// ============================================================
// CONSTANTS & CONFIG
// ============================================================

// HTML-escape helper for safe interpolation into innerHTML/template strings.
// Used wherever a third-party-API-sourced value (token symbol, pool name,
// address, label) lands in DOM. Factory pools allow permissionless metadata,
// so attacker-controlled `<img onerror=>` in a symbol field is real risk.
// Returns '' for null/undefined to keep template output clean.
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
window.escapeHtml = escapeHtml;

const API_BASE = 'https://api.curve.finance/v1';
const PRICES_BASE = 'https://prices.curve.finance/v1';
// Kept as Ethereum default for legacy callsites; new code should call
// getExplorerTxUrl(tx) which reads activeChainKey from CHAINS_CONFIG.
const ETHERSCAN = 'https://etherscan.io/tx/';
const REGISTRIES = ['main','crypto','factory','factory-crypto','factory-crvusd','factory-tricrypto','factory-twocrypto','factory-stable-ng'];
const CACHE_TTL = 30000;
// Public RPC pool. Initial order = real-browser-benchmarked 2026-05-01 from
// https://llama.box via 30x sequential eth_call get_virtual_price(). Full
// results in bench_rpc_results.md. Runtime cold-start probe (_warmRpcs)
// re-sorts per-client at page load; reactive failover (_markRpcFail + 60s
// cooldown) demotes endpoints that fail mid-session; background re-probe
// (_reprobeFailing every 90s) restores endpoints that flapped transiently.
//
// Per Nik directive msg 437 + msg 440 2026-05-01: free-only rotation, no
// request-counting against hidden per-provider limits, no permanent drop —
// public RPCs flap (CF 1015, 429, transient CORS) and recover; bench is a
// snapshot prior, not a whitelist. Endpoints below were degraded or
// failing during the 2026-05-01 22:14 bench run but are kept in the pool
// so they can recover and re-rank via the background probe loop. The
// cold-start probe + per-call latency-sorted ordering keep dead endpoints
// at the tail; users never wait on them while healthy peers exist.
//
// Excluded (structural fail, not transient): rpc.ankr.com/eth requires
// API key now; rpc.flashbots.net 403s on browser origin (filtered, not
// rate-limited). Both stay out until upstream policy changes.
const ETH_RPCS = [
  // bench top-tier (33-53ms p50, 100% success on bench day)
  // eth.rpc.blxrbdn.com удалён 2026-05-18: тестировщик Nik увидел 21k+ console
  // errors — endpoint отдаёт CORS error (no Access-Control-Allow-Origin) +
  // 429 Too Many Requests на его браузере/сети. Тот же класс что mevblocker
  // (line 59-66) и cloudflare-eth (line 67-69) — структурный per-IP/per-origin
  // rate limit. Каждый pair click триггерил probe → 5-15 RPC retries × все
  // endpoint cooldowns → буря в console. Убрано из дефолтного pool.
  'https://ethereum-rpc.publicnode.com',
  'https://ethereum.publicnode.com',
  'https://eth.drpc.org',
  // Added 2026-06-12 (Михаил: расширить failover-пул): probed with
  // Origin=llama.box — ACAO:* present AND real eth_call works. Из той же
  // проверки ОТСЕЯНЫ eth.meowrpc.com и rpc.flashbots.net: оба отвечают
  // HTTP 200 + ACAO:* на eth_blockNumber, но eth_call отдают error-body
  // («method not supported» / «not whitelisted») — ровно класс битых нод,
  // о котором предупреждал Михаил (200 ≠ работает).
  'https://eth-pokt.nodies.app',
  'https://eth.blockrazor.xyz',
  // Tenderly removed 2026-05-02: throttles to 408/429 after 3-4 sequential
  // calls per IP (per bench_rpc_results.md 2026-05-01). Structural rate
  // limit, not transient — keeping it cycles error spam in production.
  'https://eth.api.onfinality.io/public',
  'https://eth-mainnet.public.blastapi.io',
  'https://1rpc.io/eth',
  // rpc.mevblocker.io удалён 2026-05-18: тестировщик Denis F воспроизвёл 50/50
  // cold-start bug на Win+macOS — после ~130 успешных вызовов в сессии endpoint
  // начинает отдавать 429 (у Дениса) / CORS error без Access-Control-Allow-Origin
  // (репро в Playwright @ llama.box). Тот же структурный per-IP rate limit что
  // у Tenderly (line 53-55) — публичный endpoint mevblocker оптимизирован под
  // одиночные tx submit, не под multicall burst тысячи pool'ов. Recipe:
  // clear site data + reload → ~50% попыток зависает на 429/CORS-блокированном
  // mevblocker, если он попадает в топ latency-sorted очереди после probe.
  // cloudflare-eth.com удалён 2026-05-18: стабильно отдаёт CORS error в
  // браузере (Access-Control-Allow-Origin отсутствует). Тестировщик Denis F
  // увидел его в Network tab как красный пинг при cold-start probe.
  // eth.llamarpc.com удалён 2026-05-13: Playwright check на чистом бровсере
  // (без adblock) даёт тот же CORS-block что и у Ника — preflight без
  // Access-Control-Allow-Origin header. Структурный фейл, не adblock.
  // eth.merkle.io удалён 2026-05-13: возвращает No 'Access-Control-Allow-Origin'
  // header на preflight (CORS-блокирован у любого браузерного клиента, как
  // Tenderly раньше). Structural fail для browser-origin, не транзиент.
  // Excluded: rpc.payload.de + api.securerpc.com NXDOMAIN at deploy time
  // — DNS resolution failure is structural, no point cycling them.
];
let _rpcIdx = 0;

// ------------------------------------------------------------
// Multi-chain config (A2 wiring; data-layer hookup follows in A3)
// ------------------------------------------------------------
// Loaded from chains_config.json (built daily by collector/build_chain_config.py).
// `activeChainKey` is the Curve slug ('ethereum', 'arbitrum', ...); `activeChainId`
// is the numeric EVM chainId. Default = Ethereum mainnet for safe fallback when
// the config is absent or fetch fails.
//
// CHAINS_CONFIG_PATH is prefixed with window.__DYNAMIC_BASE (declared in
// index.html) so the static bundle can ship to IPFS while still fetching the
// daily-rebuilt config from the classical host. Empty base = same-origin
// (current behaviour, no breaking change).
const CHAINS_CONFIG_PATH = (typeof window !== 'undefined' && window.__DYNAMIC_BASE ? window.__DYNAMIC_BASE : '') + '/curvedex/chains_config.json';
let CHAINS_CONFIG = null;
let activeChainKey = 'ethereum';
let activeChainId = 1;

async function loadChainsConfig() {
  try {
    const resp = await fetch(CHAINS_CONFIG_PATH + '?v=' + (window.__APP_VERSION__ || ''));
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    CHAINS_CONFIG = await resp.json();
    // Restore persisted chain selection (clamped to known chains).
    const saved = localStorage.getItem('curvedex.activeChainKey');
    if (saved && CHAINS_CONFIG.chains && CHAINS_CONFIG.chains[saved]) {
      activeChainKey = saved;
      activeChainId = CHAINS_CONFIG.chains[saved].chainId;
    }
    populateChainSelector();
    // If a wallet is connected and on a chain that differs from our UI choice,
    // sync UI to wallet (wallet is the source of truth for signing chain).
    // No reload here — boot already happened on the persisted UI chain; the
    // mismatch self-corrects on the next chainChanged event from the wallet.
    if (typeof window.ethereum !== 'undefined') {
      try {
        const walletHex = await window.ethereum.request({ method: 'eth_chainId' });
        const walletId = parseInt(walletHex, 16);
        if (walletId && walletId !== activeChainId) {
          const match = Object.entries(CHAINS_CONFIG.chains).find(([, ch]) => ch.chainId === walletId);
          if (match) {
            const [walletKey] = match;
            console.log('[chains] wallet on', walletKey, '(chainId', walletId, ') vs UI', activeChainKey, '— syncing to wallet');
            localStorage.setItem('curvedex.activeChainKey', walletKey);
            // Reload so prefetch + RPC pool rebuild against the wallet chain.
            setTimeout(() => window.location.reload(), 60);
            return;
          }
        }
      } catch (_) {
        // wallet not unlocked yet or no eth_chainId support; ignore.
      }
    }
  } catch (e) {
    console.warn('[chains] config load failed, staying on Ethereum:', e.message);
  }
}

// Curve serves chain logos at this jsdelivr GitHub CDN path; falls back to a
// letter-circle if a given chain has no asset committed.
const CHAIN_ICON_CDN = 'https://cdn.jsdelivr.net/gh/curvefi/curve-assets/chains/';

function _chainIconUrl(key) {
  return CHAIN_ICON_CDN + encodeURIComponent(key) + '.png';
}
function _chainShortLabel(key, c) {
  return (c?.name || (key[0].toUpperCase() + key.slice(1))).replace(/\s+Mainnet$/i, '');
}
function _chainInitial(key) {
  return key.charAt(0).toUpperCase();
}

// Swap an <img> that 404s with an initial-letter circle span.
function _chainPickerImgError(img, key) {
  const span = document.createElement('span');
  span.className = (img.classList.contains('chain-picker-icon')
    ? 'chain-picker-fallback'
    : 'chain-picker-option-fallback');
  span.textContent = _chainInitial(key);
  img.replaceWith(span);
}
window._chainPickerImgError = _chainPickerImgError;

function populateChainSelector() {
  if (!CHAINS_CONFIG?.chains) return;
  const c = CHAINS_CONFIG.chains[activeChainKey];
  const iconEl = document.getElementById('chainPickerIcon');
  const fbEl = document.getElementById('chainPickerFallback');
  const btn = document.getElementById('chainPickerBtn');
  if (iconEl && fbEl && c) {
    fbEl.removeAttribute('data-active');
    fbEl.textContent = _chainInitial(activeChainKey);
    iconEl.hidden = false;
    iconEl.alt = _chainShortLabel(activeChainKey, c);
    iconEl.onerror = () => { iconEl.hidden = true; fbEl.setAttribute('data-active', ''); };
    iconEl.src = _chainIconUrl(activeChainKey);
    if (btn) btn.title = _chainShortLabel(activeChainKey, c);
  }
  const menu = document.getElementById('chainPickerMenu');
  if (menu) {
    const entries = Object.entries(CHAINS_CONFIG.chains);
    menu.innerHTML = entries.map(([key, ch]) => {
      const label = _chainShortLabel(key, ch);
      const active = key === activeChainKey ? ' active' : '';
      return `<button type="button" role="menuitem" class="chain-picker-option${active}" data-chain="${key}" onclick="setActiveChain('${key}'); closeChainPicker();">
        <img class="chain-picker-option-icon" src="${_chainIconUrl(key)}" alt="" width="18" height="18" onerror="_chainPickerImgError(this, '${key}')">
        <span>${label}</span>
      </button>`;
    }).join('');
  }
}

function toggleChainPicker(ev) {
  if (ev) ev.stopPropagation();
  const menu = document.getElementById('chainPickerMenu');
  const btn = document.getElementById('chainPickerBtn');
  if (!menu || !btn) return;
  const open = !menu.hasAttribute('hidden');
  if (open) {
    menu.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', 'false');
  } else {
    menu.removeAttribute('hidden');
    btn.setAttribute('aria-expanded', 'true');
    // Outside-click close: register once.
    setTimeout(() => {
      document.addEventListener('click', _closeChainPickerOnOutside, { once: true });
    }, 0);
  }
}
function closeChainPicker() {
  const menu = document.getElementById('chainPickerMenu');
  const btn = document.getElementById('chainPickerBtn');
  if (menu) menu.setAttribute('hidden', '');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}
function _closeChainPickerOnOutside(ev) {
  const picker = document.getElementById('chainPicker');
  if (picker && !picker.contains(ev.target)) closeChainPicker();
  else setTimeout(() => document.addEventListener('click', _closeChainPickerOnOutside, { once: true }), 0);
}
window.toggleChainPicker = toggleChainPicker;
window.closeChainPicker = closeChainPicker;

async function setActiveChain(key) {
  if (!CHAINS_CONFIG?.chains?.[key]) return;
  const prevKey = activeChainKey;
  if (prevKey === key) return;
  const c = CHAINS_CONFIG.chains[key];

  // If a wallet is connected, ask it to switch network first. Falls back to
  // wallet_addEthereumChain when the chain is not known to the wallet (4902).
  // User rejection (4001) aborts the switch — we keep prior local state.
  if (typeof window.ethereum !== 'undefined' && walletAddress) {
    const hexId = '0x' + c.chainId.toString(16);
    try {
      await window.ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: hexId }],
      });
    } catch (err) {
      if (err && err.code === 4902) {
        try {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: hexId,
              chainName: c.name || key,
              nativeCurrency: c.nativeCurrency && c.nativeCurrency.symbol
                ? c.nativeCurrency
                : { name: 'ETH', symbol: 'ETH', decimals: 18 },
              rpcUrls: Array.isArray(c.rpc) && c.rpc.length ? c.rpc : ETH_RPCS,
              blockExplorerUrls: c.explorer ? [c.explorer] : [],
            }],
          });
        } catch (addErr) {
          console.warn('[chains] wallet_addEthereumChain failed:', addErr);
          return;
        }
      } else if (err && err.code === 4001) {
        console.warn('[chains] wallet switch rejected by user');
        return;
      } else {
        // Network error / wallet busy — continue anyway. User can switch manually.
        console.warn('[chains] wallet_switchEthereumChain failed:', err);
      }
    }
  }

  activeChainKey = key;
  activeChainId = c.chainId;
  localStorage.setItem('curvedex.activeChainKey', key);
  console.log('[chains] active:', key, 'chainId:', activeChainId);
  // Chain switch requires a full reload: __cachePromise / __volumesPromise /
  // __gaugesPromise were resolved at boot for the previous chain and the RPC
  // pool / wallet provider / pool list are all hydrated from that data.
  setTimeout(() => window.location.reload(), 60);
}
window.setActiveChain = setActiveChain;

// URL builders that read activeChainKey / activeChainId. Falls back to
// 'ethereum' / 1 when CHAINS_CONFIG hasn't loaded yet so the legacy path is
// preserved. Multicall3 is the canonical 0xcA11... address — identical on
// every EVM chain Curve currently lists, no per-chain map needed.
function getChainKey() { return activeChainKey || 'ethereum'; }
// Per-chain API host. Curve Lite chains (e.g. Monad) live on a separate
// endpoint (api-core); falls back to the main API_BASE for full chains.
function apiBaseFor(key) {
  const c = CHAINS_CONFIG && CHAINS_CONFIG.chains && CHAINS_CONFIG.chains[key];
  return (c && c.apiBase) || API_BASE;
}
function getChainId() { return activeChainId || 1; }
function getExplorerBase() {
  const c = CHAINS_CONFIG?.chains?.[activeChainKey];
  return ((c?.explorer) || 'https://etherscan.io').replace(/\/$/, '');
}
function getExplorerTxUrl(tx) { return getExplorerBase() + '/tx/' + tx; }
function getExplorerAddressUrl(addr) { return getExplorerBase() + '/address/' + addr; }
function getExplorerTokenUrl(addr) { return getExplorerBase() + '/token/' + addr; }
function getChainRpcs() {
  const c = CHAINS_CONFIG?.chains?.[activeChainKey];
  if (c?.rpc?.length) return c.rpc;
  return ETH_RPCS;
}
// Wrapped-native ERC20 address for current chain (WETH on Ethereum/Arbitrum/Optimism/Base,
// WMATIC on Polygon, WXDAI on Gnosis, WAVAX on Avalanche, WBNB on BSC, etc).
// Returns Ethereum WETH as a defensive fallback so legacy callers keep working.
function getWrappedNativeAddr() {
  const c = CHAINS_CONFIG?.chains?.[activeChainKey];
  return (c?.wrappedNative || '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2').toLowerCase();
}
// Native gas-token symbol for current chain (ETH / XDAI / MATIC / AVAX / BNB / FTM / GLMR / ...).
function getNativeSymbol() {
  const c = CHAINS_CONFIG?.chains?.[activeChainKey];
  return (c?.nativeCurrency?.symbol) || 'ETH';
}
window.getChainKey = getChainKey;
window.getChainId = getChainId;
window.getWrappedNativeAddr = getWrappedNativeAddr;
window.getNativeSymbol = getNativeSymbol;
window.getExplorerBase = getExplorerBase;
window.getExplorerTxUrl = getExplorerTxUrl;
window.getExplorerAddressUrl = getExplorerAddressUrl;
window.getExplorerTokenUrl = getExplorerTokenUrl;
window.getChainRpcs = getChainRpcs;

// ------------------------------------------------------------
// Cold-start latency probe + reactive failover state
// ------------------------------------------------------------
// _rpcMeta: per-RPC runtime metadata, keyed by URL.
//   { lat: ms (Infinity = dead), lastFailAt: ms epoch, lastOkAt: ms epoch }
// _rpcOrderTs: epoch ms when the sorted order was last computed (TTL 1h).
// _rpcWarmInflight: Promise that resolves after the first warm-up completes;
//   subsequent calls await it so we don't re-probe in parallel. After
//   completion the value remains for the lifetime of the page (re-probe
//   triggered only by TTL expiry on next rpcCall).
// _RPC_COOLDOWN_MS: how long a failed RPC stays demoted before it can be
//   retried (60s). Re-failure resets the timer.
// _RPC_TTL_MS: how long the sorted order is trusted before re-probing (1h).
// _RPC_PROBE_MS: per-probe timeout during cold-start warm-up (1.2s).
const _rpcMeta = new Map();
let _rpcOrderTs = 0;
let _rpcWarmInflight = null;
const _RPC_COOLDOWN_MS = 60000;
const _RPC_TTL_MS = 3600 * 1000;
const _RPC_PROBE_MS = 1200;
const _RPC_LS_KEY = 'cdex_rpc_order_v1';

// Read persisted sorted order from localStorage if fresh (TTL 1h). Returns
// {urls: [...], ts: number} on hit, null on miss/stale/parse-fail. Persists
// across page reloads so a cold-start probe doesn't run on every page load —
// only after 1h or after explicit failure resets.
function _loadPersistedRpcOrder() {
  try {
    const raw = localStorage.getItem(_RPC_LS_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.urls) || !j.ts) return null;
    if (Date.now() - j.ts > _RPC_TTL_MS) return null;
    // Keep only URLs still present in current ETH_RPCS (defends against
    // pool changes shipped in a later deploy).
    const known = new Set(ETH_RPCS);
    const urls = j.urls.filter(u => known.has(u));
    if (urls.length < ETH_RPCS.length / 2) return null;
    return { urls, ts: j.ts };
  } catch { return null; }
}
function _savePersistedRpcOrder(urls) {
  try {
    localStorage.setItem(_RPC_LS_KEY, JSON.stringify({ urls, ts: Date.now() }));
  } catch { /* quota / private mode — silent */ }
}

// Probe one RPC with eth_blockNumber. Returns latency in ms on success,
// Infinity on failure/timeout. Records into _rpcMeta.
async function _probeRpc(url) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const tid = setTimeout(() => ctl.abort(), _RPC_PROBE_MS);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}',
      signal: ctl.signal,
    });
    clearTimeout(tid);
    if (!r.ok) throw new Error('http-' + r.status);
    const j = await r.json();
    if (!j || !j.result) throw new Error('no-result');
    const lat = Date.now() - t0;
    _rpcMeta.set(url, { lat, lastOkAt: Date.now(), lastFailAt: 0 });
    return lat;
  } catch (e) {
    _rpcMeta.set(url, { lat: Infinity, lastOkAt: 0, lastFailAt: Date.now() });
    return Infinity;
  }
}

// Warm up the RPC pool: probe all endpoints in parallel, sort by latency
// ascending, persist to localStorage. Idempotent (re-call within the same
// page load awaits the in-flight Promise, doesn't re-probe). Caller awaits
// this once before the first read; subsequent reads use cached order.
async function _warmRpcs() {
  if (_rpcWarmInflight) return _rpcWarmInflight;
  _rpcWarmInflight = (async () => {
    // Try persisted order first. If fresh, use it without probing — saves
    // ~1s on every page load with a cached order.
    const persisted = _loadPersistedRpcOrder();
    if (persisted) {
      // Reorder ETH_RPCS in-place to match persisted order. Unknown URLs
      // (added in a later deploy) go to the end.
      const known = new Set(persisted.urls);
      const tail = ETH_RPCS.filter(u => !known.has(u));
      ETH_RPCS.length = 0;
      ETH_RPCS.push(...persisted.urls, ...tail);
      _rpcOrderTs = persisted.ts;
      return;
    }
    // No fresh persisted order — probe all in parallel.
    const results = await Promise.all(
      ETH_RPCS.map(async u => ({ url: u, lat: await _probeRpc(u) }))
    );
    results.sort((a, b) => a.lat - b.lat);
    const sorted = results.map(r => r.url);
    ETH_RPCS.length = 0;
    ETH_RPCS.push(...sorted);
    _rpcOrderTs = Date.now();
    _savePersistedRpcOrder(sorted);
  })();
  return _rpcWarmInflight;
}
// Kick off warm-up immediately on script load. Promise sits dormant until
// awaited; rpcCall awaits it on first invocation. After the first warm-up
// settles, start the background re-probe loop so endpoints that flapped
// during cold-start probing or got demoted mid-session can recover without
// waiting for organic traffic to wander down to them.
_warmRpcs().then(() => _startRpcReprobe()).catch(() => _startRpcReprobe());

// Periodic background re-probe for endpoints that are dead (lat=Infinity)
// or recently demoted by reactive failover. Per Nik msg 440 2026-05-01:
// public RPCs flap transiently — an endpoint that fails right now may
// recover in 30-60s. Without periodic re-probe, a flapped endpoint stays
// at the tail of the persisted order for the full TTL (1h) even if it
// recovers, because organic eth_call traffic prefers the head and never
// wanders down to confirm recovery. Cheap: 1 eth_blockNumber per dead
// endpoint every ~90s, only touches failing entries.
const _RPC_REPROBE_MS = 90 * 1000;
let _rpcReprobeTimer = null;
async function _reprobeFailing() {
  const now = Date.now();
  const targets = [];
  for (const u of ETH_RPCS) {
    const m = _rpcMeta.get(u);
    if (!m) continue;
    const isDead = m.lat === Infinity;
    const recentlyFailed = m.lastFailAt && (now - m.lastFailAt) < (_RPC_COOLDOWN_MS * 4);
    if (isDead || recentlyFailed) targets.push(u);
  }
  if (targets.length === 0) return;
  await Promise.all(targets.map(u => _probeRpc(u)));
  // Re-sort ETH_RPCS by current latency so recovered endpoints climb back
  // up the order. Infinity stays at the bottom. Persist so other tabs /
  // reloads benefit from the updated ranking.
  const ranked = ETH_RPCS.slice().sort((a, b) => {
    const la = _rpcMeta.get(a)?.lat ?? Infinity;
    const lb = _rpcMeta.get(b)?.lat ?? Infinity;
    return la - lb;
  });
  ETH_RPCS.length = 0;
  ETH_RPCS.push(...ranked);
  _savePersistedRpcOrder(ranked);
}
function _startRpcReprobe() {
  if (_rpcReprobeTimer) return;
  _rpcReprobeTimer = setInterval(() => {
    _reprobeFailing().catch(() => { /* re-probe failures are non-fatal */ });
  }, _RPC_REPROBE_MS);
}

// Per-RPC reliability stats (per Nik msg 440/441 2026-05-01: trust as a
// function of history, not a single bench moment). Tracks:
//   consecutiveFails: resets to 0 on success, increments on failure;
//     used to deeply demote endpoints on a failure streak even after
//     cooldown elapses (3+ consecutive fails → tail of order).
//   recentOks / recentTotal: rolling-window success rate over the last
//     _RPC_WINDOW calls. Lightweight: no array, just two counters that
//     decay via exponential weight when window cap is hit.
const _RPC_WINDOW = 20;
function _bumpStats(url, ok) {
  const m = _rpcMeta.get(url) || {};
  let total = (m.recentTotal || 0) + 1;
  let oks = (m.recentOks || 0) + (ok ? 1 : 0);
  if (total > _RPC_WINDOW) {
    // Decay older observations: halve both counters so window stays bounded
    // without per-call array bookkeeping.
    total = Math.ceil(total / 2);
    oks = Math.ceil(oks / 2);
  }
  m.recentTotal = total;
  m.recentOks = oks;
  _rpcMeta.set(url, m);
}

// Mark an RPC as failed (used by reactive failover). Sets lastFailAt and
// puts the entry on cooldown — getOrderedRpcs() demotes it to the back of
// the order while cooldown is active. Preserves prior latency so a
// recovered endpoint can be re-ranked into its old position by the
// background re-probe loop. Increments consecutiveFails for streak demotion.
function _markRpcFail(url) {
  const meta = _rpcMeta.get(url) || {};
  const cf = (meta.consecutiveFails || 0) + 1;
  _rpcMeta.set(url, {
    ...meta,
    lat: meta.lat || Infinity,
    lastFailAt: Date.now(),
    consecutiveFails: cf,
  });
  _bumpStats(url, false);
}
function _markRpcOk(url, lat) {
  const meta = _rpcMeta.get(url) || {};
  _rpcMeta.set(url, {
    ...meta,
    lat: lat || meta.lat || 200,
    lastOkAt: Date.now(),
    lastFailAt: 0,
    consecutiveFails: 0,
  });
  _bumpStats(url, true);
}

