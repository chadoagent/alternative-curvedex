// ============================================================
// FEATURE FLAGS
// ============================================================
// Hide "Quote Comparison" panel until multiple aggregators are wired up.
// Flip to true once ParaSwap/CoW/ODOS quotes can be compared meaningfully.
const SHOW_QUOTE_COMPARISON = false;

// ============================================================
// OHLC cache — avoids re-fetching on timeframe toggle (60s TTL)
// ============================================================
const _ohlcCache = new Map(); // key → {data, ts}
const _OHLC_CACHE_TTL = 60000; // 60s

// ============================================================
// get_dy ABI cache — first call discovers whether a pool uses int128 or
// uint256 indices; cached so subsequent quotes pick the right ABI on first
// try (saves 1× RPC RTT per keystroke for cryptopools). Registry hint biases
// the *initial* guess before any cache entry exists.
// ============================================================
const _abiCache = new Map(); // lowerCaseAddr → 'i128' | 'u256'
function _initialAbiGuess(pool) {
  // Cryptopools and factory-crypto/twocrypto/tricrypto use uint256 indices.
  // Stable pools and stable-ng factories use int128. Default to int128.
  const r = pool && pool.registryId;
  if (r === 'crypto' || r === 'factory-crypto' || r === 'factory-twocrypto' || r === 'factory-tricrypto') return 'u256';
  return 'i128';
}

function _getOhlcCached(key) {
  const e = _ohlcCache.get(key);
  if (e && Date.now() - e.ts < _OHLC_CACHE_TTL) return e.data;
  return null;
}
function _setOhlcCache(key, data) {
  _ohlcCache.set(key, { data, ts: Date.now() });
  // Cap at 50 entries
  if (_ohlcCache.size > 50) {
    const oldest = _ohlcCache.keys().next().value;
    _ohlcCache.delete(oldest);
  }
}

// ============================================================
// Shared helper: shorten verbose Curve pool names
// ============================================================
function _shortPoolName(name) {
  if (!name) return '?';
  let s = name.replace(/^Curve\.fi\s+/i, '');
  s = s.replace(/^Factory\s+(Crypto\s+)?Pool:\s*/i, '');
  s = s.replace(/^Factory\s+USD\s+Metapool:\s*/i, '');
  s = s.replace(/^Factory\s+Plain\s+Pool:\s*/i, '');
  if (s.length > 25) {
    const colonIdx = s.lastIndexOf(': ');
    if (colonIdx > 0) s = s.substring(colonIdx + 2);
  }
  return s;
}

// ============================================================
// Trade pair header (Binance-style 2-row header) helpers — reference April-25
// ============================================================
function _setTradePairIcon(role, addr, sym) {
  // role: 'base' | 'quote'
  const el = document.getElementById(role === 'base' ? 'tradePairIconBase' : 'tradePairIconQuote');
  if (!el) return;
  const fallbackText = (sym || '?').slice(0, 2).toUpperCase();
  el.style.backgroundImage = '';
  el.style.color = '';
  el.textContent = fallbackText;
  if (!addr) return;
  const url = (typeof _tokenIconUrl === 'function') ? _tokenIconUrl(addr) : '';
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url("${url}")`;
    el.style.color = 'transparent';
  };
  img.onerror = () => { /* keep letter fallback */ };
  img.src = url;
}

function _formatVolBase(amount, sym) {
  if (amount == null || isNaN(amount) || amount <= 0) return '--';
  let s;
  if (amount >= 1e6) s = (amount / 1e6).toFixed(2) + 'M';
  else if (amount >= 1e3) s = (amount / 1e3).toFixed(2) + 'K';
  else if (amount >= 1) s = amount.toFixed(2);
  else s = amount.toFixed(4);
  return sym ? `${s}` : s;
}

function _classifyPoolType(pool) {
  if (!pool) return '';
  const nm = ((pool.name || '') + ' ' + (pool.type || '') + ' ' + (pool.registryId || '')).toLowerCase();
  if (nm.includes('crypto') || nm.includes('tricrypto') || nm.includes('twocrypto') || nm.includes('llamma')) return 'crypto';
  if (nm.includes('stable') || nm.includes('lending') || nm.includes('factory plain') || nm.includes('main') || nm.includes('metapool')) return 'stable';
  const stableSyms = /^(USD[CTPSD]|DAI|FRAX|LUSD|TUSD|USDP|GUSD|sUSD|USDD|USDe|crvUSD|USDS|PYUSD|GHO|FDUSD|MIM)$/i;
  const coins = pool.coins || [];
  if (coins.length >= 2 && coins.every(c => stableSyms.test(c))) return 'stable';
  const amp = parseFloat(pool.amplificationCoefficient);
  if (amp > 0 && amp < 1e6) return 'stable';
  return '';
}

function _poolFeePct(pool) {
  if (!pool) return null;
  const f = pool.fee != null ? pool.fee : (pool.swapFee != null ? pool.swapFee : null);
  if (f == null) return null;
  const num = parseFloat(f);
  if (isNaN(num) || num <= 0) return null;
  if (num >= 1e6) return (num / 1e8);
  if (num < 1) return num * 100;
  return num;
}

function _compute24hStats(candles, intervalSec) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const last = candles[candles.length - 1];
  const cutoff = (last.time || 0) - 24 * 3600;
  let window = candles.filter(c => (c.time || 0) >= cutoff);
  if (window.length < 2) window = candles.slice(-Math.max(2, Math.ceil(24*3600 / Math.max(intervalSec || 3600, 1))));
  if (window.length === 0) window = candles;
  let high = -Infinity, low = Infinity;
  for (const c of window) {
    if (c.high != null && c.high > high) high = c.high;
    if (c.low != null && c.low < low) low = c.low;
  }
  if (!isFinite(high) || !isFinite(low)) {
    high = last.high != null ? last.high : last.close;
    low = last.low != null ? last.low : last.close;
  }
  const open = window[0].open != null ? window[0].open : window[0].close;
  const close = last.close;
  const changeAbs = close - open;
  const changePct = open > 0 ? (changeAbs / open) * 100 : 0;
  return { high, low, open, close, changeAbs, changePct, count: window.length };
}

// ============================================================
// Favorites (localStorage-backed) — reference April-25 unified format
// ============================================================
const _FAV_STORAGE_KEY = 'curvedex_favorites';

function _getFavorites() {
  try {
    const raw = localStorage.getItem(_FAV_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function _saveFavorites(arr) {
  try { localStorage.setItem(_FAV_STORAGE_KEY, JSON.stringify(arr)); }
  catch (e) { console.warn('Save favorites failed:', e); }
}

function _favKey(pair) {
  if (!pair) return '';
  const pool = (pair.poolAddr || (pair.pool && pair.pool.address) || '').toLowerCase();
  const fa = (pair.baseAddr || '').toLowerCase();
  const ta = (pair.quoteAddr || '').toLowerCase();
  return `${pool}|${fa}|${ta}`;
}

function _isFavorite(pair) {
  if (!pair) return false;
  const k = _favKey(pair);
  return _getFavorites().some(f => `${(f.pool||'').toLowerCase()}|${(f.fromAddr||'').toLowerCase()}|${(f.toAddr||'').toLowerCase()}` === k);
}

function toggleTradePairFavorite() {
  const pair = (typeof selectedPair !== 'undefined') ? selectedPair : null;
  if (!pair) return;
  const favs = _getFavorites();
  const k = _favKey(pair);
  const idx = favs.findIndex(f => `${(f.pool||'').toLowerCase()}|${(f.fromAddr||'').toLowerCase()}|${(f.toAddr||'').toLowerCase()}` === k);
  if (idx >= 0) {
    favs.splice(idx, 1);
  } else {
    favs.push({
      pool: (pair.poolAddr || '').toLowerCase(),
      fromAddr: (pair.baseAddr || '').toLowerCase(),
      toAddr: (pair.quoteAddr || '').toLowerCase(),
      base: pair.base || '',
      quote: pair.quote || '',
      pairName: pair.name || `${pair.base}/${pair.quote}`,
      ts: Date.now(),
    });
  }
  _saveFavorites(favs);
  _renderTradeFavStar(pair);
  if (typeof renderPoolList === 'function') renderPoolList();
  if (typeof renderTokenPairList === 'function') renderTokenPairList();
  // Update sidebar favorites (today's feature, kept)
  try { if (typeof renderTradeFavorites === 'function') renderTradeFavorites(); } catch (e) {}
}

function _renderTradeFavStar(pair) {
  const btn = document.getElementById('tradeFavStar');
  if (!btn) return;
  const fav = _isFavorite(pair);
  btn.classList.toggle('active', fav);
  btn.innerHTML = fav ? '<svg class="icon icon--filled"><use href="#icon-star-filled"/></svg>' : '<svg class="icon"><use href="#icon-star-outline"/></svg>';
  btn.setAttribute('aria-pressed', fav ? 'true' : 'false');
  btn.title = fav ? 'Remove from Favorites' : 'Add to Favorites';
}

// ============================================================
// Pool action links (Etherscan / Curve.finance / Add Liquidity / Convex Pool / StakeDAO)
// ============================================================
function _buildPoolActionLinks(pool) {
  if (!pool || !pool.address) return '';
  const addr = pool.address;
  let html = `<a class="pool-action-link" href="${window.getExplorerAddressUrl ? window.getExplorerAddressUrl(addr) : 'https://etherscan.io/address/' + addr}" target="_blank" rel="noopener">Explorer</a>`;
  // Curve.finance — prefer poolUrls.deposit[0] if present, otherwise build canonical pool URL
  const curveUrl = pool.poolUrls?.deposit?.[0] || `https://curve.finance/dex/${window.getChainKey ? window.getChainKey() : 'ethereum'}/pools/${addr}/`;
  html += `<a class="pool-action-link" href="${curveUrl}" target="_blank" rel="noopener">Curve.finance</a>`;
  // Add Liquidity (deposit URL) — only if explicit deposit url available and != curveUrl
  if (pool.poolUrls?.deposit?.[0] && pool.poolUrls.deposit[0] !== curveUrl) {
    html += `<a class="pool-action-link" href="${pool.poolUrls.deposit[0]}" target="_blank" rel="noopener">Add Liquidity</a>`;
  } else if (pool.poolUrls?.deposit?.[0]) {
    html += `<a class="pool-action-link" href="${pool.poolUrls.deposit[0]}#deposit" target="_blank" rel="noopener">Add Liquidity</a>`;
  }
  // Convex / StakeDAO placeholders — refined async via _refinePoolActionLinks()
  html += `<span class="pool-action-link-slot" data-slot="convex"></span>`;
  html += `<span class="pool-action-link-slot" data-slot="stakedao"></span>`;
  return html;
}

async function _refinePoolActionLinks(pool, containerId) {
  if (!pool || !pool.address) return;
  const container = document.getElementById(containerId);
  if (!container) return;
  // Convex: need pid map. fetchConvexYields() lives in yield.js but is global.
  try {
    if (typeof fetchConvexYields === 'function') {
      const cvxMap = await fetchConvexYields();
      const entry = cvxMap?.get(pool.address.toLowerCase()) || cvxMap?.get((pool.lpTokenAddress || '').toLowerCase());
      const slot = container.querySelector('[data-slot="convex"]');
      if (slot && entry && entry.pid != null) {
        const chainSlug = (window.getChainKey ? window.getChainKey() : 'ethereum');
        slot.outerHTML = `<a class="pool-action-link" href="https://curve.convexfinance.com/stake/${chainSlug}/${entry.pid}" target="_blank" rel="noopener">Convex Pool</a>`;
      } else if (slot) {
        slot.remove();
      }
    }
  } catch (e) { /* non-fatal */ }
  // StakeDAO: search by LP token address
  try {
    if (typeof fetchStakeDaoYields === 'function') {
      const sdCache = await fetchStakeDaoYields();
      const lp = (pool.lpTokenAddress || pool.address || '').toLowerCase();
      const gauge = (pool.gaugeAddress || '').toLowerCase();
      const found = (lp && sdCache?.byLpAddr?.has(lp)) || (gauge && sdCache?.byGaugeAddr?.has(gauge));
      const slot = container.querySelector('[data-slot="stakedao"]');
      if (slot && found && lp) {
        slot.outerHTML = `<a class="pool-action-link" href="https://www.stakedao.org/yield?protocol=curve&search=${lp}" target="_blank" rel="noopener">StakeDAO</a>`;
      } else if (slot) {
        slot.remove();
      }
    }
  } catch (e) { /* non-fatal */ }
}

window._buildPoolActionLinks = _buildPoolActionLinks;
window._refinePoolActionLinks = _refinePoolActionLinks;

window.toggleTradePairFavorite = toggleTradePairFavorite;
window._isFavoritePool = function(poolAddr) {
  if (!poolAddr) return false;
  const lc = poolAddr.toLowerCase();
  return _getFavorites().some(f => (f.pool || '').toLowerCase() === lc);
};
window._getFavoritePools = function() {
  const pools = new Set();
  for (const f of _getFavorites()) if (f.pool) pools.add(f.pool.toLowerCase());
  return pools;
};

// togglePoolFavorite: pool-view favorite (pools page rich header)
function togglePoolFavorite() {
  const pool = (typeof selectedPool !== 'undefined') ? selectedPool : null;
  if (!pool) return;
  _togglePoolLevelFavorite(pool);
  _renderPoolFavStar();
  if (typeof renderPoolList === 'function') renderPoolList();
  try { renderPoolFavoritesSidebar(); } catch (e) {}
}

// toggleYieldPoolFavorite: yield-view fav star
function toggleYieldPoolFavorite() {
  const pool = (typeof selectedPool !== 'undefined') ? selectedPool : null;
  if (!pool) return;
  _togglePoolLevelFavorite(pool);
  _renderYieldFavStar();
  if (typeof renderPoolList === 'function') renderPoolList();
  try { renderPoolFavoritesSidebar(); } catch (e) {}
}

function _togglePoolLevelFavorite(pool) {
  const favs = _getFavorites();
  const poolLc = (pool.address || '').toLowerCase();
  const idx = favs.findIndex(f => (f.pool||'').toLowerCase() === poolLc && !(f.fromAddr));
  if (idx >= 0) favs.splice(idx, 1);
  else favs.push({ pool: poolLc, fromAddr: '', toAddr: '', base: '', quote: '', pairName: pool.name || '', ts: Date.now() });
  _saveFavorites(favs);
}

function _renderPoolFavStar() {
  const btn = document.getElementById('poolFavStar');
  if (!btn) return;
  const pool = (typeof selectedPool !== 'undefined') ? selectedPool : null;
  const fav = pool && (typeof window._isFavoritePool === 'function') ? window._isFavoritePool(pool.address) : false;
  btn.classList.toggle('active', fav);
  btn.innerHTML = fav ? '<svg class="icon icon--filled"><use href="#icon-star-filled"/></svg>' : '<svg class="icon"><use href="#icon-star-outline"/></svg>';
  btn.setAttribute('aria-pressed', fav ? 'true' : 'false');
  btn.title = fav ? 'Remove from Favorites' : 'Add to Favorites';
}

function _renderYieldFavStar() {
  const btn = document.getElementById('yieldFavStar');
  if (!btn) return;
  const pool = (typeof selectedPool !== 'undefined') ? selectedPool : null;
  const fav = pool && (typeof window._isFavoritePool === 'function') ? window._isFavoritePool(pool.address) : false;
  btn.classList.toggle('active', fav);
  btn.innerHTML = fav ? '<svg class="icon icon--filled"><use href="#icon-star-filled"/></svg>' : '<svg class="icon"><use href="#icon-star-outline"/></svg>';
  btn.setAttribute('aria-pressed', fav ? 'true' : 'false');
  btn.title = fav ? 'Remove from Favorites' : 'Add to Favorites';
}

// Favorites sidebar collapse state — persisted in localStorage per scope.
const _FAV_COLLAPSE_KEY = 'curvedex_fav_collapsed_v1';
function _getFavCollapseState() {
  try { return JSON.parse(localStorage.getItem(_FAV_COLLAPSE_KEY) || '{}') || {}; }
  catch (e) { return {}; }
}
function _setFavCollapseState(s) {
  try { localStorage.setItem(_FAV_COLLAPSE_KEY, JSON.stringify(s || {})); } catch (e) {}
}
function _applyFavCollapse(scope) {
  const id = scope === 'trade' ? 'tradeFavoritesSidebar' : 'poolFavoritesSidebar';
  const el = document.getElementById(id);
  if (!el) return;
  const state = _getFavCollapseState();
  el.classList.toggle('collapsed', !!state[scope]);
}
function toggleFavoritesCollapse(scope) {
  const id = scope === 'trade' ? 'tradeFavoritesSidebar' : 'poolFavoritesSidebar';
  const el = document.getElementById(id);
  if (!el) return;
  const state = _getFavCollapseState();
  const next = !state[scope];
  state[scope] = next;
  _setFavCollapseState(state);
  el.classList.toggle('collapsed', next);
}
window.toggleFavoritesCollapse = toggleFavoritesCollapse;

