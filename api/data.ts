import type { VercelRequest, VercelResponse } from '@vercel/node';

const useMock = !process.env.SHIPHERO_ACCESS_TOKEN && !process.env.PACKIYO_TOKEN;
const DISPLAY_LIMIT = 30;

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  // Align cache with the 3-minute cron (vercel.json): cron refreshes every 180s,
  // so s-maxage=180 means TV polls always hit CDN cache, only cron hits origin.
  res.setHeader('Cache-Control', 's-maxage=180, stale-while-revalidate=60');

  try {
    type ServiceResult = {
      pickable: any[];
      backordered: any[];
      truncated: boolean;
      error?: string;
    };

    let shResult: ServiceResult;
    let pkResult: ServiceResult;

    if (useMock) {
      const mock = await import('../src/services/mock.js');
      const mockOrders = mock.getOrders();
      const shOrders = mockOrders.filter(o => o.source === 'shiphero');
      const pkOrders = mockOrders.filter(o => o.source === 'packiyo');
      shResult = { pickable: shOrders, backordered: [], truncated: false };
      pkResult = { pickable: pkOrders, backordered: [], truncated: false };
    } else {
      const shiphero = await import('../src/services/shiphero.js');
      const packiyo = await import('../src/services/packiyo.js');

      [shResult, pkResult] = await Promise.all([
        shiphero.getOrders().catch((err: Error) => ({
          pickable: [], backordered: [], truncated: false, error: err.message,
        })),
        packiyo.getOrders().catch((err: Error) => ({
          pickable: [], backordered: [], truncated: false, error: err.message,
        })),
      ]);
    }

    const shPickable = shResult.pickable;
    const pkPickable = pkResult.pickable;
    const shBackordered = shResult.backordered;
    const pkBackordered = pkResult.backordered;

    const sortByCreated = (a: any, b: any) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    const halfSlot = Math.ceil(DISPLAY_LIMIT / 2);
    const shSorted = shPickable.slice().sort(sortByCreated);
    const pkSorted = pkPickable.slice().sort(sortByCreated);
    const shTake = Math.min(shSorted.length, halfSlot);
    const pkTake = Math.min(pkSorted.length, DISPLAY_LIMIT - shTake);
    const shTakeFinal = Math.min(shSorted.length, DISPLAY_LIMIT - pkTake);
    const orders = [
      ...shSorted.slice(0, shTakeFinal),
      ...pkSorted.slice(0, pkTake),
    ].sort(sortByCreated);

    const pickableUnits = [...shPickable, ...pkPickable].reduce(
      (sum, o) => sum + Math.max(0, (o.totalItems || 0) - (o.backorderedItems || 0)),
      0
    );

    const stats = {
      activeOrders: shPickable.length + pkPickable.length,
      backorderedOrders: shBackordered.length + pkBackordered.length,
      totalItems: pickableUnits,
      ordersBySource: {
        shiphero: shPickable.length,
        packiyo: pkPickable.length,
      },
    };

    return res.json({
      stats,
      orders,
      truncated: shResult.truncated || pkResult.truncated,
      errors: {
        shiphero: shResult.error ?? null,
        packiyo: pkResult.error ?? null,
      },
      fetchedAt: new Date().toISOString(),
      mock: useMock,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch orders', detail: String(err) });
  }
}
