// ============================================================
// Convex Finance + StakeDAO APR (per Curve pool)
// ============================================================
// Caches: 60s — yields don't change frequently
let _convexCache = null;     // { ts, byPoolAddr: Map<lowerAddr, {total,base,crv,cvx,extra}> }
let _stakedaoCache = null;   // { ts, byLpAddr: Map, byGaugeAddr: Map<lowerAddr, {total, boost}> }
const YIELD_3RDPARTY_TTL = 60 * 1000;

async function fetchConvexYields() {
  if (_convexCache && Date.now() - _convexCache.ts < YIELD_3RDPARTY_TTL) return _convexCache.byPoolAddr;
  const chainKey = (typeof window !== 'undefined' && window.getChainKey) ? window.getChainKey() : 'ethereum';
  // Sidechain Convex uses on-chain Multicall3 reads (no public JSON API).
  if (chainKey !== 'ethereum') {
    try {
      const byPoolAddr = await _fetchConvexSidechainYields(chainKey);
      _convexCache = { ts: Date.now(), byPoolAddr };
      return byPoolAddr;
    } catch (e) {
      console.warn('[convex] sidechain on-chain fetch failed:', e);
      return _convexCache?.byPoolAddr || new Map();
    }
  }
  try {
    const [apysResp, poolsResp] = await Promise.all([
      fetch('https://curve.convexfinance.com/api/curve-apys'),
      fetch('https://curve.convexfinance.com/api/curve/pools'),
    ]);
    if (!apysResp.ok || !poolsResp.ok) throw new Error('convex http');
    const apys = (await apysResp.json()).apys || {};
    const pools = (await poolsResp.json()).pools || [];
    const byId = new Map(pools.map(p => [p.id, p]));
    const byPoolAddr = new Map();
    // Convex protocol fee (msg ~2026-05-18 from Александр): Convex API `/api/curve-apys`
    // returns GROSS rewards (max-boost projected, ignoring 17% Convex protocol fee taken
    // off CRV/CVX/extra emissions before distribution to LP stakers). To align UI with
    // Convex's own "Current vAPR" column (what user actually gets today net-of-fee),
    // multiply CRV/CVX/extra by (1 - 0.17). baseApy from trading fees is unaffected.
    // Note: this still over-states reality vs true Current — full Current also requires
    // applying effective boost factor (working_supply / lp_share×2.5) which is on-chain
    // multicall work (not yet implemented here).
    const CONVEX_PROTOCOL_FEE = 0.17;
    const CVX_NET_MULT = 1 - CONVEX_PROTOCOL_FEE; // 0.83
    for (const [poolId, a] of Object.entries(apys)) {
      const meta = byId.get(poolId);
      if (!meta) continue;
      const base = Number(a.baseApy) || 0;
      const crvGross = Number(a.crvApy) || 0;
      const cvxGross = Number(a.cvxApy) || 0;
      const extras = Array.isArray(a.extraRewards) ? a.extraRewards : [];
      const extraGrossSum = extras.reduce((s, r) => s + (Number(r.apy) || 0), 0);
      // Apply 17% Convex protocol fee to emission-based rewards
      const crv = crvGross * CVX_NET_MULT;
      const cvx = cvxGross * CVX_NET_MULT;
      const extraSum = extraGrossSum * CVX_NET_MULT;
      const total = base + crv + cvx + extraSum;
      // Filter out clearly-broken entries (ridiculous APR fields like crvApy=1e8)
      if (!isFinite(total) || total > 100000) continue;
      // pid = booster pool index — Convex API exposes it under convexPoolData.id (top-level pid not present).
      // Used for Convex stake URL pattern /stake/ethereum/{pid}.
      const pid = (meta.convexPoolData?.id != null) ? Number(meta.convexPoolData.id)
                : (meta.pid != null) ? Number(meta.pid) : null;
      const entry = { total, base, crv, cvx, extra: extraSum, boost: Number(a.crvBoost) || 1, pid };
      if (meta.address) byPoolAddr.set(meta.address.toLowerCase(), entry);
      if (meta.lpTokenAddress) byPoolAddr.set(meta.lpTokenAddress.toLowerCase(), entry);
    }
    _convexCache = { ts: Date.now(), byPoolAddr };
    return byPoolAddr;
  } catch (e) {
    console.warn('Convex yields fetch failed:', e);
    return _convexCache?.byPoolAddr || new Map();
  }
}

// ============================================================
// Convex Sidechain APR via on-chain Multicall3 (no JSON API exists for
// Arbitrum/Polygon/Fraxtal — only mainnet has /api/curve-apys).
// Per Convex sidechain-platform/contracts/contracts.json: Booster.poolInfo(pid)
// returns (lptoken, gauge, rewards, shutdown, factory) — 5 fields, vs 6 on
// mainnet. IRewards on sidechain exposes rewardRate() + totalSupply() the
// same way; CRV emission APR = (rewardRate × SECS_YEAR × CRV_USD) / (totalSupply × LP_USD).
// CVX/extra rewards on sidechains use ExtraRewardPool stash — out of scope
// for v1; treated as 0 here. Boost is fixed x1 for sidechain Booster (no veCRV).
// ============================================================
const SIDECHAIN_BOOSTER_ABI = [
  'function poolLength() view returns (uint256)',
  'function poolInfo(uint256) view returns (address lptoken, address gauge, address rewards, bool shutdown, address factory)',
];
const SIDECHAIN_REWARDS_ABI = [
  'function rewardRate() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
];
const MULTICALL3_AGGREGATE3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];
const SECONDS_PER_YEAR = 31_556_952;

async function _fetchConvexSidechainYields(chainKey) {
  const cfg = (typeof CHAINS_CONFIG !== 'undefined') ? CHAINS_CONFIG : window.CHAINS_CONFIG;
  const c = cfg?.chains?.[chainKey];
  if (!c?.convexBooster) return new Map();
  if (typeof ethers === 'undefined') { try { await loadEthers(); } catch { return new Map(); } }

  // Sidechain Convex has no veCRV boost and no CVX distribution to LP stakers
  // — it forwards Curve gauge rewards minus a small management fee. That
  // means Convex sidechain APR is always slightly LOWER than direct Curve
  // gauge staking, so the "Cx wins" total-APR badge will (correctly) not
  // fire on sidechains. What we DO surface: the Convex Pool action link
  // (curve.convexfinance.com/stake/<chain>/<pid>) for users who prefer
  // Convex's UI / auto-compound. v1 only exposes pid mapping; explicit
  // bonus = 0 so badge logic is a no-op.
  // The rewards-contract ABI on sidechain differs from mainnet (no
  // rewardRate/periodFinish view); implementing accurate per-pool APR
  // needs a separate multi-token rewards walk (rewardLength / rewards(i))
  // — deferred until requested.
  const rpcUrl = (window.getChainRpcs?.() || c.rpc || [])[0];
  if (!rpcUrl) return new Map();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const multicall = new ethers.Contract(c.multicall3, MULTICALL3_AGGREGATE3_ABI, provider);
  const boosterIface = new ethers.Interface(SIDECHAIN_BOOSTER_ABI);

  const boosterCtr = new ethers.Contract(c.convexBooster, SIDECHAIN_BOOSTER_ABI, provider);
  const N = Number(await boosterCtr.poolLength());
  if (!N) return new Map();

  const piCalls = Array.from({ length: N }, (_, i) => ({
    target: c.convexBooster, allowFailure: true,
    callData: boosterIface.encodeFunctionData('poolInfo', [i]),
  }));
  const piResults = await multicall.aggregate3.staticCall(piCalls);
  const byPoolAddr = new Map();
  for (let i = 0; i < piResults.length; i++) {
    const r = piResults[i];
    if (!r.success) continue;
    try {
      const d = boosterIface.decodeFunctionResult('poolInfo', r.returnData);
      if (d[3] === true) continue; // shutdown
      const entry = { total: 0, base: 0, crv: 0, cvx: 0, extra: 0, boost: 1, pid: i };
      byPoolAddr.set(d[0].toLowerCase(), entry);
    } catch { /* skip undecodable rows */ }
  }
  return byPoolAddr;
}

// StakeDAO hub endpoint lacks CORS headers, so we fetch via r.jina.ai
// (markdown-wrapped) and parse out the JSON body. As a defensive fallback
// we also merge the GitHub raw legacy v1 feed (CORS=* but small coverage).
async function fetchStakeDaoYields() {
  if (_stakedaoCache && Date.now() - _stakedaoCache.ts < YIELD_3RDPARTY_TTL) return _stakedaoCache;
  const byLpAddr = new Map();
  const byGaugeAddr = new Map();

  // Strict EVM-address shape — schema barrier for `r.jina.ai`-proxied StakeDAO
  // payload. The substring-scan parser below picks the first `[{...}]` block
  // out of the markdown wrapper, so any attacker (or future jina rewrite) who
  // can land a JSON-looking blob earlier wins parser priority. Each entry that
  // reaches Maps/DOM must pass this gate.
  const _isAddr = (s) => typeof s === 'string' && /^0x[a-fA-F0-9]{40}$/.test(s);
  function ingestVault(v, opts) {
    if (v?.protocol !== 'curve') return;
    // Only ingest vaults matching the currently active chain. StakeDAO hub
    // returns all chains in one feed; previously hard-coded to chainId === 1
    // (Ethereum-only), now reads activeChainId from the multi-chain config.
    const expectedChainId = (typeof window !== 'undefined' && window.getChainId ? window.getChainId() : 1);
    if (v?.chainId !== expectedChainId) return;
    const total = Number(v?.apr?.current?.total);
    if (!isFinite(total) || total < 0 || total > 100000) return;
    const boost = Number(v?.apr?.boost) || 1;
    // Include `vault` (ERC4626-ish wrapper). Some users deposit but don't stake the
    // sdLP receipt — vault.balanceOf(user) is the only way to detect those balances.
    // Both API feeds (hub + github fallback) expose a top-level `vault` field.
    const vaultAddr = _isAddr(v?.vault) ? v.vault : null;
    // Parse breakdown to isolate true extras (non-CRV, non-tradingFee rewards: SDT-boost, partner tokens).
    // SD total = tradingFees + CRV_with_boost + extras. Trading fees already counted in pool.baseApy
    // (Curve side), CRV emission compared separately via gauge avg — so neither qualifies as Ext.
    let extras = 0;
    let tradingFees = 0;
    let crv = 0;
    const details = v?.apr?.current?.details;
    if (Array.isArray(details)) {
      for (const d of details) {
        const label = String(d?.label || '').toLowerCase();
        const val = Array.isArray(d?.value) ? Number(d.value[0]) : Number(d?.value);
        if (!isFinite(val) || val <= 0) continue;
        if (label.includes('trading fee') || label.includes('fee apy')) { tradingFees += val; continue; }
        if (label.includes('crv apr') || label.startsWith('crv ')) { crv += val; continue; }
        extras += val;
      }
    }
    // Bonus = everything SD adds on top of Curve baseApy: CRV (with boost) + extras.
    // tradingFees overlap with Curve baseApy and must be excluded to avoid double-counting.
    const bonus = crv + extras;
    const entry = { total, boost, vault: vaultAddr, extras, tradingFees, crv, bonus };
    const lp = v?.lpToken?.address;
    const gauge = v?.gaugeAddress || v?.gauge?.address;
    // Reject entries whose only routing keys are malformed (defends against
    // attacker-injected jina payload making it into address-keyed Maps).
    if (!_isAddr(lp) && !_isAddr(gauge)) return;
    const allowOverwrite = !opts?.fillOnly;
    if (_isAddr(lp)) {
      const k = lp.toLowerCase();
      if (allowOverwrite || !byLpAddr.has(k)) byLpAddr.set(k, entry);
    }
    if (_isAddr(gauge)) {
      const k = gauge.toLowerCase();
      if (allowOverwrite || !byGaugeAddr.has(k)) byGaugeAddr.set(k, entry);
    }
  }

  // Primary: hub via r.jina.ai (markdown wrapper around JSON body)
  try {
    const resp = await fetch('https://r.jina.ai/https://hub.stakedao.org/v1/vaults');
    if (resp.ok) {
      const text = await resp.text();
      // Extract JSON array — find first '[' after "Markdown Content:"
      const startIdx = text.indexOf('[{');
      if (startIdx >= 0) {
        const endIdx = text.lastIndexOf('}]') + 2;
        const jsonStr = text.slice(startIdx, endIdx);
        try {
          const arr = JSON.parse(jsonStr);
          if (Array.isArray(arr)) for (const v of arr) ingestVault(v);  // primary, allow overwrite
        } catch (parseErr) {
          console.warn('StakeDAO hub jina parse failed:', parseErr);
        }
      }
    }
  } catch (e) {
    console.warn('StakeDAO hub via jina fetch failed:', e);
  }

  // Fallback: GitHub raw legacy v1 (CORS=*, 78 vaults). Only fills gaps.
  try {
    const resp2 = await fetch('https://raw.githubusercontent.com/stake-dao/api/refs/heads/main/api/strategies/curve/index.json');
    if (resp2.ok) {
      const json = await resp2.json();
      const deployed = Array.isArray(json?.deployed) ? json.deployed : [];
      // Fallback: only fill gaps that hub didn't provide
      for (const v of deployed) ingestVault(v, { fillOnly: true });
    }
  } catch (e) {
    console.warn('StakeDAO github raw fetch failed:', e);
  }

  _stakedaoCache = { ts: Date.now(), byLpAddr, byGaugeAddr };
  return _stakedaoCache;
}

function lookupConvexApr(pool, convexMap) {
  if (!pool || !convexMap) return null;
  const addr = pool.address?.toLowerCase();
  if (addr && convexMap.has(addr)) return convexMap.get(addr);
  const lp = (pool.lpTokenAddress || '').toLowerCase();
  if (lp && convexMap.has(lp)) return convexMap.get(lp);
  return null;
}

function lookupStakeDaoApr(pool, sdCache) {
  if (!pool || !sdCache) return null;
  const gauge = (pool.gaugeAddress || '').toLowerCase();
  if (gauge && sdCache.byGaugeAddr?.has(gauge)) return sdCache.byGaugeAddr.get(gauge);
  const lp = (pool.lpTokenAddress || '').toLowerCase();
  if (lp && sdCache.byLpAddr?.has(lp)) return sdCache.byLpAddr.get(lp);
  const addr = pool.address?.toLowerCase();
  if (addr && sdCache.byLpAddr?.has(addr)) return sdCache.byLpAddr.get(addr);
  return null;
}

// ============================================================
// Curve.finance deposit URL (used by external-link icon next to tickers)
// Tester 266249857 (2026-05-01): "было бы еще удобно в заголовке пула
// сделать иконку со ссылкой на его deposit на Curve непосредственно".
// ============================================================
const _CURVE_CHAIN_NAMES = {
  1: 'ethereum', 137: 'polygon', 42161: 'arbitrum', 10: 'optimism',
  8453: 'base', 100: 'gnosis', 43114: 'avalanche', 250: 'fantom',
};
function _curvePoolDepositUrl(pool) {
  if (!pool) return null;
  // Curve API supplies poolUrls.deposit[0] for most registered pools.
  // Prefer that — it already contains the canonical pool name slug.
  const apiUrl = pool.poolUrls?.deposit?.[0];
  if (typeof apiUrl === 'string' && apiUrl.startsWith('http')) return apiUrl;
  const chain = _CURVE_CHAIN_NAMES[pool.chainId || 1] || 'ethereum';
  // Fall back to address-based URL — Curve UI accepts pool address as path
  // segment as well as the slug name. Trailing slash + 'deposit' to land on
  // the deposit tab specifically.
  const slug = pool.name || pool.address;
  if (!slug) return null;
  return `https://curve.finance/dex/${chain}/pools/${slug}/deposit/`;
}
function _curvePoolLinkHtml(pool) {
  const url = _curvePoolDepositUrl(pool);
  if (!url) return '';
  return ` <a class="pool-curve-link" href="${url}" target="_blank" rel="noopener noreferrer" title="Open this pool's Deposit page on Curve" onclick="event.stopPropagation();" aria-label="Open on Curve.finance"><svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-external-link"/></svg></a>`;
}
// Expose globally so trade.js can reuse the same helper.
window._curvePoolLinkHtml = _curvePoolLinkHtml;
window._curvePoolDepositUrl = _curvePoolDepositUrl;

