// ─────────────────────────────────────────────────────────────────────────
// shiphero.ts — Integrasjon mot ShipHero sitt GraphQL API
//
// Denne filen er hjertet i ShipHero-integrasjonen. Den gjør tre ting:
//   1. Henter alle "plukkbare" ordre (ready_to_ship: true)
//   2. Administrerer access token automatisk — fornyer på 401 via refresh token
//   3. Telles varer nøyaktig ved å cursor-paginere line_items for store ordre
//
// Viktig bakgrunn: Tind er en 3PL med 9 klienter i ShipHero. Hver klient har
// sin egen workflow med EGNE fulfillment_status-verdier ("Skinsecret B2C",
// "Lager VM", "Mesanin" osv.). Derfor bruker vi ikke `fulfillment_status: "pending"`
// som filter — vi bruker `ready_to_ship: true` som er ShipHero sin offisielle
// "denne kan plukkes nå"-flagg, uavhengig av hvilken tekst statusen har.
// ─────────────────────────────────────────────────────────────────────────

import { config } from '../config.js';
import type { Order } from '../types/index.js';

const { endpoint } = config.shiphero;

// Token-tilstand som lever i minnet. På Vercel er dette per "varm" instans —
// hver gang funksjonen står klar mellom kjøringer husker den dette token-et.
// Ved kaldstart begynner vi med verdien fra .env (eller Vercel env vars).
// Hvis token-et har utløpt, fanger vi 401 og fornyer via refresh-token-flyten.
let currentAccessToken = config.shiphero.accessToken;

// Lås som hindrer at vi fyrer av flere refresh-kall samtidig.
// Hvis to queries begge får 401 samtidig, skal de dele på ÉN refresh.
let refreshInFlight: Promise<string> | null = null;

// Butikker som skal skjules fra dashboardet. xserc9-vd er en test-butikk
// som Frode bekreftet ikke er en ekte klient. Legg til flere her hvis
// det dukker opp flere test-/demo-butikker.
const IGNORED_SHOP_SLUGS = new Set(['xserc9-vd']);

// Gjør om et rått shop_name ("lampefokus.myshopify.com") til et pent visningsnavn
// ("Lampefokus"). Fjerner .myshopify.com-endelsen, bytter bindestrek/understrek
// til mellomrom, og gjør hvert ord til Stor Forbokstav.
function cleanShopName(raw: string | null | undefined): string {
  if (!raw) return 'Ukjent';
  const cleaned = raw
    .replace(/\.myshopify\.com$/i, '')
    .replace(/\.shopify\.com$/i, '')
    .replace(/[-_]/g, ' ')
    .trim();
  return cleaned
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// Lager en slug (liten bokstav, uten domene) som brukes for å sjekke mot
// IGNORED_SHOP_SLUGS. Trenger IKKE være pen — skal bare matche filter-listen.
function shopSlug(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\.myshopify\.com$/i, '').replace(/\.shopify\.com$/i, '').toLowerCase();
}

// Typen som getOrders() returnerer. Brukt av dev-server.ts og api/data.ts.
//  - pickable:   ordre som kan plukkes nå (ready_to_ship: true)
//  - backordered: tom for ShipHero nå — ShipHero viser kun pickable i sin query
//  - truncated:  true hvis data er ufullstendig (banner fyrer i UI)
//  - error:      fylles kun når hele tjenesten feilet
export type OrdersResult = {
  pickable: Order[];
  backordered: Order[];
  truncated: boolean;
  error?: string;
};

// Hard timeout på alle HTTP-kall til ShipHero. Uten dette kan et hengende
// API-kall blokkere serverless-funksjonen helt til Vercel dreper den.
const FETCH_TIMEOUT_MS = 15_000;

// ─────────────────────────────────────────────────────────────────────────
// Token-fornyelse
// ─────────────────────────────────────────────────────────────────────────

