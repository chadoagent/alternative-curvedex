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
// Shared route-preview helper: pre-amount route lookup via the live router.
// Used by /trade (simple + pair views) and /swap to avoid the 3 duplicated
// `findBestPool`-based legacy code paths. Probes descending amounts 1000→100→1
// so transient quote failures fall through; catches every exception. Returns
// the first successful quote, or null if all attempts fail. Caller is
// responsible for DOM updates (label, viz) and any caching.
//
// Important: getQuote takes a HUMAN amount string and calls parseUnits()
// internally, so probe amounts are "1000"/"100"/"1", not wei.
// ============================================================
async function _getRoutePreview(router, fromAddr, toAddr, fromDec, toDec) {
  if (!router || !fromAddr || !toAddr) return null;
  if (!router._pools || router._pools.length === 0) return null;
  if (!Number.isFinite(fromDec)) fromDec = 18;
  if (!Number.isFinite(toDec)) toDec = 18;
  for (const probeAmt of ['1000', '100', '1']) {
    try {
      const q = await router.getQuote(fromAddr, toAddr, probeAmt, fromDec, toDec, 0.5, null);
      if (q && q.route && q.route.length >= 1) return q;
    } catch (e) {
      if (e && e.name === 'AbortError') return null;
      // try next amount
    }
  }
  return null;
}

// Build the route-viz `paths` array straight from a quote's own legs, so the
// drawn diagram matches the quote that actually executes — including hops whose
// "pool" is NOT a Curve pool in `allPools` (e.g. ERC-4626 vault redeem/deposit
// legs). The legacy preview mapped legs via `allPools.find(...).filter(Boolean)`
// which silently DROPPED such legs, distorting the path. This drives off the
// leg's own poolName (meaningful after the swap-type labelling) and resolves
// intermediate token symbols via the router (works for vault tokens too).
//
// Returns a single-element multiPaths array [{poolNames, midTokenSyms, pct, tvl}]
// for sequential routes, or null for parallel/split routes (caller keeps its own
// per-branch rendering) and for empty/invalid quotes.
function _buildRouteVizPaths(quote, router) {
  if (!quote || !Array.isArray(quote.route) || quote.route.length === 0) return null;
  const legs = quote.route;
  // Parallel/split routes carry per-branch `legs` arrays — not handled here.
  if (legs.some(l => l && Array.isArray(l.legs))) return null;

  const haveAllPools = (typeof allPools !== 'undefined') && Array.isArray(allPools);
  const findPool = (addr) => haveAllPools && addr
    ? allPools.find(p => (p.address || '').toLowerCase() === addr.toLowerCase())
    : null;

  const poolNames = legs.map(leg => {
    let name = leg.poolName || leg.name || leg.exchange;
    if (!name || name === '?') {
      const p = findPool(leg.pool);
      if (p && p.name) name = p.name;
    }
    return name || '?';
  });

  // Intermediate token between leg i and leg i+1. Prefer the quote's own
  // _midTokens, fall back to the leg boundary addresses (curve-js legs carry
  // from/to). Resolve the symbol via the router so vault shares resolve too.
  const mts = quote._midTokens || (quote._midToken ? [quote._midToken] : []);
  const midTokenSyms = [];
  for (let i = 0; i < legs.length - 1; i++) {
    const mt = mts[i];
    const midAddr = (mt && mt.address) || legs[i].to || (legs[i + 1] && legs[i + 1].from);
    let sym = '?';
    if (midAddr && router && typeof router._resolveTokenInfo === 'function') {
      const info = router._resolveTokenInfo(midAddr);
      if (info && info.symbol && info.symbol !== '???') sym = info.symbol;
    }
    midTokenSyms.push(sym);
  }

  // tvl floor across the legs that map to a real pool (synthetic/vault legs skipped).
  const tvls = [];
  for (const leg of legs) {
    const p = findPool(leg.pool);
    if (p && p.tvl) tvls.push(p.tvl);
  }

  return [{ poolNames, midTokenSyms, pct: 100, tvl: tvls.length ? Math.min(...tvls) : 0 }];
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

// ─── On-chain fee + rate-oracle pull (StableSwapNG family) ──────────────────
// The Curve getPools API exposes NO `fee` field and NO per-coin oracle address
// for stable-ng pools, and `pool.usesRateOracle` is a misleading POOL-LEVEL bool
// (FALSE even when a coin has an active oracle). The only observable on-chain
// signal of an active rate-oracle is `stored_rates()`. So we eth_call the pool:
//   fee()                0xddca3f43 -> raw/1e8 = percent
//   dynamic_fee(i,j)     0x76a9cd3e -> raw/1e8 = percent (deviation-adjusted)
//   stored_rates()       0xfd0684b1 -> uint256[] (dynamic): [offset, len, v0, v1...]
// stored_rates[i] conflates decimal-scaling with the oracle rate: for a coin
// WITHOUT an oracle, stored_rates[i] == 10**(36 - decimals[i]) (pure
// rate_multiplier). So oracle detection MUST be decimals-aware — a naive
// `!= 1e18` test falsely flags every non-18-decimal coin.
// Result shape: { feePct, dynFeePct: {key->pct}, oracle:{active,symbol,mult} }.
const _ONCHAIN_FEE_SEL = '0xddca3f43';      // fee()
const _ONCHAIN_DYNFEE_SEL = '0x76a9cd3e';   // dynamic_fee(int128,int128)
const _ONCHAIN_RATES_SEL = '0xfd0684b1';    // stored_rates()
const _ONCHAIN_OFFPEG_SEL = '0x8edfdd5f';   // offpeg_fee_multiplier() (NG pools only; reverts otherwise)
const _poolOnchainCache = new Map();        // lowerAddr -> { data, ts }
const _POOL_ONCHAIN_TTL = 45000;            // 45s, in line with _ETH_USD_TTL

// int128 arg -> 32-byte big-endian hex word (no 0x). Non-negative small ints only.
function _toAbiWord(n) {
  return BigInt(n).toString(16).padStart(64, '0');
}

// Trim trailing zeros off a fixed-decimal percent string, keep at least "0".
function _fmtPctTrim(pct) {
  if (pct == null || !isFinite(pct)) return null;
  let s = pct.toFixed(4);
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s + '%';
}

// Decode a dynamic uint256[] eth_call return: [offset(0x20), len(N), v0, v1, ...].
// Returns array of BigInt of length N (or null on malformed input).
function _decodeUint256Array(hex) {
  if (!hex || typeof hex !== 'string') return null;
  let h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length < 128) return null; // need at least offset + length words
  // word[0] = offset (expected 0x20), word[1] = length
  const len = Number(BigInt('0x' + h.slice(64, 128)));
  if (!isFinite(len) || len < 0 || len > 16) return null; // sanity cap
  const out = [];
  for (let i = 0; i < len; i++) {
    const start = 128 + i * 64;
    const word = h.slice(start, start + 64);
    if (word.length < 64) return null;
    out.push(BigInt('0x' + word));
  }
  return out;
}

// Resolve per-coin decimals array from pool shape (API field or coinsDetailed).
function _poolDecimals(pool) {
  if (Array.isArray(pool.decimals) && pool.decimals.length) {
    return pool.decimals.map(d => parseInt(d) || 18);
  }
  if (Array.isArray(pool.coinDecimals) && pool.coinDecimals.length) {
    return pool.coinDecimals.map(d => parseInt(d) || 18);
  }
  if (Array.isArray(pool.coinsDetailed) && pool.coinsDetailed.length) {
    return pool.coinsDetailed.map(c => parseInt(c.decimals) || 18);
  }
  return null;
}

// Per-coin symbol array from pool shape.
function _poolSymbols(pool) {
  if (Array.isArray(pool.coins) && pool.coins.length) return pool.coins.slice();
  if (Array.isArray(pool.coinsDetailed)) return pool.coinsDetailed.map(c => c.symbol || '');
  return [];
}

// Central on-chain pull. Caches per pool address (~45s). Reuses rpcCall (failover
// + latency-sort already inside). Never throws — returns partial via allSettled.
// `pairs` = optional array of [i,j] index pairs to fetch dynamic_fee for.
async function fetchPoolOnchainFeeOracle(pool, pairs) {
  if (!pool || !pool.address) return { feePct: null, dynFeePct: {}, oracle: null, offpegMult: null };
  const addr = pool.address;
  const key = addr.toLowerCase();
  const cached = _poolOnchainCache.get(key);
  const haveFresh = cached && (Date.now() - cached.ts < _POOL_ONCHAIN_TTL);

  // Determine which dynamic_fee pairs we still need (cache hit may lack a pair).
  const wantPairs = Array.isArray(pairs) ? pairs.filter(p => Array.isArray(p) && p.length === 2) : [];
  const missingPairs = wantPairs.filter(([i, j]) => !(haveFresh && cached.data.dynFeePct[i + '-' + j] !== undefined));

  if (haveFresh && missingPairs.length === 0) return cached.data;

  // Build call set. Only re-pull fee()/stored_rates() if we don't have fresh ones.
  const tasks = [];
  const taskKinds = [];
  if (!haveFresh) {
    tasks.push(rpcCall(_ONCHAIN_FEE_SEL, addr)); taskKinds.push({ kind: 'fee' });
    tasks.push(rpcCall(_ONCHAIN_RATES_SEL, addr)); taskKinds.push({ kind: 'rates' });
    // offpeg_fee_multiplier() exists only on StableSwapNG / factory-stable-ng
    // pools; it REVERTS on plain StableSwap & crypto pools. allSettled drops
    // the rejection and offpegMult stays null — never let this throw.
    tasks.push(rpcCall(_ONCHAIN_OFFPEG_SEL, addr)); taskKinds.push({ kind: 'offpeg' });
  }
  for (const [i, j] of missingPairs) {
    const data = _ONCHAIN_DYNFEE_SEL + _toAbiWord(i) + _toAbiWord(j);
    tasks.push(rpcCall(data, addr)); taskKinds.push({ kind: 'dynfee', i, j });
  }

  const settled = await Promise.allSettled(tasks);

  // Seed result from cache when present so partial refresh keeps prior values.
  const data = haveFresh
    ? { feePct: cached.data.feePct, dynFeePct: { ...cached.data.dynFeePct }, oracle: cached.data.oracle, offpegMult: cached.data.offpegMult }
    : { feePct: null, dynFeePct: {}, oracle: null, offpegMult: null };

  const decs = _poolDecimals(pool);
  const syms = _poolSymbols(pool);

  for (let t = 0; t < settled.length; t++) {
    const res = settled[t];
    const meta = taskKinds[t];
    if (res.status !== 'fulfilled') continue;
    const hex = res.value;
    try {
      if (meta.kind === 'fee') {
        const raw = BigInt(hex);
        const pct = Number(raw) / 1e8;
        if (isFinite(pct) && pct >= 0) data.feePct = pct;
      } else if (meta.kind === 'dynfee') {
        const raw = BigInt(hex);
        const pct = Number(raw) / 1e8;
        if (isFinite(pct) && pct >= 0) data.dynFeePct[meta.i + '-' + meta.j] = pct;
      } else if (meta.kind === 'rates') {
        const rates = _decodeUint256Array(hex);
        if (rates && decs && rates.length === decs.length) {
          // Decimals-aware: mult[i] = stored_rates[i] / 10**(36 - decimals[i]).
          // oracleActive when mult deviates from 1 by > 1e-6. NOT a naive !=1e18.
          let activeIdx = -1, activeMult = 1;
          for (let i = 0; i < rates.length; i++) {
            const denom = Math.pow(10, 36 - decs[i]);
            const mult = Number(rates[i]) / denom;
            if (isFinite(mult) && Math.abs(mult - 1) > 1e-6) {
              // Prefer the first / most-deviating active coin for the summary.
              if (activeIdx < 0 || Math.abs(mult - 1) > Math.abs(activeMult - 1)) {
                activeIdx = i; activeMult = mult;
              }
            }
          }
          if (activeIdx >= 0) {
            data.oracle = { active: true, symbol: syms[activeIdx] || ('coin' + activeIdx), mult: activeMult };
          } else {
            data.oracle = { active: false, symbol: null, mult: 1 };
          }
        }
      } else if (meta.kind === 'offpeg') {
        // offpeg_fee_multiplier() is scaled by FEE_DENOMINATOR = 1e10.
        // Typical NG values: 2, 5, 10, 20. A value of 1 (or absent) => no
        // dynamic scaling. Reverts on non-NG pools (caught by allSettled).
        const raw = BigInt(hex);
        const m = Number(raw) / 1e10;
        if (isFinite(m) && m >= 1) data.offpegMult = m;
      }
    } catch { /* skip malformed word */ }
  }

  _poolOnchainCache.set(key, { data, ts: Date.now() });
  return data;
}
if (typeof window !== 'undefined') window.fetchPoolOnchainFeeOracle = fetchPoolOnchainFeeOracle;

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
// ↔️ Pair-price direction toggle helpers (single inversion path, self-adapting)
// ============================================================
// Returns the displayed {base, quote} for the current pair, swapped when inverted.
function _tpDir() {
  const p = (typeof selectedPair !== 'undefined') ? selectedPair : null;
  const base = p ? p.base : null;
  const quote = p ? p.quote : null;
  return tradePairInverted ? { base: quote, quote: base } : { base, quote };
}

// Inverts a single candle. Reciprocal flips ordering so high<->low swap.
// time is unchanged. Returns a new object (never mutates input).
function _tpInvCandle(c) {
  if (!c || c.open == null) return c;
  const inv = v => (v && v !== 0) ? 1 / v : v;
  return {
    ...c,
    time: c.time,
    open: inv(c.open),
    close: inv(c.close),
    high: inv(c.low),   // reciprocal of the low is the new high
    low: inv(c.high),   // reciprocal of the high is the new low
  };
}

// Maps a candle array through inversion when the toggle is on; identity otherwise.
function _tpMaybeInvertCandles(data) {
  if (!tradePairInverted || !Array.isArray(data)) return data;
  return data.map(_tpInvCandle);
}

// ============================================================
// ↔️ Pools-tab price-direction toggle (legacy candleSeries / chartPrice header)
// Mirrors the Trade-tab inversion architecture but for the separate /pools surface.
// Reuses the candle-inversion math (_tpInvCandle) and the same special-case: the
// USD sub-price (poolChartPriceSub) is NEVER inverted.
// ============================================================

// Maps a candle array through Pools-tab inversion when ON; identity otherwise.
function _poolMaybeInvCandles(data) {
  if (!poolPriceInverted || !Array.isArray(data)) return data;
  return data.map(_tpInvCandle);
}

// Inverts a _compute24hStats() result for the Pools header. high<->low swap via
// reciprocal; close/open reciprocate; abs/pct change recomputed in inverted terms
// (sign flips — a rising base/quote is a falling quote/base). Magnitude of pct is
// the exact inverted return p/c - 1; abs is recomputed from inverted open/close.
function _poolInvStats(s) {
  if (!s) return s;
  const inv = v => (v != null && v !== 0) ? 1 / v : v;
  const open = inv(s.open);
  const close = inv(s.close);
  const changeAbs = (open != null && close != null) ? (close - open) : s.changeAbs;
  // Exact inverted pct: r_inv = (1/c)/(1/o) - 1 = o/c - 1.
  const changePct = (s.open != null && s.close != null && s.close !== 0)
    ? (s.open / s.close - 1) * 100 : -s.changePct;
  return {
    ...s,
    high: inv(s.low),   // reciprocal of the canonical low is the new high
    low: inv(s.high),
    open, close, changeAbs, changePct,
  };
}

// Reflects current Pools inversion state on the ↔️ button (active class + tooltip).
function _syncPoolPriceInvertBtn() {
  const btn = document.getElementById('poolPriceInvertBtn');
  if (!btn) return;
  btn.classList.toggle('active', !!poolPriceInverted);
  btn.setAttribute('aria-pressed', poolPriceInverted ? 'true' : 'false');
  const p = (typeof selectedPool !== 'undefined') ? selectedPool : null;
  if (p && p.coins && p.coins.length >= 2) {
    const base = poolPriceInverted ? p.coins[1] : p.coins[0];
    const quote = poolPriceInverted ? p.coins[0] : p.coins[1];
    btn.title = `Showing 1 ${base} = … ${quote}. Click to invert.`;
  } else {
    btn.title = 'Invert price direction';
  }
}

// ↔️ toggle for the Pools tab: flip direction, then re-render the chart + header
// from the CANONICAL candle cache. Re-feeding candleSeries.setData with the
// (re-inverted) view, plus re-running the header render, keeps one path for all
// pairs. No-op until candles have loaded (cache empty).
function togglePoolPriceDirection() {
  poolPriceInverted = !poolPriceInverted;
  const canon = Array.isArray(window._poolCanonCandles) ? window._poolCanonCandles : null;
  if (canon && canon.length > 0 && typeof candleSeries !== 'undefined' && candleSeries) {
    // Render first — _renderPoolHeader re-creates the ↔️ button inside innerHTML and
    // re-applies its .active state at the end (render-THEN-sync). No separate sync
    // needed here when candles exist.
    _renderPoolChartFromCandles(canon);
  } else {
    // Cache empty (candles not loaded yet): no header rebuild will run, so reflect
    // the new state on the existing button directly.
    _syncPoolPriceInvertBtn();
  }
}

// Single render path for the Pools chart + header from CANONICAL candles. Applies
// poolPriceInverted to the candle series, chartPrice, chartChange, OHLC row and the
// rich header (24h H/L, abs change, pair label, icons, vol syms). Called by both
// loadOHLC (fresh fetch) and togglePoolPriceDirection (re-render from cache).
// setData() re-feeds every bar, which repaints the whole canvas — on the 30s
// auto-refresh that reads as a blink. When only the newest bars moved (the
// normal case) push just those through update().
// The price API answers with "how many MAIN per one REFERENCE" — measured on
// FT/ftUSD 08.08: main=FT,ref=ftUSD gives 10.209546, main=ftUSD,ref=FT gives
// 0.097948, and 0.097948 is what FT is worth. So to print "FROM / TO" the way a
// human reads it (one FROM costs N TO), main must be the TO token. The pool page
// had it the other way round and printed the reciprocal under the right label —
// invisible on stables, off by 100x here (Alexandr crvecodev/1948). One helper,
// so the chart, the header, the OHLC row and the trades feed cannot drift apart.
function poolPriceTokens(pool, fromIdx, toIdx) {
  const a = pool.coinsAddresses || [];
  const last = a.length > 1 ? 1 : 0;
  const f = a[fromIdx] || a[0];
  const t = a[toIdx] || a[last];
  return { main: t, ref: f };            // main = quote (TO), ref = base (FROM)
}

function _sameCandle(a, b) {
  return !!a && !!b && a.time === b.time && a.open === b.open &&
         a.high === b.high && a.low === b.low && a.close === b.close;
}

function _setCandleData(view) {
  // REVERTED 05.08: the incremental update() path left the chart blank for
  // Alexandr. setData every time costs a repaint, which is the lesser evil;
  // do not re-enable without reproducing his blank chart first.
  candleSeries.setData(Array.isArray(view) ? view.filter(_okCandle) : view);
}

// lightweight-charts renders the time axis and the crosshair label in UTC —
// there is no timezone option. The Recent Activity table is in the viewer's
// local zone, so without these formatters the two disagree by the offset
// (Alexandr 06.08). Formatting (not shifting the timestamps) keeps event->candle
// snapping for the wallet markers intact.
const _TZ_PAD = n => String(n).padStart(2, '0');

function _chartLocalTime(t) {
  const d = new Date((typeof t === 'number' ? t : 0) * 1000);
  return `${_TZ_PAD(d.getDate())}.${_TZ_PAD(d.getMonth() + 1)} ${_TZ_PAD(d.getHours())}:${_TZ_PAD(d.getMinutes())}`;
}

function _chartLocalTick(t, tickMarkType) {
  const d = new Date((typeof t === 'number' ? t : 0) * 1000);
  switch (tickMarkType) {
    case 0: return String(d.getFullYear());                                   // Year
    case 1: return d.toLocaleString('en-US', { month: 'short' });             // Month
    case 2: return String(d.getDate());                                       // DayOfMonth
    case 4: return `${_TZ_PAD(d.getHours())}:${_TZ_PAD(d.getMinutes())}:${_TZ_PAD(d.getSeconds())}`;
    default: return `${_TZ_PAD(d.getHours())}:${_TZ_PAD(d.getMinutes())}`;    // Time
  }
}

const _CHART_LOCALIZATION = { timeFormatter: _chartLocalTime };

function _renderPoolChartFromCandles(canonCandles) {
  if (!Array.isArray(canonCandles) || canonCandles.length === 0 || !candleSeries) return;
  const view = _poolMaybeInvCandles(canonCandles);
  _setCandleData(view);
  _adaptCandlePrecision(candleSeries, view, tradeChart);
  if (typeof _applyTradeMarkers === 'function') _applyTradeMarkers();
  lastCandleData = view.map(c => c.time);
  lastCandleOHLC = view;
  const last = view[view.length - 1];
  const first = view[0];
  const priceEl = document.getElementById('chartPrice');
  if (priceEl) {
    priceEl.textContent = fmtPrice(last.close);
    priceEl.style.color = last.close >= first.open ? 'var(--green)' : 'var(--red)';
  }
  const changeEl = document.getElementById('chartChange');
  const prev = view.length >= 2 ? view[view.length - 2] : first;
  if (changeEl) {
    const changePct = ((last.close - prev.open) / prev.open * 100);
    changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
    changeEl.className = 'chart-change ' + (changePct >= 0 ? 'up' : 'down');
  }
  try {
    const intervalSec = view.length >= 2 ? Math.max(1, view[1].time - view[0].time) : 3600;
    // Compute 24h stats from CANONICAL candles, then invert the stats object so
    // _renderPoolHeader receives already-directional values (it stays inversion-agnostic).
    const statsCanon = _compute24hStats(canonCandles, intervalSec);
    const stats = poolPriceInverted ? _poolInvStats(statsCanon) : statsCanon;
    if (typeof _renderPoolHeader === 'function') _renderPoolHeader(selectedPool, stats, view);
    const lastCandle = view[view.length - 1];
    const oEl = document.getElementById('cO'), hEl = document.getElementById('cH'), lEl = document.getElementById('cL'), cEl = document.getElementById('cC');
    if (oEl) oEl.textContent = fmtPrice(lastCandle.open);
    if (hEl) hEl.textContent = fmtPrice(lastCandle.high);
    if (lEl) lEl.textContent = fmtPrice(lastCandle.low);
    if (cEl) cEl.textContent = fmtPrice(lastCandle.close);
  } catch (e) { /* non-fatal */ }
}

// Single render path for rate-line + headline price + change, applying the
// direction toggle. Takes CANONICAL (non-inverted) candle values; this helper
// flips them when inverted so every chart-load site stays DRY and consistent.
//   rawLast  — last candle (has .close); rawPrev — prior candle (.open/.close
//   reference for change%); rawFirst — first candle (.open, for up/down color).
function applyTradePairDirection(rawLast, rawPrev, rawFirst) {
  if (!rawLast || rawLast.close == null) return;
  const dir = _tpDir();
  const inv = v => (v && v !== 0) ? 1 / v : v;
  // Price shown is the (possibly inverted) close. When a refined (1h-finest)
  // close for THIS pair is already known and fresh, prefer it immediately —
  // otherwise every timeframe click first paints the stale coarse close and
  // only then refines, which reads as the price "dancing" (madeath msg 997).
  let canonClose = rawLast.close;
  try {
    const sig = selectedPair ? ((selectedPair.baseAddr || '') + '|' + (selectedPair.quoteAddr || '')) : null;
    if (sig && _tpHdrLast.sig === sig && _tpHdrLast.close > 0 && Date.now() - _tpHdrLast.ts < 60000) {
      canonClose = _tpHdrLast.close;
    }
  } catch { /* fall back to the candle close */ }
  const showClose = tradePairInverted ? inv(canonClose) : canonClose;
  window._tradePairLastClose = showClose;  // current price for crosshair Delta% (madeath_aa)
  // up/down color: compare canonical close vs first open, then flip the sense
  // when inverted (a rising base/quote is a falling quote/base).
  const firstOpen = rawFirst && rawFirst.open != null ? rawFirst.open : (rawLast.open != null ? rawLast.open : rawLast.close);
  let up = rawLast.close >= firstOpen;
  if (tradePairInverted) up = !up;

  const priceEl = document.getElementById('tradeChartPrice');
  if (priceEl) {
    priceEl.textContent = fmtPrice(showClose);
    priceEl.style.color = up ? 'var(--green)' : 'var(--red)';
  }
  // change%: derived from canonical prev.open -> last.close, magnitude preserved,
  // sign flips under inversion (reciprocal of a gain is a loss).
  const prevOpen = rawPrev && rawPrev.open != null ? rawPrev.open : firstOpen;
  const changeEl = document.getElementById('tradeChartChange');
  if (changeEl && prevOpen > 0) {
    let changePct = (rawLast.close - prevOpen) / prevOpen * 100;
    if (tradePairInverted) {
      // Exact inverted return: r_inv = (1/c)/(1/p) - 1 = p/c - 1.
      changePct = (prevOpen / rawLast.close - 1) * 100;
    }
    changeEl.textContent = (changePct >= 0 ? '+' : '') + changePct.toFixed(2) + '%';
    changeEl.className = 'chart-change ' + (changePct >= 0 ? 'up' : 'down');
  }
  // Rate line "1 base = X quote" using the directional symbols + shown close.
  const rateEl = document.getElementById('tradePairRate');
  if (rateEl && dir.base && dir.quote) {
    rateEl.textContent = `1 ${dir.base} = ${fmtPrice(showClose)} ${dir.quote}`;
  }
  // The candle close above depends on the SELECTED timeframe (coarse candles
  // from the price API lag — 1d close was ~1.7% stale vs 1h on sdYB, Alexandr
  // msg 983). Asynchronously pin the displayed price to the finest (1h)
  // aggregation, whose request-anchored last candle ends at the last trade.
  try { _tpRefineHeaderPrice(); } catch { /* best-effort */ }
}

