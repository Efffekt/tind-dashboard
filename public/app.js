// ─── Tind Order Dashboard ───

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
  const cls = source === 'shiphero' ? 'stag-sh' : 'stag-pk';
  const label = source === 'shiphero' ? 'SH' : 'PK';
  return `<span class="stag ${cls}">${label}</span>`;
}

function fmtTime(d) {
  if (!d) return '–';
  const date = new Date(d);
  const now = new Date();
  const diffH = Math.floor((now.getTime() - date.getTime()) / 3600000);

  if (diffH < 1) {
    const mins = Math.floor((now.getTime() - date.getTime()) / 60000);
    return mins < 1 ? 'Akkurat na' : `${mins} min siden`;
  }
  if (diffH < 24) return `${diffH}t siden`;

  return new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

function setStatus(state, text) {
  document.getElementById('status-dot').className = `status-dot ${state}`;
  document.getElementById('status-text').textContent = text;
}

function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.totalOrders;
  document.getElementById('stat-pending').textContent = stats.pendingOrders;
  document.getElementById('stat-shipped').textContent = stats.shippedToday;
  document.getElementById('source-sh').textContent = stats.ordersBySource.shiphero;
  document.getElementById('source-pk').textContent = stats.ordersBySource.packiyo;
}

function renderOrders(orders) {
  const feed = document.getElementById('orders-feed');
  if (!orders.length) {
    feed.innerHTML = '<div class="feed-empty">Ingen ordrer</div>';
    return;
  }

  feed.innerHTML = orders.map(o => `
    <div class="order-row">
      <div class="order-id">
        ${stag(o.source)}
        <span class="order-number">${o.orderNumber}</span>
      </div>
      <span class="order-customer">${o.customerName}</span>
      <span class="order-qty font-number">${o.totalItems}</span>
      ${pill(o.status)}
      <span class="order-time">${fmtTime(o.createdAt)}</span>
    </div>
  `).join('');
}

async function load() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();

    renderStats(data.stats);
    renderOrders(data.orders);

    setStatus('online', data.mock ? 'Testdata' : 'Live');

    document.getElementById('mock-banner').style.display = data.mock ? 'block' : 'none';

    const time = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(data.fetchedAt));
    document.getElementById('last-sync').textContent = `Sist oppdatert: ${time}`;
  } catch {
    setStatus('error', 'Frakoblet');
  }
}

// Header scroll effect — matches tind-web
const header = document.getElementById('site-header');
window.addEventListener('scroll', () => {
  if (header) header.classList.toggle('scrolled', window.scrollY > 10);
}, { passive: true });

load();
setInterval(load, 30_000);
