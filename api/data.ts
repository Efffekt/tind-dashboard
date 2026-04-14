// ─────────────────────────────────────────────────────────────────────────
// api/data.ts — Vercel serverless-funksjon som bygger dashbord-svaret
//
// Dette er "hjernen" som frontendet snakker med. Den:
//   1. Henter aktive ordre fra både ShipHero og Packiyo parallelt
//   2. Håndterer per-kilde-feil (én kan være nede uten å ødelegge den andre)
//   3. Bygger opp statistikk-objektet (aktive ordre, varer å plukke, osv.)
//   4. Setter cache-headere slik at TV-ene leser fra CDN i stedet for å
//      trigge en ny funksjons-kjøring hver gang.
//
// Denne filen kjøres av Vercel i produksjon. dev-server.ts speiler den
// for lokal utvikling.
// ─────────────────────────────────────────────────────────────────────────

import type { VercelRequest, VercelResponse } from '@vercel/node';

// Hvis ingen API-tokens finnes i miljøet, faller vi tilbake til mock-data.
// Det gjør at dashbordet fortsatt kan vises i preview/dev uten at alt kræsjer.
// I produksjon SKAL begge tokens være satt i Vercel env vars.
const useMock = !process.env.SHIPHERO_ACCESS_TOKEN && !process.env.PACKIYO_TOKEN;

// Maks antall ordre vi viser i live-listen nederst på skjermen.
// Delt 15/15 mellom ShipHero og Packiyo, med backfill hvis en side er tom.
const DISPLAY_LIMIT = 30;

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  // Cache-headeren synkroniserer med vercel.json-cronen (som kjører hvert
  // 3. minutt = 180s). Resultatet: hver TV-henting treffer CDN-cachen,
  // og bare selve cron-kallet treffer den faktiske funksjonen.
  // Dette holder Vercel-forbruket på ~480 invokasjoner/dag uansett hvor
  // mange TV-er som ser på samtidig.
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');

  try {
    // Form-definisjon for hva hver tjeneste returnerer.
    // `error` er valgfritt og settes bare hvis hele tjenesten feilet.
    type ServiceResult = {
      pickable: any[];
      backordered: any[];
      truncated: boolean;
      error?: string;
    };

    let shResult: ServiceResult;
    let pkResult: ServiceResult;

    if (useMock) {
      // MOCK-MODUS: bruker test-data. Frontend viser gult "Viser testdata"-banner.
      const mock = await import('../src/services/mock.js');
      const mockOrders = mock.getOrders();
      const shOrders = mockOrders.filter(o => o.source === 'shiphero');
      const pkOrders = mockOrders.filter(o => o.source === 'packiyo');
      shResult = { pickable: shOrders, backordered: [], truncated: false };
      pkResult = { pickable: pkOrders, backordered: [], truncated: false };
    } else {
      // EKTE-MODUS: kall begge API-ene parallelt for hastighet.
      // Hver .catch sørger for at én kilde kan feile uten å ta ned den andre.
      // Feilen lagres i result.error og propageres til frontend som rødt varsel.
      const shiphero = await import('../src/services/shiphero.js');
      const packiyo = await import('../src/services/packiyo.js');

      [shResult, pkResult] = await Promise.all([
        shiphero.getOrders().catch((err: Error) => ({
          pickable: [], backordered: [], truncated: false, error: err.message,
        })),
        packiyo.getOrders().catch((err: Error) => ({
          pickable: [], backordered: [], truncated: false, error: err.message,
        })),
      ]);
    }

    // Pakk ut for enklere bruk videre.
    const shPickable = shResult.pickable;
    const pkPickable = pkResult.pickable;
    const shBackordered = shResult.backordered;
    const pkBackordered = pkResult.backordered;

    // ─── Bygg display-listen (live feeden nederst) ───────────────────────
    //
    // Strategi: myk balansering. Vi tar de 15 nyeste fra hver kilde, men
    // hvis én side har færre enn 15 lar vi den andre fylle opp de tomme
    // plassene. Slik ser du alltid nyeste aktivitet fra begge systemer,
    // men hvis én er helt tom får den andre hele listen.
    const sortByCreated = (a: any, b: any) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    const halfSlot = Math.ceil(DISPLAY_LIMIT / 2); // 15 per kilde som mål

    const shSorted = shPickable.slice().sort(sortByCreated);
    const pkSorted = pkPickable.slice().sort(sortByCreated);

    // Ta opp til 15 ShipHero, og fyll opp med Packiyo til DISPLAY_LIMIT totalt.
    const shTake = Math.min(shSorted.length, halfSlot);
    const pkTake = Math.min(pkSorted.length, DISPLAY_LIMIT - shTake);
    // Hvis Packiyo hadde få (under 15), gi ShipHero muligheten til å fylle opp.
    const shTakeFinal = Math.min(shSorted.length, DISPLAY_LIMIT - pkTake);

    const orders = [
      ...shSorted.slice(0, shTakeFinal),
      ...pkSorted.slice(0, pkTake),
    ].sort(sortByCreated); // Slå dem sammen og sorter på nytt så nyeste kommer øverst.

    // ─── Beregn "varer å plukke" ─────────────────────────────────────────
    //
    // Viktig: trekk fra backordered-delen per ordre. En ordre med totalItems=10
    // men backorderedItems=3 har egentlig bare 7 enheter som kan plukkes nå.
    // Math.max(0, ...) er en sikkerhet mot rare data der backorder > total.
    const pickableUnits = [...shPickable, ...pkPickable].reduce(
      (sum, o) => sum + Math.max(0, (o.totalItems || 0) - (o.backorderedItems || 0)),
      0
    );

    // ─── Statistikk-objektet som vises i hero-delen av dashbordet ────────
    const stats = {
      activeOrders: shPickable.length + pkPickable.length, // Total antall plukkbare ordre
      backorderedOrders: shBackordered.length + pkBackordered.length, // (skjult i UI nå)
      totalItems: pickableUnits, // "varer å plukke"-tallet
      ordersBySource: {
        shiphero: shPickable.length,
        packiyo: pkPickable.length,
      },
    };

    // ─── Returner JSON-svaret ────────────────────────────────────────────
    return res.json({
      stats,
      orders, // Live-listen med 30 ordre
      truncated: shResult.truncated || pkResult.truncated, // Trigger rødt banner hvis data er ufullstendig
      errors: {
        shiphero: shResult.error ?? null,
        packiyo: pkResult.error ?? null,
      },
      fetchedAt: new Date().toISOString(), // Brukes for "Oppdatert HH:MM" i header
      mock: useMock, // Trigger gult "Viser testdata"-banner
    });
  } catch (err) {
    // Last-resort error handler hvis noe kastet helt uventet.
    return res.status(500).json({ error: 'Failed to fetch orders', detail: String(err) });
  }
}
