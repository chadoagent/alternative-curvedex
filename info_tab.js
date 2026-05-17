// INFO tab — per-token ratings & project info from ratings-aggregator service.
//
// Source of truth: https://llama.box/ratings/data/cache.json (refreshed by
// cron every 6h, address-keyed). Cached client-side in localStorage for 1h
// to avoid hammering on every pool switch.
//
// For each token in `selectedPool.coinsAddresses`, we lookup `address.toLowerCase()`
// in the ratings cache and render a card:
//   - Pharos: grade + score + per-dimension table + link
//   - DefiLlama: mcap (totalCirculating in peg currency) + chain count
//   - Bluechip: grade if available + link
//   - Llamarisk: research-notes link if available
//   - Savings-wrapper marker: "Rating inherited from <underlying>" when present
//   - Missing data → graceful "no rating available" row
//
// NFA disclaimer is always shown beneath the cards (rendered statically in
// index.html #infoDisclaimer).

// Default origin = llama.box. When __DYNAMIC_BASE is set (IPFS bundle), keep
// reading ratings from the same classical host that owns chains_config.json
// and cache.json so all dynamic data shares one origin.
const RATINGS_CACHE_URL = (typeof window !== 'undefined' && window.__DYNAMIC_BASE)
  ? window.__DYNAMIC_BASE + '/ratings/data/cache.json'
  : 'https://llama.box/ratings/data/cache.json';
const RATINGS_LS_KEY = 'curvedex.ratingsCache';
const RATINGS_LS_TTL_MS = 60 * 60 * 1000; // 1 hour

let _ratingsCachePromise = null;

async function fetchRatingsCache() {
  // Try localStorage first.
  try {
    const raw = localStorage.getItem(RATINGS_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ts && (Date.now() - parsed.ts) < RATINGS_LS_TTL_MS && parsed.data) {
        return parsed.data;
      }
    }
  } catch (_) { /* fall through to network */ }

  if (_ratingsCachePromise) return _ratingsCachePromise;
  _ratingsCachePromise = (async () => {
    try {
      const resp = await fetch(RATINGS_CACHE_URL, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      try {
        localStorage.setItem(RATINGS_LS_KEY, JSON.stringify({ ts: Date.now(), data }));
      } catch (_) { /* quota or private mode; ignore */ }
      return data;
    } catch (e) {
      console.warn('[info_tab] ratings cache fetch failed:', e);
      return null;
    } finally {
      _ratingsCachePromise = null;
    }
  })();
  return _ratingsCachePromise;
}

function _gradeColor(grade) {
  if (!grade) return 'var(--text-dim)';
  const g = String(grade).toUpperCase();
  if (g.startsWith('A')) return '#16c784';
  if (g.startsWith('B')) return '#9ada6a';
  if (g.startsWith('C')) return '#e0a64a';
  if (g.startsWith('D')) return '#e87a43';
  if (g.startsWith('F')) return '#ea3943';
  return 'var(--text-dim)';
}

