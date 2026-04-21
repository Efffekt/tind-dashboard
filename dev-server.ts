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
import {
  COOKIE_NAME,
  buildClearCookieHeader,
  buildSetCookieHeader,
  createSessionCookieValue,
  parseCookie,
  verifySessionCookieValue,
} from './src/auth.js';
import { buildGroups } from './src/groups.js';
import { buildAlerts } from './src/alerts.js';
import { osloMidnightIso } from './src/time.js';

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
    let shShippedToday = 0;
    let pkShippedToday = 0;

    // Midnatt i dag i Oslo-tid — grensen for "sendt i dag"-KPI.
    const sinceIso = osloMidnightIso();

    if (useMock) {
      // MOCK-MODUS
      const mock = await import('./src/services/mock.js');
      const mockOrders = mock.getOrders();
      const shOrders = mockOrders.filter(o => o.source === 'shiphero');
      const pkOrders = mockOrders.filter(o => o.source === 'packiyo');
      shResult = { pickable: shOrders, backordered: [], truncated: false };
      pkResult = { pickable: pkOrders, backordered: [], truncated: false };
      const isShipped = (s: string) => ['fulfilled', 'shipped', 'delivered'].includes(s);
      shShippedToday = shOrders.filter(o => isShipped(o.status)).length;
      pkShippedToday = pkOrders.filter(o => isShipped(o.status)).length;
    } else {
      // EKTE-MODUS: kall begge API-ene parallelt — inkl. "sendt i dag"-KPI-ene.
      const shiphero = await import('./src/services/shiphero.js');
      const packiyo = await import('./src/services/packiyo.js');

      const [shRes, pkRes, shShipped, pkShipped] = await Promise.all([
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
        // KPI-feil skal ikke ta ned responsen — returner 0 ved feil.
        shiphero.getShippedSinceCount(sinceIso).catch((err: Error) => {
          console.warn('ShipHero getShippedSinceCount error:', err.message);
          return 0;
        }),
        packiyo.getShippedSinceCount(sinceIso).catch((err: Error) => {
          console.warn('Packiyo getShippedSinceCount error:', err.message);
          return 0;
        }),
      ]);
      shResult = shRes;
      pkResult = pkRes;
      shShippedToday = shShipped;
      pkShippedToday = pkShipped;
    }

    // Pakk ut for lesbarhet.
    const shPickable = shResult.pickable;
    const pkPickable = pkResult.pickable;
    const shBackordered = shResult.backordered;
    const pkBackordered = pkResult.backordered;

    // ─── Klient-/workflow-rollup (delt med api/data.ts via src/groups.ts) ──
    const groups = buildGroups([...shPickable, ...pkPickable]);
    // Popup-alerts (ekspress + Skinsecret B2B). Klienten deduper selv.
    const alerts = buildAlerts([...shPickable, ...pkPickable]);

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
        shippedToday: shShippedToday + pkShippedToday,
        ordersBySource: {
          shiphero: shPickable.length,
          packiyo: pkPickable.length,
        },
      },
      groups,
      alerts,
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
// /api/auth-handler (speil av api/auth.ts for lokalt bruk)
// Sett DASHBOARD_PIN og SESSION_SECRET i .env for å aktivere.
// ─────────────────────────────────────────────────────────────────────────

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function handleAuth(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Allow': 'POST' });
    return res.end();
  }

  // Utlogging.
  if (url.searchParams.get('logout')) {
    // Lokalt kjører vi over HTTP, så secure: false.
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': buildClearCookieHeader({ secure: false }),
    });
    return res.end(JSON.stringify({ ok: true }));
  }

  const expectedPin = process.env.DASHBOARD_PIN || '';
  const secret = process.env.SESSION_SECRET || '';
  if (!expectedPin || !secret) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Server not configured (missing DASHBOARD_PIN or SESSION_SECRET)' }));
  }

  const body = await readJsonBody(req);
  const pin = typeof body?.pin === 'string' ? body.pin : '';
  if (pin !== expectedPin) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid PIN' }));
  }

  const cookieValue = await createSessionCookieValue(secret);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Set-Cookie': buildSetCookieHeader(cookieValue, { secure: false }),
  });
  return res.end(JSON.stringify({ ok: true }));
}

// ─────────────────────────────────────────────────────────────────────────
// Gate-logikk: speiler middleware.ts for lokal utvikling.
// Returnerer true hvis requesten ble håndtert (redirect/401) og videre
// prosessering skal stoppe.
// ─────────────────────────────────────────────────────────────────────────

// Stier som slipper forbi PIN-gaten uten autentisering.
// MÅ matche middleware.ts-unntakene for å unngå divergens mellom dev og prod.
function isPublicPath(pathname: string): boolean {
  if (pathname === '/login' || pathname === '/login.html') return true;
  if (pathname === '/api/auth') return true;
  if (pathname === '/favicon.svg') return true;
  if (pathname.startsWith('/logos/')) return true;
  return false;
}

async function isAuthed(req: http.IncomingMessage): Promise<boolean> {
  const secret = process.env.SESSION_SECRET || '';
  if (!secret) return false;
  const cookieValue = parseCookie(req.headers.cookie, COOKIE_NAME);
  return verifySessionCookieValue(cookieValue, secret);
}

// ─────────────────────────────────────────────────────────────────────────
// HTTP-server: ruter /api/data, /api/auth, og server statiske filer.
// Alt bak PIN-gaten med mindre stien er i isPublicPath().
// ─────────────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const raw = req.url || '/';
  // URL-parsing krever en base. Vi bryr oss bare om pathname + search lokalt.
  const url = new URL(raw, 'http://localhost');
  const pathname = url.pathname;

  // /api/auth slipper gjennom uten autentisering (det er selve login-endepunktet).
  if (pathname === '/api/auth') {
    return handleAuth(req, res, url);
  }

  // Gate: alt som ikke er public krever gyldig cookie.
  if (!isPublicPath(pathname)) {
    const authed = await isAuthed(req);
    if (!authed) {
      // API-kall → 401 JSON så frontend kan reagere.
      if (pathname.startsWith('/api/')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Unauthorized' }));
      }
      // HTML/asset → redirect til /login med ?next=.
      const next = pathname + url.search;
      const loc = next !== '/' && next !== '/login'
        ? `/login?next=${encodeURIComponent(next)}`
        : '/login';
      res.writeHead(307, { Location: loc });
      return res.end();
    }
  }

  // API-ruten går til handleren over (bak gaten).
  if (pathname === '/api/data') {
    return handleApi(res);
  }

  // /login → server login.html (uten å kreve at URL-en ender på .html)
  const resolvedPath = pathname === '/' ? 'index.html'
    : pathname === '/login' ? 'login.html'
    : pathname.replace(/^\//, '');

  // Alt annet: server statiske filer fra public/-mappa.
  const filePath = path.join(PUBLIC, resolvedPath);
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