// Sidebar: render favorite pools list (used on /pools and /yield).
// Click → call selectPool(addr) for /pools or selectYieldPool(addr) for /yield.
function renderPoolFavoritesSidebar() {
  const wrap = document.getElementById('poolFavoritesSidebar');
  const list = document.getElementById('poolFavoritesList');
  if (!wrap || !list) return;
  const favs = (typeof _getFavorites === 'function') ? _getFavorites() : [];
  // Pool-level favs only (have pool addr, no fromAddr/toAddr)
  const poolFavs = favs.filter(f => f && f.pool && !f.fromAddr);
  if (!poolFavs.length || typeof allPools === 'undefined' || !Array.isArray(allPools)) {
    wrap.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  const items = [];
  const seen = new Set();
  for (const f of poolFavs) {
    const pl = (f.pool || '').toLowerCase();
    if (seen.has(pl)) continue;
    const pool = allPools.find(p => (p.address || '').toLowerCase() === pl);
    if (!pool) continue;
    seen.add(pl);
    items.push(pool);
  }
  if (!items.length) {
    wrap.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  const selectedAddr = (typeof selectedPool !== 'undefined' && selectedPool) ? (selectedPool.address || '').toLowerCase() : null;
  list.innerHTML = items.map(p => {
    const tvl = p.tvl || 0;
    const tvlText = tvl >= 1e6 ? '$' + (tvl / 1e6).toFixed(1) + 'M'
                  : tvl >= 1e3 ? '$' + (tvl / 1e3).toFixed(0) + 'K'
                  : '$' + tvl.toFixed(0);
    const coins = Array.isArray(p.coins) ? p.coins : [];
    const baseSym = coins[0] || '';
    const quoteSym = coins[1] || '';
    const baseAddr = (p.coinsAddresses && p.coinsAddresses[0]) || '';
    const quoteAddr = (p.coinsAddresses && p.coinsAddresses[1]) || '';
    const baseIcon = baseAddr ? `<img src="${(typeof _tokenIconUrl === 'function') ? _tokenIconUrl(baseAddr) : ''}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
    const quoteIcon = quoteAddr ? `<img src="${(typeof _tokenIconUrl === 'function') ? _tokenIconUrl(quoteAddr) : ''}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
    const isActive = (p.address || '').toLowerCase() === selectedAddr;
    const safeAddr = String(p.address || '').replace(/'/g, "\\'");
    // selectPool handles both /pools and /yield (uses currentView)
    const handler = `(typeof selectPool==='function' && selectPool('${safeAddr}'))`;
    const shortName = (typeof _shortPoolName === 'function') ? _shortPoolName(p.name || '') : (p.name || '');
    const rawDisplay = baseSym && quoteSym ? `${baseSym} / ${quoteSym}` : shortName.slice(0, 22);
    const displayName = (window.escapeHtml || (s => String(s)))(rawDisplay);
    return `<div class="sidebar-fav-item${isActive ? ' active' : ''}" data-pool="${p.address}" onclick="${handler}">
      <div class="sidebar-fav-icons">${baseIcon}${quoteIcon}</div>
      <div class="sidebar-fav-name">${displayName}</div>
      <div class="sidebar-fav-tvl">${tvlText}</div>
    </div>`;
  }).join('');
  wrap.style.display = '';
  _applyFavCollapse('pool');
}

window.togglePoolFavorite = togglePoolFavorite;
window.toggleYieldPoolFavorite = toggleYieldPoolFavorite;
window._renderPoolFavStar = _renderPoolFavStar;
window._renderYieldFavStar = _renderYieldFavStar;
window.renderPoolFavoritesSidebar = renderPoolFavoritesSidebar;

// Inline pool-list star toggle (called from app.js renderPoolList rows).
// Takes raw pool address; resolves the pool object from allPools, flips its
// favorite state, refreshes the list and the favorites sidebar.
window.toggleFavoriteByAddr = function(addr) {
  if (!addr) return;
  const pool = (typeof allPools !== 'undefined' ? allPools : []).find(
    p => (p.address || '').toLowerCase() === addr.toLowerCase()
  );
  if (!pool) return;
  _togglePoolLevelFavorite(pool);
  if (typeof renderPoolList === 'function') renderPoolList();
  try { renderPoolFavoritesSidebar(); } catch {}
  // Sync the pool/yield header stars if the toggled pool happens to be selected.
  try { _renderPoolFavStar(); } catch {}
  try { _renderYieldFavStar(); } catch {}
};

// ============================================================
// Token favorites (trade token-list only) — separate from pool/pair favs
// Stores lowercase token addresses in localStorage `curvedex_starred_tokens`.
// ============================================================
const _STAR_TOKEN_KEY = 'curvedex_starred_tokens';
function _getStarredTokens() {
  try {
    const raw = localStorage.getItem(_STAR_TOKEN_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.map(a => (a || '').toLowerCase()).filter(Boolean) : [];
  } catch { return []; }
}
function _saveStarredTokens(arr) {
  try { localStorage.setItem(_STAR_TOKEN_KEY, JSON.stringify(Array.from(new Set(arr)))); } catch {}
}
window._isStarredToken = function(addr) {
  if (!addr) return false;
  return _getStarredTokens().includes(addr.toLowerCase());
};
// Inline token-list star toggle — called from renderTradeTokenSidebar rows.
// event.stopPropagation in onclick prevents row-click selectTradeTokenFromSidebar.
window.toggleFavoriteTokenByAddr = function(addr) {
  if (!addr) return;
  const lc = addr.toLowerCase();
  let arr = _getStarredTokens();
  if (arr.includes(lc)) arr = arr.filter(a => a !== lc);
  else arr.push(lc);
  _saveStarredTokens(arr);
  if (typeof renderTradeTokenSidebar === 'function') renderTradeTokenSidebar();
};

// ============================================================
// Tags (auto-classify pool/pair) — reference April-25
// ============================================================
let _hotVolumeThreshold = null;
let _hotVolumeCalcAt = 0;

function _calcHotVolumeThreshold() {
  if (Date.now() - _hotVolumeCalcAt < 60000 && _hotVolumeThreshold != null) return _hotVolumeThreshold;
  if (typeof allPools === 'undefined' || !Array.isArray(allPools) || allPools.length === 0) return null;
  const vols = allPools.map(p => p.volumeUSD || 0).filter(v => v > 0).sort((a,b) => a-b);
  if (vols.length < 10) return null;
  const idx = Math.floor(vols.length * 0.9);
  _hotVolumeThreshold = vols[idx] || null;
  _hotVolumeCalcAt = Date.now();
  return _hotVolumeThreshold;
}

// Stablecoin symbol set used for pair-aware classification. Matches `_STABLES_RICH`
// used elsewhere in this file — keep in sync. A token must appear here to count as
// "stable" for pair classification purposes.
const _STABLE_SYMS_FOR_TAGS = new Set([
  'USDC','USDT','DAI','crvUSD','FRAX','LUSD','TUSD','sUSD','USDD','GHO','PYUSD','USD0','eUSD',
  'mkUSD','USDe','USDG','USDP','BUSD','MIM','UST','RAI','alUSD','DOLA','MAI','USDx','sDAI','sUSDe','USR',
  'frxUSD','sfrxUSD','USDS','sUSDS','scrvUSD','USDL','USDM','syrupUSDC','USDF','USD3','RLUSD','USDY','USDtb','wM','M',
].map(s => s.toLowerCase()));

// pair: optional {base, quote} symbols. When both pair tokens are known, a pool is
// only tagged "Stable" / "crvUSD" when BOTH legs of the pair are stable. This
// prevents the engine type (e.g. factory-stable-ng) from spilling onto pairs like
// sdYB/crvUSD where one side (sdYB) is volatile.
function _computePoolTags(pool, pair) {
  if (!pool) return [];
  const tags = [];
  const reg = (pool.registryId || pool.type || '').toLowerCase();
  const isCryptoReg = ['crypto', 'factory-crypto', 'factory-twocrypto', 'factory-tricrypto'].some(r => reg === r);
  const coins = (pool.coins || []).map(c => (c || '').toLowerCase());
  const hasCrvusdCoin = coins.includes('crvusd');
  const isCrvusdReg = reg.includes('crvusd');
  const ptype = (typeof _classifyPoolType === 'function') ? _classifyPoolType(pool) : '';
  const isStableEngine = ptype === 'stable' || reg === 'main' || reg === 'factory-stable-ng' || reg === 'factory';
  const isCrypto = ptype === 'crypto' || isCryptoReg;
  // Pair-aware override: if we know the displayed pair, classify by the pair's
  // tokens, not the underlying pool's engine. sdYB/crvUSD trades through the
  // sdYB/YB stableswap pool but the displayed pair has a volatile leg (sdYB),
  // so it must NOT be tagged "Stable". Same for the "crvUSD" tag — a pair only
  // earns it when crvUSD is one leg of the pair, not just one of the pool coins.
  let pairBothStable = null;
  let pairHasCrvusd = null;
  if (pair && pair.base && pair.quote) {
    const baseSym = String(pair.base).toLowerCase();
    const quoteSym = String(pair.quote).toLowerCase();
    pairBothStable = _STABLE_SYMS_FOR_TAGS.has(baseSym) && _STABLE_SYMS_FOR_TAGS.has(quoteSym);
    pairHasCrvusd = baseSym === 'crvusd' || quoteSym === 'crvusd';
  }
  // Decide tag. When pair info is available it is authoritative.
  const showCrvusd = pairHasCrvusd !== null
    ? (pairHasCrvusd && pairBothStable)  // crvUSD tag only when crvUSD is a leg AND the pair is stable-stable
    : (isCrvusdReg || hasCrvusdCoin);
  const showStable = pairBothStable !== null
    ? pairBothStable
    : isStableEngine;
  if (showCrvusd) tags.push({ kind: 'crvusd', label: 'crvUSD' });
  else if (isCrypto || (pairBothStable === false)) tags.push({ kind: 'crypto', label: 'Crypto' });
  else if (showStable) tags.push({ kind: 'stable', label: 'Stable' });
  const cts = pool.creationTs ? parseInt(pool.creationTs) : 0;
  const ageDays = cts ? (Date.now()/1000 - cts) / 86400 : 999;
  if (ageDays > 0 && ageDays < 30) tags.push({ kind: 'new', label: '\uD83C\uDD95 New' });
  const tvl = pool.tvl || 0;
  const vol = pool.volumeUSD || 0;
  const hotThr = _calcHotVolumeThreshold();
  const isHot = hotThr != null && vol >= hotThr && vol > 0;
  const isHighTvl = tvl > 100e6;
  if (isHot && isHighTvl) tags.push({ kind: 'hot', label: '\uD83D\uDD25 Hot' });
  else if (isHot) tags.push({ kind: 'hot', label: '\uD83D\uDD25 Hot' });
  else if (isHighTvl) tags.push({ kind: 'htvl', label: '\uD83D\uDC8E High TVL' });
  return tags.slice(0, 3);
}

function _renderTradeTags(pair) {
  const el = document.getElementById('tradeChartTags');
  if (!el) return;
  if (!pair || !pair.pool) { el.innerHTML = ''; return; }
  const tags = _computePoolTags(pair.pool, pair);
  el.innerHTML = tags.map(t => { const e = window.escapeHtml || (s => String(s)); return `<span class="chart-tag chart-tag-${e(t.kind)}">${e(t.label)}</span>`; }).join('');
}

function _renderPoolTags(pool) {
  const el = document.getElementById('poolChartTags');
  if (!el) return;
  if (!pool) { el.innerHTML = ''; return; }
  const tags = _computePoolTags(pool);
  el.innerHTML = tags.map(t => { const e = window.escapeHtml || (s => String(s)); return `<span class="chart-tag chart-tag-${e(t.kind)}">${e(t.label)}</span>`; }).join('');
}

window._computePoolTags = _computePoolTags;

let _tradePairLastCandle = null;
let _tradePairLastVolUSD = null;

function _renderTradePairHeader(pair, stats, opts, candles) {
  if (!pair) return;
  if (Array.isArray(candles) && candles.length > 0) {
    _tradePairLastCandle = candles[candles.length - 1];
    _renderTradePairOHLCRow(_tradePairLastCandle, _tradePairLastVolUSD);
  }
  // Token icons
  _setTradePairIcon('base', pair.baseAddr, pair.base);
  _setTradePairIcon('quote', pair.quoteAddr, pair.quote);
  // Pair name
  const nameEl = document.getElementById('tradePairName');
  if (nameEl) {
    const linkHtml = (pair.pool && typeof window._curvePoolLinkHtml === 'function')
      ? window._curvePoolLinkHtml(pair.pool) : '';
    const _esc = window.escapeHtml || (s => String(s));
    nameEl.innerHTML = `<span class="pair-clickable pair-accent" onclick="openPairPicker('from')">${_esc(pair.base || '--')}</span><span class="pair-divider"> / </span><span class="pair-clickable" onclick="openPairPicker('to')">${_esc(pair.quote || '--')}</span>` + linkHtml;
  }
  // Pool meta line
  const metaEl = document.getElementById('tradePoolMeta');
  if (metaEl) {
    const parts = [];
    if (pair.pool && pair.pool.name) parts.push(_shortPoolName(pair.pool.name));
    const feePct = _poolFeePct(pair.pool);
    if (feePct != null) parts.push(feePct.toFixed(2).replace(/\.?0+$/, '') + '% fee');
    // Pair-aware: subtitle reports the pair's economic type, not the pool's engine.
    // sdYB/crvUSD goes through factory-stable-ng (engine=stable) but pair has a
    // volatile leg → label should be "crypto", not "stable".
    let ptype = _classifyPoolType(pair.pool);
    if (ptype && pair.base && pair.quote) {
      const baseSym = String(pair.base).toLowerCase();
      const quoteSym = String(pair.quote).toLowerCase();
      const bothStable = _STABLE_SYMS_FOR_TAGS.has(baseSym) && _STABLE_SYMS_FOR_TAGS.has(quoteSym);
      if (ptype === 'stable' && !bothStable) ptype = 'crypto';
    }
    if (ptype) parts.push(ptype);
    metaEl.textContent = parts.length ? parts.join(' · ') : '--';
  }
  // Pool TVL
  const tvlEl = document.getElementById('tradeChartPoolTvl');
  if (tvlEl) tvlEl.textContent = (typeof fmt$ === 'function') ? fmt$(pair.tvl || (pair.pool && pair.pool.tvl) || 0) : '--';

  if (stats) {
    const hiEl = document.getElementById('tradeChartHigh24');
    const loEl = document.getElementById('tradeChartLow24');
    if (hiEl) hiEl.textContent = (typeof fmtPrice === 'function') ? fmtPrice(stats.high) : stats.high.toString();
    if (loEl) loEl.textContent = (typeof fmtPrice === 'function') ? fmtPrice(stats.low) : stats.low.toString();
    const chgEl = document.getElementById('tradeChartChange');
    if (chgEl) {
      const pct = stats.changePct;
      chgEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      chgEl.className = 'chart-change ' + (pct >= 0 ? 'up' : 'down');
    }
    const chgAbsEl = document.getElementById('tradeChartChangeAbs');
    if (chgAbsEl) {
      const abs = stats.changeAbs;
      const decimals = Math.abs(abs) >= 100 ? 2 : Math.abs(abs) >= 1 ? 4 : 6;
      chgAbsEl.textContent = (abs >= 0 ? '+' : '') + abs.toFixed(decimals);
      chgAbsEl.className = 'chart-change-abs ' + (abs >= 0 ? 'up' : 'down');
    }
    const subEl = document.getElementById('tradeChartPriceSub');
    if (subEl) {
      const q = (pair.quote || '').toUpperCase();
      const isUsd = /USD|USDC|USDT|DAI|FRAX|LUSD|TUSD|USDP|GUSD/.test(q);
      if (isUsd) subEl.textContent = '$' + (stats.close >= 1 ? stats.close.toFixed(2) : stats.close.toFixed(6));
      else subEl.textContent = pair.base + ' Price';
    }
  }

  const aprPill = document.getElementById('tradeChartAprPill');
  if (aprPill) aprPill.style.display = 'none';

  const vbsymEl = document.getElementById('tradeChartVolBaseSym');
  const vqsymEl = document.getElementById('tradeChartVolQuoteSym');
  if (vbsymEl) vbsymEl.textContent = pair.base || '--';
  if (vqsymEl) {
    const q = (pair.quote || '').toUpperCase();
    const isUsd = /USD|USDC|USDT|DAI|FRAX|LUSD/.test(q);
    vqsymEl.textContent = isUsd ? 'USD' : (pair.quote || '--');
  }

  _renderTradeFavStar(pair);
  _renderTradeTags(pair);
}

function _renderTradePairOHLCRow(candle, volUsd) {
  const oEl = document.getElementById('tcO');
  const hEl = document.getElementById('tcH');
  const lEl = document.getElementById('tcL');
  const cEl = document.getElementById('tcC');
  const volEl = document.getElementById('tradeChartVol');
  if (candle && candle.open != null) {
    if (oEl) oEl.textContent = (typeof fmtPrice === 'function') ? fmtPrice(candle.open) : candle.open;
    if (hEl) hEl.textContent = (typeof fmtPrice === 'function') ? fmtPrice(candle.high) : candle.high;
    if (lEl) lEl.textContent = (typeof fmtPrice === 'function') ? fmtPrice(candle.low) : candle.low;
    if (cEl) cEl.textContent = (typeof fmtPrice === 'function') ? fmtPrice(candle.close) : candle.close;
  }
  if (volEl) {
    if (volUsd != null && volUsd > 0) {
      volEl.textContent = volUsd >= 1e6 ? '$'+(volUsd/1e6).toFixed(1)+'M' : volUsd >= 1e3 ? '$'+(volUsd/1e3).toFixed(1)+'K' : '$'+volUsd.toFixed(0);
    }
  }
}

function _updateTradePairVolumeStats(volDataUsd, price, baseSym, quoteSym) {
  const baseEl = document.getElementById('tradeChartVolBase');
  const quoteEl = document.getElementById('tradeChartVolQuote');
  if (!Array.isArray(volDataUsd) || volDataUsd.length === 0) {
    if (baseEl) baseEl.textContent = '--';
    if (quoteEl) quoteEl.textContent = '--';
    return;
  }
  const lastT = volDataUsd[volDataUsd.length - 1].time || 0;
  const cutoff = lastT - 24 * 3600;
  let sumUsd = 0;
  for (const v of volDataUsd) {
    if (v.time >= cutoff) sumUsd += v.value || 0;
  }
  if (sumUsd <= 0) {
    sumUsd = volDataUsd.reduce((m, v) => Math.max(m, v.value || 0), 0);
  }
  const baseVol = price > 0 ? sumUsd / price : null;
  if (quoteEl) quoteEl.textContent = (typeof fmt$ === 'function') ? fmt$(sumUsd) : '$' + sumUsd.toFixed(0);
  if (baseEl) baseEl.textContent = baseVol != null ? _formatVolBase(baseVol, baseSym) : '--';
  _tradePairLastVolUSD = sumUsd;
  const legacyVol = document.getElementById('tradeChartVol');
  if (legacyVol) legacyVol.textContent = (typeof fmt$ === 'function') ? fmt$(sumUsd) : '$' + sumUsd.toFixed(0);
}

// Pool view rich-header renderer (mirror of trade)
function _renderPoolHeader(pool, stats, candles) {
  if (!pool) return;
  const baseSym = (pool.coins && pool.coins[0]) || '';
  const quoteSym = (pool.coins && pool.coins[1]) || '';
  const baseAddr = (pool.coinsAddresses && pool.coinsAddresses[0]) || '';
  const quoteAddr = (pool.coinsAddresses && pool.coinsAddresses[1]) || '';
  // Token icons
  const baseEl = document.getElementById('poolPairIconBase');
  const quoteEl = document.getElementById('poolPairIconQuote');
  if (baseEl) {
    baseEl.textContent = (baseSym || '?').slice(0, 2).toUpperCase();
    if (baseAddr && typeof _tokenIconUrl === 'function') {
      const url = _tokenIconUrl(baseAddr);
      const img = new Image();
      img.onload = () => { baseEl.style.backgroundImage = `url("${url}")`; baseEl.style.color = 'transparent'; };
      img.src = url;
    }
  }
  if (quoteEl) {
    quoteEl.textContent = (quoteSym || '?').slice(0, 2).toUpperCase();
    if (quoteAddr && typeof _tokenIconUrl === 'function') {
      const url = _tokenIconUrl(quoteAddr);
      const img = new Image();
      img.onload = () => { quoteEl.style.backgroundImage = `url("${url}")`; quoteEl.style.color = 'transparent'; };
      img.src = url;
    }
  }
  // Pair name — clickable tickers populate the sidebar pool search (msg 245).
  const nameEl = document.getElementById('poolPairName');
  if (nameEl) {
    const linkHtml = (typeof window._curvePoolLinkHtml === 'function') ? window._curvePoolLinkHtml(pool) : '';
    if (pool.coins && pool.coins.length >= 2) {
      const parts = pool.coins.map((c, i) => {
        const cls = i === 0 ? 'pair-clickable pair-accent' : 'pair-clickable';
        const safeSym = String(c).replace(/'/g, "\\'");
        return `<span class="${cls}" title="Click to filter pools by ${c}" onclick="pickTokenSearch('${safeSym}')">${c}</span>`;
      });
      nameEl.innerHTML = parts.join('<span class="pair-divider"> / </span>') + linkHtml;
    } else {
      nameEl.innerHTML = `<span class="pair-clickable pair-accent" onclick="openPairPicker('from')">${pool.name || ''}</span>` + linkHtml;
    }
  }
  // Pool meta
  const metaEl = document.getElementById('poolPoolMeta');
  if (metaEl) {
    const parts = [];
    if (pool.name) parts.push(_shortPoolName(pool.name));
    const feePct = _poolFeePct(pool);
    if (feePct != null) parts.push(feePct.toFixed(2).replace(/\.?0+$/, '') + '% fee');
    const ptype = _classifyPoolType(pool);
    if (ptype) parts.push(ptype);
    metaEl.textContent = parts.length ? parts.join(' · ') : '--';
  }
  // TVL
  const tvlEl = document.getElementById('poolChartPoolTvl');
  if (tvlEl) tvlEl.textContent = (typeof fmt$ === 'function') ? fmt$(pool.tvl || 0) : '--';
  // 24h stats
  if (stats) {
    const hiEl = document.getElementById('poolChartHigh24');
    const loEl = document.getElementById('poolChartLow24');
    if (hiEl) hiEl.textContent = (typeof fmtPrice === 'function') ? fmtPrice(stats.high) : stats.high.toString();
    if (loEl) loEl.textContent = (typeof fmtPrice === 'function') ? fmtPrice(stats.low) : stats.low.toString();
    const chgEl = document.getElementById('chartChange');
    if (chgEl) {
      const pct = stats.changePct;
      chgEl.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      chgEl.className = 'chart-change ' + (pct >= 0 ? 'up' : 'down');
    }
    const chgAbsEl = document.getElementById('poolChartChangeAbs');
    if (chgAbsEl) {
      const abs = stats.changeAbs;
      const decimals = Math.abs(abs) >= 100 ? 2 : Math.abs(abs) >= 1 ? 4 : 6;
      chgAbsEl.textContent = (abs >= 0 ? '+' : '') + abs.toFixed(decimals);
      chgAbsEl.className = 'chart-change-abs ' + (abs >= 0 ? 'up' : 'down');
    }
    const subEl = document.getElementById('poolChartPriceSub');
    if (subEl) {
      const q = (quoteSym || '').toUpperCase();
      const isUsd = /USD|USDC|USDT|DAI|FRAX|LUSD|TUSD|USDP|GUSD/.test(q);
      if (isUsd) subEl.textContent = '$' + (stats.close >= 1 ? stats.close.toFixed(2) : stats.close.toFixed(6));
      else subEl.textContent = baseSym + ' Price';
    }
  }
  // Vol symbols
  const vbsymEl = document.getElementById('poolChartVolBaseSym');
  const vqsymEl = document.getElementById('poolChartVolQuoteSym');
  if (vbsymEl) vbsymEl.textContent = baseSym || '--';
  if (vqsymEl) {
    const q = (quoteSym || '').toUpperCase();
    const isUsd = /USD|USDC|USDT|DAI|FRAX|LUSD/.test(q);
    vqsymEl.textContent = isUsd ? 'USD' : (quoteSym || '--');
  }
  _renderPoolFavStar();
  _renderPoolTags(pool);
}

window._renderPoolHeader = _renderPoolHeader;

// ============================================================
// TRADE: Header & Pool Info
// ============================================================
function updateTradeHeader() {
  const pool = selectedPool;
  if (!pool) return;
  // Render full Binance-style 2-row header for /pools view
  try { _renderPoolHeader(pool, null, null); } catch (e) { /* non-fatal */ }
  // Sync favorite star + sidebar (pools view)
  try { if (typeof _renderPoolFavStar === 'function') _renderPoolFavStar(); } catch (e) {}
  try { if (typeof renderPoolFavoritesSidebar === 'function') renderPoolFavoritesSidebar(); } catch (e) {}
}

function updateTradePoolInfo() {
  const pool = selectedPool;
  // Show all detail sections
  document.getElementById('tradePoolStats').style.display = '';
  document.getElementById('tradePoolParams').style.display = '';

  // Stats
  document.getElementById('infoTvl').textContent = fmt$(pool.tvl);
  document.getElementById('infoVolume').textContent = fmt$(pool.volumeUSD);
  const estFees = pool.volumeUSD * 0.0004; // ~0.04% avg fee estimate
  document.getElementById('infoFees').textContent = pool.volumeUSD > 0 ? '~' + fmt$(estFees) : '--';
  document.getElementById('infoVPrice').textContent = pool.virtualPrice > 0 ? (pool.virtualPrice / 1e18).toFixed(6) : '--';

  // APY breakdown
  const gaugeApy = Array.isArray(pool.gaugeCrvApy) ? pool.gaugeCrvApy : [0, 0];
  const avgGauge = (gaugeApy[0] + gaugeApy[1]) / 2;
  let apyHtml = '';
  apyHtml += `<div class="apy-row"><span class="apy-row-label">Base (fees)</span><span class="apy-row-value green">${fmtPct(pool.dailyApy)}</span></div>`;
  apyHtml += `<div class="apy-row"><span class="apy-row-label">Weekly</span><span class="apy-row-value green">${fmtPct(pool.weeklyApy)}</span></div>`;
  if (avgGauge > 0) {
    apyHtml += `<div class="apy-row"><span class="apy-row-label">CRV Rewards</span><span class="apy-row-value blue">${fmtPct(gaugeApy[0])} - ${fmtPct(gaugeApy[1])}</span></div>`;
  }
  if (pool.merklApr > 0) {
    apyHtml += `<div class="apy-row"><span class="apy-row-label">Merkl</span><span class="apy-row-value purple">+${fmtPct(pool.merklApr)}</span></div>`;
  }
  const totalApy = pool.totalApy || pool.dailyApy;
  apyHtml += `<div class="apy-row total"><span class="apy-row-label">Total APY</span><span class="apy-row-value">${fmtPct(totalApy)}</span></div>`;
  document.getElementById('tradeApyBreakdown').innerHTML = apyHtml;

  // Parameters
  document.getElementById('infoType').textContent = pool.registryId || pool.type;
  const ampCoeff = pool.amplificationCoefficient;
  document.getElementById('infoAmpCoeff').textContent = ampCoeff ? Number(ampCoeff).toLocaleString() : '--';
  document.getElementById('infoAddress').innerHTML = `<a href="${window.getExplorerAddressUrl(pool.address)}" target="_blank" rel="noopener noreferrer" title="${pool.address}">${shortAddr(pool.address)}</a>`;

  const lpAddr = pool.lpTokenAddress || pool.address;
  document.getElementById('infoLpToken').innerHTML = `<a href="${window.getExplorerAddressUrl(lpAddr)}" target="_blank" rel="noopener noreferrer" title="${lpAddr}">${shortAddr(lpAddr)}</a>`;

  const gaugeRow = document.getElementById('infoGaugeRow');
  if (pool.gaugeAddress) {
    gaugeRow.style.display = '';
    document.getElementById('infoGauge').innerHTML = `<a href="${window.getExplorerAddressUrl(pool.gaugeAddress)}" target="_blank" rel="noopener noreferrer" title="${pool.gaugeAddress}">${shortAddr(pool.gaugeAddress)}</a>`;
  } else {
    gaugeRow.style.display = 'none';
  }

  // Action links
  document.getElementById('tradePoolLinks').innerHTML = _buildPoolActionLinks(pool);
  // Async refine: Convex/StakeDAO links if pool listed
  _refinePoolActionLinks(pool, 'tradePoolLinks');

  // Token balances
  updateTradeTokenBalances();
}

function updateTradeTokenBalances() {
  const pool = selectedPool;
  const container = document.getElementById('tradeTokenBalances');
  const list = document.getElementById('tradeTokenBalancesList');
  if (!pool._hasDetail) { container.style.display = 'none'; return; }

  const regData = poolDetailsByRegistry.get(pool.registryId);
  const poolDetail = regData?.find(p => p.address.toLowerCase() === pool.address.toLowerCase());
  // Use registry detail if available, otherwise use coinsDetailed from cache
  const coins = poolDetail?.coins || (pool.coinsDetailed ? pool.coinsDetailed.map(c => ({
    symbol: c.symbol, address: c.address, decimals: c.decimals,
    poolBalance: c.poolBalance, usdPrice: c.usdPrice,
  })) : null);
  if (!coins) { container.style.display = 'none'; return; }

  container.style.display = '';
  const totalUsd = coins.reduce((s, c) => s + (parseFloat(c.poolBalance) / Math.pow(10, c.decimals) * (c.usdPrice || 0)), 0);

  list.innerHTML = coins.map(c => {
    const balance = parseFloat(c.poolBalance) / Math.pow(10, c.decimals);
    const usdVal = balance * (c.usdPrice || 0);
    const pct = totalUsd > 0 ? (usdVal / totalUsd * 100) : 0;
    const iconHtml = _tokenIconInlineHtml('token-balance-icon', c.address, c.symbol);
    return `<div class="token-balance-row">
      ${iconHtml}
      <div class="token-balance-info">
        <div class="token-balance-name">${c.symbol || shortAddr(c.address)}</div>
        <div class="token-balance-bar"><div class="token-balance-fill" style="width:${pct}%"></div></div>
      </div>
      <div class="token-balance-vals">
        <div>${balance >= 1e6 ? fmtCompact(balance) : balance.toFixed(2)}</div>
        <div>${fmt$(usdVal)} <span class="token-balance-pct">${pct.toFixed(1)}%</span></div>
      </div>
    </div>`;
  }).join('');
}

// ============================================================

// ============================================================
// TRADE: Token Selection
// ============================================================
// Robust token icon renderer: preloads image and only swaps on success.
// Uses background-image trick so we never show broken-img placeholder.
// Width/height come from CSS — we don't override here so parent .token-icon
// (20x20) / .comp-icon (28x28) / .token-balance-icon (22x22) keep their size.
function _setTokenIcon(elId, address, symbol) {
  const el = document.getElementById(elId);
  if (!el) return;
  const fallbackText = String(symbol || '?').slice(0, 2).toUpperCase();
  // Reset to letter fallback while we try to load
  el.style.backgroundImage = '';
  el.style.backgroundSize = '';
  el.style.backgroundPosition = '';
  el.style.color = '';
  el.textContent = fallbackText;
  if (!address) return;
  const url = _tokenIconUrl(address);
  if (!url) return;
  const img = new Image();
  img.onload = () => {
    el.style.backgroundImage = `url("${url}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.style.color = 'transparent';
    el.textContent = fallbackText; // keep letter as text but transparent — preserves layout
  };
  img.onerror = () => { /* keep letter fallback */ };
  img.src = url;
}

// Inline icon HTML for static rendering inside innerHTML strings
// (Pool Composition rows, Token Balances rows, etc.). Renders <img> wrapped
// in the existing icon container; onerror falls back to letter via inline JS.
function _tokenIconInlineHtml(containerClass, address, symbol, sizePx) {
  const sym = String(symbol || '?');
  const fallback = sym.slice(0, 2).toUpperCase();
  const fallbackEsc = fallback.replace(/'/g, "\\'");
  const url = address ? _tokenIconUrl(address) : '';
  if (!url) {
    return `<div class="${containerClass}">${fallback}</div>`;
  }
  // We render letter as fallback content + <img> on top via background.
  // On error, hide image, letter stays visible.
  return `<div class="${containerClass}" style="background-image:url('${url}');background-size:cover;background-position:center;color:transparent;">${fallback}<img src="${url}" alt="" style="display:none" onerror="var p=this.parentNode;p.style.backgroundImage='';p.style.color='';this.remove();"></div>`;
}

function setFromToken(index) {
  if (!selectedPool || index >= selectedPool.coins.length) return;
  selectedFromToken = {
    address: selectedPool.coinsAddresses[index],
    symbol: selectedPool.coins[index],
    decimals: parseInt(selectedPool.decimals[index]) || 18,
    index: index,
  };
  document.getElementById('fromTokenName').textContent = selectedFromToken.symbol;
  _setTokenIcon('fromTokenIcon', selectedFromToken.address, selectedFromToken.symbol);
}

function setToToken(index) {
  if (!selectedPool || index >= selectedPool.coins.length) return;
  selectedToToken = {
    address: selectedPool.coinsAddresses[index],
    symbol: selectedPool.coins[index],
    decimals: parseInt(selectedPool.decimals[index]) || 18,
    index: index,
  };
  document.getElementById('toTokenName').textContent = selectedToToken.symbol;
  _setTokenIcon('toTokenIcon', selectedToToken.address, selectedToToken.symbol);
}

// ============================================================
// Volume normalization: sqrt-scale to prevent outlier domination
// Original values stored for crosshair display
// ============================================================
var _volOriginalValues = {}; // time → original USD value
function _sqrtNormalizeVol(volData) {
  _volOriginalValues = {};
  if (!volData || volData.length === 0) return volData;
  volData.forEach(d => { _volOriginalValues[d.time] = d.value; });
  return volData.map(d => ({ ...d, value: Math.sqrt(d.value) }));
}

// TRADE: Chart (Candlestick)
// ============================================================
function initTradeChart() {
  const container = document.getElementById('trade-chart-container');
  container.innerHTML = '';

  const _isMobile = window.innerWidth <= 768;
  tradeChart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#0b0e11' }, textColor: '#848e9c', fontSize: _isMobile ? 9 : 11 },
    grid: { vertLines: { color: '#1e2329' }, horzLines: { color: '#1e2329' } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#f0b90b33', width: 1, style: 0, labelBackgroundColor: '#f0b90b' },
      horzLine: { color: '#f0b90b33', width: 1, style: 0, labelBackgroundColor: '#f0b90b' },
    },
    rightPriceScale: { borderColor: '#2b3139', scaleMargins: { top: 0.1, bottom: 0.25 }, minimumWidth: _isMobile ? 48 : 70 },
    timeScale: { borderColor: '#2b3139', timeVisible: true, secondsVisible: false },
    handleScroll: { vertTouchDrag: true },
  });

  candleSeries = tradeChart.addCandlestickSeries({
    upColor: '#0ecb81', downColor: '#f6465d',
    borderUpColor: '#0ecb81', borderDownColor: '#f6465d',
    wickUpColor: '#0ecb81', wickDownColor: '#f6465d',
  });

  volumeChartSeries = tradeChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  volumeChartSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.75, bottom: 0 },
    visible: false,
    autoScale: true,
  });

  const ro = new ResizeObserver(() => {
    tradeChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
  ro.observe(container);
  tradeChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });

  // Update OHLCV display on crosshair move (like Binance)
  tradeChart.subscribeCrosshairMove(param => {
    const volEl = document.getElementById('chartVolume');
    const oEl = document.getElementById('cO');
    const hEl = document.getElementById('cH');
    const lEl = document.getElementById('cL');
    const cEl = document.getElementById('cC');
    if (!param.seriesData) { if (volEl) volEl.textContent = '--'; return; }
    // OHLC from candle series
    if (candleSeries) {
      const cd = param.seriesData.get(candleSeries);
      if (cd && cd.open != null) {
        if (oEl) oEl.textContent = fmtPrice(cd.open);
        if (hEl) hEl.textContent = fmtPrice(cd.high);
        if (lEl) lEl.textContent = fmtPrice(cd.low);
        if (cEl) cEl.textContent = fmtPrice(cd.close);
      }
    }
    // Volume
    if (volumeChartSeries && volEl) {
      const vd = param.seriesData.get(volumeChartSeries);
      if (vd && vd.value != null) {
        const origVal = _volOriginalValues[vd.time] || (vd.value * vd.value);
        volEl.textContent = origVal >= 1e6 ? '$'+(origVal/1e6).toFixed(1)+'M' : origVal >= 1e3 ? '$'+(origVal/1e3).toFixed(1)+'K' : '$'+origVal.toFixed(0);
      } else { volEl.textContent = '--'; }
    }
  });
}

async function loadOHLC() {
  if (!selectedPool) return;
  const pool = selectedPool;
  if (!pool.coinsAddresses || pool.coinsAddresses.length < 2) return;
  // Use selected swap tokens if available, otherwise default to first two
  const fromIdx = selectedFromToken ? selectedFromToken.index : 0;
  const toIdx = selectedToToken ? selectedToToken.index : 1;
  const mainToken = pool.coinsAddresses[fromIdx] || pool.coinsAddresses[0];
  const refToken = pool.coinsAddresses[toIdx] || pool.coinsAddresses[1];
  if (!mainToken || !refToken || mainToken === refToken) return;

  const timeRanges = { 1: 7*24, 4: 30*24 };
  const dayRanges = { 1: 90*24, 7: 365*24 };
  const hoursBack = currentUnit === 'day' ? (dayRanges[currentAgg] || 90*24) : (timeRanges[currentAgg] || 30*24);
  const start = Math.floor(Date.now() / 1000) - hoursBack * 3600;
  const end = Math.floor(Date.now() / 1000);
  const aggNum = currentAgg;
  const aggUnit = currentUnit;

  const url = `${PRICES_BASE}/ohlc/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&agg_number=${aggNum}&agg_units=${aggUnit}&start=${start}&end=${end}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) { console.warn(`OHLC: ${resp.status} for ${pool.name || pool.address.slice(0,10)}`); return; }
    const json = await resp.json();
    // Round timestamps to day boundaries for day/week candles (lightweight-charts requires it)
    const roundTime = currentUnit === 'day'
      ? (t => Math.floor(t / 86400) * 86400)
      : (t => t);
    const seen = new Set();
    const candles = (json.data || []).map(d => ({
      time: roundTime(d.time), open: d.open, high: d.high, low: d.low, close: d.close,
    })).filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
    if (candles.length > 0 && candleSeries) {
      candleSeries.setData(candles);
      _adaptCandlePrecision(candleSeries, candles, tradeChart);
      lastCandleData = candles.map(c => c.time); // Store timestamps for volume alignment
      lastCandleOHLC = candles; // Store full OHLC for volume bar coloring
      const last = candles[candles.length - 1];
      const first = candles[0];
      const priceEl = document.getElementById('chartPrice');
      priceEl.textContent = fmtPrice(last.close);
      priceEl.style.color = last.close >= first.open ? 'var(--green)' : 'var(--red)';
      const changeEl = document.getElementById('chartChange');
      // Use previous candle for 24h/period change (not first candle of entire range)
      const prev = candles.length >= 2 ? candles[candles.length - 2] : first;
      const changePct = ((last.close - prev.open) / prev.open * 100);
      changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
      changeEl.className = 'chart-change ' + (changePct >= 0 ? 'up' : 'down');
      // Refresh full Binance-style header with 24h stats (April-25 reference)
      try {
        const intervalSec = candles.length >= 2 ? Math.max(1, candles[1].time - candles[0].time) : 3600;
        const stats = _compute24hStats(candles, intervalSec);
        if (typeof _renderPoolHeader === 'function') _renderPoolHeader(selectedPool, stats, candles);
        // Also update OHLC row default
        const lastCandle = candles[candles.length - 1];
        const oEl = document.getElementById('cO'), hEl = document.getElementById('cH'), lEl = document.getElementById('cL'), cEl = document.getElementById('cC');
        if (oEl) oEl.textContent = fmtPrice(lastCandle.open);
        if (hEl) hEl.textContent = fmtPrice(lastCandle.high);
        if (lEl) lEl.textContent = fmtPrice(lastCandle.low);
        if (cEl) cEl.textContent = fmtPrice(lastCandle.close);
      } catch (e) { /* non-fatal */ }
    }
  } catch (e) {
    console.error('OHLC load error:', e);
  }
  loadVolumeFromTrades();
}

const CDX_API = (typeof window !== 'undefined' && window.__CDX_API_BASE)
  ? window.__CDX_API_BASE
  : ((typeof window !== 'undefined' && window.__DYNAMIC_BASE) ? window.__DYNAMIC_BASE + '/cdx-api' : 'https://t.llama.box/cdx-api');

// Long-history daily volume snapshot (server-side collected from Curve internal
// Postgres). Fills gaps older than what prices.curve.finance and CDX_API expose.
// Lazy-loaded once per page. Schema: { pools: { "0x..": { days: [{day,vol_usd}] }}}
let _longHistoryVolPromise = null;
function _ensureLongHistoryVol() {
  if (_longHistoryVolPromise) return _longHistoryVolPromise;
  _longHistoryVolPromise = fetch(((typeof window !== 'undefined' && window.__DYNAMIC_BASE) || '') + '/curvedex/collector/daily_volumes.json?v=' + (window.__APP_VERSION__ || ''), { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  return _longHistoryVolPromise;
}

// Merge long-history daily snapshot into CDX daily array. Newer wins on conflict
// (CDX is closer to real-time and includes intraday updates of "today"). Returns
// merged array sorted ascending by timestamp.
function _mergeLongHistoryDaily(cdxDaily, poolAddress) {
  return _ensureLongHistoryVol().then(snap => {
    if (!snap || !snap.pools) return cdxDaily;
    const entry = snap.pools[String(poolAddress).toLowerCase()];
    if (!entry || !Array.isArray(entry.days)) return cdxDaily;
    const byTs = new Map();
    // Seed from snapshot first (older history)
    for (const d of entry.days) {
      if (!d.day) continue;
      const ts = Math.floor(Date.parse(d.day + 'T00:00:00Z') / 1000);
      if (!Number.isFinite(ts)) continue;
      byTs.set(ts, { timestamp: ts, volume_usd: Number(d.vol_usd) || 0,
                     date: d.day, trade_count: 0, _src: 'snapshot' });
    }
    // Overlay CDX (recent + authoritative)
    for (const d of (cdxDaily || [])) {
      if (typeof d.timestamp !== 'number') continue;
      byTs.set(d.timestamp, { ...d, _src: 'cdx' });
    }
    return Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
  });
}

async function loadVolumeFromTrades() {
  if (!selectedPool) return;
  const pool = selectedPool;

  // Recreate histogram series to avoid stale scale state after right-scale margin changes
  if (volumeChartSeries && tradeChart) {
    try { tradeChart.removeSeries(volumeChartSeries); } catch(e) {}
    volumeChartSeries = tradeChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volumeChartSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
      visible: false,
      autoScale: true,
    });
  }

  // Use our collected trades API (full history, daily granularity).
  // Then merge with the long-history daily snapshot (collector/daily_volumes.json,
  // ~400 days back from Curve internal Postgres) so 1D/1W charts show > 60 days.
  // For sub-daily candles (1H/4H), distribute daily volume evenly across candles within each day.
  try {
    let cdxDaily = [];
    try {
      const resp = await fetch(`${CDX_API}/trades/${pool.address}?t=${Date.now()}`, { cache: 'no-store' });
      if (resp.ok) {
        const data = await resp.json();
        cdxDaily = (data && Array.isArray(data.daily)) ? data.daily : [];
      }
    } catch { /* keep cdxDaily = [] */ }

    // Merge in long-history snapshot for 1D / 1W timeframes (it's daily granularity).
    // For sub-daily we still use the merged set — it covers gaps just the same.
    const mergedDaily = await _mergeLongHistoryDaily(cdxDaily, pool.address);
    if (mergedDaily.length > 0 && volumeChartSeries) {
      const candleTimestamps = lastCandleData || [];
      const candleTimeSet = new Set(candleTimestamps);
      // Filter merged to candle range and exclude zero-volume entries
      const firstCandle = candleTimestamps.length > 0 ? candleTimestamps[0] : 0;
      const lastCandle = candleTimestamps.length > 0 ? candleTimestamps[candleTimestamps.length - 1] : Infinity;
      const filtered = mergedDaily.filter(d => d.volume_usd > 0 && d.timestamp >= firstCandle && d.timestamp <= lastCandle + 7 * 86400);
        let volData;
        if (currentUnit === 'day' && currentAgg >= 7) {
          // Weekly: aggregate daily into weekly buckets aligned with candle timestamps
          const weekMap = {};
          filtered.forEach(d => {
            // Find nearest candle timestamp (week start)
            let bucket = candleTimestamps.length > 0 ? candleTimestamps[0] : d.timestamp;
            for (let i = candleTimestamps.length - 1; i >= 0; i--) {
              if (candleTimestamps[i] <= d.timestamp) { bucket = candleTimestamps[i]; break; }
            }
            if (!weekMap[bucket]) weekMap[bucket] = 0;
            weekMap[bucket] += d.volume_usd;
          });
          // Build candle direction map for coloring
          const candleDir = {};
          if (lastCandleOHLC) lastCandleOHLC.forEach(c => { candleDir[c.time] = c.close >= c.open; });
          volData = Object.entries(weekMap)
            .map(([time, value]) => {
              const t = parseInt(time);
              const up = candleDir[t] !== undefined ? candleDir[t] : true;
              return { time: t, value, color: up ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)' };
            })
            .sort((a, b) => a.time - b.time);
        } else if (currentUnit === 'day' || candleTimestamps.length === 0) {
          // Daily: only include entries that match a candle timestamp
          const candleDirD = {};
          if (lastCandleOHLC) lastCandleOHLC.forEach(c => { candleDirD[c.time] = c.close >= c.open; });
          volData = filtered
            .filter(d => candleTimeSet.size === 0 || candleTimeSet.has(d.timestamp))
            .map(d => {
              const up = candleDirD[d.timestamp] !== undefined ? candleDirD[d.timestamp] : true;
              return { time: d.timestamp, value: d.volume_usd, color: up ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)' };
            });
        } else {
          // Sub-daily (1H/4H): distribute each day's volume across its candles
          const dayVolMap = new Map();
          filtered.forEach(d => dayVolMap.set(d.timestamp, d.volume_usd));
          const volumeMap = {};
          // Group candles by day
          const candlesByDay = {};
          candleTimestamps.forEach(ts => {
            const dayTs = Math.floor(ts / 86400) * 86400;
            if (!candlesByDay[dayTs]) candlesByDay[dayTs] = [];
            candlesByDay[dayTs].push(ts);
          });
          // Distribute daily volume evenly across candles in that day
          for (const [dayTs, candles] of Object.entries(candlesByDay)) {
            const dayVol = dayVolMap.get(parseInt(dayTs)) || 0;
            if (dayVol <= 0) continue;
            const perCandle = dayVol / candles.length;
            candles.forEach(ts => { volumeMap[ts] = perCandle; });
          }
          const candleDirS = {};
          if (lastCandleOHLC) lastCandleOHLC.forEach(c => { candleDirS[c.time] = c.close >= c.open; });
          volData = Object.entries(volumeMap)
            .map(([time, value]) => {
              const t = parseInt(time);
              const up = candleDirS[t] !== undefined ? candleDirS[t] : true;
              return { time: t, value, color: up ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)' };
            })
            .sort((a, b) => a.time - b.time);
        }
      if (volData.length > 0) {
        const lastOrigVol = volData[volData.length - 1].value;
        volData = _sqrtNormalizeVol(volData);
        volumeChartSeries.setData(volData);
        const volEl = document.getElementById('chartVolume');
        if (volEl) volEl.textContent = lastOrigVol >= 1e6 ? '$'+(lastOrigVol/1e6).toFixed(1)+'M' : lastOrigVol >= 1e3 ? '$'+(lastOrigVol/1e3).toFixed(1)+'K' : '$'+lastOrigVol.toFixed(0);
        return;
      }
    }
  } catch (e) { console.warn('long-history volume merge failed:', e); /* fallback to Curve volume API */ }

  // Fallback 2: Curve prices volume API (hourly granularity, works for old pools like 3pool)
  try {
    const fromIdxV = selectedFromToken ? selectedFromToken.index : 0;
    const toIdxV = selectedToToken ? selectedToToken.index : (pool.coinsAddresses.length > 1 ? 1 : 0);
    const mainTokenV = pool.coinsAddresses[fromIdxV] || pool.coinsAddresses[0];
    const refTokenV = pool.coinsAddresses[toIdxV] || pool.coinsAddresses[pool.coinsAddresses.length > 1 ? 1 : 0];
    const timeRangesV = { 1: 7*24, 4: 30*24 };
    const dayRangesV = { 1: 90*24, 7: 365*24 };
    const hoursBackV = currentUnit === 'day' ? (dayRangesV[currentAgg] || 90*24) : (timeRangesV[currentAgg] || 30*24);
    const startV = Math.floor(Date.now() / 1000) - hoursBackV * 3600;
    const endV = Math.floor(Date.now() / 1000);
    const volUrl = `${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${mainTokenV}&reference_token=${refTokenV}&start=${startV}&end=${endV}`;
    const volResp = await fetch(volUrl);
    if (volResp.ok) {
      const volJson = await volResp.json();
      const hourlyData = volJson.data || [];
      if (hourlyData.length > 0 && volumeChartSeries) {
        const candleTimestamps = lastCandleData || [];
        let volData;

        // Aggregate hourly volume into candle buckets
        const bucketMap = {};
        const intervalSec = currentUnit === 'day' ? currentAgg * 86400 : currentAgg * 3600;
        hourlyData.forEach(d => {
          let bucket;
          if (candleTimestamps.length > 0) {
            bucket = candleTimestamps[0];
            for (let i = candleTimestamps.length - 1; i >= 0; i--) {
              if (candleTimestamps[i] <= d.timestamp) { bucket = candleTimestamps[i]; break; }
            }
          } else {
            bucket = Math.floor(d.timestamp / intervalSec) * intervalSec;
          }
          if (!bucketMap[bucket]) bucketMap[bucket] = 0;
          bucketMap[bucket] += d.volume || 0;
        });

        // Build candle direction map for coloring
        const candleDir = {};
        if (lastCandleOHLC) lastCandleOHLC.forEach(c => { candleDir[c.time] = c.close >= c.open; });

        volData = Object.entries(bucketMap)
          .map(([time, value]) => {
            const t = parseInt(time);
            const up = candleDir[t] !== undefined ? candleDir[t] : true;
            return { time: t, value, color: up ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)' };
          })
          .sort((a, b) => a.time - b.time);

        if (volData.length > 0) {
          const lastOrigVol2 = volData[volData.length - 1].value;
          volData = _sqrtNormalizeVol(volData);
          volumeChartSeries.setData(volData);
          const volEl = document.getElementById('chartVolume');
          if (volEl) volEl.textContent = lastOrigVol2 >= 1e6 ? '$'+(lastOrigVol2/1e6).toFixed(1)+'M' : lastOrigVol2 >= 1e3 ? '$'+(lastOrigVol2/1e3).toFixed(1)+'K' : '$'+lastOrigVol2.toFixed(0);
          return;
        }
      }
    }
  } catch { /* fallback to Curve trades API */ }

  // Fallback 3: fetch from Curve prices trades API (limited to ~2000 trades)
  const fromIdx = selectedFromToken ? selectedFromToken.index : 0;
  const toIdx = selectedToToken ? selectedToToken.index : (pool.coinsAddresses.length > 1 ? 1 : 0);
  const mainToken = pool.coinsAddresses[fromIdx] || pool.coinsAddresses[0];
  const refToken = pool.coinsAddresses[toIdx] || pool.coinsAddresses[pool.coinsAddresses.length > 1 ? 1 : 0];
  const baseUrl = `${PRICES_BASE}/trades/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&per_page=100`;
  try {
    const batch1 = await Promise.all(
      Array.from({length: 10}, (_, i) => fetchJSON(`${baseUrl}&page=${i+1}`).catch(() => ({data:[]})))
    );
    let trades = batch1.flatMap(r => r.data || []);
    const lastBatchFull = batch1[9]?.data?.length === 100;
    if (lastBatchFull) {
      const batch2 = await Promise.all(
        Array.from({length: 10}, (_, i) => fetchJSON(`${baseUrl}&page=${i+11}`).catch(() => ({data:[]})))
      );
      trades = trades.concat(batch2.flatMap(r => r.data || []));
    }
    if (trades.length === 0 || !volumeChartSeries) return;
    const candleTimestamps = lastCandleData || [];
    const volumeMap = {};
    const intervalSec = currentUnit === 'day' ? currentAgg * 86400 : currentAgg * 3600;
    trades.forEach(t => {
      const ts = Math.floor(new Date(t.time + (t.time.includes('T') && !t.time.endsWith('Z') ? 'Z' : '')).getTime() / 1000);
      let bucket;
      if (candleTimestamps.length > 0) {
        bucket = candleTimestamps[0];
        for (let i = candleTimestamps.length - 1; i >= 0; i--) {
          if (candleTimestamps[i] <= ts) { bucket = candleTimestamps[i]; break; }
        }
      } else {
        bucket = Math.floor(ts / intervalSec) * intervalSec;
      }
      if (!volumeMap[bucket]) volumeMap[bucket] = { buy: 0, sell: 0 };
      const usd = ((t.tokens_sold_usd || 0) + (t.tokens_bought_usd || 0)) / 2;
      if (t.bought_id === 0) volumeMap[bucket].buy += usd;
      else volumeMap[bucket].sell += usd;
    });
    let volData3 = Object.entries(volumeMap)
      .map(([time, v]) => ({ time: parseInt(time), value: v.buy + v.sell, color: v.buy >= v.sell ? 'rgba(14,203,129,0.4)' : 'rgba(246,70,93,0.4)' }))
      .sort((a, b) => a.time - b.time);
    if (volData3.length > 0) {
      const lastOrigVol3 = volData3[volData3.length - 1].value;
      volData3 = _sqrtNormalizeVol(volData3);
      volumeChartSeries.setData(volData3);
      const volEl = document.getElementById('chartVolume');
      if (volEl) volEl.textContent = lastOrigVol3 >= 1e6 ? '$'+(lastOrigVol3/1e6).toFixed(1)+'M' : lastOrigVol3 >= 1e3 ? '$'+(lastOrigVol3/1e3).toFixed(1)+'K' : '$'+lastOrigVol3.toFixed(0);
    }
  } catch (e) { /* Volume is non-critical */ }
}


// ============================================================
// TRADE: Recent Activity (swaps + deposits + withdrawals)
// ============================================================
let _allRecentItems = [];
let _currentTradesFilter = 'all';

// Convert ISO timestamp from Curve API ("2026-04-28T22:02:23") to unix seconds
// for cross-source sorting. Numeric input passes through.
function _itemTs(t) {
  if (typeof t === 'number') return t;
  if (typeof t === 'string') {
    const ms = Date.parse(t.endsWith('Z') ? t : t + 'Z');
    return isFinite(ms) ? Math.floor(ms / 1000) : 0;
  }
  return 0;
}

function setTradesFilter(f) {
  _currentTradesFilter = f;
  document.querySelectorAll('.trades-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === f);
  });
  _renderTradesFiltered();
}

function _renderTradesFiltered() {
  const tbody = document.getElementById('tradesTbody');
  if (!tbody) return;
  const f = _currentTradesFilter;
  const filtered = _allRecentItems.filter(it => {
    if (f === 'all') return true;
    return it.kind === f;
  });
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:12px">No matching activity</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map(it => {
    // PRICE: number → fmtPrice, string (deposit/withdraw coin list) → as-is, null → '--'
    const priceCell = (typeof it.price === 'string')
      ? it.price
      : (it.price != null ? fmtPrice(it.price) : '--');
    // AMOUNT: number → 4 decimals (swap), array → compact join ("100+50"), null → '--'
    const amountCell = Array.isArray(it.amount)
      ? it.amount.map(_fmtAmtCompact).join('+')
      : (it.amount != null ? Number(it.amount).toFixed(4) : '--');
    return `<tr>
      <td>${fmtTime(it.time)}</td>
      <td class="${it.typeClass}">${it.type}</td>
      <td>${priceCell}</td>
      <td>${amountCell}</td>
      <td>${fmt$(it.usd || 0)}</td>
      <td><a href="${window.getExplorerTxUrl ? window.getExplorerTxUrl(it.tx) : ETHERSCAN + it.tx}" target="_blank" rel="noopener noreferrer" class="tx-link">${shortTx(it.tx)}</a></td>
    </tr>`;
  }).join('');
}

// Compact amount formatter for Recent Trades AMOUNT column (LP events).
// Returns short string: 1234567 → "1.23M", 123.45 → "123", 0.0042 → "0.0042".
function _fmtAmtCompact(v) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  if (n >= 1) return Math.round(n).toString();
  if (n >= 0.01) return n.toFixed(2);
  return n.toFixed(4);
}

