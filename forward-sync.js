(() => {
  'use strict';

  const JOURNAL_KEY = 'dust.mobile.v1';
  const SYNC_KEY = 'dust.forwardSync.v1';
  const SHADOW_ID = 'dust_shadow_50k';
  const SYNC_INTERVAL_MS = 60_000;
  let syncTimer = null;
  let syncing = false;
  let lastSnapshot = null;

  const escSync = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));

  function readConfig() {
    try {
      return { enabled: true, url: '', ...JSON.parse(localStorage.getItem(SYNC_KEY) || '{}') };
    } catch {
      return { enabled: true, url: '' };
    }
  }

  function writeConfig(next) {
    localStorage.setItem(SYNC_KEY, JSON.stringify(next));
  }

  function normalizedUrl(raw) {
    return String(raw || '').trim().replace(/\/+$/, '');
  }

  function getJournalDb() {
    try {
      if (typeof db !== 'undefined' && db && Array.isArray(db.accounts) && Array.isArray(db.trades)) return db;
    } catch {}
    try {
      const parsed = JSON.parse(localStorage.getItem(JOURNAL_KEY) || 'null');
      if (parsed && Array.isArray(parsed.accounts) && Array.isArray(parsed.trades)) return parsed;
    } catch {}
    return { currentAccountId: SHADOW_ID, accounts: [], trades: [] };
  }

  function persistJournal(targetDb) {
    try {
      if (typeof db !== 'undefined' && targetDb === db && typeof save === 'function') {
        save();
      } else {
        localStorage.setItem(JOURNAL_KEY, JSON.stringify(targetDb));
      }
      if (typeof render === 'function') render();
    } catch (err) {
      throw new Error(`Journal save failed: ${err.message}`);
    }
  }

  function ensureShadowAccount(targetDb, account) {
    targetDb.accounts = targetDb.accounts || [];
    targetDb.trades = targetDb.trades || [];
    let a = targetDb.accounts.find((x) => x.id === SHADOW_ID);
    if (!a) {
      a = {
        id: SHADOW_ID,
        name: 'DUST 50K Shadow',
        provider: 'DUST Forward',
        stage: 'Evaluation',
        startingBalance: 50000,
        maxDrawdownPct: 6,
        profitTargetPct: 10
      };
      targetDb.accounts.push(a);
    }
    if (account) {
      if (Number.isFinite(Number(account.startingBalance))) a.startingBalance = Number(account.startingBalance);
      if (Number.isFinite(Number(account.maxDrawdownPct))) a.maxDrawdownPct = Number(account.maxDrawdownPct);
      if (Number.isFinite(Number(account.profitTargetPct))) a.profitTargetPct = Number(account.profitTargetPct);
      a.stage = 'Evaluation';
      a.provider = 'DUST Forward';
      a.shadowStatus = account.status || 'ACTIVE';
      a.shadowEquity = account.equity;
      a.shadowBalance = account.balance;
    }
    return a;
  }

  function importClosedTrades(targetDb, snapshot) {
    ensureShadowAccount(targetDb, snapshot.account);
    const existing = new Set(
      (targetDb.trades || [])
        .filter((t) => t.accountId === SHADOW_ID)
        .map((t) => String(t.id))
    );

    let added = 0;
    for (const src of snapshot.closedTrades || []) {
      const id = String(src.id || `${src.entryTime || ''}:${src.exitTime || ''}:${src.entryPrice || ''}`);
      const journalId = id.startsWith('shadow:') ? id : `shadow:${id}`;
      if (existing.has(journalId) || existing.has(id)) continue;
      targetDb.trades.push({
        ...src,
        id: journalId,
        accountId: SHADOW_ID,
        market: src.market || 'BTCUSDT',
        side: src.side || (src.direction === 'long' ? 'Long' : 'Short'),
        setup: src.setup || src.strategy || 'SESSION-AUCTION v0.4',
        session: src.session || src.session_pair || '—',
        grade: src.grade || src.tier || '',
        followedPlan: src.followedPlan !== false,
        screenshots: Array.isArray(src.screenshots) ? src.screenshots : [],
        source: 'DUST Forward Sync'
      });
      existing.add(journalId);
      added += 1;
    }
    return added;
  }

  function syncCardHtml() {
    const cfg = readConfig();
    const s = lastSnapshot;
    const engine = s?.engine || {};
    const pos = s?.position;
    const armed = Array.isArray(s?.armedOrders) ? s.armedOrders.length : 0;
    const status = s ? (engine.status || 'online').toUpperCase() : (cfg.url ? 'READY' : 'SETUP');
    const statusClass = s && engine.status !== 'error' ? 'good' : '';
    const live = s
      ? `${engine.marketPrice ? Number(engine.marketPrice).toLocaleString() : '—'} BTC · ${pos ? `${String(pos.direction || '').toUpperCase()} open` : 'No open position'} · ${armed} armed`
      : 'Private remote sync via your own Tailscale network.';

    return `
      <div class="card" id="dustForwardSyncCard">
        <div class="cardhead">
          <div><small>FORWARD SYNC</small><h3>DUST Shadow → Journal</h3></div>
          <span class="pill ${statusClass}" id="dustSyncPill">${escSync(status)}</span>
        </div>
        <div class="field full">Private engine HTTPS URL
          <input id="dustSyncUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://your-pc.your-tailnet.ts.net" value="${escSync(cfg.url || '')}">
        </div>
        <label class="checkbox"><input id="dustSyncEnabled" type="checkbox" ${cfg.enabled !== false ? 'checked' : ''}> Auto-sync when DUST Journal is open</label>
        <div class="btnrow">
          <button class="btn primary" id="dustSyncNow">Sync now</button>
          <button class="btn ghost" id="dustSyncSave">Save connection</button>
        </div>
        <div class="notice" id="dustSyncMeta">${escSync(live)}</div>
      </div>`;
  }

  function mountCard() {
    const accounts = document.getElementById('accounts');
    if (!accounts) return;
    const old = document.getElementById('dustForwardSyncCard');
    if (old) {
      const holder = document.createElement('div');
      holder.innerHTML = syncCardHtml().trim();
      old.replaceWith(holder.firstElementChild);
    } else {
      accounts.insertAdjacentHTML('beforeend', syncCardHtml());
    }
    bindCard();
  }

  function setMeta(text, state = '') {
    const meta = document.getElementById('dustSyncMeta');
    const pill = document.getElementById('dustSyncPill');
    if (meta) meta.textContent = text;
    if (pill) {
      pill.textContent = state || pill.textContent;
      pill.classList.toggle('good', state === 'ONLINE' || state === 'SYNCED');
      pill.classList.toggle('bad', state === 'ERROR');
    }
  }

  function toast(message) {
    let t = document.getElementById('dustSyncToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dustSyncToast';
      Object.assign(t.style, {
        position: 'fixed', left: '50%', transform: 'translateX(-50%)', bottom: '92px', zIndex: '150',
        background: '#102836', color: '#eaf4f7', border: '1px solid #24485d', borderRadius: '12px',
        padding: '10px 14px', fontSize: '12px', boxShadow: '0 12px 30px rgba(0,0,0,.35)'
      });
      document.body.appendChild(t);
    }
    t.textContent = message;
    t.style.display = 'block';
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => { t.style.display = 'none'; }, 3500);
  }

  async function syncNow({ silent = false } = {}) {
    if (syncing) return;
    const cfg = readConfig();
    const base = normalizedUrl(cfg.url);
    if (!base) {
      if (!silent) setMeta('Enter the private Tailscale HTTPS URL first.', 'SETUP');
      return;
    }
    if (location.protocol === 'https:' && !base.startsWith('https://')) {
      setMeta('Remote sync requires an HTTPS URL. Use Tailscale Serve, not a raw http:// address.', 'ERROR');
      return;
    }

    syncing = true;
    setMeta('Connecting to your private forward engine…', 'SYNCING');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(`${base}/snapshot`, {
        method: 'GET',
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = await response.json();
      if (!snapshot || !snapshot.engine || !snapshot.account) throw new Error('Invalid engine snapshot');
      lastSnapshot = snapshot;
      const targetDb = getJournalDb();
      const added = importClosedTrades(targetDb, snapshot);
      persistJournal(targetDb);
      mountCard();
      const price = snapshot.engine.marketPrice ? Number(snapshot.engine.marketPrice).toLocaleString() : '—';
      const pos = snapshot.position ? `${String(snapshot.position.direction || '').toUpperCase()} open` : 'No open position';
      const armed = Array.isArray(snapshot.armedOrders) ? snapshot.armedOrders.length : 0;
      setMeta(`${price} BTC · ${pos} · ${armed} armed · ${added ? `${added} new trade${added === 1 ? '' : 's'} imported` : 'journal up to date'}`, 'SYNCED');
      if (added && !silent) toast(`${added} new DUST Forward trade${added === 1 ? '' : 's'} added to Journal`);
    } catch (err) {
      const message = err.name === 'AbortError' ? 'Connection timed out' : err.message;
      setMeta(`Could not reach private engine: ${message}. Check Tailscale on both devices and keep the laptop awake.`, 'ERROR');
    } finally {
      clearTimeout(timeout);
      syncing = false;
    }
  }

  function schedule() {
    clearInterval(syncTimer);
    const cfg = readConfig();
    if (cfg.enabled !== false && normalizedUrl(cfg.url)) {
      syncTimer = setInterval(() => syncNow({ silent: true }), SYNC_INTERVAL_MS);
    }
  }

  function bindCard() {
    const saveBtn = document.getElementById('dustSyncSave');
    const syncBtn = document.getElementById('dustSyncNow');
    const urlInput = document.getElementById('dustSyncUrl');
    const enabledInput = document.getElementById('dustSyncEnabled');
    if (saveBtn) saveBtn.onclick = () => {
      const next = { enabled: !!enabledInput?.checked, url: normalizedUrl(urlInput?.value) };
      writeConfig(next);
      schedule();
      setMeta(next.url ? 'Connection saved. Tap Sync now to test it.' : 'Connection cleared.', next.url ? 'READY' : 'SETUP');
    };
    if (syncBtn) syncBtn.onclick = () => {
      const next = { enabled: !!enabledInput?.checked, url: normalizedUrl(urlInput?.value) };
      writeConfig(next);
      schedule();
      syncNow({ silent: false });
    };
  }

  function boot() {
    mountCard();
    schedule();
    const cfg = readConfig();
    if (cfg.enabled !== false && normalizedUrl(cfg.url)) syncNow({ silent: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