// Fornyer access-token ved å kalle ShipHero sitt /auth/refresh-endepunkt
// med refresh-tokenet fra .env. Hvis flere queries får 401 samtidig, deler
// de på samme refresh-promise (refreshInFlight-låsen).
async function refreshAccessToken(): Promise<string> {
  // Dedupe: hvis et annet kall allerede fornyer, hekt deg på det samme promiset.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const res = await fetch('https://public-api.shiphero.com/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: config.shiphero.refreshToken }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ShipHero token refresh failed: ${res.status} ${body}`);
    }
    // Svaret inneholder { access_token, expires_in } — expires_in er i sekunder.
    const json = (await res.json()) as { access_token: string; expires_in: number };
    currentAccessToken = json.access_token;
    console.log(`ShipHero token refreshed (valid for ${Math.round(json.expires_in / 86400)} days)`);
    return currentAccessToken;
  })();

  try {
    return await refreshInFlight;
  } finally {
    // Frigi låsen slik at en senere 401 kan fyre av en NY refresh.
    refreshInFlight = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// GraphQL-kall
// ─────────────────────────────────────────────────────────────────────────

// Rå fetch uten retry-logikk. Brukes av query()-wrapperen under.
async function rawQuery(token: string, gql: string, variables?: Record<string, unknown>) {
  return fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query: gql, variables }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// Hoved-wrapper for GraphQL-kall. Gjør følgende:
//   1. Prøver med gjeldende access-token
//   2. Hvis 401 → fornyer token og prøver én gang til
//   3. Hvis GraphQL returnerer en "token utløpt"-feil → samme fornyelsesflyt
//   4. Kaster Error hvis noe går galt (fanges av kalleren)
async function query<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
  let res = await rawQuery(currentAccessToken, gql, variables);

  // 401 = token utløpt eller ugyldig. Forny og prøv igjen.
  if (res.status === 401) {
    await refreshAccessToken();
    res = await rawQuery(currentAccessToken, gql, variables);
  }

  if (!res.ok) {
    throw new Error(`ShipHero API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data: T; errors?: { message: string }[] };

  // GraphQL kan returnere HTTP 200 men med feil i "errors"-arrayen.
  // En utløpt token kommer noen ganger som GraphQL-feil i stedet for 401.
  if (json.errors?.length) {
    const msg = json.errors[0].message;
    if (/token|unauthor|expired|jwt/i.test(msg)) {
      // Token-relatert GraphQL-feil → forny og prøv igjen.
      await refreshAccessToken();
      const retry = await rawQuery(currentAccessToken, gql, variables);
      if (!retry.ok) throw new Error(`ShipHero API error after refresh: ${retry.status}`);
      const retryJson = (await retry.json()) as { data: T; errors?: { message: string }[] };
      if (retryJson.errors?.length) throw new Error(`ShipHero GraphQL error: ${retryJson.errors[0].message}`);
      return retryJson.data;
    }
    throw new Error(`ShipHero GraphQL error: ${msg}`);
  }

  return json.data;
}

// ─────────────────────────────────────────────────────────────────────────
// Ordre-mapping
// ─────────────────────────────────────────────────────────────────────────

// Formen på én ordre-node slik ShipHero returnerer den fra GraphQL.
// Dette er den "rå" formen — vi mapper den til vår egen Order-type under.
type OrderNode = {
  id: string;
  order_number: string;
  fulfillment_status: string | null;
  shop_name: string | null;
  created_at: string;
  updated_at: string;
  line_items: {
    pageInfo: { hasNextPage: boolean };
    edges: { node: { quantity_pending_fulfillment: number | null; backorder_quantity: number | null } }[];
  };
  shipments: { shipping_labels: { tracking_number: string | null }[] }[];
};

// Mapper en ShipHero-node til vår interne Order-type som dashbordet bruker.
function toOrder(node: OrderNode): Order {
  // Samle alle sporings-numre fra alle fraktetiketter i alle forsendelser.
  // Orddre kan ha flere shipments, hver med flere labels, hver med ett tracking_number.
  const trackingNumbers = (node.shipments ?? []).flatMap(shipment =>
    (shipment.shipping_labels ?? [])
      .map(label => label.tracking_number)
      .filter((t): t is string => Boolean(t))
  );

  // Sum alle enheter som fortsatt venter på å sendes (= "varer å plukke" for denne ordren).
  const totalItems = node.line_items.edges.reduce(
    (sum, e) => sum + (e.node.quantity_pending_fulfillment ?? 0),
    0
  );

  // Sum alle enheter som er på restordre (venter på lager). Trekkes fra totalItems
  // for å regne ut hva som faktisk kan plukkes akkurat nå.
  const backorderedItems = node.line_items.edges.reduce(
    (sum, e) => sum + (e.node.backorder_quantity ?? 0),
    0
  );

  return {
    id: node.id,
    source: 'shiphero' as const,
    orderNumber: node.order_number,
    // NORMALISERER statusen til "pending" for alle plukkbare ShipHero-ordre.
    // Årsak: hver 3PL-klient har sin egen status-tekst ("Skinsecret B2B", "Lager VM",
    // "Mesanin"). Fra lagerets side er de alle "venter på å plukkes". Hvis vi
    // viste den rå teksten i status-pillen, ville vi fått 5 ulike farger og
    // forvirrende etiketter på TV-en.
    status: 'pending',
    createdAt: node.created_at,
    updatedAt: node.updated_at,
    customerName: cleanShopName(node.shop_name),
    totalItems,
    backorderedItems,
    trackingNumbers,
  };
}

// GraphQL-fragment med feltene vi henter for hver ordre. Definert som konstant
// for å slippe å skrive det samme to ganger i flere queries.
//
// OBS: first: 25 på line_items er her. De fleste ordre har 1-5 linjer, så 25
// dekker alt normalt. Ordre med >25 linjer blir oppdaget via pageInfo.hasNextPage
// og refetchet individuelt med cursor-paginering (se fetchAllLineItems).
const ORDER_FIELDS = `
  id
  order_number
  fulfillment_status
  shop_name
  created_at
  updated_at
  line_items(first: 25) {
    pageInfo { hasNextPage }
    edges {
      node {
        quantity_pending_fulfillment
        backorder_quantity
      }
    }
  }
  shipments {
    shipping_labels {
      tracking_number
    }
  }
`;

// ─────────────────────────────────────────────────────────────────────────
// Hovedfunksjon: getOrders()
// ─────────────────────────────────────────────────────────────────────────

// Henter alle plukkbare ShipHero-ordre. Kalles fra api/data.ts (prod) og
// dev-server.ts (lokalt). Returnerer { pickable, backordered, truncated }.
export async function getOrders(): Promise<OrdersResult> {
  // Type-annotasjon for GraphQL-svaret. Må matche query-strukturen nedenfor.
  type OrdersShape = {
    orders: {
      data: {
        pageInfo: { hasNextPage: boolean };
        edges: { node: OrderNode }[];
      };
    };
  };

  // STEG 1: Hent alle ordre som er klare for plukking.
  // Bruker ready_to_ship: true fordi dette er ShipHero sin offisielle "kan plukkes"-flagg,
  // og den fanger opp ordre på tvers av alle de 9 klientenes custom-statuser.
  const res = await query<OrdersShape>(
    `query GetPickableOrders {
      orders(ready_to_ship: true) {
        data {
          pageInfo { hasNextPage }
          edges { node { ${ORDER_FIELDS} } }
        }
      }
    }`
  );

  // ShipHero har en hard grense på 100 ordre per query uten cursor-støtte.
  // Hvis vi når den grensen, noterer vi det og fyrer banner i UI.
  const hasNextPage = !!res.orders.data.pageInfo?.hasNextPage;
  if (hasNextPage) {
    console.warn(
      `ShipHero: ready_to_ship query hit the 100-edge page cap — some pickable orders are not counted`
    );
  }

  // STEG 2: Filtrer bort test-butikker og map til interne Order-objekter.
  const isAllowed = (n: OrderNode) => !IGNORED_SHOP_SLUGS.has(shopSlug(n.shop_name));
  const filteredNodes = res.orders.data.edges.map(e => e.node).filter(isAllowed);
  const pickable = filteredNodes.map(toOrder);

  // STEG 3: Fiks ordre med mer enn 25 linjer.
  // Main-queryen bruker line_items(first: 25). Hvis en ordre har fler enn 25
  // distincte SKUer, mister vi resten. pageInfo.hasNextPage forteller oss det.
  // For slike ordre gjør vi et ekstra, billigere kall per ordre som cursor-paginerer
  // alle linjene. Dette sikrer at "varer å plukke"-totalen ALLTID er korrekt.
  const truncatedNodes = filteredNodes.filter(n => n.line_items.pageInfo?.hasNextPage);
  let stillTruncated = false;

  if (truncatedNodes.length > 0) {
    console.log(
      `ShipHero: refetching line_items for ${truncatedNodes.length} order(s) with >25 line items: ${truncatedNodes.map(n => n.order_number).join(', ')}`
    );

    // Form på svaret for per-ordre-query. Vi trenger pageInfo.endCursor for å
    // kunne paginere videre hvis det er fler enn 100 linjer.
    type SingleOrderPageShape = {
      order: {
        data: {
          id: string;
          line_items: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            edges: {
              node: {
                quantity_pending_fulfillment: number | null;
                backorder_quantity: number | null;
              };
            }[];
          };
        };
      };
    };

    // Henter ALLE linjene for én ordre ved å paginere med `after`-cursoren.
    // ShipHero sin Order.line_items(first, after) støtter cursors, så vi kan
    // alltid nå korrekt totalsum uansett hvor mange SKUer ordren har.
    async function fetchAllLineItems(orderId: string) {
      let totalItems = 0;
      let backorderedItems = 0;
      let after: string | null = null;
      let pages = 0;
      const MAX_PAGES = 50; // 50 × 100 = 5000 linjer — sikkerhetstak for å unngå uendelige loops

      while (pages < MAX_PAGES) {
        pages++;
        const res: SingleOrderPageShape = await query<SingleOrderPageShape>(
          `query GetOrderLineItems($id: String!, $after: String) {
            order(id: $id) {
              data {
                id
                line_items(first: 100, after: $after) {
                  pageInfo { hasNextPage endCursor }
                  edges {
                    node {
                      quantity_pending_fulfillment
                      backorder_quantity
                    }
                  }
                }
              }
            }
          }`,
          { id: orderId, after }
        );
        const page = res.order.data.line_items;

        // Summér denne siden sine enheter.
        for (const e of page.edges) {
          totalItems += e.node.quantity_pending_fulfillment ?? 0;
          backorderedItems += e.node.backorder_quantity ?? 0;
        }

        // Stopp hvis det ikke er mer data.
        if (!page.pageInfo?.hasNextPage) break;
        if (!page.pageInfo?.endCursor) break; // defensivt
        after = page.pageInfo.endCursor;
      }

      // Flagg hvis vi traff sikkerhetstaket (= ordren har >5000 linjer, VELDIG sjeldent).
      const exhaustedCap = pages >= MAX_PAGES;
      return { totalItems, backorderedItems, exhaustedCap };
    }

    // Kjør alle refetchene i parallell for fart.
    const refetches = await Promise.all(
      truncatedNodes.map(async n => {
        try {
          const { totalItems, backorderedItems, exhaustedCap } = await fetchAllLineItems(n.id);
          return {
            ok: true as const,
            id: n.id,
            totalItems,
            backorderedItems,
            stillMore: exhaustedCap,
          };
        } catch (err) {
          // Hvis en refetch feiler (credits, nettverk, ...), logg og returner null.
          // Truncated-flagget settes nedenfor slik at UI viser banner.
          console.error(`ShipHero: refetch failed for order ${n.order_number}:`, err);
          return { ok: false as const, id: n.id };
        }
      })
    );

    // Del opp i suksesser og feil.
    const successes = refetches.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    const failures = refetches.filter(r => !r.ok);
    const byId = new Map(successes.map(r => [r.id, r]));

    // Overskriv de originale (underestimerte) verdiene med de korrekte.
    for (const order of pickable) {
      const refreshed = byId.get(order.id);
      if (refreshed) {
        order.totalItems = refreshed.totalItems;
        order.backorderedItems = refreshed.backorderedItems;
      }
    }

    // Flagg som truncated hvis:
    //  - first:100 fortsatt ikke var nok (ordre med >100 distincte SKUer), ELLER
    //  - en refetch feilet (vi beholdt da den underestimerte verdien)
    // Dette sikrer at UI ALDRI stille-tier om feil data.
    const someFirstHundredExhausted = successes.some(r => r.stillMore);
    stillTruncated = someFirstHundredExhausted || failures.length > 0;
    if (someFirstHundredExhausted) {
      console.warn(`ShipHero: some orders have >100 line items, still undercounting`);
    }
    if (failures.length > 0) {
      console.warn(
        `ShipHero: ${failures.length} line-item refetch(es) failed; totalItems undercounted for those orders`
      );
    }
  }

  // STEG 4: Returner resultatet til kalleren.
  // truncated-flagget bubbles opp til api/data.ts → frontend → rødt banner.
  const truncated = hasNextPage || stillTruncated;
  return { pickable, backordered: [], truncated };
}