async function loadTrades() {
  if (!selectedPool) return;
  const pool = selectedPool;
  const mainToken = pool.coinsAddresses[0];
  const refToken = pool.coinsAddresses.length > 1 ? pool.coinsAddresses[1] : pool.coinsAddresses[0];
  const tradesUrl = `${PRICES_BASE}/trades/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&per_page=50`;
  const lpUrl = `${PRICES_BASE}/liquidity/${getChainKey()}/${pool.address}?per_page=50`;

  const [tradesRes, lpRes] = await Promise.allSettled([
    fetchJSON(tradesUrl),
    fetchJSON(lpUrl),
  ]);

  const items = [];

  if (tradesRes.status === 'fulfilled') {
    for (const t of (tradesRes.value.data || [])) {
      const isBuy = t.bought_id === 0;
      items.push({
        kind: 'swap',
        type: isBuy ? 'Buy' : 'Sell',
        typeClass: isBuy ? 'trade-buy' : 'trade-sell',
        time: t.time,
        ts: _itemTs(t.time),
        tx: t.transaction_hash,
        price: t.price,
        amount: isBuy ? t.tokens_bought : t.tokens_sold,
        usd: ((t.tokens_sold_usd || 0) + (t.tokens_bought_usd || 0)) / 2,
      });
    }
  } else {
    console.error('Trades load error:', tradesRes.reason);
  }

  if (lpRes.status === 'fulfilled') {
    const lpEvents = lpRes.value.data || [];
    // Compute USD per event using cached coin prices. Fetch each unique coin
    // price once, then sum |amount[i]| * price[i] for the event.
    const uniqueCoins = [...new Set((pool.coinsAddresses || []).map(a => (a || '').toLowerCase()).filter(Boolean))];
    const priceMap = new Map();
    if (lpEvents.length > 0 && typeof _fetchUsdPrice === 'function') {
      const prices = await Promise.all(uniqueCoins.map(a => _fetchUsdPrice(a).catch(() => 0)));
      uniqueCoins.forEach((a, i) => priceMap.set(a, prices[i] || 0));
    }
    for (const e of lpEvents) {
      const isAdd = e.liquidity_event_type === 'AddLiquidity';
      const amounts = Array.isArray(e.token_amounts) ? e.token_amounts : [];
      let usd = 0;
      const movedSyms = [];
      const movedAmts = [];
      for (let i = 0; i < amounts.length; i++) {
        const v = Math.abs(amounts[i] || 0);
        const addr = (pool.coinsAddresses[i] || '').toLowerCase();
        const p = priceMap.get(addr) || 0;
        usd += v * p;
        if (v > 1e-9) {
          movedSyms.push((pool.coins && pool.coins[i]) || '?');
          movedAmts.push(v);
        }
      }
      items.push({
        kind: isAdd ? 'deposit' : 'withdraw',
        type: isAdd ? 'Deposit' : 'Withdraw',
        typeClass: isAdd ? 'trade-deposit' : 'trade-withdraw',
        time: e.time,
        ts: _itemTs(e.time),
        tx: e.transaction_hash,
        price: movedSyms.length ? movedSyms.join('+') : null,  // coins involved, e.g. "USDC+crvUSD"
        amount: movedAmts.length ? movedAmts : null,           // array of amounts in same order
        usd,
      });
    }
  } // 404 / network error: silently skip — keep swaps visible.

  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  _allRecentItems = items;
  _renderTradesFiltered();
}
window.setTradesFilter = setTradesFilter;


// ============================================================
// TRADE: Balances
// ============================================================
async function loadTradeBalances() {
  if (!walletAddress || !selectedPool || !provider) return;
  const section = document.getElementById('balancesSection');
  const list = document.getElementById('balancesList');
  // Build the index list deduped by lowercased address — the Curve API
  // occasionally returns the same token twice (e.g. RLUSD appears in both
  // coinsAddresses[i] and coinsAddresses[j] for some metapools, and the
  // _normalizeCoinArrays trim only drops zero-addr entries, not duplicates).
  // Keep first occurrence so selectedFromToken/selectedToToken indices stay
  // consistent with the original pool arrays.
  const seenAddr = new Set();
  const idxs = [];
  for (let i = 0; i < selectedPool.coinsAddresses.length; i++) {
    const a = (selectedPool.coinsAddresses[i] || '').toLowerCase();
    if (!a || seenAddr.has(a)) continue;
    seenAddr.add(a);
    idxs.push(i);
  }
  // Fetch all balances first (BigInt). Then decide whether to show the
  // section at all — if every balance is 0n we hide the heading entirely.
  const rows = await Promise.all(idxs.map(async (i) => {
    const addr = selectedPool.coinsAddresses[i];
    const symbol = selectedPool.coins[i] || 'Token';
    const decimals = parseInt(selectedPool.decimals[i]) || 18;
    try {
      let balance;
      if (addr.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
        balance = await provider.getBalance(walletAddress);
      } else {
        const contract = new ethers.Contract(addr, ERC20_ABI, provider);
        balance = await contract.balanceOf(walletAddress);
      }
      return { i, addr, symbol, decimals, balance, error: false };
    } catch (e) {
      return { i, addr, symbol, decimals, balance: 0n, error: true };
    }
  }));
  // Hide block when every (non-errored) balance is 0n. Errors don't count
  // as positive — better to hide than show a row of "Error".
  const hasAny = rows.some(r => !r.error && typeof r.balance === 'bigint' && r.balance > 0n);
  if (!hasAny) {
    section.style.display = 'none';
    list.innerHTML = '';
    // Still keep the from/to header balances in sync for the swap form.
    for (const r of rows) {
      if (r.error) continue;
      const display = parseFloat(ethers.formatUnits(r.balance, r.decimals)).toFixed(4);
      if (selectedFromToken && selectedFromToken.index === r.i) {
        fromBalanceRaw = r.balance;
        document.getElementById('fromBalance').textContent = `Balance: ${display}`;
      }
      if (selectedToToken && selectedToToken.index === r.i) {
        toBalanceRaw = r.balance;
        document.getElementById('toBalance').textContent = `Balance: ${display}`;
      }
    }
    return;
  }
  section.style.display = '';
  let html = '';
  for (const r of rows) {
    if (r.error) continue;
    const display = parseFloat(ethers.formatUnits(r.balance, r.decimals)).toFixed(4);
    // Sync from/to headers for ALL rows (including zeros) — needed by swap form.
    if (selectedFromToken && selectedFromToken.index === r.i) {
      fromBalanceRaw = r.balance;
      document.getElementById('fromBalance').textContent = `Balance: ${display}`;
    }
    if (selectedToToken && selectedToToken.index === r.i) {
      toBalanceRaw = r.balance;
      document.getElementById('toBalance').textContent = `Balance: ${display}`;
    }
    // Render in YOUR BALANCES list only for non-zero balances.
    if (r.balance <= 0n) continue;
    const iconHtml = _tokenIconInlineHtml('token-icon', r.addr, r.symbol);
    html += `<div class="balance-row">
      <div class="balance-token">${iconHtml}${r.symbol}</div>
      <div class="balance-amount">${display}</div>
    </div>`;
  }
  list.innerHTML = html;
}


// ============================================================
// TRADE: Swap Logic
// ============================================================
function swapDirection() {
  const tmp = selectedFromToken;
  selectedFromToken = selectedToToken;
  selectedToToken = tmp;
  if (selectedFromToken) {
    document.getElementById('fromTokenName').textContent = selectedFromToken.symbol;
    _setTokenIcon('fromTokenIcon', selectedFromToken.address, selectedFromToken.symbol);
  }
  if (selectedToToken) {
    document.getElementById('toTokenName').textContent = selectedToToken.symbol;
    _setTokenIcon('toTokenIcon', selectedToToken.address, selectedToToken.symbol);
  }
  const tmpBal = fromBalanceRaw;
  fromBalanceRaw = toBalanceRaw;
  toBalanceRaw = tmpBal;
  if (walletAddress && typeof ethers !== 'undefined') {
    document.getElementById('fromBalance').textContent = `Balance: ${ethers.formatUnits(fromBalanceRaw, selectedFromToken?.decimals || 18).slice(0, 10)}`;
    document.getElementById('toBalance').textContent = `Balance: ${ethers.formatUnits(toBalanceRaw, selectedToToken?.decimals || 18).slice(0, 10)}`;
  }
  document.getElementById('toAmount').value = '';
  const fromAmt = document.getElementById('fromAmount').value;
  if (fromAmt && parseFloat(fromAmt) > 0) getQuote();
  loadOHLC(); // reload chart for swapped pair
}

function setMaxFrom() {
  if (!selectedFromToken || fromBalanceRaw === 0n) return;
  document.getElementById('fromAmount').value = ethers.formatUnits(fromBalanceRaw, selectedFromToken.decimals);
  getQuote();
}

function setPreset(pct) {
  if (!selectedFromToken || fromBalanceRaw === 0n) return;
  const amount = (fromBalanceRaw * BigInt(Math.round(pct * 10000))) / 10000n;
  document.getElementById('fromAmount').value = ethers.formatUnits(amount, selectedFromToken.decimals);
  getQuote();
}

let tokenModalTarget = 'from';
function openTokenModal(target) {
  if (!selectedPool || selectedPool.coins.length === 0) return;
  tokenModalTarget = target;
  const list = document.getElementById('tokenModalList');
  list.innerHTML = selectedPool.coins.map((coin, i) => `
    <div class="token-modal-item" onclick="selectTokenFromModal(${i})">
      <div class="token-icon">${coin.slice(0, 2)}</div>
      <div><div class="token-name">${coin}</div><div class="token-addr">${shortAddr(selectedPool.coinsAddresses[i])}</div></div>
    </div>
  `).join('');
  document.getElementById('tokenModal').classList.add('show');
}

function closeTokenModal() { document.getElementById('tokenModal').classList.remove('show'); }

function selectTokenFromModal(index) {
  if (tokenModalTarget === 'from') {
    setFromToken(index);
    if (selectedToToken && selectedToToken.index === index) {
      const otherIdx = index === 0 ? 1 : 0;
      if (otherIdx < selectedPool.coins.length) setToToken(otherIdx);
    }
  } else {
    setToToken(index);
    if (selectedFromToken && selectedFromToken.index === index) {
      const otherIdx = index === 0 ? 1 : 0;
      if (otherIdx < selectedPool.coins.length) setFromToken(otherIdx);
    }
  }
  closeTokenModal();
  if (walletAddress) loadTradeBalances();
  const fromAmt = document.getElementById('fromAmount').value;
  if (fromAmt && parseFloat(fromAmt) > 0) getQuote();
  // Reload chart for new token pair
  loadOHLC();
}

document.getElementById('tokenModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('tokenModal')) closeTokenModal();
});

async function getQuote() {
  if (!selectedPool || !selectedFromToken || !selectedToToken) return;
  const fromAmt = document.getElementById('fromAmount').value;
  if (!fromAmt || parseFloat(fromAmt) <= 0) {
    document.getElementById('toAmount').value = '';
    document.getElementById('swapDetails').style.display = 'none';
    updateSwapButton();
    return;
  }
  await loadEthers();
  const dx = ethers.parseUnits(fromAmt, selectedFromToken.decimals);
  try {
    const iFrom = selectedFromToken.index, iTo = selectedToToken.index;
    let result;
    const iface128 = new ethers.Interface(['function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)']);
    const iface256 = new ethers.Interface(['function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)']);
    const _poolKey = selectedPool.address.toLowerCase();
    const _abi = _abiCache.get(_poolKey) || _initialAbiGuess(selectedPool);
    const _primaryIface = _abi === 'u256' ? iface256 : iface128;
    const _fallbackIface = _abi === 'u256' ? iface128 : iface256;
    const _fallbackKey = _abi === 'u256' ? 'i128' : 'u256';
    try {
      result = await rpcCall(_primaryIface.encodeFunctionData('get_dy', [iFrom, iTo, dx]), selectedPool.address);
      _abiCache.set(_poolKey, _abi);
    } catch (e1) {
      result = await rpcCall(_fallbackIface.encodeFunctionData('get_dy', [iFrom, iTo, dx]), selectedPool.address);
      _abiCache.set(_poolKey, _fallbackKey);
    }
    const dy = BigInt(result);
    const dyFormatted = ethers.formatUnits(dy, selectedToToken.decimals);
    document.getElementById('toAmount').value = parseFloat(dyFormatted).toFixed(6);
    document.getElementById('swapDetails').style.display = '';
    const rate = parseFloat(dyFormatted) / parseFloat(fromAmt);
    document.getElementById('swapRate').textContent = `1 ${selectedFromToken.symbol} = ${rate.toFixed(6)} ${selectedToToken.symbol}`;
    // Signed convention: NEGATIVE = user got less than 1:1 (slippage), POSITIVE = premium.
    const impact = (rate - 1) * 100;
    const impactEl = document.getElementById('swapImpact');
    if (Math.abs(impact) < 0.001) {
      impactEl.textContent = '<0.001%';
      impactEl.style.color = 'var(--green)';
    } else {
      const sign = impact > 0 ? '+' : '';
      impactEl.textContent = sign + impact.toFixed(3) + '%';
      impactEl.style.color = impact < 0 ? 'var(--red)' : 'var(--green)';
    }
    const minDy = parseFloat(dyFormatted) * (1 - slippage / 100);
    document.getElementById('swapMinReceived').textContent = `${minDy.toFixed(6)} ${selectedToToken.symbol}`;
    document.getElementById('swapFee').textContent = '--';
    updateSwapButton();
  } catch (e) {
    console.error('Quote error:', e);
    document.getElementById('toAmount').value = 'Error';
    document.getElementById('swapDetails').style.display = 'none';
    updateSwapButton();
  }
}

function updateSwapButton() {
  const btn = document.getElementById('swapSubmit');
  const fromAmt = document.getElementById('fromAmount').value;
  const toAmt = document.getElementById('toAmount').value;
  if (!walletAddress) { btn.textContent = 'Connect Wallet'; btn.className = 'swap-submit connect'; return; }
  if (!selectedPool) { btn.textContent = 'Select a Pool'; btn.className = 'swap-submit disabled'; return; }
  if (!fromAmt || parseFloat(fromAmt) <= 0) { btn.textContent = 'Enter Amount'; btn.className = 'swap-submit disabled'; return; }
  if (!toAmt || toAmt === 'Error') { btn.textContent = 'Invalid Quote'; btn.className = 'swap-submit disabled'; return; }
  btn.textContent = `Swap ${selectedFromToken?.symbol || ''} for ${selectedToToken?.symbol || ''}`;
  btn.className = 'swap-submit swap-ready';
}

async function handleSwapSubmit() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !selectedFromToken || !selectedToToken || !signer) return;
  const fromAmt = document.getElementById('fromAmount').value;
  if (!fromAmt || parseFloat(fromAmt) <= 0) return;
  const dx = ethers.parseUnits(fromAmt, selectedFromToken.decimals);
  const toAmt = document.getElementById('toAmount').value;
  if (!toAmt || toAmt === 'Error') return;
  const minDy = ethers.parseUnits(
    (parseFloat(toAmt) * (1 - slippage / 100)).toFixed(selectedToToken.decimals),
    selectedToToken.decimals
  );
  const btn = document.getElementById('swapSubmit');
  btn.textContent = 'Processing...';
  btn.className = 'swap-submit disabled';
  try {
    const isETH = selectedFromToken.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    if (!isETH) {
      const token = new ethers.Contract(selectedFromToken.address, ERC20_ABI, signer);
      const allowance = await token.allowance(walletAddress, selectedPool.address);
      if (allowance < dx) {
        btn.textContent = 'Approving...';
        const approveTx = await token.approve(selectedPool.address, ethers.MaxUint256);
        await approveTx.wait();
      }
    }
    btn.textContent = 'Swapping...';
    const isCrypto = ['crypto', 'factory-crypto', 'factory-twocrypto', 'factory-tricrypto'].includes(selectedPool.registryId);
    let tx;
    if (isCrypto) {
      const iface = new ethers.Interface(['function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)']);
      tx = await signer.sendTransaction({ to: selectedPool.address, data: iface.encodeFunctionData('exchange', [selectedFromToken.index, selectedToToken.index, dx, minDy]), value: isETH ? dx : 0n });
    } else {
      const iface = new ethers.Interface(['function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)']);
      tx = await signer.sendTransaction({ to: selectedPool.address, data: iface.encodeFunctionData('exchange', [selectedFromToken.index, selectedToToken.index, dx, minDy]), value: isETH ? dx : 0n });
    }
    btn.textContent = 'Confirming...';
    await tx.wait();
    btn.textContent = 'Swap Successful!';
    btn.className = 'swap-submit swap-ready';
    setTimeout(() => {
      document.getElementById('fromAmount').value = '';
      document.getElementById('toAmount').value = '';
      document.getElementById('swapDetails').style.display = 'none';
      updateSwapButton();
      loadTradeBalances();
    }, 2000);
  } catch (e) {
    console.error('Swap error:', e);
    btn.textContent = e.code === 'ACTION_REJECTED' ? 'Transaction Rejected' : 'Swap Failed';
    btn.className = 'swap-submit disabled';
    setTimeout(() => updateSwapButton(), 3000);
  }
}


// ============================================================
// TRADE SIMPLE SWAP
// ============================================================
let tradeTokenList = []; // [{symbol, address, decimals, poolAddresses:[]}]
let tradeTokenMap = new Map(); // symbol -> token info
let tradeBestPool = null;
let _tradeTokensPoolCount = 0; // guard: skip rebuild if pool data unchanged

function populateTradeTokens() {
  // Skip rebuild if pool data hasn't changed (same count = no cache refresh)
  if (tradeTokenList.length > 0 && allPools.length === _tradeTokensPoolCount) return;
  _tradeTokensPoolCount = allPools.length;
  const tokenMap = new Map(); // address -> {symbol, address, decimals, pools: Set}
  for (const pool of allPools) {
    if (!pool.coins || !pool.coinsAddresses) continue;
    for (let i = 0; i < pool.coins.length; i++) {
      const sym = pool.coins[i];
      const addr = (pool.coinsAddresses[i] || '').toLowerCase();
      if (!addr || !sym) continue;
      if (!tokenMap.has(addr)) {
        tokenMap.set(addr, { symbol: sym, address: addr, decimals: parseInt(pool.coinDecimals?.[i] || pool.decimals?.[i]) || 18, pools: new Set() });
      }
      tokenMap.get(addr).pools.add(pool.address.toLowerCase());
    }
  }
  tradeTokenList = [...tokenMap.values()].sort((a, b) => b.pools.size - a.pools.size);
  // Add ETH as alias for WETH (native ETH → WETH for Curve pools)
  const wethEntry = tokenMap.get('0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  if (wethEntry && !tokenMap.has('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')) {
    tradeTokenList.unshift({ symbol: 'ETH', address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 18, pools: wethEntry.pools, _isNativeETH: true, _wethAddress: wethEntry.address });
  }
  tradeTokenMap.clear();
  tradeTokenList.forEach(t => tradeTokenMap.set(t.symbol, t));

  const fromSel = document.getElementById('tradeFromToken');
  const toSel = document.getElementById('tradeToToken');
  fromSel.innerHTML = '';
  toSel.innerHTML = '';
  for (const t of tradeTokenList) {
    fromSel.add(new Option(t.symbol, t.address));
    toSel.add(new Option(t.symbol, t.address));
  }
  // Default: ETH -> USDC/USDT if available
  const ethToken = tradeTokenList.find(t => t.symbol === 'ETH' || t.symbol === 'WETH');
  const usdToken = tradeTokenList.find(t => t.symbol === 'USDC' || t.symbol === 'USDT' || t.symbol === 'crvUSD');
  if (ethToken) fromSel.value = ethToken.address;
  if (usdToken) toSel.value = usdToken.address;
  else if (tradeTokenList.length > 1) toSel.value = tradeTokenList[1].address;

  updateTradeRoute();
  // Build and render token sidebar
  buildTradeTokenData();
  renderTradeTokenSidebar();
}

// ============================================================
// TRADE TOKEN SIDEBAR
// ============================================================
let tradeTokenAggData = []; // [{symbol, address, decimals, liquidity, volume, change24h, poolsCount}]
let tradeTokenSortField = 'volume';
let tradeTokenSortDir = 1; // 1 = desc (b-a), -1 = asc (a-b)
let tradeTokenSearchQuery_ = '';
let _tradeTokenSearchTimer = null;

function buildTradeTokenData() {
  const tokenAgg = new Map(); // address -> aggregated data
  for (const pool of allPools) {
    if (!pool.coins || !pool.coinsAddresses) continue;
    const poolTvl = pool.tvl || 0;
    const poolVol = pool.volumeUSD || 0;
    const nCoins = pool.coins.length;
    const poolChg = pool._priceChange24h;
    for (let i = 0; i < nCoins; i++) {
      const sym = pool.coins[i];
      const addr = (pool.coinsAddresses[i] || '').toLowerCase();
      if (!addr || !sym) continue;
      if (!tokenAgg.has(addr)) {
        tokenAgg.set(addr, {
          symbol: sym,
          address: addr,
          decimals: parseInt(pool.coinDecimals?.[i] || pool.decimals?.[i]) || 18,
          liquidity: 0,
          volume: 0,
          change24h: null,
          _chgWeightSum: 0,
          _chgTvlSum: 0,
          poolsCount: 0,
          _pools: new Set()
        });
      }
      const t = tokenAgg.get(addr);
      t.liquidity += poolTvl / nCoins;
      t.volume += poolVol / nCoins;
      if (poolChg != null && poolTvl > 0) {
        t._chgWeightSum += poolChg * poolTvl;
        t._chgTvlSum += poolTvl;
      }
      if (!t._pools.has(pool.address)) {
        t._pools.add(pool.address);
        t.poolsCount++;
      }
    }
  }
  // Compute weighted-average 24h change per token
  for (const t of tokenAgg.values()) {
    t.change24h = t._chgTvlSum > 0 ? t._chgWeightSum / t._chgTvlSum : null;
  }
  // Add ETH alias
  const wethAddr = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const wethData = tokenAgg.get(wethAddr);
  const ethAddr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  if (wethData && !tokenAgg.has(ethAddr)) {
    tokenAgg.set(ethAddr, {
      symbol: 'ETH',
      address: ethAddr,
      decimals: 18,
      liquidity: wethData.liquidity,
      volume: wethData.volume,
      change24h: wethData.change24h,
      poolsCount: wethData.poolsCount,
      _isNativeETH: true
    });
  }
  tradeTokenAggData = [...tokenAgg.values()]
    .filter(t => t.address !== wethAddr || !tokenAgg.has(ethAddr)) // hide WETH if ETH exists
    .sort((a, b) => b.volume - a.volume);
}

function renderTradeTokenSidebar(sortBy, filter) {
  if (sortBy !== undefined) tradeTokenSortField = sortBy;
  if (filter !== undefined) tradeTokenSearchQuery_ = filter;

  const container = document.getElementById('tradeTokenListSidebar');
  if (!container) return;

  let tokens = [...tradeTokenAggData];

  // Filter by search
  const q = tradeTokenSearchQuery_.toLowerCase();
  if (q) {
    tokens = tokens.filter(t =>
      t.symbol.toLowerCase().includes(q) ||
      t.address.toLowerCase().includes(q)
    );
  }

  // Sort with direction
  const d = tradeTokenSortDir;
  switch (tradeTokenSortField) {
    case 'liquidity': tokens.sort((a, b) => d * (b.liquidity - a.liquidity)); break;
    case 'volume': tokens.sort((a, b) => d * (b.volume - a.volume)); break;
    case 'change': tokens.sort((a, b) => {
      const ca = a.change24h ?? -Infinity, cb = b.change24h ?? -Infinity;
      return d * (cb - ca);
    }); break;
    case 'pools': tokens.sort((a, b) => d * (b.poolsCount - a.poolsCount)); break;
  }

  const show = tokens.slice(0, 200);
  const activeAddr = tradeSelectedFrom ? tradeSelectedFrom.address.toLowerCase() : null;

  container.innerHTML = show.map(t => {
    const isActive = activeAddr === t.address.toLowerCase();
    const volText = _fmtTokenVal(t.volume);
    const chg = t.change24h;
    const chgClass = chg == null ? '' : chg > 0 ? 'high' : chg < 0 ? 'low' : 'medium';
    const chgText = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '--';
    const liqText = _fmtTokenVal(t.liquidity);

    const iconUrl = _tokenIconUrl(t.address);
    // Inline favorite star — stopPropagation so row-click selectTradeTokenFromSidebar
    // is not triggered when only the star is clicked.
    const isFavTok = (typeof window._isStarredToken === 'function') ? window._isStarredToken(t.address) : false;
    const favIcon = isFavTok
      ? `<svg class="icon icon--filled"><use href="#icon-star-filled"/></svg>`
      : `<svg class="icon"><use href="#icon-star-outline"/></svg>`;
    const favBtn = `<button class="pool-item-fav${isFavTok ? ' active' : ''}" type="button" title="${isFavTok ? 'Remove from Favorites' : 'Add to Favorites'}" onclick="event.stopPropagation(); window.toggleFavoriteTokenByAddr && window.toggleFavoriteTokenByAddr('${t.address}')" aria-label="Toggle favorite" aria-pressed="${isFavTok}">${favIcon}</button>`;
    return `<div class="pool-item${isActive ? ' active' : ''}" data-addr="${t.address}" onclick="selectTradeTokenFromSidebar('${t.address}')">
      ${favBtn}
      <div class="pool-item-info">
        <div class="pool-item-name" style="display:flex;align-items:center;gap:5px">
          <img class="token-icon" src="${iconUrl}" alt="" width="20" height="20" loading="lazy" onerror="this.style.display='none'">
          ${t.symbol}
        </div>
        <div class="pool-item-coins">${t.poolsCount} pool${t.poolsCount !== 1 ? 's' : ''}</div>
      </div>
      <div class="pool-item-tvl">${liqText}</div>
      <div class="pool-item-vol">${volText}</div>
      <div class="pool-item-apy ${chgClass}">${chgText}</div>
    </div>`;
  }).join('');

  // Update count
  const countEl = document.getElementById('tradeTokenCount');
  if (countEl) {
    countEl.textContent = `${tokens.length} tokens${tokens.length < tradeTokenAggData.length ? ` (filtered from ${tradeTokenAggData.length})` : ''}`;
  }
}