// Refine the header price/rate line from 1h candles regardless of the chart's
// timeframe. Multi-hop pairs use the per-hop product (with exact vault rates
// for vault↔underlying hops); direct pairs a single fetch. fetchJSON's 30s
// cache keeps timeframe toggling cheap. Chart candles are NOT touched.
let _tpHdrRefineSeq = 0;
// Last refined canonical close per pair — lets applyTradePairDirection paint
// the timeframe-independent price synchronously on timeframe switches.
const _tpHdrLast = { sig: null, close: null, ts: 0 };
async function _tpRefineHeaderPrice() {
  if (!selectedPair) return;
  if (tradePairUnit === 'hour' && tradePairAgg === 1) {
    // Already finest: the candle close IS the refined value — remember it so
    // later timeframe switches paint it synchronously.
    try {
      const sig = (selectedPair.baseAddr || '') + '|' + (selectedPair.quoteAddr || '');
      const canon = Array.isArray(window._tradePairCanonCandles) && window._tradePairCanonCandles.length
        ? window._tradePairCanonCandles[window._tradePairCanonCandles.length - 1].close : null;
      if (canon > 0) { _tpHdrLast.sig = sig; _tpHdrLast.close = canon; _tpHdrLast.ts = Date.now(); }
    } catch { /* non-fatal */ }
    return;
  }
  const seq = ++_tpHdrRefineSeq;
  const pairSig = (selectedPair.baseAddr || '') + '|' + (selectedPair.quoteAddr || '');
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 48 * 3600;
    const lastClose1h = async (poolAddr, mainAddr, refAddr) => {
      const url = `${PRICES_BASE}/ohlc/${getChainKey()}/${poolAddr}?main_token=${mainAddr}&reference_token=${refAddr}&agg_number=1&agg_units=hour&start=${start}&end=${end}`;
      const j = await fetchJSON(url);
      const d = (j && j.data) || [];
      return d.length ? d[d.length - 1].close : null;
    };
    let close = null;
    const route = selectedPair._multiRoute;
    if (Array.isArray(route) && route.length >= 2 && route._bfsTokens && route._bfsTokens.length === route.length + 1) {
      const tokens = route._bfsTokens;
      let acc = 1;
      let ok = true;
      for (let i = 0; i < route.length; i++) {
        const flat = await _tpVaultHopRate(tokens[i], tokens[i + 1]).catch(() => null);
        if (flat != null) { acc *= flat; continue; }
        const rawAddrs = route[i].coinsAddresses || [];
        const norm = rawAddrs.map(a => a.toLowerCase());
        const mainIdx = norm.indexOf(tokens[i + 1]);
        const refIdx = norm.indexOf(tokens[i]);
        if (mainIdx < 0 || refIdx < 0) { ok = false; break; }
        const c = await lastClose1h(route[i].address, rawAddrs[mainIdx], rawAddrs[refIdx]);
        if (c == null || !(c > 0)) { ok = false; break; }
        acc *= c;
      }
      if (ok) close = acc;
    } else if (selectedPair.pool && selectedPair.pool.coinsAddresses) {
      const coinAddrs = selectedPair.pool.coinsAddresses.map(a => a.toLowerCase());
      const bIdx = coinAddrs.indexOf(selectedPair.baseAddr);
      const qIdx = coinAddrs.indexOf(selectedPair.quoteAddr);
      if (bIdx >= 0 && qIdx >= 0) {
        close = await lastClose1h(selectedPair.pool.address, selectedPair.pool.coinsAddresses[qIdx], selectedPair.pool.coinsAddresses[bIdx]);
      }
    }
    if (close == null || !(close > 0)) return;
    if (seq !== _tpHdrRefineSeq) return; // superseded by a newer refine
    if (!selectedPair || ((selectedPair.baseAddr || '') + '|' + (selectedPair.quoteAddr || '')) !== pairSig) return;
    _tpHdrLast.sig = pairSig;
    _tpHdrLast.close = close;
    _tpHdrLast.ts = Date.now();
    const show = tradePairInverted ? 1 / close : close;
    const priceEl = document.getElementById('tradeChartPrice');
    if (priceEl) priceEl.textContent = fmtPrice(show);
    const dir = _tpDir();
    const rateEl = document.getElementById('tradePairRate');
    if (rateEl && dir.base && dir.quote) rateEl.textContent = `1 ${dir.base} = ${fmtPrice(show)} ${dir.quote}`;
    // The "$X" sub-line is the same current-price display (canonical
    // direction) — repaint it too, or it keeps the lagging coarse close.
    try {
      const subEl = document.getElementById('tradeChartPriceSub');
      const q = (selectedPair.quote || '').toUpperCase();
      if (subEl && /USD|USDC|USDT|DAI|FRAX|LUSD|TUSD|USDP|GUSD/.test(q)) {
        subEl.textContent = '$' + (close >= 1 ? close.toFixed(2) : close.toFixed(6));
      }
    } catch { /* non-fatal */ }
    // Extend the chart's in-progress candle to the refined price: upstream's
    // agg1/day last candle lags ~a day (verified 2026-06-12: 1H/4H/1W closes
    // agree, only 1D differs), so the series' last bar — and the price label
    // on the right scale — kept "dancing" on 1D (madeath msg 1003). Standard
    // exchange semantics: the current candle closes at the last trade.
    try {
      const canon = Array.isArray(window._tradePairCanonCandles) ? window._tradePairCanonCandles : null;
      if (canon && canon.length && typeof tradePairCandleSeries !== 'undefined' && tradePairCandleSeries) {
        const lastC = canon[canon.length - 1];
        // Живая цена дорисовывается в последнюю свечу, только если ряд вообще про
        // эту пару: на чужом ряду это давало вертикальную свечу во весь экран
        // (17.08, CRV/SDT: ряд ~1900, живая цена 2.85).
        if (lastC && lastC.close !== close && lastC.close > 0 && Math.abs(close / lastC.close - 1) <= 0.5) {
          const patched = {
            time: lastC.time,
            open: lastC.open,
            high: Math.max(lastC.high, close),
            low: Math.min(lastC.low, close),
            close,
          };
          canon[canon.length - 1] = patched;
          tradePairCandleSeries.update(_tpMaybeInvertCandles([patched])[0]);
        }
      }
    } catch { /* chart patch is best-effort */ }
  } catch { /* refine is best-effort; the timeframe close stays */ }
}

// Reflects current inversion state on the ↔️ button (active class + tooltip).
// Top-level function so it is a window property (callable from inline contexts).
function _syncTradePairInvertBtn() {
  const btn = document.getElementById('tradePairInvertBtn');
  if (!btn) return;
  btn.classList.toggle('active', !!tradePairInverted);
  const dir = _tpDir();
  if (dir.base && dir.quote) {
    btn.title = `Showing 1 ${dir.base} = … ${dir.quote}. Click to invert.`;
    btn.setAttribute('aria-pressed', tradePairInverted ? 'true' : 'false');
  }
}

// ↔️ toggle: flip direction, then re-render everything from the CANONICAL candle
// cache. Re-feeding via setData runs the single inversion wrapper afresh (chart +
// crosshair + rich header), and applyTradePairDirection refreshes the rate line
// and headline price/change. One path, all pairs — no per-pair special cases.
function toggleTradePairDirection() {
  tradePairInverted = !tradePairInverted;
  _syncTradePairInvertBtn();
  const canon = Array.isArray(window._tradePairCanonCandles) ? window._tradePairCanonCandles : null;
  if (canon && canon.length > 0 && typeof tradePairCandleSeries !== 'undefined' && tradePairCandleSeries) {
    // Re-feed canonical candles; wrapper inverts per the new state.
    try { tradePairCandleSeries.setData(canon); } catch (e) { console.warn('[chart] setData при перевороте пары отказал:', e); }
    const last = canon[canon.length - 1];
    const first = canon[0];
    const prev = canon.length >= 2 ? canon[canon.length - 2] : first;
    applyTradePairDirection(last, prev, first);
  } else {
    // No candle cache yet (e.g. chart still loading): at least flip the rate line
    // text using whatever we can. Headline price stays until candles arrive.
    const rateEl = document.getElementById('tradePairRate');
    const dir = _tpDir();
    if (rateEl && dir.base && dir.quote && /^1 .+ = .+/.test(rateEl.textContent || '')) {
      // Reuse the existing numeric token but flip symbols + reciprocal.
      const m = (rateEl.textContent || '').match(/^1 \S+ = ([0-9.eE+-]+) /);
      if (m) {
        const x = parseFloat(m[1]);
        const inv = (x && x !== 0) ? (1 / x) : x;
        rateEl.textContent = `1 ${dir.base} = ${fmtPrice(inv)} ${dir.quote}`;
      }
    }
  }
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

// ЕДИНСТВЕННЫЙ список стейблов в файле (18.08: их было три, и они отвечали
// по-разному на один вопрос). Обращаться через _isStableSym — он приводит
// регистр. Список знаменателей пары (quotePreferred) — другая сущность.
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
      // USD-absolute trap: stats.close comes from the (possibly inverted) candles.
      // The "$X" sub-line is an ABSOLUTE USD price of the base token vs the USD
      // quote — a property of the canonical direction, so it must NOT invert.
      // Recover the canonical close (1/inverted) before formatting the dollar value.
      let usdClose = tradePairInverted && stats.close ? (1 / stats.close) : stats.close;
      // Like the big price, this is a CURRENT-price display — on coarse
      // timeframes (1D) the candle close lags the last trade, so prefer the
      // refined per-pair close when fresh (madeath msg 999: 1D "пляшет").
      try {
        const sig = (pair.baseAddr || '') + '|' + (pair.quoteAddr || '');
        if (_tpHdrLast.sig === sig && _tpHdrLast.close > 0 && Date.now() - _tpHdrLast.ts < 60000) {
          usdClose = _tpHdrLast.close;
        }
      } catch { /* candle close stays */ }
      if (isUsd) subEl.textContent = '$' + (usdClose >= 1 ? usdClose.toFixed(2) : usdClose.toFixed(6));
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
  // CANONICAL token order (coins[0]/coins[1]) — used for the USD sub-price, which
  // must NOT follow the ↔️ direction toggle (the $ absolute value is a base-token
  // price, independent of which way the ratio is displayed).
  const cBaseSym = (pool.coins && pool.coins[0]) || '';
  const cQuoteSym = (pool.coins && pool.coins[1]) || '';
  // DISPLAY token order — swapped when the Pools-tab toggle is inverted. Drives the
  // pair label, icons and vol-symbol labels so they read in the shown direction.
  const _inv = (typeof poolPriceInverted !== 'undefined') && poolPriceInverted;
  const baseSym = _inv ? cQuoteSym : cBaseSym;
  const quoteSym = _inv ? cBaseSym : cQuoteSym;
  const baseAddr = (pool.coinsAddresses && (_inv ? pool.coinsAddresses[1] : pool.coinsAddresses[0])) || '';
  const quoteAddr = (pool.coinsAddresses && (_inv ? pool.coinsAddresses[0] : pool.coinsAddresses[1])) || '';
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
      // When inverted, swap the first two tickers so the label reads in the shown
      // direction (e.g. "USDC / USDT" -> "USDT / USDC"). Any extra coins (3+ pools)
      // keep their position.
      const coinsForLabel = pool.coins.slice();
      if (_inv && coinsForLabel.length >= 2) { const t = coinsForLabel[0]; coinsForLabel[0] = coinsForLabel[1]; coinsForLabel[1] = t; }
      const parts = coinsForLabel.map((c, i) => {
        const cls = i === 0 ? 'pair-clickable pair-accent' : 'pair-clickable';
        const safeSym = String(c).replace(/'/g, "\\'");
        return `<span class="${cls}" title="Click to filter pools by ${c}" onclick="pickTokenSearch('${safeSym}')">${c}</span>`;
      });
      // The ↔️ price-direction toggle lives BETWEEN the first two tickers (the two
      // tokens it swaps). event.stopPropagation() prevents the click from bubbling to
      // the adjacent pair-clickable spans (which call pickTokenSearch). Any extra
      // separators (3+ coin pools) stay as the plain " / " divider.
      const invBtnHtml = '<button type="button" id="poolPriceInvertBtn" onclick="event.stopPropagation();togglePoolPriceDirection()" title="Invert pair" aria-label="Invert pair" aria-pressed="false" style="display:inline-flex;align-items:center;justify-content:center;background:transparent;border:1px solid #2b3139;border-radius:6px;color:inherit;cursor:pointer;font-size:13px;line-height:1;padding:2px 5px;margin:0 6px;opacity:0.85;vertical-align:middle;"><svg viewBox="0 0 1024 1024" fill="currentColor" width="1em" height="1em" style="display:block" xmlns="http://www.w3.org/2000/svg"><path d="M847.9 592H152c-4.4 0-8 3.6-8 8v60c0 4.4 3.6 8 8 8h605.2L612.9 851c-4.1 5.2-.4 13 6.3 13h72.5c4.9 0 9.5-2.2 12.6-6.1l168.8-214.1c16.5-21 1.6-51.8-25.2-51.8zM872 356H266.8l144.3-183c4.1-5.2.4-13-6.3-13h-72.5c-4.9 0-9.5 2.2-12.6 6.1L150.9 380.2c-16.5 21-1.6 51.8 25.1 51.8h696c4.4 0 8-3.6 8-8v-60c0-4.4-3.6-8-8-8z"></path></svg></button>';
      let pairHtml = parts[0] + invBtnHtml + (parts.length >= 2 ? parts[1] : '');
      for (let i = 2; i < parts.length; i++) pairHtml += '<span class="pair-divider"> / </span>' + parts[i];
      nameEl.innerHTML = pairHtml + linkHtml;
      // The button was just re-created inside innerHTML, so its .active highlight was
      // wiped — re-apply the current inversion state AFTER the rebuild.
      if (typeof _syncPoolPriceInvertBtn === 'function') _syncPoolPriceInvertBtn();
    } else {
      nameEl.innerHTML = `<span class="pair-clickable pair-accent" onclick="openPairPicker('from')">${pool.name || ''}</span>` + linkHtml;
    }
    // Deprecated pools (registry withdraw-only OR gauge killed) get an explicit
    // pill in the header so users opening the card understand its status without
    // hovering the sidebar ⚠️.
    if (pool.deprecated || pool.gaugeIsKilled) {
      const pillTitle = pool.deprecated
        ? 'Deprecated pool — withdraw only. You can remove (and add) liquidity; trading/charts are not supported.'
        : 'Gauge killed by Curve DAO — protocol deprecated.';
      nameEl.innerHTML += `<span title="${pillTitle}" style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:6px;font-size:11px;font-weight:600;letter-spacing:0.3px;background:rgba(240,185,11,0.15);color:#f0b90b;border:1px solid rgba(240,185,11,0.35);vertical-align:middle;white-space:nowrap;">⚠️ Deprecated${pool.withdrawOnly ? ' · withdraw only' : ''}</span>`;
    }
  }
  // Pool meta
  const metaEl = document.getElementById('poolPoolMeta');
  if (metaEl) {
    const parts = [];
    if (pool.deprecated) parts.push('deprecated / withdraw-only');
    if (pool.name) parts.push(_shortPoolName(pool.name));
    const feePct = _poolFeePct(pool);
    if (feePct != null) parts.push(feePct.toFixed(2).replace(/\.?0+$/, '') + '% fee');
    const ptype = _classifyPoolType(pool);
    if (ptype) parts.push(ptype);
    metaEl.textContent = parts.length ? parts.join(' · ') : '--';
  }
  // 24h stats
  if (stats) {
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
      // USD sub-price is direction-INDEPENDENT: detect USD on the CANONICAL quote and
      // use the CANONICAL close ($ absolute value must not invert). When stats are
      // inverted, stats.close == 1/canonical_close, so reciprocate back.
      const q = (cQuoteSym || '').toUpperCase();
      const isUsd = /USD|USDC|USDT|DAI|FRAX|LUSD|TUSD|USDP|GUSD/.test(q);
      const canonClose = (_inv && stats.close && stats.close !== 0) ? 1 / stats.close : stats.close;
      if (isUsd) subEl.textContent = '$' + (canonClose >= 1 ? canonClose.toFixed(2) : canonClose.toFixed(6));
      else subEl.textContent = cBaseSym + ' Price';
    }
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
  renderPoolTypeBadge('infoType', pool, false);
  const ampCoeff = pool.amplificationCoefficient;
  document.getElementById('infoAmpCoeff').textContent = ampCoeff ? Number(ampCoeff).toLocaleString() : '--';
  document.getElementById('infoAddress').innerHTML = `<a href="${window.getExplorerAddressUrl(pool.address)}" target="_blank" rel="noopener noreferrer" title="${pool.address}">${shortAddr(pool.address)}</a>`;

  // Modern pools (stable-ng, twocrypto/tricrypto) mint the LP from the pool
  // contract itself — the two rows then printed the same address twice. Show
  // the second row only when the LP token really is a separate contract.
  const lpAddr = pool.lpTokenAddress || pool.address;
  const lpIsPool = lpAddr.toLowerCase() === pool.address.toLowerCase();
  const lpRow = document.getElementById('infoLpTokenRow');
  const addrLabel = document.getElementById('infoAddressLabel');
  if (lpRow) lpRow.style.display = lpIsPool ? 'none' : '';
  if (addrLabel) {
    addrLabel.textContent = lpIsPool ? 'Pool · LP Token' : 'Pool';
    addrLabel.title = lpIsPool ? 'This pool mints its LP token from the pool contract itself' : '';
  }
  document.getElementById('infoLpToken').innerHTML = `<a href="${window.getExplorerAddressUrl(lpAddr)}" target="_blank" rel="noopener noreferrer" title="${lpAddr}">${shortAddr(lpAddr)}</a>`;
  if (typeof window.renderCoinContracts === 'function') {
    window.renderCoinContracts(pool, 'infoCoins', 'infoCoinsList');
  }

  const gaugeRow = document.getElementById('infoGaugeRow');
  if (pool.gaugeAddress) {
    gaugeRow.style.display = '';
    document.getElementById('infoGauge').innerHTML = `<a href="${window.getExplorerAddressUrl(pool.gaugeAddress)}" target="_blank" rel="noopener noreferrer" title="${pool.gaugeAddress}">${shortAddr(pool.gaugeAddress)}</a>`;
  } else {
    gaugeRow.style.display = 'none';
  }

  // Fee: synchronous API/fallback first (non-NG pools), then on-chain refine.
  const _feeElTrade = document.getElementById('infoFee');
  if (_feeElTrade) {
    const syncFee = _poolFeePct(pool);
    _feeElTrade.textContent = syncFee != null ? (_fmtPctTrim(syncFee) || '--') : '...';
    _feeElTrade.style.opacity = '';
  }

  // Rate Oracle: pool.usesRateOracle from getPools API is POOL-LEVEL and
  // MISLEADING (FALSE even when a coin has an active oracle). Real signal is
  // on-chain stored_rates() with decimals-aware multiplier check. We render a
  // provisional value here, then refine async below. See spec / msg 882.
  const _rateOracleElTrade = document.getElementById('infoRateOracle');
  if (_rateOracleElTrade) {
    _rateOracleElTrade.textContent = '...';
    _rateOracleElTrade.style.opacity = '';
  }

  // Async on-chain refine of Fee + Rate Oracle (copy of yield.js % Staked
  // pattern: pool-change guard + graceful '--' / 'No' on failure, never throws).
  if (_feeElTrade || _rateOracleElTrade) {
    fetchPoolOnchainFeeOracle(pool).then((info) => {
      if (selectedPool !== pool) return; // user navigated away mid-flight
      if (_feeElTrade) {
        if (info.feePct != null) {
          if (info.offpegMult != null && info.offpegMult > 1) {
            // StableSwapNG dynamic fee: base swap fee scales up toward
            // fee × offpeg_fee_multiplier as balances go off-peg. Show range.
            const baseP = info.feePct;              // already a percent, e.g. 0.04
            const maxP = baseP * info.offpegMult;   // effective max when fully off-peg
            const multStr = info.offpegMult % 1 === 0 ? info.offpegMult : info.offpegMult.toFixed(2);
            _feeElTrade.textContent = `${_fmtPctTrim(baseP)} → ${_fmtPctTrim(maxP)}`;
            _feeElTrade.title = `Base swap fee ${_fmtPctTrim(baseP)} (on-chain fee()). For this StableSwapNG pool the effective fee scales up to ${_fmtPctTrim(maxP)} as balances go off-peg (offpeg_fee_multiplier ×${multStr}).`;
          } else {
            _feeElTrade.textContent = _fmtPctTrim(info.feePct) || '--';
            _feeElTrade.title = '';
          }
          _feeElTrade.style.opacity = '';
        } else {
          // Keep synchronous fallback if on-chain fee() unavailable.
          const syncFee = _poolFeePct(pool);
          _feeElTrade.textContent = syncFee != null ? (_fmtPctTrim(syncFee) || '--') : '--';
          _feeElTrade.style.opacity = syncFee != null ? '' : '0.5';
        }
      }
      if (_rateOracleElTrade) {
        if (info.oracle && info.oracle.active) {
          const m = info.oracle.mult;
          _rateOracleElTrade.textContent = `Yes - ${info.oracle.symbol} ×${m.toFixed(4)}`;
          _rateOracleElTrade.style.opacity = '';
        } else if (info.oracle) {
          _rateOracleElTrade.textContent = 'No';
          _rateOracleElTrade.style.opacity = '';
        } else {
          // stored_rates() unavailable — fall back to API flag (best-effort).
          _rateOracleElTrade.textContent = pool.usesRateOracle === true ? 'Yes' : 'No';
          _rateOracleElTrade.style.opacity = '';
        }
      }
    }).catch((e) => {
      console.warn('on-chain fee/oracle pull failed (trade):', e);
      if (selectedPool !== pool) return;
      if (_feeElTrade) {
        const syncFee = _poolFeePct(pool);
        _feeElTrade.textContent = syncFee != null ? (_fmtPctTrim(syncFee) || '--') : '--';
        _feeElTrade.style.opacity = syncFee != null ? '' : '0.5';
      }
      if (_rateOracleElTrade) {
        _rateOracleElTrade.textContent = pool.usesRateOracle === true ? 'Yes' : 'No';
        _rateOracleElTrade.style.opacity = '';
      }
    });
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
// Ручка отдаёт свечи с null в пустых корзинах. Библиотека на такой точке кидает
// «Value is null» и рушит ВЕСЬ график (стек 17.08: Oi.Candlestick -> Ws -> map).
// Чиним у источника: битую точку выбрасываем, а не додумываем — нарисованная
// свеча, которой не было, это враньё.
// ОДНА ТОЧКА НЕ ДОЛЖНА УБИВАТЬ РЯД. lightweight-charts кидает «Value is null»
// на любой точке с null/NaN и не рисует НИЧЕГО — весь график пустой из-за одной
// пустой корзины ручки (17.08, перемежающийся отказ на USDC/WETH). Оборачиваем
// КАЖДУЮ нашу серию один раз при создании: мусорные точки отбрасываются, живые
// рисуются. Чинить точку нельзя — додуманная свеча это враньё.
function _guardSeries(series, kind) {
  if (!series || series.__guarded) return series;
  const ok = d => !!d && Number.isFinite(d.time) && (kind === 'candle'
    ? (Number.isFinite(d.open) && Number.isFinite(d.high) && Number.isFinite(d.low) && Number.isFinite(d.close))
    : Number.isFinite(d.value));
  ['setData', 'update'].forEach(fn => {
    if (typeof series[fn] !== 'function') return;
    const orig = series[fn].bind(series);
    series[fn] = function (arg) {
      if (Array.isArray(arg)) {
        const clean = arg.filter(ok);
        if (clean.length !== arg.length) console.warn('[chart] отброшено битых точек:', arg.length - clean.length, kind);
        return orig(clean);
      }
      if (!ok(arg)) { console.warn('[chart] отброшена битая точка', kind); return; }
      return orig(arg);
    };
  });
  series.__guarded = true;
  return series;
}

function _okCandle(c) {
  return c && Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high)
    && Number.isFinite(c.low) && Number.isFinite(c.close) && c.close > 0;
}

function _sqrtNormalizeVol(volData) {
  _volOriginalValues = {};
  if (!volData || volData.length === 0) return volData;
  // Одна воронка на ОБА графика: пустая корзина приходит как undefined/NaN,
  // Math.sqrt даёт NaN, и библиотека роняет «Value is null» — весь ряд не
  // рисуется из-за одной точки (17.08).
  const clean = volData.filter(d => d && Number.isFinite(d.time) && Number.isFinite(d.value) && d.value >= 0);
  clean.forEach(d => { _volOriginalValues[d.time] = d.value; });
  return clean.map(d => ({ ...d, value: Math.sqrt(d.value) }));
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
      horzLine: { color: '#f0b90b33', width: 1, style: 0, labelBackgroundColor: '#f0b90b', labelVisible: false },
    },
    rightPriceScale: { borderColor: '#2b3139', scaleMargins: { top: 0.1, bottom: 0.25 }, minimumWidth: _isMobile ? 48 : 70 },
    localization: _CHART_LOCALIZATION,
    timeScale: { borderColor: '#2b3139', timeVisible: true, secondsVisible: false, tickMarkFormatter: _chartLocalTick },
    handleScroll: { vertTouchDrag: true },
  });

  candleSeries = _guardSeries(tradeChart.addCandlestickSeries({
    upColor: '#0ecb81', downColor: '#f6465d',
    borderUpColor: '#0ecb81', borderDownColor: '#f6465d',
    wickUpColor: '#0ecb81', wickDownColor: '#f6465d',
  }), 'candle');

  volumeChartSeries = _guardSeries(tradeChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    lastValueVisible: false,
    priceLineVisible: false,
  }), 'hist');
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
    // Axis crosshair %-pill (madeath_aa msg 1177): % of the price under the cursor
    // vs current price, on the right scale like Binance. First in handler so it
    // also hides on mouse-leave (param.point undefined).
    (function(){
      const _c = document.getElementById('trade-chart-container');
      let _p = document.getElementById('poolsAxisPct');
      if (!_p && _c) { _p = document.createElement('div'); _p.id = 'poolsAxisPct'; _p.className = 'chart-axis-pct'; _c.appendChild(_p); }
      if (_p) {
        const _arr = (typeof lastCandleOHLC !== 'undefined') ? lastCandleOHLC : null;
        const _lc = (_arr && _arr.length) ? _arr[_arr.length-1].close : null;
        let _py = null;
        try { _py = (candleSeries && param.point && param.point.y != null) ? candleSeries.coordinateToPrice(param.point.y) : null; } catch (e) { _py = null; }
        if (_py != null && _lc) {
          const _pct = (_py - _lc) / _lc * 100;
          _p.textContent = (typeof fmtPrice === 'function' ? fmtPrice(_py) : _py.toFixed(4)) + '  ' + (_pct >= 0 ? '+' : '') + _pct.toFixed(2) + '%';
          _p.style.top = param.point.y + 'px';
          _p.style.background = _pct >= 0 ? '#0ecb81' : '#f6465d';
          _p.style.display = 'block';
        } else { _p.style.display = 'none'; }
      }
    })();
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
  // Registry deprecated pools have no price-history backend (by design, see
  // deprecated_pools.json) — skip the fetch instead of generating 404 noise.
  if (pool.deprecated) return;
  if (!pool.coinsAddresses || pool.coinsAddresses.length < 2) return;
  // Use selected swap tokens if available, otherwise default to first two
  const fromIdx = selectedFromToken ? selectedFromToken.index : 0;
  const toIdx = selectedToToken ? selectedToToken.index : 1;
  const { main: mainToken, ref: refToken } = poolPriceTokens(pool, fromIdx, toIdx);
  if (!mainToken || !refToken || mainToken === refToken) return;

  const timeRanges = { 1: 7*24, 4: 30*24 };
  const dayRanges = { 1: 250*24, 7: 365*24 };
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
    })).filter(_okCandle).filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
    if (candles.length > 0 && candleSeries) {
      // Stash CANONICAL (non-inverted) candles so the ↔️ toggle can re-render
      // without double-inverting, then route through the single render path which
      // applies poolPriceInverted to chart + header consistently.
      window._poolCanonCandles = candles;
      _renderPoolChartFromCandles(candles);
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return; // silent — by-design fetch cancel on pair switch
    console.error('OHLC load error:', e);
  }
  loadVolumeFromTrades();
}

const CDX_API = (typeof window !== 'undefined' && window.__CDX_API_BASE)
  ? window.__CDX_API_BASE
  : ((typeof window !== 'undefined' && window.__DYNAMIC_BASE) ? window.__DYNAMIC_BASE + '/cdx-api' : 'https://t.llama.box/cdx-api');

// Client-side circuit breaker: pools for which CDX_API/trades has returned 404.
// Skip on next polls (auto-refresh fires every 30s) so we don't spam the server
// indefinitely. Set is cleared on page reload. Pool address never changes for a
// given pool, so once 404, always 404 within the same session. Other endpoints
// (PRICES_BASE/trades, OHLC) are unaffected.
const _cdxApiTrades404 = new Set();