// Returns the active RPC list with cooled-down + unreliable endpoints
// demoted to the back. Pure function over _rpcMeta — does not mutate
// the source list. Three-tier ordering:
//   1. live (no recent fail, success rate ≥ 50% or no history)
//   2. unreliable (success rate < 50% over last window OR
//      consecutiveFails ≥ 3) — kept in pool for transient-recovery via
//      re-probe loop, but routed last during normal traffic
//   3. cooled (lastFailAt within _RPC_COOLDOWN_MS) — strict cooldown
//
// Chain-aware: reads `activeChainId` and pulls per-chain `rpc` array from
// CHAINS_CONFIG. Falls back to ETH_RPCS only when chain config is missing
// or activeChainId === 1 (Ethereum). Without this, every Gnosis/Polygon/etc.
// get_dy goes to Ethereum endpoints and hits whatever contract lives at the
// same address there — returns garbage / reverts. Fixed 2026-05-22 after
// regression caught by Playwright smoke test on /swap XDAI→EURe.
// Per-chain RPC override. chains_config.json is daily-built and may contain
// endpoints that look healthy to the build probe but fail under burst from a
// browser origin (CORS, per-host throttle, rate-limit). For Gnosis we know:
//   blastapi.io ‒ "Failed to fetch" под burst (CORS preflight)
//   onfinality.io/public — выбрасывает revert при concurrent eth_call
//   1rpc.io/gnosis — usage limit на public tier (revert + 429)
// Pinned list below = subset of chains_config that actually serves Gnosis
// reliably under parallel-strategy burst in 2026-05-22 browser tests.
const PINNED_CHAIN_RPCS = {
  100: [ // Gnosis (verified under burst, 5/5 ok per endpoint)
    'https://gnosis.publicnode.com',
    'https://gnosis-rpc.publicnode.com',
    'https://gnosis.drpc.org',
    'https://rpc.gnosis.gateway.fm',
    'https://rpc.gnosischain.com',
  ],
};
function _getActiveChainRpcs() {
  // Pinned override wins over chains_config when present.
  if (PINNED_CHAIN_RPCS[activeChainId]) {
    return [...PINNED_CHAIN_RPCS[activeChainId]];
  }
  if (typeof CHAINS_CONFIG === 'object' && CHAINS_CONFIG && CHAINS_CONFIG.chains) {
    for (const ch of Object.values(CHAINS_CONFIG.chains)) {
      if (ch && ch.chainId === activeChainId && Array.isArray(ch.rpc) && ch.rpc.length) {
        return [...ch.rpc];
      }
    }
  }
  return ETH_RPCS;
}
function getOrderedRpcs() {
  const now = Date.now();
  const live = [];
  const unreliable = [];
  const cooled = [];
  for (const u of _getActiveChainRpcs()) {
    const m = _rpcMeta.get(u);
    if (m && m.lastFailAt && (now - m.lastFailAt) < _RPC_COOLDOWN_MS) {
      cooled.push(u);
      continue;
    }
    if (m) {
      const cf = m.consecutiveFails || 0;
      const total = m.recentTotal || 0;
      const oks = m.recentOks || 0;
      const rate = total > 0 ? oks / total : 1;
      if (cf >= 3 || (total >= 5 && rate < 0.5)) {
        unreliable.push(u);
        continue;
      }
    }
    live.push(u);
  }
  return live.concat(unreliable, cooled);
}

// ABIs
const POOL_ABI_EXCHANGE = [
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) payable returns (uint256)',
  'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)',
  'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, bool use_eth) payable returns (uint256)',
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
  'function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
];
const POOL_ABI_LIQUIDITY = [
  'function add_liquidity(uint256[2] amounts, uint256 min_mint_amount) payable returns (uint256)',
  'function add_liquidity(uint256[3] amounts, uint256 min_mint_amount) payable returns (uint256)',
  'function add_liquidity(uint256[4] amounts, uint256 min_mint_amount) payable returns (uint256)',
  'function remove_liquidity(uint256 _amount, uint256[2] min_amounts) returns (uint256[2])',
  'function remove_liquidity(uint256 _amount, uint256[3] min_amounts) returns (uint256[3])',
  'function remove_liquidity(uint256 _amount, uint256[4] min_amounts) returns (uint256[4])',
  'function remove_liquidity_one_coin(uint256 _token_amount, int128 i, uint256 _min_amount) returns (uint256)',
  'function remove_liquidity_one_coin(uint256 _token_amount, uint256 i, uint256 _min_amount) returns (uint256)',
  'function calc_token_amount(uint256[2] amounts, bool deposit) view returns (uint256)',
  'function calc_token_amount(uint256[3] amounts, bool deposit) view returns (uint256)',
  'function calc_token_amount(uint256[4] amounts, bool deposit) view returns (uint256)',
  'function calc_withdraw_one_coin(uint256 _token_amount, int128 i) view returns (uint256)',
  'function calc_withdraw_one_coin(uint256 _token_amount, uint256 i) view returns (uint256)',
];

// ---- Liquidity ABI style resolution -------------------------------------
// Older Curve pools take fixed-size arrays (uint256[N]); stableswap-NG
// implementations take dynamic arrays (uint256[]). The two encode differently,
// so building the wrong one makes add/remove_liquidity revert. Source of truth
// per pool: explicit `dynamicArrayAbi` flag (probed from contract bytecode by
// the deprecated-pools registry generator), else registryId/type mentioning
// stable-ng. Self-adapting — no per-pool hardcoding.
window.poolUsesDynamicArrays = function (pool) {
  if (!pool) return false;
  if (typeof pool.dynamicArrayAbi === 'boolean') return pool.dynamicArrayAbi;
  return /stable-?ng/i.test(`${pool.registryId || ''} ${pool.type || ''}`);
};
// Returns the correct human-readable ABI fragments for a pool's n coins.
window.poolLiquidityAbi = function (pool, n) {
  const dyn = window.poolUsesDynamicArrays(pool);
  const A = dyn ? 'uint256[]' : `uint256[${n}]`;
  return {
    dyn,
    add: `function add_liquidity(${A} amounts, uint256 min_mint_amount) payable returns (uint256)`,
    remove: `function remove_liquidity(uint256 _amount, ${A} min_amounts) returns (${A})`,
    calc: `function calc_token_amount(${A} amounts, bool deposit) view returns (uint256)`,
  };
};
const GAUGE_ABI = [
  // deposit/withdraw overloads — V4/V5/V6 factory NG gauges have varying signatures.
  // ethers.js dispatches by exact signature ('deposit(uint256,address,bool)' etc).
  'function deposit(uint256 _value)',
  'function deposit(uint256 _value, address _addr)',
  'function deposit(uint256 _value, address _addr, bool _claim_rewards)',
  'function withdraw(uint256 _value)',
  'function withdraw(uint256 _value, bool _claim_rewards)',
  'function balanceOf(address arg0) view returns (uint256)',
  'function claimable_tokens(address addr) view returns (uint256)',
  'function claim_rewards()',
  'function reward_count() view returns (uint256)',
];

// Well-known pools that always have snapshot history
const PREFERRED_POOLS = [
  '0xdc24316b9ae028f1497c275eb9192a3ea0f67022', // stETH/ETH
  '0xbebc44782c7db0a1a60cb6fe97d0b483032ff1c7', // 3pool
  '0xd51a44d3fae010294c616388b506acda1bfaae46', // tricrypto2
  '0xa1f8a6807c402e4a15ef4eba36528a3fed24e577', // frxETH/ETH
];

// ============================================================
// STATE
// ============================================================
let allPools = [];
let poolsByAddress = new Map();
let poolDetailsByRegistry = new Map();
let volumeData = null;
let gaugesData = null;
let cacheMode = false; // true when loaded from server-side cache

let selectedPool = null;

// Expose `allPools` and `selectedPool` to other top-level scripts (portfolio.js)
// via window. Top-level `let` bindings do NOT auto-attach to window in browsers,
// so `window.allPools` / `window.selectedPool` were stuck at undefined and
// portfolio.js's `(global.allPools || []).find(...)` always returned [], causing
// Manage-modal Deposit/Withdraw forms to render with `selectedPool === null`
// (the static "Select a pool to deposit" placeholder Алекс reported in
// crvecodev/479 on 2026-05-02). The defineProperty closure delegates reads and
// writes back to the real lexical binding, so cross-file `selectedPool = pool`
// works on both sides.
Object.defineProperty(window, 'allPools', {
  configurable: true,
  get() { return allPools; },
  set(v) { allPools = v; },
});
Object.defineProperty(window, 'selectedPool', {
  configurable: true,
  get() { return selectedPool; },
  set(v) { selectedPool = v; },
});
let currentView = 'trade'; // 'trade', 'swap', 'pools', or 'yield'

// Trade-specific state
let selectedFromToken = null;
let selectedToToken = null;
let fromBalanceRaw = 0n;
let toBalanceRaw = 0n;
let tradeChart = null;
let candleSeries = null;
let volumeChartSeries = null;
let lastCandleData = []; // Timestamps of current OHLC candles for volume alignment
let currentAgg = 4;
let currentUnit = 'hour';
let quoteDebounceTimer = null;
let slippage = 0.5;

// Yield-specific state
let yieldChart = null;
let apySeries = null;
let weeklyApySeries = null;
let tvlSeries = null;
let crvAprSeries = null;
let otherAprSeries = null;
let convexAprSeries = null;
let stakedaoAprSeries = null;
let currentChartMode = 'apy';
let depositSlippage = 0.5;
let withdrawSlippage = 0.5;
let withdrawMode = 'balanced';
let depositQuoteTimer = null;
let withdrawQuoteTimer = null;
let lpBalanceRaw = 0n;
let stakedLPRaw = 0n;
let simDepositAmount = 10000;
let simDepositTimer = null;
// CRV price what-if (Alexandr msg 1010): user overrides the CRV price and
// every CRV-emission APR (CRV column, FAPR, CRV part of Total) is rescaled by
// override / live. Input prefilled with the live price → ratio 1 until edited.
let crvPriceLive = null;
let crvPriceUser = null;
let crvPriceTimer = null;
function crvPriceRatio() {
  return (crvPriceUser > 0 && crvPriceLive > 0) ? crvPriceUser / crvPriceLive : 1;
}
async function initCrvPriceInput() {
  const el = document.getElementById('crvPriceInput');
  if (!el) return;
  try {
    // CRV mainnet address — the price is chain-independent, so always mainnet.
    const r = await fetch('https://prices.curve.finance/v1/usd_price/ethereum/0xd533a949740bb3306d119cc777fa900ba034cd52');
    const j = await r.json();
    const p = parseFloat(j?.data?.usd_price || j?.usd_price || 0);
    if (isFinite(p) && p > 0) {
      crvPriceLive = p;
      el.placeholder = p.toFixed(2);
      if (crvPriceUser == null && !el.value) el.value = p.toFixed(2);
      const hint = document.getElementById('crvPriceHint');
      if (hint) hint.textContent = `live $${p.toFixed(2)}`;
    }
  } catch { /* price unavailable → поле пустое, ratio stays 1 */ }
}

// Shared state
let searchQuery = '';
// Multi-select registry filter (Alexandr msg 539): empty Set = show all.
// Each registry-chip click toggles its `data-registry` value in this Set.
// Active = registryId/type is a member.
const filterRegistries = new Set();
let myAssetsOnly = false;
let favoritesOnly = false;
// High Volume / Disbalance chips (Alexandr msg 535) — independent toggles.
let highVolumeOnly = false;
let disbalanceOnly = false;
// Asset-class chips (Alexandr crvecodev/1067-1085) — replace registry chips.
// Independent toggles, AND-combine with all other filters. Classified by coin
// SYMBOL (p.coins) so no extra data source needed: ETH = contains an ETH/LST/LRT
// token, BTC = contains a BTC token, crvUSD = contains crvUSD/scrvUSD.
let assetEth = false;
let assetBtc = false;
let assetCrvusd = false;
// Min-TVL segment (Alexandr crvecodev/1081) — list-settings menu. 0 = off.
// Single-select preset threshold, persisted across reloads.
let minTvlThreshold = (() => { try { return parseInt(localStorage.getItem('cd_minTvl') || '0', 10) || 0; } catch (e) { return 0; } })();
// Gainers/Losers — filter by weekly gauge-weight delta direction (ΔW). Yield-only pills.
// Persisted in localStorage so the toggle state survives reloads (tester @Alexandr_Petryashev msg 169).
// Stored on `window` (not as `let`) because some code paths (panels.js / yield.js)
// re-render the pool list and need to read these flags via globalThis lookup.
window.gainersOnly = (() => { try { return localStorage.getItem('cd_gainersOnly') === '1'; } catch (e) { return false; } })();
window.losersOnly  = (() => { try { return localStorage.getItem('cd_losersOnly')  === '1'; } catch (e) { return false; } })();
// "Show hidden" toggle — when OFF (default), filters out gauge-killed pools
// AND dust pools (TVL < $10K). When ON, shows everything. Per Alexandr msg 511.
// On window so other modules can read it. Persisted across reloads.
window.showHidden = (() => { try { return localStorage.getItem('curvedex.showHidden') === '1'; } catch (e) { return false; } })();
let sortField = 'tvl';
let sortDir = -1;
let walletAddress = null;
let provider = null;
let signer = null;

const cache = new Map();

// Bridge script-scoped state to window for portfolio.js (classic-script IIFE) to read.
// Getters required for reassigned `let` vars so portfolio.js sees current value, not snapshot.
// (`allPools` and `selectedPool` are bridged earlier at the declaration site with getter+setter.)
Object.defineProperty(window, 'gaugesData',    { configurable: true, get: () => gaugesData });
Object.defineProperty(window, 'walletAddress', { configurable: true, get: () => walletAddress, set: (v) => { walletAddress = v; } });
Object.defineProperty(window, 'provider',      { configurable: true, get: () => provider,      set: (v) => { provider = v; } });
Object.defineProperty(window, 'signer',        { configurable: true, get: () => signer,        set: (v) => { signer = v; } });
window.ETH_RPCS = ETH_RPCS;
window.ERC20_ABI = ERC20_ABI;
window.GAUGE_ABI = GAUGE_ABI;
// Expose for portfolio.js / yield.js / trade.js so they get the same
// latency-sorted order + cooldown-aware view of the pool.
window.getOrderedRpcs = getOrderedRpcs;
window._warmRpcs = _warmRpcs;
window._markRpcFail = _markRpcFail;
window._markRpcOk = _markRpcOk;

// Track which data has been loaded for current pool
let tradeDataLoadedFor = null;
let yieldDataLoadedFor = null;

// ============================================================

// HELPERS
// ============================================================
function fmt$(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}
function fmtCompact(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return n.toFixed(0);
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '--';
  // Near-zero (but positive) values round to '0.0%' under toFixed(1) and read
  // as "no yield" when there really is some.  Show "<0.1%" so the user can
  // tell "value exists, just tiny" from "value missing".  Negative micro
  // values mirror the same display. One decimal everywhere (msg 1038).
  if (n !== 0 && Math.abs(n) < 0.05) return (n < 0 ? '>-0.1%' : '<0.1%');
  return n.toFixed(1) + '%';
}
function fmtPct1(n) {
  if (n == null || isNaN(n)) return '--';
  if (n !== 0 && Math.abs(n) < 0.05) return (n < 0 ? '>-0.1%' : '<0.1%');
  return n.toFixed(1) + '%';
}
// Full-width placeholder for pool-list cells. Single em-dash, dim opacity (per tester
// @Alexandr_Petryashev msg 252 — "тонкий dim попробуем"). Inherits cell color so it tints
// subtly to the column accent without visual weight that shifts surrounding numbers.
const EMPTY_HTML = '<span class="cell-empty">—</span>';
function fmtPrice(n, decimals = 6) { return n == null || isNaN(n) ? '--' : n.toFixed(decimals); }
function shortAddr(a) { return a ? a.slice(0, 6) + '...' + a.slice(-4) : '--'; }
// Token icon URL from curve-assets CDN (global helper).
// curvefi/curve-assets repo layout:
//   images/assets/             ← Ethereum mainnet
//   images/assets-arbitrum/    ← Arbitrum
//   images/assets-polygon/     ← Polygon
//   ...                        ← one dir per chain ('assets-' + chainKey)
// Without chain-awareness here the page builds Ethereum-asset URLs for
// every chain and the browser hits 404 on all icons except mainnet —
// hence empty icons on Sonic/Arbitrum/etc.
function _tokenIconUrl(address) {
  if (!address) return '';
  const addr = address.toLowerCase();
  // ETH placeholder → WETH (mainnet address used as canonical icon anchor).
  // On sidechains the API returns real coin addresses, this branch fires
  // only for mainnet pools using the 0xEee… sentinel.
  const resolved = (addr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')
    ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : addr;
  const chainKey = (typeof getChainKey === 'function') ? getChainKey() : 'ethereum';
  const dir = chainKey === 'ethereum' ? 'assets' : ('assets-' + chainKey);
  return `https://cdn.jsdelivr.net/gh/curvefi/curve-assets/images/${dir}/${resolved}.png`;
}
function shortTx(h) { return h ? h.slice(0, 6) + '...' + h.slice(-4) : '--'; }
function dilutedApy(apy, tvl, deposit) {
  if (!deposit || deposit <= 0 || !tvl || tvl <= 0) return apy;
  // Sanity: if deposit > 5x pool tvl, dilution math unreliable (likely stale tvl
  // from DefiLlama/subgraph mismatch or decimals issue). Pool 0x138Bb0... showed
  // 72.77% -> 7.34% on $1000 dep into $687K TVL — root cause was tvl read
  // collapsing to ~$94. Falling back to raw apy is safer than fabricating drop.
  if (deposit > tvl * 5) {
    // Per-render-list this fires once per row; on sidechains (small pools) the
    // default $10K simulate easily hits dep>>tvl for the bottom of the list
    // and floods 100-200 console.warn lines on every refresh. Down-shift to
    // debug so DevTools is still useful but production stays clean.
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[dilutedApy] dep>>tvl, returning raw', { apy, tvl, deposit });
    }
    return apy;
  }
  return apy * tvl / (tvl + deposit);
}
// CRV gauge emission is split among LP staked in gauge (gauge TVL = working_supply × LP_unit_usd),
// not pool TVL. New unboosted deposit dilutes the share proportionally. For msUSD/fxUSD pool
// 0x138Bb0... gauge.working_supply ≈ 44 LP × $1.014 = ~$45 vs pool.tvl $687K — pool.tvl-based
// dilution massively underestimates the impact for tiny gauges. Александр crvecodev 2026-05-07.
function gaugeDilutedApy(crvApy, gaugeTvlUsd, deposit) {
  if (!deposit || deposit <= 0) return crvApy;
  if (!gaugeTvlUsd || gaugeTvlUsd <= 0) return crvApy; // unknown gauge tvl, skip dilution
  return crvApy * gaugeTvlUsd / (gaugeTvlUsd + deposit);
}
// Split totalApy = base (trading) + crv (gauge) + ext + merkl, dilute base by pool.tvl and crv by
// gauge.tvl. Used wherever we previously called dilutedApy(totalApy, pool.tvl, deposit). Falls back
// to single-bucket dilution when gauge.tvl is unknown (preserves old behavior for legacy paths).
function dilutedTotalApy(pool, deposit) {
  // CRV price what-if: the crv component scales linearly with the CRV price.
  const _crvRatio = (typeof crvPriceRatio === 'function') ? crvPriceRatio() : 1;
  if (!pool || ((!deposit || deposit <= 0) && _crvRatio === 1)) {
    const raw = (pool?.bestTotalApy != null && pool.bestTotalApy > 0) ? pool.bestTotalApy : (pool?.totalApy || 0);
    return raw;
  }
  deposit = (deposit && deposit > 0) ? deposit : 0; // ratio-only path: decompose without dilution
  const baseApy = pool.weeklyApy || 0;
  const merklApr = pool.merklApr || 0;
  let extraSum = 0;
  if (Array.isArray(pool.extraRewards)) {
    for (const r of pool.extraRewards) {
      const v = parseFloat(r.apy);
      if (isFinite(v) && v > 0) extraSum += v;
    }
  }
  // Displayed total may be Curve native (totalApy) or Cx/Sd best (bestTotalApy). Either way
  // gauge-component dilution by gauge.tvl is the correct math — Cx/Sd LP sit in the same Curve
  // gauge, just boosted via veCRV. Decompose: total = base + crv + extra + merkl. Solve for crv
  // as residual since bestTotalApy doesn't expose component breakdown directly.
  const useBest = pool.bestTotalApy != null && pool.bestTotalApy > 0 && pool.bestTotalApy !== pool.totalApy;
  const totalApyVal = useBest ? pool.bestTotalApy : (pool.totalApy || 0);
  const crvPortion = Math.max(0, totalApyVal - baseApy - extraSum - merklApr) * _crvRatio;
  const baseDil = dilutedApy(baseApy, pool.tvl, deposit);
  const crvDil = gaugeDilutedApy(crvPortion, pool.gaugeTvlUsd, deposit);
  const extDil = gaugeDilutedApy(extraSum, pool.gaugeTvlUsd, deposit);
  const merklDil = gaugeDilutedApy(merklApr, pool.gaugeTvlUsd, deposit);
  return baseDil + crvDil + extDil + merklDil;
}

function fmtTime(t) {
  const d = new Date(typeof t === 'number' ? t * 1000 : t + (typeof t === 'string' && t.includes('T') && !t.endsWith('Z') ? 'Z' : ''));
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function fetchJSON(url, bypassCache = false, opts = {}) {
  // Back-compat: bypassCache can be boolean (legacy) or opts object.
  if (typeof bypassCache === 'object' && bypassCache !== null) {
    opts = bypassCache;
    bypassCache = !!opts.bypassCache;
  }
  if (!bypassCache) {
    const c = cache.get(url);
    if (c && Date.now() - c.ts < CACHE_TTL) return c.data;
  }
  const { timeoutMs = 4000, retry = 1, ...fetchOpts } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retry; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...fetchOpts, signal: ctrl.signal });
      clearTimeout(timer);
      if (r.status >= 500 && r.status < 600 && attempt < retry) {
        await new Promise(res => setTimeout(res, 1000));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
      const data = await r.json();
      cache.set(url, { data, ts: Date.now() });
      return data;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      const isAbort = e && e.name === 'AbortError';
      const isTransient = isAbort || /Failed to fetch|NetworkError/i.test(e && e.message || '');
      if (isTransient && attempt < retry) {
        await new Promise(res => setTimeout(res, 1000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('fetchJSON: exhausted retries');
}

// Concurrency gate for eth_call bursts: the quote engine races many strategies
// in parallel (up to ~a hundred eth_calls at once), which trips public-RPC
// rate limits (429) — and then each individual call exhausts its endpoint cap
// and fails. Cap in-flight eth_calls; excess callers queue FIFO. Sized from
// the live endpoint pool, not a magic constant.
let _rpcInflight = 0;
const _rpcQueue = [];
function _rpcGateSize() {
  try { return Math.max(4, getOrderedRpcs().length * 2); } catch { return 6; }
}

async function rpcCall(data, to) {
  if (_rpcInflight >= _rpcGateSize()) await new Promise(res => _rpcQueue.push(res));
  _rpcInflight++;
  try {
    return await _rpcCallInner(data, to);
  } finally {
    _rpcInflight--;
    const next = _rpcQueue.shift();
    if (next) next();
  }
}

async function _rpcCallInner(data, to) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
    id: Date.now(),
  });

  // Wait for cold-start probe to settle (resolves immediately on warm cache).
  // Without this, the first eth_call cycles through whatever order ETH_RPCS
  // ships in — costing seconds if the head entry is dead.
  if (_rpcWarmInflight) {
    try { await _rpcWarmInflight; } catch { /* warmup failures are non-fatal */ }
  }

  // Latency-sorted live list with cooled-down endpoints at the back.
  const list = getOrderedRpcs();
  // Per-call cursor offset so parallel calls don't all hammer the head.
  const startIdx = _rpcIdx;
  _rpcIdx = (_rpcIdx + 1) % list.length;

  // Capped retry: try up to RPC_RETRY_CAP endpoints per pass (was: full pool).
  // Sandbox 2026-05-19: full-list cycle (6 endpoints) amplifies burst when a bad
  // endpoint (1rpc usage-limit, mevblocker 429) is in pool — each call walks
  // entire list, hitting healthy endpoints repeatedly. Cap = 3 keeps latency
  // bounded and prevents one bad endpoint from cascading rate-limits across
  // the rest.
  //
  // Retry semantics (Михаил 2026-06-12, tx 0xb07a082…): a non-revert failure
  // (429/timeout/network) is a TRANSIENT fault — retry with backoff on a
  // second pass instead of degrading the caller (a missing eth_call silently
  // drops a route candidate and the router picks a worse path). A contract
  // revert is DETERMINISTIC — rethrow immediately, never burn more endpoints.
  const RPC_RETRY_CAP = 3;
  const PASSES = 2;
  let lastErr = null;
  const tries = Math.min(RPC_RETRY_CAP, list.length);
  for (let pass = 0; pass < PASSES; pass++) {
    if (pass > 0) await new Promise(res => setTimeout(res, 350 * pass + Math.random() * 250));
    for (let i = 0; i < tries; i++) {
      const url = list[(startIdx + pass * tries + i) % list.length];
      const t0 = Date.now();
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        if (!r.ok) throw new Error('http-' + r.status);
        const json = await r.json();
        if (json.error) {
          // Contract revert is NOT an RPC fault — endpoint is healthy, the
          // contract genuinely refused the call (wrong selector / probe of dust
          // pool with wrong indices / etc). Don't penalize the endpoint or the
          // cascade will demote every healthy RPC mid-burst on Gnosis where many
          // parallel strategy probes legitimately revert on dust pools.
          const msg = String(json.error.message || '');
          const isRevert = /revert/i.test(msg);
          const err = new Error(msg);
          err._isContractRevert = isRevert;
          throw err;
        }
        // Garbage result is an endpoint fault too (Михаил: битые RPC часто
        // отвечают HTTP 200, фейл спрятан в теле): eth_call MUST return a hex
        // string ('0x' = legit empty). null/недо-JSON → fail-over to the next
        // endpoint instead of poisoning the caller with a non-hex value.
        if (typeof json.result !== 'string' || json.result.slice(0, 2) !== '0x') {
          throw new Error('bad-result: ' + String(JSON.stringify(json.result)).slice(0, 80));
        }
        _markRpcOk(url, Date.now() - t0);
        return json.result;
      } catch (e) {
        lastErr = e;
        if (e._isContractRevert) throw e; // deterministic — retrying другие endpoints бессмысленно
        _markRpcFail(url);
      }
    }
  }
  const fail = new Error('All RPCs failed: ' + (lastErr ? lastErr.message : 'unknown'));
  fail._isRpcExhausted = true;
  throw fail;
}