// Render the two new KPIs for current selectedPool. Async — does not block header.
async function updateThirdPartyYields() {
  const pool = selectedPool;
  if (!pool) return;
  const cvxEl = document.getElementById('kpiConvexApy');
  const sdEl = document.getElementById('kpiStakeDaoApy');
  if (!cvxEl || !sdEl) return;
  // Loading state — only if currently '--'
  if (cvxEl.textContent === '--') cvxEl.textContent = '...';
  if (sdEl.textContent === '--') sdEl.textContent = '...';
  const poolAddrAtRequest = pool.address;
  try {
    const [convexMap, sdCache] = await Promise.all([
      fetchConvexYields(),
      fetchStakeDaoYields(),
    ]);
    // Stale guard — pool may have changed during await
    if (!selectedPool || selectedPool.address !== poolAddrAtRequest) return;
    const cvx = lookupConvexApr(pool, convexMap);
    const sd = lookupStakeDaoApr(pool, sdCache);
    // Ensure pool.cvxApr/sdApr/_cvxTotalUniform/etc populated so header KPIs match table TOTAL
    // — both display on uniform Curve 7d base. Skip if mergePlatformAprs already did it.
    if (cvx && pool.cvxApr == null) pool.cvxApr = cvx;
    if (sd && pool.sdApr == null) pool.sdApr = sd;
    if (typeof mergePlatformAprs === 'function' && (pool._cvxTotalUniform === undefined || pool._sdTotalUniform === undefined)) {
      try { mergePlatformAprs(); } catch (e) { /* tolerate */ }
    }
    // KPI Convex/StakeDAO display platform total reconstructed on uniform 7d base
    // (pool.weeklyApy + platform bonus) so it lines up with table TOTAL semantics.
    const baseUniform = (typeof _safe === 'function' ? _safe(pool.weeklyApy) : (pool.weeklyApy || 0));
    const cvxUniform = pool._cvxTotalUniform != null
      ? pool._cvxTotalUniform
      : (cvx ? baseUniform + (cvx.crv || 0) + (cvx.cvx || 0) + (cvx.extra || 0) : null);
    const sdUniform = pool._sdTotalUniform != null
      ? pool._sdTotalUniform
      : (sd ? baseUniform + (sd.bonus || 0) : null);
    cvxEl.textContent = cvxUniform != null ? fmtPct(cvxUniform) : '—';
    cvxEl.title = cvx
      ? `Base ${fmtPct(baseUniform)} (Curve 7d) + CRV ${fmtPct(cvx.crv)} (boost ${cvx.boost.toFixed(2)}x) + CVX ${fmtPct(cvx.cvx)}${cvx.extra ? ' + Extra ' + fmtPct(cvx.extra) : ''} | Convex raw ${fmtPct(cvx.total)}`
      : 'Pool not listed on Convex';
    sdEl.textContent = sdUniform != null ? fmtPct(sdUniform) : '—';
    sdEl.title = sd
      ? `Base ${fmtPct(baseUniform)} (Curve 7d) + CRV ${fmtPct(sd.crv || 0)} (boost ${sd.boost.toFixed(2)}x)${sd.extras ? ' + Extras ' + fmtPct(sd.extras) : ''} | StakeDAO raw ${fmtPct(sd.total)}`
      : 'Pool not listed on StakeDAO';
    // Refresh KPI Total now that bestTotalApy is finalized post-fetch
    const kpiTotalEl = document.getElementById('kpiTotalApy');
    if (kpiTotalEl && pool.bestTotalApy != null && pool.bestTotalApy > 0) {
      const rawT = pool.bestTotalApy;
      const adjT = (typeof simDepositAmount !== 'undefined' && simDepositAmount > 0)
        ? dilutedTotalApy(pool, simDepositAmount) : rawT;
      if (typeof _buildTotalApyTooltip === 'function') kpiTotalEl.title = _buildTotalApyTooltip(pool);
      if (typeof simDepositAmount !== 'undefined' && simDepositAmount > 0) {
        kpiTotalEl.innerHTML = `${fmtPct(adjT)} <span style="font-size:11px;color:var(--text-dim)">(${fmtPct(rawT)})</span>`;
      } else {
        kpiTotalEl.textContent = fmtPct(rawT);
      }
    }
    // Cache link targets for openConvexLink / openStakeDaoLink (Task 2: clickable cells)
    const cvxWrap = document.getElementById('kpiConvexWrap');
    if (cvxWrap) {
      if (cvx && cvx.pid != null) {
        cvxWrap.dataset.href = `https://www.convexfinance.com/stake/ethereum/${cvx.pid}`;
        cvxWrap.style.cursor = 'pointer';
      } else {
        delete cvxWrap.dataset.href;
        cvxWrap.style.cursor = '';
      }
    }
    const sdWrap = document.getElementById('kpiStakeDaoWrap');
    if (sdWrap) {
      const lp = pool.lpTokenAddress || pool.address;
      if (sd && lp) {
        sdWrap.dataset.href = `https://www.stakedao.org/yield?protocol=curve&search=${lp}`;
        sdWrap.style.cursor = 'pointer';
      } else {
        delete sdWrap.dataset.href;
        sdWrap.style.cursor = '';
      }
    }
  } catch (e) {
    console.warn('updateThirdPartyYields error:', e);
    if (cvxEl.textContent === '...') cvxEl.textContent = '—';
    if (sdEl.textContent === '...') sdEl.textContent = '—';
  }
}

// Click handlers for the Convex / StakeDAO KPI cells (set up in updateThirdPartyYields).
// data-href is populated only when the pool is actually listed there; otherwise no-op.
function openConvexLink() {
  const href = document.getElementById('kpiConvexWrap')?.dataset?.href;
  if (href) window.open(href, '_blank', 'noopener');
}
function openStakeDaoLink() {
  const href = document.getElementById('kpiStakeDaoWrap')?.dataset?.href;
  if (href) window.open(href, '_blank', 'noopener');
}
window.openConvexLink = openConvexLink;
window.openStakeDaoLink = openStakeDaoLink;

// ============================================================
// DefiLlama Yields API: pool mapping + historical APR
// Builds three lookup maps in a single /pools fetch:
//   curve-dex      → native Curve LP APY (used for CRV+Rewards series)
//   convex-finance → Convex APR (historical line on /yield)
//   stake-dao      → StakeDAO APR (historical line on /yield)
// All maps are keyed by sorted-lowercased underlyingTokens (the Curve coins)
// because the Convex/StakeDAO DefiLlama records expose the same coin set as
// the underlying Curve pool, not the LP-token address.
// ============================================================
let _llamaPoolMap = null;   // { ts, maps: { curve, convex, stakedao } }
const LLAMA_CACHE_TTL = 10 * 60 * 1000; // 10 min

function _addToProjectMap(map, p) {
  const tokens = (p.underlyingTokens || []).map(t => t.toLowerCase()).sort();
  if (tokens.length > 0) {
    const key = tokens.join(',');
    const existing = map.get(key);
    if (!existing || (p.tvlUsd || 0) > (existing.tvlUsd || 0)) {
      map.set(key, { poolId: p.pool, tvlUsd: p.tvlUsd || 0 });
    }
  }
  if (p.symbol) {
    const symKey = 'sym:' + p.symbol.toLowerCase();
    const existing = map.get(symKey);
    if (!existing || (p.tvlUsd || 0) > (existing.tvlUsd || 0)) {
      map.set(symKey, { poolId: p.pool, tvlUsd: p.tvlUsd || 0 });
    }
  }
}

async function getLlamaPoolMaps() {
  if (_llamaPoolMap && Date.now() - _llamaPoolMap.ts < LLAMA_CACHE_TTL) return _llamaPoolMap.maps;
  try {
    const resp = await fetch('https://yields.llama.fi/pools');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const all = (json.data || []).filter(p => p.chain === 'Ethereum');
    const maps = {
      curve: new Map(),
      convex: new Map(),
      stakedao: new Map(),
    };
    for (const p of all) {
      if (p.project === 'curve-dex') _addToProjectMap(maps.curve, p);
      else if (p.project === 'convex-finance') _addToProjectMap(maps.convex, p);
      else if (p.project === 'stake-dao') _addToProjectMap(maps.stakedao, p);
    }
    _llamaPoolMap = { ts: Date.now(), maps };
    return maps;
  } catch (e) {
    console.warn('DefiLlama pool maps fetch failed:', e);
    return null;
  }
}

// Back-compat: legacy call site used getLlamaPoolMap() to fetch only curve-dex.
async function getLlamaPoolMap() {
  const maps = await getLlamaPoolMaps();
  return maps ? maps.curve : null;
}

function findLlamaPoolId(poolMap, coinsAddresses, poolCoins) {
  if (!poolMap) return null;
  if (coinsAddresses && coinsAddresses.length > 0) {
    const ZERO = '0x0000000000000000000000000000000000000000';
    const ETH = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    // Normalize: filter out ETH placeholder and zero-padding, lowercase, sort
    const tokens = coinsAddresses
      .map(a => a.toLowerCase())
      .filter(a => a !== ETH && a !== ZERO)
      .sort();
    // Also try with WETH substituted for ETH placeholder
    const tokensWithWeth = coinsAddresses
      .map(a => {
        const l = a.toLowerCase();
        return l === ETH ? WETH : l;
      })
      .filter(a => a !== ZERO)
      .sort();
    const key1 = tokens.join(',');
    const key2 = tokensWithWeth.join(',');
    const match = poolMap.get(key1) || poolMap.get(key2);
    if (match) return match.poolId;
  }
  // Fallback: match by symbol (e.g. "DAI-USDC-USDT")
  if (poolCoins && poolCoins.length > 0) {
    const symKey = 'sym:' + [...poolCoins].sort().join('-').toLowerCase();
    const symMatch = poolMap.get(symKey);
    if (symMatch) return symMatch.poolId;
  }
  return null;
}

async function fetchLlamaChart(poolId) {
  if (!poolId) return null;
  try {
    const url = `https://yields.llama.fi/chart/${poolId}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const json = await resp.json();
    return json.data || [];
  } catch (e) {
    console.warn('DefiLlama chart fetch failed:', e);
    return null;
  }
}

// ============================================================
// YIELD: Header & Pool Info
// ============================================================
// Render stacked token icons for a yield pool (mirrors /trade and /pools rich header).
// Supports 1..N coins; shows letter fallback when CDN icon unavailable.
function _setYieldPoolIcons(pool) {
  const wrap = document.getElementById('yieldPoolIcons');
  if (!wrap) return;
  const coins = Array.isArray(pool && pool.coins) ? pool.coins : [];
  const addrs = Array.isArray(pool && pool.coinsAddresses) ? pool.coinsAddresses : [];
  if (!coins.length) { wrap.innerHTML = ''; return; }
  // Cap stacked icons at 4 — anything more becomes visual clutter
  const max = Math.min(coins.length, 4);
  const html = [];
  for (let i = 0; i < max; i++) {
    const sym = coins[i] || '';
    const addr = addrs[i] || '';
    const fallback = (sym || '?').slice(0, 2).toUpperCase();
    const cls = i === 0 ? 'pair-icon pair-icon-base' : 'pair-icon pair-icon-quote';
    html.push(`<div class="${cls}" data-idx="${i}">${fallback}</div>`);
  }
  wrap.innerHTML = html.join('');
  // Lazy-load images, swap to background when ready, keep letter fallback otherwise
  for (let i = 0; i < max; i++) {
    const addr = addrs[i] || '';
    if (!addr || typeof _tokenIconUrl !== 'function') continue;
    const url = _tokenIconUrl(addr);
    if (!url) continue;
    const el = wrap.querySelector(`.pair-icon[data-idx="${i}"]`);
    if (!el) continue;
    const img = new Image();
    img.onload = () => {
      el.style.backgroundImage = `url("${url}")`;
      el.style.color = 'transparent';
    };
    img.onerror = () => { /* keep letter fallback */ };
    img.src = url;
  }
}

function updateYieldHeader() {
  const pool = selectedPool;
  const nameEl = document.getElementById('yieldPoolName');
  // Toggle deprecated banner: Curve API gauge.is_killed (Алекс crvecodev/500)
  // OR registry deprecated/withdraw-only flag (Fantom/Avax cross-chain synth
  // pools). Mirrors yellow "PROTOCOL DEPRECATED" alert on curve.finance.
  const depBanner = document.getElementById('yieldDeprecatedBanner');
  if (depBanner) {
    if (pool && pool.deprecated) {
      depBanner.innerHTML = '<strong>⚠️ Deprecated pool — withdraw only</strong> — This pool is no longer maintained. Removing (and adding) liquidity is supported below; trading and charts are not.';
      depBanner.style.display = '';
    } else if (pool && pool.suspectOracle) {
      depBanner.innerHTML = '<strong>⚠️ Suspicious pool</strong> — A rate oracle is active on a blue-chip stablecoin in this pool (verified on-chain via stored_rates). Canonical pools never price USDC/USDT/DAI through an oracle: the deployer\'s contract can reprice deposits at will. Do not deposit unless you know exactly what this pool is.';
      depBanner.style.display = '';
    } else if (pool && pool.gaugeIsKilled) {
      depBanner.innerHTML = '<strong>⚠️ Pool deprecated</strong> — Gauge killed by Curve DAO. The underlying protocol may be abandoned. Verify deposit availability directly on <a href="https://curve.finance/dex/ethereum/pools/" target="_blank" rel="noopener" style="color:#f0b90b;text-decoration:underline">curve.finance</a> before acting.';
      depBanner.style.display = '';
    } else {
      depBanner.style.display = 'none';
    }
  }
  // Token icons (multi-coin stacked) — placed before pool name
  _setYieldPoolIcons(pool);
  if (pool.coins.length >= 2) {
    // Per @Alexandr_Petryashev msg 245: clicking an individual token ticker in
    // the pool header should populate the sidebar search with that ticker so
    // the user can quickly find all pools containing it. We escape the symbol
    // single quotes for the inline onclick attribute.
    const _esc = window.escapeHtml || (s => String(s));
    const parts = pool.coins.map((c, i) => {
      const cls = i === 0 ? 'pair-clickable pool-accent' : 'pair-clickable';
      const safeSym = String(c).replace(/'/g, "\\'");
      const cEsc = _esc(c);
      return `<span class="${cls}" title="Click to filter pools by ${cEsc}" onclick="pickTokenSearch('${safeSym}')">${cEsc}</span>`;
    });
    nameEl.innerHTML = parts.join('<span class="pair-divider"> / </span>') + _curvePoolLinkHtml(pool);
  } else {
    const _esc2 = window.escapeHtml || (s => String(s));
    nameEl.innerHTML = `<span class="pair-clickable pool-accent" onclick="openPairPicker('from')">${_esc2(pool.name || shortAddr(pool.address))}</span>` + _curvePoolLinkHtml(pool);
  }
  document.getElementById('kpiDailyApy').textContent = fmtPct(pool.dailyApy);
  document.getElementById('kpiWeeklyApy').textContent = fmtPct(pool.weeklyApy);
  document.getElementById('kpiTvl').textContent = fmt$(pool.tvl);
  const gaugeApy = Array.isArray(pool.gaugeCrvApy) ? pool.gaugeCrvApy : [0, 0];
  const avgGauge = (gaugeApy[0] + gaugeApy[1]) / 2;
  document.getElementById('kpiGaugeApy').textContent = avgGauge > 0
    ? `${fmtPct(gaugeApy[0]).replace('%', '')}-${fmtPct(gaugeApy[1])}`
    : '--';
  // Uniform base APY (same source as table TOTAL). Fallback to pool.totalApy
  // if mergePlatformAprs hasn't run yet (Convex/SD caches not loaded).
  const rawTotalApy = (pool.bestTotalApy != null && pool.bestTotalApy > 0)
    ? pool.bestTotalApy
    : (pool.totalApy || 0);
  const adjTotalApy = simDepositAmount > 0 ? dilutedTotalApy(pool, simDepositAmount) : rawTotalApy;
  const kpiEl = document.getElementById('kpiTotalApy');
  // Tooltip mirrors the table TOTAL tooltip so header and row tell the same story.
  if (typeof _buildTotalApyTooltip === 'function') {
    kpiEl.title = _buildTotalApyTooltip(pool);
  }
  if (simDepositAmount > 0 && rawTotalApy > 0) {
    kpiEl.innerHTML = `${fmtPct(adjTotalApy)} <span style="font-size:11px;color:var(--text-dim)">(${fmtPct(rawTotalApy)})</span>`;
  } else {
    kpiEl.textContent = rawTotalApy > 0 ? fmtPct(rawTotalApy) : '--';
  }
  // Merkl KPI
  const merklWrap = document.getElementById('kpiMerklWrap');
  const merklEl = document.getElementById('kpiMerklApy');
  if (pool.merklApr > 0) {
    merklEl.textContent = '+' + fmtPct(pool.merklApr);
    merklWrap.style.display = '';
  } else {
    merklWrap.style.display = 'none';
  }
  // Convex + StakeDAO APR (async, non-blocking)
  // Reset to '--' on pool change so the loading state shows
  const cvxEl = document.getElementById('kpiConvexApy');
  const sdEl = document.getElementById('kpiStakeDaoApy');
  if (cvxEl) cvxEl.textContent = '--';
  if (sdEl) sdEl.textContent = '--';
  // Clear stale link targets — repopulated by updateThirdPartyYields
  const cvxWrap = document.getElementById('kpiConvexWrap');
  const sdWrap = document.getElementById('kpiStakeDaoWrap');
  if (cvxWrap) { delete cvxWrap.dataset.href; cvxWrap.style.cursor = ''; }
  if (sdWrap) { delete sdWrap.dataset.href; sdWrap.style.cursor = ''; }
  updateThirdPartyYields();
  // Gauge weight KPI tile (current %, Δ vs prev week, virtual rank). Async — lazy.
  _updateGaugeWeightKpi(pool);
  // Sync favorite star + sidebar
  if (typeof window._renderYieldFavStar === 'function') window._renderYieldFavStar();
  if (typeof window.renderPoolFavoritesSidebar === 'function') window.renderPoolFavoritesSidebar();
}

// Render the Gauge Weight KPI tile in /yield header.
// Hidden if pool has no gauge OR no current weight in gauge_controller.
function _updateGaugeWeightKpi(pool) {
  const wrap = document.getElementById('kpiGaugeWeightWrap');
  const valEl = document.getElementById('kpiGaugeWeight');
  const metaEl = document.getElementById('kpiGaugeWeightMeta');
  if (!wrap || !valEl || !metaEl) return;
  if (!pool || !pool.gaugeAddress || pool.gaugeAddress === '0x0000000000000000000000000000000000000000') {
    wrap.style.display = 'none';
    return;
  }
  if (!window.GaugeWeights) { wrap.style.display = 'none'; return; }

  const renderFromMap = () => {
    const info = window.GaugeWeights.getForGauge(pool.gaugeAddress);
    if (!info || !(info.currentPct > 0)) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    valEl.textContent = info.currentPct.toFixed(2) + '%';
    let metaParts = [];
    if (info.deltaPct == null) {
      metaParts.push('<span class="gw-flat">new</span>');
    } else {
      const sign = info.deltaPct > 0 ? '+' : '';
      const cls = Math.abs(info.deltaPct) < 0.005 ? 'gw-flat' : (info.deltaPct > 0 ? 'gw-up' : 'gw-down');
      const arrow = Math.abs(info.deltaPct) < 0.005 ? '·' : (info.deltaPct > 0 ? '↑' : '↓');
      metaParts.push(`<span class="${cls}">${arrow} ${sign}${info.deltaPct.toFixed(2)}pp</span>`);
    }
    let rankPart = `#${info.rank}`;
    if (info.rankDelta != null && info.rankDelta !== 0) {
      const cls = info.rankDelta > 0 ? 'gw-up' : 'gw-down';
      const arrow = info.rankDelta > 0 ? '↑' : '↓';
      rankPart += ` <span class="${cls}">${arrow}${Math.abs(info.rankDelta)}</span>`;
    }
    metaParts.push(rankPart);
    metaEl.innerHTML = metaParts.join(' · ');
  };

  if (window.GaugeWeights.isReady()) {
    renderFromMap();
  } else {
    // Show placeholder while loading
    wrap.style.display = '';
    valEl.textContent = '…';
    metaEl.innerHTML = '<span class="gw-flat">loading</span>';
    window.GaugeWeights.ensure().then(() => {
      // Pool may have changed since we kicked off; only re-render if still selected.
      if (selectedPool && selectedPool.gaugeAddress === pool.gaugeAddress) renderFromMap();
    });
  }
}

// Render a clickable etherscan-linked short address with a copy button.
// Used by Pool / LP / Gauge rows AND per-coin contracts (msg 245).
// `addr`: full 0x address. Copy uses navigator.clipboard.writeText (HTTPS only)
// with a textarea fallback for non-secure contexts. Brief visual confirmation
// (.copied class) is added for ~1.5s after click.
function _addrCell(addr) {
  if (!addr) return '--';
  const safeAddr = String(addr);
  return `<a href="${window.getExplorerAddressUrl ? window.getExplorerAddressUrl(safeAddr) : 'https://etherscan.io/address/' + safeAddr}" target="_blank" rel="noopener noreferrer" title="${safeAddr}">${shortAddr(safeAddr)}</a>`
    + ` <button class="addr-copy-btn" type="button" data-addr="${safeAddr}" data-flash="copied" title="Copy ${safeAddr}" onclick="event.preventDefault(); event.stopPropagation(); _copyAddrFromBtn(this)" aria-label="Copy address">`
    + `<svg class="icon"><use href="#icon-copy"/></svg></button>`;
}