// Same pattern for prices.curve.finance/v1/volume/<chain>/<pool>: some pools
// (e.g. stETH 0xDC24316b...22) return 404 {"detail":"Pool not found"} or 405
// for every switch-pair → spams console + wastes a network roundtrip every
// time. Per-pool circuit breaker. Address lowercase. Other endpoints unaffected.
// Pre-seeded with known offenders (was _NO_VOLUME_API_POOLS, now unified).
// Пустой: список нарабатывается сам на первом 404/405 (см. ниже). Вбитый руками
// пул — это перечисление случаев, а не механизм (аудит костылей 18.08).
const _curvePricesVolume404 = new Set();

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
// ЖИВОЙ ДНЕВНОЙ ОБЪЁМ ПУЛА — приоритетнее и снапшота, и нашей базы.
// Замер 18.08 на пересечении дней: наша trades.db даёт 1/37 объёма 3pool и
// 1/3 у TricryptoUSDC, а prices.curve.finance сходится со снапшотом Curve
// (0.70 и 1.13). Снапшот при этом СТОИТ с 12.06.2026 (крон не пережил переезд
// на новый VPS). Итог: снапшот — только фундамент глубокой истории, наша база —
// только форма внутри суток, а величину дня всегда даёт живой источник.
const _pricesDayVolCache = new Map();
async function _pricesDailyVolMap(pool) {
  if (!pool || !pool.address) return null;
  const addrLC = String(pool.address).toLowerCase();
  if (_curvePricesVolume404.has(addrLC)) return null;
  const addrs = Array.isArray(pool.coinsAddresses) ? pool.coinsAddresses : [];
  if (addrs.length < 2) return null;
  const chain = getChainKey();
  const key = chain + ':' + addrLC;
  const hit = _pricesDayVolCache.get(key);
  if (hit && Date.now() - hit.ts < 300000) return hit.map;
  const end = Math.floor(Date.now() / 1000);
  const start = end - 299 * 86400;   // ручка отдаёт 300 записей: с interval=day это 299 суток
  const ask = async (m, r) => {
    const resp = await fetch(`${PRICES_BASE}/volume/${chain}/${pool.address}?main_token=${m}&reference_token=${r}&start=${start}&end=${end}&interval=day`);
    if (resp.status === 404 || resp.status === 405) { _curvePricesVolume404.add(addrLC); return null; }
    if (!resp.ok) return null;
    const j = await resp.json();
    const map = new Map(); let total = 0;
    for (const d of (j && j.data) || []) {
      const ts = Math.floor(Number(d && d.timestamp) / 86400) * 86400;
      const v = Number(d && d.volume) || 0;
      if (!Number.isFinite(ts) || v <= 0) continue;
      map.set(ts, (map.get(ts) || 0) + v); total += v;
    }
    return { map, total };
  };
  let best = null;
  try {
    // ПОРЯДОК ТОКЕНОВ НЕ СИММЕТРИЧЕН (TricryptoUSDC, 30 дней: $19.3M против $10K).
    const pair = await Promise.all([ask(addrs[0], addrs[1]), ask(addrs[1], addrs[0])]);
    for (const c of pair) if (c && c.total > 0 && (!best || c.total > best.total)) best = c;
  } catch (e) { /* живого слоя нет — остаёмся на истории */ }
  const map = best ? best.map : null;
  _pricesDayVolCache.set(key, { ts: Date.now(), map });
  return map;
}

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

  // REVERTED 05.08: keeping the series across refreshes cost the last week of
  // volume bars on Alexandr's chart. Recreate it, as before — the flash is the
  // lesser evil. Do not "optimise" this again without reproducing that.
  // Recreate histogram series to avoid stale scale state after right-scale margin changes
  if (volumeChartSeries && tradeChart) {
    try { tradeChart.removeSeries(volumeChartSeries); } catch(e) {}
    volumeChartSeries = _guardSeries(tradeChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    }), 'hist');
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
    let cdxBuckets = [];
    // Key the circuit breaker by chain too: the same address can be indexed on
    // one chain and absent on another.
    const _chain = (typeof activeChainKey !== 'undefined' && activeChainKey) ? activeChainKey : 'ethereum';
    const _addrLC = _chain + ':' + (pool.address || '').toLowerCase();
    if (!_cdxApiTrades404.has(_addrLC)) {
      try {
        // Ask for the chart's own resolution so intraday bars are real, not a
        // daily figure divided by six (Alexandr crvecodev/1828).
        const _bucketSec = currentUnit === 'day' ? 86400 : Math.max(60, currentAgg * 3600);
        // ...and at the chart's own phase: its 4H candles start at 02:00, not 00:00.
        const _cts = lastCandleData || [];
        const _bucketOff = _cts.length ? ((_cts[0] % _bucketSec) + _bucketSec) % _bucketSec : 0;
        const resp = await fetch(`${CDX_API}/trades/${pool.address}?chain=${_chain}&bucket=${_bucketSec}&offset=${_bucketOff}&t=${Date.now()}`, { cache: 'no-store' });
        if (resp.status === 404) {
          // Server has no trades data for this pool — circuit-break to avoid
          // hammering it every 30s on auto-refresh. Long-history snapshot below
          // still fills the chart if available.
          _cdxApiTrades404.add(_addrLC);
        } else if (resp.ok) {
          const data = await resp.json();
          cdxDaily = (data && Array.isArray(data.daily)) ? data.daily : [];
          cdxBuckets = (data && Array.isArray(data.buckets)) ? data.buckets : [];
        }
      } catch { /* keep cdxDaily = [] */ }
    }

    // Merge in long-history snapshot for 1D / 1W timeframes (it's daily granularity).
    // For sub-daily we still use the merged set — it covers gaps just the same.
    let mergedDaily = await _mergeLongHistoryDaily(cdxDaily, pool.address);
    const liveDayVol = await _pricesDailyVolMap(pool);
    if (liveDayVol && liveDayVol.size) {
      const _byTs = new Map(mergedDaily.map(d => [d.timestamp, d]));
      for (const [ts, v] of liveDayVol) _byTs.set(ts, { timestamp: ts, volume_usd: v, trade_count: 0, _src: 'prices-day' });
      mergedDaily = Array.from(_byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
    }
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
          // Real per-candle volume where the server could give it. The even
          // split stays only for days it does not cover (deep history comes
          // from the daily snapshot), otherwise a 4H chart repeats one bar six
          // times (Alexandr crvecodev/1828).
          const realVol = new Map();
          cdxBuckets.forEach(b => { if (b && b.volume_usd > 0) realVol.set(b.timestamp, b.volume_usd); });
          // ВЕЛИЧИНУ ДНЯ ДАЁТ ЖИВОЙ ИСТОЧНИК, ФОРМУ ВНУТРИ ДНЯ — НАША БАЗА,
          // и только если она этот день реально видела. Замер 18.08: по 3pool
          // наша trades.db держит 1/37 объёма и покрывает 97 свечей из 181 —
          // её «форма» там не форма, а дырки. Порог: сумма наших корзин за день
          // должна лежать в пределах вдвое от живого дня, иначе день ровно
          // размазывается по своим свечам.
          const _ourDaySum = new Map();
          for (const [ts, v] of realVol) {
            const d = Math.floor(ts / 86400) * 86400;
            _ourDaySum.set(d, (_ourDaySum.get(d) || 0) + v);
          }
          for (const [dayTsStr, candles] of Object.entries(candlesByDay)) {
            const dayTs = parseInt(dayTsStr);
            const live = (liveDayVol && liveDayVol.get(dayTs)) || dayVolMap.get(dayTs) || 0;
            const ours = _ourDaySum.get(dayTs) || 0;
            // Плюс ПОКРЫТИЕ: одна корзина, случайно попавшая в вилку по сумме,
            // иначе заберёт весь дневной объём в один столбик. Нужна половина
            // свечей дня, иначе день размазывается ровно.
            const _covered = candles.filter(ts => (realVol.get(ts) || 0) > 0).length;
            const trustShape = live > 0 && ours > 0 && ours / live >= 0.5 && ours / live <= 2
              && _covered >= Math.ceil(candles.length / 2);
            if (trustShape) {
              const k = live / ours;
              candles.forEach(ts => { const v = realVol.get(ts); if (v > 0) volumeMap[ts] = v * k; });
              continue;
            }
            const dayVol = live > 0 ? live : ours;
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
    const dayRangesV = { 1: 250*24, 7: 365*24 };
    const hoursBackV = currentUnit === 'day' ? (dayRangesV[currentAgg] || 90*24) : (timeRangesV[currentAgg] || 30*24);
    const startV = Math.floor(Date.now() / 1000) - hoursBackV * 3600;
    const endV = Math.floor(Date.now() / 1000);
    const _addrLCV = (pool.address || '').toLowerCase();
    if (_curvePricesVolume404.has(_addrLCV)) {
      // Circuit-breaker hit — skip fetch, fall through to Curve trades API.
      throw new Error('skip-volume-404');
    }
    const volUrl = `${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${mainTokenV}&reference_token=${refTokenV}&start=${startV}&end=${endV}`;
    const volResp = await fetch(volUrl);
    if (volResp.status === 404 || volResp.status === 405) {
      _curvePricesVolume404.add(_addrLCV);
    } else if (volResp.ok) {
      const volJson = await volResp.json();
      let hourlyData = volJson.data || [];
      // ПОРЯДОК ТОКЕНОВ В РУЧКЕ НЕ СИММЕТРИЧЕН (замер 17.08, TricryptoUSDC,
      // 30 дней: main=USDC ref=WETH -> $19.3M, обратный порядок -> $10K).
      // Пустой ответ = скорее всего спросили не с той стороны.
      if (!hourlyData.some(d => (Number(d && d.volume) || 0) > 0)) {
        try {
          const _rr = await fetch(`${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${refTokenV}&reference_token=${mainTokenV}&start=${startV}&end=${endV}`);
          if (_rr.ok) { const _jj = await _rr.json(); if ((_jj.data || []).some(d => (Number(d && d.volume) || 0) > 0)) hourlyData = _jj.data; }
        } catch (e) { /* остаёмся с первым ответом */ }
      }
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
let _tradesWallet = null;          // lowercased address, or null for "everyone"
// The feed is paged both ways: the API hands out 50 events per source per page,
// and the DOM only ever holds TRADES_RENDER_STEP rows more than the user has
// scrolled past — a busy pool would otherwise build thousands of <tr> up front.
const TRADES_PAGE_SIZE = 50;
const TRADES_RENDER_STEP = 100;
let _tradesPage = 0;
let _tradesHasMore = true;
let _tradesLoadingMore = false;
let _tradesRendered = TRADES_RENDER_STEP;

// Recent Activity stamps: "DD.MM HH:MM:SS" in the VIEWER's timezone. The API
// hands out naive ISO that is really UTC, so _itemTs normalises first and the
// browser does the offset. Column header says "Local" so nobody has to guess.
function fmtTradeTime(t) {
  const ts = _itemTs(t);
  if (!ts) return '--';
  const d = new Date(ts * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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

// Funnel next to an address: click to keep only that wallet, click again to
// release. The kind chips (All/Swaps/…) keep working on top of it.
function toggleTradesWallet(addr) {
  const a = (addr || '').toLowerCase();
  _tradesWallet = (_tradesWallet === a) ? null : a;
  _tradesRendered = TRADES_RENDER_STEP;
  _renderTradesWalletChip();
  _renderTradesFiltered();
  _applyTradeMarkers();
}

function clearTradesWallet() {
  _tradesWallet = null;
  _tradesRendered = TRADES_RENDER_STEP;
  const inp = document.getElementById('tradesWalletInput');
  if (inp) { inp.value = ''; inp.classList.remove('invalid', 'active'); }
  _renderTradesWalletChip();
  _renderTradesFiltered();
  _applyTradeMarkers();
}

// The header input and the per-row funnel drive the same filter, so whichever
// one the user touched, the other has to show the current state.
function _renderTradesWalletChip() {
  const inp = document.getElementById('tradesWalletInput');
  if (!inp) return;
  const clr = document.getElementById('tradesWalletClear');
  if (clr) clr.style.display = ((inp.value || '').trim() || _tradesWallet) ? '' : 'none';
  inp.classList.toggle('active', !!_tradesWallet);
  inp.classList.remove('invalid');
  const typed = (inp.value || '').trim().toLowerCase();
  if (_tradesWallet && typed !== _tradesWallet) inp.value = _tradesWallet;
  if (!_tradesWallet && typed && !/^0x[0-9a-f]{40}$/.test(typed)) inp.classList.add('invalid');
  if (!_tradesWallet && !typed) inp.value = '';
}

// Typing in the header: a complete address arms the filter, anything else
// releases it (and is flagged red so a typo does not look like "no trades").
function onTradesWalletInput(raw) {
  const v = (raw || '').trim().toLowerCase();
  const next = /^0x[0-9a-f]{40}$/.test(v) ? v : null;
  if (next === _tradesWallet) { _renderTradesWalletChip(); return; }
  _tradesWallet = next;
  _tradesRendered = TRADES_RENDER_STEP;
  _renderTradesWalletChip();
  _renderTradesFiltered();
  _applyTradeMarkers();
}

function setTradesFilter(f) {
  _currentTradesFilter = f;
  _tradesRendered = TRADES_RENDER_STEP;
  document.querySelectorAll('.trades-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === f);
  });
  _renderTradesFiltered();
}

function _tradesPasses(it) {
  if (_tradesWallet && (it.who || '').toLowerCase() !== _tradesWallet) return false;
  if (_currentTradesFilter === 'all') return true;
  return it.kind === _currentTradesFilter;
}

function _renderTradesFiltered() {
  const tbody = document.getElementById('tradesTbody');
  if (!tbody) return;
  const all = _allRecentItems.filter(_tradesPasses);
  const filtered = all.slice(0, _tradesRendered);
  const more = document.getElementById('tradesMore');
  if (more) more.style.display = (all.length > filtered.length || _tradesHasMore) ? '' : 'none';
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:var(--text-dim);padding:12px">No matching activity</td></tr>';
    return;
  }
  tbody.innerHTML = filtered.map(it => {
    // A swap has a price; a liquidity event does not — its coins now live in
    // the In/Out columns, so the cell stays empty instead of repeating them.
    const priceCell = (it.price != null && typeof it.price === 'number')
      ? fmtPrice(it.price) : '--';
    // Link out to the transaction, last column, like DexScreener (Alexandr
    // crvecodev/1835). Explorer base follows the active chain.
    const txnCell = it.tx
      ? `<a class="trades-txn" href="${window.getExplorerTxUrl ? window.getExplorerTxUrl(it.tx) : 'https://etherscan.io/tx/' + it.tx}" target="_blank" rel="noopener noreferrer" title="${it.tx}" aria-label="Open transaction in explorer">` +
        `<svg class="icon icon--sm" aria-hidden="true"><use href="#icon-external-link"/></svg></a>`
      : '--';
    const who = it.who || '';
    const walletCell = who
      ? `<span class="trades-wallet">` +
        `<a href="${window.getExplorerAddressUrl ? window.getExplorerAddressUrl(who) : 'https://etherscan.io/address/' + who}" target="_blank" rel="noopener noreferrer" class="tx-link" title="${who}">${shortAddr(who)}</a>` +
        `<button class="trades-funnel${(_tradesWallet === who.toLowerCase()) ? ' active' : ''}" onclick="toggleTradesWallet('${who}')" title="Only this wallet">` +
        `<svg class="icon icon--sm"><use href="#icon-filter"/></svg></button>` +
        `</span>`
      : '--';
    return `<tr>
      <td>${fmtTradeTime(it.time)}</td>
      <td class="${it.typeClass}">${it.type}</td>
      <td>${priceCell}</td>
      <td>${_fmtSideCell(it.inSide)}</td>
      <td>${_fmtSideCell(it.outSide)}</td>
      <td>${fmt$(it.usd || 0)}</td>
      <td>${walletCell}</td>
      <td>${txnCell}</td>
    </tr>`;
  }).join('');
}

// One side of an event: [{v, s}, …] → "1.2K USDC + 340 DAI". Empty side (the
// LP leg of a deposit/withdraw, whose amount the API does not report) → '--'.
function _fmtSideCell(side) {
  if (!Array.isArray(side) || side.length === 0) return '--';
  return side.map(x => `${_fmtAmtSide(x.v)} <span class="trades-sym">${x.s}</span>`).join(' + ');
}

// Amounts here are what a user checks against their own transaction, so the
// decimals stay; only genuinely huge numbers get compacted.
function _fmtAmtSide(v) {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  // Dust swaps are real trades; rounding them to a flat "0" reads like a bug.
  if (n < 1e-6) return '<0.000001';
  const t = n.toFixed(n < 0.01 ? 6 : 4);
  return t.indexOf('.') >= 0 ? t.replace(/0+$/, '').replace(/\.$/, '') : t;
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

// Fetch ONE page of both sources and return the events as render-ready items.
// Sets _tradesHasMore: a short page from both sources means the feed is done.
async function _fetchTradesPage(pool, page) {
  const { main: mainToken, ref: refToken } = poolPriceTokens(pool, 0, 1);
  const tradesUrl = `${PRICES_BASE}/trades/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&per_page=${TRADES_PAGE_SIZE}&page=${page}`;
  const lpUrl = `${PRICES_BASE}/liquidity/${getChainKey()}/${pool.address}?per_page=${TRADES_PAGE_SIZE}&page=${page}`;

  const [tradesRes, lpRes] = await Promise.allSettled([
    fetchJSON(tradesUrl),
    fetchJSON(lpUrl),
  ]);

  const items = [];

  if (tradesRes.status === 'fulfilled') {
    for (const t of (tradesRes.value.data || [])) {
      const isBuy = t.bought_id === 0;
      const symOf = i => (pool.coins && pool.coins[i]) || '?';
      items.push({
        kind: 'swap',
        type: isBuy ? 'Buy' : 'Sell',
        typeClass: isBuy ? 'trade-buy' : 'trade-sell',
        time: t.time,
        ts: _itemTs(t.time),
        tx: t.transaction_hash,
        who: t.buyer || '',
        price: t.price,
        inSide: [{ v: t.tokens_sold, s: symOf(t.sold_id) }],
        outSide: [{ v: t.tokens_bought, s: symOf(t.bought_id) }],
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
      // Deposit: coins go in, LP comes out. Withdraw: the other way round. The
      // LP leg has no amount in the API response, so that side stays empty.
      const moved = movedAmts.map((v, i) => ({ v, s: movedSyms[i] }));
      items.push({
        kind: isAdd ? 'deposit' : 'withdraw',
        type: isAdd ? 'Deposit' : 'Withdraw',
        typeClass: isAdd ? 'trade-deposit' : 'trade-withdraw',
        time: e.time,
        ts: _itemTs(e.time),
        tx: e.transaction_hash,
        who: e.provider || '',
        price: null,
        inSide: isAdd ? moved : null,
        outSide: isAdd ? null : moved,
        usd,
      });
    }
  } // 404 / network error: silently skip — keep swaps visible.

  const gotTrades = tradesRes.status === 'fulfilled' ? (tradesRes.value.data || []).length : 0;
  const gotLp = lpRes.status === 'fulfilled' ? (lpRes.value.data || []).length : 0;
  _tradesHasMore = gotTrades >= TRADES_PAGE_SIZE || gotLp >= TRADES_PAGE_SIZE;
  return items;
}

async function loadTrades() {
  if (!selectedPool) return;
  const pool = selectedPool;
  if (pool.deprecated) return; // no trades backend for registry deprecated pools
  _tradesPage = 0;
  _tradesHasMore = true;
  _tradesLoadingMore = false;
  _tradesRendered = TRADES_RENDER_STEP;
  const items = await _fetchTradesPage(pool, 1);
  if (pool !== selectedPool) return;   // pool switched while we were fetching
  _tradesPage = 1;
  items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  _allRecentItems = items;
  _renderTradesWalletChip();
  _renderTradesFiltered();
  _applyTradeMarkers();
  _bindTradesScroll();
}

// Auto-refresh path. Rebuilding the tbody every 10s made the table blink and
// threw away both the scroll position and everything the user had lazily
// loaded — so touch the DOM only when page 1 actually brought something new.
async function refreshTradesHead() {
  if (!selectedPool || _tradesLoadingMore) return;
  const pool = selectedPool;
  if (pool.deprecated) return;
  const hadMore = _tradesHasMore;
  let fresh;
  try {
    fresh = await _fetchTradesPage(pool, 1);
  } catch (e) { return; }
  _tradesHasMore = hadMore;            // page 1 says nothing about the tail
  if (pool !== selectedPool) return;
  const key = it => `${it.tx}:${it.kind}:${it.ts}`;
  const seen = new Set(_allRecentItems.map(key));
  const added = fresh.filter(it => !seen.has(key(it)));
  if (added.length === 0) return;      // nothing new — leave the DOM alone
  _allRecentItems = added.concat(_allRecentItems);
  _allRecentItems.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  _tradesRendered += added.length;     // keep the same rows on screen
  const wrap = document.querySelector('#view-pools-center .trades-table-wrap');
  const top = wrap ? wrap.scrollTop : 0;
  _renderTradesFiltered();
  if (wrap) wrap.scrollTop = top;
  _applyTradeMarkers();
}
window.refreshTradesHead = refreshTradesHead;

// Next API page, appended and de-duplicated (a swap and an LP event can share a
// transaction hash, so the key carries the kind and the timestamp too).
async function _loadMoreTrades() {
  if (_tradesLoadingMore || !_tradesHasMore || !selectedPool) return;
  _tradesLoadingMore = true;
  const pool = selectedPool;
  try {
    const more = await _fetchTradesPage(pool, _tradesPage + 1);
    if (pool !== selectedPool) return;
    _tradesPage += 1;
    if (more.length) {
      const key = it => `${it.tx}:${it.kind}:${it.ts}`;
      const seen = new Set(_allRecentItems.map(key));
      for (const it of more) {
        const k = key(it);
        if (seen.has(k)) continue;
        seen.add(k);
        _allRecentItems.push(it);
      }
      _allRecentItems.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      // The user is already at the bottom asking for more — widen the window
      // too, otherwise the fetched page sits in the buffer invisible until the
      // next scroll gesture.
      _tradesRendered += TRADES_RENDER_STEP;
    }
    _renderTradesFiltered();
    _applyTradeMarkers();
  } catch (e) {
    console.warn('trades page:', e);
  } finally {
    _tradesLoadingMore = false;
  }
}

// Near the bottom: first show more of what we already hold, and only when that
// runs out go back to the API.
function _bindTradesScroll() {
  const wrap = document.querySelector('#view-pools-center .trades-table-wrap');
  if (!wrap || wrap.dataset.lazyBound) return;
  wrap.dataset.lazyBound = '1';
  wrap.addEventListener('scroll', () => {
    if (wrap.scrollTop + wrap.clientHeight < wrap.scrollHeight - 120) return;
    const total = _allRecentItems.filter(_tradesPasses).length;
    if (_tradesRendered < total) {
      _tradesRendered += TRADES_RENDER_STEP;
      _renderTradesFiltered();
    } else if (_tradesHasMore) {
      _loadMoreTrades();
    }
  }, { passive: true });
}

// Drag the bar above the header to split the column between chart and table.
const _TRADES_H_KEY = 'cdx_tradesHeight';
// First visit: 15% of the viewport (Alexandr crvecodev/1832).
const _TRADES_H_SHARE = 0.15;

function _tradesHeightTarget() {
  const stored = parseInt(localStorage.getItem(_TRADES_H_KEY) || '', 10);
  if (isFinite(stored) && stored > 0) return stored;
  return Math.round(window.innerHeight * _TRADES_H_SHARE);
}

// `room` is 0 until the column is laid out, and the clamp in _setTradesHeight
// would then pin the table to its 96px floor — that is the height "resetting
// to something tiny" (Alexandr crvecodev/1832). Wait for a real layout.
function _applyStoredTradesHeight(retry) {
  const sec = document.querySelector('#view-pools-center .trades-section');
  if (!sec) return;
  const center = document.getElementById('view-pools-center');
  const room = center ? center.clientHeight : 0;
  if (room < 320) {
    if ((retry || 0) < 40) requestAnimationFrame(() => _applyStoredTradesHeight((retry || 0) + 1));
    return;
  }
  _setTradesHeight(sec, _tradesHeightTarget());
}

function _setTradesHeight(sec, px) {
  const center = document.getElementById('view-pools-center');
  const room = center ? center.clientHeight : window.innerHeight;
  // leave the chart something to draw in, and the table at least its header
  const h = Math.max(96, Math.min(px, room - 220));
  sec.style.flex = '0 0 auto';
  sec.style.height = h + 'px';
  return h;
}

function _initTradesResizer() {
  const bar = document.getElementById('tradesResizer');
  const sec = document.querySelector('#view-pools-center .trades-section');
  if (!bar || !sec || bar.dataset.bound) return;
  bar.dataset.bound = '1';
  _applyStoredTradesHeight();
  let startY = 0, startH = 0;
  const onMove = ev => {
    const h = _setTradesHeight(sec, startH - (ev.clientY - startY));
    localStorage.setItem(_TRADES_H_KEY, String(h));
  };
  const onUp = ev => {
    bar.classList.remove('dragging');
    bar.releasePointerCapture(ev.pointerId);
    bar.removeEventListener('pointermove', onMove);
    bar.removeEventListener('pointerup', onUp);
  };
  bar.addEventListener('pointerdown', ev => {
    startY = ev.clientY;
    startH = sec.getBoundingClientRect().height;
    bar.classList.add('dragging');
    bar.setPointerCapture(ev.pointerId);
    bar.addEventListener('pointermove', onMove);
    bar.addEventListener('pointerup', onUp);
    ev.preventDefault();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', _initTradesResizer);
  if (document.readyState !== 'loading') _initTradesResizer();
  // Re-clamp to the new room on resize; the stored value itself is untouched,
  // so shrinking the window and growing it back restores the chosen height.
  window.addEventListener('resize', () => _applyStoredTradesHeight());
  window.addEventListener('hashchange', () => _applyStoredTradesHeight());
}

// Round dots above the candle the event fell into. Only drawn while a wallet
// is picked — marking every trade of a busy pool would paint over the chart.
const _MARKER_STYLE = {
  swap_Buy:  { color: '#22c55e', text: 'B' },
  swap_Sell: { color: '#ef4444', text: 'S' },
  deposit:   { color: '#38bdf8', text: '+' },
  withdraw:  { color: '#f97316', text: '−' },
};

function _applyTradeMarkers() {
  if (typeof candleSeries === 'undefined' || !candleSeries) return;
  if (!_tradesWallet) { try { candleSeries.setMarkers([]); } catch (e) {} return; }
  const candles = window._poolCanonCandles;
  if (!Array.isArray(candles) || candles.length === 0) return;
  // Candle times are the only legal marker positions; snap each event down to
  // the bucket it belongs to and collapse duplicates within one bucket.
  const times = candles.map(c => c.time);
  const snap = ts => {
    let lo = 0, hi = times.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (times[mid] <= ts) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best >= 0 ? times[best] : null;
  };
  const seen = new Set();
  const markers = [];
  for (const it of _allRecentItems) {
    if ((it.who || '').toLowerCase() !== _tradesWallet) continue;
    const t = snap(it.ts || 0);
    if (t == null) continue;
    const style = _MARKER_STYLE[it.kind === 'swap' ? 'swap_' + it.type : it.kind];
    if (!style) continue;
    const key = t + ':' + style.text;
    if (seen.has(key)) continue;
    seen.add(key);
    markers.push({ time: t, position: 'aboveBar', shape: 'circle',
                   color: style.color, text: style.text });
  }
  markers.sort((a, b) => a.time - b.time);
  try { candleSeries.setMarkers(markers); } catch (e) { console.warn('markers:', e); }
}

window.setTradesFilter = setTradesFilter;
window.toggleTradesWallet = toggleTradesWallet;
window.clearTradesWallet = clearTradesWallet;


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
  // New token pair (main/ref swapped) -> reset ↔️ direction to canonical.
  if (typeof poolPriceInverted !== 'undefined') { poolPriceInverted = false; if (typeof _syncPoolPriceInvertBtn === 'function') _syncPoolPriceInvertBtn(); }
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
      <div><div class="token-name">${coin}</div><div class="token-addr"><a href="${window.getExplorerTokenUrl ? window.getExplorerTokenUrl(selectedPool.coinsAddresses[i]) : 'https://etherscan.io/token/' + selectedPool.coinsAddresses[i]}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="${selectedPool.coinsAddresses[i]}">${shortAddr(selectedPool.coinsAddresses[i])}</a></div></div>
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
  // New token pair selected -> reset ↔️ direction to canonical.
  if (typeof poolPriceInverted !== 'undefined') { poolPriceInverted = false; if (typeof _syncPoolPriceInvertBtn === 'function') _syncPoolPriceInvertBtn(); }
  // Reload chart for new token pair
  loadOHLC();
}

document.getElementById('tokenModal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('tokenModal')) closeTokenModal();
});

// Автообновление котировки, пока панель открыта и сумма введена. Без него
// число на экране живёт сколько угодно долго и расходится с пулом — клиент
// видит «ошибочный курс», а min_dy считается от устаревшей цифры.
let _quoteAutoTimer = null;
function _startQuoteAutoRefresh() {
  if (_quoteAutoTimer) return;
  _quoteAutoTimer = setInterval(() => {
    if (document.hidden) return;
    if (!selectedPool || !selectedFromToken || !selectedToToken) return;
    const el = document.getElementById('fromAmount');
    if (!el || !el.value || parseFloat(el.value) <= 0) return;
    if (el === document.activeElement) return;   // пока печатает — не мешаем
    getQuote();
  }, 12000);
}

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
    let _workingIface = _primaryIface;
    try {
      result = await rpcCall(_primaryIface.encodeFunctionData('get_dy', [iFrom, iTo, dx]), selectedPool.address);
      _abiCache.set(_poolKey, _abi);
    } catch (e1) {
      result = await rpcCall(_fallbackIface.encodeFunctionData('get_dy', [iFrom, iTo, dx]), selectedPool.address);
      _abiCache.set(_poolKey, _fallbackKey);
      _workingIface = _fallbackIface;
    }
    const dy = BigInt(result);
    // Точный выход котировки. В поле toAmount он уходит округлённым до 6 знаков,
    // а минимум обязан считаться от НЕокруглённого: для токена с малой ценой
    // единицы округление 1e-6 больше самого запаса, и min_dy выходит недостижимым.
    _lastPoolQuote = {
      dx: dx.toString(), dy: dy.toString(),
      from: selectedFromToken.address, to: selectedToToken.address,
      pool: selectedPool.address,
    };
    const dyFormatted = ethers.formatUnits(dy, selectedToToken.decimals);
    document.getElementById('toAmount').value = parseFloat(dyFormatted).toFixed(6);
    _startQuoteAutoRefresh();
    document.getElementById('swapDetails').style.display = '';
    const rate = parseFloat(dyFormatted) / parseFloat(fromAmt);
    document.getElementById('swapRate').textContent = `1 ${selectedFromToken.symbol} = ${rate.toFixed(6)} ${selectedToToken.symbol}`;
    // Минимум к получению — с тем же полом запаса, что применится при подписи
    // (handleSwapSubmit). Один лишний get_dy по самому глубокому пулу пары.
    try {
      const minEl = document.getElementById('swapMinOut');
      if (minEl) {
        const userSlip = (typeof slippage === 'number' && isFinite(slippage)) ? slippage : 0.5;
        let slipEff = userSlip;
        const _r = (typeof getSwapRouter === 'function') ? getSwapRouter() : null;
        if (_r && typeof _r.requiredHeadroomPct === 'function') {
          slipEff = await _r.requiredHeadroomPct(
            selectedFromToken.address, selectedToToken.address, dx, dy, userSlip,
          );
        }
        const minWei = dy * BigInt(Math.floor((1 - slipEff / 100) * 1e6)) / 1000000n;
        const minFmt = parseFloat(ethers.formatUnits(minWei, selectedToToken.decimals));
        minEl.textContent = `${minFmt.toFixed(6)} ${selectedToToken.symbol} (slip ${slipEff.toFixed(2)}%)`;
        minEl.style.color = slipEff > userSlip + 1e-9 ? 'var(--red)' : '';
      }
    } catch { /* строка необязательная, котировку не роняем */ }
    // Price Impact = deviation of the executed rate from the pool's MARGINAL
    // (near-zero-size) rate. A fixed 1:1 baseline is wrong for pools whose fair
    // cross-rate isn't 1.0 — e.g. apyUSD carries a rate oracle making apyUSD ≈
    // 1.364 apxUSD, so (rate-1) would mis-report a bogus ~+36% "impact". Probing
    // get_dy at 1 unit yields the marginal rate (oracle/stored_rates already
    // baked in); impact then reflects pure slippage and stays ~0 here, matching
    // Curve. Signed: NEGATIVE = user got less (slippage), POSITIVE = premium.
    let impact = null;
    try {
      const dxUnit = ethers.parseUnits('1', selectedFromToken.decimals);
      const spotRes = await rpcCall(_workingIface.encodeFunctionData('get_dy', [iFrom, iTo, dxUnit]), selectedPool.address);
      const spotRate = parseFloat(ethers.formatUnits(BigInt(spotRes), selectedToToken.decimals));
      if (isFinite(spotRate) && spotRate > 0) impact = (rate / spotRate - 1) * 100;
    } catch (_) { impact = null; }
    const impactEl = document.getElementById('swapImpact');
    if (impact == null) {
      impactEl.textContent = '--';
      impactEl.style.color = '';
    } else if (Math.abs(impact) < 0.001) {
      impactEl.textContent = '<0.001%';
      impactEl.style.color = 'var(--green)';
    } else {
      const sign = impact > 0 ? '+' : '';
      impactEl.textContent = sign + impact.toFixed(3) + '%';
      impactEl.style.color = impact < 0 ? 'var(--red)' : 'var(--green)';
    }
    // Строка «Min. Received» удалена 18.08: она считала минимум по СЫРОМУ слиппаджу
    // пользователя, а в транзакцию уходит минимум с расширенным запасом (swapMinOut).
    // Две строки одного смысла с разными числами — то, на чём человек и обжигается.
    // Fee: what the pool itself charges on THIS pair. dynamic_fee(i,j) when the
    // pool has one (StableSwapNG scales it up off-peg), else fee(), else the API
    // value. Shown as percent plus what it costs on this trade (Alexandr
    // crvecodev/1738 — the row used to be a hardcoded dash).
    _renderSwapFee(selectedPool, iFrom, iTo, parseFloat(dyFormatted), selectedToToken);
    updateSwapButton();
  } catch (e) {
    console.error('Quote error:', e);
    document.getElementById('toAmount').value = 'Error';
    document.getElementById('swapDetails').style.display = 'none';
    updateSwapButton();
  }
}

// Sequence guard: the fee lookup is async, the user keeps typing.
let _swapFeeSeq = 0;

async function _renderSwapFee(pool, i, j, dyOut, toToken) {
  const el = document.getElementById('swapFee');
  if (!el || !pool || !toToken) return;
  const seq = ++_swapFeeSeq;
  el.textContent = '...';

  let pct = null;
  try {
    const d = await fetchPoolOnchainFeeOracle(pool, [[i, j]]);
    const dyn = d && d.dynFeePct ? d.dynFeePct[i + '-' + j] : null;
    pct = (dyn != null && isFinite(dyn)) ? dyn : (d && d.feePct != null ? d.feePct : null);
  } catch (e) { /* fall back to the API value below */ }
  if (seq !== _swapFeeSeq) return;
  if (pct == null) pct = _poolFeePct(pool);
  if (pct == null || !isFinite(pct)) { el.textContent = '--'; return; }

  // get_dy is already net of the fee, so the fee itself is dy * f / (1 - f).
  const f = pct / 100;
  const feeTokens = (isFinite(dyOut) && dyOut > 0 && f > 0 && f < 1) ? dyOut * f / (1 - f) : null;

  let usd = null;
  if (feeTokens != null && typeof _fetchUsdPrice === 'function') {
    try {
      const price = await _fetchUsdPrice(toToken.address);
      if (price > 0) usd = feeTokens * price;
    } catch (e) { /* percent alone is still worth showing */ }
  }
  if (seq !== _swapFeeSeq) return;

  const pctStr = (typeof _fmtPctTrim === 'function' ? _fmtPctTrim(pct) : null) || (pct.toFixed(4) + '%');
  const amtStr = feeTokens != null
    ? ` \u00b7 ${feeTokens < 1 ? feeTokens.toFixed(6) : feeTokens.toFixed(4)} ${toToken.symbol}`
    : '';
  const usdStr = usd != null
    ? ` (${typeof _fmtTokenUsd === 'function' ? _fmtTokenUsd(usd) : '$' + usd.toFixed(2)})`
    : '';
  el.textContent = pctStr + amtStr + usdStr;
  el.title = 'Pool fee for this pair' + (feeTokens != null ? ', taken out of what you receive' : '');
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

// Точный (неокруглённый) выход последней котировки панели пула — см. getQuote.
let _lastPoolQuote = null;

async function handleSwapSubmit() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !selectedFromToken || !selectedToToken || !signer) return;
  const fromAmt = document.getElementById('fromAmount').value;
  if (!fromAmt || parseFloat(fromAmt) <= 0) return;
  const dx = ethers.parseUnits(fromAmt, selectedFromToken.decimals);
  const shownAmt = document.getElementById('toAmount').value;
  if (!shownAmt || shownAmt === 'Error') return;
  const btn = document.getElementById('swapSubmit');

  // Котировка этой панели снимается ОДИН раз, на ввод суммы, и дальше не
  // обновляется: между вводом и нажатием пул успевает уехать, а min_dy
  // считается от цифры на экране — в маленьком пуле этого хватает, чтобы
  // получить revert «fewer coins than expected». Пере-котируем ПЕРЕД сборкой
  // транзакции и, если стало хуже, показываем новое число и ждём второго
  // нажатия — та же защита, что в ветке пары (handleTradePairSwap).
  btn.textContent = 'Fetching quote...';
  btn.className = 'swap-submit disabled';
  await getQuote();
  const toAmt = document.getElementById('toAmount').value;
  if (!toAmt || toAmt === 'Error') { updateSwapButton(); return; }
  if (parseFloat(toAmt) < parseFloat(shownAmt)) {
    btn.textContent = 'Quote changed — review & press again';
    setTimeout(() => updateSwapButton(), 4000);
    return;
  }
  // Выход берём ТОЧНЫЙ, из самой котировки, а не из поля на экране: там он
  // округлён до 6 знаков, и для токена с малой ценой единицы это округление
  // больше запаса — min_dy получается недостижимым на ровном месте.
  let outWei;
  try {
    outWei = (_lastPoolQuote
      && _lastPoolQuote.dx === dx.toString()
      && _lastPoolQuote.from === selectedFromToken.address
      && _lastPoolQuote.to === selectedToToken.address
      && _lastPoolQuote.pool === selectedPool.address)
      ? BigInt(_lastPoolQuote.dy)
      : ethers.parseUnits(toAmt, selectedToToken.decimals);
  } catch {
    outWei = ethers.parseUnits(toAmt, selectedToToken.decimals);
  }

  // Запас не может быть меньше премии ЭТОГО пула над самым глубоким пулом пары:
  // премия — ровно та часть, что исчезает от одной чужой сделки, и min_dy,
  // посчитанный от неё, недостижим (реверт 09.08). Опоры нет / ошибка → слипадж
  // пользователя как был.
  let slippageEff = slippage;
  try {
    const _r = (typeof getSwapRouter === 'function') ? getSwapRouter() : null;
    if (_r && typeof _r.requiredHeadroomPct === 'function') {
      slippageEff = await _r.requiredHeadroomPct(
        selectedFromToken.address, selectedToToken.address, dx, outWei, slippage,
      );
    }
  } catch { /* оставляем слипадж пользователя */ }
  // Целочисленно: float на 18 знаках теряет точность. Множитель — вниз.
  const minDy = outWei * BigInt(Math.floor((1 - slippageEff / 100) * 1e6)) / 1000000n;
  btn.textContent = 'Processing...';
  btn.className = 'swap-submit disabled';
  try {
    const isETH = selectedFromToken.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    // Michwill EIP-1559 gas strategy: maxPriorityFee = 0.05×base, maxFee = 2.05×base.
    const gasOv = await window.computeMichwillGasParams(signer.provider);
    if (!isETH) {
      const token = new ethers.Contract(selectedFromToken.address, ERC20_ABI, signer);
      const allowance = await token.allowance(walletAddress, selectedPool.address);
      // Разрешение ровно на сумму свопа, не на весь баланс (Ник 11.08).
      for (const amt of window.approveAmounts(allowance, dx)) {
        btn.textContent = 'Approving...';
        // Per Михаил hard rule (msg 7092 2026-05-24): estimateGas × 1.5 even on approve.
        const approveData = token.interface.encodeFunctionData('approve', [selectedPool.address, amt]);
        const approveRaw = { to: selectedFromToken.address, data: approveData, value: 0n };
        approveRaw.gasLimit = await window.estimateGasWithBuffer(signer.provider, approveRaw, walletAddress);
        const approveTx = await signer.sendTransaction({ ...approveRaw, ...gasOv });
        await approveTx.wait();
      }
    }
    btn.textContent = 'Swapping...';
    const isCrypto = ['crypto', 'factory-crypto', 'factory-twocrypto', 'factory-tricrypto'].includes(selectedPool.registryId);
    let tx;
    {
      const iface = isCrypto
        ? new ethers.Interface(['function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)'])
        : new ethers.Interface(['function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)']);
      const swapTx = {
        to: selectedPool.address,
        data: iface.encodeFunctionData('exchange', [selectedFromToken.index, selectedToToken.index, dx, minDy]),
        value: isETH ? dx : 0n,
      };
      // Per Михаил hard rule (msg 7092 2026-05-24): estimateGas × 1.5.
      swapTx.gasLimit = await window.estimateGasWithBuffer(signer.provider, swapTx, walletAddress);
      tx = await signer.sendTransaction({ ...swapTx, ...gasOv });
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
  const tokenMap = new Map(); // address -> {symbol, address, decimals, pools: Set, volume24h: number}
  for (const pool of allPools) {
    if (!pool.coins || !pool.coinsAddresses) continue;
    const poolVol = (typeof pool.volumeUSD === 'number' && isFinite(pool.volumeUSD)) ? pool.volumeUSD : 0;
    for (let i = 0; i < pool.coins.length; i++) {
      const sym = pool.coins[i];
      const addr = (pool.coinsAddresses[i] || '').toLowerCase();
      if (!addr || !sym) continue;
      if (!tokenMap.has(addr)) {
        tokenMap.set(addr, { symbol: sym, address: addr, decimals: parseInt(pool.coinDecimals?.[i] || pool.decimals?.[i]) || 18, pools: new Set(), volume24h: 0 });
      }
      const t = tokenMap.get(addr);
      t.pools.add(pool.address.toLowerCase());
      t.volume24h += poolVol; // sum across all pools the token is in
    }
  }
  // Sort by 24h volume desc (sum across the token's pools), pool count as tiebreaker.
  tradeTokenList = [...tokenMap.values()].sort((a, b) => {
    if (b.volume24h !== a.volume24h) return b.volume24h - a.volume24h;
    return b.pools.size - a.pools.size;
  });
  // Add native gas-token as alias for its wrapped ERC20 (ETH↔WETH on Ethereum,
  // xDAI↔WXDAI on Gnosis, MATIC↔WMATIC on Polygon, AVAX↔WAVAX on Avalanche, etc).
  // Wrapped-native address + native symbol come from chains_config.json — required
  // for non-Ethereum chains where Curve treats wrapped tokens as the pool asset.
  const _wNativeAddr = (typeof getWrappedNativeAddr === 'function' ? getWrappedNativeAddr() : '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  const _nativeSym = (typeof getNativeSymbol === 'function' ? getNativeSymbol() : 'ETH');
  const wethEntry = tokenMap.get(_wNativeAddr);
  if (wethEntry && !tokenMap.has('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee')) {
    tradeTokenList.unshift({ symbol: _nativeSym, address: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', decimals: 18, pools: wethEntry.pools, _isNativeETH: true, _wethAddress: wethEntry.address });
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
  // Default: native gas-token (chain-aware: ETH on mainnet, xDAI on Gnosis, etc) -> stablecoin
  const ethToken = tradeTokenList.find(t => t._isNativeETH);
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
  // Add native gas-token alias (chain-aware: ETH on Ethereum, xDAI on Gnosis,
  // MATIC on Polygon, AVAX on Avalanche, etc). Wrapped-native address from chains_config.
  const wethAddr = (typeof getWrappedNativeAddr === 'function' ? getWrappedNativeAddr() : '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  const _nativeSym2 = (typeof getNativeSymbol === 'function' ? getNativeSymbol() : 'ETH');
  const wethData = tokenAgg.get(wethAddr);
  const ethAddr = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  if (wethData && !tokenAgg.has(ethAddr)) {
    tokenAgg.set(ethAddr, {
      symbol: _nativeSym2,
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

// Chart-route liquidity floor (crvecodev/1362): pools below this are price
// noise for charting purposes — a $1.97 pool drew a fake spike. Used by
// findBestPool, the BFS adjacency graph and generateTokenPairs. The swap
// router is unaffected (it quotes dy on-chain, any pool).
const MIN_CHART_POOL_TVL = 10000;

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
  // Below the floor return null so BFS builds a synthetic route through
  // liquid pools (with exact vault rates for vault hops) instead of charting
  // a micro-pool's noise (the $1.97 Pennyweight case, crvecodev/1362).
  return (best && bestTvl >= MIN_CHART_POOL_TVL) ? best : null;
}

// Monotonic counter for race-condition guard: a quick token switch can fire
// two updateTradeRoute() in flight; only the latest probe gets to commit.
let _tradeRouteProbeSeq = 0;

// Render `tradeBestPool` into the route text + bookkeeping. Pure DOM/state,
// no async — usable for both the legacy fallback and the router result.
function _renderTradeBestPoolText() {
  const routeEl = document.getElementById('tradeRoute');
  if (!routeEl) return;
  if (Array.isArray(tradeBestPool)) {
    const names = tradeBestPool.map(p => p.name).join(' → ');
    routeEl.innerHTML = `Best route: <span>${names}</span> (multi-hop)`;
  } else if (tradeBestPool) {
    const tvl = tradeBestPool.tvl >= 1e6 ? `$${(tradeBestPool.tvl / 1e6).toFixed(1)}M` : `$${(tradeBestPool.tvl / 1e3).toFixed(0)}K`;
    routeEl.innerHTML = `Best route: <span>${tradeBestPool.name}</span> (TVL: ${tvl})`;
  } else {
    routeEl.innerHTML = 'Best route: <span>No direct pool found</span>';
  }
  updateTradeExecButton();
  updateTradeEstimate();
}

function updateTradeRoute() {
  const fromAddr = document.getElementById('tradeFromToken').value;
  const toAddr = document.getElementById('tradeToToken').value;
  const routeEl = document.getElementById('tradeRoute');

  if (!fromAddr || !toAddr || fromAddr === toAddr) {
    routeEl.innerHTML = 'Best route: <span>Select different tokens</span>';
    tradeBestPool = null;
    updateTradeExecButton();
    updateTradeEstimate();
    return;
  }

  // STEP 1 — immediate legacy fallback render so the UI never blanks while
  // the router probe is in flight. The legacy result is replaced below if
  // the router picks a different (better) path.
  const legacyBest = findBestPool(fromAddr, toAddr);
  if (legacyBest) {
    tradeBestPool = legacyBest;
  } else {
    const multiRoute = findMultiHopRoute(fromAddr, toAddr);
    tradeBestPool = multiRoute || null;
  }
  _renderTradeBestPoolText();

  // STEP 2 — async router probe with a small unit amount. Probe='1' matches
  // the pair-view _probeRouterRouteForChart convention: enough to discover
  // routing without materially impacting dy quotes. We then overwrite
  // tradeBestPool with the router-picked pool list so the simple-view
  // preview matches the actual swap result (e.g. Strategic USD Reserves
  // for USDT/USDC, not the higher-TVL 3pool).
  const seq = ++_tradeRouteProbeSeq;
  (async () => {
    try { await loadEthers(); } catch { return; }
    const router = getTradeRouter();
    if (!router) return;
    // Resolve decimals for probe — use same _findTokenMeta lookup as
    // executeTradeSwap so the dy-based probe is correctly scaled.
    const _findTokenMeta = (addr) => {
      const lc = (addr || '').toLowerCase();
      const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      if (lc === ETH) return { address: ETH, symbol: 'ETH', decimals: 18 };
      for (const pool of allPools) {
        if (!pool.coinsAddresses) continue;
        const idx = pool.coinsAddresses.findIndex(a => a.toLowerCase() === lc);
        if (idx !== -1) {
          return {
            address: addr,
            symbol: (pool.coins && pool.coins[idx]) || '?',
            decimals: (pool.decimals && pool.decimals[idx]) || (pool.coinDecimals && pool.coinDecimals[idx]) || 18,
          };
        }
      }
      return { address: addr, symbol: '?', decimals: 18 };
    };
    const fromMeta = _findTokenMeta(fromAddr);
    const toMeta = _findTokenMeta(toAddr);
    let quote;
    try {
      quote = await router.getQuote(
        fromAddr, toAddr,
        '1', // probe — small enough to discover routing, not materially affect dy
        fromMeta.decimals, toMeta.decimals,
        0.5, null
      );
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // Probe failure → keep legacy fallback already rendered.
      return;
    }
    // Race guard — newer probe in flight, or tokens changed.
    if (seq !== _tradeRouteProbeSeq) return;
    const curFrom = document.getElementById('tradeFromToken').value;
    const curTo = document.getElementById('tradeToToken').value;
    if (curFrom !== fromAddr || curTo !== toAddr) return;
    if (!quote || !quote.route || quote.route.length < 1) return;
    if (quote.route.length === 1) {
      const pool = allPools.find(p => p.address.toLowerCase() === (quote.route[0].pool || '').toLowerCase());
      if (!pool) return;
      tradeBestPool = pool;
    } else {
      const pools = [];
      for (const leg of quote.route) {
        const p = allPools.find(pp => pp.address.toLowerCase() === (leg.pool || '').toLowerCase());
        if (!p) return; // can't resolve — keep legacy render
        pools.push(p);
      }
      tradeBestPool = pools;
    }
    _renderTradeBestPoolText();
  })();
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
    // Same floor as findBestPool: a depth-1 BFS "shortest path" through a
    // micro-pool otherwise beats the liquid multi-hop route (crvecodev/1362).
    if (!pool.coinsAddresses || (pool.tvl || pool.usdTotal || 0) < MIN_CHART_POOL_TVL) continue;
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
    // This legacy path always quotes at submit (the panel shows an estimate,
    // not a bound quote) — surface the real output before signing, and refuse
    // to sign on an incomplete strategy comparison (RPC degradation).
    if (Array.isArray(quote._degradedSources) && quote._degradedSources.length) {
      console.warn('[trade] quote degraded (' + quote._degradedSources.join(', ') + ') — submit stopped');
      btn.textContent = 'RPC degraded — try again';
      btn.className = 'swap-submit disabled';
      setTimeout(() => updateTradeExecButton(), 4000);
      return;
    }
    try {
      const toAmtEl = document.getElementById('tradeToAmount');
      if (toAmtEl && isFinite(parseFloat(quote.outputAmount))) toAmtEl.value = parseFloat(quote.outputAmount).toFixed(6);
    } catch { /* display sync is best-effort */ }

    btn.textContent = 'Approving...';
    await router.ensureApproval(quote, walletAddress, signer);

    btn.textContent = 'Swapping...';
    const txParams = await router.buildSwapTx(quote, walletAddress);
    // The built tx names the contract that will actually pull the token; top
    // the allowance up if it is not the one we pre-approved.
    await router.ensureApprovalForTx(txParams, quote, walletAddress, signer);
    // Michwill EIP-1559 gas strategy.
    const gasOv = await window.computeMichwillGasParams(browserProvider);
    // Per Михаил hard rule (msg 7092 2026-05-24): estimateGas × 1.5 (no hardcoded gas).
    const sendTx = {
      to: txParams.to,
      data: txParams.data,
      value: txParams.value || 0n,
    };
    sendTx.gasLimit = await window.estimateGasWithBuffer(browserProvider, sendTx, walletAddress);
    const tx = await signer.sendTransaction({ ...sendTx, ...gasOv });

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
// ↔️ pair-price direction toggle (pools tab). false = canonical "1 base = X quote".
// When true, ALL pair-ratio displays flip (rate line, headline price/change, candles,
// crosshair). USD-absolute displays must NOT flip — see _renderTradePairHeader.
let tradePairInverted = false;
// Pools-tab (legacy candleSeries / chartPrice header) direction toggle. Independent
// of tradePairInverted (different surface, different DOM). Reset to canonical on
// every pool switch and token-pair swap; NOT reset by the 30s OHLC auto-refresh.
let poolPriceInverted = false;
let tradePairSearchQuery = '';

let _tokenPairsPoolCount = 0; // guard: skip rebuild if pool data unchanged

function generateTokenPairs() {
  // Skip rebuild if pool data hasn't changed
  if (tokenPairs.length > 0 && allPools.length === _tokenPairsPoolCount) return;
  _tokenPairsPoolCount = allPools.length;
  const pairMap = new Map(); // "BASE/QUOTE" -> best pair data
  // ЭТО НЕ КЛАССИФИКАЦИЯ СТЕЙБЛОВ, а список привычных ЗНАМЕНАТЕЛЕЙ пары: он
  // решает, какой токен встанет справа в имени (WETH/USDC, а не USDC/WETH).
  // Расширять его «до полного списка стейблов» нельзя — тогда у пары из двух
  // стейблов знаменатель начнёт выбираться другой веткой и имена пар поедут.
  // Настоящий вопрос «стейбл ли символ» задаётся _isStableSym.
  const quotePreferred = new Set(['USDC', 'USDT', 'DAI', 'crvUSD', 'FRAX', 'LUSD', 'TUSD', 'sUSD', 'USDD', 'GHO', 'PYUSD', 'USD0', 'eUSD', 'mkUSD', 'USDe']);
  const wethAliases = new Set(['ETH', 'WETH', 'stETH', 'wstETH', 'cbETH', 'rETH', 'frxETH', 'sfrxETH', 'weETH', 'ezETH']);

  for (const pool of allPools) {
    if (!pool.coins || pool.coins.length < 2 || !pool.coinsAddresses) continue;
    const tvl = pool.tvl || 0;
    if (tvl < MIN_CHART_POOL_TVL) continue; // Skip tiny pools

    // Generate pairs from pool coins
    for (let i = 0; i < pool.coins.length; i++) {
      for (let j = i + 1; j < pool.coins.length; j++) {
        let baseSym = pool.coins[i];
        let quoteSym = pool.coins[j];
        let baseAddr = (pool.coinsAddresses[i] || '').toLowerCase();
        let quoteAddr = (pool.coinsAddresses[j] || '').toLowerCase();

        // Normalize: quote should be the "denominator" (stablecoins, then WETH, etc.)
        const iIsStable = quotePreferred.has(baseSym);
        const jIsStable = quotePreferred.has(quoteSym);
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
  // New pair always starts in canonical direction; re-sync the ↔️ button visual.
  tradePairInverted = false;
  try { _syncTradePairInvertBtn(); } catch {}
  if (typeof toggleMobileSidebar === 'function') toggleMobileSidebar(true);

  // Sync tradeSelectedFrom/To for swap button and token modal
  const fromDec = pair.pool?.coinDecimals?.[pair.pool.coinsAddresses?.findIndex(a => a.toLowerCase() === pair.baseAddr)] || pair.pool?.decimals?.[0] || 18;
  const toDec = pair.pool?.coinDecimals?.[pair.pool.coinsAddresses?.findIndex(a => a.toLowerCase() === pair.quoteAddr)] || pair.pool?.decimals?.[1] || 18;
  tradeSelectedFrom = { symbol: pair.base, address: pair.baseAddr, decimals: fromDec };
  tradeSelectedTo = { symbol: pair.quote, address: pair.quoteAddr, decimals: toDec };
  updateTradeTokenUI('from', tradeSelectedFrom);
  updateTradeTokenUI('to', tradeSelectedTo);
  // Smart slippage default: stable↔stable pairs auto-select 0.1% unless overridden.
  if (typeof window._applySmartSlippageForPair === 'function') {
    window._applySmartSlippageForPair(pair.base, pair.quote);
  }

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

    // Update route info — placeholder until _probeRouterRouteForChart picks
    // the real router-selected pool. Initial pair.pool reflects TVL-best from
    // BFS, which may not be the actual swap pool (Strategic USD Reserves can
    // beat 3pool at small/medium USDT↔USDC sizes despite lower TVL). Probe
    // fills this text below; if probe fails, falls back to pair.pool name.
    const routeEl = document.getElementById('tradePairRouteInfo');
    if (routeEl) {
      const poolLabel = _shortPoolName(pair.pool.name) || pair.poolAddr.slice(0, 12);
      routeEl.textContent = `via ${poolLabel}`;
      routeEl.dataset.isFallback = 'true'; // mark as TVL-fallback; probe will clear
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
      horzLine: { color: '#f0b90b33', width: 1, style: 0, labelBackgroundColor: '#f0b90b', labelVisible: false },
    },
    rightPriceScale: { borderColor: '#2b3139', scaleMargins: { top: 0.1, bottom: 0.25 }, minimumWidth: _isMobile ? 48 : 70 },
    localization: _CHART_LOCALIZATION,
    timeScale: { borderColor: '#2b3139', timeVisible: true, secondsVisible: false, tickMarkFormatter: _chartLocalTick },
    handleScroll: { vertTouchDrag: true },
  });

  tradePairCandleSeries = _guardSeries(tradePairChart.addCandlestickSeries({
    upColor: '#0ecb81', downColor: '#f6465d',
    borderUpColor: '#0ecb81', borderDownColor: '#f6465d',
    wickUpColor: '#0ecb81', wickDownColor: '#f6465d',
  }), 'candle');
  // Разметка пользователя (трендовые линии и уровни) — своим примитивом.
  try {
    if (window.ChartDraw) {
      const _k = (selectedPair && selectedPair.base && selectedPair.quote)
        ? (getChainKey() + ':' + selectedPair.base + '/' + selectedPair.quote) : 'default';
      window.ChartDraw.bind(tradePairChart, tradePairCandleSeries, container, _k);
    }
  } catch (e) { console.warn('draw bind', e); }

  // Capture candles for rich header (24h H/L, abs change, USD price line)
  try {
    const _origSetData = tradePairCandleSeries.setData.bind(tradePairCandleSeries);
    tradePairCandleSeries.setData = function(data) {
      // САНИТАЙЗЕР. Ручка отдаёт свечи с null в пустых корзинах; библиотека на
      // такой точке кидает «Value is null» (стек 17.08: Oi.Candlestick -> Ws) и
      // ВЕСЬ график остаётся пустым. Одна воронка на все ветки — прямую,
      // синтетику, прокси, перерисовку. Битые точки выбрасываем, а не чиним:
      // додуманная свеча — это враньё на графике.
      if (Array.isArray(data)) {
        const ok = d => d && Number.isFinite(d.time) && Number.isFinite(d.open) && Number.isFinite(d.high)
          && Number.isFinite(d.low) && Number.isFinite(d.close) && d.close > 0;
        const clean = data.filter(ok);
        if (clean.length !== data.length) {
          console.warn('[chart] выброшено битых свечей:', data.length - clean.length);
          data = clean;
        }
      }
      // Single inversion point: when the ↔️ toggle is on, flip every candle once
      // here. The chart, the crosshair (reads series data) and the rich header
      // (reads window._tradeRichLastCandles) then all see inverted values for free.
      // Stash the CANONICAL candles separately so the toggle can re-feed them
      // without double-inverting (this wrapper always inverts the input fresh).
      if (Array.isArray(data) && data.length > 0 && data[0] && data[0].open != null) {
        window._tradePairCanonCandles = data;
      }
      const view = _tpMaybeInvertCandles(data);
      try {
        if (Array.isArray(view) && view.length > 0 && view[0].open != null) {
          window._tradeRichLastCandles = view;
          try { if (typeof updateTradeRichHeader === 'function') updateTradeRichHeader(); } catch {}
        }
      } catch {}
      return _origSetData(view);
    };
  } catch {}

  tradePairVolumeSeries = _guardSeries(tradePairChart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: '',
    lastValueVisible: false,
    priceLineVisible: false,
  }), 'hist');
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
    // Axis crosshair %-pill (madeath_aa msg 1177): % of the price under the cursor
    // vs current price, on the right scale like Binance. First in handler so it
    // also hides on mouse-leave (param.point undefined).
    (function(){
      const _c = document.getElementById('trade-pair-chart-container');
      let _p = document.getElementById('tpAxisPct');
      if (!_p && _c) { _p = document.createElement('div'); _p.id = 'tpAxisPct'; _p.className = 'chart-axis-pct'; _c.appendChild(_p); }
      if (_p) {
        const _lc = window._tradePairLastClose;
        let _py = null;
        try { _py = (tradePairCandleSeries && param.point && param.point.y != null) ? tradePairCandleSeries.coordinateToPrice(param.point.y) : null; } catch (e) { _py = null; }
        if (_py != null && _lc) {
          const _pct = (_py - _lc) / _lc * 100;
          _p.textContent = (typeof fmtPrice === 'function' ? fmtPrice(_py) : _py.toFixed(4)) + '  ' + (_pct >= 0 ? '+' : '') + _pct.toFixed(2) + '%';
          _p.style.top = param.point.y + 'px';
          _p.style.background = _pct >= 0 ? '#0ecb81' : '#f6465d';
          _p.style.display = 'block';
        } else { _p.style.display = 'none'; }
      }
    })();
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

// Самый глубокий пул, где ЕСТЬ ОБА токена хопа — источник свечей для
// синтетического графика. Нулевые адреса-заполнители в metapool'ах НЕ считаем
// совпадением: иначе 3pool (DAI/USDC/USDT) выглядит как пул WETH/USDC и график
// нарисует чужую цену. Нативный ETH приравниваем к WETH — это один актив.
// Кандидаты-источники свечей для пары: все пулы, где есть ОБА токена,
// от самого глубокого к мелкому. Нулевые адреса-заполнители metapool'ов не
// считаются совпадением (иначе 3pool выглядит как пул WETH/USDC), нативный ETH
// приравнен к WETH — это один актив.
function _chartPoolCandidates(fromTok, toTok) {
  if (!Array.isArray(allPools) || !fromTok || !toTok) return [];
  const ZERO = '0x0000000000000000000000000000000000000000';
  const norm = a => {
    const l = String(a || '').toLowerCase();
    return l === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : l;
  };
  const f = norm(fromTok), t = norm(toTok);
  const out = [];
  for (const p of allPools) {
    const raw = p && p.coinsAddresses;
    if (!Array.isArray(raw)) continue;
    const addrs = raw.filter(a => String(a || '').toLowerCase() !== ZERO).map(norm);
    if (addrs.includes(f) && addrs.includes(t)) out.push(p);
  }
  return out.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
}

// Адреса для запроса свечей: main = чем меряем (quote), ref = что оцениваем (base).
function _hopApiAddrs(pool, fromTok, toTok) {
  const ZERO = '0x0000000000000000000000000000000000000000';
  const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
  const norm = a => {
    const l = String(a || '').toLowerCase();
    return l === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' ? WETH : l;
  };
  const raw = pool && pool.coinsAddresses;
  if (!Array.isArray(raw)) return null;
  const normed = raw.map(a => (String(a || '').toLowerCase() === ZERO ? WETH : norm(a)));
  const mi = normed.indexOf(norm(toTok));
  const ri = normed.indexOf(norm(fromTok));
  if (mi < 0 || ri < 0) return null;
  const fix = a => (String(a || '').toLowerCase() === ZERO ? WETH : a);
  return { main: fix(raw[mi]), ref: fix(raw[ri]) };
}

const _usdPxCache = new Map();
async function _tokenUsdPrice(addr) {
  const k = String(addr || '').toLowerCase();
  if (!k) return null;
  const c = _usdPxCache.get(k);
  if (c && Date.now() - c.ts < 300000) return c.v;
  try {
    const j = await fetchJSON(PRICES_BASE + '/usd_price/' + getChainKey() + '/' + addr);
    const v = (j && j.data && typeof j.data.usd_price === 'number') ? j.data.usd_price : null;
    _usdPxCache.set(k, { v, ts: Date.now() });
    return v;
  } catch (e) { return null; }
}

async function _poolLastHourClose(pool, mainAddr, refAddr) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - 3 * 86400;
  try {
    const u = PRICES_BASE + '/ohlc/' + getChainKey() + '/' + pool.address
      + '?main_token=' + mainAddr + '&reference_token=' + refAddr
      + '&agg_number=1&agg_units=hour&start=' + start + '&end=' + end;
    const j = await fetchJSON(u);
    const d = ((j && j.data) || []).slice().sort((a, b) => a.time - b.time);
    return d.length ? d[d.length - 1].close : null;
  } catch (e) { return null; }
}

// ИСТОЧНИК СВЕЧЕЙ ДЛЯ ПАРЫ. Не «самый глубокий пул»: у пулов YieldBasis цена
// внутренняя, с плечом, и самый глубокий из них врёт (замер 16.08, WETH/crvUSD,
// один и тот же час: YB WETH $44M -> 1938.92, Yield Basis WETH $29M -> 1914.05,
// TriCRV $2.3M -> 1880.51 при внешней цене токенов 1882.69). Поэтому из трёх
// самых глубоких берём тот, чья цена БЛИЖЕ ВСЕГО к внешней цене токенов.
// Внешней цены нет — остаёмся на самом глубоком. Списков адресов нет.
async function _pickChartPoolUncached(fromTok, toTok) {
  const cands = _chartPoolCandidates(fromTok, toTok);
  if (!cands.length) return null;
  const [ua, ub] = await Promise.all([_tokenUsdPrice(fromTok), _tokenUsdPrice(toTok)]);
  const spot = (ua > 0 && ub > 0) ? ua / ub : null;
  if (!spot) return cands[0];
  // Сначала ОТСЕИВАЕМ по согласию с внешней ценой, и только среди прошедших
  // берём самый глубокий. Брать абсолютный минимум отклонения нельзя: 16.08
  // пул на $23K обошёл пул на $3.9M разницей 0.02% против 0.04% — на графике
  // это тонкий источник с дырами, а выигрыш в точности нулевой.
  const TOL = 0.005;
  // Провал ПРОБЫ (429, пустой ответ) — не приговор пулу: иначе временный отказ
  // у глубокого пула молча продвигает мелкий. 16.08 так и вышло: проба
  // TricryptoUSDC не ответила, и хоп WETH→USDC уехал на hot_potato с историей
  // в две недели. Дисквалифицирует только ИЗМЕРЕННОЕ расхождение цены.
  // Пробы идут ПАРАЛЛЕЛЬНО: последовательные три круга добавляли по секунде на
  // каждый хоп, а на синтетике хопов два и вызов повторяется на каждое
  // переключение таймфрейма (замер 17.08: 32 запроса против 14, время до свечей
  // 36.8 с против 21.6 с).
  const probes = await Promise.all(cands.slice(0, 3).map(async p => {
    const a = _hopApiAddrs(p, fromTok, toTok);
    if (!a) return { p: p, close: null, skip: true };
    return { p: p, close: await _poolLastHourClose(p, a.main, a.ref) };
  }));
  let unproven = null, fallback = null, fallbackDev = Infinity;
  for (const pr of probes) {
    if (pr.skip) continue;
    if (!(pr.close > 0)) { if (!unproven) unproven = pr.p; continue; }
    const dev = Math.abs(pr.close / spot - 1);
    if (dev <= TOL) return pr.p; // probes в порядке cands (по TVL) — первый подходящий и есть самый глубокий
    if (dev < fallbackDev) { fallbackDev = dev; fallback = pr.p; }
  }
  return unproven || fallback || cands[0];
}

// Выбор источника не меняется от переключения таймфрейма — держим его 5 минут
// на пару, иначе каждый клик по 1H/4H/1D/1W заново гоняет пробы.
const _chartPoolPick = new Map();
// Путь графика по токенам, зафиксированный на пару (см. врезку в синтетике).
const _synPathCache = new Map();
async function _pickChartPool(fromTok, toTok) {
  // Ключ ТОЛЬКО в нижнем регистре: _bfsTokens приходят в checksum-виде, а путь
  // объёма — в нижнем, и на одну и ту же ногу заводились два разных ключа. Кэш
  // промахивался, пробы шли заново и на 17.08 давали РАЗНЫЕ пулы одной ноги в
  // соседних рендерах (WETH/SDT: 22096 на 1H и 23121 на 4H — свеча 2.85 против
  // 3.02 на одном экране).
  const f = String(fromTok || '').toLowerCase();
  const t = String(toTok || '').toLowerCase();
  const key = getChainKey() + ':' + f + ':' + t;
  const c = _chartPoolPick.get(key);
  if (c && Date.now() - c.ts < 300000) return c.pool;
  const pool = await _pickChartPoolUncached(f, t);
  _chartPoolPick.set(key, { pool: pool, ts: Date.now() });
  return pool;
}

// ГЕЙТ НА «ПРИМЕРНЫЙ» ГРАФИК. Прокси-пул рисуется, когда пары нет одним пулом и
// синтетика не собралась; сверки цены у него не было НИКОГДА, поэтому он
// показывал что угодно. 17.08 Ник прислал скрин CRV/SDT (цена 2.85) с графиком
// crvUSD/WETH около 1900. Чужая цена хуже пустого графика.
async function _proxyPriceLooksRight(candles) {
  if (!candles || !candles.length || !selectedPair) return false;
  const last = candles[candles.length - 1].close;
  if (!(last > 0)) return false;
  const px = await Promise.all([
    _tokenUsdPrice(selectedPair.baseAddr),
    _tokenUsdPrice(selectedPair.quoteAddr),
  ]);
  if (!(px[0] > 0) || !(px[1] > 0)) return false; // не с чем сверить — не рисуем
  return Math.abs(last / (px[0] / px[1]) - 1) <= 0.10;
}

function _deepestPoolForHop(fromTok, toTok) {
  if (!Array.isArray(allPools) || !fromTok || !toTok) return null;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const norm = a => {
    const l = String(a || '').toLowerCase();
    return l === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
      ? '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' : l;
  };
  let best = null, bestTvl = -1;
  for (const p of allPools) {
    const raw = p && p.coinsAddresses;
    if (!Array.isArray(raw)) continue;
    const addrs = raw.filter(a => String(a || '').toLowerCase() !== ZERO).map(norm);
    if (!addrs.includes(fromTok) || !addrs.includes(toTok)) continue;
    const tvl = (typeof p.tvl === 'number' && isFinite(p.tvl)) ? p.tvl : 0;
    if (tvl > bestTvl) { bestTvl = tvl; best = p; }
  }
  return best;
}

// Helper: load OHLC from a pool using its first two coins (proxy/fallback chart)
async function _loadProxyPoolOHLC(pool) {
  if (!pool || !pool.coinsAddresses || pool.coinsAddresses.length < 2) return null;
  const timeRanges = { 1: 7*24, 4: 30*24 };
  const dayRanges = { 1: 250*24, 7: 365*24 };
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
    })).filter(_okCandle).filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });
  } catch (e) {
    if (e && e.name === 'AbortError') return null; // silent — by-design fetch cancel on pair switch
    console.warn('Proxy pool OHLC error:', e);
    return null;
  }
}

// ERC-4626 vault↔underlying hop detector + exact redemption rate.
// Returns the from→to rate (float) when one token is a vault over the other
// (probed on-chain via asset(), no token list), else null. Both verdicts are
// cached: rates 5 min, "not a vault pair" 1 h — probes are two eth_calls.
const _tpVaultRateCache = new Map(); // 'from|to' -> { rate: number|null, ts }
async function _tpVaultHopRate(from, to) {
  if (!from || !to || typeof rpcCall !== 'function') return null;
  const f = from.toLowerCase(), t = to.toLowerCase();
  const key = f + '|' + t;
  const hit = _tpVaultRateCache.get(key);
  if (hit && Date.now() - hit.ts < (hit.rate != null ? 300000 : 3600000)) return hit.rate;

  const SEL_ASSET = '0x38d52e0f';            // asset()
  const SEL_TO_ASSETS = '0x07a2d13a';        // convertToAssets(uint256)
  const SEL_TO_SHARES = '0xc6e6f592';        // convertToShares(uint256)
  const addrFromRet = r => (r && r.length >= 66) ? ('0x' + r.slice(26, 66)).toLowerCase() : null;
  const decimalsOf = (addr) => {
    for (const p of allPools) {
      const idx = (p.coinsAddresses || []).findIndex(a => a.toLowerCase() === addr);
      if (idx >= 0 && p.decimals && p.decimals[idx] != null) return Number(p.decimals[idx]) || 18;
    }
    return 18;
  };
  const probeAsset = async (addr) => {
    try { return addrFromRet(await rpcCall(SEL_ASSET, addr)); } catch { return null; }
  };

  let rate = null;
  try {
    const w = (x) => x.toString(16).padStart(64, '0');
    const fDec = decimalsOf(f), tDec = decimalsOf(t);
    if ((await probeAsset(t)) === f) {
      // to = vault over from → deposit direction: shares per 1 underlying
      const res = await rpcCall(SEL_TO_SHARES + w(10n ** BigInt(fDec)), t);
      const shares = BigInt(res);
      if (shares > 0n) rate = Number(shares) / Number(10n ** BigInt(tDec));
    } else if ((await probeAsset(f)) === t) {
      // from = vault over to → redeem direction: assets per 1 share
      const res = await rpcCall(SEL_TO_ASSETS + w(10n ** BigInt(fDec)), f);
      const assets = BigInt(res);
      if (assets > 0n) rate = Number(assets) / Number(10n ** BigInt(tDec));
    }
  } catch { rate = null; }
  _tpVaultRateCache.set(key, { rate, ts: Date.now() });
  return rate;
}

async function loadTradePairOHLC() {
  if (!selectedPair || !selectedPair.pool) return;
  // ключ разметки следует за парой
  try {
    const _c = document.getElementById('trade-pair-chart-container');
    if (_c && _c._cdxDraw) _c._cdxDraw.rebind(tradePairChart, tradePairCandleSeries,
      getChainKey() + ':' + selectedPair.base + '/' + selectedPair.quote);
  } catch (e) {}
  // Show loading indicator on chart container while OHLC fetch is in-flight.
  // Hidden in finally. Avoids "black canvas" UX during prices.curve.finance 502s.
  const _ohlcLoadingCleanup = (() => {
    try {
      const container = document.getElementById('trade-pair-chart-container');
      if (!container) return () => {};
      let el = container.querySelector('.chart-loading');
      if (!el) {
        el = document.createElement('div');
        el.className = 'chart-loading';
        el.textContent = 'Loading chart…';
        container.appendChild(el);
      } else {
        el.style.display = '';
      }
      return () => { try { if (el && el.parentNode) el.parentNode.removeChild(el); } catch {} };
    } catch { return () => {}; }
  })();
  try {
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
  // Пара целиком лежит в одном пуле -> рисуем из него, цепочку не строим:
  // произведение ног режет историю по самой молодой ноге и добавляет свой шум
  // (16.08: WBTC/USDC давал 13 недельных свечей вместо 53 у TricryptoUSDC).
  const _directChartPool = await _pickChartPool(selectedPair.baseAddr, selectedPair.quoteAddr);
  // Multi-hop: synthetic OHLC from N hops (2 or 3)
  if (selectedPair._multiRoute && !_directChartPool) {
    const route = selectedPair._multiRoute;
    // Use BFS token chain if available, otherwise discover intermediates
    let tokens;
    let midFailed = false;
    // ПУТЬ ГРАФИКА НЕ СЛЕДУЕТ ЗА МАРШРУТОМ СДЕЛКИ. Роутер отваливается по своему
    // таймауту (10 с) и на следующем рендере отдаёт ДРУГОЙ путь: 17.08 CRV/USDC
    // грузилась как CRV→crvUSD→USDC, а после клика по таймфрейму становилась
    // CRV→WETH→USDC — вместе с путём прыгал и объём (до нуля). Первый удавшийся
    // путь держим 5 минут на пару.
    const _pathKey = getChainKey() + ':' + selectedPair.baseAddr + ':' + selectedPair.quoteAddr;
    const _pathHit = _synPathCache.get(_pathKey);
    if (_pathHit && Date.now() - _pathHit.ts < 300000
        && Array.isArray(_pathHit.tokens) && _pathHit.tokens.length === route.length + 1) {
      tokens = _pathHit.tokens;
    } else if (route._bfsTokens && route._bfsTokens.length === route.length + 1) {
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
      const dayRanges = { 1: 250*24, 7: 365*24 };
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
      // Vault↔underlying hops (e.g. crvUSD↔scrvUSD) have no liquid pool and no
      // OHLC candles — the only "pools" pairing them are dust, so the merge
      // below would find zero overlapping timestamps, kill the whole synthetic
      // and fall back to a PROXY chart of a different pair (madeath msg 994:
      // sdYB/scrvUSD rendered YB/crvUSD, +25% off). Price such hops at the
      // vault's exact on-chain redemption rate instead.
      const hopFlat = await Promise.all(
        route.map((_, i) => _tpVaultHopRate(tokens[i], tokens[i + 1]).catch(() => null))
      );
      const urls = [];
      let urlBuildFailed = false;
      for (let i = 0; i < route.length; i++) {
        if (hopFlat[i] != null) { urls.push(null); continue; } // flat vault-rate hop, no OHLC fetch
        // Свечи берём НЕ обязательно из пула сделки: роутер выбирает пул по
        // лучшей цене прямо сейчас, и им может оказаться двухнедельный пул на
        // $35K — тогда синтетика схлопывается до пересечения ног и история
        // исчезает (Ник 16.08: CRV/USDC, 1W, две свечи; нога weth/usdc
        // hot_potato отдавала 2 свечи против 53 у TriCRV). Цена пары одна и та
        // же в любом её пуле, поэтому для КАРТИНКИ берём самый глубокий пул
        // этой пары. Маршрут сделки не трогаем.
        const _chartPool = (await _pickChartPool(tokens[i], tokens[i + 1])) || route[i];
        const rawAddrs = _chartPool.coinsAddresses;
        const normAddrs = rawAddrs.map(_ohlcNorm);
        const fromTok = tokens[i];
        const toTok = tokens[i + 1];
        // API: price = ref/main. To get fromTok priced in toTok: main=toTok, ref=fromTok
        const mainIdx = normAddrs.indexOf(toTok);
        const refIdx = normAddrs.indexOf(fromTok);
        if (mainIdx < 0 || refIdx < 0) {
          console.warn('Synthetic OHLC: token not in pool coins', _chartPool.name, fromTok, toTok);
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
        urls.push(`${PRICES_BASE}/ohlc/${getChainKey()}/${_chartPool.address}?main_token=${mainAddr}&reference_token=${refAddr}&agg_number=${tradePairAgg}&agg_units=${tradePairUnit}&start=${start}&end=${end}`);
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
            const prev = _synCached.length >= 2 ? _synCached[_synCached.length - 2] : first;
            applyTradePairDirection(last, prev, first);
            loadTradePairVolume();
            return;
          }
        }
        try {
          // Use fetchJSON (has 30s built-in cache) instead of raw fetch.
          // Flat vault-rate hops (urls[i] === null) skip the fetch entirely.
          const jsons = await Promise.all(urls.map(u => (u ? fetchJSON(u) : Promise.resolve(null))));
          const roundTime = tradePairUnit === 'day' ? (t => Math.floor(t / 86400) * 86400) : (t => t);

          // Build time->candle maps for each hop (null map = flat vault hop)
          const maps = jsons.map(json => {
            if (!json) return null;
            const m = new Map();
            for (const d of (json.data || [])) {
              const t = roundTime(d.time);
              if (!m.has(t)) m.set(t, d);
            }
            return m;
          });

          // Merge: synthetic price = product of all hops. Timestamps come from
          // the first REAL (candle-backed) hop; flat hops contribute their
          // constant redemption rate at every timestamp.
          const firstRealMap = maps.find(m => m != null);
          const candles = [];
          const seen = new Set();
          for (const t of (firstRealMap ? firstRealMap.keys() : [])) {
            if (seen.has(t)) continue;
            seen.add(t);
            // All candle-backed hops must have data for this timestamp
            const cs = maps.map((m, k) => (m ? m.get(t) : { open: hopFlat[k], high: hopFlat[k], low: hopFlat[k], close: hopFlat[k] }));
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
            // Путь сработал — фиксируем его и для графика, и для объёма.
            _synPathCache.set(_pathKey, { tokens: tokens, ts: Date.now() });
            selectedPair._chartTokens = tokens;
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
              const prev = candles.length >= 2 ? candles[candles.length - 2] : first;
              applyTradePairDirection(last, prev, first);
              const detailsEl = document.getElementById('tradePairSwapDetails');
              if (detailsEl) detailsEl.style.display = '';
            }
            loadTradePairVolume();
            return; // synthetic succeeded
          }
          // candles empty — fall through to proxy chart
          console.warn('Synthetic OHLC: no overlapping candles across hops');
        } catch (e) {
          if (e && e.name === 'AbortError') return; // silent — by-design fetch cancel on pair switch
          console.error('Synthetic OHLC error:', e);
        }
      }
    }

    // Synthetic failed — fallback: show proxy chart from the highest-TVL pool in the route
    const proxyPool = [...route].sort((a, b) => (b.tvl || 0) - (a.tvl || 0))[0];
    if (proxyPool && proxyPool.coinsAddresses && proxyPool.coinsAddresses.length >= 2) {
      const proxyCandles = await _loadProxyPoolOHLC(proxyPool);
      if (proxyCandles && proxyCandles.length > 0 && tradePairCandleSeries && await _proxyPriceLooksRight(proxyCandles)) {
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
        const prev = proxyCandles.length >= 2 ? proxyCandles[proxyCandles.length - 2] : first;
        applyTradePairDirection(last, prev, first);
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
  const pool = _directChartPool || selectedPair.pool;
  // API semantics: price = reference_token / main_token
  // To show "cbBTC priced in crvUSD" (~68000), we need main=crvUSD, ref=cbBTC
  // So: main_token = QUOTE token, reference_token = BASE token
  // Адреса монет ищем С НОРМАЛИЗАЦИЕЙ: у пула может стоять нативный ETH
  // (0xeee…) там, где пара просит WETH, и голое сравнение строк роняло график
  // в запасной proxy-режим (16.08: stETH/WETH ушла на «proxy from ETH/stETH»).
  const _apiAddrs = _hopApiAddrs(pool, selectedPair.baseAddr, selectedPair.quoteAddr);
  const coinAddrs = pool.coinsAddresses.map(a => a.toLowerCase());
  const baseIdx = _apiAddrs ? 0 : coinAddrs.indexOf(selectedPair.baseAddr);
  const quoteIdx = _apiAddrs ? 0 : coinAddrs.indexOf(selectedPair.quoteAddr);
  if (!_apiAddrs && (baseIdx < 0 || quoteIdx < 0)) {
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
    if (proxyCandles && proxyCandles.length > 0 && tradePairCandleSeries && await _proxyPriceLooksRight(proxyCandles)) {
      tradePairCandleSeries.setData(proxyCandles);
      _adaptCandlePrecision(tradePairCandleSeries, proxyCandles, tradePairChart);
      tradePairLastCandles = proxyCandles.map(c => c.time);
      const srcLabel = document.getElementById('chartSourceLabel');
      if (srcLabel) srcLabel.textContent = 'Chart: proxy from ' + _shortPoolName(pool.name || pool.address.slice(0, 12));
      const last = proxyCandles[proxyCandles.length - 1];
      const first = proxyCandles[0];
      const prev = proxyCandles.length >= 2 ? proxyCandles[proxyCandles.length - 2] : first;
      applyTradePairDirection(last, prev, first);
      loadTradePairVolume();
    } else if (!tradePairCandleSeries) {
      // Only stomp the chart container if the canvas wasn't even created
      // (prevents clobbering a later router-probe re-render).
      const chartContainer = document.getElementById('trade-pair-chart-container');
      if (chartContainer) chartContainer.innerHTML = '<div class="loading-center">No chart data for ' + selectedPair.base + '/' + selectedPair.quote + '</div>';
    }
    return;
  }

  const mainToken = _apiAddrs ? _apiAddrs.main : pool.coinsAddresses[quoteIdx]; // quote = denominator in API
  const refToken = _apiAddrs ? _apiAddrs.ref : pool.coinsAddresses[baseIdx];   // base = what we price

  const timeRanges = { 1: 7*24, 4: 30*24 };
  const dayRanges = { 1: 250*24, 7: 365*24 };
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
    })).filter(_okCandle).filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; });

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
      const prev = candles.length >= 2 ? candles[candles.length - 2] : first;
      applyTradePairDirection(last, prev, first);
      const detailsEl = document.getElementById('tradePairSwapDetails');
      if (detailsEl) detailsEl.style.display = '';
    }
  } catch (e) {
    if (e && e.name === 'AbortError') {
      // silent — by-design fetch cancel on pair switch; skip volume too (next pair will load it)
      return;
    }
    console.error('Trade pair OHLC error:', e);
  }

  // Load volume
  loadTradePairVolume();
  } finally {
    try { _ohlcLoadingCleanup(); } catch {}
  }
}

async function loadTradePairVolume() {
  if (!selectedPair || !selectedPair.pool) return;
  const pool = selectedPair.pool;

  // Recreate histogram series to avoid stale scale state
  if (tradePairVolumeSeries && tradePairChart) {
    try { tradePairChart.removeSeries(tradePairVolumeSeries); } catch(e) {}
    tradePairVolumeSeries = _guardSeries(tradePairChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      lastValueVisible: false,
      priceLineVisible: false,
    }), 'hist');
    tradePairVolumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
      visible: false,
      autoScale: true,
    });
  }

  const coinAddrs = pool.coinsAddresses.map(a => a.toLowerCase());
  const baseIdx = coinAddrs.indexOf(selectedPair.baseAddr);
  const quoteIdx = coinAddrs.indexOf(selectedPair.quoteAddr);

  const baseAddrLC = (selectedPair.baseAddr || '').toLowerCase();
  const quoteAddrLC = (selectedPair.quoteAddr || '').toLowerCase();
  const chainIdNow = (typeof activeChainId === 'number') ? activeChainId : 1;
  const _setLastVol = (v) => {
    const el = document.getElementById('tradeChartVol');
    if (!el) return;
    el.textContent = v >= 1e6 ? '$'+(v/1e6).toFixed(1)+'M'
                  : v >= 1e3 ? '$'+(v/1e3).toFixed(1)+'K'
                  : '$'+v.toFixed(0);
  };

  // === MULTI-HOP: hop-by-hop volume aggregation via _multiRoute ===
  // For synthetic pairs (tBTC/USDT, msUSD/USDT, RLUSD/USDT etc.) the trade route
  // is 2+ pools and no single pool contains {base, quote}. _trade24hVolumes uses
  // MIN(volUsd) as bottleneck — same logic applied day-by-day to the snapshot.
  // If any hop is missing from snapshot, we render empty (honest — partial
  // aggregation would mis-represent actual route throughput).
  const isMultiHop = Array.isArray(selectedPair._multiRoute)
                  && selectedPair._multiRoute.length >= 2;
  if (isMultiHop) {
    // ЧАСОВОЙ ОБЪЁМ СОСТАВНОЙ ПАРЫ. Суточный снапшот ниже даёт бары только на 1D/1W:
    // на часовом окне последних дней его записей ещё нет, и на 1H/4H гистограмма
    // выходила пустой (жалоба Ника 17.08; на версии до правок графиков — так же).
    // Ручка /volume отдаёт ЧАСОВЫЕ корзины и отстаёт на полчаса (замер 17.08:
    // шаг 3600 с, последняя запись 0.48 ч назад). Считаем по каждому хопу и берём
    // МИНИМУМ по корзине — то же бутылочное горлышко, что и в суточном пути.
    {
      try {
        // ЧАСЫ и ДНИ из одной ручки: без interval она отдаёт ЧАСОВЫЕ корзины и
        // упирается в 300 записей (12.5 дня), с interval=day — ДНЕВНЫЕ, те же
        // 300 записей = 299 дней (замер 17.08). Дневной снапшот коллектора стоит
        // с 12.06 (крон не пережил переезд), поэтому для 1D/1W он пуст на всём,
        // что появилось позже, — живая ручка это закрывает.
        const _volIntervalDay = (tradePairUnit === 'day');
        const hopRoute = selectedPair._multiRoute;
        const bfsTok = (Array.isArray(selectedPair._chartTokens) && selectedPair._chartTokens.length === hopRoute.length + 1)
          ? selectedPair._chartTokens
          : (Array.isArray(hopRoute._bfsTokens) ? hopRoute._bfsTokens : null);
        const candleTs = tradePairLastCandles || [];
        if (candleTs.length > 1) {
          const endH = Math.floor(Date.now() / 1000);
          const startH = Math.max(candleTs[0] - 86400, endH - (_volIntervalDay ? 299 : 12) * 86400);
          const perHop = await Promise.all(hopRoute.map(async (hop, i) => {
            let mainT = null, refT = null;
            if (bfsTok && bfsTok.length === hopRoute.length + 1) { mainT = bfsTok[i]; refT = bfsTok[i + 1]; }
            else if (hop && Array.isArray(hop.coinsAddresses)) { mainT = hop.coinsAddresses[0]; refT = hop.coinsAddresses[1]; }
            if (!hop || !hop.address || !mainT || !refT) return null;
            // Пул объёма = пул свечей этого хопа: маршрут сделки перескакивает
            // между рендерами (роутер отваливается по таймауту 10 с и выбирает
            // другой путь), и объём вместе с ним обнулялся. Выбор кэширован.
            const volPool = (await _pickChartPool(String(mainT).toLowerCase(), String(refT).toLowerCase())) || hop;
            // Адреса — РОВНО как в пуле: в ETH/stETH лежит нативный ETH, а путь
            // приходит уже нормализованным в WETH, и ручка объёма на такой запрос
            // отдавала пусто (17.08, USDC/stETH: ноль столбиков на 1H и 4H).
            const volAddrs = _hopApiAddrs(volPool, String(refT).toLowerCase(), String(mainT).toLowerCase()); // main = raw(mainT)
            const volMain = volAddrs ? volAddrs.main : mainT;
            const volRef = volAddrs ? volAddrs.ref : refT;
            // ПОРЯДОК ТОКЕНОВ В РУЧКЕ НЕ СИММЕТРИЧЕН. Замер 17.08 на TricryptoUSDC
            // за 30 дней: main=USDC ref=WETH -> $19.3M, обратный порядок -> $10K.
            // Направление пары задаёт человек (открыл WETH/USDC или USDC/WETH),
            // и «неудачная» сторона рисовала почти пустую гистограмму. Спрашиваем
            // ОБА порядка и берём тот, где объём больше.
            const _volFetch = async (mm, rr, asDay) => {
              const wantDay = asDay || _volIntervalDay;
              const st = wantDay ? Math.max(candleTs[0] - 86400, endH - 299 * 86400) : startH;
              try {
                const j = await fetchJSON(PRICES_BASE + '/volume/' + getChainKey() + '/' + volPool.address
                  + '?main_token=' + mm + '&reference_token=' + rr
                  + '&start=' + st + '&end=' + endH
                  + (wantDay ? '&interval=day' : ''));
                const m = new Map();
                let sum = 0;
                for (const d of ((j && j.data) || [])) {
                  const ts = Number(d && d.timestamp) || 0;
                  const v = Number(d && d.volume) || 0;
                  if (ts) { m.set(ts, v); sum += v; }
                }
                return m.size ? { m: m, sum: sum } : null;
              } catch (e) { return null; }
            };
            const both = await Promise.all([_volFetch(volMain, volRef), _volFetch(volRef, volMain)]);
            const best = both.filter(Boolean).sort((x, y) => y.sum - x.sum)[0];
            if (!best) return null;
            // Часовой ответ покрывает лишь ~12.5 суток. Если окно графика длиннее,
            // добираем ранний хвост суточными корзинами (interval=day).
            if (!_volIntervalDay && candleTs.length) {
              const covered = Math.min(...best.m.keys());
              if (covered - 3600 > candleTs[0]) {
                const day = await _volFetch(volMain, volRef, true);
                const dayAlt = day && day.sum > 0 ? day : await _volFetch(volRef, volMain, true);
                const dm = dayAlt && dayAlt.sum > 0 ? dayAlt.m : null;
                // Суточное значение РАЗМАЗЫВАЕМ по свечам этого дня, иначе на 4H
                // каждый ранний день давал один столбик из шести (замер 18.08:
                // 92 столбика на 181 свечу).
                if (dm) {
                  for (const e of dm) {
                    const dayStart = e[0], v = e[1];
                    if (dayStart >= covered || !(v > 0)) continue;
                    const inDay = candleTs.filter(t => t >= dayStart && t < dayStart + 86400);
                    if (!inDay.length) { best.m.set(dayStart, v); continue; }
                    const per = v / inDay.length;
                    for (const t of inDay) best.m.set(t, per);
                  }
                }
              }
            }
            return best.m;
          }));
          if (perHop.length && perHop.every(m => m)) {
            const bucketOf = ts => {
              let b = candleTs[0];
              for (let i = candleTs.length - 1; i >= 0; i--) { if (candleTs[i] <= ts) { b = candleTs[i]; break; } }
              return b;
            };
            const sums = perHop.map(m => {
              const o = new Map();
              for (const e of m) { const b = bucketOf(e[0]); o.set(b, (o.get(b) || 0) + e[1]); }
              return o;
            });
            const volData = [];
            for (const b of candleTs) {
              let mn = Infinity;
              for (const o of sums) { const v = o.get(b) || 0; if (v < mn) mn = v; }
              if (mn > 0 && isFinite(mn)) volData.push({ time: b, value: mn, color: 'rgba(14,203,129,0.5)' });
            }
            if (tradePairVolumeSeries && volData.length > 0) {
              const lastRaw = volData[volData.length - 1].value;
              tradePairVolumeSeries.setData(_sqrtNormalizeVol(volData.slice()));
              _setLastVol(lastRaw);
              return;
            }
          }
        }
      } catch (e) { /* нет часовых — идём в суточный путь ниже */ }
    }
    try {
      const route = selectedPair._multiRoute;
      const snap = await _ensureLongHistoryVol();
      const snapPools = snap && snap.pools ? snap.pools : null;
      if (snapPools) {
        // Collect day-keyed volumes for each hop.
        const hopDayMaps = []; // Array<Map<ts, usd>>
        let allHopsCovered = true;
        // Те же пулы, что и у свечей: снапшот покрывает глубокие пулы, а
        // случайный пул из маршрута сделки в нём часто отсутствует — и весь
        // объём пары обнулялся (17.08, CRV/USDC на маршруте через WETH).
        const _volTok = (Array.isArray(selectedPair._chartTokens) && selectedPair._chartTokens.length === route.length + 1)
          ? selectedPair._chartTokens
          : (Array.isArray(route._bfsTokens) ? route._bfsTokens : null);
        const volRoute = await Promise.all(route.map(async (h, i) => {
          if (!_volTok || _volTok.length !== route.length + 1) return h;
          const p = await _pickChartPool(String(_volTok[i]).toLowerCase(), String(_volTok[i + 1]).toLowerCase());
          return p || h;
        }));
        for (const hop of volRoute) {
          const addr = String(hop && hop.address || '').toLowerCase();
          const entry = addr ? snapPools[addr] : null;
          if (!entry || !Array.isArray(entry.days)) { allHopsCovered = false; break; }
          if (entry.chain_id && entry.chain_id !== chainIdNow) { allHopsCovered = false; break; }
          const m = new Map();
          for (const d of entry.days) {
            if (!d.day) continue;
            const ts = Math.floor(Date.parse(d.day + 'T00:00:00Z') / 1000);
            if (!Number.isFinite(ts)) continue;
            const v = Number(d.vol_usd) || 0;
            if (v > 0) m.set(ts, v);
          }
          hopDayMaps.push(m);
        }
        if (allHopsCovered && hopDayMaps.length >= 2) {
          // Bottleneck per day: only days present in ALL hops count, value = MIN.
          // Use first hop as anchor (smallest set check is cheap regardless).
          const dayMap = new Map();
          const anchor = hopDayMaps[0];
          for (const [ts, v0] of anchor) {
            let minV = v0;
            let ok = true;
            for (let i = 1; i < hopDayMaps.length; i++) {
              const v = hopDayMaps[i].get(ts);
              if (!Number.isFinite(v) || v <= 0) { ok = false; break; }
              if (v < minV) minV = v;
            }
            if (ok && minV > 0) dayMap.set(ts, minV);
          }
          // Live overlay: top-TVL hop only — fetched in its own coin pair.
          // _bfsTokens=[from, mid1,...,to] gives us (main, ref) per hop position.
          try {
            const tokens = Array.isArray(route._bfsTokens) ? route._bfsTokens : null;
            let topHopIdx = 0;
            let topTvl = -1;
            for (let i = 0; i < volRoute.length; i++) {
              const t = Number(volRoute[i] && volRoute[i].tvl) || 0;
              if (t > topTvl) { topTvl = t; topHopIdx = i; }
            }
            const topHop = volRoute[topHopIdx];
            let mainT, refT;
            if (tokens && tokens.length === route.length + 1) {
              mainT = tokens[topHopIdx];
              refT = tokens[topHopIdx + 1];
            } else if (topHop && Array.isArray(topHop.coinsAddresses)) {
              mainT = topHop.coinsAddresses[0];
              refT = topHop.coinsAddresses[1];
            }
            const _addrLCH = topHop && topHop.address ? topHop.address.toLowerCase() : '';
            if (topHop && topHop.address && mainT && refT && !_curvePricesVolume404.has(_addrLCH)) {
              const hoursBack = 30 * 24;
              const startL = Math.floor(Date.now() / 1000) - hoursBack * 3600;
              const endL = Math.floor(Date.now() / 1000);
              const liveUrl = `${PRICES_BASE}/volume/${getChainKey()}/${topHop.address}?main_token=${mainT}&reference_token=${refT}&start=${startL}&end=${endL}`;
              const resp = await fetch(liveUrl);
              if (resp.status === 404 || resp.status === 405) {
                _curvePricesVolume404.add(_addrLCH);
              } else if (resp.ok) {
                const j = await resp.json();
                const liveDayMap = new Map();
                for (const d of (j.data || [])) {
                  const ts = typeof d.timestamp === 'number' ? d.timestamp : 0;
                  if (!ts) continue;
                  const dayTs = Math.floor(ts / 86400) * 86400;
                  liveDayMap.set(dayTs, (liveDayMap.get(dayTs) || 0) + (Number(d.volume) || 0));
                }
                // Overlay only days the snapshot already has (bottleneck context);
                // live value REPLACES snapshot anchor since it's fresher,
                // but we still gate by min across other hops via hopDayMaps lookup.
                for (const [ts, liveV] of liveDayMap) {
                  if (liveV <= 0) continue;
                  // Recompute MIN with live value as anchor for that day.
                  let minV = liveV;
                  let ok = true;
                  for (let i = 0; i < hopDayMaps.length; i++) {
                    if (i === topHopIdx) continue;
                    const v = hopDayMaps[i].get(ts);
                    if (!Number.isFinite(v) || v <= 0) { ok = false; break; }
                    if (v < minV) minV = v;
                  }
                  if (ok && minV > 0) dayMap.set(ts, minV);
                }
              }
            }
          } catch { /* live overlay non-fatal */ }

          // Sub-daily distribution (mirrors primary path).
          const candleTs = tradePairLastCandles || [];
          const filtered = Array.from(dayMap.entries())
            .filter(([_, v]) => v > 0)
            .sort((a, b) => a[0] - b[0]);

          let volData;
          if (tradePairUnit === 'day' && tradePairAgg >= 7) {
            const weekMap = {};
            filtered.forEach(([ts, v]) => {
              let bucket = candleTs.length > 0 ? candleTs[0] : ts;
              for (let i = candleTs.length - 1; i >= 0; i--) {
                if (candleTs[i] <= ts) { bucket = candleTs[i]; break; }
              }
              if (!weekMap[bucket]) weekMap[bucket] = 0;
              weekMap[bucket] += v;
            });
            volData = Object.entries(weekMap)
              .map(([time, value]) => ({ time: parseInt(time), value, color: 'rgba(14,203,129,0.5)' }))
              .sort((a, b) => a.time - b.time);
          } else if (tradePairUnit === 'day' || candleTs.length === 0) {
            volData = filtered
              .map(([ts, v]) => ({ time: ts, value: v, color: 'rgba(14,203,129,0.5)' }));
            if (candleTs.length > 0) {
              const firstC = candleTs[0];
              const lastC = candleTs[candleTs.length - 1];
              volData = volData.filter(d => d.time >= firstC && d.time <= lastC + 7 * 86400);
            }
          } else {
            const dayVol = new Map();
            filtered.forEach(([ts, v]) => dayVol.set(ts, v));
            const volumeMap = {};
            const candlesByDay = {};
            candleTs.forEach(ts => {
              const dayTs = Math.floor(ts / 86400) * 86400;
              if (!candlesByDay[dayTs]) candlesByDay[dayTs] = [];
              candlesByDay[dayTs].push(ts);
            });
            for (const [dTs, cs] of Object.entries(candlesByDay)) {
              const dv = dayVol.get(parseInt(dTs)) || 0;
              if (dv <= 0) continue;
              const per = dv / cs.length;
              cs.forEach(ts => { volumeMap[ts] = per; });
            }
            volData = Object.entries(volumeMap)
              .map(([time, value]) => ({ time: parseInt(time), value, color: 'rgba(14,203,129,0.5)' }))
              .sort((a, b) => a.time - b.time);
          }

          if (tradePairVolumeSeries && volData && volData.length > 0) {
            const lastRaw = volData[volData.length - 1].value;
            const normalized = _sqrtNormalizeVol(volData.slice());
            tradePairVolumeSeries.setData(normalized);
            _setLastVol(lastRaw);
            return;
          }
        }
        // If snapshot doesn't cover all hops (or no overlapping days),
        // fall through: empty bars are honest for multi-hop without coverage.
        return;
      }
    } catch (e) { console.warn('[trade-pair] multi-hop aggregation failed:', e); /* fall through to direct guard */ }
  }

  // Direct-pair path requires both base+quote in the active pool.
  if (baseIdx < 0 || quoteIdx < 0) return;

  const mainToken = pool.coinsAddresses[baseIdx];
  const refToken = pool.coinsAddresses[quoteIdx];

  // === PRIMARY: pair-level aggregation from server-side snapshot ===
  // Pair volume = SUM(volume) across ALL pools in active chain whose coin set
  // contains {base, quote}. Single-pool (e.g. 3pool for USDT/USDC) systematically
  // undercounts (~2-3× on Top pairs per 2026-05 measurement). We also overlay
  // short-window live `/volume` for the highest-TVL pool so today's bar updates
  // intra-day before snapshot rerun. Full live-aggregation across all pair-pools
  // would be N parallel fetches — expensive, deferred for now.
  try {
    if (typeof allPools !== 'undefined' && Array.isArray(allPools) && allPools.length > 0) {
      const pairPools = allPools.filter(p => {
        if (!p || !Array.isArray(p.coinsAddresses)) return false;
        const cs = p.coinsAddresses.map(a => (a || '').toLowerCase());
        return cs.includes(baseAddrLC) && cs.includes(quoteAddrLC);
      });
      const snap = await _ensureLongHistoryVol();
      const snapPools = snap && snap.pools ? snap.pools : null;
      if (snapPools) {
        // Aggregate daily volumes by day across ALL pair-pools present in snapshot.
        // chain_id sanity: filter snapshot entries to current chain.
        const dayMap = new Map();  // ts -> usd
        let participating = 0;
        for (const p of pairPools) {
          const entry = snapPools[String(p.address || '').toLowerCase()];
          if (!entry || !Array.isArray(entry.days)) continue;
          if (entry.chain_id && entry.chain_id !== chainIdNow) continue;
          participating++;
          for (const d of entry.days) {
            if (!d.day) continue;
            const ts = Math.floor(Date.parse(d.day + 'T00:00:00Z') / 1000);
            if (!Number.isFinite(ts)) continue;
            dayMap.set(ts, (dayMap.get(ts) || 0) + (Number(d.vol_usd) || 0));
          }
        }
        if (participating > 0 && dayMap.size > 0) {
          // Overlay short-window live volume for the highest-TVL pair-pool so
          // today's bar reflects intraday flow. Live = hourly buckets summed
          // into days; overrides snapshot for those days only.
          try {
            const liveDayMap = new Map();
            const topPool = pairPools.slice().sort((a, b) => (b.tvl || 0) - (a.tvl || 0))[0];
            const _addrLCP = topPool && topPool.address ? topPool.address.toLowerCase() : '';
            if (topPool && topPool.address && !_curvePricesVolume404.has(_addrLCP)) {
              const cs2 = (topPool.coinsAddresses || []).map(a => (a || '').toLowerCase());
              const bi = cs2.indexOf(baseAddrLC);
              const qi = cs2.indexOf(quoteAddrLC);
              if (bi >= 0 && qi >= 0) {
                const mainT = topPool.coinsAddresses[bi];
                const refT = topPool.coinsAddresses[qi];
                // Живой слой берём СУТОЧНЫМИ корзинами и на 299 дней назад:
                // серверный снапшот стоит с 12.06 (крон не пережил переезд), а
                // без этого ранняя часть гистограммы у прямых пар пустая —
                // 18.08 Ник увидел это на скрине (76 столбиков на 181 свечу).
                const endL = Math.floor(Date.now() / 1000);
                const startL = endL - 299 * 86400;
                const liveUrl = `${PRICES_BASE}/volume/${getChainKey()}/${topPool.address}?main_token=${mainT}&reference_token=${refT}&start=${startL}&end=${endL}&interval=day`;
                let resp = await fetch(liveUrl);
                if (resp.ok) {
                  // Порядок токенов в ручке не симметричен: пустой ответ — повод
                  // спросить обратный порядок (замер 17.08: $19.3M против $10K).
                  const probe = (await resp.clone().json().catch(() => null)) || {};
                  const sum = (probe.data || []).reduce((x, d) => x + (Number(d && d.volume) || 0), 0);
                  if (!(sum > 0)) {
                    const alt = await fetch(`${PRICES_BASE}/volume/${getChainKey()}/${topPool.address}?main_token=${refT}&reference_token=${mainT}&start=${startL}&end=${endL}&interval=day`);
                    if (alt.ok) resp = alt;
                  }
                }
                if (resp.status === 404 || resp.status === 405) {
                  _curvePricesVolume404.add(_addrLCP);
                } else if (resp.ok) {
                  const j = await resp.json();
                  for (const d of (j.data || [])) {
                    const ts = typeof d.timestamp === 'number' ? d.timestamp : 0;
                    if (!ts) continue;
                    const dayTs = Math.floor(ts / 86400) * 86400;
                    liveDayMap.set(dayTs, (liveDayMap.get(dayTs) || 0) + (Number(d.volume) || 0));
                  }
                }
              }
            }
            // Overlay: live wins for days it covers (only ~30d back, fresher).
            for (const [ts, v] of liveDayMap) {
              if (v > 0) dayMap.set(ts, v);
            }
          } catch { /* live overlay non-fatal */ }

          // Build histogram data with sub-daily distribution pattern (mirrors loadVolumeFromTrades).
          const candleTs = tradePairLastCandles || [];
          const filtered = Array.from(dayMap.entries())
            .filter(([_, v]) => v > 0)
            .sort((a, b) => a[0] - b[0]);

          let volData;
          if (tradePairUnit === 'day' && tradePairAgg >= 7) {
            // Weekly bucketing: align each daily timestamp to nearest candle bucket.
            const weekMap = {};
            filtered.forEach(([ts, v]) => {
              let bucket = candleTs.length > 0 ? candleTs[0] : ts;
              for (let i = candleTs.length - 1; i >= 0; i--) {
                if (candleTs[i] <= ts) { bucket = candleTs[i]; break; }
              }
              if (!weekMap[bucket]) weekMap[bucket] = 0;
              weekMap[bucket] += v;
            });
            volData = Object.entries(weekMap)
              .map(([time, value]) => ({ time: parseInt(time), value, color: 'rgba(14,203,129,0.5)' }))
              .sort((a, b) => a.time - b.time);
          } else if (tradePairUnit === 'day' || candleTs.length === 0) {
            // Daily: emit as-is (filter to candle range if available).
            volData = filtered
              .map(([ts, v]) => ({ time: ts, value: v, color: 'rgba(14,203,129,0.5)' }));
            if (candleTs.length > 0) {
              const firstC = candleTs[0];
              const lastC = candleTs[candleTs.length - 1];
              volData = volData.filter(d => d.time >= firstC && d.time <= lastC + 7 * 86400);
            }
          } else {
            // Sub-daily (1H/4H): distribute each day's volume across its candles.
            const dayVol = new Map();
            filtered.forEach(([ts, v]) => dayVol.set(ts, v));
            const volumeMap = {};
            const candlesByDay = {};
            candleTs.forEach(ts => {
              const dayTs = Math.floor(ts / 86400) * 86400;
              if (!candlesByDay[dayTs]) candlesByDay[dayTs] = [];
              candlesByDay[dayTs].push(ts);
            });
            for (const [dTs, cs] of Object.entries(candlesByDay)) {
              const dv = dayVol.get(parseInt(dTs)) || 0;
              if (dv <= 0) continue;
              const per = dv / cs.length;
              cs.forEach(ts => { volumeMap[ts] = per; });
            }
            volData = Object.entries(volumeMap)
              .map(([time, value]) => ({ time: parseInt(time), value, color: 'rgba(14,203,129,0.5)' }))
              .sort((a, b) => a.time - b.time);
          }

          if (tradePairVolumeSeries && volData && volData.length > 0) {
            const lastRaw = volData[volData.length - 1].value;
            // sqrt-normalize to match pool view scale
            const normalized = _sqrtNormalizeVol(volData.slice());
            tradePairVolumeSeries.setData(normalized);
            _setLastVol(lastRaw);
            return;
          }
        }
      }
    }
  } catch (e) { console.warn('[trade-pair] snapshot aggregation failed:', e); /* fall through */ }

  // === FALLBACK: single-pool live volume API (legacy, hourly granularity) ===
  // Used when no pair-pool is in snapshot (tail pairs <$300K TVL).
  try {
    const timeRangesTP = { 1: 7*24, 4: 30*24 };
    const dayRangesTP = { 1: 250*24, 7: 365*24 };
    const hoursBackTP = tradePairUnit === 'day' ? (dayRangesTP[tradePairAgg] || 90*24) : (timeRangesTP[tradePairAgg] || 30*24);
    const startTP = Math.floor(Date.now() / 1000) - hoursBackTP * 3600;
    const endTP = Math.floor(Date.now() / 1000);
    const _addrLCTP = (pool.address || '').toLowerCase();
    if (_curvePricesVolume404.has(_addrLCTP)) {
      // Circuit-breaker hit — skip fetch, fall through to Curve trades API.
      throw new Error('skip-volume-404');
    }
    const volUrlTP = `${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${mainToken}&reference_token=${refToken}&start=${startTP}&end=${endTP}`;
    const volRespTP = await fetch(volUrlTP);
    if (volRespTP.status === 404 || volRespTP.status === 405) {
      _curvePricesVolume404.add(_addrLCTP);
    } else if (volRespTP.ok) {
      const volJsonTP = await volRespTP.json();
      let hourlyTP = volJsonTP.data || [];
      // ПОРЯДОК ТОКЕНОВ В РУЧКЕ НЕ СИММЕТРИЧЕН (замер 17.08, TricryptoUSDC,
      // 30 дней: main=USDC ref=WETH -> $19.3M, обратный порядок -> $10K).
      // Пустой ответ = скорее всего спросили не с той стороны.
      const _sum = a => (a || []).reduce((x, d) => x + (Number(d && d.volume) || 0), 0);
      if (!hourlyTP.some(d => (Number(d && d.volume) || 0) > 0)) {
        try {
          const _rr = await fetch(`${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${refToken}&reference_token=${mainToken}&start=${startTP}&end=${endTP}`);
          if (_rr.ok) { const _jj = await _rr.json(); if ((_jj.data || []).some(d => (Number(d && d.volume) || 0) > 0)) hourlyTP = _jj.data; }
        } catch (e) { /* остаёмся с первым ответом */ }
      }
      // Часовая ручка покрывает ~12.5 суток, окно 4H — 30: ранняя часть
      // гистограммы у ПРЯМЫХ пар оставалась пустой (18.08, WETH/USDC: 76
      // столбиков на 181 свечу). Добираем суточными корзинами и размазываем
      // день по его свечам — тем же приёмом, что и на составных парах.
      try {
        const _cts = tradePairLastCandles || [];
        const _times = (hourlyTP || []).map(d => Number(d && d.timestamp) || 0).filter(Boolean);
        const _covered = _times.length ? Math.min(..._times) : endTP;
        if (_cts.length && _covered - 3600 > _cts[0]) {
          const _st = Math.max(_cts[0] - 86400, endTP - 299 * 86400);
          const _one = async (mm, rr) => {
            const r = await fetch(`${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${mm}&reference_token=${rr}&start=${_st}&end=${endTP}&interval=day`);
            if (!r.ok) return null;
            const j = await r.json();
            return j && j.data ? j.data : null;
          };
          let _day = await _one(mainToken, refToken);
          if (_sum(_day) === 0) _day = await _one(refToken, mainToken);
          const _extra = [];
          for (const d of (_day || [])) {
            const ds = Number(d && d.timestamp) || 0, v = Number(d && d.volume) || 0;
            if (!ds || !(v > 0) || ds >= _covered) continue;
            const inDay = _cts.filter(t => t >= ds && t < ds + 86400);
            if (!inDay.length) { _extra.push({ timestamp: ds, volume: v }); continue; }
            const per = v / inDay.length;
            for (const t of inDay) _extra.push({ timestamp: t, volume: per });
          }
          if (_extra.length) hourlyTP = _extra.concat(hourlyTP);
        }
      } catch (e) { /* без добора — как было */ }
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
        const volDataTP = Object.entries(bucketMapTP)
          .map(([time, value]) => ({ time: parseInt(time), value, color: 'rgba(14,203,129,0.5)' }))
          .sort((a, b) => a.time - b.time);
        if (volDataTP.length > 0) {
          tradePairVolumeSeries.setData(volDataTP);
          _setLastVol(volDataTP[volDataTP.length - 1].value);
          return;
        }
      }
    }
  } catch { /* fallback to trades API */ }

  // Fallback 2: Curve trades API
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
      _setLastVol(volData[volData.length - 1].value);
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
    if (e && e.name === 'AbortError') return; // silent — by-design fetch cancel on pair switch
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
      // Stash raw wei + decimals on the balance element so MAX/% buttons
      // can read precision-preserving raw BigInt (avoids .toFixed() overshoot
      // — see tx 0x61fce3fd... 2026-05-21 where MAX overshot 46246306059663 wei).
      el.dataset.rawWei = balance.toString();
      el.dataset.decimals = String(decimals);
      el.textContent = 'Balance: ' + parseFloat(formatted).toFixed(4);
    } catch (e) {
      delete el.dataset.rawWei;
      delete el.dataset.decimals;
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
  if (typeof ethers === 'undefined') return;
  const balEl = document.getElementById('tradePairFromBal');
  if (!balEl) return;
  // Prefer raw BigInt from data-rawWei (precision-preserving — avoids float
  // drift on raw wei values). Fall back to DOM text parse if attrs missing.
  if (balEl.dataset && balEl.dataset.rawWei) {
    try {
      const raw = BigInt(balEl.dataset.rawWei);
      if (raw === 0n) return;
      const decimals = parseInt(balEl.dataset.decimals || '18');
      const amt = (raw * BigInt(Math.round(fraction * 10000))) / 10000n;
      document.getElementById('tradePairFromAmt').value = ethers.formatUnits(amt, decimals);
      document.getElementById('tradePairFromAmt').dispatchEvent(new Event('input'));
      return;
    } catch (_) { /* fall through */ }
  }
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
    // Amount comparison is in WEI: quotes don't carry the raw input string, and
    // string-comparing user input ('9000' vs '9000.0') silently forces a
    // re-quote at submit — the signed tx then comes from a NEW quote the user
    // never saw (Михаил tx 0xb07a082…: screen showed direct, wallet signed a
    // worse 3-hop).
    let quote = _lastTradeQuote;
    let sameInput = false;
    try {
      sameInput = !!(quote
        && tradeSelectedFrom && tradeSelectedTo
        && quote.fromToken && quote.toToken
        && quote.fromToken.toLowerCase() === tradeSelectedFrom.address.toLowerCase()
        && quote.toToken.toLowerCase() === tradeSelectedTo.address.toLowerCase()
        && quote.inputAmountWei != null
        && BigInt(quote.inputAmountWei) === ethers.parseUnits(fromAmt, Number(tradeSelectedFrom.decimals))
        && (Date.now() - (quote._quotedAt || 0)) <= TRADE_QUOTE_MAX_AGE_MS);
    } catch { sameInput = false; }

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
      // The screen must show what will actually execute: refresh output,
      // route viz and comparison from the NEW quote before any signature.
      const toEl = document.getElementById('tradePairToAmt');
      const shownOut = toEl ? parseFloat(toEl.value) : NaN;
      const newOut = parseFloat(quote.outputAmount);
      try {
        if (toEl && isFinite(newOut)) toEl.value = newOut.toFixed(6);
        updateRouteVizFromQuote(quote);
        renderAggComparison(quote);
      } catch { /* display refresh is best-effort */ }
      if (quote) quote._quotedAt = Date.now();
      _lastTradeQuote = quote;
      // Floor: never silently sign a quote worse than what was on screen.
      // The UI now shows the fresh quote; the user re-confirms by pressing
      // Swap again (the press reuses it via the wei comparison above).
      if (isFinite(shownOut) && shownOut > 0 && isFinite(newOut) && newOut < shownOut) {
        btn.textContent = 'Quote changed — review & press again';
        btn.className = 'swap-submit disabled';
        setTimeout(() => updateTradePairButton(), 4000);
        return;
      }
    }

    // Incomplete-comparison guard: a Curve-native strategy ERRORED out of the
    // quote race (RPC degradation, not "no route") — the chosen route may be
    // worse than the real best. One re-quote after a short backoff; still
    // degraded → stop, never build the tx silently (Михаил, 2026-06-12).
    if (quote && Array.isArray(quote._degradedSources) && quote._degradedSources.length) {
      console.warn('[trade] quote degraded (' + quote._degradedSources.join(', ') + ') — re-quoting before submit');
      btn.textContent = 'Re-checking route...';
      await new Promise(r => setTimeout(r, 600));
      const slipBtn2 = document.querySelector('.trade-slip.active');
      const slipCustom2 = document.getElementById('tradeSlippageCustom')?.value;
      const slippage2 = slipCustom2 ? parseFloat(slipCustom2) : (slipBtn2 ? parseFloat(slipBtn2.dataset.slip) : 0.5);
      const requote = await router.getQuote(
        tradeSelectedFrom.address, tradeSelectedTo.address, fromAmt,
        tradeSelectedFrom.decimals, tradeSelectedTo.decimals, slippage2, walletAddress
      ).catch(() => null);
      if (!requote || (Array.isArray(requote._degradedSources) && requote._degradedSources.length)) {
        btn.textContent = 'RPC degraded — try again';
        btn.className = 'swap-submit disabled';
        setTimeout(() => updateTradePairButton(), 4000);
        return;
      }
      quote = requote;
      if (quote) quote._quotedAt = Date.now();
      _lastTradeQuote = quote;
      try {
        const toEl2 = document.getElementById('tradePairToAmt');
        if (toEl2) toEl2.value = parseFloat(quote.outputAmount).toFixed(6);
        updateRouteVizFromQuote(quote);
        renderAggComparison(quote);
      } catch { /* best-effort */ }
    }

    btn.textContent = 'Approving...';
    await router.ensureApproval(quote, walletAddress, signer);

    btn.textContent = 'Swapping...';
    const txParams = await router.buildSwapTx(quote, walletAddress);
    // The built tx names the contract that will actually pull the token; top
    // the allowance up if it is not the one we pre-approved.
    await router.ensureApprovalForTx(txParams, quote, walletAddress, signer);
    // Michwill EIP-1559 gas strategy.
    const gasOv = await window.computeMichwillGasParams(browserProvider);
    // Per Михаил hard rule (msg 7092 2026-05-24): estimateGas × 1.5.
    // Handle multi-tx envelope (split / native-wrap composite) just like /swap.
    let tx;
    if (txParams && txParams.type === 'multi-tx' && Array.isArray(txParams.transactions)) {
      const inner = quote._innerQuote || quote;
      for (const sub of txParams.transactions) {
        if (sub._spender) {
          const approveToken = inner.fromToken;
          if (approveToken && approveToken.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
            const erc20 = new ethers.Contract(approveToken, ERC20_ABI, signer);
            const have = await erc20.allowance(walletAddress, sub._spender);
            const need = BigInt(inner.inputAmountWei || '0');
            for (const amt of window.approveAmounts(have, need)) {
              const approveData = erc20.interface.encodeFunctionData('approve', [sub._spender, amt]);
              const approveTx = { to: approveToken, data: approveData, value: 0n };
              approveTx.gasLimit = await window.estimateGasWithBuffer(browserProvider, approveTx, walletAddress);
              const a = await signer.sendTransaction({ ...approveTx, ...gasOv });
              await a.wait();
            }
          }
        }
        const subTx = { to: sub.to, data: sub.data, value: sub.value || 0n };
        subTx.gasLimit = await window.estimateGasWithBuffer(browserProvider, subTx, walletAddress);
        const t = await signer.sendTransaction({ ...subTx, ...gasOv });
        await t.wait();
      }
      tx = { wait: async () => {} }; // satisfy the downstream tx.wait() call shape
    } else {
      const sendTx = { to: txParams.to, data: txParams.data, value: txParams.value || 0n };
      sendTx.gasLimit = await window.estimateGasWithBuffer(browserProvider, sendTx, walletAddress);
      tx = await signer.sendTransaction({ ...sendTx, ...gasOv });
    }

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

