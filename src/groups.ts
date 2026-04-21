// ─────────────────────────────────────────────────────────────────────────
// groups.ts — Slår sammen ordre til klient-/workflow-rollup
//
// Input: flat liste av Order-objekter fra begge kilder.
// Output: én rad per "butikk" med antall ordre + varer + eldste alder.
//
// Gruppe-nøkkelen er:
//   - ShipHero: fulfillment_status ("Skinsecret B2B", "Skinsecret B2C",
//     "Lager VM", "Mesanin"). Dette splitter Skinsecret B2B/B2C naturlig
//     siden de er ulike workflow-verdier selv når shop_name er den samme.
//   - Fallback (hvis fulfillment_status mangler): customerName.
//   - Packiyo: alltid customerName (det er allerede per-klient der).
//
// Vi grupperer IKKE på tvers av kilder — en klient som ligger i både
// ShipHero og Packiyo får to rader. Det speiler virkeligheten (det er
// faktisk to separate arbeidsflyter) og lar frontend fargekode SH/PK.
// ─────────────────────────────────────────────────────────────────────────

import type { Order } from './types/index.js';
import { orderAlertType, type AlertType } from './alerts.js';

export type OrderGroup = {
  displayName: string;
  source: 'shiphero' | 'packiyo';
  count: number;               // antall aktive ordre i gruppen
  items: number;               // sum plukkbare varer (totalItems - backorderedItems)
  oldestCreatedAt: string;     // ISO-tidsstempel for eldste aktive ordre i gruppen
  urgentCount: number;         // antall ordre i gruppen som fyrer popup-varsel (ekspress/B2B)
  urgentType: AlertType | null; // hvilken type urgent-ordre gruppen inneholder (null hvis ingen)
};

// Bygger gruppe-nøkkelen for én ordre. Rendering-navnet er en del av nøkkelen
// slik at vi ikke kan ved et uhell slå sammen to grupper som tegnes likt.
//
// Regel for ShipHero-navnegivning:
//   - Default til cleanShopName (= o.customerName) — det er det operatørene
//     kjenner butikken som.
//   - Bruk fulfillmentStatus KUN når den "utvider" shop-navnet (starter med det
//     og er lenger). Dette fanger "Skinsecret B2B"/"Skinsecret B2C" som ekte
//     sub-arbeidsflyter, men ignorerer interne ShipHero-etiketter som "Lager VM"
//     eller "Mesanin" der statusen ikke er butikk-navnet i det hele tatt.
function groupKey(o: Order): { key: string; displayName: string } {
  if (o.source === 'shiphero') {
    const shop = (o.customerName || '').trim() || 'Ukjent';
    const status = (o.fulfillmentStatus || '').trim();
    const shopLc = shop.toLowerCase();
    const statusLc = status.toLowerCase();
    const isShopExtension =
      status.length > shop.length &&
      statusLc.startsWith(shopLc) &&
      // Neste tegn etter shop-navnet må være ikke-alfanumerisk (mellomrom,
      // bindestrek, osv.) for å unngå at "Skinny" matcher "Skinnysecret".
      /[^a-z0-9]/i.test(status[shop.length] ?? ' ');
    const displayName = isShopExtension ? status : shop;
    return { key: `sh::${displayName.toLowerCase()}`, displayName };
  }
  const displayName = (o.customerName || '').trim() || 'Ukjent';
  return { key: `pk::${displayName.toLowerCase()}`, displayName };
}

export function buildGroups(orders: Order[]): OrderGroup[] {
  const byKey = new Map<string, OrderGroup>();

  for (const o of orders) {
    const { key, displayName } = groupKey(o);
    const pickable = Math.max(0, (o.totalItems || 0) - (o.backorderedItems || 0));
    // Sjekk om ordren er urgent (ekspress/B2B). Brukes for å markere raden
    // rød i dashbordet selv om popupen allerede er forsvunnet.
    const urgent = orderAlertType(o);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
      existing.items += pickable;
      if (urgent) {
        existing.urgentCount += 1;
        // Hvis en gruppe skulle ha flere typer urgent-ordre (sjelden men
        // mulig), beholder vi den første vi så — de får samme visuelle
        // behandling uansett.
        existing.urgentType = existing.urgentType ?? urgent;
      }
      // Behold det ELDSTE createdAt-tidsstempelet — det er det som driver
      // stale-highlightingen ("har butikken en ordre som har ligget for lenge?").
      if (o.createdAt && o.createdAt < existing.oldestCreatedAt) {
        existing.oldestCreatedAt = o.createdAt;
      }
    } else {
      byKey.set(key, {
        displayName,
        source: o.source,
        count: 1,
        items: pickable,
        oldestCreatedAt: o.createdAt || '',
        urgentCount: urgent ? 1 : 0,
        urgentType: urgent,
      });
    }
  }

  // Sortering: størst først. Sekundær sortering på navn for determinisme
  // slik at rekkefølgen ikke hopper rundt mellom like-tellinger.
  return [...byKey.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return a.displayName.localeCompare(b.displayName, 'nb');
  });
}
