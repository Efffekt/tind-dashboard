// ─── Tind Dashboard TV — Single screen, no interaction ───

function statusPill(status) {
  const normalized = (status || 'unknown').toLowerCase().replace(/[^a-z_]/g, '');
  const labels = {
    pending: 'Ventende', shipped: 'Sendt', fulfilled: 'Fullfort',
    delivered: 'Levert', cancelled: 'Kansellert', processing: 'Behandles',
    open: 'Apen', intransit: 'Under transport', in_transit: 'Under transport',
  };
  return `<span class="status-pill ${normalized}">${labels[normalized] || status || 'Ukjent'}</span>`;
}

function sourceTag(source) {
  return `<span class="source-tag ${source}">${source === 'shiphero' ? 'SH' : 'PK'}</span>`;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
  if (mins < 1) return 'Na';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}t`;
  return `${Math.floor(hours / 24)}d`;
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  return new Intl.DateTimeFormat('nb-NO', { hour: '2-digit', minute: '2-digit' }).format(new Date(dateStr));
}

function setStatus(state, text) {
  document.getElementById('status-dot').className = `status-dot ${state}`;
  document.getElementById('status-text').textContent = text;
}

// ─── Render ───
function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.totalOrders;
  document.getElementById('stat-pending').textContent = stats.pendingOrders;
  document.getElementById('stat-shipped').textContent = stats.shippedToday;
  document.getElementById('stat-lowstock').textContent = stats.lowStockItems;
  document.getElementById('source-sh-count').textContent = stats.ordersBySource.shiphero;
  document.getElementById('source-pk-count').textContent = stats.ordersBySource.packiyo;
}

function renderOrders(orders) {
  const feed = document.getElementById('orders-feed');
  if (!orders.length) {
    feed.innerHTML = '<div class="feed-empty">Ingen ordrer</div>';
    return;
  }

  feed.innerHTML = orders.slice(0, 15).map(o => `
    <div class="order-row">
      <div class="order-primary">
        <span class="order-number">${sourceTag(o.source)} ${o.orderNumber}</span>
        <span class="order-customer">${o.customerName}</span>
      </div>
      <span class="order-items font-number">${o.totalItems} stk</span>
      ${statusPill(o.status)}
      <span class="order-time">${formatTime(o.createdAt)}</span>
    </div>
  `).join('');
}

function renderInventory(items) {
  const list = document.getElementById('inventory-list');
  if (!items.length) {
    list.innerHTML = '<div class="feed-empty">Ingen data</div>';
    return;
  }

  // Sort: low stock first
  const sorted = [...items].sort((a, b) => a.quantityAvailable - b.quantityAvailable);

  list.innerHTML = sorted.slice(0, 8).map(i => `
    <div class="inv-row">
      <div>
        <div class="inv-name">${i.productName}</div>
        <div class="inv-sku">${i.sku} · ${i.warehouse}</div>
      </div>
      <div class="inv-qty ${i.quantityAvailable < 10 ? 'low' : ''} font-number">
        ${i.quantityAvailable}
      </div>
      ${sourceTag(i.source)}
    </div>
  `).join('');
}

function renderShipments(shipments) {
  const list = document.getElementById('shipments-list');
  // Only show active shipments
  const active = shipments.filter(s => s.status !== 'delivered');

  if (!active.length) {
    list.innerHTML = '<div class="feed-empty">Ingen aktive forsendelser</div>';
    return;
  }

  list.innerHTML = active.slice(0, 6).map(s => `
    <div class="ship-row">
      <div>
        <div class="ship-order">${sourceTag(s.source)} ${s.orderNumber}</div>
        <div class="ship-carrier">${s.carrier || ''} · ${s.trackingNumber || ''}</div>
      </div>
      ${statusPill(s.status)}
      <span class="order-time">${timeAgo(s.shippedAt)} siden</span>
    </div>
  `).join('');
}

// ─── Load ───
async function loadDashboard() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();

    renderStats(data.stats);
    renderOrders(data.orders);
    renderInventory(data.inventory);
    renderShipments(data.shipments);

    const mode = data.mock ? 'Testdata' : 'Live';
    setStatus('online', mode);

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