// ============================================================
// SMART SLIPPAGE DEFAULT — PER-BUCKET (stable vs crypto)
// ------------------------------------------------------------
// Slippage tolerance is stored and defaulted SEPARATELY for stable vs volatile
// (crypto) swaps. "stable vs volatile" is derived from the RESOLVED ROUTE's pool
// types (Curve on-chain pool metadata via _classifyPoolType), NOT from a symbol
// list — a route is 'stable' iff EVERY hop is StableSwap-type; any Cryptoswap or
// volatile hop puts it in the 'crypto' bucket.
//
//   stable bucket:  default 0.02%, presets 0.02 / 0.05 / 0.1
//   crypto bucket:  default 0.1%,  presets 0.1  / 0.5  / 1.0
//
// Each bucket persists its own chosen value INDEPENDENTLY (two localStorage
// keys, two override flags) so a manual 0.5% on a crypto pair can never leak
// into a stablecoin pair (the sandwich-on-crvUSD bug) and vice versa.
// The classifier RE-RUNS whenever the route resolves or the pair changes,
// because the bucket depends on the resolved route, not just the symbols.
// Shared via window between trade.js and swap.js (single source of truth).
// ============================================================
const _SLIP_BUCKETS = {
  stable: { def: '0.02', presets: ['0.02', '0.05', '0.1'], key: 'curvedex_slippage_stable', ovr: '_slipOverrideStable' },
  crypto: { def: '0.1',  presets: ['0.1', '0.5', '1.0'],   key: 'curvedex_slippage_crypto', ovr: '_slipOverrideCrypto' },
};
window._SLIP_BUCKETS = _SLIP_BUCKETS;
// Active bucket. Start on 'crypto' = the higher-tolerance / safer default so we
// never under-protect a volatile swap before the route resolves.
if (typeof window._currentSlipBucket === 'undefined') window._currentSlipBucket = 'crypto';
// Per-bucket override flags (a manual choice OR a persisted value for that
// bucket). Replaces the old single global `_slippageUserOverride`.
for (const b of Object.values(_SLIP_BUCKETS)) {
  if (typeof window[b.ovr] === 'undefined') {
    window[b.ovr] = false;
    try { if (localStorage.getItem(b.key) != null) window[b.ovr] = true; } catch (e) {}
  }
}

