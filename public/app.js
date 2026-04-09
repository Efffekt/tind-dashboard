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
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'Na';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}t`;
  return new Intl.DateTimeFormat('nb-NO', { day:'numeric', month:'short' }).format(new Date(d));
}

function renderOrders(orders) {
  const el = document.getElementById('orders-feed');
  if (!orders.length) { el.innerHTML = '<div class="feed-empty">Ingen ordrer</div>'; return; }

  const head = `<div class="orders-head"><span>Ordre</span><span>Kunde</span><span style="text-align:right">Antall</span><span>Status</span><span style="text-align:right">Tid</span></div>`;
  const body = orders.map(o => `<div class="order-row">
    <div class="order-id">${stag(o.source)}<span class="order-num">${o.orderNumber}</span></div>
    <span class="order-customer">${o.customerName}</span>
    <span class="order-qty font-number">${o.totalItems}</span>
    ${pill(o.status)}
    <span class="order-time">${fmtTime(o.createdAt)}</span>
  </div>`).join('');

  el.innerHTML = head + `<div class="orders-body">${body}</div>`;
}

async function load() {
  try {
    const data = await (await fetch('/api/data')).json();

    document.getElementById('stat-total').textContent = data.stats.totalOrders;
    document.getElementById('stat-pending').textContent = data.stats.pendingOrders;
    document.getElementById('stat-shipped').textContent = data.stats.shippedToday;
    document.getElementById('source-sh').textContent = data.stats.ordersBySource.shiphero;
    document.getElementById('source-pk').textContent = data.stats.ordersBySource.packiyo;

    renderOrders(data.orders);

    document.getElementById('live-dot').className = 'live-dot on';
    document.getElementById('status-text').textContent = data.mock ? 'Testdata' : 'Live';
    document.getElementById('mock-banner').style.display = data.mock ? 'block' : 'none';

    const t = new Intl.DateTimeFormat('nb-NO', { hour:'2-digit', minute:'2-digit' }).format(new Date(data.fetchedAt));
    document.getElementById('last-sync').textContent = `Oppdatert ${t}`;
  } catch {
    document.getElementById('live-dot').className = 'live-dot off';
    document.getElementById('status-text').textContent = 'Frakoblet';
  }
}

// Clock
setInterval(() => {
  document.getElementById('clock').textContent = new Intl.DateTimeFormat('nb-NO', { hour:'2-digit', minute:'2-digit', second:'2-digit' }).format(new Date());
}, 1000);

load();
setInterval(load, 30000);
