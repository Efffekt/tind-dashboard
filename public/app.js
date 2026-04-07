// ─── Tind Order Dashboard TV ───

function statusPill(status) {
  const n = (status || 'unknown').toLowerCase().replace(/[^a-z_]/g, '');
  const labels = {
    pending: 'Ventende', shipped: 'Sendt', fulfilled: 'Fullfort',
    delivered: 'Levert', cancelled: 'Kansellert', processing: 'Behandles',
    open: 'Apen', in_transit: 'Under transport', intransit: 'Under transport',
  };
  return `<span class="status-pill ${n}">${labels[n] || status || 'Ukjent'}</span>`;
}

function sourceTag(source) {
  return `<span class="source-tag ${source}">${source === 'shiphero' ? 'SH' : 'PK'}</span>`;
}

function formatTime(dateStr) {
  if (!dateStr) return '–';
  return new Intl.DateTimeFormat('nb-NO', {
    day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(dateStr));
}

function setStatus(state, text) {
  document.getElementById('status-dot').className = `status-dot ${state}`;
  document.getElementById('status-text').textContent = text;
}

function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.totalOrders;
  document.getElementById('stat-pending').textContent = stats.pendingOrders;
  document.getElementById('stat-shipped').textContent = stats.shippedToday;
  document.getElementById('source-sh-count').textContent = stats.ordersBySource.shiphero;
  document.getElementById('source-pk-count').textContent = stats.ordersBySource.packiyo;
}

function renderOrders(orders) {
  const feed = document.getElementById('orders-feed');
  if (!orders.length) {
    feed.innerHTML = '<div class="feed-empty">Ingen ordrer</div>';
    return;
  }

  const header = `
    <div class="order-header">
      <span>Ordre</span>
      <span>Kunde</span>
      <span>Antall</span>
      <span>Status</span>
      <span>Sporing</span>
      <span>Tidspunkt</span>
    </div>
  `;

  const rows = orders.map(o => `
    <div class="order-row">
      <span class="order-number">${sourceTag(o.source)}${o.orderNumber}</span>
      <span class="order-customer">${o.customerName}</span>
      <span class="order-items font-number">${o.totalItems}</span>
      ${statusPill(o.status)}
      <span class="order-tracking">${o.trackingNumbers.length ? o.trackingNumbers[0] : '–'}</span>
      <span class="order-time">${formatTime(o.createdAt)}</span>
    </div>
  `).join('');

  feed.innerHTML = header + rows;
}

async function loadDashboard() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();

    renderStats(data.stats);
    renderOrders(data.orders);

    setStatus('online', data.mock ? 'Testdata' : 'Live');

    const banner = document.getElementById('mock-banner');
    if (banner) banner.style.display = data.mock ? 'block' : 'none';

    const syncEl = document.getElementById('last-sync');
    if (syncEl) {
      const time = new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(data.fetchedAt));
      syncEl.textContent = `Sist oppdatert: ${time}`;
    }
  } catch {
    setStatus('error', 'Frakoblet');
  }
}

loadDashboard();
setInterval(loadDashboard, 30_000);