// One-time migration: the OLD shared key was used by both views and is the
// value that leaked. It was last set on whatever pair the user last touched;
// treat it as the CRYPTO bucket's value (safe — leaking crypto's value into
// crypto is a no-op; the bug was crypto→stable). Never clobber an explicit
// crypto bucket value.
(function _migrateLegacySlippage() {
  try {
    const old = localStorage.getItem('curvedex_slippage');
    if (old == null) return;
    if (localStorage.getItem(_SLIP_BUCKETS.crypto.key) == null) {
      const v = parseFloat(old);
      if (!isNaN(v) && v > 0 && v < 50) {
        localStorage.setItem(_SLIP_BUCKETS.crypto.key, String(old));
        window._slipOverrideCrypto = true;
      }
    }
  } catch (e) {}
})();

// Effective slippage for a bucket: its persisted value, else its default.
window._readSlipBucket = function (bucket) {
  const cfg = _SLIP_BUCKETS[bucket]; if (!cfg) return null;
  let saved = null;
  try { saved = localStorage.getItem(cfg.key); } catch (e) {}
  if (saved != null) { const v = parseFloat(saved); if (!isNaN(v) && v > 0 && v < 50) return String(saved); }
  return cfg.def;
};

// Walk a resolved quote's route (flat legs OR nested split-paths with .legs[])
// and return all resolved pool objects. Wrap/unwrap segments (no .pool) are
// skipped — they are not AMM hops.
window._routeAllPools = function (quote) {
  if (!quote || !Array.isArray(quote.route)) return [];
  const out = [];
  const reg = (typeof allPools !== 'undefined' && Array.isArray(allPools)) ? allPools : [];
  const find = (addr) => reg.find(p => p.address && p.address.toLowerCase() === String(addr).toLowerCase());
  const pushLeg = (leg) => {
    if (!leg || !leg.pool) return;
    const p = find(leg.pool);
    if (p) out.push(p);
  };
  for (const item of quote.route) {
    if (item && Array.isArray(item.legs)) { for (const l of item.legs) pushLeg(l); }
    else pushLeg(item);
  }
  return out;
};