// ============================================================
// WALLET TOKEN BALANCES + USD PRICES (for token modal sorting)
// ------------------------------------------------------------
// Used by /trade and /swap token-selection modals to surface
// tokens that the user already holds, sorted by USD value desc.
// Cache TTL: 30s per (walletAddress, tokenAddress). Cache is
// cleared on connect/disconnect and after a successful swap.
// ============================================================
const _WALLET_BAL_TTL = 30000;
let _walletBalanceCache = {
  walletAddress: null,
  // Map<lowerAddr, { balance: number, usdPrice: number, usdValue: number, ts: number }>
  entries: new Map(),
};
// Map<lowerAddr, { price: number, ts: number, miss?: boolean }>
const _usdPriceCache = new Map();
const _USD_PRICE_TTL = 60000;
// Long TTL for 404-misses: avoids repeating the same 404 fetch (which the browser
// logs as a red console error regardless of how we handle it client-side).
const _USD_PRICE_MISS_TTL = 24 * 3600 * 1000;

function _resetWalletBalanceCache() {
  _walletBalanceCache.entries.clear();
  // Wallet connect/disconnect/switch also invalidates the portfolio read
  // provider pool: the wallet provider entry must reflect current
  // window.ethereum state. Pool rebuilds lazily on next batch (portfolio.js).
  if (typeof window !== 'undefined') window._portfolioReadProviderPool = null;
}

// Fetch USD price for a token address from prices.curve.finance.
// Returns 0 on miss/error (so sort still works — token is just appended).
// 404 responses are cached for a long time to avoid repeated red console errors
// from the browser's network logger (curve API legitimately doesn't index every token).
async function _fetchUsdPrice(addr) {
  if (!addr) return 0;
  const lower = addr.toLowerCase();
  const cached = _usdPriceCache.get(lower);
  if (cached) {
    const ttl = cached.miss ? _USD_PRICE_MISS_TTL : _USD_PRICE_TTL;
    if (Date.now() - cached.ts < ttl) return cached.price;
  }
  try {
    const r = await fetch(`${PRICES_BASE}/usd_price/${getChainKey()}/${lower}`);
    if (r.ok) {
      const j = await r.json();
      const price = parseFloat(j?.data?.usd_price || j?.usd_price || 0);
      const safe = isFinite(price) && price > 0 ? price : 0;
      _usdPriceCache.set(lower, { price: safe, ts: Date.now(), miss: safe === 0 });
      return safe;
    }
    // Non-ok (typically 404 for unindexed tokens) — cache as long-lived miss, silent.
    _usdPriceCache.set(lower, { price: 0, ts: Date.now(), miss: true });
    return 0;
  } catch { /* network error -> 0, short cache so we retry sooner */ }
  _usdPriceCache.set(lower, { price: 0, ts: Date.now(), miss: false });
  return 0;
}

// balanceOf(address) selector + 32-byte address arg, hex-encoded eth_call data.
function _encodeBalanceOf(addr) {
  // 0x70a08231 = balanceOf(address)
  const clean = addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return '0x70a08231' + clean;
}

// Fetch on-chain balance for a single token (address or _isNativeETH=true).
// Uses provider.getBalance for native ETH, otherwise eth_call balanceOf via rpcCall.
async function _fetchTokenBalance(token, walletAddr) {
  if (!token || !walletAddr) return 0;
  try {
    if (token._isNativeETH || token.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
      // Use provider if available (faster: single RPC w/ wallet's chosen RPC).
      if (typeof provider !== 'undefined' && provider) {
        const bal = await provider.getBalance(walletAddr);
        return parseFloat(ethers.formatEther(bal));
      }
      // Fallback to public RPC: eth_getBalance via latency-sorted pool.
      if (_rpcWarmInflight) {
        try { await _rpcWarmInflight; } catch { /* non-fatal */ }
      }
      const list = getOrderedRpcs();
      const body = JSON.stringify({
        jsonrpc: '2.0', method: 'eth_getBalance',
        params: [walletAddr, 'latest'], id: Date.now(),
      });
      for (let i = 0; i < list.length; i++) {
        const url = list[(_rpcIdx + i) % list.length];
        try {
          const r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
          });
          if (r.ok) {
            const j = await r.json();
            if (j.result) {
              _markRpcOk(url);
              return parseFloat(ethers.formatEther(BigInt(j.result)));
            }
          }
          _markRpcFail(url);
        } catch { _markRpcFail(url); }
      }
      return 0;
    }
    const data = _encodeBalanceOf(walletAddr);
    const result = await rpcCall(data, token.address);
    if (!result || result === '0x') return 0;
    const raw = BigInt(result);
    const dec = token.decimals != null ? token.decimals : 18;
    return parseFloat(ethers.formatUnits(raw, dec));
  } catch (e) {
    return 0;
  }
}

// For each token in `tokens`, return Map<lowerAddr, {balance, usdPrice, usdValue}>.
// Honors per-(wallet,token) 30s cache. Errors per-token are swallowed (=> 0).
// Concurrency: parallel via Promise.all; for large lists this is fine because
// rpcCall round-robins across 6 RPCs (~16 in-flight per RPC max).
async function getWalletTokenBalances(tokens, walletAddr) {
  const result = new Map();
  if (!tokens || !tokens.length || !walletAddr) return result;

  // Reset cache if wallet changed
  if (_walletBalanceCache.walletAddress &&
      _walletBalanceCache.walletAddress.toLowerCase() !== walletAddr.toLowerCase()) {
    _resetWalletBalanceCache();
  }
  _walletBalanceCache.walletAddress = walletAddr;

  const now = Date.now();
  const toFetch = [];
  for (const t of tokens) {
    const lower = t.address.toLowerCase();
    const cached = _walletBalanceCache.entries.get(lower);
    if (cached && now - cached.ts < _WALLET_BAL_TTL) {
      result.set(lower, cached);
    } else {
      toFetch.push(t);
    }
  }

  if (toFetch.length === 0) return result;

  // Parallel fetch: balance + price per token
  await Promise.all(toFetch.map(async (t) => {
    const lower = t.address.toLowerCase();
    try {
      const [bal, price] = await Promise.all([
        _fetchTokenBalance(t, walletAddr),
        _fetchUsdPrice(t.address),
      ]);
      const safeBal = isFinite(bal) && bal > 0 ? bal : 0;
      const usdValue = safeBal * price;
      const entry = { balance: safeBal, usdPrice: price, usdValue, ts: Date.now() };
      _walletBalanceCache.entries.set(lower, entry);
      result.set(lower, entry);
    } catch (e) {
      const entry = { balance: 0, usdPrice: 0, usdValue: 0, ts: Date.now() };
      _walletBalanceCache.entries.set(lower, entry);
      result.set(lower, entry);
    }
  }));

  return result;
}

// Format helpers used by token modal items
function _fmtTokenBalance(b) {
  if (!b || !isFinite(b) || b <= 0) return '';
  if (b >= 1000) return b.toFixed(2);
  if (b >= 1) return b.toFixed(4);
  if (b >= 0.0001) return b.toFixed(6);
  return b.toExponential(2);
}
function _fmtTokenUsd(v) {
  if (!v || !isFinite(v) || v <= 0) return '';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(2) + 'K';
  if (v >= 1) return '$' + v.toFixed(2);
  return '$' + v.toFixed(4);
}


// ============================================================
// ROUTER (hash-based)
// ============================================================
function navigate(hash) {
  if (window.location.hash !== hash) {
    window.location.hash = hash;
  } else {
    handleRoute();
  }
}

function navigateToView(view) {
  if (view === 'trade') {
    navigate('#/trade');
    return;
  }
  if (selectedPool) {
    const addr = selectedPool.address;
    if (view === 'yield') {
      navigate('#/yield/' + addr);
    } else {
      navigate('#/pool/' + addr);
    }
  } else {
    if (view === 'yield') {
      navigate('#/yield');
    } else {
      navigate('#/pools');
    }
  }
}

function handleRoute() {
  const hash = window.location.hash || '#/';
  const parts = hash.replace('#/', '').split('/').filter(Boolean);

  let poolAddr = null;
  let tradePairRoute = null;
  let view = 'trade'; // default: trade view

  if (parts.length === 0) {
    view = 'trade';
  } else if (parts.length === 1) {
    if (parts[0] === 'trade') {
      view = 'trade';
    } else if (parts[0] === 'swap') {
      view = 'swap';
    } else if (parts[0] === 'pools') {
      view = 'pools';
    } else if (parts[0] === 'yield') {
      view = 'yield';
    } else if (parts[0] === 'portfolio') {
      view = 'portfolio';
    } else if (parts[0].startsWith('0x') && parts[0].length >= 40) {
      poolAddr = parts[0];
      view = 'pools';
    } else {
      view = 'trade';
    }
  } else if (parts.length >= 2) {
    if (parts[0] === 'trade') {
      // #/trade/ETH%2FUSDC -> trade view with pair
      tradePairRoute = decodeURIComponent(parts[1]);
      view = 'trade';
    } else if (parts[0] === 'pool' && parts[1].startsWith('0x') && parts[1].length >= 40) {
      // #/pool/0xAddress -> pools view with pool selected
      poolAddr = parts[1];
      view = 'pools';
    } else if (parts[0] === 'yield' && parts[1].startsWith('0x') && parts[1].length >= 40) {
      // #/yield/0xAddress -> yield view with pool selected
      poolAddr = parts[1];
      view = 'yield';
    } else if (parts[0].startsWith('0x') && parts[0].length >= 40) {
      // Legacy: #/0xAddress or #/0xAddress/yield
      poolAddr = parts[0];
      view = parts[1] === 'yield' ? 'yield' : 'pools';
    }
  }

  switchView(view);

  if (view === 'trade' && tradePairRoute) {
    // Skip if this hashchange was triggered by our own token selection
    if (_suppressHashRoute) { _suppressHashRoute = false; return; }
    // Also skip if user has active free token selection (tradeSelectedFrom set but not from sidebar)
    if (tradeSelectedFrom && tradeSelectedTo && selectedPair && selectedPair.name === `${tradeSelectedFrom.symbol}/${tradeSelectedTo.symbol}`) return;
    // Defer pair selection until pairs are generated.
    // Audit 2026-05-01 #8: URL-shared pairs like #/trade/scrvUSD%2FUSDT failed
    // to switch the displayed pair because:
    //  (a) generateTokenPairs() normalizes direction (stable as quote),
    //      so 'scrvUSD/USDT' is actually stored as 'USDT/scrvUSD' — try reverse.
    //  (b) handler waited for tradeTokenList which only populates AFTER the
    //      first selectTokenPair call, deadlocking pure-pair routes — drop the
    //      tokenList wait and only fall through to free-token if pair lookup
    //      both directions fail AND tokenList is ready.
    const trySelectPair = () => {
      if (tokenPairs.length > 0) {
        // Try direct match.
        let pair = tokenPairs.find(p => p.name === tradePairRoute);
        // Try reverse direction (handles normalization).
        if (!pair) {
          const parts = tradePairRoute.split('/');
          if (parts.length === 2) {
            const reverseName = `${parts[1]}/${parts[0]}`;
            pair = tokenPairs.find(p => p.name === reverseName);
          }
        }
        if (pair) {
          selectTokenPair(pair.name);
        } else if (tradeTokenList.length > 0) {
          // Pair not in pre-generated list — try free token selection.
          // Each half can be either a symbol or an address (0x…, 40-hex).
          // Address-based lookup disambiguates symbol collisions (e.g. two MUSDs).
          const parts = tradePairRoute.split('/');
          const resolveHalf = (s) => {
            const v = String(s || '').trim();
            if (/^0x[a-fA-F0-9]{40}$/.test(v)) {
              const lc = v.toLowerCase();
              return tradeTokenList.find(t => String(t.address || '').toLowerCase() === lc);
            }
            return tradeTokenList.find(t => t.symbol === v);
          };
          if (parts.length === 2) {
            const fromToken = resolveHalf(parts[0]);
            const toToken = resolveHalf(parts[1]);
            if (fromToken && toToken) {
              tradeSelectedFrom = fromToken;
              tradeSelectedTo = toToken;
              updateTradeTokenUI('from', fromToken);
              updateTradeTokenUI('to', toToken);
              onTradeTokensChanged();
            } else {
              selectTokenPair(tokenPairs[0].name);
            }
          } else {
            selectTokenPair(tokenPairs[0].name);
          }
        } else {
          // tokenList not ready yet — keep polling.
          setTimeout(trySelectPair, 200);
        }
      } else {
        setTimeout(trySelectPair, 200);
      }
    };
    trySelectPair();
  } else if (view === 'trade' && !tradePairRoute && tokenPairs.length > 0 && !selectedPair) {
    // Auto-select first pair
    selectTokenPair(tokenPairs[0].name);
  } else if (poolAddr && poolAddr !== selectedPool?.address?.toLowerCase()) {
    // Bounded poll: pool list may still be loading, but if 30 ticks (~6s)
    // pass and the pool never appears in poolsByAddress, the URL is bogus
    // (random hex, deleted pool, wrong chain). Without a cap the page
    // poll-loops forever and the user sees no feedback.
    let _tries = 0;
    const trySelect = () => {
      if (poolsByAddress.has(poolAddr.toLowerCase())) {
        selectPool(poolAddr);
      } else if (_tries++ < 30) {
        setTimeout(trySelect, 200);
      } else {
        // Fall back: drop the bad address from the hash and let the auto-select
        // path pick the top pool. Tell the user once via a console.info so
        // they can grep server-side analytics without flooding casual users.
        console.info('[router] pool not found on this chain, falling back:', poolAddr);
        const baseRoute = (view === 'yield') ? '#/yield' : '#/pools';
        if (typeof history !== 'undefined' && history.replaceState) {
          history.replaceState(null, '', baseRoute);
        } else {
          location.hash = baseRoute;
        }
        if (allPools.length > 0) {
          const topPool = [...allPools].sort((a, b) => (b.tvl || 0) - (a.tvl || 0))[0];
          if (topPool) selectPool(topPool.address);
        }
      }
    };
    trySelect();
  } else if ((view === 'pools' || view === 'yield') && !poolAddr && !selectedPool) {
    // Auto-select top pool by TVL
    const tryAutoSelect = () => {
      if (allPools.length > 0) {
        const topPool = [...allPools].sort((a, b) => (b.tvl || 0) - (a.tvl || 0))[0];
        if (topPool) selectPool(topPool.address);
      } else {
        setTimeout(tryAutoSelect, 200);
      }
    };
    tryAutoSelect();
  } else if (selectedPool && currentView !== view) {
    loadViewData();
  }
}

function switchView(view) {
  // Track whether the top-level view actually changed. selectPool → updateHash
  // → hashchange → handleRoute → switchView re-enters this for every pool
  // click; in that case we must NOT reset sortField/sortDir or the user's
  // manual sort (e.g. by FAPR) gets clobbered on every selection
  // (Александр msg 677 2026-05-13).
  const _viewChanged = (currentView !== view);
  currentView = view;

  // Page class on body for declarative scoping (e.g. CSS hides
  // [data-page-only="pools"] / [data-page-only="yield"] when not on
  // those pages — see styles.css for Token Balances rule).
  document.body.classList.remove('page-trade', 'page-swap', 'page-pools', 'page-yield', 'page-portfolio');
  document.body.classList.add('page-' + view);

  // Update nav
  document.getElementById('navTrade').classList.toggle('active', view === 'trade');
  document.getElementById('navSwap').classList.toggle('active', view === 'swap');
  document.getElementById('navPools').classList.toggle('active', view === 'pools');
  document.getElementById('navYield').classList.toggle('active', view === 'yield');

  // Show/hide view panels
  document.getElementById('view-trade-simple').style.display = 'none'; // legacy, always hidden
  document.getElementById('view-trade-center').style.display = view === 'trade' ? '' : 'none';
  document.getElementById('view-trade-right').style.display = view === 'trade' ? '' : 'none';
  document.getElementById('view-swap-center').style.display = view === 'swap' ? '' : 'none';
  document.getElementById('view-pools-center').style.display = view === 'pools' ? '' : 'none';
  document.getElementById('view-pools-right').style.display = view === 'pools' ? '' : 'none';
  document.getElementById('view-yield-center').style.display = view === 'yield' ? '' : 'none';
  document.getElementById('view-yield-right').style.display = view === 'yield' ? '' : 'none';
  // Initialize /yield two-level tabs on first show (idempotent).
  if (view === 'yield' && typeof renderYieldSubTabs === 'function') {
    renderYieldTopTabs();
    renderYieldSubTabs();
    showActiveYieldFormPanel();
  }
  const portfolioEl = document.getElementById('view-portfolio');
  if (portfolioEl) portfolioEl.style.display = view === 'portfolio' ? '' : 'none';
  if (view === 'portfolio' && window.Portfolio) {
    // Two rAF ticks: first lets the display change above commit a paint
    // (so the static Dashboard header is visible BEFORE async work begins),
    // second lets layout settle before openPortfolio touches innerHTML.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.Portfolio.open());
    });
  }

  // Token Balances blocks: scoped to /pools and /yield only.
  // On mobile, reorderTokenBalancesForViewport() relocates them out of their
  // center-panel parents (siblings of right-panel inside .main-layout), so
  // hiding the parent panel above is not enough — hide them explicitly here
  // when leaving /pools or /yield. Showing is handled by the renderers
  // (updateTradeTokenBalances / updateComposition) once a pool is selected.
  if (view !== 'pools') {
    const tradeTB = document.getElementById('tradeTokenBalances');
    if (tradeTB) tradeTB.style.display = 'none';
  }
  if (view !== 'yield') {
    const yieldTB = document.getElementById('yieldTokenBalances');
    if (yieldTB) yieldTB.style.display = 'none';
  }

  // Sidebar: hidden in Trade/Swap/Portfolio, shown in Pools/Yield
  const sidebar = document.getElementById('sidebar');
  const mainLayout = document.querySelector('.main-layout');
  mainLayout.classList.toggle('no-sidebar', view === 'swap' || view === 'portfolio');
  mainLayout.classList.toggle('trade-active', view === 'trade');
  mainLayout.classList.toggle('swap-active', view === 'swap');
  mainLayout.classList.toggle('portfolio-active', view === 'portfolio');

  // Reset mobile sidebar state on any view switch (close both sidebars)
  sidebar.classList.remove('mobile-open');
  const tradeSidebarEl = document.getElementById('tradeTokenSidebar');
  if (tradeSidebarEl) tradeSidebarEl.classList.remove('mobile-open');
  const mobileToggle = document.getElementById('mobilePoolToggle');
  if (mobileToggle) {
    // Burger glyph regardless of view (Alexandr msg 1012) — the opened panel
    // now carries the logo and its own context.
    mobileToggle.textContent = '☰';
    mobileToggle.classList.remove('active');
    // Show toggle in trade/pools/yield/swap (on /swap it opens the token modal,
    // Fix B). Portfolio has no list — hide it there.
    mobileToggle.style.display = (view === 'portfolio') ? 'none' : '';
  }
  const backdrop = document.getElementById('mobileSidebarBackdrop');
  if (backdrop) backdrop.classList.remove('show');

  // Populate trade view
  if (view === 'trade' && allPools.length > 0) {
    populateTradeTokens();
    generateTokenPairs();
    renderTokenPairList();
  }

  // Init swap view
  if (view === 'swap' && allPools.length > 0) {
    if (typeof populateTradeTokens === 'function') populateTradeTokens();
    if (typeof initSwapView === 'function') initSwapView();
  }

  // Update sidebar content visibility
  const registryFilters = document.getElementById('registryFilters');
  const sidebarSort = document.getElementById('sidebarSort');
  const depositSim = document.getElementById('depositSimulator');
  const poolList = document.getElementById('poolList');
  const poolCount = document.getElementById('poolCount');
  const pairListEl = document.getElementById('pairList');
  const pairCountEl = document.getElementById('pairCount');
  const searchInput = document.getElementById('poolSearch');

  if (view === 'trade' || view === 'swap') {
    // Trade/Swap view: show pair list, hide pool list and pool-specific sidebar elements
    if (registryFilters) registryFilters.style.display = 'none';
    if (sidebarSort) sidebarSort.style.display = 'none';
    if (depositSim) depositSim.classList.remove('visible');
    if (poolList) poolList.style.display = 'none';
    if (poolCount) poolCount.style.display = 'none';
    if (pairListEl) pairListEl.style.display = '';
    if (pairCountEl) pairCountEl.style.display = '';
    if (searchInput) searchInput.placeholder = 'Search pairs...';
  } else {
    // Pools/Yield: show pool list, hide pair list
    if (registryFilters) registryFilters.style.display = '';
    if (sidebarSort) sidebarSort.style.display = '';
    if (poolList) poolList.style.display = '';
    if (poolCount) poolCount.style.display = '';
    if (pairListEl) pairListEl.style.display = 'none';
    if (pairCountEl) pairCountEl.style.display = 'none';
    if (searchInput) searchInput.placeholder = 'Search pools...';
  }

  // Update sidebar sort columns visibility (pools/yield only — scoped to #sidebarSort)
  const _poolSort = document.getElementById('sidebarSort');
  const volCol = _poolSort?.querySelector('.sort-col-vol');
  const gaugeCol = _poolSort?.querySelector('.sort-col-gauge');
  const totalApyCol = _poolSort?.querySelector('.sort-col-total-apy');
  const weightCol = _poolSort?.querySelector('.sort-col-weight');
  const weightDeltaCol = _poolSort?.querySelector('.sort-col-weight-delta');
  const weightForecastCol = _poolSort?.querySelector('.sort-col-weight-forecast');
  const apyCol = _poolSort?.querySelector('.sort-col-apy');
  const ratingCol = _poolSort?.querySelector('.sort-col-rating');
  // Gainers/Losers pills are yield-only (gauge-weight ΔW makes no sense outside /yield).
  const gainersBtn = document.getElementById('gainersToggle');
  const losersBtn  = document.getElementById('losersToggle');
  if (gainersBtn) gainersBtn.style.display = (view === 'yield') ? '' : 'none';
  if (losersBtn)  losersBtn.style.display  = (view === 'yield') ? '' : 'none';
  if (view === 'pools') {
    if (volCol) volCol.style.display = '';
    if (apyCol) { apyCol.style.display = ''; apyCol.innerHTML = '24h <span class="sort-arrow"></span>'; }
    if (gaugeCol) gaugeCol.style.display = 'none';
    if (totalApyCol) totalApyCol.style.display = 'none';
    if (weightCol) weightCol.style.display = 'none';
    if (weightDeltaCol) weightDeltaCol.style.display = 'none';
    if (weightForecastCol) weightForecastCol.style.display = 'none';
    if (ratingCol) ratingCol.style.display = 'none';
    if (depositSim) depositSim.classList.remove('visible');
    if (_viewChanged) { sortField = 'tvl'; sortDir = -1; }
  } else if (view === 'yield') {
    if (volCol) volCol.style.display = 'none';
    if (apyCol) { apyCol.style.display = ''; apyCol.innerHTML = 'APY <span class="sort-arrow"></span>'; }
    if (gaugeCol) gaugeCol.style.display = '';
    if (totalApyCol) totalApyCol.style.display = '';
    if (weightCol) weightCol.style.display = '';
    if (weightDeltaCol) weightDeltaCol.style.display = '';
    if (ratingCol) ratingCol.style.display = '';
    // FAPR column: only meaningful Wed/Thu UTC.
    // Curve gauge weights flip Thu 00:00 UTC. Wed = locked-in votes most stable.
    // Other days: forecast ≈ current week's already-applied weight, zero signal → hide column.
    if (weightForecastCol) {
      const _utcDay = new Date().getUTCDay();
      weightForecastCol.style.display = (_utcDay === 3 || _utcDay === 4) ? '' : 'none';
    }
    if (depositSim) depositSim.classList.add('visible');
    if (_viewChanged) { sortField = 'totalApy'; sortDir = -1; }
  }
  // Update sort column active states (only pools sidebar, not trade sidebar)
  const poolsSortEl = document.getElementById('sidebarSort');
  if (poolsSortEl) {
    poolsSortEl.querySelectorAll('.sort-col').forEach(c => {
      c.classList.toggle('active', c.dataset.sort === sortField);
      const arrow = c.querySelector('.sort-arrow');
      if (c.dataset.sort === sortField) arrow.innerHTML = `<svg class="icon icon--sm"><use href="#icon-chevron-${sortDir === -1 ? 'down' : 'up'}"/></svg>`;
      else arrow.textContent = '';
    });
  }

  // Re-render pool list for correct columns
  if (view !== 'trade' && view !== 'swap') renderPoolList();

  // Pool favorites sidebar — visible on /pools and /yield, hidden elsewhere
  const poolFavSidebar = document.getElementById('poolFavoritesSidebar');
  if (poolFavSidebar) {
    if (view === 'pools' || view === 'yield') {
      try { if (typeof renderPoolFavoritesSidebar === 'function') renderPoolFavoritesSidebar(); } catch (e) {}
    } else {
      poolFavSidebar.style.display = 'none';
    }
  }

  // Mobile: Token Balances should appear BELOW the trade/liquidity block, not above.
  // Reorder DOM so Token Balances sits after .right-panel on viewports ≤1024px.
  reorderTokenBalancesForViewport();
}

