// ─── Tind Dashboard — Client ───

// ─── Navigation ───
const tabs = document.querySelectorAll('.nav-tab');
const views = document.querySelectorAll('.view');

tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.view;
    tabs.forEach(t => t.classList.remove('active'));
    views.forEach(v => v.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`view-${target}`).classList.add('active');
  });
});

// ─── Helpers ───
function sourceBadge(source) {
  return `<span class="source-tag ${source}">${source === 'shiphero' ? 'ShipHero' : 'Packiyo'}</span>`;
}

function statusPill(status) {
  const normalized = (status || 'unknown').toLowerCase().replace(/[^a-z]/g, '');
  return `<span class="status-pill ${normalized}">${status || 'Ukjent'}</span>`;
}

function formatDate(dateStr) {
  if (!dateStr) return '–';
  try {
    return new Intl.DateTimeFormat('nb-NO', {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(dateStr));
  } catch {
    return dateStr;
  }
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Akkurat na';
  if (mins < 60) return `${mins} min siden`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}t siden`;
  return `${Math.floor(hours / 24)}d siden`;
}

function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = `status-dot ${state}`;
  label.textContent = text;
}

// ─── Render functions ───
function renderStats(stats) {
  document.getElementById('stat-total').textContent = stats.totalOrders;
  document.getElementById('stat-pending').textContent = stats.pendingOrders;
  document.getElementById('stat-shipped').textContent = stats.shippedToday;
  document.getElementById('stat-lowstock').textContent = stats.lowStockItems;
  document.getElementById('source-sh-count').textContent = stats.ordersBySource.shiphero;
  document.getElementById('source-pk-count').textContent = stats.ordersBySource.packiyo;
}

function renderOrderRows(orders, tbody, showTracking = false) {
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="${showTracking ? 7 : 6}" class="empty-state">Ingen ordrer funnet</td></tr>`;
    return;
  }

  tbody.innerHTML = orders.map(o => `
    <tr>
      <td><strong>${o.orderNumber}</strong></td>
      <td>${sourceBadge(o.source)}</td>
      <td>${o.customerName}</td>
      <td>${statusPill(o.status)}</td>
      <td class="font-number">${o.totalItems}</td>
      ${showTracking ? `<td>${o.trackingNumbers.length ? o.trackingNumbers.join(', ') : '–'}</td>` : ''}
      <td>${formatDate(o.createdAt)}</td>
    </tr>
  `).join('');
}

function renderInventory(items, tbody) {
  if (!items.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Ingen lagervarer funnet</td></tr>';
    return;
  }

  tbody.innerHTML = items.map(i => `
    <tr>
      <td><strong>${i.sku}</strong></td>
      <td>${i.productName}</td>
      <td>${sourceBadge(i.source)}</td>
      <td>${i.warehouse}</td>
      <td class="font-number">${i.quantityOnHand}</td>
      <td class="font-number ${i.quantityAvailable < 10 ? 'low-stock' : ''}">${i.quantityAvailable}</td>
      <td class="font-number">${i.quantityAllocated}</td>
    </tr>
  `).join('');
}

function renderShipments(shipments, tbody) {
  if (!shipments.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Ingen forsendelser funnet</td></tr>';
    return;
  }

  tbody.innerHTML = shipments.map(s => `
    <tr>
      <td><strong>${s.orderNumber}</strong></td>
      <td>${sourceBadge(s.source)}</td>
      <td>${s.carrier || '–'}</td>
      <td>${statusPill(s.status)}</td>
      <td>${s.trackingNumber || '–'}</td>
      <td>${formatDate(s.shippedAt)}</td>
      <td>${formatDate(s.deliveredAt)}</td>
    </tr>
  `).join('');
}

// ─── Source filters ───
let allOrders = [];
let allInventory = [];
let allShipments = [];

document.getElementById('filter-order-source').addEventListener('change', (e) => {
  const src = e.target.value;
  const filtered = src === 'all' ? allOrders : allOrders.filter(o => o.source === src);
  renderOrderRows(filtered, document.getElementById('orders-table'), true);
});

document.getElementById('filter-inv-source').addEventListener('change', (e) => {
  const src = e.target.value;
  const filtered = src === 'all' ? allInventory : allInventory.filter(i => i.source === src);
  renderInventory(filtered, document.getElementById('inventory-table'));
});

document.getElementById('filter-ship-source').addEventListener('change', (e) => {
  const src = e.target.value;
  const filtered = src === 'all' ? allShipments : allShipments.filter(s => s.source === src);
  renderShipments(filtered, document.getElementById('shipments-table'));
});

// ─── Load data from single /api/data endpoint (served from KV cache) ───
async function loadDashboard() {
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`${res.status}`);

    const data = await res.json();

    // Stats
    renderStats(data.stats);

    // Orders
    allOrders = data.orders || [];
    renderOrderRows(allOrders.slice(0, 10), document.getElementById('recent-orders'));
    renderOrderRows(allOrders, document.getElementById('orders-table'), true);

    // Inventory
    allInventory = data.inventory || [];
    renderInventory(allInventory, document.getElementById('inventory-table'));

    // Shipments
    allShipments = data.shipments || [];
    renderShipments(allShipments, document.getElementById('shipments-table'));

    // Status
    const mode = data.mock ? 'Testdata' : 'Live';
    const syncTime = timeAgo(data.syncedAt);
    setStatus('online', `${mode} — oppdatert ${syncTime}`);

    // Show mock banner if needed
    const banner = document.getElementById('mock-banner');
    if (banner) banner.style.display = data.mock ? 'block' : 'none';

  } catch (err) {
    setStatus('error', 'Kunne ikke hente data');
    console.error('Dashboard load failed:', err);
  }
}

loadDashboard();

// Refresh UI every 30 seconds (data itself syncs every 3 min via cron)
setInterval(loadDashboard, 30_000);