// Copy handler — invoked by the inline onclick on .addr-copy-btn. Reads the
// full address from data-addr, attempts navigator.clipboard.writeText, falls
// back to a hidden textarea + execCommand. Adds .copied class for 1.5s for
// visual feedback (icon swaps + tooltip flashes "copied").
function _copyAddrFromBtn(btn) {
  if (!btn) return;
  const addr = btn.getAttribute('data-addr') || '';
  if (!addr) return;
  const flash = () => {
    btn.classList.add('copied');
    const useEl = btn.querySelector('use');
    const prev = useEl ? useEl.getAttribute('href') : null;
    if (useEl) useEl.setAttribute('href', '#icon-check');
    setTimeout(() => {
      btn.classList.remove('copied');
      if (useEl && prev) useEl.setAttribute('href', prev);
    }, 1500);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = addr;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      flash();
    } catch (e) {
      // Last resort: show error in title; no-op so click doesn't navigate.
      btn.title = 'Copy failed: ' + e.message;
    }
  };
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(addr).then(flash, fallback);
    } else {
      fallback();
    }
  } catch (e) {
    fallback();
  }
}
window._copyAddrFromBtn = _copyAddrFromBtn;

function updateYieldPoolInfo() {
  const pool = selectedPool;
  document.getElementById('yieldPoolParams').style.display = '';

  // Parameters
  // Type rendered as a styled badge (matches former pool-item-type chip moved out
  // of the row per tester @Alexandr_Petryashev msg 245). Long form (e.g.
  // "factory-stable-ng") is shortened to "f-stab" for visual parity.
  const _typeShort = pool.registryId
    ? pool.registryId.replace('factory-', 'f-').slice(0, 6)
    : (pool.type || '--');
  document.getElementById('yieldInfoType').innerHTML =
    `<span class="pool-type-badge" title="${pool.registryId || pool.type || ''}">${_typeShort}</span>`;
  const ampCoeff = pool.amplificationCoefficient;
  document.getElementById('yieldInfoAmpCoeff').textContent = ampCoeff ? Number(ampCoeff).toLocaleString() : '--';
  document.getElementById('yieldInfoVPrice').textContent = pool.virtualPrice > 0 ? (pool.virtualPrice / 1e18).toFixed(6) : '--';
  document.getElementById('yieldInfoVolume').textContent = fmt$(pool.volumeUSD);
  const estFees = pool.volumeUSD * 0.0004;
  document.getElementById('yieldInfoFees').textContent = pool.volumeUSD > 0 ? '~' + fmt$(estFees) : '--';

  // Fee row: synchronous API/fallback first, on-chain fee() refine below.
  // _poolFeePct + _fmtPctTrim are global function declarations from trade.js
  // (loaded before yield.js per the defer order in index.html).
  const _yFeeEl = document.getElementById('yieldInfoFee');
  if (_yFeeEl) {
    const syncFee = typeof _poolFeePct === 'function' ? _poolFeePct(pool) : null;
    const fmt = (p) => (typeof _fmtPctTrim === 'function' ? _fmtPctTrim(p) : (p != null ? p.toFixed(4) + '%' : null));
    _yFeeEl.textContent = syncFee != null ? (fmt(syncFee) || '--') : '...';
    _yFeeEl.style.opacity = '';
  }

  // Addresses (each gets a copy button via _addrCell helper).
  document.getElementById('yieldInfoAddress').innerHTML = _addrCell(pool.address);
  const lpAddr = pool.lpTokenAddress || pool.address;
  document.getElementById('yieldInfoLpToken').innerHTML = _addrCell(lpAddr);

  // Rate Oracle pill — moved from Pool Parameters into Token Contracts header
  // per Александр msg 891. Source is now on-chain stored_rates() (decimals-aware),
  // NOT pool.usesRateOracle (POOL-LEVEL bool that is misleadingly FALSE even when
  // a coin has an active oracle). Hidden until/unless an active oracle is found.
  const _oraclePillEl = document.getElementById('yieldInfoOraclePill');
  if (_oraclePillEl) {
    // Provisional: keep hidden, async refine reveals it with the active coin+mult.
    _oraclePillEl.style.display = 'none';
  }

  // Async on-chain refine of Fee + Rate Oracle pill (copy of % Staked pattern:
  // pool-change guard + graceful fallback, never throws). Uses the shared util
  // exported by trade.js on window.
  if ((_yFeeEl || _oraclePillEl) && typeof window.fetchPoolOnchainFeeOracle === 'function') {
    const _fmt = (p) => (typeof _fmtPctTrim === 'function' ? _fmtPctTrim(p) : (p != null ? p.toFixed(4) + '%' : null));
    window.fetchPoolOnchainFeeOracle(pool).then((info) => {
      if (selectedPool !== pool) return; // navigated away mid-flight
      if (_yFeeEl) {
        if (info.feePct != null) {
          if (info.offpegMult != null && info.offpegMult > 1) {
            // StableSwapNG dynamic fee: base fee scales up toward
            // fee × offpeg_fee_multiplier off-peg. Mirror of trade.js render.
            const baseP = info.feePct;
            const maxP = baseP * info.offpegMult;
            const multStr = info.offpegMult % 1 === 0 ? info.offpegMult : info.offpegMult.toFixed(2);
            _yFeeEl.textContent = `${_fmt(baseP)} → ${_fmt(maxP)}`;
            _yFeeEl.title = `Base swap fee ${_fmt(baseP)} (on-chain fee()). For this StableSwapNG pool the effective fee scales up to ${_fmt(maxP)} as balances go off-peg (offpeg_fee_multiplier ×${multStr}).`;
          } else {
            _yFeeEl.textContent = _fmt(info.feePct) || '--';
            _yFeeEl.title = '';
          }
          _yFeeEl.style.opacity = '';
        } else {
          const syncFee = typeof _poolFeePct === 'function' ? _poolFeePct(pool) : null;
          _yFeeEl.textContent = syncFee != null ? (_fmt(syncFee) || '--') : '--';
          _yFeeEl.style.opacity = syncFee != null ? '' : '0.5';
        }
      }
      if (_oraclePillEl) {
        if (info.oracle && info.oracle.active) {
          _oraclePillEl.textContent = `⚙ Rate oracle: ${info.oracle.symbol} ×${info.oracle.mult.toFixed(4)}`;
          _oraclePillEl.style.display = '';
        } else if (info.oracle) {
          _oraclePillEl.style.display = 'none';
        } else {
          // stored_rates() unavailable — fall back to API flag (best-effort).
          _oraclePillEl.style.display = pool.usesRateOracle === true ? '' : 'none';
        }
      }
    }).catch((e) => {
      console.warn('on-chain fee/oracle pull failed (yield):', e);
      if (selectedPool !== pool) return;
      if (_yFeeEl) {
        const syncFee = typeof _poolFeePct === 'function' ? _poolFeePct(pool) : null;
        _yFeeEl.textContent = syncFee != null ? (_fmt(syncFee) || '--') : '--';
        _yFeeEl.style.opacity = syncFee != null ? '' : '0.5';
      }
      if (_oraclePillEl) {
        _oraclePillEl.style.display = pool.usesRateOracle === true ? '' : 'none';
      }
    });
  }

  const gaugeRow = document.getElementById('yieldInfoGaugeRow');
  const stakedRow = document.getElementById('yieldInfoPctStakedRow');
  const stakedVal = document.getElementById('yieldInfoPctStaked');
  if (pool.gaugeAddress && pool.gaugeAddress !== '0x0000000000000000000000000000000000000000') {
    gaugeRow.style.display = '';
    document.getElementById('yieldInfoGauge').innerHTML = _addrCell(pool.gaugeAddress);
    // % Staked = gauge.totalSupply (on-chain ERC20) / pool.totalSupply × 100. Curve API
    // gauge_data only exposes working_supply (boost-adjusted), not raw totalSupply, so
    // we eth_call totalSupply() (selector 0x18160ddd) on gauge address. Both numerators
    // and pool.totalSupply are in wei → ratio is unit-free, no 1e18 conversion needed.
    if (stakedRow && stakedVal) {
      stakedRow.style.display = '';
      stakedVal.textContent = '...';
      const gAddr = pool.gaugeAddress;
      const poolTs = Number(pool.totalSupply);
      if (!isFinite(poolTs) || poolTs <= 0) {
        stakedVal.textContent = '—';
        stakedVal.style.opacity = '0.5';
      } else {
        rpcCall('0x18160ddd', gAddr).then((hex) => {
          // Bail if user navigated to another pool while we were waiting.
          if (selectedPool !== pool) return;
          const gTs = Number(BigInt(hex));
          let pct = (gTs / poolTs) * 100;
          if (!isFinite(pct)) { stakedVal.textContent = '—'; stakedVal.style.opacity = '0.5'; return; }
          if (pct > 100) { console.warn('% Staked >100, clamping:', pct, gAddr); pct = 100; }
          if (pct < 0) pct = 0;
          stakedVal.style.opacity = '';
          stakedVal.textContent = pct.toFixed(2) + '%';
        }).catch((e) => {
          console.warn('% Staked rpcCall failed:', e);
          if (selectedPool === pool) { stakedVal.textContent = '—'; stakedVal.style.opacity = '0.5'; }
        });
      }
    }
  } else {
    gaugeRow.style.display = 'none';
    if (stakedRow) stakedRow.style.display = 'none';
  }

  // Per-coin contract addresses (msg 245). Pool may have 2-8 coins; we render
  // each with its symbol + short addr + copy button. Skipped for pools with no
  // resolvable coin addresses (e.g. external aggregator entries).
  const coinsWrap = document.getElementById('yieldInfoCoins');
  const coinsList = document.getElementById('yieldInfoCoinsList');
  if (coinsWrap && coinsList) {
    const symbols = Array.isArray(pool.coins) ? pool.coins : [];
    const addrs = Array.isArray(pool.coinsAddresses) ? pool.coinsAddresses : [];
    const ZERO = '0x0000000000000000000000000000000000000000';
    const rows = [];
    const n = Math.max(symbols.length, addrs.length);
    for (let i = 0; i < n; i++) {
      const sym = symbols[i] || '?';
      const a = addrs[i] || '';
      if (!a || a === ZERO) continue;
      const iconHtml = `<img class="token-icon" src="${_tokenIconUrl(a)}" alt="" width="14" height="14" loading="lazy" onerror="this.style.display='none'">`;
      rows.push(`<div class="pd-coin-row"><span class="pd-coin-sym">${iconHtml}${sym}</span><span class="pd-coin-addr">${_addrCell(a)}</span></div>`);
    }
    if (rows.length) {
      coinsList.innerHTML = rows.join('');
      coinsWrap.style.display = '';
    } else {
      coinsList.innerHTML = '';
      coinsWrap.style.display = 'none';
    }
  }

  // Action links — shared builder (defined in trade.js)
  if (typeof window._buildPoolActionLinks === 'function') {
    document.getElementById('yieldPoolLinks').innerHTML = window._buildPoolActionLinks(pool);
    if (typeof window._refinePoolActionLinks === 'function') {
      window._refinePoolActionLinks(pool, 'yieldPoolLinks');
    }
  } else {
    // Fallback (should not happen — trade.js loads first)
    let linksHtml = `<a class="pool-action-link" href="${window.getExplorerAddressUrl ? window.getExplorerAddressUrl(pool.address) : 'https://etherscan.io/address/' + pool.address}" target="_blank" rel="noopener noreferrer">Explorer</a>`;
    if (pool.poolUrls?.deposit?.[0]) linksHtml += `<a class="pool-action-link" href="${pool.poolUrls.deposit[0]}" target="_blank" rel="noopener noreferrer">Add Liquidity</a>`;
    document.getElementById('yieldPoolLinks').innerHTML = linksHtml;
  }
}


// ============================================================
// YIELD: Chart (APY + Virtual Price)
// ============================================================
function initYieldChart() {
  const container = document.getElementById('yield-chart-container');
  container.innerHTML = '';

  const _isMobile = window.innerWidth <= 768;
  yieldChart = LightweightCharts.createChart(container, {
    layout: { background: { color: '#0b0e11' }, textColor: '#848e9c', fontSize: _isMobile ? 9 : 11 },
    grid: { vertLines: { color: '#1e2329' }, horzLines: { color: '#1e2329' } },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: '#f0b90b33', width: 1, style: 0, labelBackgroundColor: '#f0b90b' },
      horzLine: { color: '#f0b90b33', width: 1, style: 0, labelBackgroundColor: '#f0b90b' },
    },
    rightPriceScale: {
      visible: true,
      borderColor: '#2b3139',
      borderVisible: true,
      scaleMargins: { top: 0.15, bottom: 0.15 },
      // VP mode needs ~70px to fit "1.0398" labels; APY mode "12.34%" fits in 48px.
      minimumWidth: currentChartMode === 'tvl' ? (_isMobile ? 70 : 90) : (_isMobile ? 48 : 70),
      autoScale: true,
      entireTextOnly: false,
      drawTicks: true,
      ticksVisible: true,
    },
    leftPriceScale: { visible: false },
    timeScale: { borderColor: '#2b3139', timeVisible: true, secondsVisible: false },
    handleScroll: { vertTouchDrag: true },
  });

  // Series creation order matters: Lightweight Charts uses the FIRST visible
  // series on a price scale to drive the scale's tick formatter. To keep
  // the % formatter (APY mode) and the plain decimal formatter (VP mode)
  // from leaking into each other, we add only the active mode's series first.
  if (currentChartMode === 'tvl') {
    // VP mode: VP series first (drives '1.0398' formatter on the 'right' scale),
    // APY series afterwards (hidden, so their % formatter doesn't take over).
    tvlSeries = yieldChart.addLineSeries({
      color: '#f0b90b', lineWidth: 2, title: '',
      visible: true,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(4), minMove: 0.0001 },
      priceScaleId: 'right',
    });
    apySeries = yieldChart.addLineSeries({
      color: '#0ecb81', lineWidth: 2, title: '', visible: false,
      lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
    });
    weeklyApySeries = yieldChart.addLineSeries({
      color: '#f0b90b', lineWidth: 2, title: '', visible: false,
      lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
    });
    crvAprSeries = yieldChart.addLineSeries({
      color: '#e68a00', lineWidth: 2, title: '', visible: false,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
      crosshairMarkerVisible: true, lastValueVisible: false,
    });
    otherAprSeries = yieldChart.addLineSeries({
      color: '#26a69a', lineWidth: 2, title: '', visible: false,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
      crosshairMarkerVisible: true, lastValueVisible: false,
    });
    convexAprSeries = yieldChart.addLineSeries({
      color: '#3b82f6', lineWidth: 2, title: '', visible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
      crosshairMarkerVisible: true, lastValueVisible: false,
    });
    stakedaoAprSeries = yieldChart.addLineSeries({
      color: '#a855f7', lineWidth: 2, title: '', visible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
      crosshairMarkerVisible: true, lastValueVisible: false,
    });
  } else {
    // APY mode: APY series first, VP last (hidden).
    apySeries = yieldChart.addLineSeries({
      color: '#0ecb81', lineWidth: 2, title: '',
      lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
    });
    weeklyApySeries = yieldChart.addLineSeries({
      color: '#f0b90b', lineWidth: 2, title: '',
      lastValueVisible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
    });
    crvAprSeries = yieldChart.addLineSeries({
      color: '#e68a00', lineWidth: 2, title: '', visible: false,
      lineStyle: LightweightCharts.LineStyle.Solid,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
      crosshairMarkerVisible: true, lastValueVisible: false,
    });
    otherAprSeries = yieldChart.addLineSeries({
      color: '#26a69a', lineWidth: 2, title: '', visible: false,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
      crosshairMarkerVisible: true, lastValueVisible: false,
    });
    convexAprSeries = yieldChart.addLineSeries({
      color: '#3b82f6', lineWidth: 2, title: '', visible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
      crosshairMarkerVisible: true, lastValueVisible: false,
    });
    stakedaoAprSeries = yieldChart.addLineSeries({
      color: '#a855f7', lineWidth: 2, title: '', visible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(1) + '%' },
      priceLineVisible: false,
      crosshairMarkerVisible: true, lastValueVisible: false,
    });
    tvlSeries = yieldChart.addLineSeries({
      color: '#f0b90b', lineWidth: 2, title: '', visible: false,
      priceFormat: { type: 'custom', formatter: v => v.toFixed(4), minMove: 0.0001 },
      priceScaleId: 'right',
    });
  }

  const ro = new ResizeObserver(() => {
    yieldChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
  });
  ro.observe(container);
  yieldChart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
}

function showChartNoData(msg) {
  const container = document.getElementById('yield-chart-container');
  const old = container.querySelector('.chart-no-data');
  if (old) old.remove();
  if (!msg) return;
  const div = document.createElement('div');
  div.className = 'chart-no-data';
  div.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#848e9c;font-size:12px;text-align:center;z-index:5;background:rgba(11,14,17,0.85);padding:12px 20px;border-radius:6px;border:1px solid #2b3139;';
  div.textContent = msg;
  container.appendChild(div);
}

