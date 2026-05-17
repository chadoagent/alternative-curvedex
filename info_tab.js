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

// Deployment ages — separate JSON from ratings cache (built by
// build_deployment_ages.py in the same ratings-aggregator project).
// Surfaces contract age + ERC-1967 proxy upgrade age per token. Built so
// Alexandr-style "USG has B/74 grade but launched <30d ago" cases get an
// explicit risk pill on the card. Per-token data is fixed-size (~120 B),
// so we lazy-load the whole file once and index into it client-side.
const DEPLOY_AGES_URL = (typeof window !== 'undefined' && window.__DYNAMIC_BASE)
  ? window.__DYNAMIC_BASE + '/ratings/data/deployment_ages.json'
  : 'https://llama.box/ratings/data/deployment_ages.json';
const DEPLOY_AGES_LS_KEY = 'curvedex.deployAges';
const DEPLOY_AGES_LS_TTL_MS = 6 * 60 * 60 * 1000; // 6h (matches server cron)

// Contract <30 d → orange "new" warning; proxy upgrade <7 d → red "recently
// upgraded" warning (tightened threshold — admin keys often rotate without
// public notice).
const AGE_WARNING_SECONDS = 30 * 24 * 3600;
const PROXY_UPGRADE_WARNING_SECONDS = 7 * 24 * 3600;

let _ratingsCachePromise = null;
let _deployAgesPromise = null;

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