function _fmtTokenVal(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}

function selectTradeTokenFromSidebar(address) {
  const token = tradeTokenList.find(t => t.address.toLowerCase() === address.toLowerCase());
  if (!token) return;

  // Set as From token, keep current To
  if (tradeSelectedTo && tradeSelectedTo.address.toLowerCase() === address.toLowerCase()) {
    // If selecting same as To, swap them
    tradeSelectedTo = tradeSelectedFrom;
    if (tradeSelectedTo) updateTradeTokenUI('to', tradeSelectedTo);
  }
  tradeSelectedFrom = { symbol: token.symbol, address: token.address, decimals: token.decimals };
  updateTradeTokenUI('from', tradeSelectedFrom);
  onTradeTokensChanged();

  // Update active state in sidebar
  document.querySelectorAll('#tradeTokenListSidebar .pool-item').forEach(el => {
    el.classList.toggle('active', el.dataset.addr.toLowerCase() === address.toLowerCase());
  });

  // Auto-close mobile sidebar when token is selected
  if (window.innerWidth <= 1024 && typeof toggleMobileSidebar === 'function') {
    const sb = document.getElementById('tradeTokenSidebar');
    if (sb && sb.classList.contains('mobile-open')) toggleMobileSidebar(true);
  }
}

// Sort button handlers
document.addEventListener('DOMContentLoaded', () => {
  const sortContainer = document.getElementById('tradeTokenSort');
  if (sortContainer) {
    sortContainer.addEventListener('click', (e) => {
      const btn = e.target.closest('.sort-col');
      if (!btn) return;
      const newSort = btn.dataset.sort;
      if (newSort === tradeTokenSortField) {
        tradeTokenSortDir *= -1; // toggle direction
      } else {
        tradeTokenSortDir = 1; // new column → desc (b-a)
      }
      sortContainer.querySelectorAll('.sort-col').forEach(b => {
        b.classList.remove('active');
        const arrow = b.querySelector('.sort-arrow');
        if (arrow) arrow.textContent = '';
      });
      btn.classList.add('active');
      const arrow = btn.querySelector('.sort-arrow');
      if (arrow) arrow.innerHTML = `<svg class="icon icon--sm"><use href="#icon-chevron-${tradeTokenSortDir === 1 ? 'down' : 'up'}"/></svg>`;
      renderTradeTokenSidebar(newSort);
    });
  }

  const searchInput = document.getElementById('tradeTokenSearch');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(_tradeTokenSearchTimer);
      _tradeTokenSearchTimer = setTimeout(() => {
        renderTradeTokenSidebar(undefined, searchInput.value);
      }, 200);
    });
  }
});

// _tokenIconUrl — canonical chain-aware definition lives in app.js.  This
// file used to redefine it Ethereum-only, which silently overrode the
// chain-aware version because script load order is app.js → trade.js.  Keep
// the helper in one place.

// Adaptive price precision for candlestick series
// Stablecoins need 4-6 decimals, BTC needs 0-2
function _adaptCandlePrecision(series, candles, chart) {
  if (!series || !candles || candles.length === 0) return;
  let minP = Infinity, maxP = -Infinity;
  for (const c of candles) {
    if (c.high > maxP) maxP = c.high;
    if (c.low < minP) minP = c.low;
  }
  const range = maxP - minP;
  const mid = (maxP + minP) / 2;
  if (mid === 0) return;
  const relRange = range / mid;
  // On mobile cap precision to 4 to keep price scale narrow (avoid "1.000400" labels)
  const _isMob = (typeof window !== 'undefined') && window.innerWidth <= 768;
  // Choose precision based on relative range
  let precision, minMove;
  if (relRange < 0.001) { precision = _isMob ? 4 : 6; minMove = _isMob ? 0.0001 : 0.000001; }
  else if (relRange < 0.01) { precision = _isMob ? 4 : 5; minMove = _isMob ? 0.0001 : 0.00001; }
  else if (relRange < 0.1) { precision = 4; minMove = 0.0001; }
  else if (mid < 1) { precision = _isMob ? 4 : 6; minMove = _isMob ? 0.0001 : 0.000001; }
  else if (mid < 100) { precision = 4; minMove = 0.0001; }
  else { precision = 2; minMove = 0.01; }
  series.applyOptions({ priceFormat: { type: 'price', precision, minMove } });
  // For tight-range pairs (stablecoins), add margins so candles don't stretch to fill entire height
  if (chart && relRange < 0.005) {
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.2, bottom: 0.25 } });
  } else if (chart) {
    chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.25 } });
  }
  // Restore volume overlay margins after right-scale change
  if (chart) {
    try { if (volumeChartSeries) volumeChartSeries.priceScale().applyOptions({ scaleMargins: { top: 0.75, bottom: 0 }, autoScale: true }); } catch(e) {}
    try { if (tradePairVolumeSeries) tradePairVolumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.75, bottom: 0 }, autoScale: true }); } catch(e) {}
  }
}

// ROUTE CACHE — single source of truth for pathfinding results
// Avoids re-running BFS on every chart timeframe switch or quote refresh
const _routeCache = new Map(); // key: "from:to" → { pools, _bfsTokens, ts }
const ROUTE_CACHE_TTL = 5 * 60 * 1000; // 5 min

function getCachedRoute(fromAddr, toAddr) {
  const key = `${fromAddr}:${toAddr}`;
  const entry = _routeCache.get(key);
  if (entry && (Date.now() - entry.ts) < ROUTE_CACHE_TTL) return entry.route;
  _routeCache.delete(key);
  return null;
}

function setCachedRoute(fromAddr, toAddr, route) {
  const key = `${fromAddr}:${toAddr}`;
  _routeCache.set(key, { route, ts: Date.now() });
  // Cap cache size
  if (_routeCache.size > 100) {
    const oldest = _routeCache.keys().next().value;
    _routeCache.delete(oldest);
  }
}

function invalidateRouteCache() {
  _routeCache.clear();
}

function findBestPool(fromAddr, toAddr) {
  fromAddr = fromAddr.toLowerCase();
  toAddr = toAddr.toLowerCase();
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const _norm = a => {
    const l = a.toLowerCase();
    return (l === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || l === '0x0000000000000000000000000000000000000000') ? WETH : l;
  };
  let best = null;
  let bestTvl = 0;
  for (const pool of allPools) {
    if (!pool.coinsAddresses) continue;
    const addrs = pool.coinsAddresses.map(_norm);
    if (addrs.includes(fromAddr) && addrs.includes(toAddr)) {
      const tvl = pool.tvl || pool.usdTotal || 0;
      if (tvl > bestTvl) {
        bestTvl = tvl;
        best = pool;
      }
    }
  }
  // Don't return dead pools (TVL=0) — let BFS find multi-hop via liquid pools
  return (best && bestTvl > 0) ? best : null;
}

function updateTradeRoute() {
  const fromAddr = document.getElementById('tradeFromToken').value;
  const toAddr = document.getElementById('tradeToToken').value;
  const routeEl = document.getElementById('tradeRoute');
  const btn = document.getElementById('tradeExecBtn');

  if (!fromAddr || !toAddr || fromAddr === toAddr) {
    routeEl.innerHTML = 'Best route: <span>Select different tokens</span>';
    tradeBestPool = null;
    return;
  }

  tradeBestPool = findBestPool(fromAddr, toAddr);
  if (tradeBestPool) {
    const tvl = tradeBestPool.tvl >= 1e6 ? `$${(tradeBestPool.tvl / 1e6).toFixed(1)}M` : `$${(tradeBestPool.tvl / 1e3).toFixed(0)}K`;
    routeEl.innerHTML = `Best route: <span>${tradeBestPool.name}</span> (TVL: ${tvl})`;
  } else {
    // Try multi-hop: find intermediate tokens
    const multiRoute = findMultiHopRoute(fromAddr, toAddr);
    if (multiRoute) {
      const names = multiRoute.map(p => p.name).join(' → ');
      routeEl.innerHTML = `Best route: <span>${names}</span> (multi-hop)`;
      tradeBestPool = multiRoute; // store array for multi-hop
    } else {
      routeEl.innerHTML = 'Best route: <span>No direct pool found</span>';
      tradeBestPool = null;
    }
  }

  updateTradeExecButton();
  updateTradeEstimate();
}

// Cached BFS adjacency graph — rebuilt only when pool count changes
let _bfsAdj = null;
let _bfsPoolCount = 0;

function _getBfsAdj() {
  if (_bfsAdj && allPools.length === _bfsPoolCount) return _bfsAdj;
  const ZERO_ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const WETH_ADDR = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const adj = new Map();
  for (const pool of allPools) {
    if (!pool.coinsAddresses || (pool.tvl || pool.usdTotal || 0) <= 0) continue;
    const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
    const addrs = pool.coinsAddresses
      .filter(a => a.toLowerCase() !== ZERO_ADDR) // skip zero-padding in metapools
      .map(a => {
        const low = a.toLowerCase();
        return low === ZERO_ETH ? WETH_ADDR : low;
      });
    for (let i = 0; i < addrs.length; i++) {
      for (let j = i + 1; j < addrs.length; j++) {
        if (!adj.has(addrs[i])) adj.set(addrs[i], []);
        if (!adj.has(addrs[j])) adj.set(addrs[j], []);
        adj.get(addrs[i]).push({ token: addrs[j], pool });
        adj.get(addrs[j]).push({ token: addrs[i], pool });
      }
    }
  }
  _bfsAdj = adj;
  _bfsPoolCount = allPools.length;
  return adj;
}

function findMultiHopRoute(fromAddr, toAddr) {
  // BFS-based pathfinding: finds shortest route up to 5 hops
  // Returns array of pools [pool1, pool2, ...] or null
  fromAddr = fromAddr.toLowerCase();
  toAddr = toAddr.toLowerCase();
  if (fromAddr === toAddr) return null;

  // Check route cache first
  const cached = getCachedRoute(fromAddr, toAddr);
  if (cached) return cached;

  // Use cached adjacency graph (rebuilt only when pools change)
  const adj = _getBfsAdj();

  if (!adj.has(fromAddr) || !adj.has(toAddr)) return null;

  // BFS: find shortest path (max 5 hops)
  // Returns array of pools AND stores intermediate tokens in ._bfsTokens
  const MAX_HOPS = 5;
  const visited = new Set([fromAddr]);
  // queue entries: { token, path: [{pool, viaToken}] }
  let queue = [{ token: fromAddr, path: [] }];

  for (let depth = 0; depth < MAX_HOPS && queue.length > 0; depth++) {
    const nextQueue = [];
    for (const { token, path } of queue) {
      const edges = adj.get(token) || [];
      const sorted = [...edges].sort((a, b) => (b.pool.tvl || 0) - (a.pool.tvl || 0));
      for (const edge of sorted) {
        if (edge.token === toAddr) {
          const pools = [...path.map(p => p.pool), edge.pool];
          // Store the full token chain: [from, mid1, mid2, ..., to]
          pools._bfsTokens = [fromAddr, ...path.map(p => p.viaToken), toAddr];
          setCachedRoute(fromAddr, toAddr, pools);
          return pools;
        }
        if (!visited.has(edge.token)) {
          visited.add(edge.token);
          nextQueue.push({ token: edge.token, path: [...path, { pool: edge.pool, viaToken: edge.token }] });
        }
      }
    }
    queue = nextQueue;
  }
  return null; // no route found within 5 hops
}

function updateTradeEstimate() {
  const toInput = document.getElementById('tradeToAmount');
  const fromVal = parseFloat(document.getElementById('tradeFromAmount').value);
  if (!fromVal || !tradeBestPool) {
    toInput.value = '';
    return;
  }
  // For display purposes show an estimate based on pool price
  if (Array.isArray(tradeBestPool)) {
    toInput.value = '~' + fromVal.toFixed(4) + ' (est.)';
    return;
  }
  // Simple estimate: use the pool's virtual price as approximation
  // In real implementation, this would call get_dy on the contract
  toInput.value = '(connect wallet for quote)';
}

function updateTradeExecButton() {
  const btn = document.getElementById('tradeExecBtn');
  const fromVal = document.getElementById('tradeFromAmount').value;
  if (!walletAddress) {
    btn.textContent = 'Connect Wallet';
    btn.className = 'swap-submit connect';
    btn.onclick = connectWallet;
    return;
  }
  btn.onclick = executeTradeSwap;
  if (!tradeBestPool) {
    btn.textContent = 'No Route Found';
    btn.className = 'swap-submit disabled';
    return;
  }
  // Audit 2026-05-01 #10: toggle empty-amount hint inside swap details panel.
  const detailsEl = document.getElementById('tradePairSwapDetails');
  if (!fromVal || parseFloat(fromVal) <= 0) {
    btn.textContent = 'Enter Amount';
    btn.className = 'swap-submit disabled';
    if (detailsEl) detailsEl.classList.add('empty-amount');
    return;
  }
  if (detailsEl) detailsEl.classList.remove('empty-amount');
  btn.textContent = 'Swap';
  btn.className = 'swap-submit swap-ready';
}

function setTradeMax() {
  // Would read wallet balance for selected token
  // For now, placeholder
  console.log('MAX: requires wallet connection');
}

function swapTradeTokens() {
  const fromSel = document.getElementById('tradeFromToken');
  const toSel = document.getElementById('tradeToToken');
  const tmp = fromSel.value;
  fromSel.value = toSel.value;
  toSel.value = tmp;
  updateTradeRoute();
}

async function executeTradeSwap() {
  if (!walletAddress) { connectWallet(); return; }
  if (!tradeBestPool) { alert('No route available for this pair'); return; }

  const fromAddr = document.getElementById('tradeFromToken').value;
  const toAddr = document.getElementById('tradeToToken').value;
  const amount = document.getElementById('tradeFromAmount').value;
  const slippageInput = document.getElementById('tradeSlippage').value;
  const slippage = parseFloat(slippageInput) || 0.5;

  if (!amount || parseFloat(amount) <= 0) return;

  // Resolve from/to token metadata (decimals, symbol) from the available pool data.
  // For free-form swap we look up via allPools (token info lives there).
  function _findTokenMeta(addr) {
    const lc = (addr || '').toLowerCase();
    // Native ETH stored as 0xeeee...
    const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    if (lc === ETH) return { address: ETH, symbol: 'ETH', decimals: 18 };
    for (const pool of allPools) {
      if (!pool.coinsAddresses) continue;
      const idx = pool.coinsAddresses.findIndex(a => a.toLowerCase() === lc);
      if (idx !== -1) {
        return {
          address: addr,
          symbol: (pool.coins && pool.coins[idx]) || '?',
          decimals: (pool.decimals && pool.decimals[idx]) || 18,
        };
      }
    }
    return { address: addr, symbol: '?', decimals: 18 };
  }
  const fromTok = _findTokenMeta(fromAddr);
  const toTok = _findTokenMeta(toAddr);

  const btn = document.getElementById('tradeExecBtn');
  btn.textContent = 'Processing...';
  btn.className = 'swap-submit disabled';

  try {
    await loadEthers();
    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    const signer = await browserProvider.getSigner();
    const router = getTradeRouter();
    if (!router) throw new Error('Router not initialized');

    btn.textContent = 'Fetching quote...';
    const quote = await router.getQuote(
      fromAddr,
      toAddr,
      amount,
      fromTok.decimals,
      toTok.decimals,
      slippage,
      walletAddress
    );
    if (!quote) throw new Error('No route found for this pair');

    btn.textContent = 'Approving...';
    await router.ensureApproval(quote, walletAddress, signer);

    btn.textContent = 'Swapping...';
    const txParams = await router.buildSwapTx(quote, walletAddress);
    const tx = await signer.sendTransaction(txParams);

    btn.textContent = 'Confirming...';
    await tx.wait();

    btn.textContent = 'Swap Successful!';
    btn.className = 'swap-submit swap-ready';
    setTimeout(() => {
      const fromAmtEl = document.getElementById('tradeFromAmount');
      const toAmtEl = document.getElementById('tradeToAmount');
      if (fromAmtEl) fromAmtEl.value = '';
      if (toAmtEl) toAmtEl.value = '';
      updateTradeExecButton();
      if (typeof loadTradeBalances === 'function' && selectedPool) loadTradeBalances();
    }, 2000);
  } catch (e) {
    console.error('Trade swap error:', e);
    btn.textContent = e && e.code === 'ACTION_REJECTED' ? 'Transaction Rejected' : 'Swap Failed';
    btn.className = 'swap-submit disabled';
    setTimeout(() => updateTradeExecButton(), 3000);
  }
}

// Event listeners for trade simple
document.getElementById('tradeFromToken').addEventListener('change', updateTradeRoute);
document.getElementById('tradeToToken').addEventListener('change', updateTradeRoute);
document.getElementById('tradeFromAmount').addEventListener('input', () => {
  updateTradeExecButton();
  updateTradeEstimate();
});


// ============================================================
// TRADE VIEW: Token Pair System
// ============================================================
let tokenPairs = []; // [{base, quote, baseAddr, quoteAddr, pool, tvl, volume, priceChange}]
let selectedPair = null;
let tradePairChart = null;
let tradePairCandleSeries = null;
let tradePairVolumeSeries = null;
let tradePairLastCandles = null;
let tradePairAgg = 4;
let tradePairUnit = 'hour';
let tradePairSearchQuery = '';

let _tokenPairsPoolCount = 0; // guard: skip rebuild if pool data unchanged

function generateTokenPairs() {
  // Skip rebuild if pool data hasn't changed
  if (tokenPairs.length > 0 && allPools.length === _tokenPairsPoolCount) return;
  _tokenPairsPoolCount = allPools.length;
  const pairMap = new Map(); // "BASE/QUOTE" -> best pair data
  const stables = new Set(['USDC', 'USDT', 'DAI', 'crvUSD', 'FRAX', 'LUSD', 'TUSD', 'sUSD', 'USDD', 'GHO', 'PYUSD', 'USD0', 'eUSD', 'mkUSD', 'USDe']);
  const wethAliases = new Set(['ETH', 'WETH', 'stETH', 'wstETH', 'cbETH', 'rETH', 'frxETH', 'sfrxETH', 'weETH', 'ezETH']);

  for (const pool of allPools) {
    if (!pool.coins || pool.coins.length < 2 || !pool.coinsAddresses) continue;
    const tvl = pool.tvl || 0;
    if (tvl < 10000) continue; // Skip tiny pools

    // Generate pairs from pool coins
    for (let i = 0; i < pool.coins.length; i++) {
      for (let j = i + 1; j < pool.coins.length; j++) {
        let baseSym = pool.coins[i];
        let quoteSym = pool.coins[j];
        let baseAddr = (pool.coinsAddresses[i] || '').toLowerCase();
        let quoteAddr = (pool.coinsAddresses[j] || '').toLowerCase();

        // Normalize: quote should be the "denominator" (stablecoins, then WETH, etc.)
        const iIsStable = stables.has(baseSym);
        const jIsStable = stables.has(quoteSym);
        if (iIsStable && !jIsStable) {
          [baseSym, quoteSym] = [quoteSym, baseSym];
          [baseAddr, quoteAddr] = [quoteAddr, baseAddr];
        } else if (!iIsStable && !jIsStable) {
          // If both non-stable, prefer ETH-like as quote
          if (wethAliases.has(baseSym) && !wethAliases.has(quoteSym)) {
            [baseSym, quoteSym] = [quoteSym, baseSym];
            [baseAddr, quoteAddr] = [quoteAddr, baseAddr];
          }
        }

        const pairKey = `${baseSym}/${quoteSym}`;
        const existing = pairMap.get(pairKey);
        if (!existing || tvl > existing.tvl) {
          pairMap.set(pairKey, {
            name: pairKey,
            base: baseSym,
            quote: quoteSym,
            baseAddr,
            quoteAddr,
            pool: pool,
            poolAddr: pool.address,
            tvl,
            volume: pool.volumeUSD || 0,
            priceChange: pool._priceChange24h,
          });
        }
      }
    }
  }

  tokenPairs = [...pairMap.values()].sort((a, b) => b.tvl - a.tvl);
}

function renderTokenPairList() {
  const container = document.getElementById('pairList');
  if (!container) return;

  const query = tradePairSearchQuery.toLowerCase();
  let filtered = tokenPairs;
  if (query) {
    // Symmetric pair search: "A/B" and "B/A" return same result.
    // For slash-separated queries, every part must match either base or quote.
    const parts = query.split(/[\s/,-]+/).map(s => s.trim()).filter(Boolean);
    const isPair = parts.length >= 2;
    filtered = tokenPairs.filter(p => {
      const base = p.base.toLowerCase();
      const quote = p.quote.toLowerCase();
      if (isPair) {
        return parts.every(pt => base.includes(pt) || quote.includes(pt));
      }
      return p.name.toLowerCase().includes(query) ||
             base.includes(query) ||
             quote.includes(query);
    });
  }

  const show = filtered.slice(0, 200);
  const selectedKey = selectedPair ? selectedPair.name : null;

  container.innerHTML = show.map(p => {
    const isActive = p.name === selectedKey;
    const chg = p.priceChange;
    const chgClass = chg == null ? 'neutral' : chg > 0 ? 'up' : chg < 0 ? 'down' : 'neutral';
    const chgText = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : '--';
    const tvlText = p.tvl >= 1e6 ? '$' + (p.tvl / 1e6).toFixed(1) + 'M' :
                    p.tvl >= 1e3 ? '$' + (p.tvl / 1e3).toFixed(0) + 'K' : '$' + p.tvl.toFixed(0);
    const poolName = p.pool ? (p.pool.name || p.poolAddr.slice(0, 10)) : '--';

    return `<div class="pair-item${isActive ? ' active' : ''}" data-pair="${p.name}" onclick="selectTokenPair('${p.name}')">
      <div class="pair-item-info">
        <div class="pair-item-name">${p.base} / ${p.quote}</div>
        <div class="pair-item-pool">${poolName}</div>
      </div>
      <div class="pair-item-tvl">${tvlText}</div>
      <div class="pair-item-change ${chgClass}">${chgText}</div>
    </div>`;
  }).join('');

  const countEl = document.getElementById('pairCount');
  if (countEl) {
    countEl.textContent = `${filtered.length} pairs${filtered.length < tokenPairs.length ? ` (filtered from ${tokenPairs.length})` : ''}`;
  }
  // Refresh favorites sidebar (now that tokenPairs is populated).
  try { renderTradeFavorites(); } catch (e) { /* non-fatal */ }
}

async function selectTokenPair(pairName) {
  const pair = tokenPairs.find(p => p.name === pairName);
  if (!pair) return;

  selectedPair = pair;
  if (typeof toggleMobileSidebar === 'function') toggleMobileSidebar(true);

  // Sync tradeSelectedFrom/To for swap button and token modal
  const fromDec = pair.pool?.coinDecimals?.[pair.pool.coinsAddresses?.findIndex(a => a.toLowerCase() === pair.baseAddr)] || pair.pool?.decimals?.[0] || 18;
  const toDec = pair.pool?.coinDecimals?.[pair.pool.coinsAddresses?.findIndex(a => a.toLowerCase() === pair.quoteAddr)] || pair.pool?.decimals?.[1] || 18;
  tradeSelectedFrom = { symbol: pair.base, address: pair.baseAddr, decimals: fromDec };
  tradeSelectedTo = { symbol: pair.quote, address: pair.quoteAddr, decimals: toDec };
  updateTradeTokenUI('from', tradeSelectedFrom);
  updateTradeTokenUI('to', tradeSelectedTo);

  // Highlight in pair list
  document.querySelectorAll('.pair-item').forEach(el => {
    el.classList.toggle('active', el.dataset.pair === pairName);
  });

  // Update hash
  updateHash();

  // Update chart header
  const pairEl = document.getElementById('tradePairName');
  if (pairEl) pairEl.innerHTML = `<span class="pair-accent">${pair.base}</span> / <span>${pair.quote}</span>`;

  // Update swap panel tokens
  const fromName = document.getElementById('tradePairFromName');
  const toName = document.getElementById('tradePairToName');
  if (fromName) fromName.textContent = pair.base;
  if (toName) toName.textContent = pair.quote;
  _setTokenIcon('tradePairFromIcon', pair.baseAddr, pair.base);
  _setTokenIcon('tradePairToIcon', pair.quoteAddr, pair.quote);

  // Update pool info
  if (pair.pool) {
    const statsEl = document.getElementById('tradePairPoolStats');
    if (statsEl) statsEl.style.display = '';
    const pnEl = document.getElementById('tradePairPoolName');
    if (pnEl) pnEl.textContent = _shortPoolName(pair.pool.name) || pair.poolAddr.slice(0, 12);
    const tvlEl = document.getElementById('tradePairTvl');
    if (tvlEl) tvlEl.textContent = fmt$(pair.tvl);
    const volEl = document.getElementById('tradePairVolume');
    if (volEl) volEl.textContent = fmt$(pair.volume);
    const feesEl = document.getElementById('tradePairFees');
    if (feesEl) {
      const feePct = _poolFeePct(pair.pool);
      const rate = (feePct != null ? feePct : 0.04) / 100;
      feesEl.textContent = pair.volume > 0 ? '~' + fmt$(pair.volume * rate) : '--';
    }

    // Update route info
    // Audit 2026-05-01 #9: text was showing pool name "DAI/USDC/USDT" which
    // confusingly mimics route hops. Prefix with "via " for single-pool routes
    // to align with visual ROUTE block (source -> pool -> dest).
    const routeEl = document.getElementById('tradePairRouteInfo');
    if (routeEl) {
      const poolLabel = _shortPoolName(pair.pool.name) || pair.poolAddr.slice(0, 12);
      routeEl.textContent = `via ${poolLabel}`;
    }
  }

  // Init chart and load data
  initTradePairChart();
  try { updateTradeRichHeader(); } catch {}
  // Update active highlight in favorites sidebar
  try { renderTradeFavorites(); } catch {}
  await Promise.all([loadTradePairOHLC(), loadTradePairTrades()]);
  // After BFS chart render, probe swap router for a better path. If the router
  // picks a different (live-priced) route, the chart will re-render to match.
  _probeRouterRouteForChart();
}

function initTradePairChart() {
  const container = document.getElementById('trade-pair-chart-container');
  if (!container) return;
  // Wait for LightweightCharts to load (defer script race condition)
  if (typeof LightweightCharts === 'undefined') {
    setTimeout(initTradePairChart, 100);
    return;
  }
  // Wait for container to be visible (0-size container = no chart)
  if (container.clientWidth === 0 || container.clientHeight === 0) {
    setTimeout(initTradePairChart, 100);
    return;
  }
  container.innerHTML = '';

  const _isMobile = window.innerWidth <= 768;
  tradePairChart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#0b0e11' }, textColor: '#848e9c', fontSize: _isMobile ? 9 : 11 },
    grid: { vertLines: { color: '#1e2329' }, horzLines: { color: '#1e2329' } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#f0b90b33', width: 1, style: 0, labelBackgroundColor: '#f0b90b' },
      horzLine: { color: '#f0b90b33', width: 1, style: 0, labelBackgroundColor: '#f0b90b' },
    },
    rightPriceScale: { borderColor: '#2b3139', scaleMargins: { top: 0.1, bottom: 0.25 }, minimumWidth: _isMobile ? 48 : 70 },
    timeScale: { borderColor: '#2b3139', timeVisible: true, secondsVisible: false },
    handleScroll: { vertTouchDrag: true },
  });

  tradePairCandleSeries = tradePairChart.addCandlestickSeries({
    upColor: '#0ecb81', downColor: '#f6465d',
    borderUpColor: '#0ecb81', borderDownColor: '#f6465d',
    wickUpColor: '#0ecb81', wickDownColor: '#f6465d',
  });
  // Capture candles for rich header (24h H/L, abs change, USD price line)
  try {
    const _origSetData = tradePairCandleSeries.setData.bind(tradePairCandleSeries);
    tradePairCandleSeries.setData = function(data) {
      try {
        if (Array.isArray(data) && data.length > 0 && data[0].open != null) {
          window._tradeRichLastCandles = data;
          try { if (typeof updateTradeRichHeader === 'function') updateTradeRichHeader(); } catch {}
        }
      } catch {}
      return _origSetData(data);
    };
  } catch {}

  tradePairVolumeSeries = tradePairChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    lastValueVisible: false,
    priceLineVisible: false,
  });
  tradePairVolumeSeries.priceScale().applyOptions({
    scaleMargins: { top: 0.75, bottom: 0 },
    visible: false,
    autoScale: true,
  });

  const ro = new ResizeObserver(() => {
    tradePairChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
  ro.observe(container);
  tradePairChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });

  // OHLCV crosshair
  tradePairChart.subscribeCrosshairMove(param => {
    const oEl = document.getElementById('tcO');
    const hEl = document.getElementById('tcH');
    const lEl = document.getElementById('tcL');
    const cEl = document.getElementById('tcC');
    const volEl = document.getElementById('tradeChartVol');
    if (!param.seriesData) { if (volEl) volEl.textContent = '--'; return; }
    if (tradePairCandleSeries) {
      const cd = param.seriesData.get(tradePairCandleSeries);
      if (cd && cd.open != null) {
        if (oEl) oEl.textContent = fmtPrice(cd.open);
        if (hEl) hEl.textContent = fmtPrice(cd.high);
        if (lEl) lEl.textContent = fmtPrice(cd.low);
        if (cEl) cEl.textContent = fmtPrice(cd.close);
      }
    }
    if (tradePairVolumeSeries && volEl) {
      const vd = param.seriesData.get(tradePairVolumeSeries);
      if (vd && vd.value != null) {
        volEl.textContent = vd.value >= 1e6 ? '$'+(vd.value/1e6).toFixed(1)+'M' : vd.value >= 1e3 ? '$'+(vd.value/1e3).toFixed(1)+'K' : '$'+vd.value.toFixed(0);
      } else { volEl.textContent = '--'; }
    }
  });
}

// Helper: load OHLC from a pool using its first two coins (proxy/fallback chart)
async function _loadProxyPoolOHLC(pool) {
  if (!pool || !pool.coinsAddresses || pool.coinsAddresses.length < 2) return null;
  const timeRanges = { 1: 7*24, 4: 30*24 };
  const dayRanges = { 1: 90*24, 7: 365*24 };
  const hoursBack = tradePairUnit === 'day' ? (dayRanges[tradePairAgg] || 90*24) : (timeRanges[tradePairAgg] || 30*24);
  const start = Math.floor(Date.now() / 1000) - hoursBack * 3600;
  const end = Math.floor(Date.now() / 1000);
  const mainToken = pool.coinsAddresses[0];
  const refToken = pool.coinsAddresses[1];
  const url = `${PRICES_BASE}/ohlc/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&agg_number=${tradePairAgg}&agg_units=${tradePairUnit}&start=${start}&end=${end}`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const json = await resp.json();
    const roundTime = tradePairUnit === 'day' ? (t => Math.floor(t / 86400) * 86400) : (t => t);
    const seen = new Set();
    return (json.data || []).map(d => ({
      time: roundTime(d.time), open: d.open, high: d.high, low: d.low, close: d.close,
    })).filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
  } catch (e) {
    console.warn('Proxy pool OHLC error:', e);
    return null;
  }
}

