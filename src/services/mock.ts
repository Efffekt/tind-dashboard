// ─────────────────────────────────────────────────────────────────────────
// mock.ts — Test-data som brukes når API-tokens ikke er satt
//
// Brukes i to tilfeller:
//   1. Lokal utvikling uten .env (nye utviklere kan kjøre npm run dev
//      uten å først skaffe ekte tokens)
//   2. Vercel-deploy der env vars ved et uhell ikke er satt — da ser
//      man dashbordet fungerer, bare med falske tall + gult "Viser
//      testdata"-banner
//
// Data er håndskrevet med norske navn og realistiske tidsstempler
// slik at UI-et ser troverdig ut under utvikling.
// ─────────────────────────────────────────────────────────────────────────

import type { Order, InventoryItem, Shipment } from '../types/index.js';

// Hjelpere for å generere ISO-tidsstempler relativt til nå.
const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86400000).toISOString();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3600000).toISOString();

// Returnerer 10 eksempel-ordre (5 fra hver kilde) med blandede statuser
// slik at alle tilstander i UI-et (Ventende/Sendt/Fullfort/Levert/Kansellert)
// blir testet samtidig.
export function getOrders(): Order[] {
  return [
    { id: 'sh-1001', source: 'shiphero', orderNumber: 'SH-10421', status: 'fulfilled', createdAt: hoursAgo(2), updatedAt: hoursAgo(1), customerName: 'Kari Nordmann', totalItems: 3, trackingNumbers: ['SP1234567890'] },
    { id: 'sh-1002', source: 'shiphero', orderNumber: 'SH-10422', status: 'pending', createdAt: hoursAgo(5), updatedAt: hoursAgo(4), customerName: 'Ola Hansen', totalItems: 1, trackingNumbers: [] },
    { id: 'sh-1003', source: 'shiphero', orderNumber: 'SH-10423', status: 'shipped', createdAt: daysAgo(1), updatedAt: hoursAgo(6), customerName: 'Erik Solberg', totalItems: 5, trackingNumbers: ['SP9876543210'] },
    { id: 'sh-1004', source: 'shiphero', orderNumber: 'SH-10424', status: 'pending', createdAt: hoursAgo(1), updatedAt: hoursAgo(1), customerName: 'Maja Lie', totalItems: 2, trackingNumbers: [] },
    { id: 'sh-1005', source: 'shiphero', orderNumber: 'SH-10425', status: 'fulfilled', createdAt: daysAgo(2), updatedAt: daysAgo(1), customerName: 'Lars Berg', totalItems: 4, trackingNumbers: ['SP1122334455'] },
    { id: 'pk-2001', source: 'packiyo', orderNumber: 'PK-50301', status: 'processing', createdAt: hoursAgo(3), updatedAt: hoursAgo(2), customerName: 'Ingrid Dahl', totalItems: 2, trackingNumbers: [] },
    { id: 'pk-2002', source: 'packiyo', orderNumber: 'PK-50302', status: 'shipped', createdAt: daysAgo(1), updatedAt: hoursAgo(8), customerName: 'Thomas Vik', totalItems: 7, trackingNumbers: ['PO5566778899'] },
    { id: 'pk-2003', source: 'packiyo', orderNumber: 'PK-50303', status: 'pending', createdAt: hoursAgo(6), updatedAt: hoursAgo(5), customerName: 'Silje Moen', totalItems: 1, trackingNumbers: [] },
    { id: 'pk-2004', source: 'packiyo', orderNumber: 'PK-50304', status: 'fulfilled', createdAt: daysAgo(3), updatedAt: daysAgo(2), customerName: 'Anders Haugen', totalItems: 3, trackingNumbers: ['PO2233445566'] },
    { id: 'pk-2005', source: 'packiyo', orderNumber: 'PK-50305', status: 'cancelled', createdAt: daysAgo(4), updatedAt: daysAgo(3), customerName: 'Camilla Strand', totalItems: 1, trackingNumbers: [] },
  ];
}

