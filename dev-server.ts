import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = 3001;

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Import the API handler dynamically
async function handleApi(res: http.ServerResponse) {
  // Inline the mock data logic for local dev
  const mock = await import('./src/services/mock.js');
  const orders = mock.getOrders();

  const shOrders = orders.filter(o => o.source === 'shiphero');
  const pkOrders = orders.filter(o => o.source === 'packiyo');
  const today = new Date().toISOString().slice(0, 10);

  const data = {
    stats: {
      totalOrders: orders.length,
      pendingOrders: orders.filter(o => ['pending', 'open', 'processing'].includes(o.status)).length,
      shippedToday: orders.filter(o => o.trackingNumbers.length > 0 && o.updatedAt.startsWith(today)).length,
      ordersBySource: { shiphero: shOrders.length, packiyo: pkOrders.length },
    },
    orders,
    fetchedAt: new Date().toISOString(),
    mock: true,
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
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