// Classify a resolved route into a bucket using Curve pool metadata. Returns
// 'stable' iff EVERY resolved hop is StableSwap-type, 'crypto' if any hop is
// volatile, or null when no pools resolve (caller keeps the current bucket).
window._classifyRouteBucket = function (quote) {
  const pools = window._routeAllPools(quote);
  if (pools.length === 0) return null;
  const allStable = pools.every(p => (typeof _classifyPoolType === 'function' ? _classifyPoolType(p) : '') === 'stable');
  return allStable ? 'stable' : 'crypto';
};

// Re-skin the 3 preset buttons (data-slip + label) of one slip-button group to
// match a bucket, and mark active the button equal to `activeVal` (or clear all
// + fill custom input when activeVal is a non-preset custom value).
function _skinSlipButtons(selector, customId, bucket, activeVal) {
  const cfg = _SLIP_BUCKETS[bucket];
  const btns = document.querySelectorAll(selector);
  btns.forEach((b, i) => {
    const v = cfg.presets[i];
    if (v != null) { b.dataset.slip = v; b.textContent = v + '%'; b.style.display = ''; }
    else b.style.display = 'none';
    b.classList.toggle('active', v != null && v === activeVal);
  });
  const custom = customId ? document.getElementById(customId) : null;
  const isPreset = cfg.presets.includes(activeVal);
  if (custom) custom.value = isPreset ? '' : (activeVal || '');
}

