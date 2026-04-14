import { config } from '../config.js';
import type { Order } from '../types/index.js';

const { baseUrl, token } = config.packiyo;

type JsonApiResource = {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<
    string,
    { data: { type: string; id: string } | { type: string; id: string }[] | null }
  >;
};

type JsonApiResponse<T> = {
  data: T;
  included?: JsonApiResource[];
  meta?: { page?: { total?: number } };
};

export type OrdersResult = {
  pickable: Order[];
  backordered: Order[];
  truncated: boolean; // true when page[size]=100 didn't cover all active orders, or schema drifted
  error?: string;
};

const FETCH_TIMEOUT_MS = 15_000;

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

function findIncluded(
  included: JsonApiResource[] | undefined,
  type: string,
  id: string
): JsonApiResource | undefined {
  return included?.find(r => r.type === type && r.id === id);
}

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
  const MAX_PAGES = 20; // 20 * 100 = 2000 active orders — sanity cap

  while (page <= MAX_PAGES) {
    const response = await request<JsonApiResponse<JsonApiResource[]>>('/api/v1/orders', {
      include: 'customer.contact_information,order_items,shipments.shipment_trackings',
      sort: '-updated_at',
      'page[size]': '100',
      'page[number]': String(page),
      'filter[fulfilled]': '0',
      'filter[cancelled]': '0',
    });
    allData.push(...response.data);
    if (response.included) allIncluded.push(...response.included);

    if (response.meta?.page?.total !== undefined) {
      metaTotalSeen = true;
      reportedTotal = response.meta.page.total;
    }

    // If we have meta.page.total, use it as the stop condition. Otherwise stop
    // when a page returns fewer than the page size (last page).
    if (reportedTotal !== null && allData.length >= reportedTotal) break;
    if (response.data.length < 100) break;
    page++;
  }

  return { data: allData, included: allIncluded, metaTotalSeen, reportedTotal };
}

export async function getOrders(): Promise<OrdersResult> {
  const paged = await fetchAllActivePages();
  // Reconstruct a JsonApiResponse-like object for the rest of the parser.
  const response: JsonApiResponse<JsonApiResource[]> = {
    data: paged.data,
    included: paged.included,
    meta: paged.reportedTotal !== null ? { page: { total: paged.reportedTotal } } : undefined,
  };

  // Track schema-drift anomalies: refs that don't resolve, or unresolved line items.
  // If Packiyo ever renames `order-items` → `order_items`, or removes `quantity_pending`,
  // those would silently zero-out totalItems. We watch for that here and flag truncated.
  let unresolvedItemRefs = 0;
  let unresolvedCustomerRefs = 0;
  let itemsMissingQuantityAttr = 0;
  let unknownStatuses = new Set<string>();
  const KNOWN_STATUSES = new Set([
    'pending', 'picking', 'packing', 'ready_to_ship', 'partially_shipped',
    'on_hold', 'fraud_hold', 'address_hold', 'payment_hold', 'operator_hold',
  ]);

  const orders = response.data.map(order => {
    const attrs = order.attributes ?? {};
    const rels = order.relationships ?? {};

    // Tenant name via customer → contact_information → name (3PL client that owns the order)
    let customerName = 'Ukjent';
    const customerRef = rels.customer?.data;
    if (customerRef && !Array.isArray(customerRef)) {
      const customer = findIncluded(response.included, customerRef.type, customerRef.id);
      if (!customer) {
        unresolvedCustomerRefs++;
      } else {
        const contactRef = customer?.relationships?.contact_information?.data;
        if (contactRef && !Array.isArray(contactRef)) {
          const contact = findIncluded(response.included, contactRef.type, contactRef.id);
          const cattrs = contact?.attributes ?? {};
          const name = (cattrs.company_name as string | undefined)
            || (cattrs.name as string | undefined)
            || '';
          customerName = name.trim() || 'Ukjent';
        }
      }
    }

    // Sum pending + backordered units across order-items (type has a hyphen)
    const orderItemRefs = rels.order_items?.data;
    let totalItems = 0;
    let backorderedItems = 0;
    if (Array.isArray(orderItemRefs)) {
      for (const ref of orderItemRefs) {
        const item = findIncluded(response.included, ref.type, ref.id);
        if (!item) {
          unresolvedItemRefs++;
          continue;
        }
        const iattrs = item.attributes ?? {};
        // Explicit attribute-shape check: if neither known quantity field exists,
        // Packiyo has probably renamed or removed the attribute. Flag it.
        const hasQuantityPending = 'quantity_pending' in iattrs;
        const hasQuantity = 'quantity' in iattrs;
        if (!hasQuantityPending && !hasQuantity) {
          itemsMissingQuantityAttr++;
        }
        const pending = (iattrs.quantity_pending as number | undefined)
          ?? (iattrs.quantity as number | undefined)
          ?? 0;
        totalItems += pending;
        backorderedItems += (iattrs.quantity_backordered as number | undefined) ?? 0;
      }
    }

    // Track unexpected status_text values so a new Packiyo state doesn't silently
    // slip in without us noticing.
    const statusRaw = String(attrs.status_text ?? 'unknown').toLowerCase().replace(/\s+/g, '_');
    if (!KNOWN_STATUSES.has(statusRaw) && statusRaw !== 'unknown') {
      unknownStatuses.add(statusRaw);
    }

    // Tracking numbers via shipments -> shipment_trackings
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

  const isFullyBackordered = (o: Order) =>
    (o.totalItems ?? 0) > 0 && (o.backorderedItems ?? 0) >= (o.totalItems ?? 0);

  const pickable = orders.filter(o => !isFullyBackordered(o));
  const backordered = orders.filter(isFullyBackordered);

  // Check if our paginated fetch reached the true total.
  const reportedTotal = paged.reportedTotal;
  const orderPageTruncated = reportedTotal !== null && orders.length < reportedTotal;
  if (orderPageTruncated) {
    console.warn(
      `Packiyo: paginated fetch did not reach total (${orders.length}/${reportedTotal} active orders)`
    );
  }

  // meta.page.total removal would break our truncation detection entirely.
  const metaTotalMissing = !paged.metaTotalSeen;
  if (metaTotalMissing) {
    console.warn(
      `Packiyo: response has no meta.page.total — cannot verify completeness`
    );
  }

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

  const schemaDrift =
    unresolvedItemRefs > 0 ||
    unresolvedCustomerRefs > 0 ||
    itemsMissingQuantityAttr > 0 ||
    metaTotalMissing;
  const truncated = orderPageTruncated || schemaDrift;

  return { pickable, backordered, truncated };
}
