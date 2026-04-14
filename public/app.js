// Tind Dashboard

function pill(status) {
  const n = (status || 'unknown').toLowerCase().replace(/[^a-z_]/g, '');
  const map = { pending:'Ventende', shipped:'Sendt', fulfilled:'Fullfort', delivered:'Levert', cancelled:'Kansellert', processing:'Behandles', open:'Apen', in_transit:'Under transport', intransit:'Under transport' };
  return `<span class="pill pill-${n}">${map[n] || status || 'Ukjent'}</span>`;
}

function stag(s) {
  return `<span class="stag ${s === 'shiphero' ? 'stag-sh' : 'stag-pk'}">${s === 'shiphero' ? 'SH' : 'PK'}</span>`;
}

function fmtTime(d) {
  if (!d) return '–';
  const date = new Date(d);
  const ts = date.getTime();
  if (!Number.isFinite(ts)) return '–';
  const ms = Date.now() - ts;
  if (ms < 0) return 'Na';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Na';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}t`;
  try {
    return new Intl.DateTimeFormat('nb-NO', { day:'numeric', month:'short' }).format(date);
  } catch {
    return '–';
  }
}

const STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours
const INACTIVE_STATUSES = new Set(['fulfilled', 'cancelled', 'canceled', 'delivered', 'shipped']);

function renderOrders(orders) {
  const el = document.getElementById('orders-feed');
  if (!orders.length) { el.innerHTML = '<div class="feed-empty">Ingen ordrer</div>'; return; }

  const now = Date.now();
  const head = `<div class="orders-head"><span>Ordre</span><span>Klient</span><span style="text-align:right">Antall</span><span>Status</span><span style="text-align:right">Tid</span></div>`;
  const body = orders.map(o => {
    const age = now - new Date(o.createdAt).getTime();
    const active = !INACTIVE_STATUSES.has(o.status);
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

function applySourceErrorState(source, errorMsg) {
  const cell = document.getElementById(`cell-${source}`);
  const label = document.getElementById(`slabel-${source}`);
  if (!cell || !label) return;
  if (errorMsg) {
    cell.classList.add('errored');
    label.textContent = 'frakoblet – henter ikke data';
  } else {
    cell.classList.remove('errored');
    label.textContent = 'aktive ordrer';
  }
}

async function load() {
  try {
    const resp = await fetch('/api/data', { cache: 'no-store' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    const stats = data.stats || {};
    const bySource = stats.ordersBySource || {};

    document.getElementById('stat-active').textContent = stats.activeOrders ?? 0;
    document.getElementById('stat-items').textContent = stats.totalItems ?? 0;
    document.getElementById('source-sh').textContent = bySource.shiphero ?? 0;
    document.getElementById('source-pk').textContent = bySource.packiyo ?? 0;

    renderOrders(Array.isArray(data.orders) ? data.orders : []);

    const errors = data.errors || {};
    applySourceErrorState('sh', errors.shiphero);
    applySourceErrorState('pk', errors.packiyo);

    const bothDown = !!errors.shiphero && !!errors.packiyo;
    const liveDot = document.getElementById('live-dot');
    liveDot.className = bothDown ? 'live-dot off' : 'live-dot on';
    document.getElementById('status-text').textContent =
      bothDown ? 'Frakoblet' : data.mock ? 'Testdata' : 'Live';

    document.getElementById('mock-banner').style.display = data.mock ? 'block' : 'none';
    document.getElementById('trunc-banner').style.display = data.truncated ? 'block' : 'none';

    try {
      const t = new Intl.DateTimeFormat('nb-NO', { hour:'2-digit', minute:'2-digit' }).format(new Date(data.fetchedAt));
      document.getElementById('last-sync').textContent = `Oppdatert ${t}`;
    } catch {
      document.getElementById('last-sync').textContent = '';
    }
  } catch (err) {
    document.getElementById('live-dot').className = 'live-dot off';
    document.getElementById('status-text').textContent = 'Frakoblet';
    applySourceErrorState('sh', 'offline');
    applySourceErrorState('pk', 'offline');
  }
}

// Clock
setInterval(() => {
  document.getElementById('clock').textContent = new Intl.DateTimeFormat('nb-NO', { hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(new Date());
}, 1000);

load();
setInterval(load, 60000);
