// ============================================================
// gauge_weights.js — current + prev-week + next-week gauge weights & ranks
// ------------------------------------------------------------
// PUBLIC API:
//   window.GaugeWeights.ensure()         -> Promise; idempotent, lazy-loads
//   window.GaugeWeights.getForGauge(addr) -> {currentPct, prevPct, deltaPct, forecastPct, forecastDeltaPct, forecastCrvApy, forecastCrvApyBase, rank, prevRank, rankDelta} | null
//   window.GaugeWeights.getCurrentMap()  -> Map<gauge_addr_lower, {currentPct, rank}>
//   window.GaugeWeights.onReady(fn)      -> fires fn(map) when ready (or immediately if already ready)
//
// DATA SOURCES:
//   * Current: gauge_relative_weight from getAllGauges API (already loaded by app.js).
//   * Previous-week: on-chain gauge_controller.gauge_relative_weight(addr, prev_week_ts)
//     via rpcCall(). Cached in localStorage per prev_week_ts.
//   * Next-week (FORECAST, real votes): gauge_future_relative_weight from getAllGauges
//     API. This is the on-chain projection at next-Thursday epoch flip — no
//     extrapolation, just the deterministic outcome of currently locked
//     vote_user_slopes. Linear extrapolation rejected by tester (msg 282) as
//     semantically wrong; we now use authoritative API data instead.
//   * Next-week CRV APY: gaugeFutureCrvApy[1] (max boost) from the same API.
// ============================================================