async function loadTradePairOHLC() {
  if (!selectedPair || !selectedPair.pool) return;
  // Low TVL direct pools give unreliable OHLC — try synthetic if available
  if (!selectedPair._multiRoute && selectedPair.pool && (selectedPair.pool.tvl || 0) < 50000) {
    const synRoute = findMultiHopRoute(selectedPair.baseAddr, selectedPair.quoteAddr);
    // Only use synthetic if found AND min TVL of hops > direct pool TVL
    if (synRoute && synRoute.length >= 2) {
      const synMinTvl = Math.min(...synRoute.map(p => p.tvl || 0));
      if (synMinTvl > (selectedPair.pool.tvl || 0)) {
        selectedPair._multiRoute = synRoute;
      }
    }
  }
  // Multi-hop: synthetic OHLC from N hops (2 or 3)
  if (selectedPair._multiRoute) {
    const route = selectedPair._multiRoute;
    // Use BFS token chain if available, otherwise discover intermediates
    let tokens;
    let midFailed = false;
    if (route._bfsTokens && route._bfsTokens.length === route.length + 1) {
      tokens = route._bfsTokens;
    } else {
      tokens = [selectedPair.baseAddr];
      for (let i = 0; i < route.length - 1; i++) {
        const _norm = a => { const l = a.toLowerCase(); return (l === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || l === '0x0000000000000000000000000000000000000000') ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : l; };
        const addrsA = route[i].coinsAddresses.map(_norm);
        const addrsB = route[i + 1].coinsAddresses.map(_norm);
        const isLastHop = (i === route.length - 2);
        const mid = addrsA.find(a => addrsB.includes(a) && !tokens.includes(a) && (isLastHop ? a !== selectedPair.quoteAddr : true));
        if (!mid) {
          console.warn('Synthetic OHLC: no intermediate found between pools', route[i].name, route[i+1].name);
          midFailed = true;
          break;
      }
        tokens.push(mid);
      }
      if (!midFailed) tokens.push(selectedPair.quoteAddr);
    }
    // tokens = [base, mid1, (mid2), quote]

    if (!midFailed && tokens.length >= 2) {

      const timeRanges = { 1: 7*24, 4: 30*24 };
      const dayRanges = { 1: 90*24, 7: 365*24 };
      const hoursBack = tradePairUnit === 'day' ? (dayRanges[tradePairAgg] || 90*24) : (timeRanges[tradePairAgg] || 30*24);
      const start = Math.floor(Date.now() / 1000) - hoursBack * 3600;
      const end = Math.floor(Date.now() / 1000);

      // Build OHLC URLs for each hop
      // _bfsTokens are WETH-normalized, but pool.coinsAddresses may contain native ETH (0xeee...)
      // We need to find the original pool address that matches each normalized token
      const _ohlcNorm = a => {
        const l = a.toLowerCase();
        return (l === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || l === '0x0000000000000000000000000000000000000000')
          ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : l;
      };
      const urls = [];
      let urlBuildFailed = false;
      for (let i = 0; i < route.length; i++) {
        const rawAddrs = route[i].coinsAddresses;
        const normAddrs = rawAddrs.map(_ohlcNorm);
        const fromTok = tokens[i];
        const toTok = tokens[i + 1];
        // API: price = ref/main. To get fromTok priced in toTok: main=toTok, ref=fromTok
        const mainIdx = normAddrs.indexOf(toTok);
        const refIdx = normAddrs.indexOf(fromTok);
        if (mainIdx < 0 || refIdx < 0) {
          console.warn('Synthetic OHLC: token not in pool coins', route[i].name, fromTok, toTok);
          urlBuildFailed = true;
          break;
        }
        // Use ORIGINAL (un-normalized) addresses for the API — it expects the pool's actual coin addresses
        let mainAddr = rawAddrs[mainIdx];
        let refAddr = rawAddrs[refIdx];
        // Zero-padding in metapools → use WETH address for ETH, or skip if truly unused
        const ZERO = '0x0000000000000000000000000000000000000000';
        if (mainAddr.toLowerCase() === ZERO) mainAddr = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
        if (refAddr.toLowerCase() === ZERO) refAddr = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
        urls.push(`${PRICES_BASE}/ohlc/${getChainKey()}/${route[i].address}?main_token=${mainAddr}&reference_token=${refAddr}&agg_number=${tradePairAgg}&agg_units=${tradePairUnit}&start=${start}&end=${end}`);
      }

      if (!urlBuildFailed) {
        // Check OHLC cache for this synthetic route + timeframe
        const _synCacheKey = `syn_${route.map(p=>p.address).join('_')}_${tradePairAgg}_${tradePairUnit}`;
        const _synCached = _getOhlcCached(_synCacheKey);
        if (_synCached) {
          // Reuse cached synthetic candles
          if (_synCached.length > 0 && tradePairCandleSeries) {
            tradePairCandleSeries.setData(_synCached);
            _adaptCandlePrecision(tradePairCandleSeries, _synCached, tradePairChart);
            tradePairLastCandles = _synCached.map(c => c.time);
            const last = _synCached[_synCached.length - 1];
            const first = _synCached[0];
            const priceEl = document.getElementById('tradeChartPrice');
            if (priceEl) { priceEl.textContent = fmtPrice(last.close); priceEl.style.color = last.close >= first.open ? 'var(--green)' : 'var(--red)'; }
            loadTradePairVolume();
            return;
          }
        }
        try {
          // Use fetchJSON (has 30s built-in cache) instead of raw fetch
          const jsons = await Promise.all(urls.map(u => fetchJSON(u)));
          const roundTime = tradePairUnit === 'day' ? (t => Math.floor(t / 86400) * 86400) : (t => t);

          // Build time->candle maps for each hop
          const maps = jsons.map(json => {
            const m = new Map();
            for (const d of (json.data || [])) {
              const t = roundTime(d.time);
              if (!m.has(t)) m.set(t, d);
            }
            return m;
          });

          // Merge: synthetic price = product of all hops
          const candles = [];
          const seen = new Set();
          for (const t of maps[0].keys()) {
            if (seen.has(t)) continue;
            seen.add(t);
            // All hops must have data for this timestamp
            const cs = maps.map(m => m.get(t));
            if (cs.some(c => !c)) continue;
            candles.push({
              time: t,
              open: cs.reduce((acc, c) => acc * c.open, 1),
              high: cs.reduce((acc, c) => acc * c.high, 1),
              low: cs.reduce((acc, c) => acc * c.low, 1),
              close: cs.reduce((acc, c) => acc * c.close, 1),
            });
          }
          candles.sort((a, b) => a.time - b.time);

          if (candles.length > 0) {
            // Cache the synthetic candles for timeframe toggle
            _setOhlcCache(_synCacheKey, candles);
            if (tradePairCandleSeries) {
              tradePairCandleSeries.setData(candles);
              _adaptCandlePrecision(tradePairCandleSeries, candles, tradePairChart);
              tradePairLastCandles = candles.map(c => c.time);
              // Show chart source label
              const srcLabel = document.getElementById('chartSourceLabel');
              if (srcLabel) {
                const tokenSyms = tokens.map(t => {
                  for (const p of allPools) {
                    const idx = (p.coinsAddresses || []).findIndex(a => a.toLowerCase() === t);
                    if (idx >= 0 && p.coins) return p.coins[idx];
                  }
                  return t.slice(0, 6);
                });
                srcLabel.textContent = 'Chart: synthetic via ' + tokenSyms.join(' \u2192 ');
              }
              const last = candles[candles.length - 1];
              const first = candles[0];
              const priceEl = document.getElementById('tradeChartPrice');
              if (priceEl) {
                priceEl.textContent = fmtPrice(last.close);
                priceEl.style.color = last.close >= first.open ? 'var(--green)' : 'var(--red)';
              }
              const changeEl = document.getElementById('tradeChartChange');
              if (changeEl) {
                const prev = candles.length >= 2 ? candles[candles.length - 2] : first;
                const changePct = ((last.close - prev.open) / prev.open * 100);
                changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
                changeEl.className = 'chart-change ' + (changePct >= 0 ? 'up' : 'down');
              }
              const rateEl = document.getElementById('tradePairRate');
              if (rateEl) rateEl.textContent = `1 ${selectedPair.base} = ${fmtPrice(last.close)} ${selectedPair.quote}`;
              const detailsEl = document.getElementById('tradePairSwapDetails');
              if (detailsEl) detailsEl.style.display = '';
            }
            loadTradePairVolume();
            return; // synthetic succeeded
          }
          // candles empty — fall through to proxy chart
          console.warn('Synthetic OHLC: no overlapping candles across hops');
        } catch (e) {
          console.error('Synthetic OHLC error:', e);
        }
      }
    }

    // Synthetic failed — fallback: show proxy chart from the highest-TVL pool in the route
    const proxyPool = [...route].sort((a, b) => (b.tvl || 0) - (a.tvl || 0))[0];
    if (proxyPool && proxyPool.coinsAddresses && proxyPool.coinsAddresses.length >= 2) {
      const proxyCandles = await _loadProxyPoolOHLC(proxyPool);
      if (proxyCandles && proxyCandles.length > 0 && tradePairCandleSeries) {
        tradePairCandleSeries.setData(proxyCandles);
        _adaptCandlePrecision(tradePairCandleSeries, proxyCandles, tradePairChart);
        tradePairLastCandles = proxyCandles.map(c => c.time);
        const srcLabel = document.getElementById('chartSourceLabel');
        if (srcLabel) {
          const coins = (proxyPool.coins || []).slice(0, 2).join('/');
          srcLabel.textContent = 'Chart: ' + coins + ' pool (approximate for ' + selectedPair.base + '/' + selectedPair.quote + ')';
        }
        const last = proxyCandles[proxyCandles.length - 1];
        const first = proxyCandles[0];
        const priceEl = document.getElementById('tradeChartPrice');
        if (priceEl) {
          priceEl.textContent = fmtPrice(last.close);
          priceEl.style.color = last.close >= first.open ? 'var(--green)' : 'var(--red)';
        }
        const changeEl = document.getElementById('tradeChartChange');
        if (changeEl) {
          const prev = proxyCandles.length >= 2 ? proxyCandles[proxyCandles.length - 2] : first;
          const changePct = ((last.close - prev.open) / prev.open * 100);
          changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
          changeEl.className = 'chart-change ' + (changePct >= 0 ? 'up' : 'down');
        }
        loadTradePairVolume();
        return;
      }
    }
    // All fallbacks failed — keep canvas if it was already drawn so a later
    // router-probe re-render can still populate it via setData().
    if (!tradePairCandleSeries) {
      const chartContainer = document.getElementById('trade-pair-chart-container');
      if (chartContainer) chartContainer.innerHTML = '<div class="loading-center">No chart data for ' + selectedPair.base + '/' + selectedPair.quote + '</div>';
    }
    loadTradePairVolume();
    return;
  }
  const pool = selectedPair.pool;
  // API semantics: price = reference_token / main_token
  // To show "cbBTC priced in crvUSD" (~68000), we need main=crvUSD, ref=cbBTC
  // So: main_token = QUOTE token, reference_token = BASE token
  const coinAddrs = pool.coinsAddresses.map(a => a.toLowerCase());
  const baseIdx = coinAddrs.indexOf(selectedPair.baseAddr);
  const quoteIdx = coinAddrs.indexOf(selectedPair.quoteAddr);
  if (baseIdx < 0 || quoteIdx < 0) {
    // Base/quote not directly in pool coins (metapool underlyings, or pair
    // routed through a multi-hop pool whose first leg only contains one of
    // the two tokens — e.g. scrvUSD/crvUSD where the picked pool is
    // scrvUSD/sUSDe). Prefer BFS synthetic over the proxy chart, since
    // synthetic gives the correct cross-rate; proxy is the last-resort fallback.
    if (!selectedPair._multiRoute) {
      const synRoute = findMultiHopRoute(selectedPair.baseAddr, selectedPair.quoteAddr);
      if (synRoute && synRoute.length >= 2) {
        selectedPair._multiRoute = synRoute;
        console.log('OHLC: pool coins missing for ' + selectedPair.base + '/' + selectedPair.quote + ', falling back to synthetic via', synRoute.map(p => p.name).join(' -> '));
        return loadTradePairOHLC(); // re-enter through synthetic branch
      }
    }
    // No synthetic route — try proxy chart (legacy fallback)
    const proxyCandles = await _loadProxyPoolOHLC(pool);
    if (proxyCandles && proxyCandles.length > 0 && tradePairCandleSeries) {
      tradePairCandleSeries.setData(proxyCandles);
      _adaptCandlePrecision(tradePairCandleSeries, proxyCandles, tradePairChart);
      tradePairLastCandles = proxyCandles.map(c => c.time);
      const srcLabel = document.getElementById('chartSourceLabel');
      if (srcLabel) srcLabel.textContent = 'Chart: proxy from ' + _shortPoolName(pool.name || pool.address.slice(0, 12));
      const last = proxyCandles[proxyCandles.length - 1];
      const first = proxyCandles[0];
      const priceEl = document.getElementById('tradeChartPrice');
      if (priceEl) {
        priceEl.textContent = fmtPrice(last.close);
        priceEl.style.color = last.close >= first.open ? 'var(--green)' : 'var(--red)';
      }
      loadTradePairVolume();
    } else if (!tradePairCandleSeries) {
      // Only stomp the chart container if the canvas wasn't even created
      // (prevents clobbering a later router-probe re-render).
      const chartContainer = document.getElementById('trade-pair-chart-container');
      if (chartContainer) chartContainer.innerHTML = '<div class="loading-center">No chart data for ' + selectedPair.base + '/' + selectedPair.quote + '</div>';
    }
    return;
  }

  const mainToken = pool.coinsAddresses[quoteIdx]; // quote = denominator in API
  const refToken = pool.coinsAddresses[baseIdx];   // base = what we price

  const timeRanges = { 1: 7*24, 4: 30*24 };
  const dayRanges = { 1: 90*24, 7: 365*24 };
  const hoursBack = tradePairUnit === 'day' ? (dayRanges[tradePairAgg] || 90*24) : (timeRanges[tradePairAgg] || 30*24);
  const start = Math.floor(Date.now() / 1000) - hoursBack * 3600;
  const end = Math.floor(Date.now() / 1000);

  const url = `${PRICES_BASE}/ohlc/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&agg_number=${tradePairAgg}&agg_units=${tradePairUnit}&start=${start}&end=${end}`;
  const _directCacheKey = `${pool.address}_${mainToken}_${refToken}_${tradePairAgg}_${tradePairUnit}`;

  try {
    // Check OHLC cache first (60s TTL) — avoids re-fetch on timeframe toggle
    let json = _getOhlcCached(_directCacheKey);
    if (!json) {
      const resp = await fetch(url);
      if (!resp.ok) { console.warn(`Trade OHLC: ${resp.status}`); return; }
      json = await resp.json();
      _setOhlcCache(_directCacheKey, json);
    }
    const roundTime = tradePairUnit === 'day' ? (t => Math.floor(t / 86400) * 86400) : (t => t);
    const seen = new Set();
    const candles = (json.data || []).map(d => ({
      time: roundTime(d.time), open: d.open, high: d.high, low: d.low, close: d.close,
    })).filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });

    if (candles.length === 0) {
      // Direct pool returned no OHLC (e.g. scrvUSD/crvUSD: pool exists but
      // lacks the (main, ref) ordering or has near-zero realised trades for
      // this token pair). Before giving up, try BFS synthetic via multi-hop.
      // 2026-04-30: scrvUSD/crvUSD was a "synthetic-only" pair where the
      // selected high-TVL pool didn't include either token directly; we
      // would fall through here and clobber the chart canvas with the
      // "No chart data" string, blocking the later router-probe re-render.
      if (!selectedPair._multiRoute) {
        const synRoute = findMultiHopRoute(selectedPair.baseAddr, selectedPair.quoteAddr);
        if (synRoute && synRoute.length >= 2) {
          selectedPair._multiRoute = synRoute;
          console.log('OHLC: direct pool empty for ' + selectedPair.base + '/' + selectedPair.quote + ', falling back to synthetic via', synRoute.map(p => p.name).join(' -> '));
          return loadTradePairOHLC(); // re-enter through synthetic branch
        }
      }
      // Truly no data and no synthetic route — show fallback message.
      // Keep the canvas DOM intact so a later router-probe re-render can still
      // populate it via tradePairCandleSeries.setData().
      const chartContainer = document.getElementById('trade-pair-chart-container');
      if (chartContainer && !tradePairCandleSeries) {
        chartContainer.innerHTML = '<div class="loading-center">No chart data for this pool</div>';
      }
      return;
    }
    // Note: flat data detection removed — stablecoin pairs naturally have <0.1% variance
    if (candles.length > 0 && tradePairCandleSeries) {
      tradePairCandleSeries.setData(candles);
      _adaptCandlePrecision(tradePairCandleSeries, candles, tradePairChart);
      tradePairLastCandles = candles.map(c => c.time);
      // Show chart source label
      const srcLabel = document.getElementById('chartSourceLabel');
      if (srcLabel) srcLabel.textContent = 'Chart: pool ' + _shortPoolName(pool.name || pool.address.slice(0, 12));
      const last = candles[candles.length - 1];
      const first = candles[0];
      const priceEl = document.getElementById('tradeChartPrice');
      if (priceEl) {
        priceEl.textContent = fmtPrice(last.close);
        priceEl.style.color = last.close >= first.open ? 'var(--green)' : 'var(--red)';
      }
      const changeEl = document.getElementById('tradeChartChange');
      if (changeEl) {
        const prev = candles.length >= 2 ? candles[candles.length - 2] : first;
        const changePct = ((last.close - prev.open) / prev.open * 100);
        changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
        changeEl.className = 'chart-change ' + (changePct >= 0 ? 'up' : 'down');
      }

      // Update rate in swap panel
      const rateEl = document.getElementById('tradePairRate');
      if (rateEl) rateEl.textContent = `1 ${selectedPair.base} = ${fmtPrice(last.close)} ${selectedPair.quote}`;
      const detailsEl = document.getElementById('tradePairSwapDetails');
      if (detailsEl) detailsEl.style.display = '';
    }
  } catch (e) {
    console.error('Trade pair OHLC error:', e);
  }

  // Load volume
  loadTradePairVolume();
}

async function loadTradePairVolume() {
  if (!selectedPair || !selectedPair.pool) return;
  const pool = selectedPair.pool;

  // Recreate histogram series to avoid stale scale state
  if (tradePairVolumeSeries && tradePairChart) {
    try { tradePairChart.removeSeries(tradePairVolumeSeries); } catch(e) {}
    tradePairVolumeSeries = tradePairChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    });
    tradePairVolumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
      visible: false,
      autoScale: true,
    });
  }

  const coinAddrs = pool.coinsAddresses.map(a => a.toLowerCase());
  const baseIdx = coinAddrs.indexOf(selectedPair.baseAddr);
  const quoteIdx = coinAddrs.indexOf(selectedPair.quoteAddr);
  if (baseIdx < 0 || quoteIdx < 0) return;

  const mainToken = pool.coinsAddresses[baseIdx];
  const refToken = pool.coinsAddresses[quoteIdx];

  // Try Curve volume API first (hourly, works for old pools like 3pool)
  try {
    const timeRangesTP = { 1: 7*24, 4: 30*24 };
    const dayRangesTP = { 1: 90*24, 7: 365*24 };
    const hoursBackTP = tradePairUnit === 'day' ? (dayRangesTP[tradePairAgg] || 90*24) : (timeRangesTP[tradePairAgg] || 30*24);
    const startTP = Math.floor(Date.now() / 1000) - hoursBackTP * 3600;
    const endTP = Math.floor(Date.now() / 1000);
    const volUrlTP = `${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&start=${startTP}&end=${endTP}`;
    const volRespTP = await fetch(volUrlTP);
    if (volRespTP.ok) {
      const volJsonTP = await volRespTP.json();
      const hourlyTP = volJsonTP.data || [];
      if (hourlyTP.length > 0 && tradePairVolumeSeries) {
        const candleTsTP = tradePairLastCandles || [];
        const intervalSecTP = tradePairUnit === 'day' ? tradePairAgg * 86400 : tradePairAgg * 3600;
        const bucketMapTP = {};
        hourlyTP.forEach(d => {
          let bucket;
          if (candleTsTP.length > 0) {
            bucket = candleTsTP[0];
            for (let i = candleTsTP.length - 1; i >= 0; i--) {
              if (candleTsTP[i] <= d.timestamp) { bucket = candleTsTP[i]; break; }
            }
          } else {
            bucket = Math.floor(d.timestamp / intervalSecTP) * intervalSecTP;
          }
          if (!bucketMapTP[bucket]) bucketMapTP[bucket] = 0;
          bucketMapTP[bucket] += d.volume || 0;
        });
        const candleDirTP = {};
        // No OHLC cache for trade pair view, default to green
        const volDataTP = Object.entries(bucketMapTP)
          .map(([time, value]) => {
            const t = parseInt(time);
            const up = candleDirTP[t] !== undefined ? candleDirTP[t] : true;
            return { time: t, value, color: up ? 'rgba(14,203,129,0.5)' : 'rgba(246,70,93,0.5)' };
          })
          .sort((a, b) => a.time - b.time);
        if (volDataTP.length > 0) {
          tradePairVolumeSeries.setData(volDataTP);
          const lastVolTP = volDataTP[volDataTP.length - 1].value;
          const volElTP = document.getElementById('tradeChartVol');
          if (volElTP) volElTP.textContent = lastVolTP >= 1e6 ? '$'+(lastVolTP/1e6).toFixed(1)+'M' : lastVolTP >= 1e3 ? '$'+(lastVolTP/1e3).toFixed(1)+'K' : '$'+lastVolTP.toFixed(0);
          return;
        }
      }
    }
  } catch { /* fallback to trades API */ }

  // Fallback: Curve trades API
  const baseUrl = `${PRICES_BASE}/trades/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&per_page=100`;

  try {
    const batch = await Promise.all(
      Array.from({length: 5}, (_, i) => fetchJSON(`${baseUrl}&page=${i+1}`).catch(() => ({data:[]})))
    );
    const trades = batch.flatMap(r => r.data || []);
    if (trades.length === 0 || !tradePairVolumeSeries) return;

    const candleTs = tradePairLastCandles || [];
    const volumeMap = {};
    if (candleTs.length > 0) {
      trades.forEach(t => {
        const ts = Math.floor(new Date(t.time + (t.time.includes('T') && !t.time.endsWith('Z') ? 'Z' : '')).getTime() / 1000);
        let bucket = candleTs[0];
        for (let i = candleTs.length - 1; i >= 0; i--) {
          if (candleTs[i] <= ts) { bucket = candleTs[i]; break; }
        }
        if (!volumeMap[bucket]) volumeMap[bucket] = { buy: 0, sell: 0 };
        const usd = ((t.tokens_sold_usd || 0) + (t.tokens_bought_usd || 0)) / 2;
        if (t.bought_id === 0) volumeMap[bucket].buy += usd;
        else volumeMap[bucket].sell += usd;
      });
    } else {
      const intervalSec = tradePairUnit === 'day' ? tradePairAgg * 86400 : tradePairAgg * 3600;
      trades.forEach(t => {
        const ts = Math.floor(new Date(t.time + (t.time.includes('T') && !t.time.endsWith('Z') ? 'Z' : '')).getTime() / 1000);
        const bucket = Math.floor(ts / intervalSec) * intervalSec;
        if (!volumeMap[bucket]) volumeMap[bucket] = { buy: 0, sell: 0 };
        const usd = ((t.tokens_sold_usd || 0) + (t.tokens_bought_usd || 0)) / 2;
        if (t.bought_id === 0) volumeMap[bucket].buy += usd;
        else volumeMap[bucket].sell += usd;
      });
    }
    const volData = Object.entries(volumeMap)
      .map(([time, v]) => ({
        time: parseInt(time),
        value: v.buy + v.sell,
        color: v.buy >= v.sell ? 'rgba(14,203,129,0.4)' : 'rgba(246,70,93,0.4)',
      }))
      .sort((a, b) => a.time - b.time);
    tradePairVolumeSeries.setData(volData);
    if (volData.length > 0) {
      const lastVol = volData[volData.length - 1].value;
      const volEl = document.getElementById('tradeChartVol');
      if (volEl) volEl.textContent = lastVol >= 1e6 ? '$'+(lastVol/1e6).toFixed(1)+'M' : lastVol >= 1e3 ? '$'+(lastVol/1e3).toFixed(1)+'K' : '$'+lastVol.toFixed(0);
    }
  } catch (e) { /* volume non-critical */ }
}

async function loadTradePairTrades() {
  if (!selectedPair || !selectedPair.pool) return;
  const pool = selectedPair.pool;
  const coinAddrs = pool.coinsAddresses.map(a => a.toLowerCase());
  const baseIdx = coinAddrs.indexOf(selectedPair.baseAddr);
  const quoteIdx = coinAddrs.indexOf(selectedPair.quoteAddr);
  if (baseIdx < 0 || quoteIdx < 0) return;

  const mainToken = pool.coinsAddresses[baseIdx];
  const refToken = pool.coinsAddresses[quoteIdx];
  const url = `${PRICES_BASE}/trades/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&per_page=50`;

  try {
    const json = await fetchJSON(url);
    const trades = json.data || [];
    const tbody = document.getElementById('tradePairTbody');
    if (!tbody) return;
    if (trades.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:12px">No recent trades</td></tr>';
      return;
    }
    tbody.innerHTML = trades.map(t => {
      const isBuy = t.bought_id === 0;
      const usd = ((t.tokens_sold_usd || 0) + (t.tokens_bought_usd || 0)) / 2;
      const side = isBuy ? 'Buy' : 'Sell';
      const sideClass = isBuy ? 'trade-buy' : 'trade-sell';
      const amount = isBuy ? t.tokens_bought : t.tokens_sold;
      return `<tr>
        <td>${fmtTime(t.time)}</td>
        <td class="${sideClass}">${side}</td>
        <td>${fmtPrice(t.price)}</td>
        <td>${amount ? amount.toFixed(4) : '--'}</td>
        <td>${fmt$(usd)}</td>
        <td><a href="${window.getExplorerTxUrl ? window.getExplorerTxUrl(t.transaction_hash) : ETHERSCAN + t.transaction_hash}" target="_blank" rel="noopener noreferrer" class="tx-link">${shortTx(t.transaction_hash)}</a></td>
      </tr>`;
    }).join('');
  } catch (e) {
    console.error('Trade pair trades error:', e);
  }
}

// Trade pair timeframe buttons
document.querySelectorAll('.trade-time-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.trade-time-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    tradePairAgg = parseInt(btn.dataset.agg);
    tradePairUnit = btn.dataset.unit;
    if (selectedPair) loadTradePairOHLC();
  });
});

// Trade pair button & balances (wallet-aware)
function updateTradePairButton() {
  const btn = document.getElementById('tradePairSubmit');
  // Audit 2026-05-01 #10: also toggle empty-amount hint inside swap details panel.
  const detailsEl = document.getElementById('tradePairSwapDetails');
  if (!btn) return;
  if (!walletAddress) {
    btn.textContent = 'Connect Wallet';
    btn.className = 'swap-submit connect';
    if (detailsEl) detailsEl.classList.add('empty-amount');
    return;
  }
  const fromAmt = document.getElementById('tradePairFromAmt')?.value;
  if (!selectedPair || !selectedPair.pool) {
    btn.textContent = 'Select a Pair';
    btn.className = 'swap-submit disabled';
    if (detailsEl) detailsEl.classList.add('empty-amount');
    return;
  }
  if (!fromAmt || parseFloat(fromAmt) <= 0) {
    btn.textContent = 'Enter Amount';
    btn.className = 'swap-submit disabled';
    if (detailsEl) detailsEl.classList.add('empty-amount');
    return;
  }
  if (detailsEl) detailsEl.classList.remove('empty-amount');
  btn.textContent = `Swap ${selectedPair.base} for ${selectedPair.quote}`;
  btn.className = 'swap-submit swap-ready';
}

async function loadTradePairBalances() {
  if (!walletAddress || !provider || !selectedPair) return;
  const fromToken = tradeSelectedFrom || (selectedPair ? { address: selectedPair.baseAddr, symbol: selectedPair.base } : null);
  const toToken = tradeSelectedTo || (selectedPair ? { address: selectedPair.quoteAddr, symbol: selectedPair.quote } : null);
  const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  for (const [token, elId] of [[fromToken, 'tradePairFromBal'], [toToken, 'tradePairToBal']]) {
    const el = document.getElementById(elId);
    if (!el || !token || !token.address) continue;
    try {
      let balance;
      if (token.address.toLowerCase() === ETH) {
        balance = await provider.getBalance(walletAddress);
      } else {
        const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
        balance = await contract.balanceOf(walletAddress);
      }
      const decimals = token.decimals || 18;
      const formatted = ethers.formatUnits(balance, decimals);
      el.textContent = 'Balance: ' + parseFloat(formatted).toFixed(4);
    } catch (e) {
      el.textContent = 'Balance: --';
    }
  }
}

// Trade pair swap functions
function swapTradePairDirection() {
  if (!selectedPair) return;
  // Find the reverse pair or just swap display
  const reverseName = `${selectedPair.quote}/${selectedPair.base}`;
  const reversePair = tokenPairs.find(p => p.name === reverseName);
  if (reversePair) {
    selectTokenPair(reverseName);
  } else {
    // Just swap the display tokens
    const tmp = { ...selectedPair };
    selectedPair.base = tmp.quote;
    selectedPair.quote = tmp.base;
    selectedPair.baseAddr = tmp.quoteAddr;
    selectedPair.quoteAddr = tmp.baseAddr;
    selectedPair.name = `${selectedPair.base}/${selectedPair.quote}`;
    // Re-update UI
    const pairEl = document.getElementById('tradePairName');
    if (pairEl) pairEl.innerHTML = `<span class="pair-accent">${selectedPair.base}</span> / <span>${selectedPair.quote}</span>`;
    const fromName = document.getElementById('tradePairFromName');
    const toName = document.getElementById('tradePairToName');
    if (fromName) fromName.textContent = selectedPair.base;
    if (toName) toName.textContent = selectedPair.quote;
    _setTokenIcon('tradePairFromIcon', selectedPair.baseAddr, selectedPair.base);
    _setTokenIcon('tradePairToIcon', selectedPair.quoteAddr, selectedPair.quote);
    loadTradePairOHLC();
  }
}

async function setTradePairMax() {
  if (!walletAddress || !provider) { connectWallet(); return; }
  const token = tradeSelectedFrom;
  if (!token || !token.address) return;
  try {
    const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    let balance;
    if (token.address.toLowerCase() === ETH) {
      balance = await provider.getBalance(walletAddress);
    } else {
      const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
      balance = await contract.balanceOf(walletAddress);
    }
    const decimals = token.decimals || 18;
    const formatted = ethers.formatUnits(balance, decimals);
    document.getElementById('tradePairFromAmt').value = formatted;
    document.getElementById('tradePairFromAmt').dispatchEvent(new Event('input'));
  } catch (e) {
    console.error('setTradePairMax error:', e);
  }
}

function setTradePairPreset(fraction) {
  if (!walletAddress || !provider) { connectWallet(); return; }
  const balEl = document.getElementById('tradePairFromBal');
  if (!balEl) return;
  const match = balEl.textContent.match(/[\d.]+/);
  if (!match) return;
  const bal = parseFloat(match[0]);
  if (bal <= 0) return;
  document.getElementById('tradePairFromAmt').value = (bal * fraction).toFixed(6);
  document.getElementById('tradePairFromAmt').dispatchEvent(new Event('input'));
}

async function handleTradePairSwap() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPair || !selectedPair.pool) { alert('No pair selected'); return; }

  const fromAmt = document.getElementById('tradePairFromAmt')?.value;
  if (!fromAmt || parseFloat(fromAmt) <= 0) { alert('Enter an amount first'); return; }

  const btn = document.getElementById('tradePairSubmit');
  btn.textContent = 'Processing...';
  btn.className = 'swap-submit disabled';

  try {
    await loadEthers();
    const browserProvider = new ethers.BrowserProvider(window.ethereum);
    const signer = await browserProvider.getSigner();
    const router = getTradeRouter();
    if (!router) throw new Error('Router not initialized');

    // Reuse the most recent quote if it matches the current input; otherwise re-quote.
    let quote = _lastTradeQuote;
    const sameInput = quote
      && tradeSelectedFrom && tradeSelectedTo
      && quote.fromToken && quote.toToken
      && quote.fromToken.toLowerCase() === tradeSelectedFrom.address.toLowerCase()
      && quote.toToken.toLowerCase() === tradeSelectedTo.address.toLowerCase()
      && String(quote.inputAmount) === String(fromAmt);

    if (!sameInput) {
      btn.textContent = 'Fetching quote...';
      const slippageBtn = document.querySelector('.trade-slip.active');
      const slippageCustom = document.getElementById('tradeSlippageCustom')?.value;
      const slippage = slippageCustom ? parseFloat(slippageCustom) : (slippageBtn ? parseFloat(slippageBtn.dataset.slip) : 0.5);
      quote = await router.getQuote(
        tradeSelectedFrom.address,
        tradeSelectedTo.address,
        fromAmt,
        tradeSelectedFrom.decimals,
        tradeSelectedTo.decimals,
        slippage,
        walletAddress
      );
      if (!quote) throw new Error('No route found for this pair');
      _lastTradeQuote = quote;
    }

    btn.textContent = 'Approving...';
    await router.ensureApproval(quote, walletAddress, signer);

    btn.textContent = 'Swapping...';
    const txParams = await router.buildSwapTx(quote, walletAddress);
    const tx = await signer.sendTransaction(txParams);

    btn.textContent = 'Confirming...';
    await tx.wait();

    btn.textContent = 'Swap Successful!';
    btn.className = 'swap-submit swap-ready';
    // Balances changed -> invalidate modal cache so next open re-fetches.
    if (typeof _resetWalletBalanceCache === 'function') _resetWalletBalanceCache();
    setTimeout(() => {
      const fromAmtEl = document.getElementById('tradePairFromAmt');
      const toAmtEl = document.getElementById('tradePairToAmt');
      if (fromAmtEl) fromAmtEl.value = '';
      if (toAmtEl) toAmtEl.value = '';
      _lastTradeQuote = null;
      updateTradePairButton();
      if (typeof loadTradePairBalances === 'function') loadTradePairBalances();
    }, 2000);
  } catch (e) {
    console.error('Trade pair swap error:', e);
    btn.textContent = e && e.code === 'ACTION_REJECTED' ? 'Transaction Rejected' : 'Swap Failed';
    btn.className = 'swap-submit disabled';
    setTimeout(() => updateTradePairButton(), 3000);
  }
}

// Trade pair slippage buttons
document.querySelectorAll('.trade-slip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.trade-slip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tradeSlippageCustom').value = '';
    try { localStorage.setItem('curvedex_slippage', btn.dataset.slip); } catch (e) {}
  });
});

// Custom slippage input → persist
const _tradeSlipCustomInput = document.getElementById('tradeSlippageCustom');
if (_tradeSlipCustomInput) {
  _tradeSlipCustomInput.addEventListener('input', () => {
    const val = parseFloat(_tradeSlipCustomInput.value);
    if (!isNaN(val) && val > 0 && val < 50) {
      document.querySelectorAll('.trade-slip').forEach(b => b.classList.remove('active'));
      try { localStorage.setItem('curvedex_slippage', String(val)); } catch (e) {}
    }
  });
}

