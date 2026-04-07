import type { VercelRequest, VercelResponse } from '@vercel/node';

const useMock = !process.env.SHIPHERO_ACCESS_TOKEN && !process.env.PACKIYO_TOKEN;

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');

  try {
    let shOrders, pkOrders;

    if (useMock) {
      const mock = await import('../src/services/mock.js');
      const orders = mock.getOrders();
      shOrders = orders.filter(o => o.source === 'shiphero');
      pkOrders = orders.filter(o => o.source === 'packiyo');
    } else {
      const shiphero = await import('../src/services/shiphero.js');
      const packiyo = await import('../src/services/packiyo.js');

      [shOrders, pkOrders] = await Promise.all([
        shiphero.getOrders().catch(() => []),
        packiyo.getOrders().catch(() => []),
      ]);
    }

    const orders = [...shOrders, ...pkOrders].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const today = new Date().toISOString().slice(0, 10);

    const stats = {
      totalOrders: orders.length,
      pendingOrders: orders.filter(o => ['pending', 'open', 'processing'].includes(o.status)).length,
      shippedToday: orders.filter(o => o.trackingNumbers.length > 0 && o.updatedAt.startsWith(today)).length,
      ordersBySource: {
        shiphero: shOrders.length,
        packiyo: pkOrders.length,
      },
    };

    return res.json({ stats, orders, fetchedAt: new Date().toISOString(), mock: useMock });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch orders', detail: String(err) });
  }
}