async function fetchDeployAges() {
  // localStorage hit: avoid extra fetch on every pool switch.
  try {
    const raw = localStorage.getItem(DEPLOY_AGES_LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.ts && (Date.now() - parsed.ts) < DEPLOY_AGES_LS_TTL_MS && parsed.data) {
        return parsed.data;
      }
    }
  } catch (_) { /* fall through */ }

  if (_deployAgesPromise) return _deployAgesPromise;
  _deployAgesPromise = (async () => {
    try {
      const resp = await fetch(DEPLOY_AGES_URL, { cache: 'no-cache' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      try {
        localStorage.setItem(DEPLOY_AGES_LS_KEY, JSON.stringify({ ts: Date.now(), data }));
      } catch (_) { /* quota; ignore */ }
      return data;
    } catch (e) {
      console.warn('[info_tab] deployment_ages fetch failed:', e);
      return null;
    } finally {
      _deployAgesPromise = null;
    }
  })();
  return _deployAgesPromise;
}

function _fmtAge(seconds) {
  // Round to one unit, dropping decimals: <24h → "Xh", <30d → "Xd", <12m
  // → "Xm", else "X.Yy". Matches typical contract-age phrasing in audit
  // reports — coarse on purpose so users don't fixate on month boundaries.
  if (!isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 3600) {
    const m = Math.max(1, Math.round(seconds / 60));
    return m + 'min';
  }
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h';
  const days = seconds / 86400;
  if (days < 30) return Math.round(days) + 'd';
  const months = days / 30.4375;
  if (months < 12) return Math.round(months) + 'mo';
  const years = days / 365.25;
  if (years < 10) return years.toFixed(1) + 'y';
  return Math.round(years) + 'y';
}

function _renderContractAge(addressLower, deployAges) {
  if (!deployAges || !deployAges.addresses) return '';
  const entry = deployAges.addresses[addressLower];
  // Skip if no deployment timestamp resolved yet (EOA placeholder, fetch
  // failed, or not yet crawled). UI gracefully omits the row.
  if (!entry || !entry.deployedAt) return '';
  const dep = Number(entry.deployedAt);
  if (!isFinite(dep) || dep <= 0) return '';
  const now = Math.floor(Date.now() / 1000);
  const ageSec = now - dep;
  if (ageSec < 0) return '';
  const ageStr = _fmtAge(ageSec);
  const isNew = ageSec < AGE_WARNING_SECONDS;
  // Inline colour — keep CSS surface small; matches _gradeColor palette.
  const ageColor = isNew ? '#e87a43' : 'var(--text)';
  const newPill = isNew
    ? ' <span class="info-age-pill" title="Contract deployed less than 30 days ago — elevated risk" style="background:#e87a43;color:#0d1117;padding:1px 5px;border-radius:8px;font-size:9.5px;font-weight:700;margin-left:4px;">NEW</span>'
    : '';

  // Proxy upgrade suffix.
  let proxySuffix = '';
  if (entry.isProxy) {
    if (entry.implementationUpgradedAt) {
      const upgradeAge = now - Number(entry.implementationUpgradedAt);
      const upgradeStr = _fmtAge(upgradeAge);
      const upgradeIsRecent = upgradeAge < PROXY_UPGRADE_WARNING_SECONDS;
      const upgradeColor = upgradeIsRecent ? '#ea3943' : 'var(--text-dim)';
      proxySuffix = ` <span class="info-proxy-note" style="color:${upgradeColor};font-size:10px;">(impl upgraded ${_esc(upgradeStr)} ago${upgradeIsRecent ? ' ⚠' : ''})</span>`;
    } else {
      proxySuffix = ` <span class="info-proxy-note" style="color:var(--text-dim);font-size:10px;">(proxy, never upgraded)</span>`;
    }
  }

  return `
    <div class="info-stat info-stat-age">
      <span class="info-stat-label">Contract age</span>
      <span class="info-stat-val" style="color:${ageColor}">${_esc(ageStr)}${newPill}${proxySuffix}</span>
    </div>`;
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

function _renderCard(symbol, address, entry, deployAges) {
  const safeSym = _esc(symbol || '?');
  const safeAddr = _esc(address);
  const ageBlock = _renderContractAge(String(address || '').toLowerCase(), deployAges);
  if (!entry) {
    return `
      <div class="info-card info-card-empty">
        <div class="info-card-head">
          <span class="info-card-sym">${safeSym}</span>
          <a class="info-card-addr" href="${window.getExplorerTokenUrl ? window.getExplorerTokenUrl(safeAddr) : 'https://etherscan.io/token/' + safeAddr}" target="_blank" rel="noopener noreferrer" title="${safeAddr}">${safeAddr.slice(0, 6)}…${safeAddr.slice(-4)}</a>
        </div>
        <div class="info-card-empty-body">No rating available in aggregator for this address.</div>
        ${ageBlock ? `<div class="info-stats-row">${ageBlock}</div>` : ''}
      </div>`;
  }
  const name = _esc(entry.name || entry.symbol || symbol);
  const pharos = entry.pharos || {};
  const defi = entry.defillama || {};
  const bluechip = entry.bluechip || {};
  const tidScore = entry.tidResearchScore || null;
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

  // TID Research numeric-score row (added v=20260527c). Mirrors TID's own
  // colour buckets (orange=high-risk, amber=medium, lime=low-risk). The
  // overall score is paired with a tooltip listing per-axis breakdown so
  // hover over the badge shows e.g. "Peg Mechanism 4.5 | Backing 4.5 …".
  // Click → TID report page (same URL as the research[] pill — both stay).
  const TID_BUCKET_COLOR = {
    orange: '#fb923c',
    amber:  '#fbbf24',
    lime:   '#a3e635',
  };
  let tidScoreRow = '';
  if (tidScore && typeof tidScore.overall === 'number') {
    const tidColor = TID_BUCKET_COLOR[tidScore.color_bucket] || '#9ca3af';
    const tidUrl = tidScore.url ? _esc(tidScore.url) : '';
    const tidLink = tidUrl
      ? `<a href="${tidUrl}" target="_blank" rel="noopener" class="info-src-link">↗</a>`
      : '';
    const axes = tidScore.axes && typeof tidScore.axes === 'object' ? tidScore.axes : {};
    const axisParts = Object.entries(axes).map(([label, info]) => {
      const v = info && typeof info.score === 'number' ? info.score : null;
      return v != null ? `${label} ${v}` : null;
    }).filter(Boolean);
    const lv = tidScore.last_verified ? ` · verified ${tidScore.last_verified}` : '';
    const tooltip = axisParts.length
      ? `${axisParts.join(' | ')}${lv}`
      : `Scale 1–10. Higher is safer.${lv}`;
    const scoreText = `${tidScore.overall.toFixed(1)}/10`;
    tidScoreRow =
      `<div class="info-src-row" title="${_esc(tooltip)}">` +
        `<span class="info-src-label">TID Research</span>` +
        `<span class="info-src-val" style="color:${tidColor};font-weight:600;">${_esc(scoreText)}</span>` +
        tidLink +
      `</div>`;
  }

  // Unified Research block (Александр request 2026-05-14): replaces the
  // separate Llamarisk + TelosConsilium rows. Items grouped by source with
  // coloured pills; only renders if research[] non-empty.
  const RESEARCH_SRC_COLOR = {
    'LlamaRisk': '#10b981',
    'Curve Team': '#3b82f6',
    'TelosConsilium': '#eab308',
    'TID Research': '#a855f7',
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
        ${ageBlock}
      </div>
      ${dims}
      <div class="info-sources">
        <div class="info-src-row"><span class="info-src-label">Pharos</span><span class="info-src-val" style="color:${gradeColor}">${_esc(pharos.grade || '—')}${pharos.score != null ? ' · ' + pharos.score : ''}</span>${pharosLink}</div>
        ${bluechipRow}
        ${tidScoreRow}
        ${researchBlock}
      </div>
    </div>`;
}

// Base-pool LP token used as a metapool coin (crv2pool=USDC/USDT 2pool LP,
// 3Crv=3pool LP, ...) has no aggregator entry of its own. Synthesize an
// inherited entry from the base pool's underlying coins: take the WEAKEST
// underlying's Pharos grade/dimensions and tag inheritedFrom, so the INFO
// card shows the inherited grade + "Rating inherited from <underlying>"
// instead of "No rating available" (Alexandr 2026-06-19). Returns null when
// not a base LP or any underlying is unrated (empty card renders, as before).
const _INFO_GRADE_RANK = { 'A+':11,'A':10,'A-':9,'B+':8,'B':7,'B-':6,'C+':5,'C':4,'C-':3,'D+':2,'D':1,'D-':0.5,'F':0 };
function _synthBaseLpEntry(lpAddr, tokens) {
  const pools = window.allPools;
  if (!Array.isArray(pools) || !tokens) return null;
  const base = pools.find(p =>
    String((p.lpTokenAddress || p.address) || '').toLowerCase() === lpAddr ||
    String(p.address || '').toLowerCase() === lpAddr);
  if (!base || !Array.isArray(base.coinsAddresses) || !base.coinsAddresses.length) return null;
  let weakest = null, weakestRank = Infinity;
  const syms = [];
  for (let i = 0; i < base.coinsAddresses.length; i++) {
    const ua = String(base.coinsAddresses[i] || '').toLowerCase();
    const ue = tokens[ua];
    const ug = ue && ue.pharos && ue.pharos.grade;
    if (!ug || String(ug).toUpperCase() === 'NR') return null; // any unrated -> no inherited card
    syms.push((base.coins && base.coins[i]) || '?');
    const r = _INFO_GRADE_RANK[String(ug).trim().toUpperCase()];
    const rr = (r != null ? r : -1);
    if (rr < weakestRank) { weakestRank = rr; weakest = ue; }
  }
  if (!weakest || !weakest.pharos) return null;
  return {
    name: base.name || (syms.join('/') + ' LP'),
    symbol: base.symbol || syms.join('/'),
    inheritedFrom: { symbol: syms.join(' + ') },
    pharos: {
      grade: weakest.pharos.grade,
      score: weakest.pharos.score,
      dimensions: weakest.pharos.dimensions,
    },
  };
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

  // Parallel: ratings cache + deployment ages. deployAges may be null (graceful
  // degrade — card still renders, just without Contract age line).
  const [cache, deployAges] = await Promise.all([
    fetchRatingsCache(),
    fetchDeployAges(),
  ]);
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
    const entry = tokens[key] || _synthBaseLpEntry(key, tokens);
    return _renderCard(symbol, key, entry, deployAges);
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