// Apply saved slippage on init (shared with /swap via key 'curvedex_slippage')
function applySavedTradeSlippage() {
  let saved;
  try { saved = localStorage.getItem('curvedex_slippage'); } catch (e) { return; }
  if (!saved) return;
  const val = parseFloat(saved);
  if (isNaN(val) || val <= 0 || val >= 50) return;
  const presets = ['0.1', '0.5', '1.0'];
  const customInput = document.getElementById('tradeSlippageCustom');
  if (presets.includes(saved)) {
    document.querySelectorAll('.trade-slip').forEach(b => {
      b.classList.toggle('active', b.dataset.slip === saved);
    });
    if (customInput) customInput.value = '';
  } else {
    document.querySelectorAll('.trade-slip').forEach(b => b.classList.remove('active'));
    if (customInput) customInput.value = saved;
  }
}
applySavedTradeSlippage();


// ============================================================
// TRADE TOKEN MODAL (free token selection — any to any)
// ============================================================
let tradeTokenModalTarget = 'from'; // 'from' or 'to'
let tradeSelectedFrom = null; // {symbol, address, decimals}
let tradeSelectedTo = null;

function openTradeTokenModal(target) {
  tradeTokenModalTarget = target;
  const searchInput = document.getElementById('tradeTokenSearchInput');
  if (searchInput) searchInput.value = '';
  renderTradeTokenModalList('');
  document.getElementById('tradeTokenModal').classList.add('show');
  setTimeout(() => { if (searchInput) searchInput.focus(); }, 100);
}

function closeTradeTokenModal() {
  document.getElementById('tradeTokenModal').classList.remove('show');
}

document.getElementById('tradeTokenModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('tradeTokenModal')) closeTradeTokenModal();
});

document.getElementById('tradeTokenSearchInput').addEventListener('input', (e) => {
  renderTradeTokenModalList(e.target.value.trim());
});

// Token-balance fetch token: cancels in-flight async re-render when modal
// is re-opened or query changes. Each render bumps the token; only the
// freshest fetch is allowed to mutate the DOM.
let _tradeTokenModalRenderToken = 0;

// Sort tokens: wallet holdings first (DESC by USD value, then by raw balance
// for tokens without a price), zero-balance tokens keep original order.
function _sortTradeTokensByBalance(tokens, balMap) {
  if (!balMap || balMap.size === 0) return tokens;
  const withBal = [];
  const without = [];
  for (const t of tokens) {
    const e = balMap.get(t.address.toLowerCase());
    if (e && (e.usdValue > 0 || e.balance > 0)) withBal.push(t);
    else without.push(t);
  }
  withBal.sort((a, b) => {
    const ea = balMap.get(a.address.toLowerCase()) || { usdValue: 0, balance: 0 };
    const eb = balMap.get(b.address.toLowerCase()) || { usdValue: 0, balance: 0 };
    if (eb.usdValue !== ea.usdValue) return eb.usdValue - ea.usdValue;
    return eb.balance - ea.balance;
  });
  return [...withBal, ...without];
}

function _renderTradeTokenModalRows(showList, balMap) {
  return showList.map((t) => {
    const poolCount = t.pools ? t.pools.size : 0;
    const isSelected = (tradeTokenModalTarget === 'from' && tradeSelectedFrom && tradeSelectedFrom.address === t.address) ||
                       (tradeTokenModalTarget === 'to' && tradeSelectedTo && tradeSelectedTo.address === t.address);
    const iconUrl = _tokenIconUrl(t.address);
    const e = balMap ? balMap.get(t.address.toLowerCase()) : null;
    const balStr = e ? _fmtTokenBalance(e.balance) : '';
    const usdStr = e ? _fmtTokenUsd(e.usdValue) : '';
    const balLine = balStr
      ? `<div class="token-bal">${balStr}${usdStr ? ` <span class="token-usd">(${usdStr})</span>` : ''}</div>`
      : '';
    return `<div class="token-modal-item${isSelected ? ' selected' : ''}" onclick="selectTradeToken('${t.address}')">
      <img class="token-icon" src="${iconUrl}" alt="" width="28" height="28" style="border-radius:50%;object-fit:cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="token-icon" style="display:none">${t.symbol.slice(0, 2)}</div>
      <div class="token-modal-info">
        <div class="token-name">${t.symbol}</div>
        <div class="token-addr">${t.address.slice(0, 6)}...${t.address.slice(-4)}</div>
        <div class="token-pools">${poolCount} pool${poolCount !== 1 ? 's' : ''}</div>
      </div>
      ${balLine}
    </div>`;
  }).join('');
}

function renderTradeTokenModalList(query) {
  const list = document.getElementById('tradeTokenModalList');
  let tokens = tradeTokenList;
  if (query) {
    const q = query.toLowerCase();
    tokens = tradeTokenList.filter(t =>
      t.symbol.toLowerCase().includes(q) ||
      t.address.toLowerCase().includes(q)
    );
  }

  // Seed with cached balances from previous fetch (if any) so the first
  // paint already shows wallet ordering when re-opening the modal.
  const cachedBalMap = (typeof _walletBalanceCache !== 'undefined' && walletAddress &&
    _walletBalanceCache.walletAddress &&
    _walletBalanceCache.walletAddress.toLowerCase() === walletAddress.toLowerCase())
    ? _walletBalanceCache.entries
    : null;

  let display = tokens;
  if (cachedBalMap && cachedBalMap.size > 0) {
    display = _sortTradeTokensByBalance(tokens, cachedBalMap);
  }
  const show = display.slice(0, 100);
  list.innerHTML = _renderTradeTokenModalRows(show, cachedBalMap);
  if (show.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">No tokens found</div>';
    return;
  }

  // Async: fetch balances for ALL filtered tokens (cap 100 for safety),
  // then re-sort + re-render. If wallet not connected, skip async.
  if (!walletAddress || typeof getWalletTokenBalances !== 'function') return;
  const myToken = ++_tradeTokenModalRenderToken;
  // Limit fetch scope to the first 100 filtered tokens (= what's visible)
  const fetchScope = tokens.slice(0, 100);
  getWalletTokenBalances(fetchScope, walletAddress).then(balMap => {
    if (myToken !== _tradeTokenModalRenderToken) return; // stale
    if (!balMap || balMap.size === 0) return;
    const sorted = _sortTradeTokensByBalance(tokens, balMap);
    const show2 = sorted.slice(0, 100);
    list.innerHTML = _renderTradeTokenModalRows(show2, balMap);
  }).catch(() => { /* swallow: keep initial render */ });
}

function selectTradeToken(address) {
  const token = tradeTokenList.find(t => t.address === address);
  if (!token) return;

  if (tradeTokenModalTarget === 'from') {
    // If selecting same token as "To", swap them
    if (tradeSelectedTo && tradeSelectedTo.address === address) {
      tradeSelectedTo = tradeSelectedFrom;
      updateTradeTokenUI('to', tradeSelectedTo);
    }
    tradeSelectedFrom = token;
    updateTradeTokenUI('from', token);
  } else {
    if (tradeSelectedFrom && tradeSelectedFrom.address === address) {
      tradeSelectedFrom = tradeSelectedTo;
      updateTradeTokenUI('from', tradeSelectedFrom);
    }
    tradeSelectedTo = token;
    updateTradeTokenUI('to', token);
  }

  closeTradeTokenModal();
  onTradeTokensChanged();
}

function updateTradeTokenUI(side, token) {
  const nameEl = document.getElementById(side === 'from' ? 'tradePairFromName' : 'tradePairToName');
  const iconElId = side === 'from' ? 'tradePairFromIcon' : 'tradePairToIcon';
  if (token) {
    if (nameEl) nameEl.textContent = token.symbol;
    _setTokenIcon(iconElId, token.address, token.symbol);
  } else {
    if (nameEl) nameEl.textContent = '--';
    const iconEl = document.getElementById(iconElId);
    if (iconEl) {
      iconEl.style.backgroundImage = '';
      iconEl.style.color = '';
      iconEl.textContent = '?';
    }
  }
}

let _suppressHashRoute = false; // prevent handleRoute from overriding free token selection

function _resolveTokenAddr(token) {
  // ETH → WETH for pool lookups
  if (token._isNativeETH || token.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  }
  return token.address;
}

function onTradeTokensChanged() {
  if (!tradeSelectedFrom || !tradeSelectedTo) return;
  const fromAddr = _resolveTokenAddr(tradeSelectedFrom);
  const toAddr = _resolveTokenAddr(tradeSelectedTo);
  if (fromAddr === toAddr) return;

  // Show loading placeholders for all quote-derived fields so stale values
  // from previous token pair don't linger while new quote is being fetched.
  const _fromAmt = document.getElementById('tradePairFromAmt')?.value;
  if (_fromAmt && parseFloat(_fromAmt) > 0 && typeof _setTradePairQuoteLoading === 'function') {
    _setTradePairQuoteLoading();
  } else {
    // No amount yet — at least refresh balances and clear any old state
    const fromBal = document.getElementById('tradePairFromBal');
    if (fromBal) fromBal.textContent = 'Balance: ...';
    const toBal = document.getElementById('tradePairToBal');
    if (toBal) toBal.textContent = 'Balance: ...';
  }

  // Update chart header
  const pairEl = document.getElementById('tradePairName');
  if (pairEl) pairEl.innerHTML = `<span class="pair-accent">${tradeSelectedFrom.symbol}</span> / <span>${tradeSelectedTo.symbol}</span>`;

  // Find or create a matching pair for chart/trades
  const pairName = `${tradeSelectedFrom.symbol}/${tradeSelectedTo.symbol}`;
  let pair = tokenPairs.find(p => p.name === pairName);

  if (!pair) {
    // Try reverse
    const reverseName = `${tradeSelectedTo.symbol}/${tradeSelectedFrom.symbol}`;
    const reversePair = tokenPairs.find(p => p.name === reverseName);
    if (reversePair) {
      // Create a virtual reverse pair
      pair = {
        name: pairName,
        base: tradeSelectedFrom.symbol,
        quote: tradeSelectedTo.symbol,
        baseAddr: fromAddr,
        quoteAddr: toAddr,
        pool: reversePair.pool,
        poolAddr: reversePair.poolAddr,
        tvl: reversePair.tvl,
        volume: reversePair.volume,
        priceChange: reversePair.priceChange,
      };
    } else {
      // Find best pool directly (resolve ETH→WETH, ensure lowercase)
      const bestPool = findBestPool(fromAddr, toAddr);
      if (bestPool) {
        pair = {
          name: pairName,
          base: tradeSelectedFrom.symbol,
          quote: tradeSelectedTo.symbol,
          baseAddr: fromAddr,
          quoteAddr: toAddr,
          pool: bestPool,
          poolAddr: bestPool.address,
          tvl: bestPool.tvl || 0,
          volume: bestPool.volumeUSD || 0,
          priceChange: null,
        };
      } else {
        // Try multi-hop — find an intermediate
        const multiRoute = findMultiHopRoute(fromAddr, toAddr);
        if (multiRoute && multiRoute.length > 0) {
          pair = {
            name: pairName,
            base: tradeSelectedFrom.symbol,
            quote: tradeSelectedTo.symbol,
            baseAddr: fromAddr,
            quoteAddr: toAddr,
            pool: multiRoute[0], // Use first hop pool for chart
            poolAddr: multiRoute[0].address,
            tvl: multiRoute[0].tvl || 0,
            volume: 0,
            priceChange: null,
            _multiRoute: multiRoute,
          };
        }
      }
    }
  }

  // Suppress handleRoute from resetting our selection when hash changes
  _suppressHashRoute = true;

  if (pair) {
    selectedPair = pair;
    // Highlight in pair list if exists
    document.querySelectorAll('.pair-item').forEach(el => {
      el.classList.toggle('active', el.dataset.pair === pair.name);
    });
    updateHash();

    // Update pool stats
    if (pair.pool) {
      const statsEl = document.getElementById('tradePairPoolStats');
      if (statsEl) statsEl.style.display = '';
      const pnEl = document.getElementById('tradePairPoolName');
      if (pnEl) pnEl.textContent = _shortPoolName(pair.pool.name) || pair.poolAddr.slice(0, 12);
      const tvlEl = document.getElementById('tradePairTvl');
      if (tvlEl) tvlEl.textContent = fmt$(pair.tvl);
      const volEl = document.getElementById('tradePairVolume');
      if (volEl) volEl.textContent = fmt$(pair.volume);
      const feesEl = document.getElementById('tradePairFees');
      if (feesEl) {
        const feePct = _poolFeePct(pair.pool);
        const rate = (feePct != null ? feePct : 0.04) / 100;
        feesEl.textContent = pair.volume > 0 ? '~' + fmt$(pair.volume * rate) : '--';
      }
    }

    // Update route visualization
    updateTradeRouteViz(pair);

    // Init chart and load data
    initTradePairChart();
    Promise.all([loadTradePairOHLC(), loadTradePairTrades()]);
    // After BFS-by-TVL initial chart, probe the swap router (dy-based) for the
    // live best-rate path; if it differs, chart re-renders to match the swap.
    _probeRouterRouteForChart();
  } else {
    // No direct Curve route found — but aggregators (ParaSwap/ODOS) can still handle it
    selectedPair = {
      name: pairName,
      base: tradeSelectedFrom.symbol,
      quote: tradeSelectedTo.symbol,
      baseAddr: fromAddr,
      quoteAddr: toAddr,
      pool: null,
      poolAddr: null,
      tvl: 0,
      volume: 0,
      priceChange: null,
    };
    const routeViz = document.getElementById('tradeRouteViz');
    if (routeViz) { routeViz.classList.remove('show'); }
    const statsEl = document.getElementById('tradePairPoolStats');
    if (statsEl) statsEl.style.display = 'none';
    // Show "no Curve route" but swap form stays active for aggregator quotes
    const routeEl = document.getElementById('tradePairRouteInfo');
    if (routeEl) routeEl.textContent = 'No Curve route (aggregators available)';
    const chartContainer = document.getElementById('trade-pair-chart-container');
    if (chartContainer) chartContainer.innerHTML = '<div class="loading-center">No direct pool for this pair</div>';
    updateHash();
  }
  updateTradePairButton();
  if (walletAddress) loadTradePairBalances();

  // Retrigger quote if amount > 0 (tokens changed, so quote should refresh)
  const fromAmt = document.getElementById('tradePairFromAmt').value;
  if (fromAmt && parseFloat(fromAmt) > 0) {
    clearTimeout(tradeQuoteDebounce);
    tradeQuoteDebounce = setTimeout(fetchTradeQuote, 300);
  }
}


// ============================================================
// ROUTE VISUALIZATION (ODOS-style SVG flow graph)
// ============================================================

// Helper: format TVL string
function _fmtTvlShort(tvl) {
  if (!tvl || tvl <= 0) return '';
  if (tvl >= 1e6) return '$' + (tvl / 1e6).toFixed(1) + 'M';
  if (tvl >= 1e3) return '$' + (tvl / 1e3).toFixed(0) + 'K';
  return '$' + tvl.toFixed(0);
}

// Build SVG route visualization for a given set of route segments
function _buildRouteSVG(fromSym, toSym, pools, opts) {
  // pools: [{name, tvl, pct}] — for split, multiple entries; for direct/hop, single per step
  // opts: { split: bool, midTokens: [sym...] }
  const isSplit = opts && opts.split;
  const midTokens = (opts && opts.midTokens) || [];
  const totalNodes = 2 + (isSplit ? 0 : midTokens.length); // from + to + mid tokens
  const totalCols = isSplit ? 3 : (2 + pools.length + midTokens.length); // from + pools + midTokens + to

  // SVG dimensions
  const W = 360, nodeH = 36, padX = 10, padY = 12;
  const splitRows = isSplit ? pools.length : 1;
  const H = isSplit ? Math.max(80, splitRows * 44 + 24) : (midTokens.length > 0 ? 80 : 70);

  // Column x positions
  const colW = (W - 2 * padX) / (totalCols - 1 || 1);

  // Token node SVG
  function tokenSVG(sym, x, y, color, animDelay) {
    const icon = sym.substring(0, 2).toUpperCase();
    const w = Math.max(sym.length * 8 + 40, 70);
    return `<g class="route-svg-node" style="animation-delay:${animDelay}ms">
      <rect x="${x - w/2}" y="${y - 16}" width="${w}" height="32" rx="16" ry="16"
            fill="#2b3139" stroke="${color}" stroke-width="1.5"/>
      <circle cx="${x - w/2 + 18}" cy="${y}" r="10" fill="${color}"/>
      <text x="${x - w/2 + 18}" y="${y + 4}" text-anchor="middle"
            fill="#000" font-size="9" font-weight="700">${icon}</text>
      <text x="${x - w/2 + 34}" y="${y + 4}" fill="#eaecef"
            font-size="12" font-weight="600">${sym}</text>
    </g>`;
  }

  // Pool node SVG
  function poolSVG(name, tvl, pct, x, y, animDelay) {
    const tvlStr = _fmtTvlShort(tvl);
    const label = (pct !== undefined ? pct.toFixed(0) + '% ' : '') + name;
    const w = Math.max(label.length * 6.5 + 20, 80);
    return `<g class="route-svg-node" style="animation-delay:${animDelay}ms">
      <rect x="${x - w/2}" y="${y - 14}" width="${w}" height="28" rx="6" ry="6"
            fill="#1e2329" stroke="#2b3139" stroke-width="1"/>
      ${pct !== undefined ? `<text x="${x - w/2 + 6}" y="${y + 4}" fill="#f0b90b"
            font-size="10" font-weight="700">${pct.toFixed(0)}%</text>
      <text x="${x - w/2 + 6 + (pct.toFixed(0).length + 1) * 7}" y="${y + 4}" fill="#eaecef"
            font-size="10" font-weight="500">${name}</text>` :
      `<text x="${x}" y="${y + 4}" text-anchor="middle" fill="#eaecef"
            font-size="10" font-weight="500">${name}</text>`}
      ${tvlStr ? `<text x="${x + w/2 - 4}" y="${y + 4}" text-anchor="end" fill="#848e9c"
            font-size="9">${tvlStr}</text>` : ''}
    </g>`;
  }

  // Bezier path between two points
  function bezierPath(x1, y1, x2, y2, delay) {
    const cx = (x1 + x2) / 2;
    const d = `M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`;
    const len = Math.sqrt((x2-x1)**2 + (y2-y1)**2) * 1.3;
    return `<path d="${d}" fill="none" stroke="url(#routeGrad)" stroke-width="2" opacity="0.6"
            stroke-dasharray="${len}" stroke-dashoffset="${len}"
            style="animation: routePathDraw 0.6s ease forwards ${delay}ms"/>`;
  }

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
    style="width:100%;height:${H}px;display:block;">
    <defs>
      <linearGradient id="routeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#f0b90b"/>
        <stop offset="100%" stop-color="#0ecb81"/>
      </linearGradient>
    </defs>`;

  const fromX = padX + 40;
  const toX = W - padX - 40;
  const midY = H / 2;

  if (isSplit) {
    // Split routing: from -> parallel pool nodes -> to
    const poolX = W / 2;
    svg += tokenSVG(fromSym, fromX, midY, '#f0b90b', 0);
    svg += tokenSVG(toSym, toX, midY, '#0ecb81', 200 + pools.length * 100);

    pools.forEach((p, i) => {
      const rowY = padY + 18 + i * 42;
      svg += bezierPath(fromX + 35, midY, poolX - 40, rowY, 100 + i * 80);
      svg += poolSVG(p.name, p.tvl, p.pct, poolX, rowY, 150 + i * 80);
      svg += bezierPath(poolX + 40, rowY, toX - 35, midY, 200 + i * 80);
    });
  } else if (midTokens.length > 0) {
    // Multi-hop: from -> pool1 -> mid -> pool2 -> to
    const steps = pools.length + midTokens.length + 2;
    const stepW = (toX - fromX) / (steps - 1);
    let x = fromX;
    svg += tokenSVG(fromSym, x, midY, '#f0b90b', 0);

    let nodeIdx = 0;
    for (let i = 0; i < pools.length; i++) {
      const poolCx = x + stepW;
      svg += bezierPath(x + 35, midY, poolCx - 40, midY, 100 + nodeIdx * 120);
      svg += poolSVG(pools[i].name, pools[i].tvl, undefined, poolCx, midY, 150 + nodeIdx * 120);
      x = poolCx;
      nodeIdx++;

      if (i < midTokens.length) {
        const midCx = x + stepW;
        svg += bezierPath(x + 40, midY, midCx - 30, midY, 100 + nodeIdx * 120);
        svg += tokenSVG(midTokens[i], midCx, midY, '#848e9c', 150 + nodeIdx * 120);
        x = midCx;
        nodeIdx++;
      }
    }
    svg += bezierPath(x + 35, midY, toX - 35, midY, 100 + nodeIdx * 120);
    svg += tokenSVG(toSym, toX, midY, '#0ecb81', 150 + nodeIdx * 120);
  } else {
    // Direct: from -> pool -> to
    const poolCx = W / 2;
    svg += bezierPath(fromX + 35, midY, poolCx - 40, midY, 100);
    svg += tokenSVG(fromSym, fromX, midY, '#f0b90b', 0);
    svg += poolSVG(pools[0].name, pools[0].tvl, undefined, poolCx, midY, 150);
    svg += bezierPath(poolCx + 40, midY, toX - 35, midY, 200);
    svg += tokenSVG(toSym, toX, midY, '#0ecb81', 250);
  }

  svg += '</svg>';
  return svg;
}

/**
 * Build SVG visualization for multi-path routing.
 * Each path can be 1-hop (direct) or 2-hop (with intermediate token).
 * Shows FROM -> [parallel paths with optional midTokens] -> TO
 *
 * @param {string} fromSym - source token symbol
 * @param {string} toSym - destination token symbol
 * @param {Array} paths - [{poolNames: [str], midTokenSyms: [str], pct: number, tvl: number}]
 * @returns {string} SVG markup
 */
function _shortenPoolName(name) {
  if (!name) return '?';
  // Remove common Curve prefixes
  let s = name.replace(/^Curve\.fi Factory (Plain |Crypto |)Pool:\s*/i, '')
               .replace(/^Curve\.fi\s*/i, '')
               .replace(/^Factory\s*/i, '');
  // Truncate to 18 chars max
  if (s.length > 18) s = s.substring(0, 16) + '..';
  return s;
}

// Iterative DFS cycle check on a directed graph defined by {source, target} index links.
// Returns true if any cycle exists. Used to short-circuit d3-sankey which throws
// "circular link" on cyclic input.
function _sankeyHasCycle(nodeCount, links) {
  const adj = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) adj[i] = [];
  for (const l of links) {
    if (typeof l.source === 'number' && typeof l.target === 'number') {
      if (l.source === l.target) return true; // self-loop
      adj[l.source].push(l.target);
    }
  }
  // 0 = unvisited, 1 = on stack, 2 = done
  const state = new Uint8Array(nodeCount);
  for (let start = 0; start < nodeCount; start++) {
    if (state[start] !== 0) continue;
    // iterative DFS with explicit stack of [node, childIndex]
    const stack = [[start, 0]];
    state[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const node = top[0];
      const children = adj[node];
      if (top[1] < children.length) {
        const next = children[top[1]++];
        if (state[next] === 1) return true;       // back edge -> cycle
        if (state[next] === 0) {
          state[next] = 1;
          stack.push([next, 0]);
        }
      } else {
        state[node] = 2;
        stack.pop();
      }
    }
  }
  return false;
}

function _buildMultiPathSVG(fromSym, toSym, paths) {
  // --- Hamutzim Studio d3-sankey style: curved flows, bright on dark ---
  if (typeof d3 === 'undefined' || typeof d3.sankey === 'undefined') {
    return _buildMultiPathSVG_legacy(fromSym, toSym, paths);
  }

  const sorted = [...paths].sort((a, b) => b.pct - a.pct);

  // Build sankey graph: nodes + links
  const nodeMap = new Map();
  let nodeIdx = 0;
  const nodes = [];
  const links = [];

  function getNode(name, type) {
    const key = type + ':' + name;
    if (nodeMap.has(key)) return nodeMap.get(key);
    const idx = nodeIdx++;
    nodeMap.set(key, idx);
    nodes.push({ name, type });
    return idx;
  }

  const srcIdx = getNode(fromSym, 'source');
  const tgtIdx = getNode(toSym, 'target');

  // Pool-to-color tracking for link coloring
  const pathPoolColors = new Map(); // linkKey -> poolName

  sorted.forEach(path => {
    const value = Math.max(path.pct, 1.5); // minimum visual width

    if (path.midTokenSyms.length === 0) {
      const poolName = _shortenPoolName(path.poolNames[0]);
      const poolIdx = getNode(poolName, 'pool');
      links.push({ source: srcIdx, target: poolIdx, value, pct: path.pct, pool: poolName });
      links.push({ source: poolIdx, target: tgtIdx, value, pct: path.pct, pool: poolName });
    } else {
      const pool1Name = _shortenPoolName(path.poolNames[0]);
      const pool2Name = _shortenPoolName(path.poolNames[1]);
      const midSym = path.midTokenSyms[0] || '?';
      const p1Idx = getNode(pool1Name, 'pool');
      const midIdx = getNode(midSym, 'mid');
      const p2Idx = getNode(pool2Name, 'pool');
      links.push({ source: srcIdx, target: p1Idx, value, pct: path.pct, pool: pool1Name });
      links.push({ source: p1Idx, target: midIdx, value, pct: path.pct, pool: pool1Name });
      links.push({ source: midIdx, target: p2Idx, value, pct: path.pct, pool: pool2Name });
      links.push({ source: p2Idx, target: tgtIdx, value, pct: path.pct, pool: pool2Name });
    }
  });

  // Merge duplicate links (same source+target)
  const linkKey = l => l.source + '->' + l.target;
  const merged = new Map();
  for (const l of links) {
    const k = linkKey(l);
    if (merged.has(k)) {
      const m = merged.get(k);
      m.value += l.value;
      m.pct += l.pct;
    } else {
      merged.set(k, { ...l });
    }
  }
  const mergedLinks = [...merged.values()];

  // Detect cycles in the merged link DAG. d3-sankey throws "circular link" on cycles,
  // which happens e.g. when path A is SRC->poolX->mid1->poolY->TGT and path B is
  // SRC->poolY->mid2->poolX->TGT (poolX and poolY mutually reachable). On detection,
  // fall back to the legacy linear renderer which doesn't require an acyclic graph.
  if (_sankeyHasCycle(nodes.length, mergedLinks)) {
    return _buildMultiPathSVG_legacy(fromSym, toSym, paths);
  }

  // --- Observable d3-sankey style: stroked paths, source-target gradients ---
  const W = 440;
  const H = Math.max(180, sorted.length * 50 + 50);
  const margin = { top: 8, right: 8, bottom: 24, left: 8 };

  const sankey = d3.sankey()
    .nodeId(d => d.index)
    .nodeWidth(15)
    .nodePadding(14)
    .nodeAlign(d3.sankeyJustify)
    .extent([[margin.left, margin.top], [W - margin.right, H - margin.bottom]]);

  let graph;
  try {
    graph = sankey({
      nodes: nodes.map((d, i) => ({ ...d, index: i })),
      links: mergedLinks.map(d => ({ ...d }))
    });
  } catch (e) {
    // Defensive: if cycle check missed an edge case, still don't crash callers.
    return _buildMultiPathSVG_legacy(fromSym, toSym, paths);
  }

  // Color palette — Tableau10-inspired, vibrant on dark
  const palette = ['#4e79a7', '#59a14f', '#f28e2b', '#e15759', '#76b7b2', '#edc948', '#b07aa1', '#9c755f'];
  const nodeColorMap = new Map();
  let cIdx = 0;
  graph.nodes.forEach(n => {
    if (n.type === 'source') nodeColorMap.set(n.index, '#f0b90b');
    else if (n.type === 'target') nodeColorMap.set(n.index, '#22c55e');
    else {
      nodeColorMap.set(n.index, palette[cIdx % palette.length]);
      cIdx++;
    }
  });

  const uid = 'sk' + Math.random().toString(16).slice(2, 8);
  const linkPath = d3.sankeyLinkHorizontal();

  let defs = '';
  // Source-target gradients for each link
  graph.links.forEach((link, i) => {
    const sc = nodeColorMap.get(link.source.index) || '#888';
    const tc = nodeColorMap.get(link.target.index) || '#888';
    defs += `<linearGradient id="${uid}-${i}" gradientUnits="userSpaceOnUse"
      x1="${link.source.x1}" x2="${link.target.x0}">
      <stop offset="0%" stop-color="${sc}"/>
      <stop offset="100%" stop-color="${tc}"/>
    </linearGradient>`;
  });

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
    style="width:100%;height:auto;display:block;" class="sankey-route">
    <defs>${defs}</defs>
    <rect width="${W}" height="${H}" fill="#12151a" rx="6"/>`;

  // Links: STROKED paths (not filled) — exactly like Observable/Hamutzim
  svg += `<g fill="none" stroke-opacity="0.5">`;
  graph.links.forEach((link, i) => {
    const d = linkPath(link);
    const sw = Math.max(1, link.width);
    svg += `<path d="${d}" stroke="url(#${uid}-${i})" stroke-width="${sw}"
            style="mix-blend-mode:screen"/>`;
  });
  svg += `</g>`;

  // Nodes: colored rectangles with labels
  svg += `<g stroke="#12151a" stroke-width="0.5">`;
  graph.nodes.forEach(node => {
    const x = node.x0, y = node.y0;
    const w = node.x1 - node.x0;
    const h = Math.max(node.y1 - node.y0, 2);
    const fill = nodeColorMap.get(node.index) || '#888';
    svg += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  });
  svg += `</g>`;

  // Labels: to the side of node bars, staggered vertically for intermediates
  svg += `<g font-family="sans-serif" font-size="13" fill="#d1d5db">`;
  let labelIdx = 0;
  graph.nodes.forEach(node => {
    const x = node.x0, w = node.x1 - node.x0;
    const cy = (node.y1 + node.y0) / 2;
    const isLeft = x < W / 2;
    const lx = isLeft ? node.x1 + 6 : node.x0 - 6;
    const anchor = isLeft ? 'start' : 'end';
    const fill = nodeColorMap.get(node.index) || '#d1d5db';
    // Stagger intermediate labels vertically
    let yOff = 0;
    if (node.type !== 'source' && node.type !== 'target') {
      const offsets = [-24, -8, 8, 24];
      yOff = offsets[labelIdx % offsets.length];
      labelIdx++;
    }
    svg += `<text x="${lx}" y="${cy + yOff}" dy="0.35em" text-anchor="${anchor}"
            fill="${fill}" font-weight="600">${node.name}</text>`;
  });
  svg += `</g>`;

  // Percentage labels on source-outgoing links (only when split routes, not for single path)
  const srcLinks = graph.links.filter(l => l.source.type === 'source');
  if (srcLinks.length > 1) {
    srcLinks.forEach(link => {
      const pctLabel = link.pct.toFixed(0) + '%';
      const lx = link.source.x1 + 6;
      const ly = link.y0;
      svg += `<text x="${lx}" y="${ly}" dy="0.35em" fill="#f0b90b" opacity="0.8"
              font-size="8" font-weight="700" font-family="sans-serif">${pctLabel}</text>`;
    });
  }

  svg += '</svg>';
  return svg;
}

/**
 * Legacy fallback for _buildMultiPathSVG when d3-sankey is not loaded.
 * Preserves the old custom SVG bezier-curve visualization.
 */
