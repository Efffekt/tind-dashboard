// ─────────────────────────────────────────────────────────────────────────
// app.js — Frontend-logikken for Tind Dashboard
//
// Denne filen kjører i nettleseren på TV-en. Den gjør tre ting:
//   1. Poller /api/data hvert 60. sekund og henter siste statistikk + liste
//   2. Tegner dataene inn i DOM-et (store tall i hero, live-liste nederst)
//   3. Viser feilindikatorer hvis én eller begge API-kildene er nede
//
// Ingen frameworks, ingen build-steg — bare vanlig JS som kjøres direkte.
// ─────────────────────────────────────────────────────────────────────────

// ─── Hjelpere for rendering ─────────────────────────────────────────────

// Bygger HTML-en for status-pillen ("Ventende", "Sendt" osv.) i live-listen.
// Tar en rå status-streng og mapper den til norsk tekst + fargeklasse.
function pill(status) {
  // Sanitiser: bare små bokstaver og understrek, alt annet fjernes.
  // Dette gjør at "Skinsecret B2B" blir "skinsecretbb" og faller gjennom
  // til det generiske utfallet nedenfor.
  const n = (status || 'unknown').toLowerCase().replace(/[^a-z_]/g, '');
  // Kart fra ShipHero/Packiyo-statuser til norske etiketter.
  const map = {
    pending: 'Ventende',
    shipped: 'Sendt',
    fulfilled: 'Fullfort',
    delivered: 'Levert',
    cancelled: 'Kansellert',
    processing: 'Behandles',
    open: 'Apen',
    in_transit: 'Under transport',
    intransit: 'Under transport',
  };
  return `<span class="pill pill-${n}">${map[n] || status || 'Ukjent'}</span>`;
}

// Liten merking som viser om en ordre kommer fra ShipHero eller Packiyo.
// Viser "SH" eller "PK" med fargekode — brukes først i hver rad i live-listen.
function stag(s) {
  return `<span class="stag ${s === 'shiphero' ? 'stag-sh' : 'stag-pk'}">${s === 'shiphero' ? 'SH' : 'PK'}</span>`;
}

// Formaterer en tidsstempel til kort relativ tid på norsk.
//   "5 min"   — minst 1 minutt gammelt, mindre enn 60
//   "3t"     — 1-23 timer gammelt
//   "14. apr" — eldre enn 24 timer, viser dato i kort norsk format
// Håndterer også ugyldige datoer defensivt (returnerer "–").
function fmtTime(d) {
  if (!d) return '–';
  const date = new Date(d);
  const ts = date.getTime();
  // Sjekk om datoen er gyldig. NaN → ugyldig.
  if (!Number.isFinite(ts)) return '–';
  const ms = Date.now() - ts;
  // Fremtidig dato (klokken gått feil eller rar data) → "Na" (nå).
  if (ms < 0) return 'Na';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Na';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}t`;
  try {
    return new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' }).format(date);
  } catch {
    // Fallback hvis Intl kaster (bør ikke skje, men vi er defensive).
    return '–';
  }
}

// ─── Stale-highlighting ─────────────────────────────────────────────────

// Terskel: ordre som er eldre enn 48 timer får rød venstre-kant og rød tid.
const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 timer i millisekunder

// Statuser som betyr "ikke aktiv lenger" — disse får IKKE stale-highlight
// fordi en ferdigsendt ordre ikke er "stuck", den er ferdig.
const INACTIVE_STATUSES = new Set(['fulfilled', 'cancelled', 'canceled', 'delivered', 'shipped']);

// ─── Tegn live-listen (30 ordre) ────────────────────────────────────────

function renderOrders(orders) {
  const el = document.getElementById('orders-feed');
  // Tom liste → vis "Ingen ordrer"-melding.
  if (!orders.length) {
    el.innerHTML = '<div class="feed-empty">Ingen ordrer</div>';
    return;
  }

  const now = Date.now();

  // Tabellhodet med norske kolonnenavn.
  const head = `<div class="orders-head"><span>Ordre</span><span>Klient</span><span style="text-align:right">Antall</span><span>Status</span><span style="text-align:right">Tid</span></div>`;

  // Bygg én rad per ordre.
  const body = orders.map(o => {
    const age = now - new Date(o.createdAt).getTime();
    const active = !INACTIVE_STATUSES.has(o.status);
    // Stale = aktiv og eldre enn 48 timer. Ferdigsendte ordre er ikke "stale".
    const stale = active && age > STALE_THRESHOLD_MS;
    return `<div class="order-row${stale ? ' stale' : ''}">
      <div class="order-id">${stag(o.source)}<span class="order-num">${o.orderNumber}</span></div>
      <span class="order-customer">${o.customerName}</span>
      <span class="order-qty font-number">${o.totalItems}</span>
      ${pill(o.status)}
      <span class="order-time">${fmtTime(o.createdAt)}</span>
    </div>`;
  }).join('');

  el.innerHTML = head + `<div class="orders-body">${body}</div>`;
}