(function() {
  'use strict';
  const GAUGE_CONTROLLER = '0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB';
  // Selector for gauge_relative_weight(address,uint256). Verified via 4byte.directory.
  const SEL_GRW = '0xd3078c94';
  const WEEK = 604800;
  const STORAGE_KEY_PREFIX = 'curvedex_gauge_prev_';
  // Concurrent on-chain reads. Public RPC pool already round-robins, so 8 in-flight is fine.
  const PARALLEL = 8;

  let _state = {
    ready: false,
    promise: null,
    map: new Map(),       // gauge_addr_lower -> {currentPct, prevPct, deltaPct, rank, prevRank, rankDelta}
    currentMap: new Map(),// gauge_addr_lower -> {currentPct, rank}  (subset, available before prev-week loaded)
    listeners: [],
  };

  function prevWeekTs() {
    const now = Math.floor(Date.now() / 1000);
    return Math.floor(now / WEEK) * WEEK - WEEK;
  }

  function pad32(hex) {
    return hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  }

  function pctFromWei(weiHex) {
    if (!weiHex || weiHex === '0x') return 0;
    try {
      // BigInt division: result = weight / 1e18 * 100 = weight / 1e16
      const w = BigInt(weiHex);
      // To get a float pct: Number((w * 10000n) / 10n**18n) / 100  -> 4 decimals retained
      return Number((w * 10000n) / 10n**18n) / 100;
    } catch (e) {
      return 0;
    }
  }

  // Convert raw gauge_controller weight (1e18 scale, hex or decimal string) to
  // percent with 4-decimal precision. Returns 0 on parse failure.
  function rawToPct(raw) {
    if (raw == null) return 0;
    try {
      const w = BigInt(raw);
      return Number((w * 10000n) / 10n**18n) / 100;
    } catch (e) {
      return 0;
    }
  }

  // Pull gaugeFutureCrvApy max-boost value (index 1 = boosted, index 0 = base).
  // We surface the boosted value because that's what veCRV/Convex/StakeDAO
  // depositors will actually realize. Returns null if not present.
  function readFutureCrvApy(v) {
    const a = v && v.gaugeFutureCrvApy;
    if (!Array.isArray(a) || a.length < 2) return null;
    const x = Number(a[1]);
    return Number.isFinite(x) && x > 0 ? x : null;
  }
  // Base (no-boost) projected CRV APR — gaugeFutureCrvApy[0]. Used for tooltip
  // range (base → max-boost). Returns null if not present.
  function readFutureCrvApyBase(v) {
    const a = v && v.gaugeFutureCrvApy;
    if (!Array.isArray(a) || a.length < 1) return null;
    const x = Number(a[0]);
    return Number.isFinite(x) && x > 0 ? x : null;
  }

  function loadCurrentFromGauges() {
    const data = window.gaugesData || {};
    const items = []; // {gaugeAddr, currentPct, futurePct, futureCrvApy, isKilled}
    for (const k of Object.keys(data)) {
      const v = data[k];
      const ga = (v && v.gauge) ? String(v.gauge).toLowerCase() : null;
      if (!ga) continue;
      // Skip side-chain gauges (not in mainnet gauge_controller).
      if (v.side_chain) continue;
      const blockchain = (v.blockchainId || '').toLowerCase();
      const expected = (typeof window !== 'undefined' && window.getChainKey ? window.getChainKey() : 'ethereum');
      if (blockchain && blockchain !== expected) continue;
      const gc = v.gauge_controller || {};
      const pct = rawToPct(gc.gauge_relative_weight);
      // gauge_future_relative_weight: next-Thursday weight derived from
      // currently locked vote_user_slopes. Authoritative, not extrapolated.
      const futurePct = rawToPct(gc.gauge_future_relative_weight);
      const futureCrvApy = readFutureCrvApy(v);
      const futureCrvApyBase = readFutureCrvApyBase(v);
      items.push({
        gaugeAddr: ga,
        currentPct: pct,
        futurePct: futurePct,
        futureCrvApy: futureCrvApy,
        futureCrvApyBase: futureCrvApyBase,
        isKilled: !!v.is_killed,
      });
    }
    // Rank by current weight desc; killed gauges with 0 still get a rank but go last.
    items.sort((a, b) => b.currentPct - a.currentPct);
    const currentMap = new Map();
    items.forEach((it, idx) => {
      currentMap.set(it.gaugeAddr, {
        currentPct: it.currentPct,
        futurePct: it.futurePct,
        futureCrvApy: it.futureCrvApy,
        futureCrvApyBase: it.futureCrvApyBase,
        rank: idx + 1,
        isKilled: it.isKilled,
      });
    });
    return currentMap;
  }

  async function fetchPrevWeekWeights(gaugeAddrs, prevTs) {
    const tsHex = pad32(BigInt(prevTs).toString(16));
    const cacheKey = STORAGE_KEY_PREFIX + prevTs;
    let cache = {};
    try {
      const raw = localStorage.getItem(cacheKey);
      if (raw) cache = JSON.parse(raw) || {};
    } catch (e) {}

    // FAST PATH: try server-side weekly snapshot JSON first (Phase 2). The
    // collector stores weights keyed by week_idx = floor(ts / WEEK). If the
    // file exists, it covers all gauges at once (no on-chain RPC at all).
    const prevWeekIdx = Math.floor(prevTs / WEEK);
    const todoBefore = gaugeAddrs.filter(a => cache[a] === undefined);
    if (todoBefore.length > 0) {
      try {
        const snapUrl = ((typeof window !== 'undefined' && window.__DYNAMIC_BASE) || '') + `/curvedex/collector/gauge_weights_${prevWeekIdx}.json`;
        const r = await fetch(snapUrl, { cache: 'force-cache' });
        if (r.ok) {
          const snap = await r.json();
          const w = (snap && snap.weights) ? snap.weights : null;
          if (w) {
            for (const a of todoBefore) {
              const v = w[a];
              if (typeof v === 'number') cache[a] = v;
            }
            try { localStorage.setItem(cacheKey, JSON.stringify(cache)); } catch (e) {}
          }
        }
      } catch (e) {
        // Snapshot missing or unreachable — fall through to on-chain RPC path.
      }
    }

    const todo = gaugeAddrs.filter(a => cache[a] === undefined);
    if (todo.length === 0) return cache;

    // Run in waves of PARALLEL.
    const result = { ...cache };
    let cursor = 0;
    async function worker() {
      while (cursor < todo.length) {
        const i = cursor++;
        const ga = todo[i];
        const data = SEL_GRW + pad32(ga.replace(/^0x/, '')) + tsHex;
        try {
          const r = await rpcCall(data, GAUGE_CONTROLLER);
          result[ga] = pctFromWei(r);
        } catch (e) {
          // Mark explicit null on failure so we don't retry spam this session;
          // localStorage persists across reloads for the whole week.
          result[ga] = null;
        }
      }
    }
    const workers = [];
    for (let k = 0; k < Math.min(PARALLEL, todo.length); k++) workers.push(worker());
    await Promise.all(workers);

    try { localStorage.setItem(cacheKey, JSON.stringify(result)); } catch (e) {}
    // Sweep older keys (keep at most 4 weeks of cache).
    try {
      const keysToScan = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(STORAGE_KEY_PREFIX)) keysToScan.push(k);
      }
      const cutoff = prevTs - 4 * WEEK;
      for (const k of keysToScan) {
        const t = parseInt(k.slice(STORAGE_KEY_PREFIX.length), 10);
        if (Number.isFinite(t) && t < cutoff) localStorage.removeItem(k);
      }
    } catch (e) {}

    return result;
  }

  async function _build() {
    const currentMap = loadCurrentFromGauges();
    _state.currentMap = currentMap;
    if (currentMap.size === 0) {
      _state.ready = true;
      _state.map = new Map();
      _flushListeners();
      return;
    }

    const prevTs = prevWeekTs();
    const addrs = Array.from(currentMap.keys());
    let prevByAddr = {};
    try {
      prevByAddr = await fetchPrevWeekWeights(addrs, prevTs);
    } catch (e) {
      console.warn('[gauge_weights] prev-week fetch failed:', e);
      prevByAddr = {};
    }

    // Build prev-week ranks.
    const prevItems = addrs.map(a => ({
      gaugeAddr: a,
      prevPct: typeof prevByAddr[a] === 'number' ? prevByAddr[a] : null,
    }));
    // Sort: known prev pct desc, unknown last.
    prevItems.sort((a, b) => {
      if (a.prevPct == null && b.prevPct == null) return 0;
      if (a.prevPct == null) return 1;
      if (b.prevPct == null) return -1;
      return b.prevPct - a.prevPct;
    });
    const prevRankByAddr = new Map();
    prevItems.forEach((it, idx) => {
      if (it.prevPct != null) prevRankByAddr.set(it.gaugeAddr, idx + 1);
    });

    const finalMap = new Map();
    for (const [ga, cur] of currentMap.entries()) {
      const prevPct = (typeof prevByAddr[ga] === 'number') ? prevByAddr[ga] : null;
      const prevRank = prevRankByAddr.has(ga) ? prevRankByAddr.get(ga) : null;
      const deltaPct = (prevPct != null) ? (cur.currentPct - prevPct) : null;
      // Forecast (Phase 2, msg 282): real next-week weight from
      // gauge_future_relative_weight. Authoritative — not a linear trend.
      // Hide if both current and future are 0 (irrelevant gauge).
      const futurePct = (typeof cur.futurePct === 'number') ? cur.futurePct : null;
      const forecastPct = (futurePct != null && (futurePct > 0 || cur.currentPct > 0))
        ? futurePct
        : null;
      const forecastDeltaPct = (forecastPct != null && cur.currentPct != null)
        ? (forecastPct - cur.currentPct)
        : null;
      finalMap.set(ga, {
        currentPct: cur.currentPct,
        prevPct: prevPct,
        deltaPct: deltaPct,
        forecastPct: forecastPct,
        forecastDeltaPct: forecastDeltaPct,
        forecastCrvApy: cur.futureCrvApy,
        forecastCrvApyBase: cur.futureCrvApyBase,
        rank: cur.rank,
        prevRank: prevRank,
        // rankDelta: positive = moved UP (lower rank number is higher position)
        rankDelta: (prevRank != null) ? (prevRank - cur.rank) : null,
        isKilled: cur.isKilled,
      });
    }
    _state.map = finalMap;
    _state.ready = true;
    _flushListeners();
  }

  function _flushListeners() {
    const fns = _state.listeners.splice(0);
    for (const fn of fns) {
      try { fn(_state.map); } catch (e) { console.warn('[gauge_weights] listener error:', e); }
    }
  }

  function ensure() {
    if (_state.ready) return Promise.resolve(_state.map);
    if (_state.promise) return _state.promise;
    _state.promise = _build().catch(e => {
      console.error('[gauge_weights] build failed:', e);
      _state.ready = true;     // mark ready anyway so callers don't hang
      _state.map = new Map();
      _flushListeners();
    }).then(() => _state.map);
    return _state.promise;
  }

  // Force rebuild — call after gaugesData has been (re)populated by loadGaugesData().
  // The cache-hit path lets ensure() run before gauges arrive, latching an empty map.
  function rebuild() {
    _state.ready = false;
    _state.promise = null;
    _state.map = new Map();
    return ensure();
  }

  function getForGauge(addr) {
    if (!addr) return null;
    return _state.map.get(addr.toLowerCase()) || null;
  }

  function getCurrentMap() { return _state.currentMap; }

  function onReady(fn) {
    if (_state.ready) { try { fn(_state.map); } catch (e) {} return; }
    _state.listeners.push(fn);
  }

  function isReady() { return _state.ready; }

  window.GaugeWeights = { ensure, rebuild, getForGauge, getCurrentMap, onReady, isReady };
})();
