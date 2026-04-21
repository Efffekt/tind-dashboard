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
import { buildGroups } from '../src/groups.js';
import { buildAlerts } from '../src/alerts.js';
import { osloMidnightIso } from '../src/time.js';

// Hvis ingen API-tokens finnes i miljøet, faller vi tilbake til mock-data.
// Det gjør at dashbordet fortsatt kan vises i preview/dev uten at alt kræsjer.
// I produksjon SKAL begge tokens være satt i Vercel env vars.
const useMock = !process.env.SHIPHERO_ACCESS_TOKEN && !process.env.PACKIYO_TOKEN;

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
    let shShippedToday = 0;
    let pkShippedToday = 0;

    // Midnatt i dag i Oslo-tid — grensen for "sendt i dag"-KPI.
    const sinceIso = osloMidnightIso();

    if (useMock) {
      // MOCK-MODUS: bruker test-data. Frontend viser gult "Viser testdata"-banner.
      const mock = await import('../src/services/mock.js');
      const mockOrders = mock.getOrders();
      const shOrders = mockOrders.filter(o => o.source === 'shiphero');
      const pkOrders = mockOrders.filter(o => o.source === 'packiyo');
      shResult = { pickable: shOrders, backordered: [], truncated: false };
      pkResult = { pickable: pkOrders, backordered: [], truncated: false };
      // For mock: tell ordre som er "sendt" (fulfilled/shipped/delivered) —
      // gir realistisk tall i "sendt i dag"-KPI under utvikling.
      const isShipped = (s: string) => ['fulfilled', 'shipped', 'delivered'].includes(s);
      shShippedToday = shOrders.filter(o => isShipped(o.status)).length;
      pkShippedToday = pkOrders.filter(o => isShipped(o.status)).length;
    } else {
      // EKTE-MODUS: kall begge API-ene parallelt for hastighet — og legg
      // "sendt-i-dag"-KPI-ene inn i samme Promise.all så alt går i parallell.
      // Per-kall .catch sørger for at én feil ikke tar ned de andre.
      const shiphero = await import('../src/services/shiphero.js');
      const packiyo = await import('../src/services/packiyo.js');

      const [shRes, pkRes, shShipped, pkShipped] = await Promise.all([
        shiphero.getOrders().catch((err: Error) => ({
          pickable: [], backordered: [], truncated: false, error: err.message,
        })),
        packiyo.getOrders().catch((err: Error) => ({
          pickable: [], backordered: [], truncated: false, error: err.message,
        })),
        // KPI-ene er "best effort" — hvis de feiler, returnerer vi 0 i stedet
        // for å ta ned hele responsen. En feil her bubblet IKKE opp som
        // per-kilde-feil i UI — det er en separat KPI.
        shiphero.getShippedSinceCount(sinceIso).catch((err: Error) => {
          console.warn('ShipHero getShippedSinceCount error:', err.message);
          return 0;
        }),
        packiyo.getShippedSinceCount(sinceIso).catch((err: Error) => {
          console.warn('Packiyo getShippedSinceCount error:', err.message);
          return 0;
        }),
      ]);
      shResult = shRes;
      pkResult = pkRes;
      shShippedToday = shShipped;
      pkShippedToday = pkShipped;
    }

    // Pakk ut for enklere bruk videre.
    const shPickable = shResult.pickable;
    const pkPickable = pkResult.pickable;
    const shBackordered = shResult.backordered;
    const pkBackordered = pkResult.backordered;

    // ─── Bygg klient-/workflow-rollupen (live-seksjonen nederst) ────────
    //
    // I stedet for å vise en liste av de 30 nyeste ordrene viser TV-en en
    // oversikt per butikk/workflow ("Skinsecret B2C — 58 ordre"). Det er
    // lettere å lese på avstand og gir operatørene en umiddelbar prioritet.
    // Gruppe-logikken ligger i src/groups.ts (delt med dev-server).
    const groups = buildGroups([...shPickable, ...pkPickable]);

    // ─── Alerts (popup-triggers for TV-en) ─────────────────────────────
    // Serveren sender ALLE aktive ordre som kvalifiserer for en popup hver
    // gang. Frontend holder selv orden på hvilke IDs som allerede er vist
    // (via localStorage) slik at samme ordre ikke fyrer flere popups.
    const alerts = buildAlerts([...shPickable, ...pkPickable]);

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
      shippedToday: shShippedToday + pkShippedToday, // "sendt i dag"-KPI (begge kilder summert)
      ordersBySource: {
        shiphero: shPickable.length,
        packiyo: pkPickable.length,
      },
    };

    // ─── Returner JSON-svaret ────────────────────────────────────────────
    return res.json({
      stats,
      groups, // Rollup per butikk/workflow (rendres som rader i live-seksjonen)
      alerts, // Popup-triggers: ekspress-ordre + Skinsecret B2B
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