// On mobile, the natural flex order places center-panel (chart + Token Balances)
// before right-panel (swap/deposit). User wants Token Balances under the
// trade/liquidity block, so we physically move the section to be a sibling
// after the right-panel inside .main-layout. On desktop, move back into the
// center-panel where it belongs.
function reorderTokenBalancesForViewport() {
  const isMobile = window.innerWidth <= 1024;
  const items = [
    { id: 'tradeTokenBalances', centerId: 'view-pools-center', rightId: 'view-pools-right' },
    { id: 'yieldTokenBalances', centerId: 'view-yield-center', rightId: 'view-yield-right' },
  ];
  for (const it of items) {
    const el = document.getElementById(it.id);
    const center = document.getElementById(it.centerId);
    const right = document.getElementById(it.rightId);
    if (!el || !center || !right) continue;
    if (isMobile) {
      // Move after the right-panel (i.e., as a sibling that follows it).
      if (el.previousElementSibling !== right || el.parentElement !== right.parentElement) {
        right.parentElement.insertBefore(el, right.nextSibling);
      }
    } else {
      // Restore: ensure it's the last child of its center-panel.
      if (el.parentElement !== center) {
        center.appendChild(el);
      }
    }
  }
}
window.reorderTokenBalancesForViewport = reorderTokenBalancesForViewport;
window.addEventListener('resize', () => {
  try { reorderTokenBalancesForViewport(); } catch (e) {}
});

function updateHash() {
  if (!selectedPool && currentView !== 'trade' && currentView !== 'swap') {
    if (currentView === 'yield') window.location.hash = '#/yield';
    else if (currentView === 'pools') window.location.hash = '#/pools';
    else window.location.hash = '#/trade';
    return;
  }
  if (currentView === 'swap') {
    window.location.hash = '#/swap';
    return;
  }
  if (currentView === 'trade') {
    if (selectedPair) {
      window.location.hash = '#/trade/' + encodeURIComponent(selectedPair.name);
    } else {
      window.location.hash = '#/trade';
    }
    return;
  }
  const addr = selectedPool.address;
  if (currentView === 'yield') {
    window.location.hash = '#/yield/' + addr;
  } else {
    window.location.hash = '#/pool/' + addr;
  }
}


// ============================================================
// DATA LAYER: 2-Phase Loading
// ============================================================
// Curve API often returns coinsAddresses padded with zero addresses
// (e.g. 3pool returns 4 addrs: DAI/USDC/USDT/0x0000... with decimals
// ['18','6','6','0']) while coins[] has the real count. The trailing
// zero entries leak into UI as "Token: Error" rows in YOUR BALANCES.
// Normalize: trim parallel arrays to entries with non-zero address.
function _normalizeCoinArrays(p) {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const addrs = Array.isArray(p.coinsAddresses) ? p.coinsAddresses : [];
  // Detect real length from non-zero addresses; also drop coinsDetailed entries
  // whose own .address is empty/zero (cache-refresh path may pass fresh detailed).
  let realLen = addrs.length;
  for (let i = 0; i < addrs.length; i++) {
    const a = (addrs[i] || '').toLowerCase();
    if (!a || a === ZERO) { realLen = i; break; }
  }
  if (realLen < addrs.length) {
    p.coinsAddresses = addrs.slice(0, realLen);
    if (Array.isArray(p.decimals)) p.decimals = p.decimals.slice(0, realLen);
    if (Array.isArray(p.coins)) p.coins = p.coins.slice(0, realLen);
  }
  if (Array.isArray(p.coinsDetailed)) {
    p.coinsDetailed = p.coinsDetailed.filter(c => {
      const a = (c && c.address ? c.address : '').toLowerCase();
      return a && a !== ZERO;
    });
  }
}

// Load from server-side cache (all data pre-merged)
async function loadFromCache(cacheData) {
  const pools = cacheData.pools || [];
  cacheMode = true;

  if (allPools.length === 0) {
    allPools = pools.map(p => {
      const np = {
        address: p.address,
        name: p.name || p.address.slice(0, 10),
        type: p.type || 'unknown',
        registryId: p.registryId || '',
        volumeUSD: p.volumeUSD || 0,
        dailyApy: p.dailyApy || 0,
        weeklyApy: p.weeklyApy || 0,
        tvl: p.tvl || 0,
        coins: p.coins || [],
        coinsAddresses: p.coinsAddresses || [],
        decimals: p.decimals || [],
        coinsDetailed: p.coinsDetailed || null,
        virtualPrice: parseFloat(p.virtualPrice) || 0,
        lpTokenAddress: p.lpTokenAddress || p.address,
        gaugeAddress: p.gaugeAddress || '',
        gaugeCrvApy: p.gaugeCrvApy || [0, 0],
        extraRewards: p.extraRewards || null,
        totalApy: p.totalApy || 0,
        merklApr: p.merklApr || 0,
        amplificationCoefficient: p.amplificationCoefficient || null,
        totalSupply: p.totalSupply || 0,
        isMetaPool: p.isMetaPool || false,
        implementationAddress: p.implementationAddress || '',
        poolUrls: p.poolUrls || null,
        basePoolAddress: p.basePoolAddress || '',
        underlyingCoins: p.underlyingCoins || [],
        underlyingCoinsAddresses: p.underlyingCoinsAddresses || [],
        underlyingDecimals: p.underlyingDecimals || [],
        poolId: p.poolId || null,
        // creationTs (Curve API field, unix seconds) used by `new`-gauge tag in
        // WT cell — only flag pools created within last 14 days (Алекс
        // crvecodev/507: avoid YB-style old pools that have gauge but never
        // emit). Cache may not carry it; loadPhase1 enriches from /getPools.
        creationTs: p.creationTs || null,
        _hasDetail: !!(p.coinsAddresses && p.coinsAddresses.length),
        _priceChange24h: p.priceChange24h != null ? p.priceChange24h : undefined,
      };
      _normalizeCoinArrays(np);
      return np;
    });
    poolsByAddress.clear();
    allPools.forEach(p => poolsByAddress.set(p.address.toLowerCase(), p));
  } else {
    // Refresh from cache
    for (const p of pools) {
      const existing = poolsByAddress.get(p.address.toLowerCase());
      if (existing) {
        existing.volumeUSD = p.volumeUSD || 0;
        existing.dailyApy = p.dailyApy || 0;
        existing.weeklyApy = p.weeklyApy || 0;
        existing.tvl = p.tvl || existing.tvl;
        existing.totalApy = p.totalApy || existing.totalApy;
        existing.gaugeCrvApy = p.gaugeCrvApy || existing.gaugeCrvApy;
        existing.merklApr = p.merklApr || 0;
        existing.extraRewards = p.extraRewards || existing.extraRewards;
        if (p.priceChange24h != null) existing._priceChange24h = p.priceChange24h;
        if (p.coinsDetailed) { existing.coinsDetailed = p.coinsDetailed; _normalizeCoinArrays(existing); }
      }
    }
  }
  updateHeaderStats();
  renderPoolList();
  detectSuspectOraclePools();
}

// === Suspect rate-oracle detection (Alexandr msg 971) ===
// Trap pattern on stable-ng factories: a pool whose visible composition is
// only blue-chip stables ("PB USDC USDT", "ETH Curve SNG USDC/USDT") but
// whose stored_rates() carries an active multiplier on one of those majors.
// Blue-chip stables are the unit of account — in every canonical pool their
// stored rate is exactly 10^(36-decimals) — so an oracle there means the
// deployer's contract can reprice deposits at will. Curve API misses these
// (usesRateOracle:false, implementation "plainstableng"; proven on-chain for
// 0xe6355ca5…: USDC ×0.9947 / USDT ×0.9989). Detection is data-derived:
//   major: coin with usdPrice within 5% of $1 whose pool-occurrence count is
//          in the top decile (p90) of stable tokens on the current chain;
//   candidate: pool where EVERY coin is such a major — nothing exotic in the
//          name to warn the user (~5% of pools, probed once, cached 7d);
//   flagged: stored_rates()[i] != 10^(36-dec) on a non-LP major coin. LP
//          coins are exempt — their rate is base-pool virtual_price (legit).
// Flagged pools get p.suspectOracle → "Show hidden" bucket + ⚠️ badge.
const _SUSPECT_SEL = '0xfd0684b1'; // stored_rates()
function _suspectCacheKey() {
  return `curvedex.suspectOracle.${typeof getChainKey === 'function' ? getChainKey() : 'ethereum'}`;
}
let _suspectScanInflight = null;

function _computeMajorStableSet() {
  const cnt = new Map(), price = new Map(), isLp = new Map();
  // LP detection from our own pool list (address / lpTokenAddress), not the
  // API's isBasePoolLpToken flag — the volumes/cache path drops that field,
  // which falsely flagged metapools (their LP coin's stored_rate is the base
  // pool's virtual_price, e.g. FRAXPYUSD ×1.0178 in DOLA Strategic Reserves).
  for (const p of allPools) {
    isLp.set((p.lpTokenAddress || p.address || '').toLowerCase(), true);
    isLp.set((p.address || '').toLowerCase(), true);
  }
  for (const p of allPools) {
    const cd = Array.isArray(p.coinsDetailed) ? p.coinsDetailed : null;
    if (!cd) continue;
    for (const c of cd) {
      const a = (c.address || '').toLowerCase();
      if (!a) continue;
      cnt.set(a, (cnt.get(a) || 0) + 1);
      const up = parseFloat(c.usdPrice);
      if (isFinite(up) && up > 0) price.set(a, up);
      if (c.isBasePoolLpToken) isLp.set(a, true);
    }
  }
  const stables = [...cnt.keys()].filter(a => price.has(a) && Math.abs(price.get(a) - 1) <= 0.05);
  if (!stables.length) return { majors: new Set(), stables: new Set(), isLp };
  const counts = stables.map(a => cnt.get(a)).sort((x, y) => y - x);
  const p90 = counts[Math.max(0, Math.floor(counts.length * 0.10) - 1)];
  const thr = Math.max(5, p90);
  return { majors: new Set(stables.filter(a => cnt.get(a) >= thr)), stables: new Set(stables), isLp };
}

function _ratesShowOracleOnMajor(hexResult, p, majors, isLp) {
  if (!hexResult || hexResult === '0x') return false;
  const h = hexResult.slice(2);
  const words = [];
  for (let i = 0; i + 64 <= h.length; i += 64) words.push(BigInt('0x' + h.slice(i, i + 64)));
  if (!words.length) return false;
  // dynamic uint256[] returns [offset(0x20), len, v0..]; fixed uint256[N] is inline
  let rates = words;
  if (words.length > 2 && words[0] === 32n && words[1] <= 8n && words.length >= 2 + Number(words[1])) {
    rates = words.slice(2, 2 + Number(words[1]));
  }
  const cd = p.coinsDetailed || [];
  for (let i = 0; i < Math.min(rates.length, cd.length); i++) {
    const a = (cd[i].address || '').toLowerCase();
    if (!majors.has(a) || isLp.get(a)) continue;
    const dec = parseInt(cd[i].decimals, 10);
    if (!isFinite(dec) || dec > 36) continue;
    if (rates[i] !== 10n ** BigInt(36 - dec)) return true;
  }
  return false;
}

async function detectSuspectOraclePools() {
  if (_suspectScanInflight) return _suspectScanInflight;
  _suspectScanInflight = (async () => {
    try {
      const { majors, stables, isLp } = _computeMajorStableSet();
      if (!majors.size) return;
      // Candidate: every coin is a ~$1 stable AND at least one is a major —
      // covers both pure camouflage pairs (USDC/USDT) and major-plus-young-
      // stable pairs (e.g. a hypothetical USDS/USDC trap before USDS crosses
      // the frequency threshold). Safe against false positives because the
      // flag itself only fires on an oracle attached to the MAJOR coin —
      // verified standalone 2026-06-11: 257 extra candidates, 0 new flags
      // (all legit oracles sit on the exotic/yield coin, never on the major).
      const cands = allPools.filter(p => {
        const cd = Array.isArray(p.coinsDetailed) ? p.coinsDetailed : null;
        if (!cd || cd.length < 2 || p.deprecated) return false;
        const addrs = cd.map(c => (c.address || '').toLowerCase());
        return addrs.every(a => stables.has(a)) && addrs.some(a => majors.has(a));
      });
      if (!cands.length) return;
      let cache = {};
      try { cache = JSON.parse(localStorage.getItem(_suspectCacheKey()) || '{}'); } catch (e) { cache = {}; }
      // Oracle presence is a property of the deployed implementation — static,
      // so a long TTL is safe; new pools are probed on first sight.
      const TTL = 7 * 24 * 3600 * 1000;
      const now = Date.now();
      const todo = [];
      let changed = false;
      for (const p of cands) {
        const e = cache[p.address.toLowerCase()];
        if (e && (now - e.ts) < TTL) {
          if (e.s) { p.suspectOracle = true; changed = true; }
        } else todo.push(p);
      }
      // Probe via Multicall3.aggregate3 (canonical 0xcA11… on every chain we
      // list): one eth_call per ~40 pools instead of a per-pool burst that
      // spams 403/429 across the public RPC pool. allowFailure=true keeps
      // legacy plain pools (stored_rates reverts) as clean.
      const MC3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
      const mcIface = (typeof ethers !== 'undefined' && ethers.Interface)
        ? new ethers.Interface(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])'])
        : null;
      for (let i = 0; i < todo.length; i += 40) {
        const chunk = todo.slice(i, i + 40);
        if (mcIface) {
          try {
            const data = mcIface.encodeFunctionData('aggregate3', [chunk.map(p => ({ target: p.address, allowFailure: true, callData: _SUSPECT_SEL }))]);
            const raw = await rpcCall(data, MC3);
            const [rets] = mcIface.decodeFunctionResult('aggregate3', raw);
            chunk.forEach((p, j) => {
              const r = rets[j];
              const s = (r && r.success && r.returnData && r.returnData !== '0x')
                ? (_ratesShowOracleOnMajor(r.returnData, p, majors, isLp) ? 1 : 0) : 0;
              cache[p.address.toLowerCase()] = { s, ts: now };
              if (s) { p.suspectOracle = true; changed = true; }
            });
            continue;
          } catch (e) { /* fall through to per-pool path for this chunk */ }
        }
        await Promise.all(chunk.map(async (p) => {
          let s = 0;
          try {
            const res = await rpcCall(_SUSPECT_SEL, p.address);
            s = _ratesShowOracleOnMajor(res, p, majors, isLp) ? 1 : 0;
          } catch (e) { s = 0; /* revert = legacy plain pool without stored_rates */ }
          cache[p.address.toLowerCase()] = { s, ts: now };
          if (s) { p.suspectOracle = true; changed = true; }
        }));
      }
      try { localStorage.setItem(_suspectCacheKey(), JSON.stringify(cache)); } catch (e) {}
      if (changed) {
        console.log('[suspectOracle]', allPools.filter(p => p.suspectOracle).length, 'pools flagged (oracle on blue-chip stable)');
        renderPoolList();
        // If the user already opened a flagged pool by direct link, refresh
        // its header so the warning banner appears without re-selecting.
        try { if (typeof updateYieldHeader === 'function' && selectedPool && selectedPool.suspectOracle) updateYieldHeader(); } catch (e) {}
      }
    } catch (e) {
      console.warn('[suspectOracle] scan failed:', e && e.message);
    } finally { _suspectScanInflight = null; }
  })();
  return _suspectScanInflight;
}

function updateHeaderStats() {
  document.getElementById('hdr-pools').textContent = allPools.length.toLocaleString();
  const totalVol = allPools.reduce((s, p) => s + p.volumeUSD, 0);
  document.getElementById('hdr-volume').textContent = fmt$(totalVol);
  const totalTvl = allPools.reduce((s, p) => s + (p.tvl || 0), 0);
  document.getElementById('hdr-tvl').textContent = fmt$(totalTvl);
  const poolsWithApy = allPools.filter(p => p.dailyApy > 0 && p.dailyApy < 10000);
  if (poolsWithApy.length > 0) {
    const avgApy = poolsWithApy.reduce((s, p) => s + p.dailyApy, 0) / poolsWithApy.length;
    document.getElementById('hdr-avg-apy').textContent = fmtPct(avgApy);
  }
}

// Merge manually-registered DEPRECATED pools (not in the Curve API) into the
// active chain's pool list so users can still find them and withdraw / add
// liquidity. The registry (deprecated_pools.json) carries each pool's coins,
// addresses, decimals and N — read on-chain at build time, not hand-typed.
// Only chains with an entry (Fantom 250, Avalanche 43114) get anything; every
// other chain is a no-op. Idempotent: pools already present from the API are
// skipped by address.
async function mergeDeprecatedPools() {
  try {
    const resp = await fetch((window.__DYNAMIC_BASE || '') + '/curvedex/deprecated_pools.json?v=' + (window.__APP_VERSION__ || ''));
    if (!resp.ok) return;
    const reg = await resp.json();
    const list = (reg && reg.pools && reg.pools[String(activeChainId)]) || [];
    if (!list.length) return;
    let added = 0, enriched = 0;
    for (const dp of list) {
      const key = (dp.address || '').toLowerCase();
      if (!key) continue;
      const existing = poolsByAddress.get(key);
      if (existing) {
        // Pool already came from the (volumes) API. Flag it deprecated/
        // withdraw-only so it survives the dust/killed filters and stays
        // findable, and backfill the on-chain coin metadata that the
        // volumes endpoint omits but remove_liquidity needs.
        existing.deprecated = true;
        existing.withdrawOnly = true;
        if (!existing.coinsAddresses || !existing.coinsAddresses.length) existing.coinsAddresses = dp.coinsAddresses || [];
        if (!existing.decimals || !existing.decimals.length) existing.decimals = dp.decimals || [];
        if (!existing.coins || !existing.coins.length) existing.coins = dp.coins || [];
        if (!existing.lpTokenAddress) existing.lpTokenAddress = dp.lpTokenAddress || dp.address;
        if (!existing.totalSupply) existing.totalSupply = dp.totalSupply || 0;
        if (dp.n && !existing.n) existing.n = dp.n;
        if (dp.displayName && !existing.displayName) existing.displayName = dp.displayName;
        if (typeof dp.dynamicArrayAbi === 'boolean') existing.dynamicArrayAbi = dp.dynamicArrayAbi;
        enriched++;
        continue;
      }
      const np = {
        address: dp.address,
        name: dp.name || dp.displayName || dp.address.slice(0, 10),
        displayName: dp.displayName || '',
        type: dp.type || 'deprecated',
        registryId: '',
        volumeUSD: 0, dailyApy: 0, weeklyApy: 0, tvl: 0,
        n: dp.n || (dp.coins ? dp.coins.length : 0),
        coins: dp.coins || [],
        coinsAddresses: dp.coinsAddresses || [],
        decimals: dp.decimals || [],
        virtualPrice: 0,
        lpTokenAddress: dp.lpTokenAddress || dp.address,
        gaugeAddress: '', gaugeCrvApy: [0, 0], totalApy: 0, merklApr: 0,
        amplificationCoefficient: null,
        totalSupply: dp.totalSupply || 0,
        isMetaPool: false, implementationAddress: '', poolUrls: null,
        creationTs: null, _hasDetail: true,
        deprecated: true, withdrawOnly: true,
        dynamicArrayAbi: (typeof dp.dynamicArrayAbi === 'boolean') ? dp.dynamicArrayAbi : undefined,
      };
      allPools.push(np);
      poolsByAddress.set(key, np);
      added++;
    }
    if (added || enriched) console.log('[deprecated] chain', activeChainId, '- added', added, 'enriched', enriched, 'withdraw-only pools');
  } catch (e) {
    console.warn('[deprecated] merge skipped:', e && e.message);
  }
}

async function loadPhase1() {
  try {
    let json = null;
    if (window.__volumesPromise) {
      json = await window.__volumesPromise;
      window.__volumesPromise = null;
    }
    if (json) {
      cache.set(`${apiBaseFor(getChainKey())}/getVolumes/${getChainKey()}`, { data: json, ts: Date.now() });
    } else {
      // Deprecated chains (e.g. Fantom Opera) may have no / erroring Curve API.
      // Tolerate it so the manual deprecated-pool registry still loads below
      // and users can find + withdraw from those pools.
      try {
        json = await fetchJSON(`${apiBaseFor(getChainKey())}/getVolumes/${getChainKey()}`);
      } catch (e) {
        console.warn('[loadPhase1] getVolumes failed (continuing for deprecated pools):', e && e.message);
        json = null;
      }
    }
    volumeData = json;
    const pools = json?.data?.pools || [];

    if (allPools.length === 0) {
      allPools = pools.map(p => ({
        address: p.address,
        name: p.name || p.address.slice(0, 10),
        type: p.type || 'unknown',
        registryId: p.registryId || '',
        volumeUSD: p.volumeUSD || 0,
        dailyApy: p.latestDailyApyPcent || 0,
        weeklyApy: p.latestWeeklyApyPcent || 0,
        tvl: p.usdTotal || 0,
        coins: p.coins || [],
        coinsAddresses: [],
        decimals: [],
        virtualPrice: 0,
        lpTokenAddress: null,
        gaugeAddress: '',
        gaugeCrvApy: [0, 0],
        totalApy: 0,
        merklApr: 0,
        amplificationCoefficient: null,
        totalSupply: 0,
        isMetaPool: false,
        implementationAddress: '',
        poolUrls: null,
        creationTs: p.creationTs || null,  // for `new` gauge tag (≤14d window)
        _hasDetail: false,
      }));
      poolsByAddress.clear();
      allPools.forEach(p => poolsByAddress.set(p.address.toLowerCase(), p));
      await mergeDeprecatedPools();
    } else {
      pools.forEach(p => {
        const existing = poolsByAddress.get(p.address.toLowerCase());
        if (existing) {
          existing.volumeUSD = p.volumeUSD || 0;
          existing.dailyApy = p.latestDailyApyPcent || 0;
          existing.weeklyApy = p.latestWeeklyApyPcent || 0;
          existing.tvl = p.usdTotal || existing.tvl;
        }
      });
    }

    updateHeaderStats();
    renderPoolList();
  } catch (e) {
    console.error('Phase 1 load error:', e);
  }
}

async function loadPhase2() {
  // In cache mode, pool data is already merged — only fetch registries for
  // detailed coin balances (composition view) in background
  const _ck = getChainKey();
  const _cc = CHAINS_CONFIG && CHAINS_CONFIG.chains && CHAINS_CONFIG.chains[_ck];
  // Lite chains expose only their factory registries; full chains keep the
  // global REGISTRIES set (unchanged behaviour).
  const _regs = (_cc && _cc.lite && Array.isArray(_cc.registries)) ? _cc.registries : REGISTRIES;
  const promises = _regs.map(async reg => {
    try {
      const json = await fetchJSON(`${apiBaseFor(getChainKey())}/getPools/${getChainKey()}/${reg}`);
      const pools = json?.data?.poolData || [];
      poolDetailsByRegistry.set(reg, pools);

      // creationTs is needed by the `new`-gauge tag (Алекс crvecodev/507)
      // even in cache mode where the rest of the merge is skipped — server
      // cache.json rarely carries it, but /getPools always does.
      for (const p of pools) {
        if (!p.creationTs) continue;
        const ex = poolsByAddress.get((p.address || '').toLowerCase());
        if (ex && !ex.creationTs) ex.creationTs = p.creationTs;
      }

      if (!cacheMode) {
        // Direct API mode: merge registry data into allPools
        let totalTvl = 0;
        pools.forEach(p => {
          const key = p.address.toLowerCase();
          const existing = poolsByAddress.get(key);
          if (existing) {
            existing.tvl = p.usdTotal || existing.tvl;
            existing.coins = (p.coins || []).map(c => c.symbol || c.name || 'Unknown');
            existing.coinsAddresses = p.coinsAddresses || (p.coins || []).map(c => c.address);
            existing.decimals = p.decimals || (p.coins || []).map(c => c.decimals);
            existing.virtualPrice = parseFloat(p.virtualPrice) || 0;
            existing.poolId = p.id;
            existing.registryId = reg;
            existing.name = p.name || existing.name;
            existing.lpTokenAddress = p.lpTokenAddress || p.address;
            existing.gaugeAddress = p.gaugeAddress || existing.gaugeAddress || '';
            existing.gaugeCrvApy = p.gaugeCrvApy || existing.gaugeCrvApy || [0, 0];
            existing.amplificationCoefficient = p.amplificationCoefficient || existing.amplificationCoefficient;
            existing.totalSupply = p.totalSupply || existing.totalSupply || 0;
            existing.isMetaPool = p.isMetaPool || false;
            existing.implementationAddress = p.implementationAddress || '';
            existing.poolUrls = p.poolUrls || null;
            existing.basePoolAddress = p.basePoolAddress || existing.basePoolAddress || '';
            existing.underlyingCoins = (p.underlyingCoins || []).map(c => c.symbol || c.name || 'Unknown');
            existing.underlyingCoinsAddresses = p.underlyingCoinsAddresses
              || (p.underlyingCoins || []).map(c => c.address);
            existing.underlyingDecimals = (p.underlyingCoins || []).map(c => Number(c.decimals) || 18);
            // creationTs always wins from /getPools (cache JSON often misses it)
            if (p.creationTs && !existing.creationTs) existing.creationTs = p.creationTs;
            existing._hasDetail = true;
            _normalizeCoinArrays(existing);
          } else {
            const newPool = {
              address: p.address,
              name: p.name || p.address.slice(0, 10),
              type: p.assetTypeName || reg,
              registryId: reg,
              volumeUSD: 0,
              dailyApy: 0,
              weeklyApy: 0,
              tvl: p.usdTotal || 0,
              coins: (p.coins || []).map(c => c.symbol || c.name || 'Unknown'),
              coinsAddresses: p.coinsAddresses || (p.coins || []).map(c => c.address),
              decimals: p.decimals || (p.coins || []).map(c => c.decimals),
              virtualPrice: parseFloat(p.virtualPrice) || 0,
              poolId: p.id,
              lpTokenAddress: p.lpTokenAddress || p.address,
              gaugeAddress: p.gaugeAddress || '',
              gaugeCrvApy: p.gaugeCrvApy || [0, 0],
              totalApy: 0,
              merklApr: 0,
              amplificationCoefficient: p.amplificationCoefficient || null,
              totalSupply: p.totalSupply || 0,
              isMetaPool: p.isMetaPool || false,
              implementationAddress: p.implementationAddress || '',
              poolUrls: p.poolUrls || null,
              basePoolAddress: p.basePoolAddress || '',
              underlyingCoins: (p.underlyingCoins || []).map(c => c.symbol || c.name || 'Unknown'),
              underlyingCoinsAddresses: p.underlyingCoinsAddresses
                || (p.underlyingCoins || []).map(c => c.address),
              underlyingDecimals: (p.underlyingCoins || []).map(c => Number(c.decimals) || 18),
              creationTs: p.creationTs || null,
              _hasDetail: true,
            };
            _normalizeCoinArrays(newPool);
            allPools.push(newPool);
            poolsByAddress.set(key, newPool);
          }
          totalTvl += (p.usdTotal || 0);
        });
      }
      return 0;
    } catch (e) {
      console.error(`Registry ${reg} load error:`, e);
      return 0;
    }
  });

  await Promise.all(promises);
  if (!cacheMode) {
    updateHeaderStats();
  }
  renderPoolList();
  loadBaseApyVp();
  // Pool favorites sidebar populates from allPools — refresh after load
  try { if (typeof renderPoolFavoritesSidebar === 'function') renderPoolFavoritesSidebar(); } catch (e) {}
  // coinsDetailed (usdPrice / isBasePoolLpToken) is now populated — scan for
  // rate oracles hidden on blue-chip stable pairs (registry path; cache path
  // triggers from loadFromCache).
  detectSuspectOraclePools();
}