function _buildMultiPathSVG_legacy(fromSym, toSym, paths) {
  const W = 460;
  const rowH = 46;
  const n = paths.length;
  const maxPools = Math.max(...paths.map(p => p.poolNames.length));
  const H = Math.max(maxPools > 1 ? 160 : 120, n * rowH + 40);
  const midY = H / 2;
  const fromCX = 32, toCX = W - 32;
  const sorted = [...paths].sort((a, b) => b.pct - a.pct);
  const maxPct = Math.max(...sorted.map(p => p.pct), 1);

  function tokenCircle(sym, cx, cy, color, ad) {
    const icon = sym.substring(0, 2).toUpperCase();
    return `<g class="route-svg-node" style="animation-delay:${ad}ms">
      <circle cx="${cx}" cy="${cy}" r="22" fill="#1a1d23" stroke="${color}" stroke-width="2.5"/>
      <text x="${cx}" y="${cy - 3}" text-anchor="middle" fill="${color}"
            font-size="9" font-weight="800">${icon}</text>
      <text x="${cx}" y="${cy + 9}" text-anchor="middle" fill="#eaecef"
            font-size="8" font-weight="600">${sym}</text>
    </g>`;
  }

  function chip(label, cx, cy, d, fill, stroke) {
    const w = Math.max(label.length * 6 + 12, 48);
    return `<g class="route-svg-node" style="animation-delay:${d}ms">
      <rect x="${cx - w/2}" y="${cy - 10}" width="${w}" height="20" rx="4"
            fill="${fill || '#1e2329'}" stroke="${stroke || '#3a3f47'}" stroke-width="1"/>
      <text x="${cx}" y="${cy + 3.5}" text-anchor="middle" fill="#d1d5db"
            font-size="8" font-weight="600">${label}</text>
    </g>`;
  }

  function tokenDot(sym, cx, cy, d) {
    return `<g class="route-svg-node" style="animation-delay:${d}ms">
      <circle cx="${cx}" cy="${cy}" r="11" fill="#252830" stroke="#5a6270" stroke-width="1.2"/>
      <text x="${cx}" y="${cy + 3}" text-anchor="middle" fill="#b0b8c1"
            font-size="7" font-weight="700">${sym}</text>
    </g>`;
  }

  let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg"
    style="width:100%;height:auto;display:block;">
    <defs>
      <linearGradient id="mpG1" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#f0b90b"/><stop offset="100%" stop-color="#0ecb81"/>
      </linearGradient>
      <linearGradient id="mpG0" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#f0b90b" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#0ecb81" stop-opacity="0.3"/>
      </linearGradient>
    </defs>`;

  const zoneL = fromCX + 30;
  const zoneR = toCX - 30;
  const zoneMid = (zoneL + zoneR) / 2;

  sorted.forEach((path, i) => {
    const rowY = 10 + (i + 0.5) * rowH;
    const delay = 40 + i * 40;
    const ratio = path.pct / maxPct;
    const sw = Math.max(1.5, ratio * 5);
    const op = 0.3 + ratio * 0.55;
    const gid = ratio > 0.4 ? 'mpG1' : 'mpG0';
    const x1 = fromCX + 22, x2 = toCX - 22;
    const dx1 = (zoneL - x1) * 0.5;
    const dx2 = (x2 - zoneR) * 0.5;
    const d = `M${x1},${midY} C${x1 + dx1},${midY} ${zoneL - dx1},${rowY} ${zoneL},${rowY} L${zoneR},${rowY} C${zoneR + dx2},${rowY} ${x2 - dx2},${midY} ${x2},${midY}`;
    const len = (zoneR - zoneL) + Math.sqrt((zoneL - x1) ** 2 + (rowY - midY) ** 2) * 1.3 + Math.sqrt((x2 - zoneR) ** 2 + (midY - rowY) ** 2) * 1.3;
    svg += `<path d="${d}" fill="none" stroke="url(#${gid})" stroke-width="${sw}"
            opacity="${op}" stroke-linecap="round"
            stroke-dasharray="${len}" stroke-dashoffset="${len}"
            style="animation:routePathDraw .8s ease forwards ${delay}ms"/>`;
  });

  sorted.forEach((path, i) => {
    const rowY = 10 + (i + 0.5) * rowH;
    const delay = 80 + i * 50;
    const pctLabel = path.pct.toFixed(0) + '%';

    if (path.midTokenSyms.length === 0) {
      const shortName = _shortenPoolName(path.poolNames[0]);
      const tvlStr = _fmtTvlShort(path.tvl);
      const label = tvlStr ? shortName + '  ' + tvlStr : shortName;
      svg += chip(label, zoneMid, rowY, delay);
      svg += `<text x="${zoneMid - 40}" y="${rowY - 14}" fill="#f0b90b"
              font-size="9" font-weight="700" opacity="0.9" class="route-svg-node"
              style="animation-delay:${delay - 20}ms">${pctLabel}</text>`;
    } else {
      // N pools with N-1 intermediate tokens — pools below flow, mid tokens on flow
      const nPools = path.poolNames.length;
      const nMids = path.midTokenSyms.length;
      const totalItems = nPools + nMids;
      const seg = (zoneR - zoneL) / (totalItems + 1);
      for (let k = 0; k < nPools; k++) {
        const poolX = zoneL + seg * (1 + k * 2);
        // All pool chips below the flow line, staggered
        const yOff = 28 + (k % 2) * 18;
        svg += chip(_shortenPoolName(path.poolNames[k]), poolX, rowY + yOff, delay + k * 25);
        if (k < nMids) {
          const midX = zoneL + seg * (2 + k * 2);
          svg += tokenDot(path.midTokenSyms[k] || '?', midX, rowY, delay + k * 25 + 12);
        }
      }
      svg += `<text x="${zoneL + 4}" y="${rowY - 14}" fill="#f0b90b"
              font-size="9" font-weight="700" opacity="0.9" class="route-svg-node"
              style="animation-delay:${delay - 20}ms">${pctLabel}</text>`;
    }
  });

  svg += tokenCircle(fromSym, fromCX, midY, '#f0b90b', 0);
  svg += tokenCircle(toSym, toCX, midY, '#0ecb81', 100 + n * 50);

  svg += '</svg>';
  return svg;
}

function updateTradeRouteViz(pair) {
  const viz = document.getElementById('tradeRouteViz');
  const pathEl = document.getElementById('tradeRoutePath');
  if (!viz || !pathEl) return;

  if (!pair || !pair.pool || !pair.base || !pair.quote) {
    viz.classList.remove('show');
    return;
  }

  if (pair._multiRoute && pair._multiRoute.length >= 2) {
    // Multi-hop (2 or 3 hops): build Sankey with intermediate tokens
    const route = pair._multiRoute;
    const poolNames = route.map(p => _shortPoolName(p.name || '?'));
    const _vizNorm = a => {
      const l = a.toLowerCase();
      return (l === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' || l === '0x0000000000000000000000000000000000000000')
        ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : l;
    };
    const midTokenSyms = [];
    // Prefer _bfsTokens if available (already has the correct token chain)
    if (route._bfsTokens && route._bfsTokens.length === route.length + 1) {
      for (let i = 1; i < route._bfsTokens.length - 1; i++) {
        const midAddr = route._bfsTokens[i];
        // Find symbol from pool coins
        let midSym = '?';
        for (const p of route) {
          const normAddrs = (p.coinsAddresses || []).map(_vizNorm);
          const idx = normAddrs.indexOf(midAddr);
          if (idx >= 0 && p.coins && p.coins[idx]) { midSym = p.coins[idx]; break; }
        }
        midTokenSyms.push(midSym);
      }
    } else {
      for (let i = 0; i < route.length - 1; i++) {
        const addrsA = route[i].coinsAddresses.map(_vizNorm);
        const addrsB = route[i + 1].coinsAddresses.map(_vizNorm);
        const midAddr = addrsA.find(a => addrsB.includes(a) && a !== pair.baseAddr && a !== pair.quoteAddr);
        const midIdx = midAddr ? addrsA.indexOf(midAddr) : -1;
        const midSym = (midIdx >= 0 && route[i].coins) ? (route[i].coins[midIdx] || '?') : '?';
        midTokenSyms.push(midSym);
      }
    }
    const tvl = Math.min(...route.map(p => p.tvl || 0));
    const multiPaths = [{ poolNames, midTokenSyms, pct: 100, tvl }];
    pathEl.innerHTML = _buildMultiPathSVG(pair.base, pair.quote, multiPaths);
  } else {
    // Single direct pool — show as single-path Sankey
    const pool = allPools.find(p => p.address === pair.poolAddr);
    const poolName = _shortPoolName((pair.pool && pair.pool.name) ? pair.pool.name : (pool ? pool.name : '?'));
    const tvl = pool ? (pool.tvl || 0) : 0;
    const multiPaths = [{
      poolNames: [poolName],
      midTokenSyms: [],
      pct: 100,
      tvl: tvl,
    }];
    pathEl.innerHTML = _buildMultiPathSVG(pair.base, pair.quote, multiPaths);
  }
  viz.classList.add('show');
}

// ============================================================

// AGGREGATOR COMPARISON
// ============================================================
let tradeRouterInstance = null;
let tradeQuoteDebounce = null;

function getTradeRouter() {
  if (!tradeRouterInstance && typeof CurveDEXRouter !== 'undefined') {
    tradeRouterInstance = new CurveDEXRouter({
      rpcCall: rpcCall,
      pools: allPools,
      chainId: 1,
      quoteTimeout: 10000,
      strategies: ['curve-direct', 'curve-router'],
      enableParaSwap: false,
      enableCow: false,
      enableOdos: false,
    });
  }
  return tradeRouterInstance;
}

// Reset router when pools change
function resetTradeRouter() { tradeRouterInstance = null; invalidateRouteCache(); }

// ============================================================
// LOADING STATE: called at start of every token-change path so
// stale quote/rate/route/gas/balance values don't linger while a
// fresh quote is being fetched (~200-400ms gap looked broken).
// ============================================================
function _setTradePairQuoteLoading() {
  // Output amount input — clear value, show loading placeholder
  const toInput = document.getElementById('tradePairToAmt');
  if (toInput) { toInput.value = ''; toInput.placeholder = 'Loading...'; }

  // Show details container so loading dots are visible (otherwise hidden)
  const detailsEl = document.getElementById('tradePairSwapDetails');
  if (detailsEl) detailsEl.style.display = '';

  // Rate / impact / route info
  const rateEl = document.getElementById('tradePairRate');
  if (rateEl) rateEl.textContent = '...';
  const impactEl = document.getElementById('tradePairImpact');
  if (impactEl) { impactEl.textContent = '...'; impactEl.style.color = ''; }
  const routeEl = document.getElementById('tradePairRouteInfo');
  if (routeEl) routeEl.textContent = '...';

  // Gas total + breakdown
  const gasEl = document.getElementById('tradePairGas');
  if (gasEl) { gasEl.textContent = '...'; gasEl.className = 'gas-value loading'; }
  const gApprove = document.getElementById('tradePairGasApprove');
  if (gApprove) gApprove.textContent = '...';
  const gSwap = document.getElementById('tradePairGasSwap');
  if (gSwap) gSwap.textContent = '...';

  // Route Sankey viz — clear inner SVG so old route doesn't hang there
  const routePath = document.getElementById('tradeRoutePath');
  if (routePath) routePath.innerHTML = '';

  // Balances refetch on token change
  const fromBal = document.getElementById('tradePairFromBal');
  if (fromBal) fromBal.textContent = 'Balance: ...';
  const toBal = document.getElementById('tradePairToBal');
  if (toBal) toBal.textContent = 'Balance: ...';

  // Invalidate cached quote so handleTradePairSwap re-quotes
  _lastTradeQuote = null;
}

// Lightweight router probe used at pair-load time so the chart can sync to the
// swap router's path (dy-based, multi-strategy) instead of the static BFS-by-TVL
// path. No UI side-effects (does not touch swap rate / impact / route text /
// gas labels / aggregator compare). Just rewrites selectedPair._multiRoute to
// the router-picked pools and triggers a chart re-render if the path changed.
//
// Why this is needed: BFS picks the highest-TVL chain, which may be stale-
// priced (e.g. LlamaThena scrvUSD/sUSDe pool unbalanced after the 24/4 event)
// while the live swap router finds a better path (Curvykin/Spark.fi). Without
// this probe, the chart shows synthetic 1.0756 while the swap quotes 1.0989.
async function _probeRouterRouteForChart() {
  if (!tradeSelectedFrom || !tradeSelectedTo) return;
  if (!selectedPair) return;
  // Skip if router quote will run anyway (user already entered amount)
  const fromAmtEl = document.getElementById('tradePairFromAmt');
  const fromAmt = fromAmtEl ? fromAmtEl.value : '';
  if (fromAmt && parseFloat(fromAmt) > 0) return;
  // Need ethers.parseUnits inside the router
  try { await loadEthers(); } catch { return; }
  const router = getTradeRouter();
  if (!router) return;
  const pairBaseAddr = selectedPair.baseAddr;
  const pairQuoteAddr = selectedPair.quoteAddr;
  try {
    // Probe with a small unit amount — enough to discover route/path,
    // not enough to materially impact dy quotes.
    const probeAmt = '1';
    const quote = await router.getQuote(
      tradeSelectedFrom.address,
      tradeSelectedTo.address,
      probeAmt,
      tradeSelectedFrom.decimals,
      tradeSelectedTo.decimals,
      0.5,
      null
    );
    if (!quote || !quote.route || quote.route.length < 2) return;
    // Pair may have changed while probe was in flight — abort if so.
    if (!selectedPair || selectedPair.baseAddr !== pairBaseAddr || selectedPair.quoteAddr !== pairQuoteAddr) return;
    const quotePools = [];
    const quoteTokens = [pairBaseAddr];
    let syncOk = true;
    for (let i = 0; i < quote.route.length; i++) {
      const leg = quote.route[i];
      const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
      if (!pool) { syncOk = false; break; }
      quotePools.push(pool);
      if (i < quote.route.length - 1) {
        const mts = quote._midTokens || (quote._midToken ? [quote._midToken] : []);
        const mt = mts[i];
        if (mt && mt.address) quoteTokens.push(mt.address.toLowerCase());
        else { syncOk = false; break; }
      }
    }
    if (!syncOk || quotePools.length < 2) return;
    quoteTokens.push(pairQuoteAddr);
    quotePools._bfsTokens = quoteTokens;
    const _addrSig = (arr) => (arr || []).map(p => (p.address || '').toLowerCase()).join('|');
    const oldSig = _addrSig(selectedPair._multiRoute);
    const newSig = _addrSig(quotePools);
    if (oldSig === newSig) return; // chart already correct, nothing to do
    selectedPair._multiRoute = quotePools;
    setCachedRoute(pairBaseAddr, pairQuoteAddr, quotePools);
    // Re-render chart with the swap-router-picked synthetic path
    loadTradePairOHLC();
  } catch (e) {
    // Probe failures are silent — chart simply keeps BFS route.
    console.warn('Chart route probe failed (keeping BFS route):', e && e.message);
  }
}

async function fetchTradeQuote() {
  if (!tradeSelectedFrom || !tradeSelectedTo) return;
  const fromAmt = document.getElementById('tradePairFromAmt').value;
  if (!fromAmt || parseFloat(fromAmt) <= 0) {
    hideAggCompare();
    return;
  }

  // Show loading state
  const toInput = document.getElementById('tradePairToAmt');
  if (toInput) { toInput.value = ''; toInput.placeholder = 'Loading...'; }
  const btn = document.getElementById('tradePairSwapBtn');
  if (btn) { btn.textContent = 'Fetching quote...'; btn.className = 'swap-submit disabled'; }

  // Ensure ethers.js is loaded (router.getQuote needs ethers.parseUnits)
  await loadEthers();

  const router = getTradeRouter();
  if (!router) { if (toInput) toInput.placeholder = '0.0'; updateTradePairButton(); return; }

  const slippageBtn = document.querySelector('.trade-slip.active');
  const slippageCustom = document.getElementById('tradeSlippageCustom').value;
  const slippage = slippageCustom ? parseFloat(slippageCustom) : (slippageBtn ? parseFloat(slippageBtn.dataset.slip) : 0.5);

  try {
    const quote = await router.getQuote(
      tradeSelectedFrom.address,
      tradeSelectedTo.address,
      fromAmt,
      tradeSelectedFrom.decimals,
      tradeSelectedTo.decimals,
      slippage,
      walletAddress || null
    );

    if (toInput) toInput.placeholder = '0.0';
    if (!quote) { if (toInput) toInput.value = ''; toInput.placeholder = 'No route found'; hideAggCompare(); updateTradePairButton(); return; }

    // Update To amount
    if (toInput) toInput.value = parseFloat(quote.outputAmount).toFixed(6);

    // Update swap details
    const detailsEl = document.getElementById('tradePairSwapDetails');
    if (detailsEl) detailsEl.style.display = '';
    const rateEl = document.getElementById('tradePairRate');
    if (rateEl) rateEl.textContent = `1 ${tradeSelectedFrom.symbol} = ${quote.rate.toFixed(6)} ${tradeSelectedTo.symbol}`;
    const impactEl = document.getElementById('tradePairImpact');
    if (impactEl) {
      let impact = quote.priceImpact;
      if (impact == null) {
        // Signed convention: NEGATIVE = loss, POSITIVE = premium.
        try {
          const microQuote = await tradeRouter.getQuote(
            _resolveTokenAddr(tradeSelectedFrom), _resolveTokenAddr(tradeSelectedTo),
            '0.01', tradeSelectedFrom.decimals || 18, tradeSelectedTo.decimals || 18,
            tradeSlippage, null
          );
          if (microQuote && microQuote.rate > 0) {
            impact = (quote.rate - microQuote.rate) / microQuote.rate * 100;
          }
        } catch { /* ignore */ }
      }
      if (impact == null) {
        impactEl.textContent = '—';
        impactEl.style.color = 'var(--text-dim)';
      } else if (Math.abs(impact) < 0.001) {
        impactEl.textContent = '<0.001%';
        impactEl.style.color = 'var(--green)';
      } else {
        const sign = impact > 0 ? '+' : '';
        impactEl.textContent = sign + impact.toFixed(3) + '%';
        impactEl.style.color = impact < 0 ? 'var(--red)' : 'var(--green)';
      }
    }

    // Update route text from quote (ensures text matches viz)
    const routeEl = document.getElementById('tradePairRouteInfo');
    if (routeEl && quote.route) {
      const routeParts = quote.route.map(r => _shortPoolName(r.poolName || r.exchange || '?')).filter(x => x && x !== '?');
      if (routeParts.length > 0) routeEl.textContent = routeParts.join(' \u2192 ');
    }

    // Update route visualization from quote
    updateRouteVizFromQuote(quote);

    // Sync selectedPair._multiRoute from router quote for chart consistency.
    // The chart's initial route comes from BFS-by-TVL (findMultiHopRoute), which
    // can pick a stale-priced high-TVL pool (e.g. LlamaThena scrvUSD/sUSDe) while
    // the swap router (dy-based, multi-strategy) finds the live best-rate path
    // (e.g. Curvykin/Spark.fi). When they diverge, the chart shows a synthetic
    // price that does NOT match the swap rate. After every successful router
    // quote, rewrite _multiRoute to match the swap path AND re-render the chart
    // if the path actually changed (cheap address-set comparison).
    if (selectedPair && quote.route && quote.route.length >= 2) {
      const quotePools = [];
      const quoteTokens = [selectedPair.baseAddr];
      let syncOk = true;
      for (let i = 0; i < quote.route.length; i++) {
        const leg = quote.route[i];
        const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
        if (!pool) { syncOk = false; break; }
        quotePools.push(pool);
        // Extract mid token from quote._midTokens
        if (i < quote.route.length - 1) {
          const mts = quote._midTokens || (quote._midToken ? [quote._midToken] : []);
          const mt = mts[i];
          if (mt && mt.address) {
            quoteTokens.push(mt.address.toLowerCase());
          } else { syncOk = false; break; }
        }
      }
      if (syncOk && quotePools.length >= 2) {
        quoteTokens.push(selectedPair.quoteAddr);
        quotePools._bfsTokens = quoteTokens;
        // Compare new route addrs with currently-rendered chart route
        const _addrSig = (arr) => (arr || []).map(p => (p.address || '').toLowerCase()).join('|');
        const oldSig = _addrSig(selectedPair._multiRoute);
        const newSig = _addrSig(quotePools);
        const routeChanged = oldSig !== newSig;
        selectedPair._multiRoute = quotePools;
        // Cache this route for future chart loads (timeframe switches etc)
        setCachedRoute(selectedPair.baseAddr, selectedPair.quoteAddr, quotePools);
        // If router picked a different path than chart is showing, re-render
        // chart with the synthetic OHLC over the swap-router-picked pools.
        if (routeChanged) {
          // Fire-and-forget; loadTradePairOHLC handles its own loading state.
          loadTradePairOHLC();
        }
      }
    }

    // Render aggregator comparison
    renderAggComparison(quote);

    // Render gas estimation (async, non-blocking)
    _lastTradeQuote = quote;
    renderTradeGasEstimate(quote, router);

    updateTradePairButton();

  } catch (e) {
    console.warn('Trade quote error:', e);
    const toInputErr = document.getElementById('tradePairToAmt');
    if (toInputErr) toInputErr.placeholder = '0.0';
    hideAggCompare();
    updateTradePairButton();
  }
}

function updateRouteVizFromQuote(quote) {
  const viz = document.getElementById('tradeRouteViz');
  const pathEl = document.getElementById('tradeRoutePath');
  if (!viz || !pathEl || !quote.route) return;

  const fromSym = tradeSelectedFrom.symbol;
  const toSym = tradeSelectedTo.symbol;

  // Always use Sankey visualization for all route types
  let multiPaths = [];

  if (quote.source === 'curve-split' && quote.route.length > 1) {
    const totalInput = BigInt(quote.inputAmountWei);
    multiPaths = quote.route.map(leg => {
      const pct = totalInput > 0n ? Number(BigInt(leg.chunkWei || 0) * 10000n / totalInput) / 100 : 0;
      const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
      return { poolNames: [_shortPoolName(leg.poolName || (pool ? pool.name : '?'))], midTokenSyms: [], pct, tvl: pool ? (pool.tvl || 0) : 0 };
    });
  } else if ((quote.source === 'curve-multi-path' || quote.source === 'curve-graph-split') && quote.route.length > 1) {
    const totalInput = BigInt(quote.inputAmountWei);
    multiPaths = quote.route.map(pathRoute => {
      const pct = totalInput > 0n ? Number(BigInt(pathRoute.chunkWei || 0) * 10000n / totalInput) / 100 : 0;
      const legs = pathRoute.legs || [];
      const poolNames = legs.map(l => {
        const pool = allPools.find(p => p.address.toLowerCase() === (l.pool || '').toLowerCase());
        return _shortPoolName(l.poolName || (pool ? pool.name : '?'));
      });
      const midTokenSyms = (pathRoute._midTokens || []).map(t => t.symbol || '???');
      const tvl = Math.min(...legs.map(l => {
        const pool = allPools.find(p => p.address.toLowerCase() === (l.pool || '').toLowerCase());
        return pool ? (pool.tvl || 0) : 0;
      }));
      return { poolNames, midTokenSyms, pct, tvl };
    });
  } else if (quote.source === 'curve-router' && quote.route.length >= 2) {
    const poolNames = [];
    const midTokenSyms = [];
    for (let i = 0; i < quote.route.length; i++) {
      const leg = quote.route[i];
      const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
      poolNames.push(_shortPoolName(leg.poolName || (pool ? pool.name : '?')));
      if (i < quote.route.length - 1) {
        const mts = quote._midTokens || (quote._midToken ? [quote._midToken] : []);
        midTokenSyms.push(mts[i]?.symbol || '?');
      }
    }
    multiPaths = [{ poolNames, midTokenSyms, pct: 100, tvl: 0 }];
  } else if (quote.route.length === 1) {
    const leg = quote.route[0];
    const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
    multiPaths = [{ poolNames: [_shortPoolName(leg.poolName || (pool ? pool.name : '?'))], midTokenSyms: [], pct: 100, tvl: pool ? (pool.tvl || 0) : 0 }];
  }

  if (multiPaths.length > 0) {
    pathEl.innerHTML = _buildMultiPathSVG(fromSym, toSym, multiPaths);
  }

  viz.classList.add('show');

  // Update route info text
  const routeEl = document.getElementById('tradePairRouteInfo');
  if (routeEl) {
    const routeParts = quote.route.map(r => _shortPoolName(r.poolName || r.exchange || '?')).filter(x => x && x !== '?');
    routeEl.textContent = routeParts.length > 0
      ? routeParts.join(' -> ')
      : (quote.sourceName || quote.source || 'Direct');
  }
}

function renderAggComparison(bestQuote) {
  const container = document.getElementById('tradeAggCompare');
  const rowsEl = document.getElementById('tradeAggRows');
  if (!container || !rowsEl) return;

  // Feature-flagged: hide until multiple aggregators are integrated.
  if (!SHOW_QUOTE_COMPARISON) {
    container.classList.remove('show');
    container.style.display = 'none';
    return;
  }

  const allQuotes = bestQuote.allQuotes || [bestQuote];
  if (allQuotes.length <= 1) {
    // Only one source — no comparison needed but still show it
    container.classList.remove('show');
    return;
  }

  const toSym = tradeSelectedTo.symbol;

  // Consolidate Curve strategies into one "Curve" entry (best of direct/router/split)
  const curveQuotes = allQuotes.filter(q => (q.source || '').startsWith('curve-'));
  const otherQuotes = allQuotes.filter(q => !(q.source || '').startsWith('curve-'));
  const bestCurve = curveQuotes.length > 0 ? curveQuotes.reduce((a, b) => a.outputAmount > b.outputAmount ? a : b) : null;
  const consolidated = [];
  if (bestCurve) {
    const cq = { ...bestCurve, sourceName: 'Curve', _curveType: bestCurve.source.replace('curve-', '') };
    consolidated.push(cq);
  }
  consolidated.push(...otherQuotes);
  // Sort by output descending
  consolidated.sort((a, b) => b.outputAmount - a.outputAmount);

  if (consolidated.length <= 0) { container.classList.remove('show'); return; }

  let html = '';
  for (let i = 0; i < consolidated.length; i++) {
    const q = consolidated[i];
    const isBest = i === 0;
    const amount = parseFloat(q.outputAmount).toFixed(4);
    const routeDesc = q.route.map(r => _shortPoolName(r.poolName || r.exchange || '?')).join(' + ');
    const sourceLabel = q.sourceName || q.source;
    const viaText = q._curveType ? `via ${q._curveType}: ${routeDesc}` : `via ${routeDesc}`;

    html += `<div class="trade-agg-row${isBest ? ' best' : ''}">
      <span class="agg-source">${sourceLabel}${isBest ? '<span class="agg-badge">BEST</span>' : ''}</span>
      <span class="agg-amount">${amount} ${toSym}</span>
      <span class="agg-via" title="${viaText}">${viaText}</span>
    </div>`;
  }

  rowsEl.innerHTML = html;
  container.classList.add('show');
}

function hideAggCompare() {
  const container = document.getElementById('tradeAggCompare');
  if (container) container.classList.remove('show');
  const toInput = document.getElementById('tradePairToAmt');
  if (toInput) toInput.value = '';
  // Reset gas estimate UI
  _lastTradeQuote = null;
  const gasEl = document.getElementById('tradePairGas');
  if (gasEl) { gasEl.textContent = '--'; gasEl.className = 'gas-value'; }
  const ba = document.getElementById('tradePairGasBreakdown');
  if (ba) ba.style.display = 'none';
  const bs = document.getElementById('tradePairGasSwapBreakdown');
  if (bs) bs.style.display = 'none';
}

// ============================================================
// GAS ESTIMATION (shared with swap.js via window.estimateSwapGas)
// ============================================================

// Cached ETH/USD price (refreshed every 60s). Public, simple, no key.
let _ethUsdCache = { price: null, ts: 0 };
const _ETH_USD_TTL = 60000;

async function _getEthUsdPrice() {
  // Return fresh cache
  if (_ethUsdCache.price && Date.now() - _ethUsdCache.ts < _ETH_USD_TTL) {
    return _ethUsdCache.price;
  }
  // Strategy: read ETH/USD from Curve prices API (consistent with rest of app),
  // fallback to public Coinbase ticker, finally last cached value (even if stale).
  try {
    const r = await fetch('https://prices.curve.finance/v1/usd_price/ethereum/0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    if (r.ok) {
      const j = await r.json();
      const price = j?.data?.usd_price || j?.usd_price;
      if (price && price > 0) {
        _ethUsdCache = { price: parseFloat(price), ts: Date.now() };
        return _ethUsdCache.price;
      }
    }
  } catch { /* fallback */ }
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/ETH-USD/spot');
    if (r.ok) {
      const j = await r.json();
      const price = parseFloat(j?.data?.amount);
      if (price && price > 0) {
        _ethUsdCache = { price, ts: Date.now() };
        return price;
      }
    }
  } catch { /* fallback */ }
  // Stale cache (better than nothing)
  return _ethUsdCache.price;
}

// Generic eth_* RPC helper (uses same provider list as eth_call rpcCall in app.js).
async function _ethRpc(method, params) {
  // Wait for cold-start probe to settle so we use latency-sorted order.
  if (typeof window._warmRpcs === 'function') {
    try { await window._warmRpcs(); } catch { /* non-fatal */ }
  }
  const list = (typeof window.getOrderedRpcs === 'function')
    ? window.getOrderedRpcs()
    : ETH_RPCS;
  const body = JSON.stringify({ jsonrpc: '2.0', method, params, id: Date.now() });
  let lastErr = null;
  for (let i = 0; i < list.length; i++) {
    const url = list[i];
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!r.ok) throw new Error('http-' + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      if (typeof window._markRpcOk === 'function') window._markRpcOk(url);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (typeof window._markRpcFail === 'function') window._markRpcFail(url);
    }
  }
  throw new Error('All RPCs failed for ' + method + ': ' + (lastErr ? lastErr.message : 'unknown'));
}

function _hexToBigInt(h) {
  if (!h) return 0n;
  return BigInt(h);
}

// Default fallback gas estimates (tuned to typical Curve mainnet usage).
// Used when eth_estimateGas fails (e.g., insufficient allowance, ETH balance).
const _GAS_FALLBACK = {
  approve: 50000n,
  directSwap: 200000n,
  routerSwap: 350000n,
  splitSwap: 250000n,
  wethWrap: 50000n, // WETH9 deposit/withdraw, ≈30-40k empirical, +headroom
  // Yield / portfolio actions
  addLiquidity: 350000n, // Curve add_liquidity: 200-400k typical (varies by pool size & rebalancing)
  removeLiquidity: 250000n, // remove_liquidity (balanced)
  removeLiquidityOneCoin: 280000n, // remove_liquidity_one_coin
  gaugeDeposit: 220000n, // gauge.deposit(amount[, ...])
  gaugeWithdraw: 200000n, // gauge.withdraw(amount[, ...])
  claimRewards: 180000n, // gauge.claim_rewards()
  minterMint: 250000n, // Minter.mint(gauge) — CRV emissions
  minterMintMany: 800000n, // Minter.mint_many(gauges[8])
};

/**
 * Estimate gas for the full swap flow (optional approval + swap).
 *
 * @param {Object} quote - Quote from router.getQuote()
 * @param {Object} router - CurveDEXRouter instance (must have buildSwapTx)
 * @param {string|null} userAddress - Wallet address (or null when not connected)
 * @returns {Promise<{
 *   approveGas: bigint, swapGas: bigint, gasPrice: bigint,
 *   ethPrice: number|null, totalUsd: number|null, approveNeeded: boolean,
 *   approveGasFallback: boolean, swapGasFallback: boolean,
 *   error: string|null
 * }>}
 */
async function estimateSwapGas(quote, router, userAddress) {
  const isETH = quote.fromToken && quote.fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
  const result = {
    approveGas: 0n,
    swapGas: 0n,
    gasPrice: 0n,
    ethPrice: null,
    totalUsd: null,
    approveNeeded: false,
    approveGasFallback: false,
    swapGasFallback: false,
    error: null,
  };

  // Build swap tx params (used for both estimateGas and fallback heuristics).
  let swapTx = null;
  let swapTxs = []; // for split-tx (multi-tx)
  try {
    // Some routers throw if userAddress is null; pass zero-address fallback.
    const fakeAddr = userAddress || '0x0000000000000000000000000000000000000000';
    const built = await router.buildSwapTx(quote, fakeAddr);
    if (built && built.type === 'multi-tx') {
      swapTxs = built.transactions || [];
      swapTx = swapTxs[0] || null;
    } else {
      swapTx = built;
    }
  } catch (e) {
    result.error = 'tx build: ' + (e.message || e);
  }

  // Heuristic fallback by source (used if estimateGas fails)
  const fallbackSwap = (() => {
    const src = quote.source || '';
    if (src === 'weth-wrap') return _GAS_FALLBACK.wethWrap;
    if (src === 'curve-direct') return _GAS_FALLBACK.directSwap;
    if (src === 'curve-router') return _GAS_FALLBACK.routerSwap;
    if (src === 'curve-split') return _GAS_FALLBACK.splitSwap * BigInt(Math.max(1, swapTxs.length));
    if (src === 'curve-multi-path' || src === 'curve-graph-split') return _GAS_FALLBACK.routerSwap;
    return _GAS_FALLBACK.directSwap;
  })();

  // Step 1: Gas price + ETH price in parallel
  let gasPriceHex = null;
  try {
    const [gp, ep] = await Promise.all([
      _ethRpc('eth_gasPrice', []),
      _getEthUsdPrice(),
    ]);
    gasPriceHex = gp;
    result.gasPrice = _hexToBigInt(gp);
    result.ethPrice = ep;
  } catch (e) {
    result.error = result.error || ('gas/eth price: ' + (e.message || e));
  }

  // Step 2: Approval check + estimate (only for ERC-20 with real wallet)
  if (!isETH && userAddress && swapTx && swapTx._spender) {
    try {
      // allowance(owner, spender) ABI-encoded
      const iface = new ethers.Interface(['function allowance(address,address) view returns (uint256)']);
      const allowanceCalldata = iface.encodeFunctionData('allowance', [userAddress, swapTx._spender]);
      const allowanceRaw = await rpcCall(allowanceCalldata, quote.fromToken);
      const allowance = _hexToBigInt(allowanceRaw);
      const needed = BigInt(quote.inputAmountWei);
      if (allowance < needed) {
        result.approveNeeded = true;
        // Build approve tx and estimate
        const approveIface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
        const approveData = approveIface.encodeFunctionData('approve', [
          swapTx._spender,
          // Approve max (matches ensureApproval flow)
          ethers.MaxUint256,
        ]);
        try {
          const estHex = await _ethRpc('eth_estimateGas', [{
            from: userAddress,
            to: quote.fromToken,
            data: approveData,
          }]);
          result.approveGas = _hexToBigInt(estHex);
        } catch {
          result.approveGas = _GAS_FALLBACK.approve;
          result.approveGasFallback = true;
        }
      }
    } catch (e) {
      // Allowance check failed — assume approval needed, use fallback
      result.approveNeeded = true;
      result.approveGas = _GAS_FALLBACK.approve;
      result.approveGasFallback = true;
    }
  }

  // Step 3: Swap gas estimate
  if (swapTx && swapTx.data) {
    // For multi-tx (split), sum estimates of each chunk
    const txsToEstimate = swapTxs.length > 0 ? swapTxs : [swapTx];

    // If approval is required AND user is connected, eth_estimateGas on the swap will revert
    // (allowance is 0). Use fallback heuristic. Without a wallet, also fallback (no `from`).
    const willRevert = result.approveNeeded || !userAddress;

    if (willRevert) {
      // Sum fallbacks (split = N chunks)
      let total = 0n;
      for (const tx of txsToEstimate) {
        const src = quote.source || '';
        if (src === 'weth-wrap') total += _GAS_FALLBACK.wethWrap;
        else if (src === 'curve-direct') total += _GAS_FALLBACK.directSwap;
        else if (src === 'curve-router') total += _GAS_FALLBACK.routerSwap;
        else if (src === 'curve-split') total += _GAS_FALLBACK.splitSwap;
        else if (src === 'curve-multi-path' || src === 'curve-graph-split') total += _GAS_FALLBACK.routerSwap;
        else total += _GAS_FALLBACK.directSwap;
      }
      result.swapGas = total;
      result.swapGasFallback = true;
    } else {
      let totalEst = 0n;
      let anyFallback = false;
      for (const tx of txsToEstimate) {
        try {
          const params = {
            from: userAddress,
            to: tx.to,
            data: tx.data,
          };
          if (tx.value && BigInt(tx.value) > 0n) {
            params.value = '0x' + BigInt(tx.value).toString(16);
          }
          const estHex = await _ethRpc('eth_estimateGas', [params]);
          totalEst += _hexToBigInt(estHex);
        } catch {
          totalEst += fallbackSwap;
          anyFallback = true;
        }
      }
      result.swapGas = totalEst;
      result.swapGasFallback = anyFallback;
    }
  } else {
    result.swapGas = fallbackSwap;
    result.swapGasFallback = true;
  }

  // Total in USD
  if (result.ethPrice && result.gasPrice > 0n) {
    const totalGas = result.approveGas + result.swapGas;
    // wei = gasPrice * totalGas; USD = wei / 1e18 * ethPrice
    const weiCost = result.gasPrice * totalGas;
    result.totalUsd = Number(weiCost) / 1e18 * result.ethPrice;
  }

  return result;
}

// Format a gas-cost {gas, gasPrice, ethPrice} into a "$X.XX (~NNk gas)" string.
function _formatGasCost(gas, gasPrice, ethPrice) {
  if (!gas || !gasPrice) return '--';
  const gasNum = Number(gas);
  const gasStr = gasNum >= 1000 ? `${(gasNum / 1000).toFixed(0)}k` : `${gasNum}`;
  if (!ethPrice) return `~${gasStr} gas`;
  const usd = Number(gasPrice * gas) / 1e18 * ethPrice;
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)} (~${gasStr} gas)`;
}