// Apply a bucket to BOTH the /trade and /swap-view slippage UIs and to the
// `swapSlippage` global used by the swap engine. Uses the bucket's effective
// value (persisted-or-default). This is the single place that switches buckets.
window._applySlippageBucket = function (bucket) {
  if (!_SLIP_BUCKETS[bucket]) return;
  window._currentSlipBucket = bucket;
  const val = window._readSlipBucket(bucket);
  _skinSlipButtons('.trade-slip', 'tradeSlippageCustom', bucket, val);
  _skinSlipButtons('.swap-view-slip', 'swapViewSlippageCustom', bucket, val);
  if (typeof swapSlippage !== 'undefined') { const n = parseFloat(val); if (!isNaN(n)) swapSlippage = n; }
};

// Authoritative entry: classify the RESOLVED route and apply the matching
// bucket. Called whenever a quote resolves in either view.
window._applySmartSlippageForRoute = function (quote) {
  const bucket = window._classifyRouteBucket(quote);
  if (!bucket) return; // unknown route → keep current bucket
  window._applySlippageBucket(bucket);
};

// Provisional pre-route hint on pair/token change. The route has not resolved
// yet, so this is a best-effort guess that gives instant UI feedback; the
// route-resolve callback (_applySmartSlippageForRoute) is authoritative and
// will correct it. We only switch to the STABLE bucket when BOTH symbols look
// stable; anything else stays/falls back to CRYPTO (never under-protect).
window._applySmartSlippageForPair = function (fromSym, toSym) {
  const looksStable = window._isStableSym(fromSym) && window._isStableSym(toSym);
  window._applySlippageBucket(looksStable ? 'stable' : 'crypto');
};

// Symbol stable-hint (provisional only — NOT used for the authoritative route
// classification, which reads pool type). Kept for the instant pre-route guess.
window._isStableSym = function (sym) {
  if (!sym) return false;
  return _STABLE_SYMS_FOR_TAGS.has(String(sym).toLowerCase());
};

// Persist a manual choice to the CURRENT bucket only, mark that bucket
// overridden, update swapSlippage, and mirror the active state onto BOTH the
// /trade and /swap-view button groups so the two views stay in sync. Single
// source of truth shared with swap.js via window.
window._persistSlipManual = function (val) {
  const cfg = _SLIP_BUCKETS[window._currentSlipBucket] || _SLIP_BUCKETS.crypto;
  try { localStorage.setItem(cfg.key, String(val)); } catch (e) {}
  window[cfg.ovr] = true;
  const sval = String(val);
  if (typeof swapSlippage !== 'undefined') { const n = parseFloat(sval); if (!isNaN(n)) swapSlippage = n; }
  // Mirror active state across both views without re-skinning (presets unchanged).
  const isPreset = cfg.presets.includes(sval);
  [['.trade-slip', 'tradeSlippageCustom'], ['.swap-view-slip', 'swapViewSlippageCustom']].forEach(([sel, cid]) => {
    document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', isPreset && b.dataset.slip === sval));
    const custom = document.getElementById(cid);
    if (custom && custom !== document.activeElement) custom.value = isPreset ? '' : sval;
  });
};

// Trade pair slippage buttons (presets are re-skinned per bucket; the click
// just reads the live data-slip and persists to the active bucket).
document.querySelectorAll('.trade-slip').forEach(btn => {
  btn.addEventListener('click', () => { window._persistSlipManual(btn.dataset.slip); });
});

// Custom slippage input → persist to the active bucket.
const _tradeSlipCustomInput = document.getElementById('tradeSlippageCustom');
if (_tradeSlipCustomInput) {
  _tradeSlipCustomInput.addEventListener('input', () => {
    const val = parseFloat(_tradeSlipCustomInput.value);
    if (!isNaN(val) && val > 0 && val < 50) window._persistSlipManual(val);
  });
}

// Initialize UI to the current bucket's effective value on load.
window._applySlippageBucket(window._currentSlipBucket);


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
  // Native gas-token (pseudo 0xeee...e) → wrapped ERC20 for pool lookups.
  // Wrapped address is chain-aware: WETH on Ethereum/Arb/Op/Base, WXDAI on Gnosis,
  // WMATIC on Polygon, WAVAX on Avalanche, etc — from chains_config.json.
  if (token._isNativeETH || token.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return (typeof getWrappedNativeAddr === 'function' ? getWrappedNativeAddr() : '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2');
  }
  return token.address;
}

