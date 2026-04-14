// ─────────────────────────────────────────────────────────────────────────
// packiyo.ts — Integrasjon mot Packiyo sitt REST API (JSON:API-standard)
//
// Denne filen henter aktive ordre fra Packiyo. Forskjellen fra ShipHero er:
//
//   1. Packiyo bruker REST + JSON:API i stedet for GraphQL
//   2. JSON:API har en relasjonsmodell: hver ordre refererer til sin kunde,
//      sine order-items, og sine shipments via "relationships", og de faktiske
//      ressursene ligger flatt i en "included"-array. Vi må manuelt følge
//      referansene for å finne data.
//   3. Packiyo paginerer orders-listen (men IKKE per-ordre ting som order_items
//      — alt det kommer i ett svar). Vi henter alle sider via page[number].
//   4. Token-et utløper ikke, så vi trenger ingen refresh-logikk her.
//
// Vi filtrerer med fulfilled=0 & cancelled=0, som er Packiyo sin "aktiv"-
// definisjon — fanger alt som ikke er ferdigsendt eller avbrutt.
// ─────────────────────────────────────────────────────────────────────────

import { config } from '../config.js';
import type { Order } from '../types/index.js';

const { baseUrl, token } = config.packiyo;

// JSON:API-formatet: hver ressurs har type, id, attributes, og relationships.
// Relationships peker til andre ressurser via { type, id }. De faktiske
// ressursene ligger i "included"-arrayen på topp-nivå av svaret.
type JsonApiResource = {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data: { type: string; id: string } | { type: string; id: string }[] | null }
  >;
};

// Selve svaret fra Packiyo. "data" er den etterspurte ressursen(e),
// "included" er alle relaterte ressurser som ble inkludert via ?include=...
// "meta.page.total" forteller oss hvor mange ordre som TOTALT matcher filteret,
// slik at vi vet om vi har fått alle (via paginering) eller om noe mangler.
type JsonApiResponse<T> = {
  data: T;
  included?: JsonApiResource[];
  meta?: { page?: { total?: number } };
};

// Returtypen fra getOrders(). Samme som ShipHero for konsistens.
//  - pickable:   ordre klare til plukking
//  - backordered: ordre der ALLE varer er på restordre
//  - truncated:  true hvis data er ufullstendig (skjemadrift, pagineringstak, etc.)
//  - error:      settes kun hvis hele tjenesten feilet
export type OrdersResult = {
  pickable: Order[];
  backordered: Order[];
  truncated: boolean;
  error?: string;
};

// Samme hard-timeout som ShipHero (15s).
const FETCH_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────
// HTTP-helper
// ─────────────────────────────────────────────────────────────────────────

