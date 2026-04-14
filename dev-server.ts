import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3001;

// Load .env (simple parser, no deps)
try {
  const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env not present — fine, will use mock
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const DISPLAY_LIMIT = 30;

type ServiceResult = {
  pickable: any[];
  backordered: any[];
  truncated: boolean;
  error?: string;
};

async function handleApi(res: http.ServerResponse) {
  const useMock = !process.env.SHIPHERO_ACCESS_TOKEN && !process.env.PACKIYO_TOKEN;

  try {
    let shResult: ServiceResult;
    let pkResult: ServiceResult;

    if (useMock) {
      const mock = await import('./src/services/mock.js');
      const mockOrders = mock.getOrders();
      const shOrders = mockOrders.filter(o => o.source === 'shiphero');
      const pkOrders = mockOrders.filter(o => o.source === 'packiyo');
      shResult = { pickable: shOrders, backordered: [], truncated: false };
      pkResult = { pickable: pkOrders, backordered: [], truncated: false };
    } else {
      const shiphero = await import('./src/services/shiphero.js');
      const packiyo = await import('./src/services/packiyo.js');

      [shResult, pkResult] = await Promise.all([
        shiphero.getOrders().catch((err: Error) => {
          console.error('ShipHero error:', err.message);
          return { pickable: [], backordered: [], truncated: false, error: err.message };
        }),
        packiyo.getOrders().catch((err: Error) => {
          console.error('Packiyo error:', err.message);
          return { pickable: [], backordered: [], truncated: false, error: err.message };
        }),
      ]);
    }

    const shPickable = shResult.pickable;
    const pkPickable = pkResult.pickable;
    const shBackordered = shResult.backordered;
    const pkBackordered = pkResult.backordered;

    // Display list: only pickable orders. Soft-balance per source so both get airtime,
    // but if one side has fewer than half, the other backfills the empty slots.
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

    // Varer å plukke = pickable units (exclude backordered portion) across pickable orders
    const pickableUnits = [...shPickable, ...pkPickable].reduce(
      (sum, o) => sum + Math.max(0, (o.totalItems || 0) - (o.backorderedItems || 0)),
      0
    );

    const data = {
      stats: {
        activeOrders: shPickable.length + pkPickable.length,
        backorderedOrders: shBackordered.length + pkBackordered.length,
        totalItems: pickableUnits,
        ordersBySource: {
          shiphero: shPickable.length,
          packiyo: pkPickable.length,
        },
      },
      orders,
      truncated: shResult.truncated || pkResult.truncated,
      errors: {
        shiphero: shResult.error ?? null,
        packiyo: pkResult.error ?? null,
      },
      fetchedAt: new Date().toISOString(),
      mock: useMock,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (err) {
    console.error('API error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch orders', detail: String(err) }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  if (url === '/api/data') {
    return handleApi(res);
  }

  // Serve static files
  const filePath = path.join(PUBLIC, url === '/' ? 'index.html' : url);
  const ext = path.extname(filePath);

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    // SPA fallback
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
});

server.listen(PORT, () => {
  console.log(`Tind Dashboard dev server: http://localhost:${PORT}`);
});
