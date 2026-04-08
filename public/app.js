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
  return `<span class="stag ${source === 'shiphero' ? 'stag-sh' : 'stag-pk'}">${source === 'shiphero' ? 'SH' : 'PK'}</span>`;
}

function fmtTime(d) {
  if (!d) return '–';
  const date = new Date(d);
  const diffM = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffM < 1) return 'Akkurat na';
  if (diffM < 60) return `${diffM} min siden`;
  const diffH = Math.floor(diffM / 60);
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
  const el = document.getElementById('orders-feed');
  if (!orders.length) { el.innerHTML = '<div class="feed-empty">Ingen ordrer</div>'; return; }

  el.innerHTML = orders.map(o => `
    <div class="order-row">
      <div class="order-id">${stag(o.source)}<span class="order-num">${o.orderNumber}</span></div>
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
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();

    renderStats(data.stats);
    renderOrders(data.orders);
    setStatus('online', data.mock ? 'Testdata' : 'Live');
    document.getElementById('mock-banner').style.display = data.mock ? 'block' : 'none';

    const t = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(data.fetchedAt));
    document.getElementById('last-sync').textContent = `Oppdatert ${t}`;
  } catch { setStatus('error', 'Frakoblet'); }
}

// Header scroll — matches tind-web
const hdr = document.getElementById('site-header');
window.addEventListener('scroll', () => { if (hdr) hdr.classList.toggle('scrolled', window.scrollY > 10); }, { passive: true });

load();
setInterval(load, 30_000);