export function getInventory(): InventoryItem[] {
  return [
    { id: 'si-1', source: 'shiphero', sku: 'WH-BLK-M', productName: 'Warehouse Gloves Black M', quantityOnHand: 240, quantityAvailable: 195, quantityAllocated: 45, warehouse: 'Oslo Sentrallager' },
    { id: 'si-2', source: 'shiphero', sku: 'WH-BLK-L', productName: 'Warehouse Gloves Black L', quantityOnHand: 180, quantityAvailable: 150, quantityAllocated: 30, warehouse: 'Oslo Sentrallager' },
    { id: 'si-3', source: 'shiphero', sku: 'PKG-SM-25', productName: 'Pakkeeske Liten 25x20x15', quantityOnHand: 1200, quantityAvailable: 980, quantityAllocated: 220, warehouse: 'Oslo Sentrallager' },
    { id: 'si-4', source: 'shiphero', sku: 'PKG-LG-50', productName: 'Pakkeeske Stor 50x40x30', quantityOnHand: 45, quantityAvailable: 8, quantityAllocated: 37, warehouse: 'Bergen Lager' },
    { id: 'si-5', source: 'shiphero', sku: 'TAPE-BRN-48', productName: 'Pakketape Brun 48mm', quantityOnHand: 320, quantityAvailable: 290, quantityAllocated: 30, warehouse: 'Oslo Sentrallager' },
    { id: 'pi-1', source: 'packiyo', sku: 'FIL-A4-WHT', productName: 'Fyllmateriale A4 Hvit', quantityOnHand: 5000, quantityAvailable: 4200, quantityAllocated: 800, warehouse: 'Packiyo Warehouse 1' },
    { id: 'pi-2', source: 'packiyo', sku: 'LBL-SHIP-A6', productName: 'Fraktetikett A6', quantityOnHand: 8500, quantityAvailable: 7800, quantityAllocated: 700, warehouse: 'Packiyo Warehouse 1' },
    { id: 'pi-3', source: 'packiyo', sku: 'BAG-POLY-M', productName: 'Polypose Medium', quantityOnHand: 30, quantityAvailable: 5, quantityAllocated: 25, warehouse: 'Packiyo Warehouse 2' },
    { id: 'pi-4', source: 'packiyo', sku: 'WRAP-BUBBLE', productName: 'Bobleplast Rull 50m', quantityOnHand: 60, quantityAvailable: 42, quantityAllocated: 18, warehouse: 'Packiyo Warehouse 1' },
  ];
}

export function getShipments(): Shipment[] {
  return [
    { id: 'ss-1', source: 'shiphero', orderNumber: 'SH-10421', status: 'delivered', carrier: 'Posten', trackingNumber: 'SP1234567890', shippedAt: daysAgo(2), deliveredAt: hoursAgo(12) },
    { id: 'ss-2', source: 'shiphero', orderNumber: 'SH-10423', status: 'in_transit', carrier: 'PostNord', trackingNumber: 'SP9876543210', shippedAt: hoursAgo(6), deliveredAt: null },
    { id: 'ss-3', source: 'shiphero', orderNumber: 'SH-10425', status: 'delivered', carrier: 'Bring', trackingNumber: 'SP1122334455', shippedAt: daysAgo(3), deliveredAt: daysAgo(1) },
    { id: 'ps-1', source: 'packiyo', orderNumber: 'PK-50302', status: 'in_transit', carrier: 'Bring', trackingNumber: 'PO5566778899', shippedAt: hoursAgo(8), deliveredAt: null },
    { id: 'ps-2', source: 'packiyo', orderNumber: 'PK-50304', status: 'delivered', carrier: 'Posten', trackingNumber: 'PO2233445566', shippedAt: daysAgo(4), deliveredAt: daysAgo(2) },
  ];
}