async function loadApyHistory() {
  if (!selectedPool) return;
  showChartNoData(null);
  try {
    const end = Math.floor(Date.now() / 1000);
    const start = end - 90 * 24 * 3600;
    const url = `${PRICES_BASE}/snapshots/${getChainKey()}/${selectedPool.address}?start=${start}&end=${end}`;
    let json;
    try { json = await fetchJSON(url); } catch (fetchErr) {
      showChartNoData('No historical data available for this pool');
      apySeries.setData([]); weeklyApySeries.setData([]); tvlSeries.setData([]);
      crvAprSeries.setData([]); otherAprSeries.setData([]);
      updateYieldLegend(false, false);
      return;
    }
    const snapshots = json?.data || [];
    if (snapshots.length === 0) {
      showChartNoData('No historical data available for this pool');
      apySeries.setData([]); weeklyApySeries.setData([]); tvlSeries.setData([]);
      crvAprSeries.setData([]); otherAprSeries.setData([]);
      updateYieldLegend(false, false);
      return;
    }
    const dailyApyData = [], weeklyApyData = [], vpData = [];
    for (const snap of snapshots) {
      const ts = typeof snap.timestamp === 'number' ? snap.timestamp : Math.floor(new Date(snap.timestamp).getTime() / 1000);
      if (snap.base_daily_apr != null) {
        const v = parseFloat(snap.base_daily_apr) * 100;
        if (isFinite(v)) dailyApyData.push({ time: ts, value: v });
      }
      if (snap.base_weekly_apr != null) {
        const v = parseFloat(snap.base_weekly_apr) * 100;
        if (isFinite(v)) weeklyApyData.push({ time: ts, value: v });
      }
      if (snap.virtual_price != null) {
        const vp = parseFloat(snap.virtual_price) / 1e18;
        if (isFinite(vp) && vp > 0) vpData.push({ time: ts, value: vp });
      }
    }
    const dedup = (arr) => {
      const map = new Map();
      arr.forEach(d => map.set(d.time, d));
      return [...map.values()].sort((a, b) => a.time - b.time);
    };
    apySeries.setData(dedup(dailyApyData));
    weeklyApySeries.setData(dedup(weeklyApyData));
    tvlSeries.setData(dedup(vpData));

    // CRV+Rewards APR — try DefiLlama historical, fallback to horizontal line
    const pool = selectedPool;
    let hasCrv = false;
    let hasOther = false;
    let hasConvex = false;
    let hasStakeDao = false;

    // Attempt DefiLlama historical rewards data
    let llamaUsed = false;
    // Always start hidden — only show if data found
    crvAprSeries.applyOptions({ visible: false });
    crvAprSeries.setData([]);
    otherAprSeries.applyOptions({ visible: false });
    otherAprSeries.setData([]);
    convexAprSeries.applyOptions({ visible: false });
    convexAprSeries.setData([]);
    stakedaoAprSeries.applyOptions({ visible: false });
    stakedaoAprSeries.setData([]);

    if (currentChartMode === 'apy') {
      try {
        const maps = await getLlamaPoolMaps();
        const cutoff90d = Date.now() - 90 * 24 * 3600 * 1000;

        // Helper: fetch + transform a /chart/{poolId} response into a series array.
        // `field` selects which APR component to plot (apyReward for native rewards,
        // apy for total Convex/StakeDAO APR — that matches the KPI cells).
        const fetchSeries = async (poolId, field) => {
          if (!poolId) return [];
          const chartData = await fetchLlamaChart(poolId);
          if (!chartData || chartData.length === 0) return [];
          const out = [];
          for (const d of chartData) {
            const ts = Math.floor(new Date(d.timestamp).getTime() / 1000);
            if (ts * 1000 < cutoff90d) continue;
            const v = d[field];
            if (v != null && isFinite(v)) out.push({ time: ts, value: v });
          }
          return dedup(out);
        };

        // Run native curve-dex (APY rewards), Convex (total APR), StakeDAO (total APR)
        // in parallel — three small JSON fetches, no need to chain them.
        const curveId = findLlamaPoolId(maps?.curve, pool.coinsAddresses, pool.coins);
        const convexId = findLlamaPoolId(maps?.convex, pool.coinsAddresses, pool.coins);
        const stakedaoId = findLlamaPoolId(maps?.stakedao, pool.coinsAddresses, pool.coins);

        const [crvData, cvxData, sdData] = await Promise.all([
          fetchSeries(curveId, 'apyReward'),
          fetchSeries(convexId, 'apy'),
          fetchSeries(stakedaoId, 'apy'),
        ]);

        if (crvData.length > 0) {
          crvAprSeries.applyOptions({ visible: true, title: '', lineStyle: LightweightCharts.LineStyle.Solid });
          crvAprSeries.setData(crvData);
          hasCrv = true;
          llamaUsed = true;
        }
        if (cvxData.length > 0) {
          convexAprSeries.applyOptions({ visible: true });
          convexAprSeries.setData(cvxData);
          hasConvex = true;
        }
        if (sdData.length > 0) {
          stakedaoAprSeries.applyOptions({ visible: true });
          stakedaoAprSeries.setData(sdData);
          hasStakeDao = true;
        }
      } catch (e) {
        console.warn('DefiLlama APR fetch failed:', e);
      }
    }

    updateYieldLegend(hasCrv, false, llamaUsed, hasConvex, hasStakeDao);

    if (currentChartMode === 'apy' && dailyApyData.length === 0 && weeklyApyData.length === 0) {
      showChartNoData('No APY history data for this pool');
    } else if (currentChartMode === 'tvl' && vpData.length === 0) {
      showChartNoData('No virtual price history for this pool');
    }
    yieldChart.timeScale().fitContent();
  } catch (e) {
    console.error('APY history error:', e);
    showChartNoData('Failed to load historical data');
  }
}

function switchChartMode(mode) {
  currentChartMode = mode;
  document.querySelectorAll('.chart-tab').forEach(t => t.classList.toggle('active', t.dataset.chart === mode));
  // Recreate the chart from scratch on tab switch so the right price scale's
  // autoScale range, lastValuePill, and tick formatter all reset cleanly per
  // mode. Toggling visibility on a shared chart left stale APY ticks on the
  // VP scale (and vice versa). Cost: one extra fetchJSON for history snapshots,
  // mitigated by browser cache + the prices.curve.finance edge.
  if (yieldChart) {
    try { yieldChart.remove(); } catch (e) {}
    yieldChart = null;
  }
  initYieldChart();
  loadApyHistory();
  const legend = document.getElementById('yieldChartLegend');
  if (legend) legend.style.display = mode === 'apy' ? '' : 'none';
  showChartNoData(null);
}

// ============================================================
// YIELD: Chart Legend
// ============================================================
function updateYieldLegend(hasCrv, hasOther, llamaUsed = false, hasConvex = false, hasStakeDao = false) {
  let el = document.getElementById('yieldChartLegend');
  if (!el) {
    // Create legend overlay inside chart container
    const container = document.getElementById('yield-chart-container');
    el = document.createElement('div');
    el.id = 'yieldChartLegend';
    el.style.cssText = 'display:flex;gap:12px;font-size:11px;font-family:var(--font-mono);pointer-events:none;flex-wrap:wrap;padding:4px 8px 2px;';
    // Place the legend ABOVE the chart container, not overlaying the canvas
    // (Nik feedback on v=20260613a — legend pills were covering the chart).
    if (container.parentNode) container.parentNode.insertBefore(el, container);
    else container.appendChild(el);
  }
  el.style.display = currentChartMode === 'apy' ? '' : 'none';
  let html = '';
  const legBar = '<svg class="icon"><use href="#icon-legend-bar"/></svg>';
  const legDash = '<svg class="icon"><use href="#icon-legend-dashed"/></svg>';
  html += `<span style="color:#0ecb81;">${legBar} Daily APY</span>`;
  html += `<span style="color:#f0b90b;">${legBar} Weekly APY</span>`;
  if (hasCrv) {
    const crvLabel = llamaUsed ? 'CRV+Rewards APR (DefiLlama)' : 'CRV APR';
    html += `<span style="color:#e68a00;">${legDash} ${crvLabel}</span>`;
  }
  if (hasOther) {
    html += `<span style="color:#26a69a;">${legDash} Other APR</span>`;
  }
  if (hasConvex) {
    html += `<span style="color:#3b82f6;">${legBar} Convex APR</span>`;
  }
  if (hasStakeDao) {
    html += `<span style="color:#a855f7;">${legBar} StakeDAO APR</span>`;
  }
  el.innerHTML = html;
}

