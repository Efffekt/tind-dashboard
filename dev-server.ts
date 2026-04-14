// ─────────────────────────────────────────────────────────────────────────
// dev-server.ts — Lokal utviklings-server
//
// Denne filen kjører lokalt når du gjør `npm run dev`. Den speiler det
// Vercel gjør i produksjon (api/data.ts + statisk public/-server), men
// som én enkelt Node HTTP-server på port 3001.
//
// Vi har denne fordi:
//   1. Vercel sin `vercel dev` er treg og vanskelig å debugge
//   2. Det er mye enklere å iterere lokalt med en vanlig Node-server
//   3. tsx watch restarter automatisk ved filendringer
//
// Denne filen kjører ALDRI i produksjon. api/data.ts er produksjons-
// versjonen av /api/data-ruten, og Vercel serverer public/-mappa direkte.
// ─────────────────────────────────────────────────────────────────────────

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ESM-aktig __dirname — Node gir ikke dette ut av boksen for import.meta.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3001;

// ─── Last .env manuelt ──────────────────────────────────────────────────
// tsx laster ikke .env automatisk. I stedet for å legge til en dotenv-avhengighet,
// leser vi .env-filen manuelt og setter prosess-miljøvariabler. Hopper over
// tomme linjer og kommentarer (linjer som starter med #).
try {
  const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    // Ikke overskriv variabler som allerede er satt av shell-et.
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env-filen finnes ikke — det er OK, vi faller tilbake til mock-modus.
}

// MIME-typer for statiske filer (brukes for public/-innhold).
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// Samme konstant som i api/data.ts — maks ordre i live-listen.
const DISPLAY_LIMIT = 30;

// Form-definisjon for hva hver tjeneste returnerer.
type ServiceResult = {
  pickable: any[];
  backordered: any[];
  truncated: boolean;
  error?: string;
};

// ─────────────────────────────────────────────────────────────────────────
// /api/data-handler (speil av api/data.ts for lokalt bruk)
// ─────────────────────────────────────────────────────────────────────────

async function handleApi(res: http.ServerResponse) {
  // Samme mock-fallback som i produksjon: hvis ingen tokens er satt,
  // bruker vi test-data og viser det gule "Viser testdata"-banneret.
  const useMock = !process.env.SHIPHERO_ACCESS_TOKEN && !process.env.PACKIYO_TOKEN;

  try {
    let shResult: ServiceResult;
    let pkResult: ServiceResult;

    if (useMock) {
      // MOCK-MODUS
      const mock = await import('./src/services/mock.js');
      const mockOrders = mock.getOrders();
      const shOrders = mockOrders.filter(o => o.source === 'shiphero');
      const pkOrders = mockOrders.filter(o => o.source === 'packiyo');
      shResult = { pickable: shOrders, backordered: [], truncated: false };
      pkResult = { pickable: pkOrders, backordered: [], truncated: false };
    } else {
      // EKTE-MODUS: kall begge API-ene parallelt.
      const shiphero = await import('./src/services/shiphero.js');
      const packiyo = await import('./src/services/packiyo.js');

      [shResult, pkResult] = await Promise.all([
        // Per-kilde .catch: feil i én kilde tar IKKE ned den andre.
        // Feilmeldingen lagres og sendes til frontend som rødt varsel.
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

    // Pakk ut for lesbarhet.
    const shPickable = shResult.pickable;
    const pkPickable = pkResult.pickable;
    const shBackordered = shResult.backordered;
    const pkBackordered = pkResult.backordered;

    // ─── Myk-balansert display-liste (15 per kilde, med backfill) ────────
    // Samme logikk som i api/data.ts. Vi kopierer den her i stedet for å
    // hente ut til en delt fil, fordi dev-server er en tynn wrapper og
    // duplisering er enklere enn å introdusere et nytt abstraksjonslag.
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

    // Varer å plukke = summen av (totalItems - backorderedItems) per ordre.
    // Trekker fra restordre-delen siden den ikke kan plukkes nå.
    const pickableUnits = [...shPickable, ...pkPickable].reduce(
      (sum, o) => sum + Math.max(0, (o.totalItems || 0) - (o.backorderedItems || 0)),
      0
    );

    // Bygg det samme JSON-svaret som api/data.ts gjør i produksjon.
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
    // Last-resort feilhåndtering.
    console.error('API error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Failed to fetch orders', detail: String(err) }));
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP-server: ruter /api/data til handleApi, alt annet som statiske filer
// ─────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';

  // API-ruten går til handleren over.
  if (url === '/api/data') {
    return handleApi(res);
  }

  // Alt annet: server statiske filer fra public/-mappa.
  // / → index.html (rotstien leverer hoved-dashbordet)
  const filePath = path.join(PUBLIC, url === '/' ? 'index.html' : url);
  const ext = path.extname(filePath);

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  } catch {
    // SPA-fallback: hvis fila ikke finnes, returner index.html likevel.
    // Dette betyr at f.eks. /noe-som-ikke-finnes også laster dashbordet.
    const html = fs.readFileSync(path.join(PUBLIC, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }
});

server.listen(PORT, () => {
  console.log(`Tind Dashboard dev server: http://localhost:${PORT}`);
});