// ─── Per-kilde feilindikator ────────────────────────────────────────────

// Hver stat-bar-celle (ShipHero, Packiyo) kan vise en rød ⚠ hvis den
// kilden sin API er nede. Denne funksjonen setter/fjerner den klassen
// basert på hva /api/data returnerte.
function applySourceErrorState(source, errorMsg) {
  const cell = document.getElementById(`cell-${source}`);
  const label = document.getElementById(`slabel-${source}`);
  if (!cell || !label) return;
  if (errorMsg) {
    // Feil → legg på .errored-klassen (CSS viser rød ramme + ⚠)
    // og bytt etiketten slik at det er tydelig hva som er galt.
    cell.classList.add('errored');
    label.textContent = 'frakoblet – henter ikke data';
  } else {
    // Ingen feil → fjern klassen, sett tilbake normal etikett.
    cell.classList.remove('errored');
    label.textContent = 'aktive ordrer';
  }
}

// ─── Hoved-polling: hent /api/data og oppdater UI ───────────────────────

async function load() {
  try {
    // cache: 'no-store' forhindrer at nettleseren serverer gamle svar.
    // Vi vil alltid gå til CDN-cachen, ikke browser-cachen.
    const resp = await fetch('/api/data', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Defensive oppslag — hvis API-svaret mangler felter (pga. feil),
    // faller vi tilbake til tomme verdier i stedet for å krasje.
    const stats = data.stats || {};
    const bySource = stats.ordersBySource || {};

    // Oppdater de store tallene i hero-delen.
    document.getElementById('stat-active').textContent = stats.activeOrders ?? 0;
    document.getElementById('stat-items').textContent = stats.totalItems ?? 0;
    // Oppdater stat-barens per-kilde-tall.
    document.getElementById('source-sh').textContent = bySource.shiphero ?? 0;
    document.getElementById('source-pk').textContent = bySource.packiyo ?? 0;

    // Tegn live-listen på nytt.
    renderOrders(Array.isArray(data.orders) ? data.orders : []);

    // Sett feilstatus per kilde (grønn eller rød ⚠).
    const errors = data.errors || {};
    applySourceErrorState('sh', errors.shiphero);
    applySourceErrorState('pk', errors.packiyo);

    // Live-dot i header: grønn hvis minst én kilde virker, rød hvis begge er nede.
    const bothDown = !!errors.shiphero && !!errors.packiyo;
    const liveDot = document.getElementById('live-dot');
    liveDot.className = bothDown ? 'live-dot off' : 'live-dot on';
    document.getElementById('status-text').textContent =
      bothDown ? 'Frakoblet' : data.mock ? 'Testdata' : 'Live';

    // Vis/skjul de to bannerne (mock og truncated).
    document.getElementById('mock-banner').style.display = data.mock ? 'block' : 'none';
    document.getElementById('trunc-banner').style.display = data.truncated ? 'block' : 'none';

    // "Oppdatert HH:MM"-tekst i header, formatert i norsk tidsformat.
    try {
      const t = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit' }).format(new Date(data.fetchedAt));
      document.getElementById('last-sync').textContent = `Oppdatert ${t}`;
    } catch {
      document.getElementById('last-sync').textContent = '';
    }
  } catch (err) {
    // Alt feilet (nettverk, parse, osv.) → vis dashbordet som frakoblet.
    // Dette er en annen tilstand enn "API virker men returnerte feil".
    document.getElementById('live-dot').className = 'live-dot off';
    document.getElementById('status-text').textContent = 'Frakoblet';
    applySourceErrorState('sh', 'offline');
    applySourceErrorState('pk', 'offline');
  }
}

// ─── Klokke i header ────────────────────────────────────────────────────

// Oppdater digital klokke hvert sekund. Denne er helt frikoblet fra
// API-pollingen — klokken tikker selv om backend er nede.
setInterval(() => {
  document.getElementById('clock').textContent = new Intl.DateTimeFormat('nb-NO', {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(new Date());
}, 1000);

// ─── Start: last data én gang med en gang, så poll hvert 60. sekund ────
load();
setInterval(load, 60000);