// ============================================================
// YIELD: Token Balances (reuses /pools rendering — DRY)
// Renders into #yieldTokenBalances / #yieldTokenBalancesList using the
// same .token-balance-row markup as updateTradeTokenBalances() in trade.js.
// ============================================================
function updateComposition() {
  const container = document.getElementById('yieldTokenBalances');
  const list = document.getElementById('yieldTokenBalancesList');
  if (!container || !list) return;
  if (!selectedPool || !selectedPool._hasDetail) { container.style.display = 'none'; return; }
  const regData = poolDetailsByRegistry.get(selectedPool.registryId);
  const poolDetail = regData?.find(p => p.address.toLowerCase() === selectedPool.address.toLowerCase());
  const coins = poolDetail?.coins || (selectedPool.coinsDetailed ? selectedPool.coinsDetailed.map(c => ({
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
    const iconHtml = (typeof _tokenIconInlineHtml === 'function')
      ? _tokenIconInlineHtml('token-balance-icon', c.address, c.symbol)
      : `<div class="token-balance-icon">${(c.symbol || '??').slice(0, 2)}</div>`;
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
// YIELD: Balances
// ============================================================
async function loadAllYieldBalances() {
  if (!walletAddress || !selectedPool || !provider) return;
  await Promise.all([loadYieldUserBalances(), loadDepositBalances(), loadLPBalance(), loadStakeData()]);
}

// YOUR BALANCES on /yield — mirrors loadTradeBalances (trade.js) behavior:
//   • dedup by lowercased token address (Curve API returns dupes for some metapools)
//   • hide entire section if every balance is 0n (errors don't count as positive)
// Independent from loadDepositBalances which targets the per-coin deposit form fields.
async function loadYieldUserBalances() {
  const section = document.getElementById('yieldBalancesSection');
  const list = document.getElementById('yieldBalancesList');
  if (!section || !list) return;
  if (!walletAddress || !selectedPool || !provider) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  const seenAddr = new Set();
  const idxs = [];
  for (let i = 0; i < selectedPool.coinsAddresses.length; i++) {
    const a = (selectedPool.coinsAddresses[i] || '').toLowerCase();
    if (!a || seenAddr.has(a)) continue;
    seenAddr.add(a);
    idxs.push(i);
  }
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
  // Render only rows with a positive balance. Hide section entirely if none.
  const positive = rows.filter(r => !r.error && typeof r.balance === 'bigint' && r.balance > 0n);
  if (positive.length === 0) {
    section.style.display = 'none';
    list.innerHTML = '';
    return;
  }
  section.style.display = '';
  let html = '';
  for (const r of positive) {
    const iconHtml = (typeof _tokenIconInlineHtml === 'function')
      ? _tokenIconInlineHtml('token-icon', r.addr, r.symbol)
      : `<div class="token-icon">${(r.symbol || '').slice(0, 2)}</div>`;
    const display = parseFloat(ethers.formatUnits(r.balance, r.decimals)).toFixed(4);
    html += `<div class="balance-row">
      <div class="balance-token">${iconHtml}${r.symbol}</div>
      <div class="balance-amount">${display}</div>
    </div>`;
  }
  list.innerHTML = html;
}

async function loadDepositBalances() {
  if (!walletAddress || !selectedPool || !provider) return;
  for (let i = 0; i < selectedPool.coinsAddresses.length; i++) {
    const addr = selectedPool.coinsAddresses[i];
    const decimals = parseInt(selectedPool.decimals[i]) || 18;
    const el = document.getElementById(`depCoinBal_${i}`);
    if (!el) continue;
    try {
      let balance;
      if (addr.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
        balance = await provider.getBalance(walletAddress);
      } else {
        const contract = new ethers.Contract(addr, ERC20_ABI, provider);
        balance = await contract.balanceOf(walletAddress);
      }
      // Store raw BigInt in data-attr for precision-preserving MAX/% buttons.
      // Display is truncated to 4 decimals for UI, but raw wei is the source of
      // truth on submit (prevents .toFixed() overshoot that reverts tx — see
      // tx 0x61fce3fd... 2026-05-21 where YB MAX overshot 46246306059663 wei).
      el.dataset.rawWei = balance.toString();
      el.dataset.decimals = String(decimals);
      el.textContent = 'Bal: ' + parseFloat(ethers.formatUnits(balance, decimals)).toFixed(4);
    } catch (e) {
      delete el.dataset.rawWei;
      delete el.dataset.decimals;
      el.textContent = 'Bal: --';
    }
  }
}

// Format LP balance like native curve.finance: collapse positive sub-1e-5
// values to "<0.00001" instead of "0.000000" so users see they own micro
// dust (relevant for residual balances after full Withdraw / partial fill).
function _formatLP(n) {
  if (!Number.isFinite(n) || n <= 0) return n === 0 ? '0.000000' : '0';
  if (n < 1e-5) return '<0.00001';
  return n.toFixed(6);
}

async function loadLPBalance() {
  if (!walletAddress || !selectedPool || !provider) return;
  const lpAddr = selectedPool.lpTokenAddress || selectedPool.address;
  try {
    const contract = new ethers.Contract(lpAddr, ERC20_ABI, provider);
    const balance = await contract.balanceOf(walletAddress);
    lpBalanceRaw = balance;
    const formatted = _formatLP(parseFloat(ethers.formatUnits(balance, 18)));
    document.getElementById('withdrawLPBalance').textContent = 'Balance: ' + formatted;
    document.getElementById('stakeLpBalance').textContent = formatted;
  } catch (e) {
    console.error('LP balance error:', e);
  }
}

async function loadStakeData() {
  if (!walletAddress || !selectedPool || !provider) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') return;
  try {
    const contract = new ethers.Contract(gauge, GAUGE_ABI, provider);
    const staked = await contract.balanceOf(walletAddress);
    stakedLPRaw = staked;
    const stakedFmt = parseFloat(ethers.formatUnits(staked, 18)).toFixed(6);
    document.getElementById('stakedBalance').textContent = stakedFmt;
    let earnedFmt = '0.0000';
    let earnedRaw = 0n;
    try {
      earnedRaw = await contract.claimable_tokens(walletAddress);
      earnedFmt = parseFloat(ethers.formatUnits(earnedRaw, 18)).toFixed(4);
    } catch (e) { /* claimable_tokens reverts on some gauges */ }
    _withdrawPendingCRVRaw = earnedRaw;
    document.getElementById('earnedCRV').textContent = earnedFmt;
    // Mirror into the new Unstake / Claim Rewards sub-tabs.
    const usb = document.getElementById('unstakeStakedBalance');
    const ulb = document.getElementById('unstakeLpBalance');
    const cec = document.getElementById('claimEarnedCRV');
    const csb = document.getElementById('claimStakedBalance');
    if (usb) usb.textContent = stakedFmt;
    if (ulb) ulb.textContent = parseFloat(ethers.formatUnits(lpBalanceRaw, 18)).toFixed(6);
    if (cec) cec.textContent = earnedFmt;
    if (csb) csb.textContent = stakedFmt;
  } catch (e) {
    console.error('Stake data error:', e);
  }
  updateWithdrawGaugeActions();
  _refreshWithdrawClaimRow();
}

// Show Unstake/Claim actions on Withdraw tab only when pool has a real gauge.
function updateWithdrawGaugeActions() {
  const wrap = document.getElementById('withdrawGaugeActions');
  if (!wrap) return;
  if (!selectedPool) { wrap.style.display = 'none'; return; }
  const gauge = selectedPool.gaugeAddress;
  const hasGauge = gauge && gauge !== '0x0000000000000000000000000000000000000000';
  wrap.style.display = hasGauge ? '' : 'none';
}

// Module-level state for Withdraw "Also claim" checkbox row.
// Populated by loadStakeData (CRV) and _refreshWithdrawClaimRow (extras).
let _withdrawPendingCRVRaw = 0n;
let _withdrawExtrasTokens = []; // [{ symbol, claimable }]

// Toggle checkbox row visibility/text + asynchronously refresh extras count.
async function _refreshWithdrawClaimRow() {
  const row = document.getElementById('withdrawClaimRow');
  if (!row) return;
  if (!selectedPool || !walletAddress) { row.style.display = 'none'; return; }
  const gauge = selectedPool.gaugeAddress;
  const hasGauge = gauge && gauge !== '0x0000000000000000000000000000000000000000';
  if (!hasGauge) { row.style.display = 'none'; return; }
  // Async fetch extras (cached). Tolerate failure → empty array.
  try {
    let extras = { tokens: [] };
    if (window.Portfolio && typeof window.Portfolio._fetchExtras === 'function') {
      extras = await window.Portfolio._fetchExtras(gauge, walletAddress);
    } else if (typeof _yieldFetchExtras === 'function') {
      extras = await _yieldFetchExtras(gauge, walletAddress);
    }
    _withdrawExtrasTokens = (extras.tokens || []).filter(t => t.claimable > 0);
  } catch (e) {
    _withdrawExtrasTokens = [];
  }
  _renderWithdrawClaimRow();
}

function _renderWithdrawClaimRow() {
  const row = document.getElementById('withdrawClaimRow');
  const sum = document.getElementById('withdrawClaimSummary');
  if (!row) return;
  const hasCrv = _withdrawPendingCRVRaw > 0n;
  const hasExtras = _withdrawExtrasTokens.length > 0;
  row.style.display = (hasCrv || hasExtras) ? '' : 'none';
  if (sum) {
    const parts = [];
    if (hasCrv && typeof ethers !== 'undefined') {
      parts.push(`${parseFloat(ethers.formatUnits(_withdrawPendingCRVRaw, 18)).toFixed(4)} CRV`);
    }
    if (hasExtras) {
      parts.push(`+ ${_withdrawExtrasTokens.length} extra${_withdrawExtrasTokens.length > 1 ? 's' : ''}`);
    }
    sum.textContent = parts.join(' ');
  }
}

// Re-estimate gas when checkbox toggles.
function onWithdrawClaimToggle() {
  if (typeof _scheduleGasUpdate === 'function') _scheduleGasUpdate('withdraw', updateWithdrawGas, 50);
}


// ============================================================
// YIELD: Two-Level Tab Switching (curve.finance UX)
// Top level: DEPOSIT | WITHDRAW (no Swap — by design).
// Sub level: action variants beneath each top tab.
// ============================================================
let _activeTopTab = 'deposit';
let _activeSubTab = 'deposit';
const SUB_TABS = {
  deposit: [
    { id: 'deposit', label: 'Deposit' },
    { id: 'stake', label: 'Stake' },
    { id: 'deposit-and-stake', label: 'Deposit & Stake' },
  ],
  withdraw: [
    { id: 'withdraw', label: 'Withdraw' },
    { id: 'unstake', label: 'Unstake' },
    { id: 'claim-rewards', label: 'Claim Rewards' },
  ],
  // INFO top-tab has no sub-tabs — it shows ratings cards for current pool tokens.
  info: [
    { id: 'info', label: '' },
  ],
};
const _SUB_TAB_PANEL_IDS = ['tab-deposit', 'tab-stake', 'tab-deposit-and-stake', 'tab-withdraw', 'tab-unstake', 'tab-claim-rewards', 'tab-info'];

function setYieldTopTab(top) {
  if (!SUB_TABS[top]) return;
  _activeTopTab = top;
  _activeSubTab = SUB_TABS[top][0].id;
  renderYieldTopTabs();
  renderYieldSubTabs();
  showActiveYieldFormPanel();
}

function setYieldSubTab(sub) {
  _activeSubTab = sub;
  renderYieldSubTabs();
  showActiveYieldFormPanel();
}

function renderYieldTopTabs() {
  document.querySelectorAll('#view-yield-right .yt-top').forEach(b => {
    b.classList.toggle('active', b.dataset.top === _activeTopTab);
  });
}

function renderYieldSubTabs() {
  const container = document.getElementById('ySubTabs');
  if (!container) return;
  // INFO top-tab has a single empty-label sub — hide the sub-tab row entirely
  // so the panel sits flush under the top tabs.
  if (_activeTopTab === 'info') {
    container.innerHTML = '';
    container.style.display = 'none';
    return;
  }
  container.style.display = '';
  const subs = SUB_TABS[_activeTopTab] || [];
  container.innerHTML = subs.map(s =>
    `<button class="yt-sub${s.id === _activeSubTab ? ' active' : ''}" data-sub="${s.id}" onclick="setYieldSubTab('${s.id}')">${s.label}</button>`
  ).join('');
}

function showActiveYieldFormPanel() {
  const targetId = 'tab-' + _activeSubTab;
  for (const id of _SUB_TAB_PANEL_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.display = (id === targetId) ? '' : 'none';
    el.classList.toggle('active', id === targetId);
  }
  // Per-tab refresh: keep info panels in sync when user switches.
  if (_activeSubTab === 'unstake') updateUnstakeTabUI();
  else if (_activeSubTab === 'claim-rewards') updateClaimTabUI();
  else if (_activeSubTab === 'deposit-and-stake') {
    if (typeof buildDepositAndStakeUI === 'function') buildDepositAndStakeUI();
    updateDepositAndStakeButton();
  }
  else if (_activeSubTab === 'info') {
    if (typeof renderYieldInfoTab === 'function') renderYieldInfoTab();
  }
  // Trigger gas estimate for the now-visible tab (if helpers loaded).
  if (window._yieldGasHooks && typeof window._yieldGasHooks.onTabShow === 'function') {
    window._yieldGasHooks.onTabShow(_activeSubTab);
  }
}

// Backward-compat: any legacy caller using switchYieldTab() still works.
function switchYieldTab(tabName) {
  // Map legacy flat names → new (top, sub) pair.
  const topByLegacy = {
    deposit: 'deposit',
    stake: 'deposit',
    'deposit-and-stake': 'deposit',
    withdraw: 'withdraw',
    unstake: 'withdraw',
    'claim-rewards': 'withdraw',
  };
  const top = topByLegacy[tabName] || 'deposit';
  _activeTopTab = top;
  _activeSubTab = tabName;
  renderYieldTopTabs();
  renderYieldSubTabs();
  showActiveYieldFormPanel();
}

// ============================================================
// YIELD: Sub-tab info refreshers (Unstake / Claim Rewards)
// ============================================================
function updateUnstakeTabUI() {
  if (!selectedPool) return;
  const gauge = selectedPool.gaugeAddress;
  const hasGauge = gauge && gauge !== '0x0000000000000000000000000000000000000000';
  const noMsg = document.getElementById('unstakeNoGaugeMsg');
  const submit = document.getElementById('unstakeSubmit');
  const inp = document.getElementById('unstakeAmountInput');
  if (noMsg) noMsg.style.display = hasGauge ? 'none' : '';
  if (submit) submit.style.display = hasGauge ? '' : 'none';
  if (inp) inp.disabled = !hasGauge;
  const ga = document.getElementById('unstakeGaugeAddr');
  if (ga) ga.innerHTML = hasGauge ? `<a href="${window.getExplorerAddressUrl ? window.getExplorerAddressUrl(gauge) : 'https://etherscan.io/address/' + gauge}" target="_blank" rel="noopener noreferrer" title="${gauge}">${shortAddr(gauge)}</a>` : 'N/A';
  if (typeof ethers !== 'undefined') {
    const sb = document.getElementById('unstakeStakedBalance');
    const lb = document.getElementById('unstakeLpBalance');
    if (sb) sb.textContent = parseFloat(ethers.formatUnits(stakedLPRaw, 18)).toFixed(6);
    if (lb) lb.textContent = parseFloat(ethers.formatUnits(lpBalanceRaw, 18)).toFixed(6);
  }
  if (!walletAddress && submit) {
    submit.textContent = 'Connect Wallet';
    submit.className = 'action-btn connect';
  } else if (submit) {
    submit.textContent = 'Unstake';
    submit.className = 'action-btn ready';
  }
}

function updateClaimTabUI() {
  if (!selectedPool) return;
  const gauge = selectedPool.gaugeAddress;
  const hasGauge = gauge && gauge !== '0x0000000000000000000000000000000000000000';
  const noMsg = document.getElementById('claimNoGaugeMsg');
  const list = document.getElementById('yieldClaimList');
  if (noMsg) noMsg.style.display = hasGauge ? 'none' : '';
  if (list) list.style.display = hasGauge ? '' : 'none';
  // Mirror Earned CRV / Staked from Stake tab DOM (loadStakeData updates those continuously).
  const earnedTxt = document.getElementById('earnedCRV')?.textContent || '--';
  const staked = document.getElementById('stakedBalance')?.textContent || '--';
  const ec = document.getElementById('claimEarnedCRV');
  const sc = document.getElementById('claimStakedBalance');
  if (ec) ec.textContent = earnedTxt;
  if (sc) sc.textContent = staked;
  // Enable/disable CRV button based on earned > 0
  const crvBtn = document.getElementById('yieldClaimCrvBtn');
  const earnedNum = parseFloat(earnedTxt);
  if (crvBtn) {
    if (!walletAddress) {
      crvBtn.textContent = 'Connect';
      crvBtn.disabled = false;
      crvBtn.onclick = () => connectWallet();
    } else {
      crvBtn.textContent = 'Claim';
      crvBtn.onclick = () => handleClaimCRVFromYield();
      crvBtn.disabled = !(isFinite(earnedNum) && earnedNum > 0);
    }
  }
  // Async fetch on-chain extras for THIS gauge (own claimable + symbol). Replace
  // any existing yield-extras row(s) when settled. Skip if no gauge / no wallet.
  if (hasGauge && walletAddress) {
    _renderYieldExtrasRow(gauge);
  } else {
    document.querySelectorAll('.yield-claim-extras-row').forEach(n => n.remove());
  }
}

// Fetch + render extras row for /yield Claim Rewards tab. Mirrors portfolio.js
// _renderExtrasRows logic: 1 token = own row, ≥2 tokens = collapsed "Extras" row.
async function _renderYieldExtrasRow(gauge) {
  const list = document.getElementById('yieldClaimList');
  if (!list) return;
  // Reuse Portfolio's cached fetcher when available; falls back to inline impl.
  let extras = { tokens: [] };
  try {
    if (window.Portfolio && typeof window.Portfolio._fetchExtras === 'function') {
      extras = await window.Portfolio._fetchExtras(gauge, walletAddress);
    } else {
      extras = await _yieldFetchExtras(gauge, walletAddress);
    }
  } catch (e) {
    extras = { tokens: [] };
  }
  // Remove any existing extras rows first
  list.querySelectorAll('.yield-claim-extras-row').forEach(n => n.remove());
  const tokens = extras.tokens || [];
  if (tokens.length === 0) return;
  let row;
  if (tokens.length === 1) {
    const t = tokens[0];
    const has = t.claimable > 0;
    row = document.createElement('div');
    row.className = 'pm-claim-row yield-claim-extras-row';
    row.innerHTML = `
      <span class="pm-claim-label">${_yieldEsc(t.symbol)}</span>
      <span class="pm-claim-amount">${t.claimable.toFixed(4)}</span>
      <button class="pm-claim-btn" onclick="handleClaimExtrasFromYield()"${has ? '' : ' disabled'}>Claim</button>
    `;
  } else {
    const amounts = tokens.map(t => `${t.claimable.toFixed(4)} ${_yieldEsc(t.symbol)}`).join(' · ');
    const any = tokens.some(t => t.claimable > 0);
    row = document.createElement('div');
    row.className = 'pm-claim-row yield-claim-extras-row';
    row.innerHTML = `
      <span class="pm-claim-label">Extras</span>
      <span class="pm-claim-amount">${amounts}</span>
      <button class="pm-claim-btn" onclick="handleClaimExtrasFromYield()"${any ? '' : ' disabled'}>Claim All</button>
    `;
  }
  list.appendChild(row);
}

function _yieldEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

// Fallback inline extras fetcher used if Portfolio module isn't loaded yet.
async function _yieldFetchExtras(gaugeAddr, walletAddr) {
  if (typeof ethers === 'undefined' || !provider) return { tokens: [] };
  try {
    const gIface = new ethers.Interface([
      'function reward_count() view returns (uint256)',
      'function reward_tokens(uint256) view returns (address)',
      'function claimable_reward(address, address) view returns (uint256)',
    ]);
    const eIface = new ethers.Interface([
      'function symbol() view returns (string)',
      'function decimals() view returns (uint8)',
    ]);
    const mc = new ethers.Contract(
      '0xcA11bde05977b3631167028862bE2a173976CA11',
      ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])'],
      provider,
    );
    const rcRes = await mc.aggregate3.staticCall([
      { target: gaugeAddr, allowFailure: true, callData: gIface.encodeFunctionData('reward_count', []) },
    ]);
    let n = 0;
    try { if (rcRes[0]?.success) n = Number((gIface.decodeFunctionResult('reward_count', rcRes[0].returnData))[0]); } catch (_) {}
    if (!n) return { tokens: [] };
    const tCalls = [];
    for (let i = 0; i < n; i++) tCalls.push({ target: gaugeAddr, allowFailure: true, callData: gIface.encodeFunctionData('reward_tokens', [i]) });
    const tRes = await mc.aggregate3.staticCall(tCalls);
    const addrs = [];
    for (let i = 0; i < n; i++) {
      try { if (tRes[i]?.success) {
        const [a] = gIface.decodeFunctionResult('reward_tokens', tRes[i].returnData);
        if (a && a !== '0x0000000000000000000000000000000000000000') addrs.push(a);
      } } catch (_) {}
    }
    if (addrs.length === 0) return { tokens: [] };
    const dCalls = [];
    for (const a of addrs) {
      dCalls.push({ target: gaugeAddr, allowFailure: true, callData: gIface.encodeFunctionData('claimable_reward', [walletAddr, a]) });
      dCalls.push({ target: a, allowFailure: true, callData: eIface.encodeFunctionData('symbol', []) });
      dCalls.push({ target: a, allowFailure: true, callData: eIface.encodeFunctionData('decimals', []) });
    }
    const dRes = await mc.aggregate3.staticCall(dCalls);
    const tokens = addrs.map((a, i) => {
      const off = i * 3;
      let cBn = 0n, sym = a.slice(0, 6) + '…', dec = 18;
      try { if (dRes[off]?.success) [cBn] = gIface.decodeFunctionResult('claimable_reward', dRes[off].returnData); } catch (_) {}
      try { if (dRes[off + 1]?.success) [sym] = eIface.decodeFunctionResult('symbol', dRes[off + 1].returnData); } catch (_) {}
      try { if (dRes[off + 2]?.success) [dec] = eIface.decodeFunctionResult('decimals', dRes[off + 2].returnData); } catch (_) {}
      return { address: a, symbol: String(sym), decimals: Number(dec), claimable: parseFloat(ethers.formatUnits(cBn, Number(dec))) };
    });
    return { tokens };
  } catch (e) {
    console.debug('[yield] _yieldFetchExtras failed:', e?.shortMessage || e?.message);
    return { tokens: [] };
  }
}

// ============================================================
// YIELD: Unstake (from dedicated tab — uses #unstakeAmountInput)
// ============================================================
// Guard + error mapping for gauge unstake. Reads the LIVE staked balance for
// THIS wallet at click time (a stale on-screen balance can't push a doomed tx),
// and maps opaque ethers errors to a human message. Without this, withdrawing
// more LP than the gauge holds for you reverts and some wallet RPCs return the
// revert in a shape ethers v6 can't decode -> the raw "could not coalesce
// error" testers reported.
async function clampUnstake(gauge, amtWei) {
  const staked = await new ethers.Contract(gauge, GAUGE_ABI, signer).balanceOf(walletAddress);
  if (staked === 0n) throw new Error('Nothing staked to unstake on this wallet.');
  // The on-screen / preset amount is a rounded display value and can round UP
  // past the exact 18-decimal staked balance (e.g. 304.40836608 >
  // 304.408366078245481253), which makes the gauge revert and surfaces as the
  // opaque "could not coalesce error". Clamp to the exact balance so an
  // "unstake all" intent always works down to the wei.
  return amtWei > staked ? staked : amtWei;
}
function cleanTxError(e) {
  const m = (e && (e.shortMessage || e.message)) || String(e);
  if (e?.code === 'CALL_EXCEPTION' || /could not coalesce|missing revert|UNKNOWN_ERROR/i.test(m)) {
    return 'network rejected the transaction \u2014 the amount is likely larger than your staked balance. Check the amount and try again.';
  }
  return m;
}

function setUnstakePreset(pct) {
  if (typeof ethers === 'undefined') return;
  if (stakedLPRaw === 0n) return;
  document.getElementById('unstakeAmountInput').value = ethers.formatUnits(
    (stakedLPRaw * BigInt(Math.round(pct * 10000))) / 10000n, 18,
  );
}

async function handleUnstakeFromUnstakeTab() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') return;
  const amtVal = document.getElementById('unstakeAmountInput').value;
  if (!amtVal || parseFloat(amtVal) <= 0) { alert('Enter LP token amount to unstake'); return; }
  const btn = document.getElementById('unstakeSubmit');
  btn.textContent = 'Unstaking...';
  btn.className = 'action-btn disabled';
  try {
    let _amtWei = ethers.parseUnits(amtVal, 18);
    _amtWei = await clampUnstake(gauge, _amtWei);
    await (await window.sendContractTxWithDynamicGas(new ethers.Contract(gauge, GAUGE_ABI, signer), 'withdraw(uint256)', [_amtWei])).wait();
    document.getElementById('unstakeAmountInput').value = '';
    await loadLPBalance();
    await loadStakeData();
    updateUnstakeTabUI();
  } catch (e) {
    console.error('Unstake error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Unstake failed: ' + cleanTxError(e));
    btn.textContent = 'Unstake';
    btn.className = 'action-btn ready';
  }
}

// ============================================================
// YIELD: Claim Rewards (Minter.mint() for CRV + best-effort extras)
// CRV emissions are minted via the Minter contract, NOT gauge.claim_rewards()
// (claim_rewards only handles extra reward tokens). See portfolio.js commit 63b32dfc.
// ============================================================
const MINTER_ADDR = '0xd061D61a4d941c39E5453435B6345Dc261C2fcE0';
const MINTER_ABI = ['function mint(address gauge_addr) external'];

// Separate "Claim CRV" handler — Minter.mint(gauge) only. Mirrors classical curve.finance UX.
async function handleClaimCRVFromYield() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') return;
  const btn = document.getElementById('yieldClaimCrvBtn');
  if (btn) { btn.textContent = 'Claiming...'; btn.disabled = true; }
  try {
    const minter = new ethers.Contract(MINTER_ADDR, MINTER_ABI, signer);
    await (await minter.mint(gauge)).wait();
    await loadStakeData();
    updateClaimTabUI();
  } catch (e) {
    console.error('Claim CRV error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Claim CRV failed: ' + (e.shortMessage || e.message));
    if (btn) { btn.textContent = 'Claim'; btn.disabled = false; }
  }
}

// Separate "Claim Extras" handler — gauge.claim_rewards() (claims ALL extras for this gauge).
// Curve gauges don't expose per-token claim; UI collapses 2+ extras into one "Claim All" row.
async function handleClaimExtrasFromYield() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') return;
  // Find the active extras button via DOM (more robust than relying on event arg).
  const btn = document.querySelector('.yield-claim-extras-row .pm-claim-btn');
  const origLabel = btn ? btn.textContent : '';
  if (btn) { btn.textContent = 'Claiming...'; btn.disabled = true; }
  try {
    const g = new ethers.Contract(gauge, GAUGE_ABI, signer);
    await (await window.sendContractTxWithDynamicGas(g, 'claim_rewards', [])).wait();
    await loadStakeData();
    updateClaimTabUI();
  } catch (e) {
    console.error('Claim extras error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Claim extras failed: ' + (e.shortMessage || e.message));
    if (btn) { btn.textContent = origLabel || 'Claim'; btn.disabled = false; }
  }
}

// ============================================================
// YIELD: Deposit & Stake (combined flow: add_liquidity → approve LP → gauge.deposit)
// Reuses Deposit-tab inputs verbatim (mirrors values from #depAmount_*) so users
// don't have to re-enter amounts when toggling between Deposit and Deposit & Stake.
// ============================================================
let dasSlippage = 0.5;
let dasQuoteTimer = null;

function buildDepositAndStakeUI() {
  if (!selectedPool) return;
  const container = document.getElementById('dasCoinInputs');
  if (!container) return;
  const coins = selectedPool.coins;
  if (!coins || coins.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px;font-size:12px;">No coin data for this pool</div>';
    return;
  }
  const gauge = selectedPool.gaugeAddress;
  const hasGauge = gauge && gauge !== '0x0000000000000000000000000000000000000000';
  const noMsg = document.getElementById('dasNoGaugeMsg');
  const submit = document.getElementById('dasSubmit');
  if (noMsg) noMsg.style.display = hasGauge ? 'none' : '';
  if (submit) submit.style.display = hasGauge ? '' : 'none';
  container.innerHTML = coins.map((coin, i) => `
    <div class="coin-input-group">
      <div class="coin-input-box">
        <div class="coin-input-header">
          <span class="coin-input-label"><img class="token-icon" src="${_tokenIconUrl(selectedPool.coinsAddresses[i])}" alt="" width="20" height="20" loading="lazy" onerror="this.style.display='none'"> ${coin}</span>
          <span class="coin-input-balance" id="dasCoinBal_${i}" onclick="setDasMax(${i})">Bal: --</span>
        </div>
        <div class="coin-input-row">
          <input type="number" class="coin-amount-input" id="dasAmount_${i}" placeholder="0.0" step="any" oninput="onDasAmountChange()">
        </div>
        <div class="coin-preset-btns">
          <button class="coin-preset-btn" onclick="setDasPreset(${i}, 0.25)">25%</button>
          <button class="coin-preset-btn" onclick="setDasPreset(${i}, 0.50)">50%</button>
          <button class="coin-preset-btn" onclick="setDasPreset(${i}, 0.75)">75%</button>
          <button class="coin-preset-btn" onclick="setDasPreset(${i}, 1.0)">MAX</button>
        </div>
      </div>
    </div>
  `).join('');
  document.getElementById('dasPreview').style.display = 'none';
  updateDepositAndStakeButton();
  if (walletAddress) loadDepositBalances(); // shared with Deposit tab
  // Mirror Deposit-tab balances into dasCoinBal_* labels via direct copy.
  // Includes data-rawWei/data-decimals — required so setDasMax/setDasPreset
  // can read raw BigInt without going back to depCoinBal_* (still safe to fall
  // back via _resolveDepositRawBal, but mirroring keeps DOM self-consistent).
  setTimeout(() => {
    for (let i = 0; i < coins.length; i++) {
      const src = document.getElementById(`depCoinBal_${i}`);
      const dst = document.getElementById(`dasCoinBal_${i}`);
      if (src && dst) {
        dst.textContent = src.textContent;
        if (src.dataset.rawWei) dst.dataset.rawWei = src.dataset.rawWei;
        else delete dst.dataset.rawWei;
        if (src.dataset.decimals) dst.dataset.decimals = src.dataset.decimals;
        else delete dst.dataset.decimals;
      }
    }
  }, 800);
}