// ============================================================
// POOL LIST RENDERING
// ============================================================
function getFilteredPools() {
  let list = allPools;
  // On Yield view, hide dead pools (TVL < $1000) — they have broken virtualPrice/APY.
  // Deprecated withdraw-only pools are exempt (TVL 0 in our registry) so they stay
  // findable for users who need to exit them.
  if (currentView === 'yield') {
    list = list.filter(p => p.deprecated || p.tvl >= 1000);
  }
  // "Show hidden" toggle (Alexandr msg 511) — when OFF (default), hide
  // deprecated pools (gauge killed by Curve DAO) AND dust pools.
  // Threshold is chain-aware: Ethereum $10K (lots of large pools), sidechains
  // $1K (Sonic/Avalanche/etc have much smaller pool sizes — a $10K cutoff
  // erases 90%+ of valid activity, leaving only 3-5 pools).
  if (!window.showHidden) {
    const _dustThreshold = (typeof getChainKey === 'function' && getChainKey() === 'ethereum') ? 10000 : 1000;
    list = list.filter(p => {
      if (p.deprecated) return true; // deprecated withdraw-only pools must stay findable
      if (p.gaugeIsKilled) return false;
      if (p.suspectOracle) return false; // rate oracle on a blue-chip stable — deposit trap

      const tvlVal = (p.tvlUsd != null) ? p.tvlUsd : (p.tvl != null ? p.tvl : null);
      if (tvlVal != null && tvlVal < _dustThreshold) return false;
      return true;
    });
  }
  if (filterRegistries.size > 0) {
    list = list.filter(p => filterRegistries.has(p.registryId) || filterRegistries.has(p.type));
  }
  // "My Assets" filter — show only pools where the connected wallet has any
  // position (Curve LP/staked, Convex stake, StakeDAO stake). Set is populated
  // by portfolio.js _refreshMyPoolSet() after positions load. Toggle no-op
  // when wallet not connected or positions not yet loaded — show all.
  if (myAssetsOnly && walletAddress && window._myPoolAddrs && window._myPoolAddrs.size > 0) {
    list = list.filter(p => window._myPoolAddrs.has((p.address || '').toLowerCase()));
  }
  // "Favorites" filter — show only pools the user starred. Source is
  // window._getFavoritePools() (Set of lowercased pool addresses) populated
  // from localStorage by trade.js. Toggle no-op when no favorites set.
  if (favoritesOnly && typeof window._getFavoritePools === 'function') {
    const favs = window._getFavoritePools();
    if (favs && favs.size > 0) list = list.filter(p => favs.has((p.address || '').toLowerCase()));
  }
  // High Volume — pool's 24h volume USD ≥ TVL (utilization ≥ 100%).
  if (highVolumeOnly) {
    list = list.filter(p => {
      const vol = (typeof p.volumeUSD === 'number' && isFinite(p.volumeUSD)) ? p.volumeUSD : 0;
      const tvl = (typeof p.tvl === 'number' && isFinite(p.tvl)) ? p.tvl : 0;
      return tvl > 0 && vol / tvl >= 1.0;
    });
  }
  // Disbalance — at least one token's USD share < (1/N) * 0.5, i.e. ≥50%
  // off equal split. For 2 tokens: any < 25%; for 3 tokens: any < 16.67%.
  if (disbalanceOnly) {
    list = list.filter(p => {
      const cd = Array.isArray(p.coinsDetailed) ? p.coinsDetailed : null;
      if (!cd || cd.length < 2) return false;
      const usdValues = cd.map(c => {
        const dec = parseInt(c.decimals, 10);
        const balRaw = parseFloat(c.poolBalance);
        const price = parseFloat(c.usdPrice);
        if (!isFinite(dec) || !isFinite(balRaw) || !isFinite(price) || price <= 0) return 0;
        return (balRaw / Math.pow(10, dec)) * price;
      });
      const total = usdValues.reduce((s, v) => s + v, 0);
      if (total <= 0) return false;
      const threshold = (1 / cd.length) * 0.5;
      return usdValues.some(v => (v / total) < threshold);
    });
  }
  // Asset-class chips (Alexandr crvecodev/1067-1085). Symbol-based, AND-combine.
  // ETH family: any coin symbol contains "ETH" (WETH/stETH/wstETH/rETH/weETH/ezETH/
  // ankrETH/ETHx/…). BTC: contains "BTC" (WBTC/tBTC/cbBTC/LBTC/…). crvUSD: crvUSD/scrvUSD.
  if (assetEth) {
    list = list.filter(p => Array.isArray(p.coins) && p.coins.some(c => /eth/i.test(c)));
  }
  if (assetBtc) {
    list = list.filter(p => Array.isArray(p.coins) && p.coins.some(c => /btc/i.test(c)));
  }
  if (assetCrvusd) {
    list = list.filter(p => Array.isArray(p.coins) && p.coins.some(c => /crvusd/i.test(c)));
  }
  // Min-TVL segment (Alexandr crvecodev/1081) — keep pools at/above the chosen floor.
  if (minTvlThreshold > 0) {
    list = list.filter(p => {
      const t = (p.tvl != null) ? p.tvl : (p.tvlUsd != null ? p.tvlUsd : 0);
      return t >= minTvlThreshold;
    });
  }
  // 🛡 Stablecoins — pool passes only if EVERY coin address is present in the
  // ratings-aggregator catalog (i.e. classified as a pegged asset by Pharos).
  // Covers all peg currencies (USD/EUR/GBP/JPY/...). Index populated by
  // info_tab.js on page load into window._ratingsTokens (Set of lowercase addr).
  if (window.stablecoinsOnly) {
    const idx = window._ratingsTokens;
    if (idx && idx.size > 0) {
      list = list.filter(p => {
        const addrs = p.coinsAddresses;
        if (!Array.isArray(addrs) || !addrs.length) return false;
        return addrs.every(a => idx.has((a || '').toLowerCase()));
      });
    }
  }
  // 🅰 Grade ≥ B — strict subset of Stablecoins. Pool passes if EVERY coin has
  // a Pharos grade of B- or better (weakest-token rule, conservative).
  if (window.minGradeBOnly) {
    const grades = window._ratingsGrades;
    if (grades && grades.size > 0) {
      const ok = new Set(['A+', 'A', 'A-', 'B+', 'B', 'B-']);
      list = list.filter(p => {
        const addrs = p.coinsAddresses;
        if (!Array.isArray(addrs) || !addrs.length) return false;
        return addrs.every(a => {
          const g = grades.get((a || '').toLowerCase());
          return g && ok.has(g);
        });
      });
    }
  }
  // Gainers / Losers — filter by weekly gauge-weight delta direction (ΔW). Both
  // active = union (any movement, hides flat-zero & no-data). No-data pools
  // (deltaPct == null) are always hidden when either pill is on.
  if (window.gainersOnly || window.losersOnly) {
    list = list.filter(p => {
      const wt = (window.GaugeWeights && p.gaugeAddress) ? window.GaugeWeights.getForGauge(p.gaugeAddress) : null;
      if (!wt || wt.deltaPct == null) return false;
      if (window.gainersOnly && window.losersOnly) return wt.deltaPct !== 0;
      if (window.gainersOnly) return wt.deltaPct > 0;
      return wt.deltaPct < 0;
    });
  }
  if (searchQuery) {
    const q = searchQuery.toLowerCase().trim();
    // Pair-search parts: split on / whitespace and -; require ≥2 chars each so
    // names like 'LUSD3CRV-f' or 'PT-…' don't false-match on tiny tail tokens.
    const parts = q.split(/[\s/\-]+/).filter(s => s.length >= 2);
    list = list.filter(p => {
      // Standard substring (covers literal name/address/coin matches).
      if (
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.address && p.address.toLowerCase().includes(q)) ||
        (p.coins && p.coins.some(c => c.toLowerCase().includes(q)))
      ) return true;
      // Order-independent pair-search fallback: ALL parts must appear among coins.
      if (parts.length >= 2 && p.coins && p.coins.length) {
        const coinsLc = p.coins.map(c => c.toLowerCase());
        return parts.every(part => coinsLc.some(c => c.includes(part)));
      }
      return false;
    });
  }
  list = [...list].sort((a, b) => {
    let va, vb;
    switch (sortField) {
      case 'name': va = (a.name || '').toLowerCase(); vb = (b.name || '').toLowerCase(); return sortDir * va.localeCompare(vb);
      case 'rating': {
        // Sort by min Pharos grade across pool coins. Numeric rank: A+=11 (top
        // when desc), F=0 (bottom). Pools with no rating ALWAYS sink to the
        // bottom regardless of sortDir (same pattern as gaugeDelta).
        const ga = _poolMinGrade(a);
        const gb = _poolMinGrade(b);
        if (ga == null && gb == null) { va = 0; vb = 0; break; }
        if (ga == null) return 1;  // a goes after b
        if (gb == null) return -1; // a goes before b
        va = _gradeRank(ga);
        vb = _gradeRank(gb);
        break;
      }
      case 'tvl': va = a.tvl || 0; vb = b.tvl || 0; break;
      case 'volume': va = a.volumeUSD || 0; vb = b.volumeUSD || 0; break;
      case 'apy': va = a.dailyApy || 0; vb = b.dailyApy || 0; break;
      case 'gauge':
        va = Array.isArray(a.gaugeCrvApy) ? (a.gaugeCrvApy[0] + a.gaugeCrvApy[1]) / 2 : 0;
        vb = Array.isArray(b.gaugeCrvApy) ? (b.gaugeCrvApy[0] + b.gaugeCrvApy[1]) / 2 : 0;
        break;
      case 'ext':
        va = a.extApr || 0;
        vb = b.extApr || 0;
        break;
      case 'totalApy': {
        const baseA = (a.bestTotalApy != null && a.bestTotalApy > 0) ? a.bestTotalApy : (a.totalApy || 0);
        const baseB = (b.bestTotalApy != null && b.bestTotalApy > 0) ? b.bestTotalApy : (b.totalApy || 0);
        va = simDepositAmount > 0 ? dilutedTotalApy(a, simDepositAmount) : baseA;
        vb = simDepositAmount > 0 ? dilutedTotalApy(b, simDepositAmount) : baseB;
        break;
      }
      case 'gaugeWeight': {
        const wa = (window.GaugeWeights && a.gaugeAddress) ? window.GaugeWeights.getForGauge(a.gaugeAddress) : null;
        const wb = (window.GaugeWeights && b.gaugeAddress) ? window.GaugeWeights.getForGauge(b.gaugeAddress) : null;
        va = (wa && wa.currentPct > 0) ? wa.currentPct : 0;
        vb = (wb && wb.currentPct > 0) ? wb.currentPct : 0;
        break;
      }
      case 'gaugeDelta': {
        // Signed numeric sort: positive on top when desc (default), negative on top when asc.
        // Pools without delta data sort to the bottom regardless of direction.
        const wa = (window.GaugeWeights && a.gaugeAddress) ? window.GaugeWeights.getForGauge(a.gaugeAddress) : null;
        const wb = (window.GaugeWeights && b.gaugeAddress) ? window.GaugeWeights.getForGauge(b.gaugeAddress) : null;
        const da = (wa && wa.deltaPct != null) ? wa.deltaPct : null;
        const db = (wb && wb.deltaPct != null) ? wb.deltaPct : null;
        if (da == null && db == null) { va = 0; vb = 0; break; }
        if (da == null) return 1;  // a goes after b
        if (db == null) return -1; // a goes before b
        va = da; vb = db;
        break;
      }
      case 'gaugeForecast': {
        // Sort by projected next-week CRV APR (max-boost). Falls back to
        // forecast weight when APR isn't available so killed-but-still-voted
        // gauges still rank.
        const wa = (window.GaugeWeights && a.gaugeAddress) ? window.GaugeWeights.getForGauge(a.gaugeAddress) : null;
        const wb = (window.GaugeWeights && b.gaugeAddress) ? window.GaugeWeights.getForGauge(b.gaugeAddress) : null;
        // Sort by base (no-boost) projected APR — matches the cell display.
        // Fallback chain: forecastCrvApyBase → forecastCrvApy (max-boost) → forecastPct.
        let fa = (wa && wa.forecastCrvApyBase != null) ? wa.forecastCrvApyBase
          : (wa && wa.forecastCrvApy != null) ? wa.forecastCrvApy
          : (wa && wa.forecastPct != null ? wa.forecastPct : null);
        let fb = (wb && wb.forecastCrvApyBase != null) ? wb.forecastCrvApyBase
          : (wb && wb.forecastCrvApy != null) ? wb.forecastCrvApy
          : (wb && wb.forecastPct != null ? wb.forecastPct : null);
        // Apply simulate-deposit dilution to match what's rendered in the cell,
        // so sort by FAPR after entering a deposit amount surfaces realistic
        // post-deposit yields, not tiny-gauge nominal projections (msg 666).
        // Skip dilution for the forecastPct fallback (weight % is not an APR).
        if (simDepositAmount > 0 && wa && (wa.forecastCrvApyBase != null || wa.forecastCrvApy != null)) {
          fa = gaugeDilutedApy(fa, a.gaugeTvlUsd, simDepositAmount);
        }
        if (simDepositAmount > 0 && wb && (wb.forecastCrvApyBase != null || wb.forecastCrvApy != null)) {
          fb = gaugeDilutedApy(fb, b.gaugeTvlUsd, simDepositAmount);
        }
        if (fa == null && fb == null) { va = 0; vb = 0; break; }
        if (fa == null) return 1;
        if (fb == null) return -1;
        va = fa; vb = fb;
        break;
      }
      default: va = a.tvl || 0; vb = b.tvl || 0;
    }
    return sortDir * (va - vb);
  });
  return list;
}

// Grade letter → numeric score for sorting + min-comparison. A+=11 (best),
// A=10, A-=9, B+=8, ..., F=0. Unknown grades → -1 so they sink to the bottom
// in desc sort and surface to top in asc sort (Alexandr 2026-05-15 spec).
const _GRADE_RANK = { 'A+': 11, 'A': 10, 'A-': 9, 'B+': 8, 'B': 7, 'B-': 6, 'C+': 5, 'C': 4, 'C-': 3, 'D+': 2, 'D': 1, 'D-': 0.5, 'F': 0 };
function _gradeRank(g) {
  if (g == null) return -1;
  const k = String(g).trim().toUpperCase();
  return _GRADE_RANK[k] != null ? _GRADE_RANK[k] : -1;
}
// Map of base-pool LP token address -> its underlying coin addresses (lowercase),
// built from our own pool list. A Curve metapool carries another pool's LP token
// as a "coin" (e.g. crv2pool = USDC/USDT 2pool LP, 3Crv = 3pool LP); that LP
// address is never in the ratings aggregator, which would blank the whole pool.
// We instead inherit the LP's grade from the base pool's underlying coins
// (Alexandr 2026-06-19). Data-driven - covers crv2pool, 3Crv and any base LP.
let _baseLpCoinsCache = null, _baseLpCoinsSrc = null;
function _baseLpCoinsMap() {
  if (_baseLpCoinsCache && _baseLpCoinsSrc === allPools) return _baseLpCoinsCache;
  const m = new Map();
  for (const p of allPools) {
    const coins = Array.isArray(p.coinsAddresses)
      ? p.coinsAddresses.map(x => String(x || '').toLowerCase()).filter(Boolean) : [];
    if (!coins.length) continue;
    const lp = String(p.lpTokenAddress || p.address || '').toLowerCase();
    const ad = String(p.address || '').toLowerCase();
    if (lp) m.set(lp, coins);
    if (ad) m.set(ad, coins);
  }
  _baseLpCoinsCache = m; _baseLpCoinsSrc = allPools;
  return m;
}
// Resolve one coin address to a Pharos grade letter. Direct cache hit wins;
// otherwise, if the address is a base-pool LP token, inherit the weakest grade
// across the base pool's underlying coins (recursively, cycle-guarded). Returns
// undefined when unrated/NR or any underlying is unrated - conservative.
function _coinGrade(a, grades, lpMap, seen) {
  a = String(a || '').toLowerCase();
  if (!a) return undefined;
  const g = grades.get(a);
  if (g) return String(g).toUpperCase() === 'NR' ? undefined : g;
  if (seen.has(a)) return undefined;
  const under = lpMap.get(a);
  if (!under || !under.length) return undefined;
  seen.add(a);
  let minRank = Infinity, minLetter;
  for (const u of under) {
    const ug = _coinGrade(u, grades, lpMap, seen);
    if (!ug) return undefined;
    const r = _gradeRank(ug);
    if (r < minRank) { minRank = r; minLetter = ug; }
  }
  return minLetter;
}
// Weakest (minimum) Pharos grade across pool.coinsAddresses. Returns the grade
// letter (string) if EVERY coin resolves to a rating, otherwise undefined - the
// cell is then rendered empty. Conservative rule per Alexandr 2026-05-15: any
// un-rated coin disqualifies the pool. Base-pool LP coins inherit from their
// underlying (2026-06-19) so metapools (crv2pool/3Crv) are no longer blanked.
function _poolMinGrade(p) {
  const grades = window._ratingsGrades;
  if (!grades || !grades.size) return undefined;
  const addrs = p && p.coinsAddresses;
  if (!Array.isArray(addrs) || !addrs.length) return undefined;
  const lpMap = _baseLpCoinsMap();
  const self = String((p && (p.lpTokenAddress || p.address)) || '').toLowerCase();
  let minRank = Infinity;
  let minLetter = undefined;
  for (const a of addrs) {
    const g = _coinGrade(a, grades, lpMap, new Set(self ? [self] : []));
    if (!g) return undefined;
    const r = _gradeRank(g);
    if (r < minRank) { minRank = r; minLetter = g; }
  }
  return minLetter;
}
// Render the rating pill HTML for a pool (centered span with grade-letter
// background per .pool-rating-pill.grade-X). Returns empty string when no
// rating to show; the wrapping .pool-item-rating cell stays in the row to
// preserve column alignment.
function _renderRatingCell(p) {
  const g = _poolMinGrade(p);
  if (!g) return `<div class="pool-item-rating"></div>`;
  const letter = String(g).trim().toUpperCase();
  // grade-A covers A+/A/A-, grade-B covers B+/B/B-, etc. (color buckets)
  const bucket = letter.charAt(0); // 'A', 'B', 'C', 'D', 'F'
  return `<div class="pool-item-rating"><span class="pool-rating-pill grade-${bucket}" title="Min Pharos grade across pool coins: ${letter}">${letter}</span></div>`;
}

