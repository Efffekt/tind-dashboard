// ─────────────────────────────────────────────────────────────────────────
// types/index.ts — Delte TypeScript-typer brukt på tvers av tjenestene
//
// Hovedpoenget med denne fila er å ha ÉN felles Order-type som både
// ShipHero og Packiyo mapper til. Det gjør at api/data.ts og dev-server.ts
// kan behandle ordre fra begge kilder som samme datatype.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Felles ordre-representasjon på tvers av ShipHero og Packiyo.
 * Begge tjenester (shiphero.ts og packiyo.ts) oversetter sine egne
 * interne former til denne typen før de returneres.
 */
export interface Order {
  id: string;
  source: 'shiphero' | 'packiyo';
  orderNumber: string;         // ordre-nummeret som operatørene kjenner (f.eks. "#4763" eller "1182334")
  status: string;              // normalisert status ("pending", "fulfilled", osv.)
  createdAt: string;           // ISO-8601 tidsstempel for når ordren ble opprettet
  updatedAt: string;           // ISO-8601 tidsstempel for siste endring
  customerName: string;        // TENANT-navn, ikke kjøpernavn (f.eks. "Lampefokus", "Sweats.no")
  totalItems: number;          // antall enheter som venter på å sendes (inkluderer backordered-delen)
  backorderedItems?: number;   // delmengden av totalItems som er på restordre
  trackingNumbers: string[];   // ev. sporings-numre fra etiketter (kan være tom)
  // ShipHero: per-klient-arbeidsflyt-tekst ("Skinsecret B2B", "Skinsecret B2C",
  // "Lager VM", "Mesanin"). Brukes som gruppe-nøkkel i dashboard-rollupen
  // slik at Skinsecret B2B og B2C blir separate rader. Tomt/udefinert for Packiyo.
  fulfillmentStatus?: string;
  // Packiyo: shipping_method_name (f.eks. "Sweats-Bring-Express neste dag",
  // "Posten Norge"). Brukes for å oppdage ekspress-ordre og fyre popup-varsel.
  // Tomt/udefinert for ShipHero.
  shippingMethod?: string;
}

/** Felles lagerbeholdnings-type. Brukes ikke i dashbordet foreløpig
 *  (vi har ingen UI for lager), men beholdes i typen i tilfelle fremtidig bruk. */
export interface InventoryItem {
  id: string;
  source: 'shiphero' | 'packiyo';
  sku: string;
  productName: string;
  quantityOnHand: number;
  quantityAvailable: number;
  quantityAllocated: number;
  warehouse: string;
}

/** Felles forsendelse-type. Heller ikke i aktivt bruk for TV-visningen,
 *  men definert for konsistens. */
export interface Shipment {
  id: string;
  source: 'shiphero' | 'packiyo';
  orderNumber: string;
  status: string;
  carrier: string;
  trackingNumber: string;
  shippedAt: string | null;
  deliveredAt: string | null;
}

/** Dashbord-oppsummering. Ikke direkte brukt (api/data.ts bygger
 *  sitt eget stats-objekt inline), men dokumenterer forventet form. */
export interface DashboardStats {
  totalOrders: number;
  pendingOrders: number;
  shippedToday: number;
  lowStockItems: number;
  ordersBySource: {
    shiphero: number;
    packiyo: number;
  };
}