// Rå REST-kall til Packiyo. Legger på obligatoriske JSON:API-headere.
// Packiyo krever både Accept og Content-Type som application/vnd.api+json.
async function request<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      'Authorization': `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Packiyo API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

// Slår opp en ressurs i "included"-arrayen på type + id.
// Brukes når vi følger en relasjons-referanse.
function findIncluded(
  included: JsonApiResource[] | undefined,
  type: string,
  id: string
): JsonApiResource | undefined {
  return included?.find(r => r.type === type && r.id === id);
}

// ─────────────────────────────────────────────────────────────────────────
// Paginering
// ─────────────────────────────────────────────────────────────────────────

// Henter ALLE sider med aktive ordre via page[number]-paginering.
// Packiyo gir maks 100 per side. Hvis Tind har flere enn 100 aktive ordre,
// må vi fortsette med neste side helt til vi har alle. Her slår vi dem
// sammen i én stor data-liste og included-liste slik at resten av parseren
// kan behandle det som ett svar.
async function fetchAllActivePages(): Promise<{
  data: JsonApiResource[];
  included: JsonApiResource[];
  metaTotalSeen: boolean;
  reportedTotal: number | null;
}> {
  const allData: JsonApiResource[] = [];
  const allIncluded: JsonApiResource[] = [];
  let page = 1;
  let reportedTotal: number | null = null;
  let metaTotalSeen = false;
  const MAX_PAGES = 20; // 20 * 100 = 2000 aktive ordre — sikkerhetstak

  while (page <= MAX_PAGES) {
    const response = await request<JsonApiResponse<JsonApiResource[]>>('/api/v1/orders', {
      // include= forteller Packiyo å bake inn relaterte ressurser i svaret.
      // customer.contact_information → kundenavn (klientens firmanavn)
      // order_items → linjene med antall per SKU
      // shipments.shipment_trackings → tracking-numre for avsendte forsendelser
      include: 'customer.contact_information,order_items,shipments.shipment_trackings',
      // Sorter etter sist oppdatert, nyeste først.
      sort: '-updated_at',
      'page[size]': '100',
      'page[number]': String(page),
      // De to filtrene nedenfor er "aktiv"-definisjonen:
      //   fulfilled=0  → ikke ferdigsendt
      //   cancelled=0  → ikke avbrutt
      // Dette fanger alt som er i arbeid (pending, picking, packing, etc.)
      'filter[fulfilled]': '0',
      'filter[cancelled]': '0',
    });
    allData.push(...response.data);
    if (response.included) allIncluded.push(...response.included);

    if (response.meta?.page?.total !== undefined) {
      metaTotalSeen = true;
      reportedTotal = response.meta.page.total;
    }

    // Stopp hvis vi har kommet opp til meta.page.total, eller hvis siste
    // side returnerte færre enn 100 (= det var siste sida).
    if (reportedTotal !== null && allData.length >= reportedTotal) break;
    if (response.data.length < 100) break;
    page++;
  }

  return { data: allData, included: allIncluded, metaTotalSeen, reportedTotal };
}

// ─────────────────────────────────────────────────────────────────────────
// Hovedfunksjon: getOrders()
// ─────────────────────────────────────────────────────────────────────────

export async function getOrders(): Promise<OrdersResult> {
  // STEG 1: Hent alle aktive ordre via paginering.
  const paged = await fetchAllActivePages();

  // Lag et "kunstig" JsonApiResponse som slår sammen alle sidene til ett objekt.
  // Dette lar oss bruke resten av parseren som om det var ett stort svar.
  const response: JsonApiResponse<JsonApiResource[]> = {
    data: paged.data,
    included: paged.included,
    meta: paged.reportedTotal !== null ? { page: { total: paged.reportedTotal } } : undefined,
  };

  // STEG 2: Tellere for å oppdage skjemadrift.
  // Hvis Packiyo endrer API-et (f.eks. omdøper 'order-items' til 'order_items',
  // eller fjerner 'quantity_pending'-attributtet), ville koden vår stille få 0
  // der det skulle vært tall. Vi sporer hver slik anomali og flagger truncated=true.
  let unresolvedItemRefs = 0;
  let unresolvedCustomerRefs = 0;
  let itemsMissingQuantityAttr = 0;
  let unknownStatuses = new Set<string>();
  // Kjente status-verdier fra Packiyo — hvis en ny dukker opp, logger vi den.
  const KNOWN_STATUSES = new Set([
    'pending', 'picking', 'packing', 'ready_to_ship', 'partially_shipped',
    'on_hold', 'fraud_hold', 'address_hold', 'payment_hold', 'operator_hold',
  ]);

  // STEG 3: Bygg en Order-liste ved å iterere over hver rå ordre-ressurs.
  const orders = response.data.map(order => {
    const attrs = order.attributes ?? {};
    const rels = order.relationships ?? {};

    // -- Klientnavn (tenant) via customer → contact_information --
    // Hver Packiyo-ordre har en relasjon "customer" som peker til et customer-objekt.
    // Customer-objektet har igjen en "contact_information"-relasjon som inneholder
    // selve navnet og firmanavnet. Vi følger kjeden for å få tak i klientnavnet
    // som brukes i dashboard-visningen ("Klient"-kolonnen).
    let customerName = 'Ukjent';
    const customerRef = rels.customer?.data;
    if (customerRef && !Array.isArray(customerRef)) {
      const customer = findIncluded(response.included, customerRef.type, customerRef.id);
      if (!customer) {
        // Ref peker ikke til noe i included → skjemadrift eller ufullstendig include.
        unresolvedCustomerRefs++;
      } else {
        const contactRef = customer?.relationships?.contact_information?.data;
        if (contactRef && !Array.isArray(contactRef)) {
          const contact = findIncluded(response.included, contactRef.type, contactRef.id);
          const cattrs = contact?.attributes ?? {};
          // Foretrekk company_name (firmanavn) hvis det finnes, fall tilbake til name.
          const name = (cattrs.company_name as string | undefined)
            || (cattrs.name as string | undefined)
            || '';
          customerName = name.trim() || 'Ukjent';
        }
      }
    }

    // -- Summer enheter fra order-items --
    // OBS: Packiyo bruker 'order-items' (med bindestrek) som type-navn i JSON:API.
    // Min første kode brukte 'order_items' (med understrek) og fant ingenting!
    const orderItemRefs = rels.order_items?.data;
    let totalItems = 0;
    let backorderedItems = 0;
    if (Array.isArray(orderItemRefs)) {
      for (const ref of orderItemRefs) {
        const item = findIncluded(response.included, ref.type, ref.id);
        if (!item) {
          // Referansen peker ikke til noe i included → skjemadrift.
          unresolvedItemRefs++;
          continue;
        }
        const iattrs = item.attributes ?? {};

        // Eksplisitt sjekk: er quantity_pending / quantity i det hele tatt til stede?
        // Hvis Packiyo noen gang omdøper disse, ville vi ellers bare stille fått 0.
        const hasQuantityPending = 'quantity_pending' in iattrs;
        const hasQuantity = 'quantity' in iattrs;
        if (!hasQuantityPending && !hasQuantity) {
          itemsMissingQuantityAttr++;
        }

        // Foretrekk quantity_pending (= det som gjenstår å sende), fall tilbake
        // til totale quantity hvis det ikke finnes.
        const pending = (iattrs.quantity_pending as number | undefined)
          ?? (iattrs.quantity as number | undefined)
          ?? 0;
        totalItems += pending;
        backorderedItems += (iattrs.quantity_backordered as number | undefined) ?? 0;
      }
    }

    // -- Spor ukjente status-verdier --
    // Hvis Packiyo introduserer en ny mellomtilstand vi ikke har sett før, logger
    // vi den så vi kan verifisere at "fulfilled=0 & cancelled=0"-filteret fortsatt
    // gir mening for denne statusen.
    const statusRaw = String(attrs.status_text ?? 'unknown').toLowerCase().replace(/\s+/g, '_');
    if (!KNOWN_STATUSES.has(statusRaw) && statusRaw !== 'unknown') {
      unknownStatuses.add(statusRaw);
    }

    // -- Sporingsnumre (tracking numbers) --
    // Kjeden: order → shipments → shipment_trackings → tracking_number
    const shipmentRefs = rels.shipments?.data;
    const trackingNumbers: string[] = [];
    if (Array.isArray(shipmentRefs)) {
      for (const shipmentRef of shipmentRefs) {
        const shipment = findIncluded(response.included, shipmentRef.type, shipmentRef.id);
        const trackingRefs = shipment?.relationships?.shipment_trackings?.data;
        if (Array.isArray(trackingRefs)) {
          for (const trackingRef of trackingRefs) {
            const tracking = findIncluded(response.included, trackingRef.type, trackingRef.id);
            const trackingNumber = tracking?.attributes?.tracking_number as string | undefined;
            if (trackingNumber) trackingNumbers.push(trackingNumber);
          }
        }
      }
    }

    // Returner Order-objektet for denne ordren.
    return {
      id: String(order.id),
      source: 'packiyo' as const,
      orderNumber: String(attrs.number ?? order.id),
      status: String(attrs.status_text ?? 'unknown').toLowerCase(),
      createdAt: String(attrs.ordered_at ?? attrs.created_at ?? ''),
      updatedAt: String(attrs.updated_at ?? attrs.created_at ?? ''),
      customerName,
      totalItems,
      backorderedItems,
      trackingNumbers,
    };
  });

  // STEG 4: Del opp i "plukkbar" vs "helt på restordre".
  // En ordre er "helt på restordre" hvis alle pending-enhetene er backordered.
  // Disse har ingen plukkbar jobb akkurat nå og ekskluderes fra listen.
  const isFullyBackordered = (o: Order) =>
    (o.totalItems ?? 0) > 0 && (o.backorderedItems ?? 0) >= (o.totalItems ?? 0);

  const pickable = orders.filter(o => !isFullyBackordered(o));
  const backordered = orders.filter(isFullyBackordered);

  // STEG 5: Sjekk om paginerings-henting faktisk nådde korrekt total.
  const reportedTotal = paged.reportedTotal;
  const orderPageTruncated = reportedTotal !== null && orders.length < reportedTotal;
  if (orderPageTruncated) {
    console.warn(
      `Packiyo: paginated fetch did not reach total (${orders.length}/${reportedTotal} active orders)`
    );
  }

  // meta.page.total er selve verktøyet vi bruker til å oppdage ufullstendig
  // paginering. Hvis Packiyo noen gang fjerner det feltet, mister vi evnen
  // til å vite om vi har alle ordre — vi flagger det som truncated.
  const metaTotalMissing = !paged.metaTotalSeen;
  if (metaTotalMissing) {
    console.warn(
      `Packiyo: response has no meta.page.total — cannot verify completeness`
    );
  }

  // STEG 6: Logg skjemadrift-anomalier. Alt dette resulterer i truncated=true
  // og rødt banner i UI, slik at vi ALDRI stille viser feil tall.
  if (unresolvedItemRefs > 0) {
    console.warn(
      `Packiyo: ${unresolvedItemRefs} order-item ref(s) did not resolve in included — schema may have drifted (type rename?)`
    );
  }
  if (unresolvedCustomerRefs > 0) {
    console.warn(
      `Packiyo: ${unresolvedCustomerRefs} customer ref(s) did not resolve in included`
    );
  }
  if (itemsMissingQuantityAttr > 0) {
    console.warn(
      `Packiyo: ${itemsMissingQuantityAttr} order-item(s) missing both 'quantity_pending' and 'quantity' attributes — Packiyo may have renamed/removed the attribute`
    );
  }
  if (unknownStatuses.size > 0) {
    console.warn(
      `Packiyo: unexpected status_text values: ${Array.from(unknownStatuses).join(', ')} — verify these are still active/pickable`
    );
  }

  // Sett truncated = true hvis noe er galt: paginering-tak, manglende meta,
  // eller skjemadrift. Frontend viser da rødt banner.
  const schemaDrift =
    unresolvedItemRefs > 0 ||
    unresolvedCustomerRefs > 0 ||
    itemsMissingQuantityAttr > 0 ||
    metaTotalMissing;
  const truncated = orderPageTruncated || schemaDrift;

  return { pickable, backordered, truncated };
}
