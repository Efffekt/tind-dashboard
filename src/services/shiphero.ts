import { config } from '../config.js';
import type { Order } from '../types/index.js';

const { endpoint } = config.shiphero;

// In-memory token state. On Vercel this is per-warm-instance; cold starts begin
// with the env token. Refresh kicks in automatically on 401.
let currentAccessToken = config.shiphero.accessToken;
let refreshInFlight: Promise<string> | null = null;

const IGNORED_SHOP_SLUGS = new Set(['xserc9-vd']); // test/demo stores to hide

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

function shopSlug(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.replace(/\.myshopify\.com$/i, '').replace(/\.shopify\.com$/i, '').toLowerCase();
}

export type OrdersResult = {
  pickable: Order[];
  backordered: Order[];
  truncated: boolean;  // true when ShipHero's 100-edge cap was hit, or a refetch failed
  error?: string;      // set when the service could not fully deliver a result
};

const FETCH_TIMEOUT_MS = 15_000;

async function refreshAccessToken(): Promise<string> {
  // Dedupe concurrent refresh calls — multiple in-flight requests share one auth call.
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
    const json = (await res.json()) as { access_token: string; expires_in: number };
    currentAccessToken = json.access_token;
    console.log(`ShipHero token refreshed (valid for ${Math.round(json.expires_in / 86400)} days)`);
    return currentAccessToken;
  })();
  try {
    return await refreshInFlight;
  } finally {
    // Clear the lock so a later 401 can trigger a fresh refresh
    refreshInFlight = null;
  }
}

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

async function query<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
  let res = await rawQuery(currentAccessToken, gql, variables);

  // 401 → refresh the access token using the refresh token, then retry once.
  if (res.status === 401) {
    await refreshAccessToken();
    res = await rawQuery(currentAccessToken, gql, variables);
  }

  if (!res.ok) {
    throw new Error(`ShipHero API error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    const msg = json.errors[0].message;
    // An expired-token error sometimes comes through as a GraphQL error instead of 401.
    if (/token|unauthor|expired|jwt/i.test(msg)) {
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

function toOrder(node: OrderNode): Order {
  const trackingNumbers = (node.shipments ?? []).flatMap(shipment =>
    (shipment.shipping_labels ?? [])
      .map(label => label.tracking_number)
      .filter((t): t is string => Boolean(t))
  );

  const totalItems = node.line_items.edges.reduce(
    (sum, e) => sum + (e.node.quantity_pending_fulfillment ?? 0),
    0
  );
  const backorderedItems = node.line_items.edges.reduce(
    (sum, e) => sum + (e.node.backorder_quantity ?? 0),
    0
  );

  return {
    id: node.id,
    source: 'shiphero' as const,
    orderNumber: node.order_number,
    // Normalize custom 3PL status values ("Skinsecret B2B", "Lager VM", etc.) to "pending"
    // for display — from the warehouse TV's perspective these are all "ready to pick".
    status: 'pending',
    createdAt: node.created_at,
    updatedAt: node.updated_at,
    customerName: cleanShopName(node.shop_name),
    totalItems,
    backorderedItems,
    trackingNumbers,
  };
}

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

export async function getOrders(): Promise<OrdersResult> {
  // Use ready_to_ship: true — the correct "active" filter for 3PL accounts that
  // use custom fulfillment_status values (e.g. "Skinsecret B2C", "Lager VM").
  // Those orders would never match a literal fulfillment_status: "pending" filter.
  type OrdersShape = {
    orders: {
      data: {
        pageInfo: { hasNextPage: boolean };
        edges: { node: OrderNode }[];
      };
    };
  };

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

  const hasNextPage = !!res.orders.data.pageInfo?.hasNextPage;
  if (hasNextPage) {
    console.warn(
      `ShipHero: ready_to_ship query hit the 100-edge page cap — some pickable orders are not counted`
    );
  }

  const isAllowed = (n: OrderNode) => !IGNORED_SHOP_SLUGS.has(shopSlug(n.shop_name));
  const filteredNodes = res.orders.data.edges.map(e => e.node).filter(isAllowed);
  const pickable = filteredNodes.map(toOrder);

  // For orders with >25 line items (our first:25 cap), refetch them individually
  // with first:100 so totalItems is accurate. The per-order `order(id:...)` query
  // is cheap (~102 credits each) and only runs when truncation is actually detected.
  const truncatedNodes = filteredNodes.filter(n => n.line_items.pageInfo?.hasNextPage);
  let stillTruncated = false;

  if (truncatedNodes.length > 0) {
    console.log(
      `ShipHero: refetching line_items for ${truncatedNodes.length} order(s) with >25 line items: ${truncatedNodes.map(n => n.order_number).join(', ')}`
    );

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

    // Fully paginate line_items for a single order using the `after` cursor.
    // ShipHero's `Order.line_items(first, after)` supports cursors, so we can
    // always reach the true total regardless of how many SKUs are on the order.
    async function fetchAllLineItems(orderId: string) {
      let totalItems = 0;
      let backorderedItems = 0;
      let after: string | null = null;
      let pages = 0;
      const MAX_PAGES = 50; // 50 * 100 = 5000 line items — sanity cap

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
        for (const e of page.edges) {
          totalItems += e.node.quantity_pending_fulfillment ?? 0;
          backorderedItems += e.node.backorder_quantity ?? 0;
        }
        if (!page.pageInfo?.hasNextPage) break;
        if (!page.pageInfo?.endCursor) break; // defensive
        after = page.pageInfo.endCursor;
      }

      const exhaustedCap = pages >= MAX_PAGES;
      return { totalItems, backorderedItems, exhaustedCap };
    }

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
          console.error(`ShipHero: refetch failed for order ${n.order_number}:`, err);
          return { ok: false as const, id: n.id };
        }
      })
    );

    const successes = refetches.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    const failures = refetches.filter(r => !r.ok);
    const byId = new Map(successes.map(r => [r.id, r]));

    // Override the affected orders with the corrected totals
    for (const order of pickable) {
      const refreshed = byId.get(order.id);
      if (refreshed) {
        order.totalItems = refreshed.totalItems;
        order.backorderedItems = refreshed.backorderedItems;
      }
    }

    // Flag as truncated if:
    //  - first:100 still wasn't enough (orders with >100 distinct line items), OR
    //  - any refetch failed (we kept the undercounted value for those orders)
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

  const truncated = hasNextPage || stillTruncated;
  return { pickable, backordered: [], truncated };
}