function renderPoolList() {
  const list = getFilteredPools();
  const container = document.getElementById('poolList');
  const selectedAddr = selectedPool?.address?.toLowerCase();
  const show = list.slice(0, 200);
  const isYield = currentView === 'yield';
  // FAPR column lives Wed/Thu UTC only (same predicate as the header in
  // navigateToView). The row cell MUST disappear with the header: an extra
  // trailing 44px cell on other days shifts every column off its header
  // (Alexandr msg 1022, Friday misalignment).
  const _utcDay = new Date().getUTCDay();
  const faprVisible = (_utcDay === 3 || _utcDay === 4);

  container.innerHTML = show.map(p => {
    const isActive = p.address.toLowerCase() === selectedAddr;
    // Escape API-sourced strings before any innerHTML interpolation below.
    // Curve factory pools allow permissionless metadata, so symbol/name are
    // attacker-controllable.
    const coinSymbols = p.coins.length > 0 ? escapeHtml(p.coins.join(' / ')) : '';
    const poolName = escapeHtml(p.name || p.address.slice(0, 12));
    const apyVal = p.dailyApy || 0;
    const apyClass = apyVal >= 10 ? 'high' : apyVal >= 2 ? 'medium' : 'low';
    const gaugeApy = (Array.isArray(p.gaugeCrvApy) ? ((p.gaugeCrvApy[0] + p.gaugeCrvApy[1]) / 2) : 0) * crvPriceRatio();

    // Use bestTotalApy (max across Curve / Convex / StakeDAO) when available, fallback to Curve total
    const rawTotalApy = (p.bestTotalApy != null && p.bestTotalApy > 0) ? p.bestTotalApy : (p.totalApy || 0);
    const totalApyVal = isYield && (simDepositAmount > 0 || crvPriceRatio() !== 1) ? dilutedTotalApy(p, simDepositAmount) : rawTotalApy;
    const totalApyClass = totalApyVal >= 5 ? 'high' : totalApyVal >= 1 ? 'medium' : 'low';
    const extApr = p.extApr || 0;

    let cols = '';
    if (isYield) {
      const merklBadge = p.merklApr > 0 ? `<span class="merkl-badge" title="Merkl +${p.merklApr.toFixed(1)}%">M</span>` : '';
      // Source badge: Cx / Sd / C (Curve) — only show if non-Curve wins
      let srcBadge = '';
      if (p.bestSrc === 'Cx') srcBadge = `<span class="src-badge src-cx" title="Convex wins (best total APR)">Cx</span>`;
      else if (p.bestSrc === 'Sd') srcBadge = `<span class="src-badge src-sd" title="StakeDAO wins (best total APR)">Sd</span>`;
      // Tooltip with breakdown
      const tt = _buildTotalApyTooltip(p);
      // Gauge weight cells — split into 2 columns. Each cell has its OWN
      // visibility predicate so e.g. a pool whose emission was just CUT to 0
      // still shows ΔW (negative delta) even though WT is "--":
      //   WT  shown when currentPct > 0
      //   ΔW  shown whenever any movement is meaningful — i.e.
      //         (currentPct > 0 OR prevPct > 0 OR rankDelta != 0).
      //       Pure 0/0/no-rank-change rows render "--" (nothing to say).
      const wt = (window.GaugeWeights && p.gaugeAddress) ? window.GaugeWeights.getForGauge(p.gaugeAddress) : null;
      let weightCell = `<div class="pool-item-weight">${EMPTY_HTML}</div>`;
      let deltaCell = `<div class="pool-item-weight-delta">${EMPTY_HTML}</div>`;
      // FW (Forecast Weight) — next-Thursday weight from on-chain
      // gauge_future_relative_weight (real votes, not extrapolation). Read
      // straight from getAllGauges API; reflects all currently locked
      // vote_user_slopes. Hidden when no signal exists (currentPct=0 and
      // futurePct=0).
      let forecastCell = `<div class="pool-item-weight-forecast">${EMPTY_HTML}</div>`;
      if (wt) {
        if (wt.currentPct > 0) {
          const pct = wt.currentPct.toFixed(2);
          const wtTitle = `Gauge weight ${pct}%` + (wt.prevPct != null ? ` (prev week ${wt.prevPct.toFixed(2)}%)` : '') + ` · rank #${wt.rank}` + (wt.prevRank != null ? ` (prev #${wt.prevRank})` : '') + (wt.forecastPct != null ? ` · next-week ${wt.forecastPct.toFixed(2)}%` : '');
          weightCell = `<div class="pool-item-weight" title="${wtTitle}"><span class="gw-pct">${pct}%</span></div>`;
        } else if (p.gaugeIsKilled) {
          // Killed gauge with currentPct=0 — slot the empty WT cell with a `kill`
          // tag so the row carries the same warning sortable inside the WT
          // column (Алекс crvecodev/502 idea: reuse otherwise-empty space).
          const wtTitle = `Gauge killed by Curve DAO — protocol deprecated, deposits disabled.${wt.prevPct != null && wt.prevPct > 0 ? ` Prev-week weight ${wt.prevPct.toFixed(2)}%.` : ''}`;
          weightCell = `<div class="pool-item-weight pool-weight-killed" title="${wtTitle}"><span class="gw-tag-killed">kill</span></div>`;
        } else if (
          p.gaugeAddress && p.gaugeAddress !== '0x0000000000000000000000000000000000000000' &&
          (wt.prevPct == null || wt.prevPct === 0) &&
          p.creationTs && (Date.now() / 1000 - p.creationTs) <= 14 * 86400
        ) {
          // `new` tag — gauge connected, no emission yet, AND pool created
          // within last 14 days (Алекс crvecodev/507: tighten window to skip
          // long-dormant pools like YB which have gauge but never emit).
          // creationTs comes from /getPools per-registry API; cache.json may
          // miss it, in which case we silently skip the tag.
          const ageDays = Math.floor((Date.now() / 1000 - p.creationTs) / 86400);
          weightCell = `<div class="pool-item-weight pool-weight-new" title="New pool (${ageDays}d old). Gauge connected but emission not yet started."><span class="gw-tag-new">new</span></div>`;
        }
        // Forecast cell: shows next-week PROJECTED CRV APR (max-boost) directly
        // in the table. Tooltip carries the boost-range (base → max-boost),
        // forecast weight, and weight-delta vs current.
        // Visibility predicate unchanged: show whenever current OR next-week
        // weight has signal (>0.005%).
        // Day-of-week guard: only render FAPR Wed/Thu UTC (matches column header visibility).
        if (faprVisible && wt.forecastPct != null && (wt.currentPct > 0.005 || wt.forecastPct > 0.005)) {
          const fpct = wt.forecastPct.toFixed(2);
          const fdelta = (wt.forecastDeltaPct != null) ? wt.forecastDeltaPct : null;
          const fdeltaTxt = (fdelta != null)
            ? ` (Δ ${fdelta >= 0 ? '+' : ''}${fdelta.toFixed(3)}pp vs current)`
            : '';
          // FAPR is a pure CRV-emission APR → scales with the CRV what-if price.
          const apyMaxRaw = (wt.forecastCrvApy != null && wt.forecastCrvApy > 0) ? wt.forecastCrvApy * crvPriceRatio() : null;
          const apyMinRaw = (wt.forecastCrvApyBase != null && wt.forecastCrvApyBase > 0) ? wt.forecastCrvApyBase * crvPriceRatio() : null;
          // Simulate-deposit dilution: FAPR is a CRV-emission APR → dilutes by
          // gauge.tvl (same as crv portion in dilutedTotalApy). Without this
          // FAPR shows raw projected % while TOTAL already accounts for the
          // deposit, so the two columns disagree by orders of magnitude on
          // small/ε-tvl gauges (Александр screenshot msg 666: FAPR 3563% while
          // TOTAL 0.1% on USDC/USG with $10K simulate).
          const apyMax = (apyMaxRaw != null && simDepositAmount > 0)
            ? gaugeDilutedApy(apyMaxRaw, p.gaugeTvlUsd, simDepositAmount)
            : apyMaxRaw;
          const apyMin = (apyMinRaw != null && simDepositAmount > 0)
            ? gaugeDilutedApy(apyMinRaw, p.gaugeTvlUsd, simDepositAmount)
            : apyMinRaw;
          // Cell text: base (no-boost) APR — most LPs operate without max veCRV boost.
          // Fall back to max-boost APR, then weight % if APRs unavailable.
          let cellTxt;
          if (apyMin != null) {
            cellTxt = apyMin.toFixed(2) + '%';
          } else if (apyMax != null) {
            cellTxt = apyMax.toFixed(2) + '%';
          } else {
            cellTxt = fpct + '%';
          }
          let rangeTxt = '';
          if (apyMin != null && apyMax != null) {
            rangeTxt = `Projected CRV APR ${apyMin.toFixed(2)}% (no boost) → ${apyMax.toFixed(2)}% (×2.5 with full veCRV). `;
          } else if (apyMax != null) {
            rangeTxt = `Projected CRV APR ${apyMax.toFixed(2)}% at max ×2.5 boost. `;
          } else if (apyMin != null) {
            rangeTxt = `Projected CRV APR ${apyMin.toFixed(2)}% (no boost). `;
          }
          const dilNote = (simDepositAmount > 0 && (apyMinRaw != null || apyMaxRaw != null))
            ? `Diluted by $${simDepositAmount.toLocaleString('en-US')} simulated deposit (raw ${(apyMinRaw ?? apyMaxRaw).toFixed(2)}%${apyMaxRaw != null && apyMinRaw != null ? ' → ' + apyMaxRaw.toFixed(2) + '%' : ''}). `
            : '';
          const fTitle = `${rangeTxt}${dilNote}Next-Thursday gauge weight ${fpct}%${fdeltaTxt}. Source: currently locked vote_user_slopes via Curve API.`;
          forecastCell = `<div class="pool-item-weight-forecast" title="${fTitle}"><span class="gw-forecast">${cellTxt}</span></div>`;
        }
        // ΔW visibility: only render when the gauge actually had emission in
        // ≥1 of the two weeks compared. Rationale (Алекс crvecodev/493 2026-05-02):
        // gauges with currentPct=0 AND prevPct=0 still get a numeric rank from
        // the sort step (tie-break by gauge address among ~hundreds of dead
        // gauges). That produces phantom rank-deltas (↑N/↓N) for pools that
        // never had any CRV emission, which reads as "the position changed for
        // a non-emitting pool" and is misleading. Gating the entire cell on
        // hadEmission removes that noise: rank movement only matters when
        // emission was non-zero in at least one of the two weekly snapshots.
        const hasDelta = (wt.deltaPct != null) && Math.abs(wt.deltaPct) >= 0.005;
        const hasRankMove = (wt.rankDelta != null) && wt.rankDelta !== 0;
        const hadEmission = (wt.currentPct > 0.005) || (wt.prevPct != null && wt.prevPct > 0.005);
        if (hadEmission && (hasDelta || hasRankMove || wt.deltaPct != null)) {
          let dParts = [];
          if (wt.deltaPct == null) {
            dParts.push('<span class="gw-flat">new</span>');
          } else if (Math.abs(wt.deltaPct) < 0.005) {
            dParts.push('<span class="gw-flat">·</span>');
          } else {
            const cls = wt.deltaPct > 0 ? 'gw-up' : 'gw-down';
            const sign = wt.deltaPct > 0 ? '+' : '−';
            dParts.push(`<span class="${cls}">${sign}${Math.abs(wt.deltaPct).toFixed(2)}</span>`);
          }
          if (hasRankMove) {
            const cls = wt.rankDelta > 0 ? 'gw-up' : 'gw-down';
            const arrow = wt.rankDelta > 0 ? '↑' : '↓';
            dParts.push(`<span class="${cls}">${arrow}${Math.abs(wt.rankDelta)}</span>`);
          }
          const dTitle = (wt.deltaPct != null ? `Weekly Δ: ${wt.deltaPct > 0 ? '+' : ''}${wt.deltaPct.toFixed(2)}pp` : 'No prev-week data') + (wt.rankDelta != null ? ` · rank ${wt.rankDelta > 0 ? '+' : ''}${wt.rankDelta}` : '');
          deltaCell = `<div class="pool-item-weight-delta" title="${dTitle}">${dParts.join('')}</div>`;
        } else if (wt.deltaPct == null && wt.currentPct > 0) {
          // brand-new gauge: currentPct exists but no prev-week
          deltaCell = `<div class="pool-item-weight-delta" title="No prev-week data"><span class="gw-flat">new</span></div>`;
        }
      }
      const gaugeLine = gaugeApy > 0 ? `<span class="pig-crv">${fmtPct1(gaugeApy)}</span>` : '';
      const extLine = extApr > 0 ? `<span class="pig-ext">${fmtPct1(extApr)}</span>` : '';
      const gaugeExtInner = (gaugeLine || extLine) ? (gaugeLine + extLine) : EMPTY_HTML;
      const ratingCell = _renderRatingCell(p);
      // Skip wrapping <span class="src-badge-slot"> entirely when srcBadge empty
      // so the slot doesn't reserve 16px before merkl-badge (Alexandr 2026-05-15).
      // CSS .src-badge-slot:empty{display:none} is a belt-and-suspenders backstop.
      const srcSlotHtml = srcBadge ? `<span class="src-badge-slot">${srcBadge}</span>` : '';
      cols = `${ratingCell}
        <div class="pool-item-tvl">${p.tvl > 0 ? fmtCompact(p.tvl) : EMPTY_HTML}</div>
        <div class="pool-item-apy ${apyClass}">${apyVal != null && !isNaN(apyVal) ? fmtPct1(apyVal) : EMPTY_HTML}</div>
        <div class="pool-item-gauge-ext" title="CRV: ${gaugeApy > 0 ? fmtPct1(gaugeApy) : '—'} | External (non-CRV): ${_buildExtTooltip(p)}">${gaugeExtInner}</div>
        <div class="pool-item-total-apy ${totalApyClass}" title="${tt}">${totalApyVal > 0 ? fmtPct1(totalApyVal) : EMPTY_HTML}${srcSlotHtml}${merklBadge}</div>
        ${weightCell}
        ${deltaCell}
        ${faprVisible ? forecastCell : ''}`;
    } else {
      const chg = p._priceChange24h != null ? p._priceChange24h : null;
      const chgClass = chg == null ? '' : chg > 0 ? 'high' : chg < 0 ? 'low' : 'medium';
      const chgText = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : EMPTY_HTML;
      cols = `<div class="pool-item-tvl">${p.tvl > 0 ? fmtCompact(p.tvl) : EMPTY_HTML}</div>
        <div class="pool-item-vol">${p.volumeUSD > 0 ? fmtCompact(p.volumeUSD) : EMPTY_HTML}</div>
        <div class="pool-item-apy ${chgClass}">${chgText}</div>`;
    }

    // Pool coin icons (all coins, overlapping clover style)
    const coinIcons = (p.coinsAddresses || []).filter(a => a && a !== '0x0000000000000000000000000000000000000000').map(a =>
      `<img class="token-icon" src="${_tokenIconUrl(a)}" alt="" width="18" height="18" loading="lazy" onerror="this.style.display='none'">`
    ).join('');

    // Inline favorite toggle — fills when starred (icon-star-filled), outline otherwise.
    // event.stopPropagation prevents row-click selectPool when only the star is clicked.
    const isFav = (typeof window._isFavoritePool === 'function') ? window._isFavoritePool(p.address) : false;
    const favIcon = isFav
      ? `<svg class="icon icon--filled"><use href="#icon-star-filled"/></svg>`
      : `<svg class="icon"><use href="#icon-star-outline"/></svg>`;
    const favBtn = `<button class="pool-item-fav${isFav ? ' active' : ''}" type="button" title="${isFav ? 'Remove from Favorites' : 'Add to Favorites'}" onclick="event.stopPropagation(); window.toggleFavoriteByAddr && window.toggleFavoriteByAddr('${p.address}')" aria-label="Toggle favorite" aria-pressed="${isFav}">${favIcon}</button>`;

    // Deprecated badge — two triggers, same visual: Curve API gauge.is_killed
    // (Iron Bank etc.) or registry deprecated/withdraw-only flag (Fantom/Avax
    // cross-chain synth pools). Tooltip explains which.
    const deprTitle = p.deprecated
      ? 'Deprecated pool — withdraw only. Exit liquidity is supported; new deposits are discouraged.'
      : (p.suspectOracle
        ? 'Rate oracle detected on a blue-chip stable in this pool. The deployer can reprice deposits — likely a trap, avoid depositing.'
        : 'Gauge killed by Curve DAO — protocol deprecated, deposits disabled on curve.finance. Avoid this pool.');
    const killedBadge = (p.gaugeIsKilled || p.deprecated || p.suspectOracle)
      ? `<span class="pool-deprecated-badge" title="${deprTitle}">⚠️</span>`
      : '';
    const itemClass = `pool-item${isActive ? ' active' : ''}${p.gaugeIsKilled ? ' pool-deprecated' : ''}`;
    return `<div class="${itemClass}" data-addr="${p.address}" onclick="selectPool('${p.address}')">
      ${favBtn}
      <div class="pool-item-info" title="${poolName}\n${coinSymbols}${p.deprecated ? '\n⚠ Deprecated — withdraw only' : (p.gaugeIsKilled ? '\n⚠ Deprecated (gauge killed)' : '')}">
        <div class="pool-item-name" style="display:flex;align-items:center;gap:3px">${killedBadge}${coinIcons}<span class="pin-label">${coinSymbols || poolName}</span></div>
        ${coinSymbols ? `<div class="pool-item-coins">${poolName}</div>` : ''}
      </div>
      ${cols}
    </div>`;
  }).join('');

  document.getElementById('poolCount').textContent = `${list.length} pools${list.length < allPools.length ? ` (filtered from ${allPools.length})` : ''}`;
}

// ============================================================

// POOL SELECTION (unified)
// ============================================================
async function selectPool(address) {
  const pool = poolsByAddress.get(address.toLowerCase());
  if (!pool) return;

  selectedPool = pool;
  // Reset the Pools-tab ↔️ price-direction toggle to canonical on every pool switch.
  if (typeof poolPriceInverted !== 'undefined') { poolPriceInverted = false; if (typeof _syncPoolPriceInvertBtn === 'function') _syncPoolPriceInvertBtn(); }
  if (typeof toggleMobileSidebar === 'function') toggleMobileSidebar(true);

  // Notify other modules (info_tab.js) that the pool changed.
  try { document.dispatchEvent(new CustomEvent('curvedex:poolSelected', { detail: { address } })); } catch (_) {}

  // Highlight in pool list
  document.querySelectorAll('.pool-item').forEach(el => {
    el.classList.toggle('active', el.dataset.addr?.toLowerCase() === address.toLowerCase());
  });

  // Update hash
  updateHash();

  // Load data for current view
  await loadViewData();
}

async function loadViewData() {
  if (!selectedPool) return;
  const addr = selectedPool.address;

  if (currentView === 'pools') {
    // Update pools (chart+swap) UI
    updateTradeHeader();
    updateTradePoolInfo();
    if (selectedPool.coins.length >= 2 && selectedPool.coinsAddresses.length >= 2) {
      setFromToken(0);
      setToToken(1);
    }
    updateSwapButton();
    initTradeChart();
    await Promise.all([loadOHLC(), loadTrades()]);
    if (walletAddress) loadTradeBalances();
    tradeDataLoadedFor = addr;
  } else {
    // Update yield UI
    updateYieldHeader();
    updateYieldPoolInfo();
    buildDepositUI();
    buildWithdrawUI();
    updateStakeSection();
    if (typeof updateWithdrawGaugeActions === 'function') updateWithdrawGaugeActions();
    updateComposition();
    updateDepositButton();
    updateWithdrawButton();
    initYieldChart();
    await loadApyHistory();
    if (walletAddress) loadAllYieldBalances();
    yieldDataLoadedFor = addr;
    // Re-estimate gas for the now-selected pool (gauge/lp may differ)
    if (typeof window._yieldGasReestimate === 'function') window._yieldGasReestimate();
  }
}


// ============================================================
// WALLET CONNECTION (shared)
// ============================================================
let _ethersLoadPromise = null;
async function loadEthers() {
  if (typeof ethers !== 'undefined') return;
  if (_ethersLoadPromise) return _ethersLoadPromise;
  _ethersLoadPromise = new Promise((resolve, reject) => {
    const cdns = [
      'https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js',
      'https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js',
      'https://unpkg.com/ethers@6.13.4/dist/ethers.umd.min.js',
    ];
    // SRI hash for ethers@6.13.4 UMD bundle — verified identical bytes across
    // jsdelivr/cdnjs/unpkg 2026-05-17. If hashes mismatch (CDN compromise),
    // browser refuses to execute and onerror fires → fallback to next CDN.
    const SRI = 'sha384-6Zl0Pc8zjSz8KvmNeXRvUQgY4ryFb+BwDvKCmLYcBME0joAaru491tQgi9B7zsMM';
    let loaded = false;
    function tryLoad(i) {
      if (i >= cdns.length) { reject(new Error('Failed to load ethers.js from all CDNs')); return; }
      const s = document.createElement('script');
      s.src = cdns[i];
      s.integrity = SRI;
      s.crossOrigin = 'anonymous';
      s.onload = () => { loaded = true; resolve(); };
      s.onerror = () => { if (!loaded) tryLoad(i + 1); };
      document.head.appendChild(s);
    }
    tryLoad(0);
  });
  _ethersLoadPromise.catch(() => { _ethersLoadPromise = null; });
  return _ethersLoadPromise;
}

async function connectWallet() {
  if (!window.ethereum) {
    alert('Wallet not detected. Please open this page in a browser with an EVM-compatible wallet extension (or via your wallet\'s in-app browser).');
    return;
  }
  const btn = document.getElementById('walletBtn');
  // Show loader from the very first click — covers ethers load, MetaMask
  // popup-prep (1-3s for Rabby), and getSigner. Restored to "Connect Wallet"
  // on error; on success the connected-state markup overwrites it below.
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="wallet-btn-text">Connecting...</span>';
  }
  try {
    if (typeof ethers === 'undefined') {
      await loadEthers();
    }
    provider = new ethers.BrowserProvider(window.ethereum);
    const accounts = await provider.send('eth_requestAccounts', []);
    walletAddress = accounts[0];
    // Wallet changed -> drop any stale cache from previous wallet
    if (typeof _resetWalletBalanceCache === 'function') _resetWalletBalanceCache();
    signer = await provider.getSigner();
    btn.innerHTML = '<span class="wallet-btn-icon" aria-hidden="true"><svg class="icon"><use href="#icon-profile"/></svg></span><span class="wallet-btn-text">' + shortAddr(walletAddress) + '</span>';
    btn.className = 'wallet-btn connected';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'Click for menu (Dashboard, Disconnect)';
    if (window.Portfolio && typeof window.Portfolio.attachWalletDropdown === 'function') {
      window.Portfolio.attachWalletDropdown();
    }
    try {
      localStorage.setItem('curvedex_wallet_connected', '1');
      localStorage.setItem('curvedex_wallet_address', walletAddress);
    } catch (e) {}
    updateSwapButton();
    updateDepositButton();
    updateWithdrawButton();
    updateTradePairButton();
    // Update all view-specific buttons and balances
    if (typeof updateSwapViewButton === 'function') updateSwapViewButton();
    if (selectedPool) {
      if (currentView === 'pools') loadTradeBalances();
      else if (currentView === 'yield') loadAllYieldBalances();
    }
    if (currentView === 'trade' && selectedPair) loadTradePairBalances();
    if (currentView === 'swap') {
      if (typeof loadSwapBalances === 'function') loadSwapBalances();
    }
    if (currentView === 'portfolio' && window.Portfolio) window.Portfolio.open();
    // No portfolio preload here — preload of 2160 pools through the wallet's
    // serial RPC queue made connectWallet feel frozen. Dashboard now does its
    // own first-open fetch on demand (slightly slower first open, instant
    // wallet connect). Removed 2026-04-28 (commit 793814f0 was the regression).
  } catch (e) {
    console.error('Wallet connect error:', e);
    // Restore button to clickable "Connect Wallet" state so user can retry.
    if (btn && !walletAddress) {
      btn.disabled = false;
      btn.innerHTML = '<span class="wallet-btn-icon" aria-hidden="true"><svg class="icon"><use href="#icon-wallet"/></svg></span><span class="wallet-btn-text">Connect Wallet</span>';
    }
  } finally {
    // Re-enable on success too — connected state is just a different render.
    if (btn) btn.disabled = false;
  }
}

// Auto-reconnect wallet on page reload — silent (eth_accounts, no popup).
// Triggered only if user previously connected (flag in localStorage).
async function tryAutoReconnectWallet() {
  let flag;
  try { flag = localStorage.getItem('curvedex_wallet_connected'); } catch (e) { return; }
  if (flag !== '1' || !window.ethereum) return;
  try {
    // Silent check — does NOT trigger MetaMask popup
    const accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (!Array.isArray(accounts) || accounts.length === 0) {
      // User disconnected externally (MetaMask) — clear flag
      try {
        localStorage.removeItem('curvedex_wallet_connected');
        localStorage.removeItem('curvedex_wallet_address');
      } catch (e) {}
      return;
    }
    if (typeof ethers === 'undefined') await loadEthers();
    provider = new ethers.BrowserProvider(window.ethereum);
    walletAddress = accounts[0];
    if (typeof _resetWalletBalanceCache === 'function') _resetWalletBalanceCache();
    signer = await provider.getSigner();
    try { localStorage.setItem('curvedex_wallet_address', walletAddress); } catch (e) {}
    const btn = document.getElementById('walletBtn');
    if (btn) {
      btn.innerHTML = '<span class="wallet-btn-icon" aria-hidden="true"><svg class="icon"><use href="#icon-profile"/></svg></span><span class="wallet-btn-text">' + shortAddr(walletAddress) + '</span>';
      btn.className = 'wallet-btn connected';
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.title = 'Click for menu (Dashboard, Disconnect)';
    }
    if (window.Portfolio && typeof window.Portfolio.attachWalletDropdown === 'function') {
      window.Portfolio.attachWalletDropdown();
    }
    updateSwapButton();
    updateDepositButton();
    updateWithdrawButton();
    updateTradePairButton();
    if (typeof updateSwapViewButton === 'function') updateSwapViewButton();
    if (selectedPool) {
      if (currentView === 'pools') loadTradeBalances();
      else if (currentView === 'yield') loadAllYieldBalances();
    }
    if (currentView === 'trade' && selectedPair) loadTradePairBalances();
    if (currentView === 'swap' && typeof loadSwapBalances === 'function') loadSwapBalances();
    if (currentView === 'portfolio' && window.Portfolio) window.Portfolio.open();
    // No portfolio preload — see connectWallet for rationale.
  } catch (e) {
    console.warn('Auto-reconnect failed:', e);
  }
}

if (window.ethereum) {
  window.ethereum.on('accountsChanged', accounts => {
    if (accounts.length === 0) {
      walletAddress = null; signer = null;
      if (typeof _resetWalletBalanceCache === 'function') _resetWalletBalanceCache();
      const wbtn = document.getElementById('walletBtn');
      wbtn.innerHTML = '<span class="wallet-btn-icon" aria-hidden="true"><svg class="icon"><use href="#icon-wallet"/></svg></span><span class="wallet-btn-text">Connect Wallet</span>';
      wbtn.className = 'wallet-btn';
      wbtn.removeAttribute('aria-haspopup');
      wbtn.removeAttribute('aria-expanded');
      wbtn.removeAttribute('title');
      wbtn.onclick = connectWallet;
      try {
        localStorage.removeItem('curvedex_wallet_connected');
        localStorage.removeItem('curvedex_wallet_address');
        localStorage.removeItem('curvedex_portfolio_v1');
      } catch (e) {}
      // If on portfolio view, re-render empty state
      if (currentView === 'portfolio' && window.Portfolio) window.Portfolio.open();
    } else {
      // Wallet changed -> drop stale cache before re-fetching
      if (typeof _resetWalletBalanceCache === 'function') _resetWalletBalanceCache();
      walletAddress = accounts[0];
      try {
        localStorage.setItem('curvedex_wallet_connected', '1');
        localStorage.setItem('curvedex_wallet_address', walletAddress);
      } catch (e) {}
      const wbtn = document.getElementById('walletBtn');
      wbtn.innerHTML = '<span class="wallet-btn-icon" aria-hidden="true"><svg class="icon"><use href="#icon-profile"/></svg></span><span class="wallet-btn-text">' + shortAddr(walletAddress) + '</span>';
      wbtn.setAttribute('aria-haspopup', 'menu');
      wbtn.setAttribute('aria-expanded', 'false');
      wbtn.title = 'Click for menu (Dashboard, Disconnect)';
      // Bug 4: invalidate stale portfolio cache (tied to old address) + re-bind dropdown handler
      if (window.Portfolio) {
        if (typeof window.Portfolio._invalidateCache === 'function') window.Portfolio._invalidateCache();
        if (typeof window.Portfolio.attachWalletDropdown === 'function') window.Portfolio.attachWalletDropdown();
        if (location.hash === '#/portfolio') window.Portfolio.open();
        // No preload here — see connectWallet for rationale.
      }
      if (selectedPool) {
        if (currentView === 'pools') loadTradeBalances();
        else if (currentView === 'yield') loadAllYieldBalances();
      }
    }
    updateSwapButton();
    updateDepositButton();
    updateWithdrawButton();
    updateTradePairButton();
    if (currentView === 'trade' && selectedPair && walletAddress) loadTradePairBalances();
  });
  window.ethereum.on('chainChanged', () => window.location.reload());
}


// ============================================================
// GAUGES DATA (CRV rewards + extra rewards)
// ============================================================
// Merkl rewards cache
let merklRewardsMap = new Map(); // address (lower) → apr
let merklLastFetch = 0;
const MERKL_REFRESH_MS = 5 * 60 * 1000; // 5 minutes

// Base (trading-fee) APY for Curve Lite chains, derived from virtualPrice growth
// (Lite exposes no getVolumes). Reads the daily vp snapshot history and annualizes
// vp growth over the available window (~7d target). Sets dailyApy/weeklyApy/totalApy
// so the APY + TOTAL columns populate. No-op on non-Lite chains. (Alexandr 2026-06-19)
async function loadBaseApyVp() {
  const ck = getChainKey();
  const cc = CHAINS_CONFIG && CHAINS_CONFIG.chains && CHAINS_CONFIG.chains[ck];
  if (!cc || !cc.lite) return;
  let hist;
  try {
    const base = (window.__DYNAMIC_BASE || "");
    const resp = await fetch(base + "/curvedex/vp_history.json?v=" + (window.__APP_VERSION__ || ""), { cache: "no-cache" });
    if (!resp.ok) return;
    hist = await resp.json();
  } catch (e) { console.warn("[vp] history fetch failed:", e && e.message); return; }
  const series = hist && hist.chains && hist.chains[ck];
  if (!series) return;
  let applied = 0;
  for (const pool of allPools) {
    const s = series[(pool.address || "").toLowerCase()];
    if (!Array.isArray(s) || s.length < 2) continue;
    const a0 = s[0], aN = s[s.length - 1];
    const v0 = a0[1], vN = aN[1];
    if (!(v0 > 0) || !(vN > 0)) continue;
    const days = (Date.parse(aN[0]) - Date.parse(a0[0])) / 86400000;
    if (!(days >= 1)) continue;
    let apy = (vN / v0 - 1) * (365 / days) * 100;
    if (!isFinite(apy) || apy < 0) apy = 0;
    apy = Math.min(apy, 1000);
    pool.dailyApy = apy;
    pool.weeklyApy = apy;
    pool.totalApy = apy;
    pool.baseApyFromVp = apy;
    applied++;
  }
  if (applied > 0 && typeof renderPoolList === "function") renderPoolList();
}

