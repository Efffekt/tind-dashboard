// ─────────────────────────────────────────────────────────────────────────
// alerts.ts — Bygger liste av ordre som bør trigge popup-varsel på TV-en
//
// Serveren returnerer ALLE aktuelle aktive alerts hver gang. Frontend
// holder orden på hvilke IDs den allerede har poppet opp (localStorage)
// og fyrer bare popup på nye IDs. Det gir:
//   - Ingen popup-storm på TV-boot (baseline første gang)
//   - Ingen dupliserte popups hvis samme alert vises i flere poll-sykluser
//
// To alert-typer i dag:
//   - packiyo-express:  shipping_method_name inneholder "express"
//   - skinsecret-b2b:   ShipHero fulfillment_status === "Skinsecret B2B"
// ─────────────────────────────────────────────────────────────────────────

import type { Order } from './types/index.js';

export type AlertType = 'packiyo-express' | 'skinsecret-b2b';

export type Alert = {
  id: string;          // ordre-ID — brukes til dedup på klienten
  type: AlertType;
  displayName: string; // f.eks. "Sweats.no" eller "Skinsecret B2B"
  orderNumber: string;
  createdAt: string;
  // Ekstra kontekst som er nyttig i popupen. Valgfri — ikke alle alert-typer
  // har alle felter, og vi vil ikke blokkere popup-visningen på manglende data.
  shippingMethod?: string;
};

const EXPRESS_PATTERN = /express/i;
const SKINSECRET_B2B = 'skinsecret b2b';

// Delt deteksjon: returnerer hvilken alert-type en ordre kvalifiserer for,
// eller null hvis ingen. Brukes både av buildAlerts (popup-triggers) og
// av buildGroups (rad-markering i rollupen).
export function orderAlertType(o: Order): AlertType | null {
  if (o.source === 'packiyo' && o.shippingMethod && EXPRESS_PATTERN.test(o.shippingMethod)) {
    return 'packiyo-express';
  }
  if (o.source === 'shiphero'
      && (o.fulfillmentStatus || '').trim().toLowerCase() === SKINSECRET_B2B) {
    return 'skinsecret-b2b';
  }
  return null;
}

export function buildAlerts(orders: Order[]): Alert[] {
  const alerts: Alert[] = [];
  for (const o of orders) {
    const type = orderAlertType(o);
    if (!type) continue;
    if (type === 'packiyo-express') {
      alerts.push({
        id: o.id,
        type,
        displayName: o.customerName || 'Ukjent',
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
        shippingMethod: o.shippingMethod,
      });
    } else {
      alerts.push({
        id: o.id,
        type,
        displayName: 'Skinsecret B2B',
        orderNumber: o.orderNumber,
        createdAt: o.createdAt,
      });
    }
  }
  return alerts;
}
