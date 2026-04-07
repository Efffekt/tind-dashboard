import { config } from '../config.js';
import type { Order, InventoryItem, Shipment } from '../types/index.js';

const { baseUrl, token, customerId } = config.packiyo;

async function request<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, baseUrl);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Customer-Id': customerId,
    },
  });

  if (!res.ok) {
    throw new Error(`Packiyo API error: ${res.status} ${res.statusText}`);
  }

  return res.json() as Promise<T>;
}

export async function getOrders(): Promise<Order[]> {
  // Packiyo API structure — adjust field names once we have actual docs access
  const data = await request<{
    data: {
      id: number;
      order_number: string;
      status: string;
      created_at: string;
      updated_at: string;
      shipping_contact_name: string;
      order_items: { id: number }[];
      shipments: { tracking_number: string }[];
    }[];
  }>('/api/v1/orders');

  return data.data.map(order => ({
    id: String(order.id),
    source: 'packiyo' as const,
    orderNumber: order.order_number,
    status: order.status,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    customerName: order.shipping_contact_name || 'Unknown',
    totalItems: order.order_items.length,
    trackingNumbers: order.shipments.map(s => s.tracking_number).filter(Boolean),
  }));
}

export async function getInventory(): Promise<InventoryItem[]> {
  const data = await request<{
    data: {
      id: number;
      sku: string;
      name: string;
      quantity_on_hand: number;
      quantity_available: number;
      quantity_allocated: number;
      warehouse_name: string;
    }[];
  }>('/api/v1/inventory');

  return data.data.map(item => ({
    id: String(item.id),
    source: 'packiyo' as const,
    sku: item.sku,
    productName: item.name,
    quantityOnHand: item.quantity_on_hand,
    quantityAvailable: item.quantity_available,
    quantityAllocated: item.quantity_allocated,
    warehouse: item.warehouse_name,
  }));
}

export async function getShipments(): Promise<Shipment[]> {
  const data = await request<{
    data: {
      id: number;
      order_number: string;
      status: string;
      carrier: string;
      tracking_number: string;
      shipped_at: string | null;
      delivered_at: string | null;
    }[];
  }>('/api/v1/shipments');

  return data.data.map(shipment => ({
    id: String(shipment.id),
    source: 'packiyo' as const,
    orderNumber: shipment.order_number,
    status: shipment.status,
    carrier: shipment.carrier,
    trackingNumber: shipment.tracking_number,
    shippedAt: shipment.shipped_at,
    deliveredAt: shipment.delivered_at,
  }));
}