async function loadMerklRewards() {
  try {
    const resp = await fetch(`https://api.merkl.xyz/v4/opportunities?chainId=${getChainId()}&tags=curve`);
    if (!resp.ok) return;
    const data = await resp.json();
    if (!Array.isArray(data)) return;
    const newMap = new Map();
    for (const opp of data) {
      const addr = (opp.identifier || '').toLowerCase();
      const apr = parseFloat(opp.apr);
      if (addr && isFinite(apr) && apr > 0) {
        // Keep highest APR if multiple entries for same address
        const existing = newMap.get(addr) || 0;
        if (apr > existing) newMap.set(addr, apr);
      }
    }
    merklRewardsMap = newMap;
    merklLastFetch = Date.now();
    // Apply to pools
    applyMerklToPools();
  } catch (e) { console.warn('Merkl API error (non-fatal):', e); }
}

function applyMerklToPools() {
  for (const pool of allPools) {
    const poolAddr = pool.address.toLowerCase();
    const gaugeAddr = (pool.gaugeAddress || '').toLowerCase();
    const merkl = merklRewardsMap.get(poolAddr) || merklRewardsMap.get(gaugeAddr) || 0;
    pool.merklApr = merkl;
  }
}

// ============================================================
// Cross-platform APR merge (Curve + Convex + StakeDAO)
// ============================================================
// Populates per-pool: cvxApr, sdApr, extApr, bestTotalApy, bestSrc.
// Curve "extras" portion = sum of all extraRewards.apy entries (non-CRV).
// Convex non-CRV portion = extra + cvx (CVX is incentive token, not CRV).
// StakeDAO has no breakdown in our cache (single total + boost), but
// for visualisation we approximate StakeDAO non-CRV as max(0, total - gaugeCrvAvg)
// when gaugeCrvAvg > 0, else the full total (no Curve gauge → all "extra").
function _curveExtraSum(pool) {
  if (!Array.isArray(pool.extraRewards)) return 0;
  let s = 0;
  for (const r of pool.extraRewards) {
    const v = parseFloat(r.apy);
    if (isFinite(v) && v > 0) s += v;
  }
  return s;
}
function _gaugeCrvAvg(pool) {
  return Array.isArray(pool.gaugeCrvApy) ? (pool.gaugeCrvApy[0] + pool.gaugeCrvApy[1]) / 2 : 0;
}
function _safe(n) { return (typeof n === 'number' && isFinite(n) && n > 0) ? n : 0; }

function mergePlatformAprs() {
  // Look up Convex/StakeDAO entries for each pool from already-fetched caches.
  // _convexCache / _stakedaoCache live in yield.js (script-scoped, accessible as globals).
  const cvxMap = (typeof _convexCache !== 'undefined' && _convexCache) ? _convexCache.byPoolAddr : null;
  const sdCache = (typeof _stakedaoCache !== 'undefined' && _stakedaoCache) ? _stakedaoCache : null;
  for (const pool of allPools) {
    const cvx = cvxMap ? lookupConvexApr(pool, cvxMap) : null;
    const sd = sdCache ? lookupStakeDaoApr(pool, sdCache) : null;
    pool.cvxApr = cvx;  // {total, base, crv, cvx, extra, boost, pid} or null
    pool.sdApr = sd;    // {total, boost, vault, extras, tradingFees, crv, bonus} or null

    const curveExtra = _curveExtraSum(pool);
    const cvxNonCrv = cvx ? (_safe(cvx.cvx) + _safe(cvx.extra)) : 0;
    const sdNonCrv = sd ? _safe(sd.extras) : 0;

    pool.extApr = Math.max(curveExtra, cvxNonCrv, sdNonCrv);

    // ─── Uniform base APY architecture (msg 590, 2026-05-08) ───
    // Прежняя `pool.totalApy` от Curve бралась с 7d окном (pool.weeklyApy + crvAvg + extras),
    // Convex считает baseApy на своём окне (свежее, ~24h), SD = tradingFees+CRV+extras
    // (фактически тоже ~24h). Сравнение `max(curveTotal, cvxTotal, sdTotal)` искажалось,
    // т.к. base APY у троих был на разных окнах. Решение от msg 592 «7d бери»:
    // зафиксировать base как pool.weeklyApy (Curve 7d) и сравнивать ТОЛЬКО bonus.
    // 2026-05-20: молодые пулы (sUSDat, <7d) не имеют weeklyApy → baseUniform=0
    // → TOTAL=0 → прочерк (Александр msg 876). Fallback на dailyApy для свежих пулов.
    // Параллельно curveBonus считаем напрямую из gauge+extras (не через вычитание),
    // т.к. для молодого пула pool.totalApy тоже может быть null.
    const baseUniform = _safe(pool.weeklyApy) || _safe(pool.dailyApy);
    const curveBonusDirect = _gaugeCrvAvg(pool) + curveExtra;
    const curveBonusSubtract = Math.max(0, _safe(pool.totalApy) - _safe(pool.weeklyApy));
    const curveBonus = Math.max(curveBonusDirect, curveBonusSubtract);
    const cvxBonus = cvx ? (_safe(cvx.crv) + _safe(cvx.cvx) + _safe(cvx.extra)) : 0;
    const sdBonus = sd ? _safe(sd.bonus) : 0;

    let bestBonus = curveBonus, src = 'C';
    if (cvxBonus > bestBonus) { bestBonus = cvxBonus; src = 'Cx'; }
    if (sdBonus > bestBonus) { bestBonus = sdBonus; src = 'Sd'; }
    pool.bestBonus = bestBonus;
    pool.bestTotalApy = baseUniform + bestBonus;
    pool.bestSrc = src;

    // Store per-platform totals reconstructed on uniform base for tooltip transparency
    pool._curveTotalUniform = baseUniform + curveBonus;
    pool._cvxTotalUniform = cvx ? (baseUniform + cvxBonus) : null;
    pool._sdTotalUniform = sd ? (baseUniform + sdBonus) : null;

    // Note: Convex/SD return inflated crvApy when working_supply=0 (e.g. 497% on
    // factory-stable-ng-704/705) — by-design Convex "Projected vAPR" semantic:
    // rate-if-someone-stakes-first. Real on-chain emission дилютится корректно
    // через gaugeDilutedApy при вводе amount (gaugeTvlUsd ≥ 1 ε в loadGaugesData).
  }
}

function _buildExtTooltip(p) {
  const parts = [];
  const ce = _curveExtraSum(p);
  if (ce > 0) parts.push(`Curve extras ${fmtPct(ce)}`);
  if (p.cvxApr) {
    const cvxNon = _safe(p.cvxApr.cvx) + _safe(p.cvxApr.extra);
    if (cvxNon > 0) parts.push(`Convex (CVX+extra) ${fmtPct(cvxNon)}`);
  }
  if (p.sdApr) {
    const sdNon = _safe(p.sdApr.extras);
    if (sdNon > 0) parts.push(`StakeDAO extras ${fmtPct(sdNon)}`);
  }
  return parts.length ? parts.join(' | ') : 'No external rewards';
}

function _buildTotalApyTooltip(p) {
  // Uniform base architecture: base = pool.weeklyApy (Curve 7d), bonus per platform.
  // Tooltip shows base + each platform's bonus + which platform won.
  const parts = [];
  const base = _safe(p.weeklyApy);
  parts.push(`Base ${fmtPct(base)} (Curve 7d)`);
  if (p._curveTotalUniform != null) {
    const cb = p._curveTotalUniform - base;
    if (cb > 0) parts.push(`Curve bonus ${fmtPct(cb)}`);
  }
  if (p.cvxApr) {
    const cvxB = _safe(p.cvxApr.crv) + _safe(p.cvxApr.cvx) + _safe(p.cvxApr.extra);
    parts.push(`Cx bonus ${fmtPct(cvxB)}`);
  }
  if (p.sdApr) {
    parts.push(`Sd bonus ${fmtPct(_safe(p.sdApr.bonus))}`);
  }
  const srcName = p.bestSrc === 'Cx' ? 'Convex' : (p.bestSrc === 'Sd' ? 'StakeDAO' : 'Curve');
  parts.push(`Best: ${srcName}`);
  // The breakdown above is at the LIVE CRV price; flag the active what-if so
  // the tooltip doesn't silently disagree with the rescaled Total cell.
  const _r = (typeof crvPriceRatio === 'function') ? crvPriceRatio() : 1;
  if (_r !== 1 && crvPriceUser > 0) {
    parts.push(`What-if CRV $${crvPriceUser.toFixed(2)} (×${_r.toFixed(2)} to CRV parts; breakdown shown at live price)`);
  }
  return parts.join(' | ').replace(/"/g, '&quot;');
}

// Kick off Convex/StakeDAO fetches early (parallel to Curve API), apply merge when ready.
// Failures are tolerable (single-platform absence → skipped from max comparison).
function loadPlatformAprsBackground() {
  if (typeof fetchConvexYields !== 'function' || typeof fetchStakeDaoYields !== 'function') return;
  Promise.allSettled([fetchConvexYields(), fetchStakeDaoYields()])
    .then(() => {
      try {
        mergePlatformAprs();
        if (typeof renderPoolList === 'function') renderPoolList();
      } catch (e) { console.warn('mergePlatformAprs failed:', e); }
    });
}

async function loadGaugesData() {
  try {
    // __gaugesPromise resolves to null when cache hit (we skipped prefetch). Fall through to fresh fetch.
    let json = window.__gaugesPromise ? await window.__gaugesPromise : null;
    window.__gaugesPromise = null;
    if (!json) json = await fetchJSON(`${apiBaseFor(getChainKey())}/getAllGauges`);
    gaugesData = json?.data || json || {};
    const gaugeByPool = new Map();
    for (const [, gauge] of Object.entries(gaugesData)) {
      // Curve API getAllGauges uses `swap` for pool address; some entries also
      // expose `poolAddress` after later enrichment. Cover both so the map
      // captures every pool — otherwise downstream lookups (gauge APR, extra
      // rewards, is_killed flag) silently miss most gauges.
      const poolAddr = (gauge.poolAddress || gauge.swap || '').toLowerCase();
      if (poolAddr) gaugeByPool.set(poolAddr, gauge);
    }
    for (const pool of allPools) {
      const gauge = gaugeByPool.get(pool.address.toLowerCase());
      if (gauge) {
        if (gauge.gaugeCrvApy && Array.isArray(gauge.gaugeCrvApy) && gauge.gaugeCrvApy.length >= 2 && gauge.gaugeCrvApy[0] != null) {
          const currentAvg = Array.isArray(pool.gaugeCrvApy) ? (pool.gaugeCrvApy[0] + pool.gaugeCrvApy[1]) / 2 : 0;
          if (currentAvg === 0 && gauge.gaugeCrvApy[0] > 0) pool.gaugeCrvApy = gauge.gaugeCrvApy;
        }
        if (gauge.extraRewards && gauge.extraRewards.length > 0) pool.extraRewards = gauge.extraRewards;
        if (!pool.gaugeAddress && gauge.gauge) pool.gaugeAddress = gauge.gauge;
        // gauge_data.working_supply is boost-adjusted LP staked in gauge (×1e18, BigInt-as-string).
        // gauge_tvl_usd = working_supply_LP × pool.tvl/totalSupply_LP (per-LP USD price). Used for
        // CRV APR dilution because emission is split among gauge stakers, not pool LPs. Tiny gauges
        // (msUSD/fxUSD: working ≈ 44 LP vs pool.totalSupply 679K LP) suffer huge dilution that
        // pool.tvl-based math misses entirely.
        const ws = gauge.gauge_data?.working_supply;
        const ts = pool.totalSupply;
        if (ws && ts && pool.tvl > 0) {
          try {
            const wsLp = Number(ws) / 1e18;
            const tsLp = Number(ts) / 1e18;
            if (tsLp > 0 && isFinite(wsLp) && isFinite(tsLp)) {
              pool.gaugeTvlUsd = pool.tvl * wsLp / tsLp;
            }
          } catch (e) { /* swallow BigInt/parse */ }
        }
        // First-staker projection (Александр crvecodev 2026-05-07 USG/USDC, USG/frxUSD): когда
        // gauge_relative_weight>0 но working_supply=0 (никто не застейкан), gauge_tvl=0 →
        // gaugeDilutedApy skip-ала бы дилюцию и показывала Convex's inflated baseline (497%).
        // Вместо strip-а CRV (теряет real emission ~$12-22/yr) ставим ε=$1 — это reproduces
        // Convex "Projected vAPR" assumption (rate-if-someone-stakes-first-with-$1) и при
        // user deposit $10K дилюцируется до ~497% × $1/($1+$10K) ≈ 0.05% (правильный projected APR).
        // API структура: weight живёт ВНУТРИ gauge.gauge_controller, не на верхнем уровне.
        const gaugeRelW = gauge.gauge_controller?.gauge_relative_weight ?? gauge.gauge_relative_weight;
        const wt = Number(gaugeRelW);
        if ((!pool.gaugeTvlUsd || pool.gaugeTvlUsd <= 0) && isFinite(wt) && wt > 0) {
          pool.gaugeTvlUsd = 1;
        }
        // Curve API authoritative deprecated flag (Алекс crvecodev/500 2026-05-02 +
        // /497 gov proposals idea). `is_killed=true` means Curve DAO voted to stop
        // CRV emission to this gauge — typically because the underlying protocol
        // is dead (Iron Bank, exploited projects). On curve.finance UI this drives
        // the yellow "DEPRECATED" banner + Deposit-disabled state. Surfacing it as
        // pool.gaugeIsKilled lets renderPoolList add a ⚠️ visual warning so users
        // don't deposit into a dead pool.
        pool.gaugeIsKilled = gauge.is_killed === true;
        // gauge_relative_weight: 0/null when no votes (factory pool with gauge but no vote-power).
        // Used by mergePlatformAprs() to detect stale Convex/SD crvApy (baseline rate without
        // gauge_weight factor — Convex showed 497% on factory-stable-ng-704/705 with weight=null,
        // 0 working_supply, no votes; Александр crvecodev 2026-05-07).
        pool.gaugeRelativeWeight = gaugeRelW;
      }
    }
    // Re-apply Merkl after gauge addresses are known
    applyMerklToPools();
    // Compute totalApy for each pool: base + min CRV + extra rewards + merkl
    for (const pool of allPools) {
      const baseApy = pool.weeklyApy || 0;
      const gaugeCrvMin = (Array.isArray(pool.gaugeCrvApy) && pool.gaugeCrvApy[0] > 0) ? pool.gaugeCrvApy[0] : 0;
      let extraRewardsSum = 0;
      if (Array.isArray(pool.extraRewards)) {
        for (const r of pool.extraRewards) {
          const v = parseFloat(r.apy);
          if (isFinite(v) && v > 0) extraRewardsSum += v;
        }
      }
      pool.totalApy = baseApy + gaugeCrvMin + extraRewardsSum + pool.merklApr;
    }
    // After Curve totals are computed, refresh ext/best across platforms (caches may be ready)
    try { mergePlatformAprs(); } catch (e) { /* yield.js may not be loaded yet */ }
    renderPoolList();
    // Kick off gauge-weight enrichment (current+prev). Re-render list & yield header once ready.
    // Use rebuild() because earlier callers (yield.js _updateGaugeWeightKpi) may have triggered
    // ensure() before gaugesData was populated, latching an empty map.
    if (window.GaugeWeights) {
      const _gw = window.GaugeWeights.rebuild ? window.GaugeWeights.rebuild() : window.GaugeWeights.ensure();
      _gw.then(() => {
        try { renderPoolList(); } catch (e) {}
        try {
          if (typeof selectedPool !== 'undefined' && selectedPool && currentView === 'yield' && typeof _updateGaugeWeightKpi === 'function') {
            _updateGaugeWeightKpi(selectedPool);
          }
        } catch (e) {}
      });
    }
  } catch (e) { console.error('Gauges data error:', e); }
}

// ============================================================
// EVENT HANDLERS
// ============================================================

// Swap slippage
document.querySelectorAll('.swap-slip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.swap-slip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    slippage = parseFloat(btn.dataset.slip);
    document.getElementById('slippageCustom').value = '';
    getQuote();
  });
});
document.getElementById('slippageCustom').addEventListener('input', function() {
  const val = parseFloat(this.value);
  if (!isNaN(val) && val > 0 && val < 50) {
    slippage = val;
    document.querySelectorAll('.swap-slip').forEach(b => b.classList.remove('active'));
    getQuote();
  }
});

// Deposit slippage
document.querySelectorAll('.dep-slip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.dep-slip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    depositSlippage = parseFloat(btn.dataset.slip);
  });
});

// Withdraw slippage
document.querySelectorAll('.wd-slip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.wd-slip').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    withdrawSlippage = parseFloat(btn.dataset.slip);
  });
});

// Search
let searchDebounce = null;
document.getElementById('poolSearch').addEventListener('input', function() {
  clearTimeout(searchDebounce);
  const val = this.value.trim();
  if (currentView === 'trade') {
    searchDebounce = setTimeout(() => { tradePairSearchQuery = val; renderTokenPairList(); }, 150);
  } else {
    searchDebounce = setTimeout(() => { searchQuery = val; renderPoolList(); }, 150);
  }
});

// Deposit simulator
document.getElementById('simDepositInput').addEventListener('input', function() {
  clearTimeout(simDepositTimer);
  simDepositTimer = setTimeout(() => {
    const val = parseFloat(this.value);
    simDepositAmount = (isNaN(val) || val < 0) ? 0 : val;
    renderPoolList();
    if (selectedPool && currentView === 'yield') updateYieldHeader();
  }, 300);
});

// CRV price what-if input (next to the deposit simulator)
document.getElementById('crvPriceInput')?.addEventListener('input', function() {
  clearTimeout(crvPriceTimer);
  crvPriceTimer = setTimeout(() => {
    const v = parseFloat(this.value);
    crvPriceUser = (isNaN(v) || v <= 0) ? null : v;
    renderPoolList();
    if (selectedPool && currentView === 'yield') updateYieldHeader();
  }, 300);
});
// "live $X" hint = reset: put the live price back into the input (msg 1019)
document.getElementById('crvPriceHint')?.addEventListener('click', () => {
  if (!(crvPriceLive > 0)) return;
  const el = document.getElementById('crvPriceInput');
  if (el) el.value = crvPriceLive.toFixed(2);
  clearTimeout(crvPriceTimer);
  crvPriceUser = null;
  renderPoolList();
  if (selectedPool && currentView === 'yield') updateYieldHeader();
});
initCrvPriceInput();

// Filters — registry chips are now independent toggles (Alexandr msg 539).
// Empty Set = show all. Click toggles registry in Set, no chip resets others.
document.querySelectorAll('.filter-btn').forEach(btn => {
  // Skip orthogonal toggle pills — they have their own click handlers below
  // and don't carry data-registry semantics.
  if (btn.id === 'myAssetsToggle' || btn.id === 'favoritesToggle' ||
      btn.id === 'gainersToggle' || btn.id === 'losersToggle' ||
      btn.id === 'highVolumeToggle' || btn.id === 'disbalanceToggle' ||
      btn.id === 'stablecoinsToggle' || btn.id === 'minGradeBToggle' ||
      btn.id === 'assetEthToggle' || btn.id === 'assetBtcToggle' || btn.id === 'assetCrvusdToggle') return;
  btn.addEventListener('click', () => {
    const reg = btn.dataset.registry;
    if (!reg) return;
    if (filterRegistries.has(reg)) filterRegistries.delete(reg);
    else filterRegistries.add(reg);
    btn.classList.toggle('active', filterRegistries.has(reg));
    renderPoolList();
  });
});

// "★ Mine" pill — mutex with ★ Fav per Alexandr msg 544 ("эти 2 все равно вместе
// включаются"). Two ★ pills are conceptually conflicting (own positions vs starred
// catalog), so activating one turns the other OFF. Both can still be turned OFF.
// Other chips (registry types, Gainers/Losers, High Vol/Disbalance) remain
// independent toggles.
const myAssetsToggleEl = document.getElementById('myAssetsToggle');
if (myAssetsToggleEl) {
  myAssetsToggleEl.addEventListener('click', () => {
    myAssetsOnly = !myAssetsOnly;
    myAssetsToggleEl.classList.toggle('active', myAssetsOnly);
    if (myAssetsOnly && favoritesOnly) {
      favoritesOnly = false;
      const favEl = document.getElementById('favoritesToggle');
      if (favEl) favEl.classList.toggle('active', false);
    }
    if (myAssetsOnly && walletAddress && window.Portfolio && typeof window.Portfolio._preloadPositions === 'function') {
      window.Portfolio._preloadPositions();
    }
    renderPoolList();
  });
}

// "★ Fav" pill — mutex with ★ Mine (see comment above).
const favoritesToggleEl = document.getElementById('favoritesToggle');
if (favoritesToggleEl) {
  favoritesToggleEl.addEventListener('click', () => {
    favoritesOnly = !favoritesOnly;
    favoritesToggleEl.classList.toggle('active', favoritesOnly);
    if (favoritesOnly && myAssetsOnly) {
      myAssetsOnly = false;
      const mineEl = document.getElementById('myAssetsToggle');
      if (mineEl) mineEl.classList.toggle('active', false);
    }
    renderPoolList();
  });
}

// "↑ Gainers" / "↓ Losers" pills — yield-only filters by weekly ΔW direction.
// Independently toggleable; both ON = union (any movement). State persisted.
const gainersToggleEl = document.getElementById('gainersToggle');
const losersToggleEl  = document.getElementById('losersToggle');
function _persistGL() {
  try {
    localStorage.setItem('cd_gainersOnly', window.gainersOnly ? '1' : '0');
    localStorage.setItem('cd_losersOnly',  window.losersOnly  ? '1' : '0');
  } catch (e) {}
}
// Gainers/Losers — independent toggles. Generic .filter-btn handler skips
// these IDs so their click is handled here only.
if (gainersToggleEl) {
  gainersToggleEl.classList.toggle('active', window.gainersOnly);
  gainersToggleEl.addEventListener('click', () => {
    window.gainersOnly = !window.gainersOnly;
    gainersToggleEl.classList.toggle('active', window.gainersOnly);
    _persistGL();
    renderPoolList();
  });
}
if (losersToggleEl) {
  losersToggleEl.classList.toggle('active', window.losersOnly);
  losersToggleEl.addEventListener('click', () => {
    window.losersOnly = !window.losersOnly;
    losersToggleEl.classList.toggle('active', window.losersOnly);
    _persistGL();
    renderPoolList();
  });
}

// "⚡ High Vol" pill (Alexandr msg 535) — pools with 24h volume / TVL ≥ 1.0
// (utilization ≥ 100%). Independent toggle.
const highVolumeToggleEl = document.getElementById('highVolumeToggle');
if (highVolumeToggleEl) {
  highVolumeToggleEl.addEventListener('click', () => {
    highVolumeOnly = !highVolumeOnly;
    highVolumeToggleEl.classList.toggle('active', highVolumeOnly);
    renderPoolList();
  });
}

// "⚖ Disbalance" pill (Alexandr msg 535) — pools where any token's USD share
// of total reserves drops below (1/N) * 0.5 (i.e. ≥50% off equal split).
const disbalanceToggleEl = document.getElementById('disbalanceToggle');
if (disbalanceToggleEl) {
  disbalanceToggleEl.addEventListener('click', () => {
    disbalanceOnly = !disbalanceOnly;
    disbalanceToggleEl.classList.toggle('active', disbalanceOnly);
    renderPoolList();
  });
}

// Asset-class chips (Alexandr crvecodev/1067-1085) — ETH / BTC / crvUSD.
// Independent toggles, symbol-classified, AND-combine. Replace registry chips.
const assetEthToggleEl = document.getElementById('assetEthToggle');
if (assetEthToggleEl) {
  assetEthToggleEl.addEventListener('click', () => {
    assetEth = !assetEth;
    assetEthToggleEl.classList.toggle('active', assetEth);
    renderPoolList();
  });
}
const assetBtcToggleEl = document.getElementById('assetBtcToggle');
if (assetBtcToggleEl) {
  assetBtcToggleEl.addEventListener('click', () => {
    assetBtc = !assetBtc;
    assetBtcToggleEl.classList.toggle('active', assetBtc);
    renderPoolList();
  });
}
const assetCrvusdToggleEl = document.getElementById('assetCrvusdToggle');
if (assetCrvusdToggleEl) {
  assetCrvusdToggleEl.addEventListener('click', () => {
    assetCrvusd = !assetCrvusd;
    assetCrvusdToggleEl.classList.toggle('active', assetCrvusd);
    renderPoolList();
  });
}