// Resolve raw BigInt balance for deposit/das coin slot. Prefers data-rawWei
// (set by loadDepositBalances), falls back to depCoinBal mirror (das tab
// copies textContent from depCoinBal_*, but data-* attrs ARE NOT copied — so
// fall back to reading depCoinBal_${index} data-rawWei directly).
// Returns { raw: BigInt, decimals: number } or null if unavailable.
function _resolveDepositRawBal(index) {
  const dasEl = document.getElementById(`dasCoinBal_${index}`);
  const depEl = document.getElementById(`depCoinBal_${index}`);
  const el = (dasEl && dasEl.dataset && dasEl.dataset.rawWei) ? dasEl : depEl;
  if (!el || !el.dataset || !el.dataset.rawWei) return null;
  try {
    return { raw: BigInt(el.dataset.rawWei), decimals: parseInt(el.dataset.decimals || '18') };
  } catch (_) { return null; }
}

function setDasMax(index) {
  if (!walletAddress || !selectedPool || typeof ethers === 'undefined') return;
  const b = _resolveDepositRawBal(index);
  if (!b || b.raw === 0n) return;
  // Use full-precision formatUnits — parseUnits round-trips cleanly, so submit
  // sees exact raw wei (no .toFixed() overshoot).
  document.getElementById(`dasAmount_${index}`).value = ethers.formatUnits(b.raw, b.decimals);
  onDasAmountChange();
}

function setDasPreset(index, pct) {
  if (!walletAddress || !selectedPool || typeof ethers === 'undefined') return;
  const b = _resolveDepositRawBal(index);
  if (!b || b.raw === 0n) return;
  // BigInt percent math: avoid float drift on raw wei.
  const amt = (b.raw * BigInt(Math.round(pct * 10000))) / 10000n;
  document.getElementById(`dasAmount_${index}`).value = ethers.formatUnits(amt, b.decimals);
  onDasAmountChange();
}

function onDasAmountChange() {
  clearTimeout(dasQuoteTimer);
  dasQuoteTimer = setTimeout(getDasQuote, 400);
  updateDepositAndStakeButton();
  updateDasApySim();
}

async function getDasQuote() {
  if (!selectedPool) return;
  await loadEthers();
  const n = selectedPool.coins.length;
  const amounts = [];
  let hasAny = false;
  for (let i = 0; i < n; i++) {
    const el = document.getElementById(`dasAmount_${i}`);
    const val = el ? parseFloat(el.value) : 0;
    if (val > 0) hasAny = true;
    const decimals = parseInt(selectedPool.decimals[i]) || 18;
    amounts.push(val > 0 ? ethers.parseUnits(val.toFixed(decimals > 8 ? 8 : decimals), decimals) : 0n);
  }
  if (!hasAny) { document.getElementById('dasPreview').style.display = 'none'; return; }
  try {
    // ABI style (fixed uint256[N] vs stable-ng dynamic uint256[]) resolved
    // per pool via window.poolLiquidityAbi — also covers n > 4 pools.
    const iface = new ethers.Interface([window.poolLiquidityAbi(selectedPool, n).calc]);
    const result = await rpcCall(iface.encodeFunctionData('calc_token_amount', [amounts, true]), selectedPool.address);
    const lpFormatted = ethers.formatUnits(BigInt(result), 18);
    document.getElementById('dasPreview').style.display = '';
    document.getElementById('dasExpectedLP').textContent = parseFloat(lpFormatted).toFixed(6) + ' LP';
    if (selectedPool.tvl > 0) {
      document.getElementById('dasShareOfPool').textContent = '~' + (parseFloat(lpFormatted) / (selectedPool.tvl + parseFloat(lpFormatted)) * 100).toFixed(4) + '%';
    }
  } catch (e) { console.error('DAS quote error:', e); }
}

function updateDepositAndStakeButton() {
  const btn = document.getElementById('dasSubmit');
  if (!btn) return;
  if (!walletAddress) { btn.textContent = 'Connect Wallet'; btn.className = 'action-btn connect'; return; }
  if (!selectedPool) { btn.textContent = 'Select a Pool'; btn.className = 'action-btn disabled'; return; }
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') {
    btn.textContent = 'No Gauge'; btn.className = 'action-btn disabled'; return;
  }
  const n = selectedPool.coins.length;
  let hasAny = false;
  for (let i = 0; i < n; i++) { const el = document.getElementById(`dasAmount_${i}`); if (el && parseFloat(el.value) > 0) hasAny = true; }
  if (!hasAny) { btn.textContent = 'Enter Amount'; btn.className = 'action-btn disabled'; return; }
  btn.textContent = 'Deposit & Stake';
  btn.className = 'action-btn ready';
}

function setDasStatus(msg) {
  const el = document.getElementById('dasStatus');
  if (!el) return;
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = ''; el.textContent = msg;
}

async function handleDepositAndStakeSubmit() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') { alert('This pool has no gauge.'); return; }
  const n = selectedPool.coins.length;
  const amounts = [];
  let hasAny = false;
  for (let i = 0; i < n; i++) {
    const el = document.getElementById(`dasAmount_${i}`);
    const val = el ? parseFloat(el.value) : 0;
    if (val > 0) hasAny = true;
    const decimals = parseInt(selectedPool.decimals[i]) || 18;
    amounts.push(val > 0 ? ethers.parseUnits(val.toFixed(decimals > 8 ? 8 : decimals), decimals) : 0n);
  }
  if (!hasAny) return;
  const btn = document.getElementById('dasSubmit');
  btn.textContent = 'Processing...';
  btn.className = 'action-btn disabled';
  try {
    // Step 1/2 (with optional approvals): add_liquidity.
    setDasStatus('Step 1/2: approving deposit tokens...');
    for (let i = 0; i < n; i++) {
      if (amounts[i] === 0n) continue;
      const addr = selectedPool.coinsAddresses[i];
      if (addr.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') continue;
      const token = new ethers.Contract(addr, ERC20_ABI, signer);
      const allowance = await token.allowance(walletAddress, selectedPool.address);
      if (allowance < amounts[i]) { await (await window.sendContractTxWithDynamicGas(token, 'approve', [selectedPool.address, ethers.MaxUint256])).wait(); }
    }
    setDasStatus('Step 1/2: adding liquidity...');
    const liqAbi = window.poolLiquidityAbi(selectedPool, n);
    let minMint = 0n;
    try {
      const result = await rpcCall(new ethers.Interface([liqAbi.calc]).encodeFunctionData('calc_token_amount', [amounts, true]), selectedPool.address);
      minMint = BigInt(result) * BigInt(Math.round((1 - dasSlippage / 100) * 10000)) / 10000n;
    } catch (_) { /* keep minMint = 0n best-effort (same as old missing-iface path) */ }
    const addIface = new ethers.Interface([liqAbi.add]);
    const poolContract = new ethers.Contract(selectedPool.address, addIface, signer);
    let ethValue = 0n;
    for (let i = 0; i < n; i++) {
      if (selectedPool.coinsAddresses[i]?.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') ethValue = amounts[i];
    }
    await (await window.sendContractTxWithDynamicGas(poolContract, 'add_liquidity', [amounts, minMint], { value: ethValue })).wait();

    // Step 2/2: approve LP for gauge (if needed) → gauge.deposit(lpBal).
    const lpAddr = selectedPool.lpTokenAddress || selectedPool.address;
    const lpToken = new ethers.Contract(lpAddr, ERC20_ABI, signer);
    const lpBal = await lpToken.balanceOf(walletAddress);
    if (lpBal === 0n) {
      setDasStatus('LP balance is zero — staking skipped.');
      throw new Error('LP balance is 0 after deposit — staking aborted.');
    }
    const allowance = await lpToken.allowance(walletAddress, gauge);
    if (allowance < lpBal) {
      setDasStatus('Step 2/2: approving LP for gauge...');
      await (await window.sendContractTxWithDynamicGas(lpToken, 'approve', [gauge, ethers.MaxUint256])).wait();
    }
    setDasStatus('Step 2/2: staking LP into gauge...');
    // Overload fallback chain (mirrors portfolio.js executeStake, commit de89f481):
    // newer gauges: deposit(uint256, address, bool); legacy: deposit(uint256, address); ancient: deposit(uint256).
    const gaugeContract = new ethers.Contract(gauge, [
      'function deposit(uint256)',
      'function deposit(uint256,address)',
      'function deposit(uint256,address,bool)',
    ], signer);
    let staked = false;
    try {
      await (await window.sendContractTxWithDynamicGas(gaugeContract, 'deposit(uint256,address,bool)', [lpBal, walletAddress, false])).wait();
      staked = true;
    } catch (_) {
      try {
        await (await window.sendContractTxWithDynamicGas(gaugeContract, 'deposit(uint256,address)', [lpBal, walletAddress])).wait();
        staked = true;
      } catch (__) {
        await (await window.sendContractTxWithDynamicGas(gaugeContract, 'deposit(uint256)', [lpBal])).wait();
        staked = true;
      }
    }
    if (staked) setDasStatus('Done!');
    for (let i = 0; i < n; i++) { const el = document.getElementById(`dasAmount_${i}`); if (el) el.value = ''; }
    document.getElementById('dasPreview').style.display = 'none';
    await loadAllYieldBalances();
    setTimeout(() => setDasStatus(''), 2000);
  } catch (e) {
    console.error('Deposit & Stake error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Deposit & Stake failed: ' + (e.shortMessage || e.message));
    setDasStatus('');
  }
  updateDepositAndStakeButton();
}

// Slippage button wiring for Deposit & Stake (deferred until DOM is ready).
document.addEventListener('click', (ev) => {
  const t = ev.target;
  if (t && t.classList && t.classList.contains('das-slip')) {
    document.querySelectorAll('.das-slip').forEach(b => b.classList.toggle('active', b === t));
    dasSlippage = parseFloat(t.dataset.slip);
  }
});

// ============================================================
// YIELD: Deposit
// ============================================================
function buildDepositUI() {
  if (!selectedPool) return;
  const container = document.getElementById('depositCoinInputs');
  const coins = selectedPool.coins;
  if (coins.length === 0) {
    container.innerHTML = '<div style="text-align:center;color:var(--text-dim);padding:20px;font-size:12px;">No coin data for this pool</div>';
    return;
  }
  container.innerHTML = coins.map((coin, i) => `
    <div class="coin-input-group">
      <div class="coin-input-box">
        <div class="coin-input-header">
          <span class="coin-input-label"><img class="token-icon" src="${_tokenIconUrl(selectedPool.coinsAddresses[i])}" alt="" width="20" height="20" loading="lazy" onerror="this.style.display='none'"> ${coin}</span>
          <span class="coin-input-balance" id="depCoinBal_${i}" onclick="setDepositMax(${i})">Bal: --</span>
        </div>
        <div class="coin-input-row">
          <input type="number" class="coin-amount-input" id="depAmount_${i}" placeholder="0.0" step="any" oninput="onDepositAmountChange()">
        </div>
        <div class="coin-preset-btns">
          <button class="coin-preset-btn" onclick="setDepositPreset(${i}, 0.25)">25%</button>
          <button class="coin-preset-btn" onclick="setDepositPreset(${i}, 0.50)">50%</button>
          <button class="coin-preset-btn" onclick="setDepositPreset(${i}, 0.75)">75%</button>
          <button class="coin-preset-btn" onclick="setDepositPreset(${i}, 1.0)">MAX</button>
        </div>
      </div>
    </div>
  `).join('');
  document.getElementById('depositPreview').style.display = 'none';
  updateDepositButton();
  if (walletAddress) loadDepositBalances();
}

function setDepositMax(index) {
  if (!walletAddress || !selectedPool || typeof ethers === 'undefined') return;
  const b = _resolveDepositRawBal(index);
  if (!b || b.raw === 0n) return;
  // Full-precision formatUnits — submit's parseUnits round-trips losslessly.
  document.getElementById(`depAmount_${index}`).value = ethers.formatUnits(b.raw, b.decimals);
  onDepositAmountChange();
}

function setDepositPreset(index, pct) {
  if (!walletAddress || !selectedPool || typeof ethers === 'undefined') return;
  const b = _resolveDepositRawBal(index);
  if (!b || b.raw === 0n) return;
  const amt = (b.raw * BigInt(Math.round(pct * 10000))) / 10000n;
  document.getElementById(`depAmount_${index}`).value = ethers.formatUnits(amt, b.decimals);
  onDepositAmountChange();
}

function onDepositAmountChange() {
  clearTimeout(depositQuoteTimer);
  depositQuoteTimer = setTimeout(getDepositQuote, 400);
  updateDepositButton();
}

async function getDepositQuote() {
  if (!selectedPool) return;
  await loadEthers();
  const n = selectedPool.coins.length;
  const amounts = [];
  let hasAny = false;
  for (let i = 0; i < n; i++) {
    const el = document.getElementById(`depAmount_${i}`);
    const val = el ? parseFloat(el.value) : 0;
    if (val > 0) hasAny = true;
    const decimals = parseInt(selectedPool.decimals[i]) || 18;
    amounts.push(val > 0 ? ethers.parseUnits(val.toFixed(decimals > 8 ? 8 : decimals), decimals) : 0n);
  }
  if (!hasAny) { document.getElementById('depositPreview').style.display = 'none'; return; }
  try {
    const iface = new ethers.Interface([window.poolLiquidityAbi(selectedPool, n).calc]);
    const result = await rpcCall(iface.encodeFunctionData('calc_token_amount', [amounts, true]), selectedPool.address);
    const lpFormatted = ethers.formatUnits(BigInt(result), 18);
    document.getElementById('depositPreview').style.display = '';
    document.getElementById('depositExpectedLP').textContent = parseFloat(lpFormatted).toFixed(6) + ' LP';
    if (selectedPool.tvl > 0) {
      document.getElementById('depositShareOfPool').textContent = '~' + (parseFloat(lpFormatted) / (selectedPool.tvl + parseFloat(lpFormatted)) * 100).toFixed(4) + '%';
    }
  } catch (e) { console.error('Deposit quote error:', e); }
}

function updateDepositButton() {
  const btn = document.getElementById('depositSubmit');
  if (!walletAddress) { btn.textContent = 'Connect Wallet'; btn.className = 'action-btn connect'; return; }
  if (!selectedPool) { btn.textContent = 'Select a Pool'; btn.className = 'action-btn disabled'; return; }
  const n = selectedPool.coins.length;
  let hasAny = false;
  for (let i = 0; i < n; i++) { const el = document.getElementById(`depAmount_${i}`); if (el && parseFloat(el.value) > 0) hasAny = true; }
  if (!hasAny) { btn.textContent = 'Enter Amount'; btn.className = 'action-btn disabled'; return; }
  btn.textContent = 'Add Liquidity';
  btn.className = 'action-btn ready';
}

async function handleDepositSubmit() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const n = selectedPool.coins.length;
  const amounts = [];
  let hasAny = false;
  for (let i = 0; i < n; i++) {
    const el = document.getElementById(`depAmount_${i}`);
    const val = el ? parseFloat(el.value) : 0;
    if (val > 0) hasAny = true;
    const decimals = parseInt(selectedPool.decimals[i]) || 18;
    amounts.push(val > 0 ? ethers.parseUnits(val.toFixed(decimals > 8 ? 8 : decimals), decimals) : 0n);
  }
  if (!hasAny) return;
  const btn = document.getElementById('depositSubmit');
  btn.textContent = 'Processing...';
  btn.className = 'action-btn disabled';
  try {
    for (let i = 0; i < n; i++) {
      if (amounts[i] === 0n) continue;
      const addr = selectedPool.coinsAddresses[i];
      if (addr.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') continue;
      const token = new ethers.Contract(addr, ERC20_ABI, signer);
      const allowance = await token.allowance(walletAddress, selectedPool.address);
      if (allowance < amounts[i]) { const tx = await window.sendContractTxWithDynamicGas(token, 'approve', [selectedPool.address, ethers.MaxUint256]); await tx.wait(); }
    }
    const liqAbi = window.poolLiquidityAbi(selectedPool, n);
    let minMint = 0n;
    try {
      const result = await rpcCall(new ethers.Interface([liqAbi.calc]).encodeFunctionData('calc_token_amount', [amounts, true]), selectedPool.address);
      minMint = BigInt(result) * BigInt(Math.round((1 - depositSlippage / 100) * 10000)) / 10000n;
    } catch (_) { /* keep minMint = 0n best-effort (same as old missing-iface path) */ }
    const addIface = new ethers.Interface([liqAbi.add]);
    const poolContract = new ethers.Contract(selectedPool.address, addIface, signer);
    let ethValue = 0n;
    for (let i = 0; i < n; i++) {
      if (selectedPool.coinsAddresses[i]?.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') ethValue = amounts[i];
    }
    const tx = await window.sendContractTxWithDynamicGas(poolContract, 'add_liquidity', [amounts, minMint], { value: ethValue });
    await tx.wait();
    // Stake LP tokens if checkbox is checked
    const shouldStake = document.getElementById('depositAndStake')?.checked;
    if (shouldStake && selectedPool._gaugeAddress) {
      try {
        const lpAddr = selectedPool.lpTokenAddress || selectedPool.address;
        const lpToken = new ethers.Contract(lpAddr, ERC20_ABI, signer);
        const lpBal = await lpToken.balanceOf(walletAddress);
        if (lpBal > 0n) {
          const gaugeAllowance = await lpToken.allowance(walletAddress, selectedPool._gaugeAddress);
          if (gaugeAllowance < lpBal) { const aTx = await window.sendContractTxWithDynamicGas(lpToken, 'approve', [selectedPool._gaugeAddress, ethers.MaxUint256]); await aTx.wait(); }
          const gauge = new ethers.Contract(selectedPool._gaugeAddress, ['function deposit(uint256)'], signer);
          const sTx = await window.sendContractTxWithDynamicGas(gauge, 'deposit', [lpBal]);
          await sTx.wait();
        }
      } catch (stakeErr) { console.error('Auto-stake failed:', stakeErr); }
    }
    for (let i = 0; i < n; i++) { const el = document.getElementById(`depAmount_${i}`); if (el) el.value = ''; }
    document.getElementById('depositPreview').style.display = 'none';
    loadAllYieldBalances();
  } catch (e) {
    console.error('Deposit error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Deposit failed: ' + e.message);
  }
  updateDepositButton();
}

// ============================================================
// YIELD: Withdraw
// ============================================================
function buildWithdrawUI() {
  if (!selectedPool) return;
  const select = document.getElementById('withdrawCoinSelect');
  select.innerHTML = selectedPool.coins.map((coin, i) => `<option value="${i}">${coin}</option>`).join('');
  document.getElementById('withdrawPreview').style.display = 'none';
  updateWithdrawButton();
}

function setWithdrawMode(mode) {
  withdrawMode = mode;
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('withdrawSingleCoinWrap').style.display = mode === 'single' ? '' : 'none';
  onWithdrawAmountChange();
}

function setMaxWithdrawLP() {
  if (lpBalanceRaw === 0n || typeof ethers === 'undefined') return;
  document.getElementById('withdrawLPAmount').value = ethers.formatUnits(lpBalanceRaw, 18);
  onWithdrawAmountChange();
}

function setWithdrawPreset(pct) {
  if (lpBalanceRaw === 0n || typeof ethers === 'undefined') return;
  document.getElementById('withdrawLPAmount').value = ethers.formatUnits((lpBalanceRaw * BigInt(Math.round(pct * 10000))) / 10000n, 18);
  onWithdrawAmountChange();
}

function onWithdrawAmountChange() {
  clearTimeout(withdrawQuoteTimer);
  withdrawQuoteTimer = setTimeout(getWithdrawQuote, 400);
  updateWithdrawButton();
}

async function getWithdrawQuote() {
  if (!selectedPool) return;
  await loadEthers();
  const lpVal = document.getElementById('withdrawLPAmount').value;
  if (!lpVal || parseFloat(lpVal) <= 0) { document.getElementById('withdrawPreview').style.display = 'none'; return; }
  const lpAmount = ethers.parseUnits(lpVal, 18);
  if (withdrawMode === 'single') {
    const coinIdx = parseInt(document.getElementById('withdrawCoinSelect').value);
    const decimals = parseInt(selectedPool.decimals[coinIdx]) || 18;
    try {
      let result;
      try {
        const iface = new ethers.Interface(['function calc_withdraw_one_coin(uint256 _token_amount, int128 i) view returns (uint256)']);
        result = await rpcCall(iface.encodeFunctionData('calc_withdraw_one_coin', [lpAmount, coinIdx]), selectedPool.address);
      } catch (e) {
        const iface = new ethers.Interface(['function calc_withdraw_one_coin(uint256 _token_amount, uint256 i) view returns (uint256)']);
        result = await rpcCall(iface.encodeFunctionData('calc_withdraw_one_coin', [lpAmount, coinIdx]), selectedPool.address);
      }
      document.getElementById('withdrawPreview').style.display = '';
      document.getElementById('withdrawExpected').textContent = `${parseFloat(ethers.formatUnits(BigInt(result), decimals)).toFixed(6)} ${selectedPool.coins[coinIdx]}`;
    } catch (e) { document.getElementById('withdrawPreview').style.display = 'none'; }
  } else {
    document.getElementById('withdrawPreview').style.display = '';
    document.getElementById('withdrawExpected').textContent = `Proportional withdrawal of ${parseFloat(lpVal).toFixed(4)} LP`;
  }
}

function updateWithdrawButton() {
  const btn = document.getElementById('withdrawSubmit');
  if (!walletAddress) { btn.textContent = 'Connect Wallet'; btn.className = 'action-btn connect'; return; }
  if (!selectedPool) { btn.textContent = 'Select a Pool'; btn.className = 'action-btn disabled'; return; }
  const lpVal = document.getElementById('withdrawLPAmount').value;
  if (!lpVal || parseFloat(lpVal) <= 0) { btn.textContent = 'Enter LP Amount'; btn.className = 'action-btn disabled'; return; }
  // Curve's remove_liquidity reverts when _burn_amount > balanceOf(msg.sender),
  // so block submit when amount exceeds UNSTAKED LP. Staked LP must be unstaked first.
  if (typeof ethers !== 'undefined') {
    try {
      const lpAmount = ethers.parseUnits(lpVal, 18);
      if (lpAmount > lpBalanceRaw) {
        btn.textContent = stakedLPRaw > 0n ? 'Unstake LP first' : 'Insufficient LP balance';
        btn.className = 'action-btn disabled';
        return;
      }
    } catch (e) { /* parse error → fall through to default label */ }
  }
  btn.textContent = withdrawMode === 'single' ? 'Withdraw Single Coin' : 'Withdraw Balanced';
  btn.className = 'action-btn ready';
}

async function handleWithdrawSubmit() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const lpVal = document.getElementById('withdrawLPAmount').value;
  if (!lpVal || parseFloat(lpVal) <= 0) return;
  const lpAmount = ethers.parseUnits(lpVal, 18);
  // Belt-and-suspenders: button is already disabled in this case, but guard the
  // raw call too so a stale-state submit can't reach Curve and revert.
  if (lpAmount > lpBalanceRaw) {
    const staked = parseFloat(ethers.formatUnits(stakedLPRaw, 18)).toFixed(6);
    alert(stakedLPRaw > 0n
      ? `Insufficient unstaked LP. You have ${staked} LP staked in the gauge — Unstake first, then Withdraw.`
      : 'Insufficient LP balance.');
    return;
  }
  const btn = document.getElementById('withdrawSubmit');
  // Decide which extra steps fire BEFORE the actual withdraw.
  const claimChecked = !!document.getElementById('withdrawClaimCheckbox')?.checked;
  const gauge = selectedPool.gaugeAddress;
  const hasGauge = gauge && gauge !== '0x0000000000000000000000000000000000000000';
  const willMintCRV = claimChecked && hasGauge && _withdrawPendingCRVRaw > 0n;
  const willClaimExtras = claimChecked && hasGauge && _withdrawExtrasTokens.length > 0;
  const totalSteps = (willMintCRV ? 1 : 0) + (willClaimExtras ? 1 : 0) + 1;
  let stepIdx = 0;
  const setBtn = (label) => {
    btn.textContent = label;
    btn.className = 'action-btn disabled';
  };
  try {
    // Step: claim CRV via Minter.mint(gauge)
    if (willMintCRV) {
      stepIdx += 1;
      setBtn(`Claiming CRV (${stepIdx}/${totalSteps})...`);
      const minter = new ethers.Contract(MINTER_ADDR, MINTER_ABI, signer);
      await (await minter.mint(gauge)).wait();
    }
    // Step: claim extras via gauge.claim_rewards()
    if (willClaimExtras) {
      stepIdx += 1;
      setBtn(`Claiming extras (${stepIdx}/${totalSteps})...`);
      const g = new ethers.Contract(gauge, GAUGE_ABI, signer);
      await (await window.sendContractTxWithDynamicGas(g, 'claim_rewards', [])).wait();
    }
    stepIdx += 1;
    setBtn(totalSteps > 1 ? `Withdrawing (${stepIdx}/${totalSteps})...` : 'Processing...');
    const n = selectedPool.coins.length;
    if (withdrawMode === 'single') {
      const coinIdx = parseInt(document.getElementById('withdrawCoinSelect').value);
      let expected;
      try {
        const iface = new ethers.Interface(['function calc_withdraw_one_coin(uint256 _token_amount, int128 i) view returns (uint256)']);
        expected = BigInt(await rpcCall(iface.encodeFunctionData('calc_withdraw_one_coin', [lpAmount, coinIdx]), selectedPool.address));
      } catch (e) {
        const iface = new ethers.Interface(['function calc_withdraw_one_coin(uint256 _token_amount, uint256 i) view returns (uint256)']);
        expected = BigInt(await rpcCall(iface.encodeFunctionData('calc_withdraw_one_coin', [lpAmount, coinIdx]), selectedPool.address));
      }
      const minOut = expected * BigInt(Math.round((1 - withdrawSlippage / 100) * 10000)) / 10000n;
      try {
        const iface = new ethers.Interface(['function remove_liquidity_one_coin(uint256 _token_amount, int128 i, uint256 _min_amount) returns (uint256)']);
        const contract = new ethers.Contract(selectedPool.address, iface, signer);
        await (await window.sendContractTxWithDynamicGas(contract, 'remove_liquidity_one_coin', [lpAmount, coinIdx, minOut])).wait();
      } catch (e) {
        const iface = new ethers.Interface(['function remove_liquidity_one_coin(uint256 _token_amount, uint256 i, uint256 _min_amount) returns (uint256)']);
        const contract = new ethers.Contract(selectedPool.address, iface, signer);
        await (await window.sendContractTxWithDynamicGas(contract, 'remove_liquidity_one_coin', [lpAmount, coinIdx, minOut])).wait();
      }
    } else {
      const minAmounts = new Array(n).fill(0n);
      const iface = new ethers.Interface([window.poolLiquidityAbi(selectedPool, n).remove]);
      const contract = new ethers.Contract(selectedPool.address, iface, signer);
      await (await window.sendContractTxWithDynamicGas(contract, 'remove_liquidity', [lpAmount, minAmounts])).wait();
    }
    document.getElementById('withdrawLPAmount').value = '';
    document.getElementById('withdrawPreview').style.display = 'none';
    const cb = document.getElementById('withdrawClaimCheckbox');
    if (cb) cb.checked = false;
    loadAllYieldBalances();
  } catch (e) {
    console.error('Withdraw error:', e);
    if (e.code !== 'ACTION_REJECTED') {
      // Identify which step failed for clearer feedback.
      let label = 'Withdraw';
      if (willMintCRV && stepIdx === 1) label = 'Claim CRV';
      else if (willClaimExtras && ((willMintCRV && stepIdx === 2) || (!willMintCRV && stepIdx === 1))) label = 'Claim extras';
      alert(`${label} failed: ${e.shortMessage || e.message}`);
    }
  }
  updateWithdrawButton();
}

// ============================================================
// YIELD: Stake
// ============================================================
function updateStakeSection() {
  if (!selectedPool) { document.getElementById('noGaugeMsg').style.display = 'none'; return; }
  const gauge = selectedPool.gaugeAddress;
  const hasGauge = gauge && gauge !== '0x0000000000000000000000000000000000000000';
  document.getElementById('noGaugeMsg').style.display = hasGauge ? 'none' : '';
  if (hasGauge) {
    document.getElementById('gaugeAddress').innerHTML = `<a href="${window.getExplorerAddressUrl ? window.getExplorerAddressUrl(gauge) : 'https://etherscan.io/address/' + gauge}" target="_blank" rel="noopener noreferrer">${shortAddr(gauge)}</a>`;
  } else {
    document.getElementById('gaugeAddress').textContent = 'N/A';
  }
  document.getElementById('stakedBalance').textContent = '--';
  document.getElementById('earnedCRV').textContent = '--';

  const rewardsContainer = document.getElementById('extraRewardsInfo');
  if (rewardsContainer) {
    const extras = selectedPool.extraRewards || [];
    if (extras.length > 0) {
      rewardsContainer.innerHTML = '<div class="section-subtitle" style="margin-top:12px;">Extra Rewards</div>' +
        extras.map(r => {
          const symbol = r.tokenSymbol || r.tokenAddress?.slice(0, 8) || '???';
          const apy = r.apy ? parseFloat(r.apy).toFixed(2) + '%' : '--';
          return `<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px;">
            <span style="color:var(--text-dim);">${symbol}</span>
            <span style="color:var(--green);font-family:var(--font-mono);">${apy}</span>
          </div>`;
        }).join('');
      rewardsContainer.style.display = '';
    } else {
      rewardsContainer.style.display = 'none';
    }
  }
}

function setStakePreset(pct) {
  if (typeof ethers === 'undefined') return;
  // Input is shared by Stake (uses unstaked LP) and Unstake (uses staked LP).
  // Use whichever balance is larger so presets are useful in both directions:
  // user with only staked LP can fill MAX to unstake, user with only unstaked LP can stake.
  const basis = stakedLPRaw > lpBalanceRaw ? stakedLPRaw : lpBalanceRaw;
  if (basis === 0n) return;
  document.getElementById('stakeAmountInput').value = ethers.formatUnits((basis * BigInt(Math.round(pct * 10000))) / 10000n, 18);
  updateStakeApySim();
}

async function handleStake() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge) return;
  const amtVal = document.getElementById('stakeAmountInput').value;
  if (!amtVal || parseFloat(amtVal) <= 0) { alert('Enter LP token amount to stake'); return; }
  const amount = ethers.parseUnits(amtVal, 18);
  const lpAddr = selectedPool.lpTokenAddress || selectedPool.address;
  try {
    const lpToken = new ethers.Contract(lpAddr, ERC20_ABI, signer);
    const allowance = await lpToken.allowance(walletAddress, gauge);
    if (allowance < amount) { await (await window.sendContractTxWithDynamicGas(lpToken, 'approve', [gauge, ethers.MaxUint256])).wait(); }
    await (await window.sendContractTxWithDynamicGas(new ethers.Contract(gauge, GAUGE_ABI, signer), 'deposit(uint256)', [amount])).wait();
    document.getElementById('stakeAmountInput').value = '';
    loadLPBalance(); loadStakeData();
  } catch (e) {
    console.error('Stake error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Stake failed: ' + e.message);
  }
}

