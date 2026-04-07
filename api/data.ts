import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { DashboardStats } from '../src/types/index.js';

const useMock = !process.env.SHIPHERO_ACCESS_TOKEN && !process.env.PACKIYO_TOKEN;

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  // Edge cache: serve stale for 60s while revalidating, fresh for 180s
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');

  try {
    let shOrders, pkOrders, shInv, pkInv, shShip, pkShip;

    if (useMock) {
      const mock = await import('../src/services/mock.js');
      const orders = mock.getOrders();
      const inv = mock.getInventory();
      const ship = mock.getShipments();
      shOrders = orders.filter(o => o.source === 'shiphero');
      pkOrders = orders.filter(o => o.source === 'packiyo');
      shInv = inv.filter(i => i.source === 'shiphero');
      pkInv = inv.filter(i => i.source === 'packiyo');
      shShip = ship.filter(s => s.source === 'shiphero');
      pkShip = ship.filter(s => s.source === 'packiyo');
    } else {
      const shiphero = await import('../src/services/shiphero.js');
      const packiyo = await import('../src/services/packiyo.js');

      [shOrders, pkOrders, shInv, pkInv, shShip, pkShip] = await Promise.all([
        shiphero.getOrders().catch(() => []),
        packiyo.getOrders().catch(() => []),
        shiphero.getInventory().catch(() => []),
        packiyo.getInventory().catch(() => []),
        shiphero.getShipments().catch(() => []),
        packiyo.getShipments().catch(() => []),
      ]);
    }

    const orders = [...shOrders, ...pkOrders].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
    const inventory = [...shInv, ...pkInv];
    const shipments = [...shShip, ...pkShip].sort(
      (a, b) => new Date(b.shippedAt || 0).getTime() - new Date(a.shippedAt || 0).getTime()
    );

    const today = new Date().toISOString().slice(0, 10);

    const stats: DashboardStats = {
      totalOrders: orders.length,
      pendingOrders: orders.filter(o => ['pending', 'open', 'processing'].includes(o.status)).length,
      shippedToday: orders.filter(o => o.trackingNumbers.length > 0 && o.updatedAt.startsWith(today)).length,
      lowStockItems: inventory.filter(i => i.quantityAvailable < 10).length,
      ordersBySource: {
        shiphero: shOrders.length,
        packiyo: pkOrders.length,
      },
    };

    return res.json({
      stats,
      orders,
      inventory,
      shipments,
      fetchedAt: new Date().toISOString(),
      mock: useMock,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Sync failed', detail: String(err) });
  }
}