// List-settings popover (Alexandr crvecodev/1062-1085) — tune icon opens a menu
// holding the relocated deposit/CRV/Show-hidden toolbar, WT/ΔW column toggles and
// the min-TVL segment. Built once on load.
(function initListSettings() {
  const btn = document.getElementById('listSettingsBtn');
  const menu = document.getElementById('listSettingsMenu');
  const wrap = document.getElementById('listSettingsWrap');
  if (!btn || !menu || !wrap) return;

  // Relocate the existing #depositSimulator node into the menu — keeps its IDs and
  // already-bound listeners intact (Simulate deposit / CRV price / Show hidden).
  const sim = document.getElementById('depositSimulator');
  if (sim) menu.appendChild(sim);

  // Relocate the whole settings wrap (button + menu) to the END of the search row,
  // sized to match the search input height (Alexandr crvecodev/1093+). Frees the
  // row above the sort header that previously held it.
  const searchRow = document.querySelector('.sidebar-search');
  if (searchRow) searchRow.appendChild(wrap);

  function setOpen(open) {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });

  // Min-TVL segment — single-select preset; click the active one again to reset.
  const seg = document.getElementById('minTvlSegment');
  if (seg) {
    const paint = () => seg.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.tvl, 10) === minTvlThreshold);
    });
    paint();
    seg.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => {
        const v = parseInt(b.dataset.tvl, 10) || 0;
        minTvlThreshold = (minTvlThreshold === v) ? 0 : v;
        try { localStorage.setItem('cd_minTvl', String(minTvlThreshold)); } catch (e) {}
        paint();
        renderPoolList();
      });
    });
  }

  // Column toggles — hide WT / ΔW via a class on #sidebar (CSS hides header + cells
  // together so the flexbox pool table stays aligned). Default = shown.
  const sidebar = document.getElementById('sidebar');
  function applyCol(key, cls, show) {
    if (sidebar) sidebar.classList.toggle(cls, !show);
    try { localStorage.setItem(key, show ? '1' : '0'); } catch (e) {}
  }
  const wtChk = document.getElementById('colToggleWt');
  const dwChk = document.getElementById('colToggleDw');
  const wtShow = (() => { try { return localStorage.getItem('cd_colWt') !== '0'; } catch (e) { return true; } })();
  const dwShow = (() => { try { return localStorage.getItem('cd_colDw') !== '0'; } catch (e) { return true; } })();
  if (wtChk) { wtChk.checked = wtShow; applyCol('cd_colWt', 'cdx-hide-wt', wtShow);
    wtChk.addEventListener('change', () => applyCol('cd_colWt', 'cdx-hide-wt', wtChk.checked)); }
  if (dwChk) { dwChk.checked = dwShow; applyCol('cd_colDw', 'cdx-hide-dw', dwShow);
    dwChk.addEventListener('change', () => applyCol('cd_colDw', 'cdx-hide-dw', dwChk.checked)); }
})();

// "🛡 Stablecoins" pill — show only pools where every coin is in the ratings
// aggregator (Pharos catalog of pegged assets). Index is filled by info_tab.js.
const stablecoinsToggleEl = document.getElementById('stablecoinsToggle');
if (stablecoinsToggleEl) {
  stablecoinsToggleEl.addEventListener('click', () => {
    window.stablecoinsOnly = !window.stablecoinsOnly;
    stablecoinsToggleEl.classList.toggle('active', window.stablecoinsOnly);
    renderPoolList();
  });
}

// "🅰 Grade ≥ B" pill — strict subset: every coin's Pharos grade is B- or better.
const minGradeBToggleEl = document.getElementById('minGradeBToggle');
if (minGradeBToggleEl) {
  minGradeBToggleEl.addEventListener('click', () => {
    window.minGradeBOnly = !window.minGradeBOnly;
    minGradeBToggleEl.classList.toggle('active', window.minGradeBOnly);
    renderPoolList();
  });
}

// "Show hidden" checkbox — toggle to reveal deprecated (gauge killed) and dust
// (TVL < $10K) pools. Default OFF per Alexandr msg 511/518 (checkbox, not chip).
// State persisted in localStorage key `curvedex.showHidden`.
const chipShowHiddenEl = document.getElementById('chipShowHidden');
if (chipShowHiddenEl) {
  chipShowHiddenEl.checked = !!window.showHidden;
  chipShowHiddenEl.addEventListener('change', () => {
    window.showHidden = chipShowHiddenEl.checked;
    try { localStorage.setItem('curvedex.showHidden', window.showHidden ? '1' : '0'); } catch (e) {}
    renderPoolList();
  });
}

// Sort
document.querySelectorAll('.sort-col').forEach(col => {
  col.addEventListener('click', () => {
    const field = col.dataset.sort;
    if (sortField === field) { sortDir *= -1; }
    else { sortField = field; sortDir = field === 'name' ? 1 : -1; }
    document.querySelectorAll('.sort-col').forEach(c => {
      c.classList.toggle('active', c.dataset.sort === sortField);
      const arrow = c.querySelector('.sort-arrow');
      if (c.dataset.sort === sortField) arrow.innerHTML = `<svg class="icon icon--sm"><use href="#icon-chevron-${sortDir === -1 ? 'down' : 'up'}"/></svg>`;
      else arrow.textContent = '';
    });
    renderPoolList();
  });
});

// Time selector (trade)
document.querySelectorAll('.time-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentAgg = parseInt(btn.dataset.agg);
    currentUnit = btn.dataset.unit;
    if (selectedPool && currentView === 'pools') loadOHLC();
  });
});

// Chart tabs (yield)
document.querySelectorAll('.chart-tab').forEach(btn => {
  btn.addEventListener('click', () => switchChartMode(btn.dataset.chart));
});

// From amount -> quote
document.getElementById('fromAmount').addEventListener('input', function() {
  clearTimeout(quoteDebounceTimer);
  quoteDebounceTimer = setTimeout(getQuote, 300);
  updateSwapButton();
});

function toggleMobileSidebar(forceClose) {
  // /trade: trade-token-sidebar; /pools, /yield: shared #sidebar (pool list);
  // /swap: no sidebar list — open token modal instead (Fix B).
  if (currentView === 'swap') {
    if (forceClose) return;
    if (typeof openSwapTokenModal === 'function') openSwapTokenModal('from');
    return;
  }
  const tradeSb = document.getElementById('tradeTokenSidebar');
  const sidebar = document.getElementById('sidebar');
  const targetSb = currentView === 'trade' ? tradeSb : sidebar;
  const otherSb = currentView === 'trade' ? sidebar : tradeSb;
  const toggle = document.getElementById('mobilePoolToggle');
  const backdrop = document.getElementById('mobileSidebarBackdrop');
  // Always close the non-active sidebar to avoid stuck overlay state on view switch
  if (otherSb) otherSb.classList.remove('mobile-open');
  if (!targetSb) return;
  if (forceClose || targetSb.classList.contains('mobile-open')) {
    targetSb.classList.remove('mobile-open');
    toggle.classList.remove('active');
    backdrop.classList.remove('show');
    toggle.textContent = '☰';
  } else {
    targetSb.classList.add('mobile-open');
    toggle.classList.add('active');
    backdrop.classList.add('show');
    toggle.textContent = '✕';
  }
}

// Fix A: pair-name picker helper — opens correct picker per view.
// /trade desktop+mobile → opens token modal (base pick).
// /pools, /yield → on desktop focuses sidebar pool-search; on mobile opens sidebar.
// /swap → opens swap token modal (from).
function openPairPicker(slot) {
  // slot: 'from' (default) or 'to' — selects which side of the pair the modal updates.
  const target = (slot === 'to') ? 'to' : 'from';
  const isMobile = window.innerWidth <= 1024;
  if (currentView === 'trade') {
    if (typeof openTradeTokenModal === 'function') openTradeTokenModal(target);
    return;
  }
  if (currentView === 'swap') {
    if (typeof openSwapTokenModal === 'function') openSwapTokenModal(target);
    return;
  }
  // /pools or /yield: single pool-list picker (no per-slot filtering yet).
  if (isMobile) {
    toggleMobileSidebar();
  }
  const search = document.getElementById('poolSearch');
  if (search) {
    try { search.focus(); search.select(); } catch (e) {}
  }
}
window.openPairPicker = openPairPicker;

// Click on a token ticker in the right pool/pair header populates the sidebar
// search input with that ticker and triggers the filter (per tester
// @Alexandr_Petryashev msg 245). On /yield and /pools that filters the pool
// list; on /trade it filters the token sidebar.
function pickTokenSearch(symbol) {
  if (!symbol) return;
  const sym = String(symbol).trim();
  const isMobile = window.innerWidth <= 1024;
  if (isMobile) {
    // On mobile the sidebar is collapsed by default — open it so the user
    // sees the filtered result without an extra tap.
    if (typeof toggleMobileSidebar === 'function') toggleMobileSidebar();
  }
  if (currentView === 'trade' || currentView === 'swap') {
    const tInput = document.getElementById('tradeTokenSearch');
    if (tInput) {
      tInput.value = sym;
      tInput.dispatchEvent(new Event('input', { bubbles: true }));
      try { tInput.focus(); } catch (e) {}
    }
    return;
  }
  // /pools or /yield: poolSearch drives the pool list filter.
  const pInput = document.getElementById('poolSearch');
  if (pInput) {
    pInput.value = sym;
    pInput.dispatchEvent(new Event('input', { bubbles: true }));
    try { pInput.focus(); } catch (e) {}
  }
}
window.pickTokenSearch = pickTokenSearch;

document.getElementById('mobilePoolToggle').addEventListener('click', () => toggleMobileSidebar());
document.getElementById('mobileSidebarBackdrop').addEventListener('click', () => toggleMobileSidebar(true));

// Hash change listener for back/forward
window.addEventListener('hashchange', handleRoute);


// ============================================================
// INIT
// ============================================================
async function init() {
  // Load multi-chain config (non-blocking failure tolerated; defaults to Ethereum).
  await loadChainsConfig();

  // Try server-side cache first
  const cacheData = window.__cachePromise ? await window.__cachePromise : null;
  window.__cachePromise = null;

  if (cacheData && cacheData.pools && cacheData.pools.length > 0) {
    console.log(`Loaded from cache: ${cacheData.pools.length} pools, updated ${new Date(cacheData.updated * 1000).toISOString()}`);
    await loadFromCache(cacheData);

    // Kick off Convex + StakeDAO fetches in background — used for cross-platform max in /yield listing.
    // Non-blocking: re-renders listing once data lands. Tolerant of single-platform failures.
    loadPlatformAprsBackground();

    // Ensure initial view is fully set up (route + tokens)
    handleRoute();

    // If still on trade view, populate token dropdowns and generate pairs
    if (currentView === 'trade' && allPools.length > 0) {
      populateTradeTokens();
      generateTokenPairs();
      renderTokenPairList();
      // Auto-select first pair if none selected
      if (!selectedPair && tokenPairs.length > 0) {
        selectTokenPair(tokenPairs[0].name);
      }
    }

    // Load registry details in background for composition view (non-blocking)
    loadPhase2().catch(e => console.error('Phase 2 background error:', e));

    // Cache only gives us pool-level gaugeAddress but no gauge_controller weights.
    // Fetch /getAllGauges so gauge_weights.js can build the rank/weight map.
    // merkl + gauges are independent — run in parallel (was sequential .then chain).
    Promise.all([loadMerklRewards(), loadGaugesData()]).catch(e => console.error('Gauges background error:', e));
  } else {
    // Fallback: direct API loading (original flow)
    console.log('Cache unavailable, using direct API');
    await loadPhase1();

    // Same: kick off cross-platform APR fetches early (yield listing depends on them)
    loadPlatformAprsBackground();

    const phase2Done = loadPhase2();
    phase2Done.then(() => {
      renderPoolList();
      handleRoute();
      if (currentView === 'trade' && allPools.length > 0) {
        populateTradeTokens();
        generateTokenPairs();
        renderTokenPairList();
        if (!selectedPair && tokenPairs.length > 0) selectTokenPair(tokenPairs[0].name);
      }
      // Load gauges and Merkl rewards in parallel
      loadMerklRewards().then(() => loadGaugesData());
    }).catch(e => console.error('Phase 2 error:', e));
    return; // startRefresh will be called after init resolves
  }
}

function autoSelectPool() {
  const hash = window.location.hash;
  if (hash && hash !== '#/' && hash !== '#') {
    handleRoute();
  } else if (!selectedPool && allPools.length > 0 && currentView !== 'trade') {
    let best = null;
    for (const addr of PREFERRED_POOLS) {
      const pool = poolsByAddress.get(addr);
      if (pool && pool._hasDetail && pool.coins.length >= 2) { best = pool; break; }
    }
    if (!best) {
      const mainCryptoPools = allPools.filter(p =>
        p._hasDetail && p.coins.length >= 2 && p.tvl > 500000 &&
        (p.registryId === 'main' || p.registryId === 'crypto')
      );
      if (mainCryptoPools.length > 0) { mainCryptoPools.sort((a, b) => b.tvl - a.tvl); best = mainCryptoPools[0]; }
    }
    if (!best) {
      const sorted = [...allPools].sort((a, b) => b.tvl - a.tvl);
      best = sorted.find(p => p._hasDetail && p.coins.length >= 2);
    }
    if (best) selectPool(best.address);
  }
}

// ============================================================
// AUTO-REFRESH
// ============================================================
function startRefresh() {
  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (selectedPool && currentView === 'pools') loadTrades();
  }, 10000);

  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (selectedPool && currentView === 'pools') loadOHLC();
  }, 30000);

  setInterval(async () => {
    if (document.visibilityState !== 'visible') return;
    if (cacheMode) {
      // Refresh from server-side cache.  Prefixed with __DYNAMIC_BASE so the
      // IPFS-served bundle keeps polling the daily-refreshed cache on the
      // classical host.  Empty base = same-origin (current behaviour).
      try {
        const resp = await fetch((window.__DYNAMIC_BASE || '') + '/curvedex/cache.json?t=' + Date.now());
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.pools) await loadFromCache(data);
        }
      } catch (e) { console.warn('Cache refresh error:', e); }
    } else {
      await loadPhase1();
    }
    renderPoolList();
    if (selectedPool && currentView === 'yield') {
      const pool = poolsByAddress.get(selectedPool.address.toLowerCase());
      if (pool) {
        selectedPool = pool;
        document.getElementById('kpiDailyApy').textContent = fmtPct(pool.dailyApy);
        document.getElementById('kpiWeeklyApy').textContent = fmtPct(pool.weeklyApy);
        const rawApy = (pool.bestTotalApy != null && pool.bestTotalApy > 0) ? pool.bestTotalApy : (pool.totalApy || 0);
        const adjApy = simDepositAmount > 0 ? dilutedTotalApy(pool, simDepositAmount) : rawApy;
        const kpiTotalEl = document.getElementById('kpiTotalApy');
        if (typeof _buildTotalApyTooltip === 'function') kpiTotalEl.title = _buildTotalApyTooltip(pool);
        if (simDepositAmount > 0 && rawApy > 0) {
          kpiTotalEl.innerHTML = `${fmtPct(adjApy)} <span style="font-size:11px;color:var(--text-dim)">(${fmtPct(rawApy)})</span>`;
        } else {
          kpiTotalEl.textContent = rawApy > 0 ? fmtPct(rawApy) : '--';
        }
        document.getElementById('kpiTvl').textContent = fmt$(pool.tvl);
        const merklWrap = document.getElementById('kpiMerklWrap');
        const merklEl = document.getElementById('kpiMerklApy');
        if (pool.merklApr > 0) {
          merklEl.textContent = '+' + fmtPct(pool.merklApr);
          merklWrap.style.display = '';
        } else {
          merklWrap.style.display = 'none';
        }
      }
    }
  }, 60000);

  setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (walletAddress && selectedPool) {
      if (currentView === 'yield') loadAllYieldBalances();
    }
  }, 30000);

  // Refresh Merkl rewards every 5 minutes (only in direct API mode, cache already has it)
  if (!cacheMode) {
    setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadMerklRewards().then(() => {
        for (const pool of allPools) {
          const baseApy = pool.weeklyApy || 0;
          const gaugeCrvMin = (Array.isArray(pool.gaugeCrvApy) && pool.gaugeCrvApy[0] > 0) ? pool.gaugeCrvApy[0] : 0;
          let extraRewardsSum = 0;
          if (Array.isArray(pool.extraRewards)) {
            for (const r of pool.extraRewards) {
              const v = parseFloat(r.apy);
              if (isFinite(v) && v > 0) extraRewardsSum += v;
            }
          }
          pool.totalApy = baseApy + gaugeCrvMin + extraRewardsSum + pool.merklApr;
        }
        try { mergePlatformAprs(); } catch (e) { /* tolerate */ }
        renderPoolList();
      });
    }, MERKL_REFRESH_MS);
  }
}

// Progressive 24h price change loading for top pools
async function loadPriceChanges() {
  // Load price changes for ALL pools with coin addresses, sorted by TVL
  const topPools = [...allPools]
    .filter(p => p.coinsAddresses && p.coinsAddresses.length >= 2 && p.tvl > 1000)
    .sort((a, b) => b.tvl - a.tvl);

  // Load in batches of 10 (parallel) for speed
  let poolsSinceRender = 0;
  for (let i = 0; i < topPools.length; i += 10) {
    const batch = topPools.slice(i, i + 10);
    await Promise.all(batch.map(async pool => {
      try {
        const mt = pool.coinsAddresses[0], rt = pool.coinsAddresses[1];
        const url = `${PRICES_BASE}/ohlc/${getChainKey()}/${pool.address}?main_token=${mt}&reference_token=${rt}&agg_number=1&agg_units=day&start=${Math.floor(Date.now()/1000) - 2*86400}&end=${Math.floor(Date.now()/1000)}`;
        const resp = await fetch(url);
        if (!resp.ok) return;
        const json = await resp.json();
        const candles = json.data || [];
        if (candles.length >= 2) {
          const prev = candles[candles.length - 2];
          const last = candles[candles.length - 1];
          pool._priceChange24h = ((last.close - prev.open) / prev.open * 100);
        } else if (candles.length === 1) {
          pool._priceChange24h = ((candles[0].close - candles[0].open) / candles[0].open * 100);
        }
      } catch (e) { /* skip */ }
    }));
    poolsSinceRender += batch.length;
    // Re-render every 50 pools instead of every 10 — reduces DOM thrash 5x
    if (poolsSinceRender >= 50 || i + 10 >= topPools.length) {
      renderPoolList();
      if (typeof buildTradeTokenData === 'function') {
        buildTradeTokenData();
        renderTradeTokenSidebar();
      }
      poolsSinceRender = 0;
    }
  }
}

// init() is called from index.html after all scripts are loaded


// ============================================================
// EIP-1559 gas pricing strategy (Михаил Егоров / Curve founder)
// ------------------------------------------------------------
// Formula (from msg 6920/6922, chat 279159946, 2026-05-21):
//   base               = provider.getBlock('latest').baseFeePerGas
//   maxPriorityFeePerGas = 0.05 × base
//   maxFeePerGas         = 2 × base + tip   (≈ 2.05 × base)
// Always passes, never overpays. Single default — no presets/UI selector.
// Fallback to legacy gasPrice (provider.getFeeData()) on pre-1559 chains
// where getBlock returns no baseFeePerGas (some sidechains / older L2s).
// ============================================================
async function computeMichwillGasParams(provider) {
  try {
    const blk = await provider.getBlock('latest');
    const base = blk && blk.baseFeePerGas;
    if (base && base > 0n) {
      const tip = (base * 5n) / 100n;           // 5% of base
      const maxFee = base * 2n + tip;           // 2× base + tip
      return { maxFeePerGas: maxFee, maxPriorityFeePerGas: tip };
    }
  } catch (e) {
    // Block lookup failed — fall through to legacy fee data.
  }
  // Pre-1559 chain (no baseFeePerGas) — use legacy gasPrice.
  try {
    const fd = await provider.getFeeData();
    if (fd.gasPrice && fd.gasPrice > 0n) return { gasPrice: fd.gasPrice };
  } catch (e) { /* let wallet pick its own default */ }
  return {}; // empty override — wallet uses its own defaults
}
window.computeMichwillGasParams = computeMichwillGasParams;

// ============================================================
// DYNAMIC GAS LIMIT (Михаил hard rule, msg 7092 chat 279159946 2026-05-24 22:47)
// ============================================================
// "Хардкодить газ ни для каких транзакций вообще нельзя в принципе. Нужно
// делать estimate, но передавать на транзакцию в 1.5 раза больше чем estimate"
//
// Strategy:
//   1) estimate = provider.estimateGas({...tx, from})
//   2) gasLimit = ceil(estimate × 1.5) using BigInt-safe `(g * 15n + 9n) / 10n`
//   3) If estimateGas throws (revert / OOG estimate / network) — propagate
//      the error UP. Calling code must show the revert reason to the user and
//      NOT send a blind tx. NO silent fallback.
//
// Applies to: wrap/unwrap, exchange, approve, zap, Router NG, composite envelopes.
// ============================================================
async function estimateGasWithBuffer(provider, tx, from) {
  if (!provider || typeof provider.estimateGas !== 'function') {
    throw new Error('estimateGasWithBuffer: provider missing or no .estimateGas');
  }
  // Build clean estimateGas params. ethers v6 accepts bigint/string/number for
  // value; estimateGas tolerates the same shape as sendTransaction.
  const estimateTx = { ...tx };
  if (from && !estimateTx.from) estimateTx.from = from;
  // Strip any fields that don't belong on estimateGas (gasLimit itself, gasPrice
  // overrides, internal metadata starting with underscore).
  delete estimateTx.gasLimit;
  delete estimateTx.gas;
  delete estimateTx.maxFeePerGas;
  delete estimateTx.maxPriorityFeePerGas;
  delete estimateTx.gasPrice;
  for (const k of Object.keys(estimateTx)) {
    if (k.startsWith('_')) delete estimateTx[k];
  }
  // Ethers v6 wants value as bigint or hex; if zero or missing, omit.
  if (estimateTx.value != null) {
    try { estimateTx.value = BigInt(estimateTx.value); } catch (_) { delete estimateTx.value; }
    if (estimateTx.value === 0n) delete estimateTx.value;
  }
  const estimate = await provider.estimateGas(estimateTx);
  const g = BigInt(estimate);
  // ceil(g * 1.5) = (g * 15 + 9) / 10
  return (g * 15n + 9n) / 10n;
}
window.estimateGasWithBuffer = estimateGasWithBuffer;

// Sugar wrapper for ethers Contract calls that already build calldata for us.
// Given an ethers.Contract method invocation we want to:
//   1) build calldata via populateTransaction
//   2) estimateGas × 1.5
//   3) attach Michwill EIP-1559 gas params if available
//   4) signer.sendTransaction
// Returns the TransactionResponse (call .wait() outside).
//
// Usage:
//   const lp = new ethers.Contract(addr, ERC20_ABI, signer);
//   const tx = await window.sendContractTxWithDynamicGas(lp, 'approve', [spender, amount], { value: 0n });
//   await tx.wait();
async function sendContractTxWithDynamicGas(contract, methodName, args, opts = {}) {
  if (!contract || !contract.interface) {
    throw new Error('sendContractTxWithDynamicGas: invalid contract');
  }
  const data = contract.interface.encodeFunctionData(methodName, args || []);
  const to = await contract.getAddress();
  const tx = { to, data };
  if (opts.value != null) tx.value = opts.value;
  const signer = contract.runner;
  if (!signer || typeof signer.sendTransaction !== 'function') {
    throw new Error('sendContractTxWithDynamicGas: contract has no signer');
  }
  const provider = signer.provider;
  const from = (typeof signer.getAddress === 'function') ? await signer.getAddress() : undefined;
  if (provider) {
    try {
      tx.gasLimit = await estimateGasWithBuffer(provider, tx, from);
    } catch (e) {
      // Don't silently swallow — let the caller handle (surface revert reason).
      throw e;
    }
  }
  // Apply Michwill EIP-1559 strategy if available.
  let gasOv = {};
  if (provider && typeof computeMichwillGasParams === 'function') {
    try { gasOv = await computeMichwillGasParams(provider); } catch (_) {}
  }
  return signer.sendTransaction({ ...tx, ...gasOv });
}
window.sendContractTxWithDynamicGas = sendContractTxWithDynamicGas;

// EIP-1559 fee preview via raw JSON-RPC (used by gas-preview UI that runs
// without a connected wallet). Returns an effective per-gas price suitable
// for "you won't pay more than $X" upper bound: maxFeePerGas (2× base + tip).
// Falls back to legacy eth_gasPrice on pre-1559 chains.
async function _michwillGasPricePreview() {
  try {
    if (typeof window._ethRpc !== 'function') return 0n;
    // eth_getBlockByNumber returns {baseFeePerGas: '0x...'} on EIP-1559 chains.
    const blk = await window._ethRpc('eth_getBlockByNumber', ['latest', false]);
    const baseHex = blk && blk.baseFeePerGas;
    if (baseHex) {
      const base = BigInt(baseHex);
      if (base > 0n) {
        const tip = (base * 5n) / 100n;
        return base * 2n + tip;
      }
    }
  } catch (e) { /* fall through */ }
  try {
    if (typeof window._ethRpc !== 'function') return 0n;
    const gp = await window._ethRpc('eth_gasPrice', []);
    return BigInt(gp || '0x0');
  } catch (e) { return 0n; }
}
window._michwillGasPricePreview = _michwillGasPricePreview;


// Global comma-to-dot normalizer for inputmode=decimal text inputs
// Locale-independent decimal entry: user types '0,05' or '0.05' — internally always '0.05'
document.addEventListener('input', (e) => {
  const t = e.target;
  if (t && t.tagName === 'INPUT' && t.getAttribute('inputmode') === 'decimal' && t.value.includes(',')) {
    const cursorPos = t.selectionStart;
    t.value = t.value.replace(',', '.');
    try { t.setSelectionRange(cursorPos, cursorPos); } catch (_) {}
  }
}, true);