async function handleUnstake() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge) return;
  const amtVal = document.getElementById('stakeAmountInput').value;
  if (!amtVal || parseFloat(amtVal) <= 0) { alert('Enter LP token amount to unstake'); return; }
  try {
    let _amtWei = ethers.parseUnits(amtVal, 18);
    _amtWei = await clampUnstake(gauge, _amtWei);
    await (await window.sendContractTxWithDynamicGas(new ethers.Contract(gauge, GAUGE_ABI, signer), 'withdraw(uint256)', [_amtWei])).wait();
    document.getElementById('stakeAmountInput').value = '';
    loadLPBalance(); loadStakeData();
  } catch (e) {
    console.error('Unstake error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Unstake failed: ' + cleanTxError(e));
  }
}

// Withdraw-tab variant: reads LP amount from #withdrawLPAmount field (the user is on Withdraw tab),
// not from the Stake-tab input. After unstake, also refresh the withdraw input balance label.
async function handleUnstakeFromWithdraw() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge) return;
  const amtVal = document.getElementById('withdrawLPAmount').value;
  if (!amtVal || parseFloat(amtVal) <= 0) { alert('Enter LP token amount to unstake (LP Tokens field above).'); return; }
  try {
    let _amtWei = ethers.parseUnits(amtVal, 18);
    _amtWei = await clampUnstake(gauge, _amtWei);
    await (await window.sendContractTxWithDynamicGas(new ethers.Contract(gauge, GAUGE_ABI, signer), 'withdraw(uint256)', [_amtWei])).wait();
    // Don't clear the input — user may want to immediately withdraw the same amount.
    loadLPBalance(); loadStakeData(); updateWithdrawGaugeActions();
  } catch (e) {
    console.error('Unstake error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Unstake failed: ' + cleanTxError(e));
  }
}

async function handleClaimRewards() {
  if (!walletAddress) { connectWallet(); return; }
  if (!selectedPool || !signer) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge) return;
  try {
    await (await new ethers.Contract(gauge, GAUGE_ABI, signer).claim_rewards()).wait();
    loadStakeData();
  } catch (e) {
    console.error('Claim error:', e);
    if (e.code !== 'ACTION_REJECTED') alert('Claim failed: ' + e.message);
  }
}

// ============================================================
// YIELD: Gas estimation displays (per-tab)
// Wires gas estimates to all yield-tab transaction flows.
// Each updateXGas() reads current input values, builds calldata,
// calls window.estimateMultiStepGas, and renders the result.
// All updaters are debounced via _yieldGasDebounce to avoid
// re-estimating on every keystroke.
// ============================================================
const _ETH_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const _yieldGasTimers = {};
function _scheduleGasUpdate(key, fn, delay) {
  clearTimeout(_yieldGasTimers[key]);
  _yieldGasTimers[key] = setTimeout(fn, delay || 400);
}

// Stamp helper to discard stale results when input changes mid-flight.
function _gasStamp() { return Date.now() + ':' + Math.random(); }

function _setGasLoading(elId) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = 'estimating...';
  el.className = 'gas-value loading';
}

function _setGasUnavailable(elId, msg) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.textContent = msg || 'unavailable';
  el.className = 'gas-value error';
}

// --- DEPOSIT tab gas ---
let _lastDepositGasStamp = null;
async function updateDepositGas() {
  const elId = 'depositGas';
  const el = document.getElementById(elId);
  if (!el || !selectedPool) return;
  if (typeof window.estimateMultiStepGas !== 'function') return;
  if (typeof ethers === 'undefined') { try { await loadEthers(); } catch { return; } }
  const n = selectedPool.coins.length;
  const amounts = [];
  let hasAny = false;
  for (let i = 0; i < n; i++) {
    const inp = document.getElementById(`depAmount_${i}`);
    const val = inp ? parseFloat(inp.value) : 0;
    const dec = parseInt(selectedPool.decimals[i]) || 18;
    if (val > 0) hasAny = true;
    try {
      amounts.push(val > 0 ? ethers.parseUnits(val.toFixed(dec > 8 ? 8 : dec), dec) : 0n);
    } catch { amounts.push(0n); }
  }
  if (!hasAny) { el.textContent = '--'; el.className = 'gas-value'; return; }
  const stamp = _gasStamp(); _lastDepositGasStamp = stamp;
  _setGasLoading(elId);
  try {
    const steps = [];
    // Approval steps for each non-ETH input that needs allowance
    if (walletAddress) {
      for (let i = 0; i < n; i++) {
        if (amounts[i] === 0n) continue;
        const addr = (selectedPool.coinsAddresses[i] || '').toLowerCase();
        if (!addr || addr === _ETH_PSEUDO) continue;
        const allowance = await window._readAllowance(selectedPool.coinsAddresses[i], walletAddress, selectedPool.address);
        if (allowance >= amounts[i]) continue;
        steps.push({
          label: `Approve ${selectedPool.coins[i]}`,
          to: selectedPool.coinsAddresses[i],
          data: window._buildApproveCalldata(selectedPool.address, ethers.MaxUint256),
          fallback: window._GAS_FALLBACK.approve,
        });
      }
    }
    // add_liquidity step
    const addIface = new ethers.Interface([window.poolLiquidityAbi(selectedPool, n).add]);
    let ethValue = 0n;
    for (let i = 0; i < n; i++) {
      if ((selectedPool.coinsAddresses[i] || '').toLowerCase() === _ETH_PSEUDO) ethValue = amounts[i];
    }
    steps.push({
      label: 'Add liquidity',
      to: selectedPool.address,
      data: addIface.encodeFunctionData('add_liquidity', [amounts, 0n]),
      value: ethValue,
      fallback: window._GAS_FALLBACK.addLiquidity,
    });
    const r = await window.estimateMultiStepGas(steps, walletAddress || null);
    if (stamp !== _lastDepositGasStamp) return;
    window.renderGasLine(el, r, { hasWallet: !!walletAddress });
  } catch (e) {
    if (stamp !== _lastDepositGasStamp) return;
    console.warn('updateDepositGas:', e);
    _setGasUnavailable(elId);
  }
}

