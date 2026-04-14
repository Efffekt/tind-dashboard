/** Unified order representation across both platforms */
export interface Order {
  id: string;
  source: 'shiphero' | 'packiyo';
  orderNumber: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  customerName: string;
  totalItems: number;          // total pending units (includes any backordered)
  backorderedItems?: number;   // subset of totalItems that is on backorder
  trackingNumbers: string[];
}

/** Unified inventory item */
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

/** Unified shipment */
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

/** Dashboard summary stats */
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
