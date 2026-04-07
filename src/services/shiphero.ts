import { config } from '../config.js';
import type { Order, InventoryItem, Shipment } from '../types/index.js';

const { endpoint, accessToken } = config.shiphero;

async function query<T>(gql: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: gql, variables }),
  });

  if (!res.ok) {
    throw new Error(`ShipHero API error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as { data: T; errors?: { message: string }[] };
  if (json.errors?.length) {
    throw new Error(`ShipHero GraphQL error: ${json.errors[0].message}`);
  }

  return json.data;
}

export async function getOrders(limit = 25): Promise<Order[]> {
  const data = await query<{
    orders: {
      data: {
        edges: {
          node: {
            id: string;
            order_number: string;
            fulfillment_status: string;
            created_at: string;
            updated_at: string;
            shipping_address: { name: string } | null;
            line_items: { edges: { node: { id: string } }[] };
            shipments: { tracking_number: string }[];
          };
        }[];
      };
    };
  }>(`
    query GetOrders($first: Int) {
      orders(first: $first) {
        data {
          edges {
            node {
              id
              order_number
              fulfillment_status
              created_at
              updated_at
              shipping_address {
                name
              }
              line_items {
                edges {
                  node {
                    id
                  }
                }
              }
              shipments {
                tracking_number
              }
            }
          }
        }
      }
    }
  `, { first: limit });

  return data.orders.data.edges.map(({ node }) => ({
    id: node.id,
    source: 'shiphero' as const,
    orderNumber: node.order_number,
    status: node.fulfillment_status,
    createdAt: node.created_at,
    updatedAt: node.updated_at,
    customerName: node.shipping_address?.name || 'Unknown',
    totalItems: node.line_items.edges.length,
    trackingNumbers: node.shipments.map(s => s.tracking_number).filter(Boolean),
  }));
}

export async function getInventory(): Promise<InventoryItem[]> {
  const data = await query<{
    warehouse_products: {
      data: {
        edges: {
          node: {
            id: string;
            sku: string;
            product: { name: string };
            on_hand: number;
            available: number;
            allocated: number;
            warehouse: { name: string };
          };
        }[];
      };
    };
  }>(`
    query GetInventory {
      warehouse_products(first: 50) {
        data {
          edges {
            node {
              id
              sku
              product {
                name
              }
              on_hand
              available
              allocated
              warehouse {
                name
              }
            }
          }
        }
      }
    }
  `);

  return data.warehouse_products.data.edges.map(({ node }) => ({
    id: node.id,
    source: 'shiphero' as const,
    sku: node.sku,
    productName: node.product.name,
    quantityOnHand: node.on_hand,
    quantityAvailable: node.available,
    quantityAllocated: node.allocated,
    warehouse: node.warehouse.name,
  }));
}

export async function getShipments(): Promise<Shipment[]> {
  const data = await query<{
    shipments: {
      data: {
        edges: {
          node: {
            id: string;
            order_number: string;
            shipping_status: string;
            carrier: string;
            tracking_number: string;
            shipped_at: string | null;
            delivered_at: string | null;
          };
        }[];
      };
    };
  }>(`
    query GetShipments {
      shipments(first: 25) {
        data {
          edges {
            node {
              id
              order_number
              shipping_status
              carrier
              tracking_number
              shipped_at
              delivered_at
            }
          }
        }
      }
    }
  `);

  return data.shipments.data.edges.map(({ node }) => ({
    id: node.id,
    source: 'shiphero' as const,
    orderNumber: node.order_number,
    status: node.shipping_status,
    carrier: node.carrier,
    trackingNumber: node.tracking_number,
    shippedAt: node.shipped_at,
    deliveredAt: node.delivered_at,
  }));
}