// Render gas estimation for the trade page.
async function renderTradeGasEstimate(quote, router) {
  const gasRow = document.getElementById('tradePairGasRow');
  const gasEl = document.getElementById('tradePairGas');
  const breakdownApprove = document.getElementById('tradePairGasBreakdown');
  const breakdownSwap = document.getElementById('tradePairGasSwapBreakdown');
  const approveEl = document.getElementById('tradePairGasApprove');
  const swapEl = document.getElementById('tradePairGasSwap');
  if (!gasEl) return;

  // Loading state
  gasEl.textContent = 'estimating...';
  gasEl.className = 'gas-value loading';
  if (breakdownApprove) breakdownApprove.style.display = 'none';
  if (breakdownSwap) breakdownSwap.style.display = 'none';

  try {
    const r = await estimateSwapGas(quote, router, walletAddress || null);
    // Stale-quote guard: only render if quote is still the latest
    if (quote !== _lastTradeQuote) return;

    const isETH = quote.fromToken && quote.fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
    if (!r.gasPrice || r.gasPrice === 0n) {
      gasEl.textContent = 'unavailable';
      gasEl.className = 'gas-value error';
      return;
    }

    const totalGas = r.approveGas + r.swapGas;
    const totalLabel = _formatGasCost(totalGas, r.gasPrice, r.ethPrice);
    const fallbackHint = (r.swapGasFallback || r.approveGasFallback) ? ' (est)' : '';
    const walletHint = walletAddress ? '' : ' (preview)';
    gasEl.textContent = totalLabel + fallbackHint + walletHint;
    gasEl.className = 'gas-value';

    // Show breakdown rows when there's something to break down
    if (breakdownApprove && breakdownSwap && approveEl && swapEl) {
      if (r.approveNeeded || (!isETH && !walletAddress)) {
        breakdownApprove.style.display = '';
        approveEl.textContent = r.approveNeeded
          ? _formatGasCost(r.approveGas, r.gasPrice, r.ethPrice)
          : (isETH ? 'not needed' : 'check on connect');
      } else {
        breakdownApprove.style.display = '';
        approveEl.textContent = 'not needed';
      }
      breakdownSwap.style.display = '';
      swapEl.textContent = _formatGasCost(r.swapGas, r.gasPrice, r.ethPrice);
    }
  } catch (e) {
    if (quote !== _lastTradeQuote) return;
    console.warn('gas estimate (trade) failed:', e);
    gasEl.textContent = 'unavailable';
    gasEl.className = 'gas-value error';
  }
}

// Track latest quote to discard stale gas results.
let _lastTradeQuote = null;

// ============================================================
// UNIVERSAL GAS ESTIMATION HELPERS (used by yield.js, portfolio.js)
// Exposed on window so non-swap flows (stake/unstake/claim/deposit/
// withdraw/deposit&stake) can show gas estimates the same way swap does.
// ============================================================

/**
 * Estimate gas for an arbitrary contract call via eth_estimateGas.
 * Returns BigInt gas units. Falls back to provided default on revert.
 *
 * @param {Object} params
 * @param {string} params.from - sender (wallet) address
 * @param {string} params.to - target contract address
 * @param {string} params.data - calldata hex
 * @param {bigint|null} [params.value] - msg.value in wei
 * @param {bigint} [params.fallback] - fallback gas units when estimateGas reverts
 * @returns {Promise<{gas: bigint, fallback: boolean, error: string|null}>}
 */
async function estimateContractGas({ from, to, data, value, fallback }) {
  const fb = fallback || 200000n;
  if (!to || !data) return { gas: fb, fallback: true, error: 'missing to/data' };
  try {
    const params = { to, data };
    if (from) params.from = from;
    if (value && BigInt(value) > 0n) params.value = '0x' + BigInt(value).toString(16);
    const estHex = await _ethRpc('eth_estimateGas', [params]);
    return { gas: _hexToBigInt(estHex), fallback: false, error: null };
  } catch (e) {
    return { gas: fb, fallback: true, error: e.message || String(e) };
  }
}

/**
 * Build calldata for ERC20.approve(spender, amount).
 */
function _buildApproveCalldata(spender, amount) {
  const iface = new ethers.Interface(['function approve(address,uint256) returns (bool)']);
  return iface.encodeFunctionData('approve', [spender, amount]);
}

/**
 * Read allowance(owner, spender) on an ERC20 token via eth_call.
 * Returns BigInt; 0n on error.
 */
async function _readAllowance(token, owner, spender) {
  try {
    const iface = new ethers.Interface(['function allowance(address,address) view returns (uint256)']);
    const data = iface.encodeFunctionData('allowance', [owner, spender]);
    const raw = await rpcCall(data, token);
    return _hexToBigInt(raw);
  } catch { return 0n; }
}

/**
 * Estimate a multi-step flow (e.g. approve + stake, or approve + add_liquidity + approve + deposit).
 *
 * @param {Array<Object>} steps - each step: {label, from, to, data, value?, fallback?, skip?}
 *   skip=true means this step is not needed (e.g. allowance already set) — it contributes 0 gas.
 * @param {string|null} userAddress
 * @returns {Promise<{
 *   steps: Array<{label, gas: bigint, fallback: boolean, skipped: boolean}>,
 *   totalGas: bigint, gasPrice: bigint, ethPrice: number|null,
 *   totalUsd: number|null, anyFallback: boolean, error: string|null
 * }>}
 */
async function estimateMultiStepGas(steps, userAddress) {
  const result = {
    steps: [],
    totalGas: 0n,
    gasPrice: 0n,
    ethPrice: null,
    totalUsd: null,
    anyFallback: false,
    error: null,
  };
  // Gas price + ETH/USD price in parallel
  try {
    const [gp, ep] = await Promise.all([
      _ethRpc('eth_gasPrice', []).catch(() => null),
      _getEthUsdPrice().catch(() => null),
    ]);
    if (gp) result.gasPrice = _hexToBigInt(gp);
    if (ep) result.ethPrice = ep;
  } catch (e) { result.error = 'gas/eth price: ' + (e.message || e); }

  // Estimate each non-skipped step. estimateContractGas tolerates missing wallet
  // (omits `from`) — node may revert, fallback is used.
  for (const step of steps) {
    if (step.skip) {
      result.steps.push({ label: step.label, gas: 0n, fallback: false, skipped: true });
      continue;
    }
    const r = await estimateContractGas({
      from: userAddress,
      to: step.to,
      data: step.data,
      value: step.value,
      fallback: step.fallback || 200000n,
    });
    if (r.fallback) result.anyFallback = true;
    result.totalGas += r.gas;
    result.steps.push({ label: step.label, gas: r.gas, fallback: r.fallback, skipped: false });
  }
  if (result.gasPrice > 0n && result.ethPrice) {
    result.totalUsd = Number(result.gasPrice * result.totalGas) / 1e18 * result.ethPrice;
  }
  return result;
}

/**
 * Render a one-line gas summary into a target element.
 * @param {HTMLElement} el - target span/div
 * @param {Object} r - return object from estimateMultiStepGas
 * @param {Object} [opts] - {hasWallet: boolean, prefix: string}
 */
function renderGasLine(el, r, opts) {
  if (!el) return;
  const hasWallet = opts && 'hasWallet' in opts ? opts.hasWallet : true;
  const prefix = (opts && opts.prefix) || '';
  if (!r || !r.gasPrice || r.gasPrice === 0n) {
    el.textContent = prefix + 'unavailable';
    el.className = 'gas-value error';
    return;
  }
  const totalLabel = _formatGasCost(r.totalGas, r.gasPrice, r.ethPrice);
  const fallbackHint = r.anyFallback ? ' (est)' : '';
  const walletHint = hasWallet ? '' : ' (preview)';
  el.textContent = prefix + totalLabel + fallbackHint + walletHint;
  el.className = 'gas-value';
}

// Expose to swap.js, yield.js, portfolio.js
window.estimateSwapGas = estimateSwapGas;
window._formatGasCost = _formatGasCost;
window._ethRpc = _ethRpc;
window._getEthUsdPrice = _getEthUsdPrice;
window._GAS_FALLBACK = _GAS_FALLBACK;
window._hexToBigInt = _hexToBigInt;
window._buildApproveCalldata = _buildApproveCalldata;
window._readAllowance = _readAllowance;
window.estimateContractGas = estimateContractGas;
window.estimateMultiStepGas = estimateMultiStepGas;
window.renderGasLine = renderGasLine;

// Debounced quote fetch on amount input
document.getElementById('tradePairFromAmt').addEventListener('input', () => {
  clearTimeout(tradeQuoteDebounce);
  tradeQuoteDebounce = setTimeout(fetchTradeQuote, 500);
  updateTradePairButton();
});

// Also update the swapTradePairDirection to work with free token selection
const _origSwapTradePairDirection = swapTradePairDirection;
swapTradePairDirection = function() {
  if (tradeSelectedFrom && tradeSelectedTo) {
    const tmp = tradeSelectedFrom;
    tradeSelectedFrom = tradeSelectedTo;
    tradeSelectedTo = tmp;
    updateTradeTokenUI('from', tradeSelectedFrom);
    updateTradeTokenUI('to', tradeSelectedTo);
    onTradeTokensChanged();
    // Re-fetch quote if amount entered
    const fromAmt = document.getElementById('tradePairFromAmt').value;
    if (fromAmt && parseFloat(fromAmt) > 0) {
      clearTimeout(tradeQuoteDebounce);
      tradeQuoteDebounce = setTimeout(fetchTradeQuote, 300);
    }
  } else {
    _origSwapTradePairDirection();
  }
};

// Sync free token selection when pair is selected from sidebar
const _origSelectTokenPair = selectTokenPair;
selectTokenPair = async function(pairName) {
  // Loading-ize stale quote/rate/route/gas/balance values BEFORE async work
  // so old pair's data doesn't linger during sidebar pair switch.
  const _fromAmt = document.getElementById('tradePairFromAmt')?.value;
  if (typeof _setTradePairQuoteLoading === 'function' && _fromAmt && parseFloat(_fromAmt) > 0) {
    _setTradePairQuoteLoading();
  } else {
    const fromBal = document.getElementById('tradePairFromBal');
    if (fromBal) fromBal.textContent = 'Balance: ...';
    const toBal = document.getElementById('tradePairToBal');
    if (toBal) toBal.textContent = 'Balance: ...';
  }

  await _origSelectTokenPair(pairName);
  // Sync free token selectors
  if (selectedPair) {
    const baseAddr = (selectedPair.baseAddr || '').toLowerCase();
    const quoteAddr = (selectedPair.quoteAddr || '').toLowerCase();
    tradeSelectedFrom = tradeTokenList.find(t => t.address.toLowerCase() === baseAddr) || null;
    tradeSelectedTo = tradeTokenList.find(t => t.address.toLowerCase() === quoteAddr) || null;
    // Update route viz
    updateTradeRouteViz(selectedPair);
    // Update button and load balances
    updateTradePairButton();
    if (walletAddress) loadTradePairBalances();
    // If amount is entered, retrigger quote so loading placeholders get replaced.
    // (Original selectTokenPair didn't trigger fetchTradeQuote; without this
    // the user would be stuck on '...' after switching pair from the sidebar.)
    const fromAmt = document.getElementById('tradePairFromAmt')?.value;
    if (fromAmt && parseFloat(fromAmt) > 0) {
      clearTimeout(tradeQuoteDebounce);
      tradeQuoteDebounce = setTimeout(fetchTradeQuote, 300);
    }
  }
};

// Sync token sidebar highlight whenever From token changes
function updateTokenSidebarHighlight() {
  const activeAddr = tradeSelectedFrom ? tradeSelectedFrom.address.toLowerCase() : null;
  document.querySelectorAll('.token-item').forEach(el => {
    el.classList.toggle('active', activeAddr && el.dataset.addr && el.dataset.addr.toLowerCase() === activeAddr);
  });
}

// Wrap onTradeTokensChanged to update sidebar highlight
const _origOnTradeTokensChanged = onTradeTokensChanged;
onTradeTokensChanged = function() {
  _origOnTradeTokensChanged();
  updateTokenSidebarHighlight();
  try { updateTradeRichHeader(); } catch (e) { /* non-fatal */ }
};

// ============================================================
// TRADE: Rich Header (Binance-style) — favorites, icons, tags,
// 24h H/L/Vol(base)/Vol(USD)/TVL. Updated when pair changes.
// ============================================================
const _STABLES_RICH = new Set(['USDC','USDT','DAI','crvUSD','FRAX','LUSD','TUSD','sUSD','USDD','GHO','PYUSD','USD0','eUSD','mkUSD','USDe','USDG','USDP','BUSD','MIM','UST','RAI','alUSD','DOLA','MAI','USDx','sDAI','sUSDe','USR']);

function _tradeFavorites() {
  try { return JSON.parse(localStorage.getItem('curvedex.favorites') || '[]'); } catch { return []; }
}
function _tradeFavoriteSave(list) {
  try { localStorage.setItem('curvedex.favorites', JSON.stringify(Array.from(new Set(list)))); } catch {}
}
function _tradeFavoriteKey(pair) {
  if (!pair || !pair.pool) return null;
  return (pair.pool.address || pair.poolAddr || '').toLowerCase() + '|' + (pair.base || '') + '/' + (pair.quote || '');
}
function _tradeIsFavorite(pair) {
  const k = _tradeFavoriteKey(pair); if (!k) return false;
  return _tradeFavorites().includes(k);
}
function _tradeToggleFavorite() {
  if (!selectedPair) return;
  const k = _tradeFavoriteKey(selectedPair); if (!k) return;
  let list = _tradeFavorites();
  if (list.includes(k)) list = list.filter(x => x !== k);
  else list.push(k);
  _tradeFavoriteSave(list);
  const star = document.getElementById('tradeFavoriteStar');
  if (star) star.classList.toggle('active', list.includes(k));
  try { renderTradeFavorites(); } catch (e) { /* non-fatal */ }
}

// Render favorites list in left sidebar (trade view).
// Hidden when empty. Each row: token icons + pair name + small TVL value.
// Click navigates to that pair via existing selectTokenPair().
// Uses reference April-25 storage (_FAV_STORAGE_KEY = curvedex_favorites: array of objects).
function renderTradeFavorites() {
  const wrap = document.getElementById('tradeFavoritesSidebar');
  const list = document.getElementById('tradeFavoritesList');
  if (!wrap || !list) return;
  const favs = (typeof _getFavorites === 'function') ? _getFavorites() : [];
  if (!favs.length) {
    wrap.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  if (!Array.isArray(tokenPairs) || !tokenPairs.length) {
    wrap.style.display = 'none';
    return;
  }
  // Match each favorite object against current tokenPairs (both directions).
  const items = [];
  const seen = new Set();
  for (const f of favs) {
    if (!f) continue;
    const fa = (f.fromAddr || '').toLowerCase();
    const ta = (f.toAddr || '').toLowerCase();
    const poolLc = (f.pool || '').toLowerCase();
    if (!fa || !ta) continue; // pool-only favorites (Pools view) — skip in trade sidebar
    // Try exact direction first
    let pair = tokenPairs.find(p =>
      (p.poolAddr || p.pool?.address || '').toLowerCase() === poolLc
      && (p.baseAddr || '').toLowerCase() === fa
      && (p.quoteAddr || '').toLowerCase() === ta
    );
    // Fallback: same pool, reverse direction (tokenPairs stores one direction per pair)
    if (!pair) {
      pair = tokenPairs.find(p =>
        (p.poolAddr || p.pool?.address || '').toLowerCase() === poolLc
        && (p.baseAddr || '').toLowerCase() === ta
        && (p.quoteAddr || '').toLowerCase() === fa
      );
    }
    // Fallback by symbol pair (both directions)
    if (!pair) {
      pair = tokenPairs.find(p => (p.base === f.base && p.quote === f.quote) || (p.base === f.quote && p.quote === f.base));
    }
    if (!pair) continue;
    if (seen.has(pair.name)) continue;
    seen.add(pair.name);
    items.push(pair);
  }
  if (!items.length) {
    wrap.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  const selectedKey = selectedPair ? selectedPair.name : null;
  list.innerHTML = items.map(p => {
    const tvlText = p.tvl >= 1e6 ? '$' + (p.tvl / 1e6).toFixed(1) + 'M'
                  : p.tvl >= 1e3 ? '$' + (p.tvl / 1e3).toFixed(0) + 'K'
                  : '$' + (p.tvl || 0).toFixed(0);
    const baseIcon = p.baseAddr ? `<img src="${_tokenIconUrl(p.baseAddr)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
    const quoteIcon = p.quoteAddr ? `<img src="${_tokenIconUrl(p.quoteAddr)}" alt="" loading="lazy" onerror="this.style.display='none'">` : '';
    const isActive = p.name === selectedKey;
    // Use single quotes inside JS attr to avoid breaking on names with spaces.
    const safeName = String(p.name).replace(/'/g, "\\'");
    return `<div class="sidebar-fav-item${isActive ? ' active' : ''}" data-pair="${p.name}" onclick="selectTokenPair('${safeName}')">
      <div class="sidebar-fav-icons">${baseIcon}${quoteIcon}</div>
      <div class="sidebar-fav-name">${p.base} / ${p.quote}</div>
      <div class="sidebar-fav-tvl">${tvlText}</div>
    </div>`;
  }).join('');
  wrap.style.display = '';
  _applyFavCollapse('trade');
}

function _tradeFmtAmount(n) {
  if (n == null || !isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1e9) return (n/1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n/1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n/1e3).toFixed(2) + 'K';
  return n.toFixed(2);
}
function _tradeFmtUSD(n) {
  if (n == null || !isFinite(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n/1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n/1e3).toFixed(2) + 'K';
  return '$' + n.toFixed(2);
}

function _tradePoolTags(pool, pair) {
  const tags = [];
  if (!pool) return tags;
  const coins = Array.isArray(pool.coins) ? pool.coins : [];
  const allStable = coins.length >= 2 && coins.every(c => _STABLES_RICH.has(c));
  const hasCrvUsd = coins.some(c => c === 'crvUSD');
  const assetType = (pool.assetType || '').toLowerCase();
  const registryId = (pool.registryId || '').toLowerCase();
  const isCrypto = registryId.includes('crypto') || assetType === 'crypto' || assetType === '4' || (!allStable && !hasCrvUsd && coins.length > 0);
  if (hasCrvUsd) tags.push({ cls: 'crvusd', label: 'crvUSD' });
  else if (allStable || assetType === 'usd' || assetType === '0') tags.push({ cls: 'stable', label: 'Stable' });
  else if (isCrypto) tags.push({ cls: 'crypto', label: 'Crypto' });
  // Hot: 24h volume > $5M
  const vol = pool.volumeUSD || pair?.volume || 0;
  if (vol > 5e6) tags.push({ cls: 'hot', label: '\uD83D\uDD25 Hot' });
  // High TVL: > $10M
  const tvl = pool.tvl || pair?.tvl || 0;
  if (tvl > 10e6) tags.push({ cls: 'high-tvl', label: '\uD83D\uDC8E High TVL' });
  // New: pool age < 30 days (creationBlock based — can't easily; use createdTimestamp/ageInDays if present)
  const createdTs = pool.creationTimestamp || pool.creationBlockTimestamp || pool.createdAt;
  if (createdTs) {
    const ageDays = (Date.now()/1000 - Number(createdTs)) / 86400;
    if (ageDays >= 0 && ageDays < 30) tags.push({ cls: 'new', label: '\uD83C\uDD95 New' });
  }
  return tags;
}

function _tradeShortPoolName(name) {
  if (!name) return '';
  return name.replace(/^Curve\.fi\s+/i, '').replace(/\s+pool$/i, '').slice(0, 30);
}

function _trade24hHighLow(candles) {
  // last 24h: hourly = last 24, 4h = last 6, 1d = last 1
  if (!Array.isArray(candles) || candles.length === 0) return { high: null, low: null };
  let count = 24;
  if (typeof tradePairUnit !== 'undefined' && tradePairUnit === 'day') count = 1;
  else if (typeof tradePairAgg !== 'undefined' && tradePairAgg === 4) count = 6;
  else if (typeof tradePairAgg !== 'undefined' && tradePairAgg === 1) count = 24;
  const slice = candles.slice(-count);
  let h = -Infinity, l = Infinity;
  for (const c of slice) { if (c.high > h) h = c.high; if (c.low < l) l = c.low; }
  if (!isFinite(h) || !isFinite(l)) return { high: null, low: null };
  return { high: h, low: l };
}

// Pools known to return 404 от Curve volume API (no candle-resolution data).
// stETH/ETH (0xDC24316b9AE028F1497c275EB9192a3Ea0f67022) — perma-404 since
// 2026-05-13 console log. Hard-coded so first request не засирает console.
// Runtime additions: любой пул который 404'ил один раз → запоминаем и
// больше не fetch'им (silent fallback на pool.volumeUSD).
const _NO_VOLUME_API_POOLS = new Set([
  '0xdc24316b9ae028f1497c275eb9192a3ea0f67022',
]);

// Single-pool 24h volume via Curve API. Returns {volBase, volUsd, poolName}.
// Pools in _NO_VOLUME_API_POOLS skipped (silent fallback на pool.volumeUSD).
async function _trade24hVolumesSinglePool(pool, mainAddr, refAddr) {
  if (!pool || !pool.address || !mainAddr || !refAddr) return null;
  const fallbackUsd = pool.volumeUSD || 0;
  const poolKey = String(pool.address).toLowerCase();
  const fallbackResult = fallbackUsd > 0
    ? { volBase: 0, volUsd: fallbackUsd, poolName: pool.name || '' }
    : null;
  // Pool в blacklist (perma-404) — сразу fallback, без сети
  if (_NO_VOLUME_API_POOLS.has(poolKey)) return fallbackResult;
  try {
    const start = Math.floor(Date.now()/1000) - 24*3600;
    const end = Math.floor(Date.now()/1000);
    const url = `${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${mainAddr}&reference_token=${refAddr}&start=${start}&end=${end}`;
    let resp;
    try {
      resp = await fetch(url);
    } catch (_netErr) {
      // Network error (offline, CORS, DNS) — silent fallback
      return fallbackResult;
    }
    if (!resp.ok) {
      // 404/5xx — добавляем в runtime blacklist чтобы повторные клики не
      // спамили console тем же 404. Swallow и fallback на pool-level.
      if (resp.status === 404) _NO_VOLUME_API_POOLS.add(poolKey);
      return fallbackResult;
    }
    let json;
    try { json = await resp.json(); }
    catch { return fallbackResult; }
    const arr = (json && json.data) || [];
    let volBase = 0, volUsd = 0;
    for (const d of arr) {
      volBase += d.volume || 0;
      volUsd += (d.volume_usd || d.volumeUsd || 0);
    }
    if (volUsd === 0) volUsd = fallbackUsd;
    return { volBase, volUsd, poolName: pool.name || '' };
  } catch { return fallbackResult; }
}

// 24h volumes for the active route (single or multi-hop).
// Single-hop: returns { volBase, volUsd, hopCount:1, sourcePoolCount:1, isBottleneck:false, perPool:[...] }.
// Multi-hop: bottleneck = MIN(volUsd) across all hops; volBase from the hop matching `pair.baseAddr` if present.
async function _trade24hVolumes(pair) {
  if (!pair || !pair.pool) return { volBase: null, volUsd: null, hopCount: 0, sourcePoolCount: 0, isBottleneck: false, perPool: [] };
  // Detect multi-hop via pair._multiRoute (set by quote sync). Each entry is a pool object.
  const route = Array.isArray(pair._multiRoute) ? pair._multiRoute : null;
  if (route && route.length >= 2) {
    // Multi-hop: each hop has its own (mainToken, refToken). Use _bfsTokens if present:
    // _bfsTokens = [from, mid1, mid2, ..., to] — length = hops + 1.
    const tokens = Array.isArray(route._bfsTokens) ? route._bfsTokens : null;
    const perPool = [];
    for (let i = 0; i < route.length; i++) {
      const p = route[i];
      let main, ref;
      if (tokens && tokens.length === route.length + 1) {
        main = tokens[i];
        ref = tokens[i + 1];
      } else {
        // Fallback: use pool's first 2 coins
        main = (p.coinsAddresses || [])[0];
        ref = (p.coinsAddresses || [])[1];
      }
      const v = await _trade24hVolumesSinglePool(p, main, ref);
      if (v && v.volUsd > 0) {
        perPool.push({ poolName: v.poolName || (p.name || `pool ${i+1}`), volUsd: v.volUsd, volBase: v.volBase });
      }
    }
    if (perPool.length === 0) {
      return { volBase: null, volUsd: null, hopCount: route.length, sourcePoolCount: 0, isBottleneck: true, perPool: [] };
    }
    // Bottleneck: min volUsd across hops
    const min = perPool.reduce((m, x) => x.volUsd < m.volUsd ? x : m, perPool[0]);
    return {
      volBase: null, // base-symbol volume not meaningful across mixed hops
      volUsd: min.volUsd,
      hopCount: route.length,
      sourcePoolCount: perPool.length,
      isBottleneck: true,
      perPool,
      bottleneckPoolName: min.poolName,
    };
  }
  // Single-hop path
  const pool = pair.pool;
  const coinAddrs = (pool.coinsAddresses || []).map(a => a.toLowerCase());
  const baseIdx = coinAddrs.indexOf((pair.baseAddr||'').toLowerCase());
  const quoteIdx = coinAddrs.indexOf((pair.quoteAddr||'').toLowerCase());
  if (baseIdx < 0 || quoteIdx < 0) {
    return { volBase: null, volUsd: pool.volumeUSD || pair.volume || null, hopCount: 1, sourcePoolCount: 1, isBottleneck: false, perPool: [] };
  }
  const main = pool.coinsAddresses[baseIdx];
  const ref = pool.coinsAddresses[quoteIdx];
  const v = await _trade24hVolumesSinglePool(pool, main, ref);
  if (!v) return { volBase: null, volUsd: pool.volumeUSD || pair.volume || null, hopCount: 1, sourcePoolCount: 1, isBottleneck: false, perPool: [] };
  return { volBase: v.volBase, volUsd: v.volUsd, hopCount: 1, sourcePoolCount: 1, isBottleneck: false, perPool: [] };
}

async function updateTradeRichHeader() {
  // Wrapper: delegates to reference April-25 _renderTradePairHeader (Binance-style 2-row header)
  // Keeps today's async volumes API refinement.
  const pair = (typeof selectedPair !== 'undefined') ? selectedPair : null;
  if (!pair) return;
  const pool = pair.pool || {};

  // Multi-hop detection: route via 2+ pools — H/L/Pool TVL/Vol(base) don't compose meaningfully.
  const isMultiHop = Array.isArray(pair._multiRoute) && pair._multiRoute.length >= 2;

  // Compute 24h stats from candles cache (today's window._tradeRichLastCandles).
  // For multi-hop the candles are synthetic (price product across hops) — H/L
  // are approximations of the synthetic price, not any single pool's H/L.
  // Show them anyway with a tooltip rather than blanking the cells.
  let stats = null;
  try {
    if (Array.isArray(window._tradeRichLastCandles) && window._tradeRichLastCandles.length > 0) {
      const candles = window._tradeRichLastCandles;
      const intervalSec = candles.length >= 2 ? Math.max(1, (candles[1].time || 0) - (candles[0].time || 0)) : 3600;
      stats = _compute24hStats(candles, intervalSec);
    }
  } catch (e) { /* non-fatal */ }

  // Render reference April-25 rich header (icons, pair, meta, price, change, tags, fav, TVL, OHLC row)
  _renderTradePairHeader(pair, stats, {}, window._tradeRichLastCandles || null);

  // Multi-hop: keep H/L from synthetic candles but tag with tooltip; Pool TVL
  // becomes sum across all pools in the route (with bottleneck note).
  if (isMultiHop) {
    const hopCount = pair._multiRoute.length;
    const hi = document.getElementById('tradeChartHigh24');
    const lo = document.getElementById('tradeChartLow24');
    const tvl = document.getElementById('tradeChartPoolTvl');
    const hlTip = `Synthetic price across ${hopCount} hops (product of pool prices)`;
    if (hi) hi.title = hlTip;
    if (lo) lo.title = hlTip;
    if (tvl) {
      let sumTvl = 0;
      let bottleneck = { tvl: Infinity, name: null };
      for (const hop of pair._multiRoute) {
        const t = Number(hop?.pool?.tvl || hop?.tvl || 0);
        if (t > 0) {
          sumTvl += t;
          if (t < bottleneck.tvl) bottleneck = { tvl: t, name: hop?.pool?.name || hop?.name || null };
        }
      }
      if (sumTvl > 0) {
        tvl.textContent = _tradeFmtUSD(sumTvl);
        tvl.title = `Sum of ${hopCount} pools` + (bottleneck.name ? ` (bottleneck: ${bottleneck.name} ${_tradeFmtUSD(bottleneck.tvl)})` : '');
      } else {
        tvl.textContent = '—';
        tvl.title = `Multi-hop (${hopCount} pools): TVL data unavailable`;
      }
    }
  }

  // Refine 24h volumes async
  const volBaseEl = document.getElementById('tradeChartVolBase');
  const volQuoteEl = document.getElementById('tradeChartVolQuote');
  if (volQuoteEl) {
    volQuoteEl.textContent = isMultiHop ? '—' : _tradeFmtUSD(pool.volumeUSD || pair.volume || 0);
    volQuoteEl.removeAttribute('title');
  }
  if (volBaseEl) {
    volBaseEl.textContent = isMultiHop ? '—' : '--';
    volBaseEl.removeAttribute('title');
  }
  try {
    const v = await _trade24hVolumes(pair);
    if (v.isBottleneck) {
      // Multi-hop bottleneck: show min vol across hops with explanatory tooltip.
      const tip = `min by ${v.sourcePoolCount} of ${v.hopCount} pools` + (v.bottleneckPoolName ? ` (bottleneck: ${v.bottleneckPoolName})` : '');
      if (volQuoteEl) {
        volQuoteEl.textContent = v.volUsd != null ? _tradeFmtUSD(v.volUsd) : '—';
        volQuoteEl.title = tip;
      }
      if (volBaseEl) {
        volBaseEl.textContent = '—';
        volBaseEl.title = `Multi-hop: base-token volume not meaningful (each hop trades different tokens)`;
      }
    } else {
      if (volBaseEl && v.volBase != null) {
        volBaseEl.textContent = _tradeFmtAmount(v.volBase);
        volBaseEl.removeAttribute('title');
      }
      if (volQuoteEl && v.volUsd != null) {
        volQuoteEl.textContent = _tradeFmtUSD(v.volUsd);
        volQuoteEl.removeAttribute('title');
      }
    }
  } catch (e) {}
}

// Mobile pool toggle

