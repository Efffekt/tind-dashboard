// ─── Tind Order Dashboard TV ───

function pill(status) {
  const n = (status || 'unknown').toLowerCase().replace(/[^a-z_]/g, '');
  const labels = {
    pending: 'Ventende', shipped: 'Sendt', fulfilled: 'Fullfort',
    delivered: 'Levert', cancelled: 'Kansellert', processing: 'Behandles',
    open: 'Apen', in_transit: 'Under transport', intransit: 'Under transport',
  };
  return `<span class="pill pill-${n}">${labels[n] || status || 'Ukjent'}</span>`;
}

function stag(source) {
  return `<span class="stag ${source === 'shiphero' ? 'stag-sh' : 'stag-pk'}">${source === 'shiphero' ? 'SH' : 'PK'}</span>`;
}

function fmtTime(d) {
  if (!d) return '–';
  const date = new Date(d);
  const diffM = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffM < 1) return 'Na';
  if (diffM < 60) return `${diffM}m`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}t`;
  return new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short' }).format(date);
}

function setStatus(state, text) {
  document.querySelector('.pulse-dot').className = `pulse-dot ${state}`;
  document.getElementById('status-text').textContent = text;
}

function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.totalOrders;
  document.getElementById('stat-pending').textContent = stats.pendingOrders;
  document.getElementById('stat-shipped').textContent = stats.shippedToday;
  document.getElementById('source-sh').textContent = stats.ordersBySource.shiphero;
  document.getElementById('source-pk').textContent = stats.ordersBySource.packiyo;

  // Date in hero
  const now = new Date();
  document.getElementById('hero-date').textContent = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(now);
}

function renderOrders(orders) {
  const el = document.getElementById('orders-feed');
  if (!orders.length) { el.innerHTML = '<div class="feed-empty">Ingen ordrer</div>'; return; }

  // Duplicate for infinite scroll effect
  const rows = orders.map(o => `
    <div class="order-row">
      <div class="order-id">${stag(o.source)}<span class="order-num">${o.orderNumber}</span></div>
      <span class="order-customer">${o.customerName}</span>
      <span class="order-qty font-number">${o.totalItems}</span>
      ${pill(o.status)}
      <span class="order-time">${fmtTime(o.createdAt)}</span>
    </div>
  `).join('');

  // Double the content for seamless loop if enough orders
  el.innerHTML = orders.length > 8 ? rows + rows : rows;

  // Only animate if content overflows
  if (orders.length <= 8) {
    el.style.animation = 'none';
  }
}

async function load() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();

    renderStats(data.stats);
    renderOrders(data.orders);
    setStatus('online', data.mock ? 'TESTDATA' : 'LIVE');
    document.getElementById('mock-banner').style.display = data.mock ? 'block' : 'none';

    const t = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(data.fetchedAt));
    document.getElementById('last-sync').textContent = `Oppdatert ${t}`;
  } catch { setStatus('error', 'FRAKOBLET'); }
}

// Clock
function tick() {
  const el = document.getElementById('live-clock');
  if (el) el.textContent = new Intl.DateTimeFormat('nb-NO', { hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(new Date());
}
tick(); setInterval(tick, 1000);

// Header scroll
const hdr = document.getElementById('site-header');
window.addEventListener('scroll', () => { if (hdr) hdr.classList.toggle('scrolled', window.scrollY > 10); }, { passive: true });

load();
setInterval(load, 30_000);