// --- WITHDRAW tab gas ---
let _lastWithdrawGasStamp = null;
async function updateWithdrawGas() {
  const elId = 'withdrawGas';
  const el = document.getElementById(elId);
  if (!el || !selectedPool) return;
  if (typeof window.estimateMultiStepGas !== 'function') return;
  if (typeof ethers === 'undefined') { try { await loadEthers(); } catch { return; } }
  const lpVal = document.getElementById('withdrawLPAmount')?.value;
  if (!lpVal || parseFloat(lpVal) <= 0) { el.textContent = '--'; el.className = 'gas-value'; return; }
  let lpAmount;
  try { lpAmount = ethers.parseUnits(lpVal, 18); } catch { return; }
  const stamp = _gasStamp(); _lastWithdrawGasStamp = stamp;
  _setGasLoading(elId);
  try {
    const n = selectedPool.coins.length;
    const steps = [];
    // Optional claim steps if checkbox is ticked AND user has pending rewards.
    const cb = document.getElementById('withdrawClaimCheckbox');
    const claimChecked = !!cb && cb.checked;
    const gauge = selectedPool.gaugeAddress;
    const hasGauge = gauge && gauge !== '0x0000000000000000000000000000000000000000';
    if (claimChecked && hasGauge && _withdrawPendingCRVRaw > 0n) {
      const minterIface = new ethers.Interface(['function mint(address)']);
      steps.push({
        label: 'Claim CRV',
        to: MINTER_ADDR,
        data: minterIface.encodeFunctionData('mint', [gauge]),
        fallback: window._GAS_FALLBACK.minterMint,
      });
    }
    if (claimChecked && hasGauge && _withdrawExtrasTokens.length > 0) {
      const gIface = new ethers.Interface(['function claim_rewards()']);
      steps.push({
        label: 'Claim extras',
        to: gauge,
        data: gIface.encodeFunctionData('claim_rewards', []),
        fallback: window._GAS_FALLBACK.claimRewards,
      });
    }
    // Final withdraw step (always).
    let stepData, stepFallback;
    if (withdrawMode === 'single') {
      const coinIdx = parseInt(document.getElementById('withdrawCoinSelect').value);
      // Use int128-variant calldata (most common). estimateGas falls back if revert.
      const iface = new ethers.Interface(['function remove_liquidity_one_coin(uint256 _token_amount, int128 i, uint256 _min_amount) returns (uint256)']);
      stepData = iface.encodeFunctionData('remove_liquidity_one_coin', [lpAmount, coinIdx, 0n]);
      stepFallback = window._GAS_FALLBACK.removeLiquidityOneCoin;
    } else {
      const minAmounts = new Array(n).fill(0n);
      const iface = new ethers.Interface([window.poolLiquidityAbi(selectedPool, n).remove]);
      stepData = iface.encodeFunctionData('remove_liquidity', [lpAmount, minAmounts]);
      stepFallback = window._GAS_FALLBACK.removeLiquidity;
    }
    steps.push({ label: 'Withdraw', to: selectedPool.address, data: stepData, fallback: stepFallback });
    const r = await window.estimateMultiStepGas(steps, walletAddress || null);
    if (stamp !== _lastWithdrawGasStamp) return;
    window.renderGasLine(el, r, { hasWallet: !!walletAddress });
  } catch (e) {
    if (stamp !== _lastWithdrawGasStamp) return;
    console.warn('updateWithdrawGas:', e);
    _setGasUnavailable(elId);
  }
}

// --- STAKE tab gas (Stake button) ---
let _lastStakeGasStamp = null;
async function updateStakeGas() {
  const elId = 'stakeGas';
  const el = document.getElementById(elId);
  if (!el || !selectedPool) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') {
    el.textContent = '--'; el.className = 'gas-value'; return;
  }
  if (typeof window.estimateMultiStepGas !== 'function') return;
  if (typeof ethers === 'undefined') { try { await loadEthers(); } catch { return; } }
  const amtVal = document.getElementById('stakeAmountInput')?.value;
  if (!amtVal || parseFloat(amtVal) <= 0) { el.textContent = '--'; el.className = 'gas-value'; return; }
  let amount;
  try { amount = ethers.parseUnits(amtVal, 18); } catch { return; }
  const stamp = _gasStamp(); _lastStakeGasStamp = stamp;
  _setGasLoading(elId);
  try {
    const lpAddr = selectedPool.lpTokenAddress || selectedPool.address;
    const steps = [];
    if (walletAddress) {
      const allowance = await window._readAllowance(lpAddr, walletAddress, gauge);
      if (allowance < amount) {
        steps.push({
          label: 'Approve LP',
          to: lpAddr,
          data: window._buildApproveCalldata(gauge, ethers.MaxUint256),
          fallback: window._GAS_FALLBACK.approve,
        });
      }
    }
    // gauge.deposit(uint256) — most common signature
    const gIface = new ethers.Interface(['function deposit(uint256)']);
    steps.push({
      label: 'Stake',
      to: gauge,
      data: gIface.encodeFunctionData('deposit', [amount]),
      fallback: window._GAS_FALLBACK.gaugeDeposit,
    });
    const r = await window.estimateMultiStepGas(steps, walletAddress || null);
    if (stamp !== _lastStakeGasStamp) return;
    window.renderGasLine(el, r, { hasWallet: !!walletAddress });
  } catch (e) {
    if (stamp !== _lastStakeGasStamp) return;
    console.warn('updateStakeGas:', e);
    _setGasUnavailable(elId);
  }
}

// --- UNSTAKE-tab gas (separate tab, uses #unstakeAmountInput) ---
let _lastUnstakeTabGasStamp = null;
async function updateUnstakeTabGas() {
  const elId = 'unstakeGas';
  const el = document.getElementById(elId);
  if (!el || !selectedPool) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') {
    el.textContent = '--'; el.className = 'gas-value'; return;
  }
  if (typeof window.estimateMultiStepGas !== 'function') return;
  if (typeof ethers === 'undefined') { try { await loadEthers(); } catch { return; } }
  const amtVal = document.getElementById('unstakeAmountInput')?.value;
  if (!amtVal || parseFloat(amtVal) <= 0) { el.textContent = '--'; el.className = 'gas-value'; return; }
  let amount;
  try { amount = ethers.parseUnits(amtVal, 18); } catch { return; }
  const stamp = _gasStamp(); _lastUnstakeTabGasStamp = stamp;
  _setGasLoading(elId);
  try {
    const gIface = new ethers.Interface(['function withdraw(uint256)']);
    const r = await window.estimateMultiStepGas(
      [{
        label: 'Unstake',
        to: gauge,
        data: gIface.encodeFunctionData('withdraw', [amount]),
        fallback: window._GAS_FALLBACK.gaugeWithdraw,
      }],
      walletAddress || null,
    );
    if (stamp !== _lastUnstakeTabGasStamp) return;
    window.renderGasLine(el, r, { hasWallet: !!walletAddress });
  } catch (e) {
    if (stamp !== _lastUnstakeTabGasStamp) return;
    console.warn('updateUnstakeTabGas:', e);
    _setGasUnavailable(elId);
  }
}

// --- CLAIM-REWARDS tab gas (Minter.mint + best-effort extras) ---
let _lastClaimGasStamp = null;
async function updateClaimGas() {
  const elId = 'claimGas';
  const el = document.getElementById(elId);
  if (!el || !selectedPool) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') {
    el.textContent = '--'; el.className = 'gas-value'; return;
  }
  if (typeof window.estimateMultiStepGas !== 'function') return;
  if (typeof ethers === 'undefined') { try { await loadEthers(); } catch { return; } }
  const stamp = _gasStamp(); _lastClaimGasStamp = stamp;
  _setGasLoading(elId);
  try {
    const minterIface = new ethers.Interface(['function mint(address)']);
    const r = await window.estimateMultiStepGas(
      [{
        label: 'Claim CRV',
        to: MINTER_ADDR,
        data: minterIface.encodeFunctionData('mint', [gauge]),
        fallback: window._GAS_FALLBACK.minterMint,
      }],
      walletAddress || null,
    );
    if (stamp !== _lastClaimGasStamp) return;
    window.renderGasLine(el, r, { hasWallet: !!walletAddress });
  } catch (e) {
    if (stamp !== _lastClaimGasStamp) return;
    console.warn('updateClaimGas:', e);
    _setGasUnavailable(elId);
  }
}

// --- DEPOSIT & STAKE tab gas (multi-step: approves + add_liquidity + LP approve + gauge.deposit) ---
let _lastDasGasStamp = null;
async function updateDasGas() {
  const elId = 'dasGas';
  const el = document.getElementById(elId);
  if (!el || !selectedPool) return;
  const gauge = selectedPool.gaugeAddress;
  if (!gauge || gauge === '0x0000000000000000000000000000000000000000') {
    el.textContent = '--'; el.className = 'gas-value'; return;
  }
  if (typeof window.estimateMultiStepGas !== 'function') return;
  if (typeof ethers === 'undefined') { try { await loadEthers(); } catch { return; } }
  const n = selectedPool.coins.length;
  const amounts = [];
  let hasAny = false;
  for (let i = 0; i < n; i++) {
    const inp = document.getElementById(`dasAmount_${i}`);
    const val = inp ? parseFloat(inp.value) : 0;
    const dec = parseInt(selectedPool.decimals[i]) || 18;
    if (val > 0) hasAny = true;
    try { amounts.push(val > 0 ? ethers.parseUnits(val.toFixed(dec > 8 ? 8 : dec), dec) : 0n); }
    catch { amounts.push(0n); }
  }
  if (!hasAny) { el.textContent = '--'; el.className = 'gas-value'; return; }
  const stamp = _gasStamp(); _lastDasGasStamp = stamp;
  _setGasLoading(elId);
  try {
    const steps = [];
    if (walletAddress) {
      for (let i = 0; i < n; i++) {
        if (amounts[i] === 0n) continue;
        const addr = (selectedPool.coinsAddresses[i] || '').toLowerCase();
        if (!addr || addr === _ETH_PSEUDO) continue;
        const allowance = await window._readAllowance(selectedPool.coinsAddresses[i], walletAddress, selectedPool.address);
        if (allowance >= amounts[i]) continue;
        steps.push({
          label: `Approve ${selectedPool.coins[i]}`,
          to: selectedPool.coinsAddresses[i],
          data: window._buildApproveCalldata(selectedPool.address, ethers.MaxUint256),
          fallback: window._GAS_FALLBACK.approve,
        });
      }
    }
    const addIface = new ethers.Interface([window.poolLiquidityAbi(selectedPool, n).add]);
    let ethValue = 0n;
    for (let i = 0; i < n; i++) {
      if ((selectedPool.coinsAddresses[i] || '').toLowerCase() === _ETH_PSEUDO) ethValue = amounts[i];
    }
    steps.push({
      label: 'Add liquidity',
      to: selectedPool.address,
      data: addIface.encodeFunctionData('add_liquidity', [amounts, 0n]),
      value: ethValue,
      fallback: window._GAS_FALLBACK.addLiquidity,
    });
    // LP approve + gauge deposit (only estimable as fallback because LP doesn't exist yet)
    steps.push({
      label: 'Approve LP',
      to: selectedPool.lpTokenAddress || selectedPool.address,
      data: window._buildApproveCalldata(gauge, ethers.MaxUint256),
      fallback: window._GAS_FALLBACK.approve,
    });
    // gauge.deposit will revert without LP balance — fallback used.
    const gIface = new ethers.Interface(['function deposit(uint256)']);
    steps.push({
      label: 'Stake LP',
      to: gauge,
      data: gIface.encodeFunctionData('deposit', [1n]),
      fallback: window._GAS_FALLBACK.gaugeDeposit,
    });
    const r = await window.estimateMultiStepGas(steps, walletAddress || null);
    if (stamp !== _lastDasGasStamp) return;
    window.renderGasLine(el, r, { hasWallet: !!walletAddress });
  } catch (e) {
    if (stamp !== _lastDasGasStamp) return;
    console.warn('updateDasGas:', e);
    _setGasUnavailable(elId);
  }
}

// --- APR Simulation (Stake / Deposit & Stake) ---
// Shows raw → diluted total APR as user types deposit amount. Uses dilutedTotalApy()
// from app.js which splits base by pool.tvl and crv/ext/merkl by gauge.tvl.
function _renderApySimRow(rowId, valId, raw, diluted) {
  const row = document.getElementById(rowId);
  const val = document.getElementById(valId);
  if (!row || !val) return;
  const delta = diluted - raw;
  row.style.display = '';
  val.innerHTML = `<span style="opacity:0.6">${raw.toFixed(2)}%</span> &rarr; <strong>${diluted.toFixed(2)}%</strong> <span style="color:${delta < 0 ? 'var(--red, #f6465d)' : 'var(--green, #0ecb81)'};font-size:0.85em">(${delta >= 0 ? '+' : ''}${delta.toFixed(2)}pp)</span>`;
}
function updateStakeApySim() {
  const row = document.getElementById('stakeApySim');
  if (!row) return;
  const pool = selectedPool;
  if (!pool || !pool.totalSupply || !pool.tvl || pool.tvl <= 0) { row.style.display = 'none'; return; }
  const amtVal = document.getElementById('stakeAmountInput')?.value;
  const lp = parseFloat(amtVal);
  if (!isFinite(lp) || lp <= 0) { row.style.display = 'none'; return; }
  // LP → USD via per-LP price (pool.tvl / totalSupply_LP). totalSupply stored in wei (1e18).
  const tsLp = Number(pool.totalSupply) / 1e18;
  if (!isFinite(tsLp) || tsLp <= 0) { row.style.display = 'none'; return; }
  const perLpUsd = pool.tvl / tsLp;
  const depositUsd = lp * perLpUsd;
  if (!isFinite(depositUsd) || depositUsd <= 0) { row.style.display = 'none'; return; }
  const raw = (pool.bestTotalApy != null && pool.bestTotalApy > 0) ? pool.bestTotalApy : (pool.totalApy || 0);
  const diluted = (typeof dilutedTotalApy === 'function') ? dilutedTotalApy(pool, depositUsd) : raw;
  _renderApySimRow('stakeApySim', 'stakeApySimVal', raw, diluted);
}
function updateDasApySim() {
  const row = document.getElementById('dasApySim');
  if (!row) return;
  const pool = selectedPool;
  if (!pool || !pool.tvl || pool.tvl <= 0) { row.style.display = 'none'; return; }
  // Sum USD across dasAmount_${i} × coinsDetailed[i].usdPrice (same pattern as estimateDasGas indexing).
  let depositUsd = 0;
  const n = Array.isArray(pool.coins) ? pool.coins.length : 0;
  for (let i = 0; i < n; i++) {
    const inp = document.getElementById(`dasAmount_${i}`);
    if (!inp) continue;
    const amt = parseFloat(inp.value);
    if (!isFinite(amt) || amt <= 0) continue;
    const coinPrice = pool.coinsDetailed?.[i]?.usdPrice || 0;
    depositUsd += amt * coinPrice;
  }
  if (!isFinite(depositUsd) || depositUsd <= 0) { row.style.display = 'none'; return; }
  const raw = (pool.bestTotalApy != null && pool.bestTotalApy > 0) ? pool.bestTotalApy : (pool.totalApy || 0);
  const diluted = (typeof dilutedTotalApy === 'function') ? dilutedTotalApy(pool, depositUsd) : raw;
  _renderApySimRow('dasApySim', 'dasApySimVal', raw, diluted);
}
window.updateStakeApySim = updateStakeApySim;
window.updateDasApySim = updateDasApySim;

// Hook gas updates into existing input handlers (idempotent — safe to add).
// Wired after page load so the elements exist.
function _wireYieldGas() {
  // Deposit
  for (let i = 0; i < 8; i++) {
    const inp = document.getElementById(`depAmount_${i}`);
    if (inp) inp.addEventListener('input', () => _scheduleGasUpdate('deposit', updateDepositGas, 500));
    const dasInp = document.getElementById(`dasAmount_${i}`);
    if (dasInp) dasInp.addEventListener('input', () => _scheduleGasUpdate('das', updateDasGas, 500));
  }
  // Withdraw
  const wInp = document.getElementById('withdrawLPAmount');
  if (wInp) wInp.addEventListener('input', () => _scheduleGasUpdate('withdraw', updateWithdrawGas, 500));
  const wSel = document.getElementById('withdrawCoinSelect');
  if (wSel) wSel.addEventListener('change', () => _scheduleGasUpdate('withdraw', updateWithdrawGas, 100));
  // Mode buttons
  document.querySelectorAll('.mode-btn').forEach(b => b.addEventListener('click', () => _scheduleGasUpdate('withdraw', updateWithdrawGas, 100)));
  // Stake
  const sInp = document.getElementById('stakeAmountInput');
  if (sInp) sInp.addEventListener('input', () => _scheduleGasUpdate('stake', updateStakeGas, 500));
  // Unstake-tab
  const uInp = document.getElementById('unstakeAmountInput');
  if (uInp) uInp.addEventListener('input', () => _scheduleGasUpdate('unstake', updateUnstakeTabGas, 500));
  // Claim — no input; estimate when tab opens
}

document.addEventListener('DOMContentLoaded', () => {
  // Late wire (after _build*UI re-creates input elements, we still hit them via id)
  // Use capture-phase document listener so dynamically replaced inputs propagate up.
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (!(t && t.id)) return;
    if (/^depAmount_\d+$/.test(t.id)) _scheduleGasUpdate('deposit', updateDepositGas, 500);
    else if (/^dasAmount_\d+$/.test(t.id)) { _scheduleGasUpdate('das', updateDasGas, 500); updateDasApySim(); }
    else if (t.id === 'withdrawLPAmount') _scheduleGasUpdate('withdraw', updateWithdrawGas, 500);
    else if (t.id === 'stakeAmountInput') { _scheduleGasUpdate('stake', updateStakeGas, 500); updateStakeApySim(); }
    else if (t.id === 'unstakeAmountInput') _scheduleGasUpdate('unstake', updateUnstakeTabGas, 500);
  });
  _wireYieldGas();
});

// Trigger initial estimate when claim tab is shown (no input)
window._yieldGasHooks = {
  onTabShow: function(tabName) {
    if (tabName === 'claim-rewards') _scheduleGasUpdate('claim', updateClaimGas, 100);
    else if (tabName === 'stake') _scheduleGasUpdate('stake', updateStakeGas, 100);
    else if (tabName === 'unstake') _scheduleGasUpdate('unstake', updateUnstakeTabGas, 100);
    else if (tabName === 'deposit') _scheduleGasUpdate('deposit', updateDepositGas, 100);
    else if (tabName === 'withdraw') _scheduleGasUpdate('withdraw', updateWithdrawGas, 100);
    else if (tabName === 'deposit-and-stake') _scheduleGasUpdate('das', updateDasGas, 100);
  },
};

// Re-estimate when the selected pool changes (gauge/lp address may differ)
window._yieldGasReestimate = function() {
  _scheduleGasUpdate('deposit', updateDepositGas, 100);
  _scheduleGasUpdate('withdraw', updateWithdrawGas, 100);
  _scheduleGasUpdate('stake', updateStakeGas, 100);
  _scheduleGasUpdate('unstake', updateUnstakeTabGas, 100);
  _scheduleGasUpdate('claim', updateClaimGas, 100);
  _scheduleGasUpdate('das', updateDasGas, 100);
};

