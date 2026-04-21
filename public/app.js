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

// Escaper innhold vi skriver inn i innerHTML. Butikknavn kommer fra eksterne
// API-er og kan i teorien inneholde HTML-tegn — enkel defensiv rensing.
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Liten merking som viser om en ordre-gruppe kommer fra ShipHero eller Packiyo.
// Viser "SH" eller "PK" med fargekode — brukes først i hver rad.
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

// Terskel: gruppe med eldste ordre eldre enn 48 timer får rød venstre-kant
// og rød tid. Surfacer butikker som har ordre som har ligget for lenge.
const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000;

// ─── Tegn klient-/workflow-rollupen ────────────────────────────────────
//
// En rad per butikk/workflow: kilde-tag, navn, antall ordre, antall varer,
// og eldste alder. Sortert med flest ordre øverst (gjøres av server).

function renderGroups(groups) {
  const el = document.getElementById('orders-feed');
  if (!groups.length) {
    el.innerHTML = '<div class="feed-empty">Ingen aktive ordrer</div>';
    return;
  }

  const now = Date.now();

  const head = `<div class="orders-head">
    <span>Kilde</span>
    <span>Butikk</span>
    <span style="text-align:right">Ordrer</span>
    <span style="text-align:right">Varer</span>
    <span style="text-align:right">Eldste</span>
  </div>`;

  const body = groups.map(g => {
    // Stale = gruppen har en ordre eldre enn 48 timer. Gir TV-en tydelig
    // visuell prioritering av butikker med liggende ordre.
    const oldestTs = g.oldestCreatedAt ? new Date(g.oldestCreatedAt).getTime() : 0;
    const stale = Number.isFinite(oldestTs) && oldestTs > 0 && (now - oldestTs) > STALE_THRESHOLD_MS;
    // Urgent = gruppen har aktive ekspress- eller Skinsecret B2B-ordre.
    // Persistent markering i tilfelle operatøren gikk glipp av popup-varselet.
    const urgent = (g.urgentCount || 0) > 0;
    const urgentLabel = g.urgentType === 'packiyo-express' ? 'ekspress'
                       : g.urgentType === 'skinsecret-b2b' ? 'B2B'
                       : '';
    const urgentCls = urgent
      ? ` urgent urgent-${g.urgentType === 'packiyo-express' ? 'express' : 'b2b'}`
      : '';
    const urgentBadge = urgent
      ? `<span class="urgent-badge">${g.urgentCount} ${urgentLabel}</span>`
      : '';
    return `<div class="order-row group-row${stale ? ' stale' : ''}${urgentCls}">
      <div class="order-id">${stag(g.source)}</div>
      <span class="order-customer">${esc(g.displayName)}${urgentBadge}</span>
      <span class="order-qty font-number">${g.count}</span>
      <span class="group-items font-number">${g.items}</span>
      <span class="order-time">${fmtTime(g.oldestCreatedAt)}</span>
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

// ─── Popup-varsel for ekspress-/Skinsecret B2B-ordre ────────────────────
//
// Serveren returnerer ALLE aktive alerts hver gang. Vi deduper på klient-
// siden med localStorage slik at:
//   - Samme ordre fyrer aldri popup to ganger
//   - Første gang TV-en laster siden poppes INGENTING opp (baseline)
//   - Hvis TV-en reboote, regner vi eksisterende alerts som allerede sett
//     (noe operatørene allerede ser i hovedlisten — ingen grunn til storm)
//
// Hvis flere alerts kommer samtidig vises de én om gangen i kø.

const ALERT_SEEN_KEY = 'tind_seen_alerts';    // localStorage-nøkkel: { [alertId]: firstSeenMs }
const ALERT_SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // Rydd bort IDs eldre enn 7 dager
const ALERT_AUTO_DISMISS_MS = 12_000;         // Popup lukkes automatisk etter 12s
let alertBaselined = false;                   // Settes til true etter første processAlerts
const alertQueue = [];                        // FIFO-kø; vi viser én om gangen
let alertActive = false;                      // Er en popup synlig akkurat nå?
let alertDismissTimer = null;

function loadSeenAlerts() {
  try { return JSON.parse(localStorage.getItem(ALERT_SEEN_KEY) || '{}') || {}; }
  catch { return {}; }
}
function saveSeenAlerts(map) {
  try { localStorage.setItem(ALERT_SEEN_KEY, JSON.stringify(map)); } catch {}
}

// Tar listen fra /api/data, skriver nye IDs til localStorage, og køer popups
// for hver ID som ikke har vært sett før — så fremt vi ikke er på første last.
function processAlerts(alerts) {
  if (!Array.isArray(alerts)) return;
  const seen = loadSeenAlerts();
  const now = Date.now();

  for (const a of alerts) {
    if (!a || !a.id) continue;
    if (!(a.id in seen)) {
      if (alertBaselined) {
        alertQueue.push(a);
      }
      seen[a.id] = now;
    }
  }

  // Rydd opp gamle IDs slik at localStorage ikke vokser uendelig.
  for (const id of Object.keys(seen)) {
    if (now - seen[id] > ALERT_SEEN_TTL_MS) delete seen[id];
  }
  saveSeenAlerts(seen);

  alertBaselined = true;
  drainAlertQueue();
}

function drainAlertQueue() {
  if (alertActive) return;
  const next = alertQueue.shift();
  if (!next) return;
  showAlertPopup(next);
}

// Tegn én popup og start auto-dismiss-timeren.
function showAlertPopup(a) {
  const overlay = document.getElementById('alert-overlay');
  const card = document.getElementById('alert-card');
  const kicker = document.getElementById('alert-kicker');
  const title = document.getElementById('alert-title');
  const orderEl = document.getElementById('alert-order');
  const storeEl = document.getElementById('alert-store');
  if (!overlay || !card) return;

  // Sett type-avhengig farge + tekst.
  card.classList.remove('type-express', 'type-b2b');
  if (a.type === 'packiyo-express') {
    card.classList.add('type-express');
    kicker.textContent = 'Ny ekspress-ordre';
    title.textContent = a.shippingMethod || 'Express';
  } else if (a.type === 'skinsecret-b2b') {
    card.classList.add('type-b2b');
    kicker.textContent = 'Ny Skinsecret B2B';
    title.textContent = 'Skinsecret B2B';
  } else {
    kicker.textContent = 'Ny ordre';
    title.textContent = a.displayName || '—';
  }
  orderEl.textContent = a.orderNumber || '—';
  storeEl.textContent = a.displayName || '—';

  overlay.style.display = 'flex';
  alertActive = true;

  clearTimeout(alertDismissTimer);
  alertDismissTimer = setTimeout(dismissAlertPopup, ALERT_AUTO_DISMISS_MS);
}

function dismissAlertPopup() {
  const overlay = document.getElementById('alert-overlay');
  if (!overlay) return;
  overlay.style.display = 'none';
  alertActive = false;
  clearTimeout(alertDismissTimer);
  alertDismissTimer = null;
  // Hvis flere alerts ligger i kø, vis den neste.
  setTimeout(drainAlertQueue, 120);
}

// Klikk hvor som helst på overlayen for å lukke manuelt.
document.addEventListener('click', (e) => {
  const overlay = document.getElementById('alert-overlay');
  if (overlay && e.target && (e.target === overlay || overlay.contains(e.target))) {
    dismissAlertPopup();
  }
});

// ─── Hoved-polling: hent /api/data og oppdater UI ───────────────────────

async function load() {
  try {
    // cache: 'no-store' forhindrer at nettleseren serverer gamle svar.
    // Vi vil alltid gå til CDN-cachen, ikke browser-cachen.
    const resp = await fetch('/api/data', { cache: 'no-store' });
    // 401 = sesjonen er ugyldig/utløpt. Last siden på nytt slik at
    // middleware redirectr til /login. Vi kommer IKKE tilbake hit før
    // brukeren har logget inn på nytt.
    if (resp.status === 401) {
      location.reload();
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    // Defensive oppslag — hvis API-svaret mangler felter (pga. feil),
    // faller vi tilbake til tomme verdier i stedet for å krasje.
    const stats = data.stats || {};
    const bySource = stats.ordersBySource || {};

    // Oppdater de store tallene i hero-delen.
    document.getElementById('stat-active').textContent = stats.activeOrders ?? 0;
    document.getElementById('stat-items').textContent = stats.totalItems ?? 0;
    document.getElementById('stat-shipped').textContent = stats.shippedToday ?? 0;
    // Oppdater stat-barens per-kilde-tall.
    document.getElementById('source-sh').textContent = bySource.shiphero ?? 0;
    document.getElementById('source-pk').textContent = bySource.packiyo ?? 0;

    // Tegn klient-rollupen på nytt.
    renderGroups(Array.isArray(data.groups) ? data.groups : []);

    // Popup-varsel for ekspress/B2B-ordre. Første gang ignoreres IDs (baseline),
    // deretter fyrer nye IDs popups. Se processAlerts for detaljer.
    processAlerts(data.alerts);

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