function onTradeTokensChanged() {
  if (!tradeSelectedFrom || !tradeSelectedTo) return;
  const fromAddr = _resolveTokenAddr(tradeSelectedFrom);
  const toAddr = _resolveTokenAddr(tradeSelectedTo);
  if (fromAddr === toAddr) return;

  // Smart slippage default: stable↔stable → stable bucket (0.02%), otherwise → crypto bucket (0.1%).
  // No-op if user has manually overridden in this session.
  if (typeof window._applySmartSlippageForPair === 'function') {
    window._applySmartSlippageForPair(tradeSelectedFrom.symbol, tradeSelectedTo.symbol);
  }

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
    // New pair always starts in canonical direction; re-sync the ↔️ button visual.
    tradePairInverted = false;
    try { _syncTradePairInvertBtn(); } catch {}
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

    // General N-hop chain: source -> pool0 -> mid0 -> pool1 -> mid1 -> ... -> poolN-1 -> target.
    // For n pools there are n-1 intermediate tokens. Covers single-hop (n=1, no mids),
    // 2-hop (n=2, 1 mid) and arbitrary multi-hop incl. vault legs (n>=3).
    const poolNames = (path.poolNames || []).map(_shortenPoolName);
    if (poolNames.length === 0) return;
    const mids = path.midTokenSyms || [];
    let prevIdx = srcIdx;
    for (let i = 0; i < poolNames.length; i++) {
      const poolName = poolNames[i];
      const poolIdx = getNode(poolName, 'pool');
      links.push({ source: prevIdx, target: poolIdx, value, pct: path.pct, pool: poolName });
      if (i < poolNames.length - 1) {
        const midSym = mids[i] || '?';
        const midIdx = getNode(midSym, 'mid');
        links.push({ source: poolIdx, target: midIdx, value, pct: path.pct, pool: poolName });
        prevIdx = midIdx;
      } else {
        links.push({ source: poolIdx, target: tgtIdx, value, pct: path.pct, pool: poolName });
      }
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
    // Single direct pool — show as single-path Sankey.
    // Prefer router-picked pool (set by _probeRouterRouteForChart when it
    // disagrees with the BFS/TVL-best pool) so the pre-amount preview
    // reflects what the swap router would actually execute.
    const routerPool = pair._routerPool || null;
    const fallbackPool = allPools.find(p => p.address === pair.poolAddr);
    const pool = routerPool || fallbackPool;
    const poolName = _shortPoolName(
      (routerPool && routerPool.name) ? routerPool.name :
      (pair.pool && pair.pool.name) ? pair.pool.name :
      (pool ? pool.name : '?')
    );
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
      // curve-js-baseline added 2026-06-12 (madeath msg 1001): pairs whose only
      // graph link is a vault↔underlying leg (sdYB→scrvUSD) quoted To=0 —
      // the pool graph offers nothing but dust pools for crvUSD↔scrvUSD, while
      // the vault deposit (Router NG swap-type 9) lives in curve-js. The
      // strategy self-guards (mainnet-only, 2s curve-js-ready timeout) and
      // races in parallel — no hot-path latency added.
      strategies: ['curve-direct', 'curve-router', 'curve-js-baseline'],
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
  const minOutEl = document.getElementById('tradePairMinOut');
  if (minOutEl) { minOutEl.textContent = '...'; minOutEl.style.color = ''; }
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
async function _probeRouterRouteForChart(_retry) {
  // Bullet-proof rewrite: tries probe amounts ['1000','100','1'] in sequence,
  // catches every exception, updates DOM on first success or schedules retry.
  // On total failure, leaves initial TVL-fallback text in place.
  if (!selectedPair) return;
  const fromAmtEl = document.getElementById('tradePairFromAmt');
  const fromAmt = fromAmtEl ? fromAmtEl.value : '';
  if (fromAmt && parseFloat(fromAmt) > 0) return; // user-driven quote will run

  // Resolve from/to addresses + decimals from selectedPair (avoids dependency
  // on tradeSelectedFrom/To globals which are populated by the wrapper post-call).
  const fromAddr = selectedPair.baseAddr;
  const toAddr = selectedPair.quoteAddr;
  if (!fromAddr || !toAddr) return;
  // Resolve decimals. Prefer the global tradeSelectedFrom/To set by the inner
  // selectTokenPair (line 2730) — they hold canonical decimals. Fall back to
  // scanning any pool that contains both coins; final fallback is 18/18 only
  // if everything's missing (which would mean broken cache).
  let fromDec = null, toDec = null;
  if (tradeSelectedFrom && tradeSelectedTo && Number.isFinite(tradeSelectedFrom.decimals) && Number.isFinite(tradeSelectedTo.decimals)) {
    fromDec = tradeSelectedFrom.decimals;
    toDec = tradeSelectedTo.decimals;
  } else {
    // Scan allPools for any pool containing fromAddr; read its decimals[]
    const fromLow = fromAddr.toLowerCase(), toLow = toAddr.toLowerCase();
    for (const p of allPools) {
      if (!p.coinsAddresses || !p.decimals) continue;
      const addrs = p.coinsAddresses.map(a => a.toLowerCase());
      const fi = addrs.indexOf(fromLow);
      const ti = addrs.indexOf(toLow);
      if (fi >= 0 && fromDec === null) fromDec = Number(p.decimals[fi]);
      if (ti >= 0 && toDec === null) toDec = Number(p.decimals[ti]);
      if (fromDec !== null && toDec !== null) break;
    }
  }
  if (!Number.isFinite(fromDec)) fromDec = 18;
  if (!Number.isFinite(toDec)) toDec = 18;

  try { await loadEthers(); } catch { return; }
  const router = getTradeRouter();
  if (!router) return;
  if (!router._pools || router._pools.length === 0) {
    if (!_retry) setTimeout(() => _probeRouterRouteForChart('retry-pools'), 1500);
    return;
  }

  const pairBaseAddr = fromAddr, pairQuoteAddr = toAddr;
  let quote = null;
  const PROBE_AMOUNTS = ['1000', '100', '1'];
  for (const probeAmt of PROBE_AMOUNTS) {
    try {
      quote = await router.getQuote(fromAddr, toAddr, probeAmt, fromDec, toDec, 0.5, null);
      if (quote && quote.route && quote.route.length >= 1) break;
      quote = null;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // try next smaller amount
      quote = null;
    }
  }
  // All probe amounts failed → leave initial TVL-fallback text alone. Retry once after 2.5s.
  if (!quote) {
    if (!_retry) setTimeout(() => _probeRouterRouteForChart('retry-quote'), 2500);
    return;
  }

  // Pair may have changed while probe was in flight — abort if so.
  if (!selectedPair || selectedPair.baseAddr !== pairBaseAddr || selectedPair.quoteAddr !== pairQuoteAddr) return;

  // Helper: write DOM text + viz from given pools array
  const applyRoute = (pools) => {
    if (!pools || pools.length === 0) return;
    if (pools.length === 1) {
      selectedPair._routerPool = pools[0];
      selectedPair._multiRoute = null;
    } else {
      selectedPair._multiRoute = pools;
      selectedPair._routerPool = null;
    }
    const routeEl = document.getElementById('tradePairRouteInfo');
    if (routeEl) {
      const names = pools.map(p => _shortPoolName(p.name) || (p.address || '').slice(0, 12)).join(' → ');
      routeEl.textContent = pools.length === 1 ? `via ${names}` : names;
      delete routeEl.dataset.isFallback;
    }
    try { updateTradeRouteViz(selectedPair); } catch {}
  };

  // Resolve route legs to pool objects
  const quotePools = [];
  for (let i = 0; i < quote.route.length; i++) {
    const leg = quote.route[i];
    const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
    if (!pool) return; // can't sync — leave current state
    quotePools.push(pool);
  }
  if (quote.route.length >= 2) {
    // Build _bfsTokens chain for multi-hop chart
    const quoteTokens = [pairBaseAddr];
    const mts = quote._midTokens || (quote._midToken ? [quote._midToken] : []);
    let chainOk = true;
    for (let i = 0; i < quote.route.length - 1; i++) {
      const mt = mts[i];
      if (mt && mt.address) quoteTokens.push(mt.address.toLowerCase());
      else { chainOk = false; break; }
    }
    if (chainOk) {
      quoteTokens.push(pairQuoteAddr);
      quotePools._bfsTokens = quoteTokens;
    }
    setCachedRoute(pairBaseAddr, pairQuoteAddr, quotePools);
  }
  applyRoute(quotePools);
  // Route resolved (chart probe runs even with no amount entered) → classify
  // slippage bucket from the resolved pool types. Authoritative over the
  // provisional symbol guess made at pair-selection time.
  if (typeof window._applySmartSlippageForRoute === 'function') window._applySmartSlippageForRoute(quote);
  if (quote.route.length >= 2) {
    try { loadTradePairOHLC(); } catch {}
  }
}

let _tradePairAutoTimer = null;
// У числа, от которого подписывают транзакцию, должен быть срок годности.
// На странице пула автообновление было, на панели пары — нет (замер 18.08:
// 0 запросов за 75 секунд покоя, курс на экране застывал).
function _startTradePairAutoRefresh() {
  if (_tradePairAutoTimer) return;
  _tradePairAutoTimer = setInterval(() => {
    if (document.hidden) return;
    if (!tradeSelectedFrom || !tradeSelectedTo) return;
    const el = document.getElementById('tradePairFromAmt');
    if (!el || !el.value || parseFloat(el.value) <= 0) return;
    if (el === document.activeElement) return;   // пока печатает — не мешаем
    fetchTradeQuote();
  }, 12000);
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

    _startTradePairAutoRefresh();
    // Update swap details
    const detailsEl = document.getElementById('tradePairSwapDetails');
    if (detailsEl) detailsEl.style.display = '';
    const rateEl = document.getElementById('tradePairRate');
    if (rateEl) rateEl.textContent = `1 ${tradeSelectedFrom.symbol} = ${quote.rate.toFixed(6)} ${tradeSelectedTo.symbol}`;
    const minEl = document.getElementById('tradePairMinOut');
    if (minEl) {
      const mo = quote.minOutput != null ? parseFloat(quote.minOutput) : null;
      const hr = quote.slippage != null ? Number(quote.slippage) : null;
      minEl.textContent = (mo != null && isFinite(mo))
        ? `${mo.toFixed(6)} ${tradeSelectedTo.symbol}` + (hr != null && isFinite(hr) ? ` (slip ${hr.toFixed(2)}%)` : '')
        : '--';
      minEl.style.color = (hr != null && hr > tradeSlippage + 1e-9) ? 'var(--red)' : '';
    }
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
    if (quote) quote._quotedAt = Date.now();
    _lastTradeQuote = quote;
    // Route resolved → re-classify slippage bucket from the resolved pool types
    // (authoritative; overrides the provisional symbol-based pre-route guess).
    if (typeof window._applySmartSlippageForRoute === 'function') window._applySmartSlippageForRoute(quote);
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
  } else if (quote.route.length >= 2) {
    // Any other sequential multi-hop source not matched above (notably
    // curve-js-baseline, which wins amount-dependent multi-hop routes). Build
    // the diagram from the quote's own legs so vault/synthetic hops aren't lost.
    const _r = (typeof getTradeRouter === 'function' && getTradeRouter())
      || (typeof getSwapRouter === 'function' && getSwapRouter()) || null;
    const vp = (typeof _buildRouteVizPaths === 'function') ? _buildRouteVizPaths(quote, _r) : null;
    if (vp) multiPaths = vp;
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
  // Use Michwill EIP-1559 strategy (maxFeePerGas ≈ 2.05 × baseFeePerGas) so the
  // preview reflects the upper bound the user can actually pay on submit,
  // matching the gas params we attach to signer.sendTransaction(). Falls back
  // to legacy eth_gasPrice on pre-1559 chains (helper handles this).
  try {
    const [gp, ep] = await Promise.all([
      window._michwillGasPricePreview ? window._michwillGasPricePreview() : _ethRpc('eth_gasPrice', []).then(_hexToBigInt),
      _getEthUsdPrice(),
    ]);
    result.gasPrice = (typeof gp === 'bigint') ? gp : _hexToBigInt(gp);
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
          // Ровно сумма операции — так же, как в реальном approve-флоу.
          needed,
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
// Котировка стареет: цена в пуле уходит и без наших действий. Всё, что старше
// этого возраста, к подписи не допускается — пересчитываем (инцидент 09.08:
// подписанный min_dy считался от котировки, которую человек видел минутами раньше).
const TRADE_QUOTE_MAX_AGE_MS = 20000;

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
  // Use Michwill EIP-1559 preview (maxFeePerGas ≈ 2.05 × baseFeePerGas) to
  // match what we send on submit. Falls back to legacy gasPrice inside the
  // helper for pre-1559 chains.
  try {
    const [gp, ep] = await Promise.all([
      (window._michwillGasPricePreview ? window._michwillGasPricePreview() : _ethRpc('eth_gasPrice', []).then(_hexToBigInt)).catch(() => null),
      _getEthUsdPrice().catch(() => null),
    ]);
    if (gp) result.gasPrice = (typeof gp === 'bigint') ? gp : _hexToBigInt(gp);
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

// USD-value estimate under swap amounts (madeath_aa msg 1171) — reuses app.js
// _fetchUsdPrice (Curve prices API, cached). Informational, avoids misclicks.
async function updateTradePairUsd() {
  const apply = async (amtId, tok, elId) => {
    const el = document.getElementById(elId);
    if (!el) return;
    const amt = parseFloat((document.getElementById(amtId) || {}).value);
    if (!tok || !tok.address || !(amt > 0)) { el.textContent = ''; return; }
    let price = 0;
    try { if (typeof _fetchUsdPrice === 'function') price = await _fetchUsdPrice(tok.address); } catch (_) {}
    if (parseFloat((document.getElementById(amtId) || {}).value) !== amt) return; // stale async write guard
    if (price > 0) {
      const v = amt * price;
      el.textContent = '\u2248 $' + (v >= 1 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v.toPrecision(2));
    } else { el.textContent = ''; }
  };
  apply('tradePairFromAmt', tradeSelectedFrom, 'tradePairFromUsd');
  apply('tradePairToAmt', tradeSelectedTo, 'tradePairToUsd');
}

// Debounced quote fetch on amount input
document.getElementById('tradePairFromAmt').addEventListener('input', () => {
  clearTimeout(tradeQuoteDebounce);
  tradeQuoteDebounce = setTimeout(fetchTradeQuote, 500);
  updateTradePairButton();
  updateTradePairUsd();
});

// Refresh USD estimate after every quote (covers To-amount + preset/MAX/swap).
const _origFetchTradeQuoteUsd = fetchTradeQuote;
fetchTradeQuote = async function(...a) {
  try { return await _origFetchTradeQuoteUsd.apply(this, a); }
  finally { try { updateTradePairUsd(); } catch (_) {} }
};

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
    // Re-trigger router probe now that tradeSelectedFrom/To are populated.
    // The inner _origSelectTokenPair calls _probeRouterRouteForChart but at that
    // point these globals are still null (wrapper sets them post-call), so the
    // probe's `if (!tradeSelectedFrom...)` guard exits silently. Without this
    // explicit re-trigger the route text stays on TVL-fallback for hash-driven
    // and sidebar-driven pair selection.
    if (typeof _probeRouterRouteForChart === 'function') _probeRouterRouteForChart();
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
  const allStable = coins.length >= 2 && coins.every(c => window._isStableSym(c));
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

// Single-pool 24h volume via Curve API. Returns {volBase, volUsd, poolName}.
// Uses shared _curvePricesVolume404 circuit breaker (defined near top of file,
// pre-seeded with stETH 0xDC24316b...22 — perma-404 since 2026-05-13).
// Runtime additions: любой пул который 404/405'ил один раз → больше не fetch'им
// (silent fallback на pool.volumeUSD).
async function _trade24hVolumesSinglePool(pool, mainAddr, refAddr) {
  if (!pool || !pool.address || !mainAddr || !refAddr) return null;
  const fallbackUsd = pool.volumeUSD || 0;
  const poolKey = String(pool.address).toLowerCase();
  const fallbackResult = fallbackUsd > 0
    ? { volBase: 0, volUsd: fallbackUsd, poolName: pool.name || '' }
    : null;
  // Pool в blacklist (perma-404) — сразу fallback, без сети
  if (_curvePricesVolume404.has(poolKey)) return fallbackResult;
  try {
    const start = Math.floor(Date.now()/1000) - 24*3600;
    const end = Math.floor(Date.now()/1000);
    const url = `${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${mainAddr}&reference_token=${refAddr}&start=${start}&end=${end}`;
    let resp;
    try {
      // 4s abort timeout — prices.curve.finance can hang on 502 w/o CORS,
      // blocking switch-pair UX. Header is non-critical → no retry.
      const _ctrl = new AbortController();
      const _timer = setTimeout(() => _ctrl.abort(), 4000);
      try {
        resp = await fetch(url, { signal: _ctrl.signal });
      } finally {
        clearTimeout(_timer);
      }
    } catch (_netErr) {
      // Network error / abort timeout / CORS / DNS — silent fallback
      return fallbackResult;
    }
    if (!resp.ok) {
      // 404/405/5xx — добавляем в runtime blacklist чтобы повторные клики не
      // спамили console тем же 404. Swallow и fallback на pool-level.
      if (resp.status === 404 || resp.status === 405) _curvePricesVolume404.add(poolKey);
      return fallbackResult;
    }
    let json;
    try { json = await resp.json(); }
    catch { return fallbackResult; }
    let arr = (json && json.data) || [];
    // ПОРЯДОК ТОКЕНОВ В РУЧКЕ НЕ СИММЕТРИЧЕН (замер 17.08, TricryptoUSDC,
    // 30 дней: main=USDC ref=WETH -> $19.3M, обратный порядок -> $10K).
    // Пустой ответ = скорее всего спросили не с той стороны.
    if (!arr.some(d => (Number(d && d.volume) || 0) > 0)) {
      try {
        const _rr = await fetch(`${PRICES_BASE}/volume/${getChainKey()}/${pool.address}?main_token=${refAddr}&reference_token=${mainAddr}&start=${start}&end=${end}`);
        if (_rr.ok) { const _jj = await _rr.json(); if ((_jj.data || []).some(d => (Number(d && d.volume) || 0) > 0)) arr = _jj.data; }
      } catch (e) { /* остаёмся с первым ответом */ }
    }
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



// Price alert bell: the subscription lives in Telegram, the site only builds the
// link — that keeps this working on the static .eth mirror too, where no form
// could reach a backend. Composite pairs travel as their route: the server
// multiplies the same legs the chart does, so both show one number.
// _tpVaultLegTag: a route leg that is not a pool but an ERC-4626 wrapper
// (scrvUSD over crvUSD, sUSDe over USDe). There is nothing to trade there — the
// rate lives in the contract — so the alert link carries the wrapper address and
// the direction instead of a pool with two coin indices.
async function _tpVaultLegTag(from, to) {
  if (!from || !to || typeof rpcCall !== 'function') return null;
  const f = from.toLowerCase(), t = to.toLowerCase();
  const addrFromRet = r => (r && r.length >= 66) ? ('0x' + r.slice(26, 66)).toLowerCase() : null;
  const asset = async a => { try { return addrFromRet(await rpcCall('0x38d52e0f', a)); } catch { return null; } };
  if ((await asset(t)) === f) return 'v' + t.slice(2, 14) + '-0';   // base -> wrapper
  if ((await asset(f)) === t) return 'v' + f.slice(2, 14) + '-1';   // wrapper -> base
  return null;
}

async function openTradePairAlert() {
  const pair = (typeof selectedPair !== 'undefined') ? selectedPair : null;
  if (!pair) { alert('Open a pair first.'); return; }
  const hops = [];
  const route = pair._multiRoute;
  if (Array.isArray(route) && route.length >= 2 && route._bfsTokens
      && route._bfsTokens.length === route.length + 1) {
    const tokens = route._bfsTokens;
    for (let i = 0; i < route.length; i++) {
      const addrs = (route[i].coinsAddresses || []).map(a => (a || '').toLowerCase());
      const main = addrs.indexOf(tokens[i + 1]);
      const ref = addrs.indexOf(tokens[i]);
      if (main < 0 || ref < 0) {
        const tag = await _tpVaultLegTag(tokens[i], tokens[i + 1]);
        if (!tag) { alert('One leg of this route is neither a pool nor a vault — alerts cannot follow it yet.'); return; }
        hops.push(tag);
        continue;
      }
      hops.push(`${route[i].address.slice(2, 14)}-${main}-${ref}`);
    }
  } else if (pair.pool && pair.pool.coinsAddresses) {
    const addrs = pair.pool.coinsAddresses.map(a => (a || '').toLowerCase());
    const main = addrs.indexOf((pair.quoteAddr || '').toLowerCase());
    const ref = addrs.indexOf((pair.baseAddr || '').toLowerCase());
    if (main < 0 || ref < 0) { alert('Alerts are not available for this pair yet.'); return; }
    hops.push(`${pair.pool.address.slice(2, 14)}-${main}-${ref}`);
  }
  if (!hops.length) { alert('Alerts are not available for this pair yet.'); return; }
  // Telegram's start= payload caps at 64 chars; three hops (16 chars each) plus the
  // level already overflow it, so the link would arrive truncated and unparseable.
  if (hops.length > 2) { alert('This route has too many hops for an alert link (max 2).'); return; }
  const inv = (typeof tradePairInverted !== 'undefined' && tradePairInverted);
  // 1 base = <level> quote; inverted swaps which side the level is quoted in.
  _askPriceAlert(hops, 'tradeChartPrice', inv, inv ? pair.base : pair.quote);
}

// _askPriceAlert: shared tail of both bells — ask for a level, open the bot deep-link.
// Payload: h_<pool12>-<main>-<ref>[_<hop2>]_<a|b>_<level, dot as d>_<0|1 inverted>
let _alertCtx = null;

// Keep the level in the same shape the header shows it in. A pair at 0.00000042
// and a pair at 1.0001 need very different precision, and toFixed(n) with one
// fixed n destroys one of them -- so the number of decimals comes from the price
// on screen, and offsets never add digits the user did not already see.
function _alertFmt(v, sample) {
  if (!isFinite(v) || v <= 0) return '';
  const dot = String(sample || '').indexOf('.');
  const dec = dot < 0 ? 6 : Math.min(18, String(sample).length - dot - 1);
  return v.toFixed(dec).replace(/0+$/, '').replace(/\.$/, '');
}

// Offsets. Derived-from-volatility ladders were tried and rejected: on a stable
// pair they collapsed to 0.01% and read as noise. Alexandr picked the balance
// himself (crvecodev/1931) -- 0.25 / 0.5 / 1 covers a stable repeg and a normal
// move on a volatile pair without a second set of numbers to reason about.
const _ALERT_STEPS = [-1, -0.5, -0.25, 0.25, 0.5, 1];
// Перекос — величина другого порядка: у ровного пула он около нуля, у заметно
// сдвинутого — десятки процентов. Уровни абсолютные, не смещение от текущего.
// Потолок 75%: +100% у пары означает, что одной монеты в пуле не осталось
// вовсе — уровень недостижимый (Alexandr crvecodev/2006).
const _SKEW_STEPS = [-75, -50, -25, 25, 50, 75];

// Перекос = НАИБОЛЬШЕЕ относительное отклонение доли монеты от равной (1/n),
// доли считаются В ТОКЕНАХ. Долларовая доля при депеге сама себя гасит: монеты
// в пуле становится больше, а её цена в тот же момент падает.
function _poolSkewNow(pool) {
  const cd = (pool && pool.coinsDetailed) || null;
  if (!cd || cd.length < 2) return null;
  // ЧЕМ мерить доли, решает инварианта пула. Стейбл-пул держит монеты равными ПО
  // КОЛИЧЕСТВУ; крипто-пул (twocrypto/tricrypto — своя кривая с ценовой шкалой)
  // держит их равными ПО СТОИМОСТИ. Считать крипто-пул в токенах бессмысленно:
  // 16.8M crvUSD против 14.6K WETH дают «перекос 99.8%» на ровном пуле
  // (madeath_aa, crvecodev/2002).
  const byValue = /crypto/i.test(String((pool && pool.registryId) || ''));
  const units = [];
  for (const c of cd) {
    const dec = parseInt(c.decimals, 10);
    const u = parseFloat(c.poolBalance);
    if (!isFinite(u) || !isFinite(dec)) return null;
    let w = u / Math.pow(10, dec);
    if (byValue) {
      const pr = parseFloat(c.usdPrice);
      if (!isFinite(pr) || pr <= 0) return null;
      w *= pr;
    }
    units.push(w);
  }
  const total = units.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  const ideal = 1 / units.length;
  let best = 0;
  for (let i = 1; i < units.length; i++) {
    if (units[i] > units[best]) best = i;
  }
  return { pct: (units[best] / total / ideal - 1) * 100,
           coin: cd[best].symbol || '?',
           best,
           byValue,
           // перекос КАЖДОЙ монеты: подписка ставится на конкретную из них
           devs: units.map(u => (u / total / ideal - 1) * 100),
           syms: cd.map(c => c.symbol || '?'),
           coins: cd.map(c => c.symbol || '?').join(' / ') };
}
function _alertPctLabel(p) { return String(Math.abs(p)); }
function _alertSteps() { return _ALERT_STEPS; }

function _alertRefresh() {
  if (!_alertCtx) return;
  const inp = document.getElementById('alertLevelInput');
  const hint = document.getElementById('alertHint');
  const btn = document.getElementById('alertSubmit');
  const level = parseFloat(String(inp.value || '').replace(',', '.'));
  const now = _alertCtx.kind === 'b' ? _alertSkewNow() : _alertCtx.now;
  // Перекос принимает знак: −25% значит «разбуди, когда доля упадёт на четверть
  // ниже равной». Цена знака не имеет.
  const ok = isFinite(level) && (_alertCtx.kind === 'b' ? level !== 0 : level > 0);
  if (ok && _alertCtx.kind === 'b') _alertCtx.op = level >= 0 ? 'a' : 'b';
  btn.disabled = !ok;
  hint.className = 'alert-hint';
  if (!ok) {
    const typed = String(inp.value || '').trim();
    // Пустое поле у перекоса — место для примера: в самом placeholder он не
    // помещается (крупный моноширинный шрифт режет строку на середине).
    hint.textContent = typed
      ? (_alertCtx.kind === 'b' ? 'Enter a skew, plus or minus, but not zero.' : 'Enter a price above zero.')
      : (_alertCtx.kind === 'b' ? 'e.g. +50 — a 50/50 pool sitting at 75/25; \u221250 — the coin down to a quarter.' : '');
    return;
  }
  if (_alertCtx.kind === 'b') {
    if (now === null) { hint.textContent = ''; return; }
    const sym = _alertCtx.skew.syms[_alertCtx.coinIdx] || '';
    const up = _alertCtx.op === 'a';
    const already = up ? now >= level : now <= level;
    hint.className = already ? 'alert-hint warn' : 'alert-hint';
    hint.textContent = already
      ? `${sym} is already ${now >= 0 ? '+' : ''}${now.toFixed(1)}% ${now >= 0 ? 'over' : 'under'} its ideal share, so the alert fires at once.`
      : `${sym} now ${now >= 0 ? '+' : ''}${now.toFixed(1)}% \u2014 wake me ${up ? 'above' : 'below'} ${level > 0 ? '+' : ''}${level}%, an even share is 0%`
        + (_alertCtx.skew && _alertCtx.skew.byValue ? ', shares by value.' : '.');
    return;
  }
  if (!now) { hint.textContent = ''; return; }
  const diff = (level - now) / now * 100;
  const side = level >= now ? 'a' : 'b';
  const sign = diff >= 0 ? '+' : '';
  if (side !== _alertCtx.op) {
    hint.className = 'alert-hint warn';
    hint.textContent = `${sign}${diff.toFixed(2)}% from now — the price is already ${_alertCtx.op === 'a' ? 'above' : 'below'} this level, so the alert fires at once.`;
  } else {
    hint.textContent = `${sign}${diff.toFixed(2)}% from the current price.`;
  }
}

// Repeat mode rides along in the deep-link payload as a trailing field, so an
// old link without it still parses (Alexandr crvecodev/1945).
// Вкладка типа: 'p' — цена пары, 'b' — перекос балансов пула. Форма одна,
// меняются только единица, шкала чипов и подсказка (Alexandr crvecodev/1980).
function setAlertKind(kind) {
  if (!_alertCtx) return;
  if (kind === 'b' && !_alertCtx.skew) return;
  _alertCtx.kind = kind;
  document.querySelectorAll('#alertTabs .alert-seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.kind === kind);
  });
  const bal = kind === 'b';
  const inp = document.getElementById('alertLevelInput');
  document.getElementById('alertTitle').textContent = bal ? 'Pool skew alert' : 'Price alert';
  document.getElementById('alertPairName').textContent =
    bal ? ((_alertCtx.skew && _alertCtx.skew.coins) || _alertCtx.poolName || 'This pool')
        : (_alertCtx.pairText || 'This pair');
  // Above/Below осмысленны только у цены; у перекоса предмет выбора — МОНЕТА.
  const seg = document.getElementById('alertSeg');
  const coinsRow = document.getElementById('alertCoins');
  seg.style.display = bal ? 'none' : '';
  coinsRow.style.display = bal ? '' : 'none';
  if (bal) {
    coinsRow.innerHTML = '';
    _alertCtx.skew.syms.forEach((s, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'alert-seg-btn';
      b.dataset.coin = String(i);
      b.textContent = s;
      b.onclick = () => setAlertCoin(i);
      coinsRow.appendChild(b);
    });
    if (!(_alertCtx.coinIdx >= 0 && _alertCtx.coinIdx < _alertCtx.skew.syms.length)) {
      _alertCtx.coinIdx = _alertCtx.skew.best;
    }
  }
  document.getElementById('alertNowPrice').textContent = bal
    ? `${_alertCtx.skew.devs[_alertCtx.coinIdx] >= 0 ? '+' : ''}${_alertCtx.skew.devs[_alertCtx.coinIdx].toFixed(1)}% (${_alertCtx.skew.syms[_alertCtx.coinIdx]})`
    : (_alertCtx.sample || '--');
  document.getElementById('alertUnit').textContent = bal ? '%' : (_alertCtx.unit || '');
  inp.placeholder = bal ? '% from ideal balance' : '';
  inp.value = bal ? '' : (_alertCtx.sample || '');
  const steps = bal ? _SKEW_STEPS : _alertSteps();
  document.querySelectorAll('#alertChips .alert-chip').forEach((c, i) => {
    const v = steps[i];
    if (v === undefined) { c.style.display = 'none'; return; }
    c.style.display = (bal || (_alertCtx.now > 0)) ? '' : 'none';
    c.dataset.pct = String(v);
    c.textContent = (v > 0 ? '+' : '\u2212') + _alertPctLabel(v) + '%';
    c.onclick = () => {
      if (!_alertCtx) return;
      // Уровень перекоса ЗНАКОВЫЙ: + это перевес монеты, − недовес. Сторона
      // сравнения выводится из знака в _alertRefresh, отдельного переключателя
      // тут нет (crvecodev/1996 — чип не должен менять чужой выбор; crvecodev/2031
      // — ловить надо и падение доли, не только рост).
      if (_alertCtx.kind === 'b') { inp.value = String(v); _alertRefresh(); return; }
      if (!_alertCtx.now) return;
      inp.value = _alertFmt(_alertCtx.now * (1 + v / 100), _alertCtx.sample);
      setAlertOp(v >= 0 ? 'a' : 'b');
    };
  });
  if (bal) setAlertCoin(_alertCtx.coinIdx); else _alertRefresh();
}
window.setAlertKind = setAlertKind;

function setAlertMode(mode) {
  if (!_alertCtx) return;
  _alertCtx.mode = mode;
  document.querySelectorAll('#alertMode .alert-mode-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === mode);
  });
}
window.setAlertMode = setAlertMode;

// Перекос ВЫБРАННОЙ монеты. Отдельный хелпер, потому что величину спрашивают
// и подсказка, и submit, и переключатель монеты.
function _alertSkewNow() {
  const s = _alertCtx && _alertCtx.skew;
  if (!s || !s.devs) return null;
  const v = s.devs[_alertCtx.coinIdx];
  return isFinite(v) ? v : null;
}

function setAlertCoin(i) {
  if (!_alertCtx || !_alertCtx.skew) return;
  _alertCtx.coinIdx = i;
  document.querySelectorAll('#alertCoins .alert-seg-btn').forEach(b => {
    b.classList.toggle('active', Number(b.dataset.coin) === i);
  });
  const v = _alertSkewNow();
  document.getElementById('alertNowPrice').textContent =
    v === null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}% (${_alertCtx.skew.syms[i]})`;
  _alertRefresh();
}
window.setAlertCoin = setAlertCoin;

function setAlertOp(op) {
  if (!_alertCtx) return;
  _alertCtx.op = op;
  document.querySelectorAll('#alertSeg .alert-seg-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.op === op);
  });
  _alertRefresh();
}
window.setAlertOp = setAlertOp;

function closePriceAlert() {
  document.getElementById('priceAlertModal').classList.remove('show');
  _alertCtx = null;
}
window.closePriceAlert = closePriceAlert;

function submitPriceAlert() {
  if (!_alertCtx) return;
  const inp = document.getElementById('alertLevelInput');
  const level = parseFloat(String(inp.value || '').replace(',', '.'));
  const bad = !isFinite(level) || (_alertCtx.kind === 'b' ? level === 0 : level <= 0);
  if (bad) { _alertRefresh(); inp.focus(); return; }
  const { hops, inverted, op, mode } = _alertCtx;
  if (_alertCtx.kind === 'b') {
    const ch = (typeof activeChainKey !== 'undefined' && activeChainKey) ? activeChainKey : 'ethereum';
    const netB = ch === 'ethereum' ? '' : `_c${ch.replace(/[^a-z]/g, '')}`;
    // третье поле — индекс монеты (было направление a|b; бот читает оба вида).
    const pl = `b_${_alertCtx.poolPrefix}_${_alertCtx.coinIdx}_${String(level).replace('.', 'd')}_${mode || 'o'}${netB}`;
    closePriceAlert();
    _openAlertBot(pl);
    return;
  }
  // Ethereum stays unmarked: every link minted before networks existed means it,
  // and the bot reads a missing field exactly that way (Nik crvecodev/1962).
  const chain = (typeof activeChainKey !== 'undefined' && activeChainKey) ? activeChainKey : 'ethereum';
  const net = chain === 'ethereum' ? '' : `_c${chain.replace(/[^a-z]/g, '')}`;
  const payload = `h_${hops.join('_')}_${op}_${String(level).replace('.', 'd')}_${inverted ? '1' : '0'}_${mode || 'o'}${net}`;
  closePriceAlert();
  _openAlertBot(payload);
}
window.submitPriceAlert = submitPriceAlert;

// _askPriceAlert: shared tail of both bells — collect the level, open the bot deep-link.
function _askPriceAlert(hops, priceElId, inverted, unit, opts) {
  opts = opts || {};
  const priceEl = document.getElementById(priceElId);
  const shown = String(priceEl ? priceEl.textContent : '').replace(/[^0-9.]/g, '');
  const now = parseFloat(shown);
  // Вкладка перекоса живёт только там, где предмет — ОДИН пул: на составном
  // маршруте Trade перекос считать не от чего, и таб прячется целиком.
  // Предмет перекоса — ОДИН пул, и его передаёт вызывающая кнопка: на составном
  // маршруте Trade его нет, а на Yield цены пары на экране нет вовсе, поэтому
  // выводить наличие пула из имени элемента цены нельзя (Alexandr crvecodev/2011).
  const bPool = opts.pool || null;
  const skew = bPool ? _poolSkewNow(bPool) : null;
  _alertCtx = { hops, inverted, op: 'a', mode: 'o', kind: 'p', coinIdx: skew ? skew.best : 0,
                now: (isFinite(now) && now > 0) ? now : null, sample: shown,
                unit: (unit && unit.length <= 10) ? unit : '',
                skew, poolName: bPool ? (bPool.name || '') : '',
                poolPrefix: bPool ? bPool.address.slice(2, 14) : '' };
  const tabs = document.getElementById('alertTabs');
  if (tabs) tabs.style.display = skew ? '' : 'none';

  const nameEl = document.getElementById(priceElId === 'chartPrice' ? 'poolPairName' : 'tradePairName');
  // Join the child spans with a space: the swap arrow between the tickers is an
  // icon with no text of its own, so a plain textContent glues them into 'DAIUSDC'.
  const pairText = nameEl ? Array.from(nameEl.childNodes).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim() : '';
  _alertCtx.pairText = pairText || 'This pair';

  const inp = document.getElementById('alertLevelInput');
  inp.oninput = _alertRefresh;
  inp.onkeydown = e => { if (e.key === 'Enter') submitPriceAlert(); if (e.key === 'Escape') closePriceAlert(); };

  setAlertOp('a');
  setAlertMode('o');
  // Вкладка по умолчанию: на Yield предмет — пул, там сразу перекос.
  setAlertKind(opts.kind === 'b' && skew ? 'b' : 'p');
  document.getElementById('priceAlertModal').classList.add('show');
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
}

// _openAlertBot: сперва tg://resolve — приложение открывается сразу, без промежуточной
// страницы t.me. Если схему никто не перехватил (нет приложения / браузер её не знает),
// страница остаётся видимой — тогда через 1.2 с уходим на обычную t.me-ссылку, иначе
// клик был бы мёртвым и человек не увидел бы вообще ничего.
function _openAlertBot(payload) {
  const web = `https://t.me/curvedex_alerts_bot?start=${payload}`;
  let left = false;
  const gone = () => { left = true; };
  document.addEventListener('visibilitychange', gone, { once: true });
  window.addEventListener('blur', gone, { once: true });
  window.location.href = `tg://resolve?domain=curvedex_alerts_bot&start=${payload}`;
  setTimeout(() => {
    document.removeEventListener('visibilitychange', gone);
    window.removeEventListener('blur', gone);
    if (!left && !document.hidden) window.open(web, '_blank', 'noopener');
  }, 1200);
}

// openPoolPairAlert: bell on the Pools rich header. The pool chart requests OHLC with
// main = coinsAddresses[fromIdx], reference = coinsAddresses[toIdx] and then flips the
// series when poolPriceInverted — the alert carries exactly the same two indices + flag.
function openPoolPairAlert() {
  const pool = (typeof selectedPool !== 'undefined') ? selectedPool : null;
  if (!pool || !pool.coinsAddresses || pool.coinsAddresses.length < 2) { alert('Open a pool first.'); return; }
  // main = TO, ref = FROM — same order the chart asks the price API for.
  const mainIdx = (typeof selectedToToken !== 'undefined' && selectedToToken) ? selectedToToken.index : 1;
  const refIdx = (typeof selectedFromToken !== 'undefined' && selectedFromToken) ? selectedFromToken.index : 0;
  if (mainIdx === refIdx || !pool.coinsAddresses[mainIdx] || !pool.coinsAddresses[refIdx]) {
    alert('Alerts are not available for this pool yet.'); return;
  }
  const inv = (typeof poolPriceInverted !== 'undefined') && poolPriceInverted;
  const coins = pool.coins || [];
  _askPriceAlert([`${pool.address.slice(2, 14)}-${mainIdx}-${refIdx}`], 'chartPrice', inv,
                 inv ? coins[refIdx] : coins[mainIdx], { pool });
}
window.openPoolPairAlert = openPoolPairAlert;

// Колокольчик в шапке Yield. Предмет вкладки — пул, а не пара, поэтому форма
// открывается сразу на перекосе; ценника на экране нет, и «Now» у Price пустое.
function openYieldPoolAlert() {
  const pool = (typeof selectedPool !== 'undefined') ? selectedPool : null;
  if (!pool || !pool.coinsAddresses || pool.coinsAddresses.length < 2) { alert('Open a pool first.'); return; }
  _askPriceAlert([`${pool.address.slice(2, 14)}-1-0`], 'yieldNoPrice', false,
                 (pool.coins || [])[1] || '', { pool, kind: 'b' });
}
window.openYieldPoolAlert = openYieldPoolAlert;