function _fmtMcap(n) {
  if (n == null) return '—';
  const v = Number(n);
  if (!isFinite(v) || v <= 0) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function _renderDimensions(dims) {
  if (!dims || typeof dims !== 'object') return '';
  const order = ['pegStability', 'liquidity', 'resilience', 'decentralization', 'dependencyRisk'];
  const labels = {
    pegStability: 'Peg',
    liquidity: 'Liquidity',
    resilience: 'Resilience',
    decentralization: 'Decentralization',
    dependencyRisk: 'Dependency Risk',
  };
  const rows = order
    .map(k => {
      const d = dims[k];
      if (!d || (d.grade == null && d.score == null)) return null;
      const color = _gradeColor(d.grade);
      const scoreStr = d.score != null ? (' · ' + d.score) : '';
      return `<div class="info-dim-row"><span class="info-dim-label">${labels[k]}</span><span class="info-dim-grade" style="color:${color}">${_esc(d.grade || '—')}${_esc(scoreStr)}</span></div>`;
    })
    .filter(Boolean);
  if (!rows.length) return '';
  return `<div class="info-dim-grid">${rows.join('')}</div>`;
}

function _renderCard(symbol, address, entry) {
  const safeSym = _esc(symbol || '?');
  const safeAddr = _esc(address);
  if (!entry) {
    return `
      <div class="info-card info-card-empty">
        <div class="info-card-head">
          <span class="info-card-sym">${safeSym}</span>
          <span class="info-card-addr">${safeAddr.slice(0, 6)}…${safeAddr.slice(-4)}</span>
        </div>
        <div class="info-card-empty-body">No rating available in aggregator for this address.</div>
      </div>`;
  }
  const name = _esc(entry.name || entry.symbol || symbol);
  const pharos = entry.pharos || {};
  const defi = entry.defillama || {};
  const bluechip = entry.bluechip || {};
  const inherited = entry.inheritedFrom;

  // Pharos url in cache uses legacy `/coin/<id>` which 404s; rewrite to `/stablecoin/`.
  // Server-side fix landed in commit (next refresh); this keeps current cache usable.
  const pharosUrl = pharos.url ? String(pharos.url).replace('/coin/', '/stablecoin/') : '';
  const pharosLink = pharosUrl ? `<a href="${_esc(pharosUrl)}" target="_blank" rel="noopener" class="info-src-link">↗</a>` : '';
  const bluechipLink = bluechip.url ? `<a href="${_esc(bluechip.url)}" target="_blank" rel="noopener" class="info-src-link">↗</a>` : '';
  // Llamarisk portal stub-link removed (Александр msg 662) — research note URLs
  // below are authoritative; portal-guessed paths 404.

  const gradeColor = _gradeColor(pharos.grade);
  const inheritedBadge = inherited
    ? `<div class="info-inherited">↳ Rating inherited from <strong>${_esc(inherited.symbol)}</strong></div>`
    : '';

  const descr = entry.description
    ? `<div class="info-descr">${_esc(entry.description)}</div>`
    : '';

  const mcap = _fmtMcap(defi.totalCirculating);
  const chains = defi.chainCount != null ? String(defi.chainCount) : '—';

  const dims = _renderDimensions(pharos.dimensions);

  const bluechipRow = bluechip.grade
    ? `<div class="info-src-row"><span class="info-src-label">Bluechip</span><span class="info-src-val" style="color:${_gradeColor(bluechip.grade)}">${_esc(bluechip.grade)}</span>${bluechipLink}</div>`
    : '';

  // Unified Research block (Александр request 2026-05-14): replaces the
  // separate Llamarisk + TelosConsilium rows. Items grouped by source with
  // coloured pills; only renders if research[] non-empty.
  const RESEARCH_SRC_COLOR = {
    'LlamaRisk': '#10b981',
    'Curve Team': '#3b82f6',
    'TelosConsilium': '#eab308',
    'Manual': '#9ca3af',
  };
  const research = Array.isArray(entry.research) ? entry.research : [];
  const researchBlock = research.length
    ? `<div class="info-src-row"><span class="info-src-label">Research</span><span class="info-src-val">${research.length} note${research.length === 1 ? '' : 's'}</span></div>
       <div class="info-notes-list">${research.slice(0, 8).map(r => {
         const color = RESEARCH_SRC_COLOR[r.source] || '#9ca3af';
         const meta = [r.author, r.date && String(r.date).slice(0, 10)].filter(Boolean).map(_esc).join(' · ');
         return `<a class="info-note-row" href="${_esc(r.url || '#')}" target="_blank" rel="noopener" style="display:flex;gap:6px;align-items:center;">
           <span style="background:${color};color:#0d1117;padding:1px 5px;border-radius:3px;font-size:9.5px;font-weight:700;flex-shrink:0;">${_esc(r.source || '—')}</span>
           <span style="flex:1;min-width:0;">${_esc(r.title || 'Research note')}${meta ? `<span style="display:block;font-size:0.7rem;opacity:0.65;">${meta}</span>` : ''}</span>
         </a>`;
       }).join('')}</div>`
    : '';

  return `
    <div class="info-card">
      <div class="info-card-head">
        <span class="info-card-sym">${safeSym}</span>
        <span class="info-card-name">${name}</span>
        <span class="info-grade-badge" style="background:${gradeColor};">${_esc(pharos.grade || '—')}${pharos.score != null ? ' · ' + pharos.score : ''}</span>
      </div>
      ${inheritedBadge}
      ${descr}
      <div class="info-stats-row">
        <div class="info-stat"><span class="info-stat-label">Market cap</span><span class="info-stat-val">${_esc(mcap)}</span></div>
        <div class="info-stat"><span class="info-stat-label">Chains</span><span class="info-stat-val">${_esc(chains)}</span></div>
      </div>
      ${dims}
      <div class="info-sources">
        <div class="info-src-row"><span class="info-src-label">Pharos</span><span class="info-src-val" style="color:${gradeColor}">${_esc(pharos.grade || '—')}${pharos.score != null ? ' · ' + pharos.score : ''}</span>${pharosLink}</div>
        ${bluechipRow}
        ${researchBlock}
      </div>
    </div>`;
}

async function renderYieldInfoTab() {
  const empty = document.getElementById('infoEmpty');
  const cardsEl = document.getElementById('infoCardsContainer');
  const discl = document.getElementById('infoDisclaimer');
  if (!empty || !cardsEl || !discl) return;

  // No pool selected → show placeholder, hide cards/disclaimer.
  if (!window.selectedPool || !window.selectedPool.coinsAddresses || !window.selectedPool.coinsAddresses.length) {
    empty.style.display = '';
    cardsEl.innerHTML = '';
    discl.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  cardsEl.innerHTML = '<div class="info-loading" style="text-align:center;color:var(--text-dim);padding:18px;font-size:12px;">Loading ratings…</div>';
  discl.style.display = '';

  const cache = await fetchRatingsCache();
  if (!cache || !cache.tokens) {
    cardsEl.innerHTML = '<div class="info-loading" style="text-align:center;color:var(--text-dim);padding:18px;font-size:12px;">Ratings unavailable. <a href="https://llama.box/ratings/" target="_blank" rel="noopener">Source</a></div>';
    return;
  }
  const tokens = cache.tokens;
  const pool = window.selectedPool;
  if (!pool || pool !== window.selectedPool) return; // pool changed mid-flight

  const html = pool.coinsAddresses.map((addr, i) => {
    const symbol = pool.coins?.[i] || '?';
    const key = String(addr || '').toLowerCase();
    return _renderCard(symbol, key, tokens[key]);
  }).join('');

  cardsEl.innerHTML = html || '<div class="info-loading">No tokens in this pool.</div>';
}

// Hook into pool-change events: re-render when user switches pool (only if
// INFO is the active tab). yield.js sets _activeSubTab on tab switches; for
// pool-switch events we listen to window.selectedPool indirectly via the
// existing chart/details refresh that runs on selectPool.
window.renderYieldInfoTab = renderYieldInfoTab;

document.addEventListener('curvedex:poolSelected', () => {
  // Re-render only if INFO tab is currently visible to avoid wasted work.
  const tabInfo = document.getElementById('tab-info');
  if (tabInfo && tabInfo.style.display !== 'none' && tabInfo.classList.contains('active')) {
    renderYieldInfoTab();
  }
});

// Eager-populate ratings index for sidebar chip filters (Stablecoins,
// Grade ≥ B). Runs once at page load, non-blocking. Populates two globals
// used by getFilteredPools() in app.js for O(1) chip-filter lookups.
(async function _seedRatingsIndex() {
  try {
    const cache = await fetchRatingsCache();
    if (!cache || !cache.tokens) return;
    const tokens = new Set();
    const grades = new Map();
    for (const [addr, entry] of Object.entries(cache.tokens)) {
      const key = String(addr).toLowerCase();
      tokens.add(key);
      const g = entry && entry.pharos && entry.pharos.grade;
      if (typeof g === 'string') grades.set(key, g);
    }
    window._ratingsTokens = tokens;
    window._ratingsGrades = grades;
    // If user already toggled a ratings chip before cache landed, re-filter now.
    if ((window.stablecoinsOnly || window.minGradeBOnly) && typeof renderPoolList === 'function') {
      renderPoolList();
    }
  } catch (_) { /* silent — chip filters degrade gracefully */ }
})();
