/**
 * CurveDEX Router v3.0 — Intelligent Curve-Only Routing
 *
 * Eight routing strategies (5 core Curve + 3 optional aggregators):
 * 1. Curve Direct — find best pool containing both tokens, on-chain get_dy + exchange
 * 2. Curve Router NG — multi-hop routing (up to 5 hops) via graph-based pathfinding
 *    - Dynamic intermediate token discovery from pool data
 *    - BFS graph search for 2-hop and 3-hop routes
 *    - Top candidates verified via on-chain get_dy
 * 3. Curve Split — optimized split across multiple Curve pools of the same pair
 *    - Binary search over split ratios to maximize output
 *    - Accounts for non-linear price impact (AMM curves)
 * 4. Curve Multi-Path — split across DIFFERENT paths (1-hop and 2-hop)
 *    - Multi-edge token graph: stores ALL pools per token pair, not just best
 *    - Finds all 1-2 hop routes, caps at top 6 by estimated output
 *    - TVL-proportional seed + pairwise binary search optimization
 *    - Ideal for large swaps ($100K+) where single path has too much impact
 * 5. Curve Graph-Split — DAG-based routing with shared intermediate nodes
 *    - Yen's K-shortest paths algorithm for top-K path discovery
 *    - Shared nodes allow volume to split/merge at ANY intermediate point
 *    - Convex optimization with shared-pool awareness penalties
 *    - Key advantage: paths can share intermediate tokens (like ODOS/1inch)
 * 6. ParaSwap (optional) — cross-DEX aggregator, 70+ DEXes, free API
 * 7. CoW Protocol (optional) — intent-based MEV-protected batch auctions
 * 8. ODOS (optional) — smart order routing with native split support
 *
 * Core Curve strategies always active. Aggregators enabled via constructor flags.
 * All strategies run in parallel, best output wins.
 *
 * Dependencies: ethers.js v6 (loaded globally in the page)
 *
 * Contract addresses (Ethereum mainnet):
 * - Curve Router NG: 0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e
 * - ParaSwap Augustus V6.2: 0x6a000f20005980200259b80c5102003040001068
 * - CoW VaultRelayer: 0xC92E8bdf79f0507f65a392b0ab4667716BFE0110
 * - ODOS Router V2: 0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559
 */

// ============================================================
// CONSTANTS & CONFIGURATION
// ============================================================

const CURVE_ROUTER_NG = '0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e';
// Chain-specific Curve Router NG (Address Provider id=2). Gnosis = Sidechain
// Tricrypto Meta v1.1, supports swap_type 1/2/3/4/6/8 + pool_type 1/2/3/10/20/30/4.
// Mainnet (Ethereum) = canonical Router v1.2 (same Vyper) — supports swap_type=8
// (ETH↔WETH wrap/unwrap, ETH↔stETH, stETH↔wstETH, ETH↔wBETH) so we can route a
// USDT→ETH or crvUSD→ETH swap as ONE tx with auto-unwrap of WETH at the end.
const CURVE_ROUTER_NG_BY_CHAIN = {
  1:   '0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e', // Ethereum (Router v1.2)
  100: '0x0DCDED3545D565bA3B19E683431381007245d983', // Gnosis
};

// Curve Router NG dispatch on mainnet is delegated entirely to @curvefi/api
// (curve-js) — see `_buildMainnetCurveJsTx`. curve-js is the same library
// that powers curve.finance UI; it owns the Router NG ABI, every pool_type
// (stable / stable-ng / twocrypto / tricrypto / llamma / wrappers — values
// 1..30 + swap_types 1..9), exchange_underlying for metapools, and ETH↔WETH
// wrap/unwrap. We no longer maintain a parallel encoder.

// External aggregators moved to aggregators.js (ParaSwap, CoW, ODOS)

// Native ETH placeholder used across DeFi protocols
const ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// Wrapped-native addresses per chainId. Used to:
//   - normalize native ↔ wrapped as the same node in the routing graph
//   - shortcut native ↔ wrapped swaps to a direct deposit()/withdraw() call
//   - inject a wrap hop when the user picks the native gas token as from/to
//     and the actual liquidity lives on the wrapped-ERC20 side (e.g. on
//     Gnosis: XDAI is the gas token, but every Curve pool holds WXDAI).
// Keep in sync with chains_config.json `wrappedNative` field — that file
// is the source of truth for UI/balance code; this table mirrors it so the
// router stays standalone (no app.js dependency at construct time).
const NATIVE_WRAPS = {
  1:     '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // Ethereum: WETH
  10:    '0x4200000000000000000000000000000000000006', // Optimism: WETH
  56:    '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', // BSC: WBNB
  100:   '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', // Gnosis: WXDAI
  137:   '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', // Polygon: WMATIC
  146:   '0x039e2fb66102314ce7b64ce5ce3e5183bc94ad38', // Sonic: wS
  250:   '0x21be370D5312f44cB42ce377BC9b8a0cEF1A4C83', // Fantom: WFTM
  252:   '0xFC00000000000000000000000000000000000006', // Fraxtal: WFRXETH
  324:   '0x5AEa5775959fBC2557Cc8789bC1bf90A239D9a91', // zkSync: WETH
  1284:  '0xacc15dc74880c9944775448304b263d191c6077f', // Moonbeam: WGLMR
  1313161554: '0xc9bdeed33cd01541e1eed10f90519d2c06fe3feb', // Aurora: WETH
  8453:  '0x4200000000000000000000000000000000000006', // Base: WETH
  42161: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // Arbitrum: WETH
  42220: '0x471ece3750da237f93b8e339c536989b8978a438', // Celo: CELO
  43114: '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7', // Avalanche: WAVAX
  59144: '0xe5d7c2a44ffddf6b295a15c148167daaaf5cf34f', // Linea: WETH
  81457: '0x4300000000000000000000000000000000000004', // Blast: WETH
};

// Curve metapool zaps per chainId. A "zap" is a stateless helper contract that
// composes a base-pool (3pool-like) add_liquidity/remove_liquidity_one_coin with
// a metapool.exchange in a single transaction, so users can swap directly
// between a base-pool underlying (WXDAI/USDC.e/USDT) and the meta coin (EURe)
// without manually depositing into the base pool first.
//
// We use zaps because Curve Router NG is NOT deployed on Gnosis — every other
// strategy in this router relies on Router NG for multi-hop, and direct quote
// only sees the metapool's two slots ([x3CRV, EURe]), not the underlying base
// coins. Without zap support, a swap like WXDAI→EURe finds no route.
//
// Quote path:
//   base→meta: 3pool.calc_token_amount(amts, true) → metapool.get_dy(1, 0, lp)
//   meta→base: metapool.get_dy(0, 1, dx)         → 3pool.calc_withdraw_one_coin(lp, i)
//
// Tx path: a single call to zap.exchange_underlying(i, j, dx, min_dy)
// where i/j use the unified underlying indexing: 0=metaCoin, 1+=baseCoins[k].
const ZAP_METAPOOLS = {
  100: [
    {
      zap: '0xe3fff29d4dc930ebb787fecd49ee5963dadf60b6',
      metapool: '0x056C6C5e684CeC248635eD86033378Cc444459B0',
      basePool: '0x7f90122BF0700F9E7e1F688fe926940E8839F353',
      metaCoin: { address: '0xcb444e90d8198415266c6a2724b7900fb12fc56e', symbol: 'EURe', decimals: 18 },
      baseCoins: [
        { address: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', symbol: 'WXDAI', decimals: 18 },
        { address: '0xDDAfbb505ad214D7B80b1f830fcCc89B60fb7A83', symbol: 'USDC.e', decimals: 6 },
        { address: '0x4ECaBa5870353805a9F068101A40E0f32ed605C6', symbol: 'USDT', decimals: 6 },
      ],
    },
  ],
};

// Intermediate (hub) tokens for multi-hop routing are discovered ENTIRELY from
// pool data at runtime (see _getIntermediates) — ranked by tvl-weighted degree,
// with no hardcoded seed list and no fixed TVL floor. The only structural knob
// is how many pools a token must bridge to be eligible as a hub:
// Minimum number of pools a token must appear in to be considered an intermediate.
const MIN_POOLS_FOR_INTERMEDIATE = 2;
// Minimum pool TVL (USD) for a hop to be considered viable in multi-hop routing.
// Excludes only true dust pools (sub-$10) that produce nonsense get_dy outputs
// without removing legitimate small pools. The primary safeguard against bad
// routes is the rate-sanity check after path evaluation (see _isRateSane).
// Direct quotes (single hop) bypass this filter via _findBestPool.
const MIN_HOP_POOL_TVL = 10;
// Maximum allowed deviation between executed rate and spot rate before a path
// is rejected as routing through saturated/dust liquidity.
// 0.5 = path output must be ≥50% of (spot_rate × input). A legitimate large
// trade rarely loses more than 50% to slippage — anything below that is the
// signature of get_dy returning the asymptotic pool-balance ceiling rather
// than honest swap math.
const MIN_RATE_RATIO_VS_SPOT = 0.5;
// Half-width of the $1.00 peg window used to classify a coin as a $1-pegged
// stable (per the pool's own usdPrice). 0.01 = ±1% of $1.00. Single source of
// truth shared by _isPegOne (coin classification) and _estimatePriceImpact
// (self-consistency guard on the (rate-1) shortcut).
const PEG_WINDOW = 0.01;
// Maximum number of intermediate candidates to try on-chain (performance cap)
const MAX_INTERMEDIATE_CANDIDATES = 8;
// Maximum number of 3-hop paths to try on-chain
const MAX_3HOP_CANDIDATES = 4;
// Top-K pools per hop expanded into Cartesian variants for multi-hop routing.
// Mirrors the single-hop _getCurveDirectQuote fix where smaller pools (e.g. Strategic
// USD Reserves) can outperform highest-TVL pools at small/medium sizes. With K=2,
// 2-hop yields ≤4 variants/shape, 3-hop ≤8 variants/shape — capped globally below.
const TOP_K_POOLS_PER_HOP = 2;
// Global cap on total route variants evaluated via on-chain get_dy. Sorted by
// min-TVL across hops before slicing, so each shape's single-best-pool variant
// is naturally retained alongside the deepest expansions. Keeps RPC cost
// bounded: 20 variants × ≤3 hops = ≤60 sequential get_dy calls (parallelized
// across variants), comparable to legacy single-pool-per-hop budget.
const MAX_TOTAL_ROUTE_VARIANTS = 20;
// Sanity ceiling: a multi-pool variant of the same path shape should not produce
// an output more than 1.5x the highest-TVL-per-hop baseline variant. Anything
// larger signals get_dy returning the asymptotic ceiling from a depleted pool.
// Mirrors the rationale of the 1.5x guard in _getCurveDirectQuote.
const MAX_ROUTER_VARIANT_OUTPUT_RATIO = 1.5;
// Split routing grid search: number of ratio steps
const SPLIT_GRID_STEPS = 5; // legacy, kept for reference — replaced by binary search (8 iterations)

// Per-route-shape gas-unit estimates (units of gas, NOT a price or USD value).
// These describe the structural cost of each strategy's transaction shape:
// a single exchange is ~150k, a Router NG multi-hop grows with steps, a
// split/zap pays for multiple legs. They are used ONLY to convert into a USD
// tx-cost via the LIVE gas price + ETH/USD rate (see _annotateTxCosts), exactly
// the way curve-js multiplies estimateGas() by the live standard gas price.
// They are not routing whitelists or output thresholds. When a quote carries an
// accurate per-quote `gas` field (e.g. curve-js-baseline), that takes priority.
const GAS_BY_SOURCE = {
  'curve-direct': 150000,
  'curve-router': 300000,
  'curve-split': 250000,
  'curve-multi-path': 500000,
  'curve-graph-split': 550000,
  'curve-zap-metapool': 500000,
  'curve-js-baseline': 400000,
  'paraswap': 200000,
  'odos': 200000,
  'cow': 0, // solver pays gas
};

// ============================================================
// ABI FRAGMENTS (minimal, only what we need)
// ============================================================

// Curve Router NG ABI — exchange + get_dy with route encoding
const CURVE_ROUTER_ABI = [
  // _route: address[11] — alternating [token, pool/zap, token, pool/zap, token, ...]
  // _swap_params: uint256[5][5] — each hop is [i, j, swap_type, pool_type, n_coins]
  // _pools: address[5] — optional base/meta pools for zap swaps
  'function get_dy(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, address[5] _pools) view returns (uint256)',
  'function get_dy(address[11] _route, uint256[5][5] _swap_params, uint256 _amount) view returns (uint256)',
  'function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy, address[5] _pools, address _receiver) payable returns (uint256)',
  'function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy) payable returns (uint256)',
];

// Direct pool ABI for single-pool swaps
const POOL_ABI = [
  'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
  'function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)',
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) payable returns (uint256)',
  'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)',
  'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy, bool use_eth) payable returns (uint256)',
];

// ERC20_ABI is defined in index.html inline script (loaded before this deferred script)
// Do NOT redeclare here — const/var/let redeclaration causes SyntaxError

/**
 * Swap type values for Curve Router NG _swap_params:
 * 1 = exchange (standard pool swap)
 * 2 = exchange_underlying (swap via underlying tokens)
 * 3 = exchange via zap for meta pools
 * 4 = coin -> LP token (add_liquidity single-sided)
 * 5 = lending pool coin -> LP token
 * 6 = LP token -> coin (remove_liquidity_one_coin)
 * 7 = LP token -> lending/underlying coin
 * 8 = ETH/WETH/stETH/frxETH/wstETH/wBETH wrapping conversions
 * 9 = ERC4626 asset <-> share conversions (e.g. sDAI)
 *
 * Pool type values:
 * 1 = stable (StableSwap)
 * 2 = crypto (CryptoSwap/TwoCrypto/TriCrypto)
 * 3 = factory-stable-ng
 * 4 = llamma (crvUSD lending)
 */


// ============================================================
// MAIN ROUTER CLASS
// ============================================================

class CurveDEXRouter {
  /**
   * @param {Object} options
   * @param {Function} options.rpcCall - async function(calldata, toAddress) => hex result
   * @param {Array} options.pools - allPools array from CurveDEX (pool objects with coinsAddresses, etc.)
   * @param {number} [options.chainId=1] - Chain ID (default: Ethereum mainnet)
   * @param {number} [options.quoteTimeout=12000] - Timeout for each quote source in ms
   * @param {boolean} [options.enableParaSwap=false] - Enable ParaSwap aggregator as fallback
   * @param {boolean} [options.enableCow=false] - Enable CoW Protocol (MEV-protected, intent-based)
   * @param {boolean} [options.enableOdos=false] - Enable ODOS (smart split routing)
   */
  constructor({ rpcCall, pools, chainId = 1, quoteTimeout = 12000, enableParaSwap = false, enableCow = false, enableOdos = false, strategies = null } = {}) {
    this._rpcCall = rpcCall;
    this._pools = pools || [];
    this._chainId = chainId;
    this._quoteTimeout = quoteTimeout;
    this._enableParaSwap = enableParaSwap;
    this._enableCow = enableCow;
    this._enableOdos = enableOdos;
    this._strategies = strategies; // null = all, or ['curve-direct', 'curve-router', ...]
    // Cache for token decimals. Populated emergently from pool data on demand
    // (see _getIntermediates / _getDecimals); only the native-token sentinel is
    // seeded here since ETH has no pool coin entry to read decimals from.
    this._decimalsCache = new Map();
    this._decimalsCache.set(ETH_ADDRESS.toLowerCase(), 18);

    // Token graph and dynamic intermediates (rebuilt on setPools)
    this._tokenGraph = null; // Map<tokenAddr, Map<tokenAddr, {pool, tvl}>> (single-best, for BFS compat)
    this._tokenGraphMulti = null; // Map<tokenAddr, Map<tokenAddr, [{pool, tvl}, ...]>> (multi-edge)
    this._dynamicIntermediates = null; // Array of {address, symbol, decimals}

    // LRU cache for get_dy RPC calls (avoids duplicate calls within same quote cycle)
    this._dyCache = new Map();
    this._dyCacheTTL = 5000; // 5 seconds
    this._dyCacheMaxSize = 200;
  }

  /**
   * Update the pools list (call after pools are loaded/refreshed).
   * Rebuilds the token graph and discovers dynamic intermediate tokens.
   * @param {Array} pools - allPools array
   */
  setPools(pools) {
    this._pools = pools;
    // Invalidate caches so they rebuild on next use
    this._tokenGraph = null;
    this._tokenGraphMulti = null;
    this._dynamicIntermediates = null;
  }

  /**
   * Wrapped-native ERC20 address for the active chain (lowercase).
   * Mirrors chains_config.json `wrappedNative`. Falls back to Ethereum WETH so
   * legacy code paths keep working if the constructor was called pre-chain-init.
   * @returns {string} lowercase address
   */
  _getWrappedAddr() {
    const w = NATIVE_WRAPS[this._chainId];
    return (w || WETH_ADDRESS).toLowerCase();
  }
  /** Native ETH placeholder (0xeee…), lowercase. Shared across all chains. */
  _getNativeAddr() { return ETH_ADDRESS.toLowerCase(); }

  // ============================================================
  // ZAP METAPOOL HELPERS (e.g. Gnosis EURe via 3pool zap)
  // ============================================================

  /**
   * Encode a uint256 (or BigInt) as a 64-hex-char (32-byte) ABI word.
   * Used to build raw calldata for zap/3pool calls without ethers.Interface
   * (Vyper selector + sequential uint256 args).
   */
  _hex32(v) { return BigInt(v).toString(16).padStart(64, '0'); }

  /**
   * Locate a zap-metapool config on the active chain that bridges fromToken
   * and toToken (one side = metaCoin, other side = one of the base coins).
   * Returns the zap entry annotated with direction and base coin index, or
   * null if no zap supports this pair.
   *
   * direction='base_to_meta'  baseCoins[baseIdx] → metaCoin
   * direction='meta_to_base'  metaCoin → baseCoins[baseIdx]
   */
  _findZapMetapool(fromToken, toToken) {
    const zaps = ZAP_METAPOOLS[this._chainId] || [];
    if (!zaps.length) return null;
    const from = (fromToken || '').toLowerCase();
    const to = (toToken || '').toLowerCase();
    for (const z of zaps) {
      const metaAddr = z.metaCoin.address.toLowerCase();
      const baseAddrs = z.baseCoins.map(c => c.address.toLowerCase());
      if (from === metaAddr && baseAddrs.includes(to)) {
        return { ...z, direction: 'meta_to_base', baseIdx: baseAddrs.indexOf(to) };
      }
      if (to === metaAddr && baseAddrs.includes(from)) {
        return { ...z, direction: 'base_to_meta', baseIdx: baseAddrs.indexOf(from) };
      }
    }
    return null;
  }

  /**
   * Quote a swap through a metapool zap (base coin ↔ meta coin).
   *
   * base_to_meta: 3pool.calc_token_amount([…amts…], true) gives x3CRV LP minted
   *               by depositing the base coin; metapool.get_dy(1, 0, lp) gives
   *               EURe received for that LP.
   * meta_to_base: metapool.get_dy(0, 1, dx) gives x3CRV LP received for EURe;
   *               3pool.calc_withdraw_one_coin(lp, i) gives base coin out.
   *
   * Selectors (Vyper signatures):
   *   3pool.calc_token_amount(uint256[3],bool)        = 0x3883e119
   *   metapool.get_dy(uint256,uint256,uint256)        = 0x556d6e9f
   *   3pool.calc_withdraw_one_coin(uint256,int128)    = 0xcc2b27d7
   */
  // Isolated direct fetch — bypasses _rpcCall's shared cursor/_rpcMeta state.
  // Under parallel strategy burst, the shared cursor advances per-call and lands
  // some zap probes on whichever endpoints are already cooled by other strategies'
  // legitimate dust-pool reverts. Direct fetch with sequential retry on a private
  // RPC list keeps zap isolated from that cascade. 2026-05-22 inline debug after
  // 5 deploys failed to fix via _rpcCall-level patches.
  async _zapRpc(data, to) {
    // Get chain-active list via the same accessor app.js uses, then iterate
    // sequentially with a 4s timeout per endpoint. No marking, no cursor.
    const list = typeof window !== 'undefined' && typeof window.getOrderedRpcs === 'function'
      ? window.getOrderedRpcs()
      : [];
    if (!list.length) throw new Error('zap-rpc: no endpoints available');
    let lastErr = null;
    for (const url of list) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_call',
            params: [{ to, data }, 'latest'], id: Math.floor(Math.random() * 1e9) }),
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!r.ok) { lastErr = new Error('http-' + r.status); continue; }
        const json = await r.json();
        if (json.error) { lastErr = new Error(json.error.message || 'rpc-error'); continue; }
        return json.result;
      } catch (e) { lastErr = e; }
    }
    throw new Error('zap-rpc all-failed: ' + (lastErr ? lastErr.message : 'unknown'));
  }

  async _quoteViaZap(zapInfo, amountWei) {
    if (zapInfo.direction === 'base_to_meta') {
      const amts = [0n, 0n, 0n];
      amts[zapInfo.baseIdx] = BigInt(amountWei);
      const calcData = '0x3883e119'
        + this._hex32(amts[0]) + this._hex32(amts[1]) + this._hex32(amts[2])
        + this._hex32(1n);
      const lpHex = await this._zapRpc(calcData, zapInfo.basePool);
      const lpWei = BigInt(lpHex);
      if (lpWei <= 0n) return null;
      const dyData = '0x556d6e9f' + this._hex32(1n) + this._hex32(0n) + this._hex32(lpWei);
      const outHex = await this._zapRpc(dyData, zapInfo.metapool);
      const outWei = BigInt(outHex);
      if (outWei <= 0n) return null;
      return { outputWei: outWei, lpWei };
    }
    const dyData = '0x556d6e9f' + this._hex32(0n) + this._hex32(1n) + this._hex32(BigInt(amountWei));
    const lpHex = await this._zapRpc(dyData, zapInfo.metapool);
    const lpWei = BigInt(lpHex);
    if (lpWei <= 0n) return null;
    const wdData = '0xcc2b27d7' + this._hex32(lpWei) + this._hex32(BigInt(zapInfo.baseIdx));
    const outHex = await this._zapRpc(wdData, zapInfo.basePool);
    const outWei = BigInt(outHex);
    if (outWei <= 0n) return null;
    return { outputWei: outWei, lpWei };
  }

  /**
   * Build a full quote object for a zap-metapool swap. Returns null if the
   * pair is not zap-supported on the active chain, or if the on-chain probe
   * fails. Result is in the same shape as other curve-* quotes so the
   * getQuote dispatcher can sort it via _gasAwareScore.
   */
  async _getZapMetapoolQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const zapInfo = this._findZapMetapool(fromToken, toToken);
    if (!zapInfo) return null;
    try {
      const r = await this._quoteViaZap(zapInfo, amountWei);
      if (!r) return null;
      const outFormatted = ethers.formatUnits(r.outputWei, toDecimals);
      const inFormatted = ethers.formatUnits(amountWei, fromDecimals);
      const rate = parseFloat(outFormatted) / parseFloat(inFormatted);
      const fromSymbol = zapInfo.direction === 'base_to_meta'
        ? zapInfo.baseCoins[zapInfo.baseIdx].symbol : zapInfo.metaCoin.symbol;
      const toSymbol = zapInfo.direction === 'base_to_meta'
        ? zapInfo.metaCoin.symbol : zapInfo.baseCoins[zapInfo.baseIdx].symbol;
      return {
        source: 'curve-zap-metapool',
        sourceName: `Curve Zap (3pool + ${zapInfo.metaCoin.symbol} metapool)`,
        fromToken, toToken,
        inputAmountWei: amountWei,
        outputAmountWei: r.outputWei.toString(),
        outputAmount: outFormatted,
        rate,
        priceImpact: 0, // zap path; PI not estimated here, UI shows rate
        gas: 500000,
        route: [
          {
            pool: zapInfo.basePool, poolName: '3pool',
            from: fromToken, to: toToken,
            fromSymbol, toSymbol,
            iFrom: 0, iTo: 0,
            isCrypto: false, _isZap: true,
          },
          {
            pool: zapInfo.metapool, poolName: `${zapInfo.metaCoin.symbol} metapool`,
            from: fromToken, to: toToken,
            fromSymbol, toSymbol,
            iFrom: 0, iTo: 0,
            isCrypto: false, _isZap: true,
          },
        ],
        _zapInfo: zapInfo,
        _lpWei: r.lpWei.toString(),
      };
    } catch (e) {
      console.warn('[CurveDEXRouter] zap-metapool quote failed:', e?.message || e);
      return null;
    }
  }

  // ============================================================
  // CURVE-JS BASELINE QUOTE (universal "no worse than curve.finance" floor)
  // ============================================================
  //
  // Why: our hand-written quote engine (curve-direct + curve-router +
  // curve-split + curve-multi-path + curve-graph-split + curve-zap-metapool)
  // covers single-hop / multi-hop / split paths well, but routinely loses to
  // @curvefi/api on routes that mix swap with add_liquidity / remove_liquidity
  // helpers (swap_type=4/5) — the canonical example is alUSD→3Crv where
  // curve-js routes alUSD→fxUSD→…→USDT→3pool.add_liquidity(USDT, dx)→3Crv,
  // which mints 3Crv directly. Our engine treats 3Crv as just another ERC20
  // and tries swap-only paths, ending ~40% behind.
  //
  // Rather than re-implement the metapool deposit / lp-mint zap path for every
  // pool class (which would be a per-pool whitelist drift Nik banned), we
  // simply ask curve-js for its best route, register the result as one of our
  // quote candidates, and let _gasAwareScore pick whichever is best.
  //
  // Cost: one RPC call to curve.router.getBestRouteAndOutput per quote (curve-js
  // already memoizes internally for the same args). Submit reuses
  // _buildMainnetCurveJsTx (already source-whitelisted below) — no new tx path.
  //
  // Guarantees:
  //   - Mainnet chainId=1 only (curve-js init / RPC configured for mainnet).
  //   - If curve-js is not ready yet (cold session) the call short-circuits to
  //     null and the aggregator falls back to our own sources.
  //   - The quote shape mirrors curve-router / curve-direct (source, route,
  //     outputAmountWei, rate, gas) so downstream scoring works unchanged.
  async _getCurveJsBaselineQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    if (this._chainId !== 1) return null;
    if (typeof window === 'undefined' || typeof window.curveJsReadyForChain !== 'function') return null;
    let curve = null;
    try {
      // Short timeout: if curve-js is still loading we don't block other sources.
      curve = await Promise.race([
        window.curveJsReadyForChain(1),
        new Promise((_, rej) => setTimeout(() => rej(new Error('curve-js not ready')), 2000)),
      ]);
    } catch { return null; }
    if (!curve?.router?.getBestRouteAndOutput) return null;
    const amountStr = ethers.formatUnits(BigInt(amountWei), fromDecimals);
    try {
      const res = await curve.router.getBestRouteAndOutput(fromToken, toToken, amountStr);
      if (!res || res.output == null) return null;
      // res.output is human-readable decimal string (curve-js convention).
      const outputWei = ethers.parseUnits(String(res.output), toDecimals);
      if (outputWei <= 0n) return null;
      const outputFormatted = ethers.formatUnits(outputWei, toDecimals);
      const inputFormatted = ethers.formatUnits(BigInt(amountWei), fromDecimals);
      const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);
      const cjRoute = Array.isArray(res.route) ? res.route : [];
      const numHops = cjRoute.length || 1;
      // Build a display route mirroring our other quote sources' shape so
      // existing UI / route-viz code works without special-casing.
      const route = cjRoute.map((step) => {
        const fromAddr = (step.inputCoinAddress || '').toLowerCase();
        const toAddr = (step.outputCoinAddress || '').toLowerCase();
        const swapType = Array.isArray(step.swapParams) ? Number(step.swapParams[2] ?? 1) : 1;
        // Real AMM hops carry a pool name from curve-js. Synthetic legs (ERC-4626
        // vault redeem/deposit = type 9, native wrap/unwrap = type 8) have no pool,
        // so curve-js leaves the name blank and we used to show "curve-js step".
        // Build a readable label from the token symbols + the Router NG swap type.
        // Self-adapting: driven by curve-js's own swap_type, no hardcoded token list.
        let poolName = step.poolName || step.name;
        if (!poolName) {
          const fromSym = this._resolveTokenInfo(fromAddr).symbol;
          const toSym = this._resolveTokenInfo(toAddr).symbol;
          const kind = this._swapTypeLabel(swapType);
          poolName = (fromSym !== '???' && toSym !== '???')
            ? `${fromSym} → ${toSym}${kind ? ` · ${kind}` : ''}`
            : (kind || 'curve-js step');
        }
        return {
          pool: (step.poolAddress || step.swapAddress || '').toLowerCase(),
          poolName,
          from: fromAddr,
          to: toAddr,
          iFrom: Array.isArray(step.swapParams) ? Number(step.swapParams[0] ?? 0) : 0,
          iTo: Array.isArray(step.swapParams) ? Number(step.swapParams[1] ?? 0) : 0,
          isCrypto: false,
          _swapType: swapType,
        };
      });
      return {
        source: 'curve-js-baseline',
        sourceName: `Curve.js (${numHops}-hop`
          + (cjRoute.some(s => Array.isArray(s.swapParams) && [4, 5, 7].includes(Number(s.swapParams[2]))) ? ' + zap' : '')
          + ')',
        fromToken,
        toToken,
        inputAmountWei: amountWei,
        outputAmountWei: outputWei.toString(),
        outputAmount: outputFormatted,
        rate,
        // PI estimation skipped — curve-js does not expose it directly; UI
        // shows rate only, like our zap-metapool quote.
        priceImpact: 0,
        // Gas heuristic: ~200k per hop, +100k if any zap step (add/remove_liquidity).
        gas: 200000 * numHops + (cjRoute.some(s => Array.isArray(s.swapParams) && [4, 5, 7].includes(Number(s.swapParams[2]))) ? 100000 : 0),
        route,
        _numHops: numHops,
        _cjRoute: cjRoute,
      };
    } catch (e) {
      // Common reasons: pair not in curve-js graph, rate-limited RPC, network blip.
      console.warn('[CurveDEXRouter] curve-js baseline quote failed:', e?.message || e);
      return null;
    }
  }

  /**
   * Human-readable category for a Curve Router NG swap type. Used to label
   * synthetic route legs (vault conversions, native wraps) that have no pool
   * name. The arrow + token symbols convey direction; this adds the leg kind.
   * Swap types per Router NG _swap_params: 1 exchange, 2 crypto, 3 zap metapool,
   * 4/5 coin->LP, 6/7 LP->coin, 8 ETH/wrapping, 9 ERC-4626 asset<->share.
   * @param {number} swapType
   * @returns {string} short label, '' if unknown
   */
  _swapTypeLabel(swapType) {
    switch (Number(swapType)) {
      case 1: return 'stable';
      case 2: return 'crypto';
      case 3: return 'zap';
      case 4:
      case 5: return 'add liquidity';
      case 6:
      case 7: return 'remove liquidity';
      case 8: return 'wrap';
      case 9: return 'vault'; // ERC-4626 redeem/deposit at redemption rate
      default: return '';
    }
  }

  // ============================================================
  // LRU CACHE FOR get_dy RPC CALLS
  // ============================================================

  /**
   * Get cached get_dy result if still valid (within TTL).
   * @param {string} key - Cache key (pool+i+j+amount)
   * @returns {BigInt|null}
   */
  _getCachedDy(key) {
    const entry = this._dyCache.get(key);
    if (entry && Date.now() - entry.ts < this._dyCacheTTL) return entry.value;
    if (entry) this._dyCache.delete(key); // expired
    return null;
  }

  /**
   * Store get_dy result in cache. Evicts oldest entry if cache is full.
   * @param {string} key - Cache key
   * @param {BigInt} value - get_dy result
   */
  _setCachedDy(key, value) {
    this._dyCache.set(key, { value, ts: Date.now() });
    if (this._dyCache.size > this._dyCacheMaxSize) {
      // Evict oldest entry (Map preserves insertion order)
      const firstKey = this._dyCache.keys().next().value;
      this._dyCache.delete(firstKey);
    }
  }

  // ============================================================
  // GAS-AWARE SCORING
  // ============================================================

  /**
   * Real gas price in wei/gas, mirroring curve-js's source of truth.
   *
   * curve-js (@curvefi/api lib/router.js) selects the best route by
   * (outputUsd − txCostUsd) where txCost uses the LIVE standard gas price from
   * https://api.curve.finance/api/getGas (`data.gas.standard`). On modern
   * mainnet that tier is sub-1-gwei (~0.26 gwei). Using a hardcoded 30 gwei (as
   * the old _gasAwareScore did) inflates the gas penalty ~100×, which made us
   * discard the higher-output multi-hop route curve-js picks and fall back to a
   * lower-output single hop. We therefore pull the SAME real value, with two
   * on-chain/network fallbacks and NO magic constant as the primary path.
   *
   * Cached 60s (gas price is slow-moving relative to a quote burst).
   * @returns {Promise<number>} gas price in wei per gas unit
   */
  async _getGasPriceWei() {
    const now = Date.now();
    if (this._gasPriceCache && now - this._gasPriceCache.ts < 60000) {
      return this._gasPriceCache.value;
    }
    let wei = null;
    // 1) curve.finance gas oracle — the exact source curve-js uses.
    try {
      if (typeof fetch === 'function') {
        const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
        const to = ctrl ? setTimeout(() => ctrl.abort(), 2500) : null;
        const res = await fetch('https://api.curve.finance/api/getGas', ctrl ? { signal: ctrl.signal } : {});
        if (to) clearTimeout(to);
        const data = await res.json();
        const std = data?.data?.gas?.standard;
        if (std != null && isFinite(Number(std)) && Number(std) > 0) wei = Number(std);
      }
    } catch { /* fall through */ }
    // 2) eth_gasPrice via the shared RPC (reuse existing _rpcCall failover infra).
    if (wei == null && typeof this._rpcCall === 'function') {
      try {
        // eth_gasPrice isn't an eth_call; use provider-style raw if available.
        // Our _rpcCall is an eth_call shim, so we approximate via the base-fee of
        // the latest block: eth_getBlockByNumber('latest', false).baseFeePerGas.
        const hex = await this._rpcRawGasPrice();
        if (hex && hex > 0) wei = hex;
      } catch { /* fall through */ }
    }
    // 3) Final fallback: a realistic modern-mainnet value (sub-gwei). This is a
    //    safety net only — both real sources above are tried first. It is NOT a
    //    routing whitelist or output threshold; it merely prevents a divide path
    //    when the network is unreachable, and is deliberately small so it cannot
    //    re-introduce the old over-penalty.
    if (wei == null || !isFinite(wei) || wei <= 0) wei = 0.5e9; // 0.5 gwei
    this._gasPriceCache = { value: wei, ts: now };
    return wei;
  }

  /**
   * Best-effort raw eth_gasPrice / base fee via the page provider if exposed.
   * Returns wei/gas as a Number, or null. Kept separate so _getGasPriceWei stays
   * readable and this can no-op cleanly in environments without a raw provider.
   */
  async _rpcRawGasPrice() {
    try {
      if (typeof window !== 'undefined' && window.ethereum && window.ethereum.request) {
        const hex = await window.ethereum.request({ method: 'eth_gasPrice' });
        const v = Number(BigInt(hex));
        if (isFinite(v) && v > 0) return v;
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * USD price of a token address, sourced from the in-memory pool data
   * (coinsDetailed[].usdPrice), mirroring curve-js's _getUsdRate intent without
   * an extra network call. Falls back to 1.0 — the vast majority of Curve route
   * outputs (and ETH-as-gas conversions handled by caller) are near-dollar
   * stables, the same proxy the previous scorer made implicitly.
   * @param {string} addr token address
   * @returns {number} usd price (>0)
   */
  _getTokenUsdPrice(addr) {
    if (!addr) return 1;
    const lc = addr.toLowerCase();
    for (const p of this._pools) {
      const d = p.coinsDetailed;
      if (!Array.isArray(d)) continue;
      for (const c of d) {
        if ((c?.address || '').toLowerCase() === lc) {
          const pr = parseFloat(c?.usdPrice);
          if (isFinite(pr) && pr > 0) return pr;
        }
      }
    }
    return 1;
  }

  /**
   * ETH price in USD, from pool data (WETH coinsDetailed) with a sane fallback.
   * Used only to convert a gas cost (denominated in ETH) into USD for the
   * (outputUsd − txCostUsd) comparison, exactly as curve-js does via _getUsdRate.
   * @returns {number}
   */
  _getEthUsdRate() {
    const weth = this._getWrappedAddr();
    const p = this._getTokenUsdPrice(weth);
    if (p > 1.5) return p; // a real ETH price, not a $1 stable fallback
    // Fallback ETH price. A coarse value here only scales the gas term, which is
    // already tiny at sub-gwei prices; it cannot flip a route choice the way the
    // old 30-gwei constant did.
    return 3000;
  }

  /**
   * Precompute and attach `_txCostUsd` to each quote, mirroring curve-js's
   * route-selection inputs. Called ONCE per getQuote (not per comparator call)
   * so the sort itself is pure arithmetic.
   *
   * txCostUsd = gasUnits × gasPriceWei × 1e-18 (ETH) × ethUsdRate
   *
   * @param {Array<Object>} quotes
   * @param {string} toToken output token address (for output USD pricing)
   * @returns {Promise<void>}
   */
  async _annotateTxCosts(quotes, toToken) {
    let gasPriceWei;
    try { gasPriceWei = await this._getGasPriceWei(); }
    catch { gasPriceWei = 0.5e9; }
    const ethUsd = this._getEthUsdRate();
    const outUsdPrice = this._getTokenUsdPrice(toToken);
    for (const q of quotes) {
      const gasUnits = q.gas || GAS_BY_SOURCE[q.source] || 200000;
      const gasCostEth = gasUnits * gasPriceWei * 1e-18;
      q._txCostUsd = gasCostEth * ethUsd;
      const out = parseFloat(q.outputAmount || '0');
      q._outputUsd = out * outUsdPrice;
    }
  }

  /**
   * Score a quote by net USD value: (outputUsd − txCostUsd), mirroring curve-js's
   * route selection (@curvefi/api lib/router.js picks max of output − txCost,
   * tiebreak toward fewer hops). Higher is better.
   *
   * Inputs `_outputUsd` and `_txCostUsd` are precomputed once per getQuote by
   * _annotateTxCosts using the LIVE gas price (api.curve.finance/api/getGas
   * standard tier, ~0.26 gwei) and the real ETH/USD rate — NOT the old hardcoded
   * 30 gwei / $2500 / 0.5-cap model, which inflated the gas penalty ~100× and
   * discarded the higher-output multi-hop route curve-js correctly picks.
   *
   * Falls back to raw output if annotation hasn't run (defensive; the sort site
   * always annotates first).
   * @param {Object} quote - Quote result with _outputUsd / _txCostUsd attached
   * @returns {number} net-USD score (higher is better)
   */
  _gasAwareScore(quote) {
    const outputUsd = (quote._outputUsd != null && isFinite(quote._outputUsd))
      ? quote._outputUsd
      : parseFloat(quote.outputAmount || '0');
    const txCostUsd = (quote._txCostUsd != null && isFinite(quote._txCostUsd))
      ? quote._txCostUsd
      : 0;
    return outputUsd - txCostUsd;
  }

  // ============================================================
  // PUBLIC API
  // ============================================================

  /**
   * Get the best swap quote from all Curve routing strategies.
   * Queries direct pool, multi-hop (Router NG), and split routing in parallel.
   *
   * @param {string} fromToken - Source token address
   * @param {string} toToken - Destination token address
   * @param {string} amount - Amount in human-readable format (e.g. "1.5")
   * @param {number} fromDecimals - Decimals of source token
   * @param {number} toDecimals - Decimals of destination token
   * @param {number} [slippage=0.5] - Slippage tolerance in percent (0.5 = 0.5%)
   * @param {string} [userAddress] - User's wallet address (unused, kept for API compat)
   * @returns {Promise<QuoteResult>} Best quote across all Curve strategies
   */
  async getQuote(fromToken, toToken, amount, fromDecimals, toDecimals, slippage = 0.5, userAddress = null) {
    if (!fromToken || !toToken || !amount || parseFloat(amount) <= 0) {
      throw new Error('Invalid parameters: fromToken, toToken, and positive amount required');
    }

    // ethers v6 parseUnits requires Number (or BigInt) for the unit/decimals
    // arg — string "18" is interpreted as a unit name and throws
    // INVALID_ARGUMENT (value="18", argument="unit"). Curve API returns
    // pool.decimals as strings, so callers may pass "18". Coerce to Number
    // here so all formatUnits/parseUnits within this method work.
    fromDecimals = Number(fromDecimals);
    toDecimals = Number(toDecimals);
    if (!Number.isFinite(fromDecimals) || !Number.isFinite(toDecimals)) {
      throw new Error(`Invalid decimals: fromDecimals=${fromDecimals}, toDecimals=${toDecimals}`);
    }
    const amountWei = ethers.parseUnits(amount, fromDecimals).toString();
    const from = fromToken;
    const to = toToken;

    // Native ↔ wrapped special case (ETH↔WETH, XDAI↔WXDAI, MATIC↔WMATIC, ...):
    // Direct ERC20 deposit/withdraw — no slippage, no price impact, ~30k gas.
    if (this._isWrapUnwrap(from, to)) {
      const wrapQuote = this._getWethWrapQuote(from, to, amountWei, fromDecimals, toDecimals);
      if (wrapQuote) {
        // Slippage / minOutput: 1:1 always, but keep fields consistent for buildSwapTx/UI.
        wrapQuote.minOutputWei = amountWei;
        wrapQuote.minOutput = wrapQuote.outputAmount;
        wrapQuote.slippage = 0;
        wrapQuote.allQuotes = [wrapQuote];
        return wrapQuote;
      }
    }

    // Native gas-token routing (e.g. XDAI→EURe on Gnosis): every Curve pool
    // holds the wrapped ERC20 variant (WXDAI), so the quote engine must search
    // from the wrapped side. We then wrap the underlying quote in a composite
    // route with an explicit wrap/unwrap segment exposed in the UI and as a
    // separate sub-transaction at submit time.
    const NATIVE = this._getNativeAddr();
    const WRAPPED = this._getWrappedAddr();
    const fromIsNative = from.toLowerCase() === NATIVE;
    const toIsNative = to.toLowerCase() === NATIVE;
    if ((fromIsNative || toIsNative) && WRAPPED && WRAPPED !== NATIVE) {
      // Resolve target side (wrapped representative) and recurse.
      const innerFrom = fromIsNative ? WRAPPED : from;
      const innerTo = toIsNative ? WRAPPED : to;
      // Avoid infinite recursion: only recurse if at least one side actually
      // changed AND inner pair is not the wrap-shortcut pair (handled above).
      if (innerFrom !== from || innerTo !== to) {
        if (!this._isWrapUnwrap(innerFrom, innerTo)) {
          try {
            // Pre-populate wrapped-native decimals (always 18 for ERC20 wrappers)
            this._decimalsCache.set(WRAPPED, 18);
            const inner = await this.getQuote(
              innerFrom, innerTo, amount, fromDecimals, toDecimals,
              slippage, userAddress,
            );
            if (inner && inner.outputAmountWei && BigInt(inner.outputAmountWei) > 0n) {
              // Если inner — агрегатор (paraswap/odos/cow), они сами умеют native
              // через 0xEee alias и роутер контракта auto-wrap/unwrap. Composite
              // envelope с явным wrap/unwrap step здесь лишний — может потеряться
              // вторая sub-tx (incident Михаил tx 0x18ff91f4..., crvUSD→ETH
              // приземлился как WETH без unwrap'а). Re-fetch агрегатор с native
              // alias и используем напрямую если выходное количество ≥ composite.
              const aggSources = ['paraswap', 'odos', 'cow'];
              if (this._enableParaSwap || this._enableOdos || this._enableCow) {
                if (aggSources.includes(inner.source)) {
                  try {
                    let nativeQuote = null;
                    if (inner.source === 'paraswap' && this._enableParaSwap) {
                      nativeQuote = await this._getParaSwapQuote(from, to, amountWei, fromDecimals, toDecimals, userAddress);
                    } else if (inner.source === 'odos' && this._enableOdos) {
                      nativeQuote = await this._getOdosQuote(from, to, amountWei, fromDecimals, toDecimals, userAddress);
                    } else if (inner.source === 'cow' && this._enableCow && userAddress) {
                      nativeQuote = await this._getCowQuote(from, to, amountWei, fromDecimals, toDecimals, userAddress);
                    }
                    if (nativeQuote && BigInt(nativeQuote.outputAmountWei || 0) > 0n &&
                        BigInt(nativeQuote.outputAmountWei) * 100n >= BigInt(inner.outputAmountWei) * 99n) {
                      const minOutput = BigInt(nativeQuote.outputAmountWei) * BigInt(Math.floor((1 - slippage / 100) * 10000)) / 10000n;
                      nativeQuote.minOutputWei = minOutput.toString();
                      nativeQuote.minOutput = ethers.formatUnits(minOutput, toDecimals);
                      nativeQuote.slippage = slippage;
                      nativeQuote.allQuotes = [nativeQuote];
                      return nativeQuote;
                    }
                  } catch (e) {
                    console.warn('[CurveDEXRouter] aggregator native re-fetch failed, falling back to composite:', e?.message || e);
                  }
                }
              }
              return this._wrapNativeComposite(inner, from, to, fromIsNative, toIsNative, amountWei, fromDecimals, toDecimals, slippage);
            }
          } catch (e) {
            // fall through to vanilla path (may still find a route if a pool
            // explicitly references the 0xeee… native sentinel on some chains)
            console.warn('[CurveDEXRouter] native-wrap recurse failed:', e?.message || e);
          }
        }
      }
    }

    // Launch Curve strategies in parallel with individual timeouts
    const s = this._strategies; // null = all
    const allStrategies = [
      { name: 'curve-direct', fn: () => this._getCurveDirectQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-router', fn: () => this._getCurveRouterQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-split', fn: () => this._getCurveSplitQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-multi-path', fn: () => this._getCurveMultiPathQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-graph-split', fn: () => this._getCurveGraphSplitQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-zap-metapool', fn: () => this._getZapMetapoolQuote(from, to, amountWei, fromDecimals, toDecimals) },
      // Curve.js baseline: ensures our final pick is never worse than the
      // route curve.finance would produce. Particularly important for routes
      // where curve-js mixes swap with add_liquidity / remove_liquidity
      // helpers (swap_type=4/5/7), e.g. alUSD→3Crv. Mainnet only — see
      // _getCurveJsBaselineQuote for guard logic.
      { name: 'curve-js-baseline', fn: () => this._getCurveJsBaselineQuote(from, to, amountWei, fromDecimals, toDecimals) },
    ];
    // Per-call registry of strategies that FAILED (threw / timed out) — as
    // opposed to legitimately returning null (no route via that strategy).
    // A failed Curve-native source means the comparison set is incomplete and
    // the "best" pick may be a worse route (Михаил tx 0xb07a082…: curve-direct
    // dropped on RPC errors → multihop won). Surfaced on the returned quote as
    // _degradedSources so submit paths can refuse to sign silently.
    const strategyFailures = {};
    const quotePromises = allStrategies
      .filter(st => !s || s.includes(st.name))
      .map(st => this._withTimeout(st.fn(), st.name, strategyFailures));
    // Optional aggregator fallbacks
    if (this._enableParaSwap) {
      quotePromises.push(
        this._withTimeout(this._getParaSwapQuote(from, to, amountWei, fromDecimals, toDecimals, userAddress), 'paraswap')
      );
    }
    if (this._enableCow && userAddress) {
      quotePromises.push(
        this._withTimeout(this._getCowQuote(from, to, amountWei, fromDecimals, toDecimals, userAddress), 'cow')
      );
    }
    if (this._enableOdos) {
      quotePromises.push(
        this._withTimeout(this._getOdosQuote(from, to, amountWei, fromDecimals, toDecimals, userAddress), 'odos')
      );
    }

    const results = await Promise.allSettled(quotePromises);

    // Collect successful quotes
    const quotes = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        quotes.push(r.value);
      }
    }

    if (quotes.length === 0) {
      throw new Error('No valid quotes found from any Curve source');
    }

    // Annotate each quote with USD output + USD tx-cost (real gas price + ETH
    // rate) ONCE, so the sort comparator is pure arithmetic and mirrors curve-js's
    // (outputUsd − txCostUsd) selection. Must run before the sort.
    await this._annotateTxCosts(quotes, to);

    // Sort by net-USD score (descending) — best quote first.
    // Tiebreak toward fewer hops (cheaper, lower-risk execution), matching
    // curve-js, when two routes are within a negligible net-USD epsilon.
    quotes.sort((a, b) => {
      const aScore = this._gasAwareScore(a);
      const bScore = this._gasAwareScore(b);
      const diff = bScore - aScore;
      // Epsilon: 1e-6 USD — below any meaningful output difference. Within it,
      // prefer the route with fewer hops (lower _numHops, default 1).
      if (Math.abs(diff) > 1e-6) return diff;
      const aHops = a._numHops || 1;
      const bHops = b._numHops || 1;
      return aHops - bHops;
    });

    // Mainnet: split-family quotes cannot be executed as displayed —
    // buildSwapTx delegates every Curve source to curve-js populateSwap
    // (single route), so a split winner would DRAW a branched sankey while
    // SIGNING a different single route with another expected output (same
    // display/execute class as tx 0xb07a082…). Until split execution exists
    // they don't compete for winner; they stay in allQuotes for the panel.
    const SPLIT_SRCS = ['curve-split', 'curve-multi-path', 'curve-graph-split'];
    const best = (this._chainId === 1
      ? quotes.find(q => !SPLIT_SRCS.includes(q.source))
      : null) || quotes[0];

    // Compute min received with slippage
    const minOutput = BigInt(best.outputAmountWei) * BigInt(Math.floor((1 - slippage / 100) * 10000)) / 10000n;
    best.minOutputWei = minOutput.toString();
    best.minOutput = ethers.formatUnits(minOutput, toDecimals);
    best.slippage = slippage;
    best.allQuotes = quotes; // Include all quotes for comparison UI
    // Curve-native sources that errored out (RPC, timeout) — the comparison is
    // incomplete. External aggregators (paraswap/odos/cow) excluded: their
    // failures are routine (CORS/DNS) and never the baseline.
    const degraded = Object.keys(strategyFailures)
      .filter(n => !['paraswap', 'odos', 'cow'].includes(n));
    if (degraded.length) best._degradedSources = degraded;

    return best;
  }

  /**
   * Build a swap transaction for execution.
   * Returns an object ready to pass to signer.sendTransaction().
   *
   * @param {QuoteResult} quote - Quote from getQuote()
   * @param {string} userAddress - User's wallet address
   * @returns {Promise<Object>} Transaction parameters { to, data, value, gasLimit? }
   */
  async buildSwapTx(quote, userAddress) {
    if (!quote || !userAddress) throw new Error('Quote and userAddress required');

    // Mainnet curve-js always-on intercept: route ALL Curve quotes through
    // @curvefi/api populateSwap so the *same* code that powers curve.finance
    // builds our tx. There is no parallel Router NG encoder — curve-js owns
    // every pool_type / metapool exchange_underlying / wrap-unwrap leg, AND
    // it picks the best multi-hop split automatically.
    //
    // Reasoning (Михаил 2026-05-25): «должен быть единый роутер для всех
    // пулов, вайтлисты — плохо. Наш роутер может находить лучшее, но точно
    // не хуже». curve-js's getBestRouteAndOutput picks the best route over
    // ALL factories; we keep our own multi-source quote search (paraswap /
    // odos / cow / our split paths) to surface BETTER routes when we find
    // them, but the tx encoding for the chosen Curve route is delegated to
    // curve-js so we never regress against curve.finance's UI.
    //
    // Constraints:
    //   - chainId=1 only (curve-js init / RPC configured for mainnet)
    //   - quote source ∈ {curve-direct, curve-router, curve-split,
    //     curve-multi-path, curve-graph-split, curve-zap-metapool}
    //   - curve-js must be ready (window.curveJsReadyForChain(1) resolved).
    //     If still loading, we await it — it's a one-time ~1s cost per
    //     session.
    //   - graceful fallback to legacy direct-pool path if curve-js build
    //     throws (network blip, pool not in curve-js registry) — never
    //     block a swap.
    const __isMainnetCurveSrc = (
      this._chainId === 1 &&
      typeof window !== 'undefined' &&
      typeof window.curveJsReadyForChain === 'function' &&
      ['curve-direct','curve-router','curve-split','curve-multi-path','curve-graph-split','curve-zap-metapool','curve-js-baseline'].includes(quote.source)
    );
    if (__isMainnetCurveSrc) {
      try {
        return await this._buildMainnetCurveJsTx(quote, userAddress);
      } catch (e) {
        console.warn('[CurveDEXRouter] curve-js intercept failed, falling back to direct path:', e?.message || e);
        // fall through to switch dispatch (legacy direct-to-pool)
      }
    }

    switch (quote.source) {
      case 'weth-wrap':
        return this._buildWethWrapTx(quote, userAddress);
      case 'native-wrap-composite':
        return this._buildNativeWrapCompositeTx(quote, userAddress);
      case 'curve-direct':
        return this._buildCurveDirectTx(quote, userAddress);
      case 'curve-router':
        return this._buildCurveRouterTx(quote, userAddress);
      case 'curve-split':
        return this._buildCurveSplitTx(quote, userAddress);
      case 'curve-multi-path':
        return this._buildCurveMultiPathTx(quote, userAddress);
      case 'curve-graph-split':
        return this._buildCurveGraphSplitTx(quote, userAddress);
      case 'curve-zap-metapool':
        return this._buildZapMetapoolTx(quote, userAddress);
      case 'paraswap':
        return this._buildParaSwapTx(quote, userAddress);
      case 'cow':
        return this._buildCowTx(quote, userAddress);
      case 'odos':
        return this._buildOdosTx(quote, userAddress);
      default:
        throw new Error(`Unknown quote source: ${quote.source}`);
    }
  }

  /**
   * Check and set token approval for the appropriate spender.
   * Returns null if no approval needed, or the approval tx receipt.
   *
   * @param {QuoteResult} quote - Quote from getQuote()
   * @param {string} userAddress - User's wallet address
   * @param {ethers.Signer} signer - ethers.js Signer
   * @returns {Promise<Object|null>} Approval tx receipt or null
   */
  async ensureApproval(quote, userAddress, signer) {
    const fromToken = quote.fromToken;
    // Native ETH doesn't need approval
    if (fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase()) return null;

    const spender = this._getSpender(quote);
    if (!spender) return null;

    const token = new ethers.Contract(fromToken, ERC20_ABI, signer);
    const allowance = await token.allowance(userAddress, spender);
    const needed = BigInt(quote.inputAmountWei);

    if (allowance >= needed) return null;

    // Approve max to save gas on future swaps. Apply Michwill EIP-1559 gas
    // strategy (tip=5% of base, maxFee=2.05×base) — same as actual swap tx.
    const gasOv = signer.provider && typeof window !== 'undefined' && typeof window.computeMichwillGasParams === 'function'
      ? await window.computeMichwillGasParams(signer.provider)
      : {};
    // Per Михаил hard rule (msg 7092 2026-05-24): never hardcode gasLimit on
    // ANY tx including approve. Estimate × 1.5.
    const approveData = token.interface.encodeFunctionData('approve', [spender, ethers.MaxUint256]);
    const approveTx = { to: fromToken, data: approveData, value: 0n };
    if (signer.provider && typeof window !== 'undefined' && typeof window.estimateGasWithBuffer === 'function') {
      approveTx.gasLimit = await window.estimateGasWithBuffer(signer.provider, approveTx, userAddress);
    }
    const tx = await signer.sendTransaction({ ...approveTx, ...gasOv });
    return tx.wait();
  }

  // ============================================================
  // TOKEN GRAPH & DYNAMIC INTERMEDIATE DISCOVERY
  // ============================================================

  /**
   * Build a token connectivity graph from pool data.
   * Nodes = token addresses (lowercase), Edges = pools connecting them.
   * Each edge stores the best pool (highest TVL) between two tokens.
   * Lazy-built and cached until setPools() invalidates.
   *
   * @returns {Map<string, Map<string, {pool: Object, tvl: number}>>}
   */
  /**
   * Normalize native ↔ wrapped-native: treat them as the same node in graphs.
   * Chain-aware: WETH on Ethereum, WXDAI on Gnosis, WMATIC on Polygon, etc.
   * @param {string} addr - lowercase token address
   * @returns {string} normalized address (wrapped variant when input is native)
   */
  _normalizeEthWeth(addr) {
    return addr === ETH_ADDRESS.toLowerCase() ? this._getWrappedAddr() : addr;
  }

  /**
   * Detect native ↔ wrapped-native wrap/unwrap on the active chain. This is
   * not a swap — it's a 1:1 deposit/withdraw on the wrapped-native ERC20
   * (WETH9 on Ethereum, WXDAI on Gnosis, ...). Curve has no pools that ingest
   * one and emit the other, so any "swap" engine returns garbage (revert).
   * Production aggregators (Uniswap UI, 1inch, CowSwap) all detect and shortcut.
   *
   * @param {string} fromAddr - source token address (any case)
   * @param {string} toAddr - destination token address (any case)
   * @returns {'wrap'|'unwrap'|null} 'wrap'=native→wrapped, 'unwrap'=wrapped→native
   */
  _isWrapUnwrap(fromAddr, toAddr) {
    const a = (fromAddr || '').toLowerCase();
    const b = (toAddr || '').toLowerCase();
    const E = ETH_ADDRESS.toLowerCase();
    const W = this._getWrappedAddr();
    if (a === E && b === W) return 'wrap';
    if (a === W && b === E) return 'unwrap';
    return null;
  }

  /**
   * Build a synthetic 1:1 quote for ETH ↔ WETH wrap/unwrap. No on-chain calls.
   * @param {string} fromToken
   * @param {string} toToken
   * @param {string} amountWei
   * @param {number} fromDecimals (always 18 for ETH/WETH)
   * @param {number} toDecimals (always 18 for ETH/WETH)
   * @returns {Object} synthetic quote
   */
  _getWethWrapQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const direction = this._isWrapUnwrap(fromToken, toToken);
    if (!direction) return null;
    const formatted = ethers.formatUnits(amountWei, fromDecimals);
    const wrapped = this._getWrappedAddr();
    return {
      source: 'weth-wrap',
      sourceName: direction === 'wrap' ? 'Wrap (deposit)' : 'Unwrap (withdraw)',
      fromToken,
      toToken,
      inputAmountWei: amountWei,
      outputAmountWei: amountWei,
      outputAmount: formatted,
      rate: 1,
      priceImpact: 0,
      gas: direction === 'wrap' ? 30000 : 35000, // realistic deposit/withdraw cost
      route: [{
        pool: wrapped,
        poolName: 'native wrapper',
        from: fromToken,
        to: toToken,
        iFrom: 0,
        iTo: 0,
        isCrypto: false,
      }],
      _wrapDirection: direction,
      _wrapContract: wrapped,
    };
  }

  _getTokenGraph() {
    if (this._tokenGraph) return this._tokenGraph;

    const graph = new Map();

    const addEdge = (a, b, pool, tvl) => {
      a = this._normalizeEthWeth(a);
      b = this._normalizeEthWeth(b);
      if (!graph.has(a)) graph.set(a, new Map());
      const neighbors = graph.get(a);
      const existing = neighbors.get(b);
      if (!existing || tvl > existing.tvl) {
        neighbors.set(b, { pool, tvl });
      }
    };

    for (const pool of this._pools) {
      if (!pool.coinsAddresses || pool.coinsAddresses.length < 2) continue;
      const tvl = pool.tvl || 0;
      // Skip dust pools for multi-hop routing — they produce nonsense get_dy outputs
      // when the swap size dwarfs available liquidity. Direct quotes bypass this graph
      // and use _findBestPool which iterates _pools directly, so small legitimate pools
      // remain reachable for single-hop swaps.
      if (tvl < MIN_HOP_POOL_TVL) continue;
      const coins = pool.coinsAddresses.map(a => a.toLowerCase());

      // Add edges between all pairs of coins in this pool
      for (let i = 0; i < coins.length; i++) {
        for (let j = i + 1; j < coins.length; j++) {
          addEdge(coins[i], coins[j], pool, tvl);
          addEdge(coins[j], coins[i], pool, tvl);
        }
      }
    }

    this._tokenGraph = graph;
    return graph;
  }

  /**
   * Build a multi-edge token graph: stores ALL pools per token pair (not just best).
   * Each edge is an array of {pool, tvl} sorted by TVL descending.
   * Lazy-built and cached until setPools() invalidates.
   *
   * @returns {Map<string, Map<string, Array<{pool: Object, tvl: number}>>>}
   */
  _getTokenGraphMulti() {
    if (this._tokenGraphMulti) return this._tokenGraphMulti;

    const graph = new Map();

    const addEdge = (a, b, pool, tvl) => {
      a = this._normalizeEthWeth(a);
      b = this._normalizeEthWeth(b);
      if (a === b) return; // skip self-loops
      if (!graph.has(a)) graph.set(a, new Map());
      const neighbors = graph.get(a);
      if (!neighbors.has(b)) neighbors.set(b, []);
      // Avoid duplicate pools (same address)
      const arr = neighbors.get(b);
      if (!arr.some(e => e.pool.address === pool.address)) {
        arr.push({ pool, tvl });
      }
    };

    for (const pool of this._pools) {
      if (!pool.coinsAddresses || pool.coinsAddresses.length < 2) continue;
      const tvl = pool.tvl || 0;
      // Same dust filter as _getTokenGraph — multi-hop pathfinding cannot use pools
      // that mathematically saturate to their entire balance under real trade sizes.
      if (tvl < MIN_HOP_POOL_TVL) continue;
      const coins = pool.coinsAddresses.map(a => a.toLowerCase());

      for (let i = 0; i < coins.length; i++) {
        for (let j = i + 1; j < coins.length; j++) {
          addEdge(coins[i], coins[j], pool, tvl);
          addEdge(coins[j], coins[i], pool, tvl);
        }
      }
    }

    // Sort each edge array by TVL descending
    for (const [, neighbors] of graph) {
      for (const [key, arr] of neighbors) {
        arr.sort((a, b) => b.tvl - a.tvl);
      }
    }

    this._tokenGraphMulti = graph;
    return graph;
  }

  /**
   * Resolve a token's symbol/decimals from a hop's pool data when possible,
   * falling back to the seed/discovered intermediates list, then to '???'.
   *
   * Why this exists: _getIntermediates() only knows ~30 popular tokens (USDC, DAI,
   * stETH, etc.). Routes through niche tokens (sdYB, YB, USD3, ...) would render as
   * '???' in the route visualization even though the pool itself knows the symbol.
   * The pool object carries coin symbols at the same index as coinsAddresses, so we
   * can look up the symbol directly from the hop's pool — guaranteed to have the
   * answer for any token actually in the route.
   *
   * @param {string} addr - token address
   * @param {Object|null} pool - pool that contains this token (any leg's pool works)
   * @returns {{address, symbol, decimals}}
   */
  _resolveTokenInfo(addr, pool = null) {
    if (!addr) return { address: addr, symbol: '???', decimals: 18 };
    const lc = addr.toLowerCase();
    // 1) Try the supplied pool first (cheapest and most reliable for unusual tokens)
    if (pool && pool.coinsAddresses && pool.coins) {
      const idx = pool.coinsAddresses.findIndex(a => a.toLowerCase() === lc);
      if (idx >= 0) {
        const symbol = pool.coins[idx];
        const decimals = pool.coinDecimals?.[idx] || (pool.decimals?.[idx] ? Number(pool.decimals[idx]) : 18);
        if (symbol && symbol !== '???') return { address: addr, symbol, decimals };
      }
    }
    // 2) Fall back to intermediates list (covers seed + discovered hubs)
    const intermediates = this._getIntermediates();
    const found = intermediates.find(t => t.address.toLowerCase() === lc);
    if (found) return found;
    // 3) Last resort: scan all pools for this address (one-time cost, cached on miss
    //    is unnecessary because we usually find it via the pool argument above)
    for (const p of this._pools) {
      if (!p.coinsAddresses) continue;
      const idx = p.coinsAddresses.findIndex(a => a.toLowerCase() === lc);
      if (idx >= 0 && p.coins?.[idx]) {
        const decimals = p.coinDecimals?.[idx] || (p.decimals?.[idx] ? Number(p.decimals[idx]) : 18);
        return { address: addr, symbol: p.coins[idx], decimals };
      }
    }
    return { address: addr, symbol: '???', decimals: 18 };
  }

  /**
   * Sanity-check a multi-hop quote's rate against a spot rate computed from a
   * tiny probe through the same path. The spot rate is what the user would get
   * for an infinitesimal trade (no slippage); the executed rate is what they
   * get for the requested amount. If the executed rate is wildly worse than
   * the spot rate, the path is hitting saturation — typically a dust pool's
   * get_dy returning the asymptotic max ≈ entire pool balance. Reject.
   *
   * Why this is needed even with TVL filtering: TVL data from Curve API can be
   * stale, missing, or inflated by virtual prices. A pool reporting $100k TVL
   * may still have $0.50 of one specific coin if balances are heavily skewed.
   * Rate-sanity catches these cases at evaluation time using the actual on-chain
   * state — TVL is just a cheap pre-filter.
   *
   * Performs a single extra get_dy call per leg (probe at amountWei/1000) — adds
   * ~30-50ms total per candidate path; acceptable cost to avoid presenting users
   * a quote that delivers <1% of expected output.
   *
   * @param {Array<{pool, fromToken, toToken}>} legs - the path legs
   * @param {string} amountWei - the actual trade size in wei
   * @param {string} executedOutputWei - the on-chain quote output for amountWei
   * @returns {Promise<boolean>} true if rate is plausible, false if path should be rejected
   */
  async _isPathRateSane(legs, amountWei, executedOutputWei) {
    try {
      const probeAmount = BigInt(amountWei) / 1000n;
      if (probeAmount <= 0n) return true; // can't probe, accept
      let probeOutput = probeAmount;
      for (const leg of legs) {
        const { iFrom, iTo } = this._getPoolIndices(leg.pool, leg.fromToken || leg.from, leg.toToken || leg.to);
        if (iFrom === -1 || iTo === -1) return true; // unknown pool shape, don't gate
        const out = await this._getDy(leg.pool, iFrom, iTo, probeOutput.toString());
        if (!out || out <= 0n) return true; // probe failed, don't gate
        probeOutput = out;
      }
      // probeOutput is for input = amountWei/1000. Scale to expected full output.
      const expectedOutputAtSpot = probeOutput * 1000n;
      if (expectedOutputAtSpot <= 0n) return true;
      const executed = BigInt(executedOutputWei);
      // ratio = executed / expected (basis points to avoid float)
      const ratioBps = executed * 10000n / expectedOutputAtSpot;
      const minBps = BigInt(Math.floor(MIN_RATE_RATIO_VS_SPOT * 10000));
      return ratioBps >= minBps;
    } catch {
      return true; // any error in probe → don't gate, fall back to TVL filter
    }
  }

  /**
   * Discover intermediate (hub) tokens purely from pool data — no hardcoded seed
   * list and no fixed TVL floor.
   *
   * A token's value as a routing hub IS its connectivity weighted by the
   * liquidity routed through it. We therefore rank every token by its
   * tvl-weighted degree: the summed TVL of all pools it appears in. A token
   * qualifies as a candidate hub simply by appearing in ≥2 pools (so it can act
   * as a bridge between otherwise-disjoint pairs). There is no $-threshold gate:
   * removing the old MIN_TVL_FOR_INTERMEDIATE=500000 means low-TVL-but-well-
   * connected stables (which curve-js routes through) are no longer silently
   * dropped. The tvl-weighting naturally orders genuine hubs (WETH/USDC/crvUSD…)
   * to the top without naming them.
   *
   * The returned list is capped only to bound RPC cost downstream; the cap is a
   * count of distinct hubs to expand, NOT a value threshold or an allow-list of
   * specific tokens. Per-quote on-chain probing is further bounded by
   * MAX_INTERMEDIATE_CANDIDATES.
   *
   * @returns {Array<{address: string, symbol: string, decimals: number}>}
   */
  _getIntermediates() {
    if (this._dynamicIntermediates) return this._dynamicIntermediates;

    // addr -> { count, totalTvl, symbol, decimals }
    const tokenStats = new Map();

    for (const pool of this._pools) {
      if (!pool.coinsAddresses) continue;
      const tvl = pool.tvl || 0;
      const coins = pool.coinsAddresses;
      const symbols = pool.coins || [];
      // Cache stores decimals under `decimals` (strings); `coinDecimals` is not
      // populated. Read the real field, coerce to Number, default 18.
      const decimals = pool.decimals || pool.coinDecimals || [];

      for (let i = 0; i < coins.length; i++) {
        if (!coins[i]) continue;
        const addr = coins[i].toLowerCase();
        const stat = tokenStats.get(addr) || {
          count: 0, totalTvl: 0,
          symbol: symbols[i]?.symbol || symbols[i] || '???',
          decimals: Number(decimals[i]) || 18,
        };
        stat.count++;
        stat.totalTvl += tvl;
        tokenStats.set(addr, stat);
      }
    }

    // Candidate hubs: any token bridging ≥2 pools. Rank by tvl-weighted degree.
    const candidates = [];
    for (const [addr, stat] of tokenStats) {
      if (stat.count >= MIN_POOLS_FOR_INTERMEDIATE) {
        candidates.push({ address: addr, symbol: stat.symbol, decimals: stat.decimals, totalTvl: stat.totalTvl, count: stat.count });
      }
    }
    candidates.sort((a, b) => b.totalTvl - a.totalTvl);

    // Cap the hub list to bound downstream RPC fan-out. This is a count of hubs,
    // scaled to the pool universe (not a hardcoded magic number tuned to a token
    // set): √(#pools) keeps it proportional — ~47 hubs for 2243 pools — which
    // comfortably covers the connected core while staying RPC-bounded. Per-quote
    // expansion is additionally capped by MAX_INTERMEDIATE_CANDIDATES.
    const hubCap = Math.max(MIN_POOLS_FOR_INTERMEDIATE * 2, Math.ceil(Math.sqrt(this._pools.length)));
    const result = [];
    for (const c of candidates.slice(0, hubCap)) {
      result.push({ address: c.address, symbol: c.symbol, decimals: c.decimals });
      this._decimalsCache.set(c.address, c.decimals);
    }

    this._dynamicIntermediates = result;
    console.log(`[CurveDEXRouter] Intermediates: ${result.length} hubs discovered (emergent, tvl-weighted; cap=${hubCap}) from ${candidates.length} ≥2-pool tokens`);
    return result;
  }

  /**
   * BFS pathfinding through the token graph.
   * Finds paths from source to target with up to maxHops hops.
   * Returns array of paths, each path is [{from, to, pool, tvl}, ...].
   * Paths are sorted by minimum TVL along the path (descending = best liquidity first).
   *
   * @param {string} fromToken - Source token address
   * @param {string} toToken - Destination token address
   * @param {number} maxHops - Maximum number of hops (2 or 3)
   * @param {number} maxPaths - Maximum number of paths to return
   * @returns {Array<Array<{from: string, to: string, pool: Object, tvl: number}>>}
   */
  _findPaths(fromToken, toToken, maxHops = 3, maxPaths = 8) {
    const graph = this._getTokenGraph();
    const from = fromToken.toLowerCase();
    const to = toToken.toLowerCase();

    if (!graph.has(from)) return [];

    const paths = [];
    // BFS with path tracking: queue items are [currentNode, pathSoFar, visitedSet]
    const queue = [[from, [], new Set([from])]];

    while (queue.length > 0 && paths.length < maxPaths * 3) { // collect more, filter later
      const [current, pathSoFar, visited] = queue.shift();

      if (pathSoFar.length >= maxHops) continue;

      const neighbors = graph.get(current);
      if (!neighbors) continue;

      for (const [neighbor, edge] of neighbors) {
        if (visited.has(neighbor) && neighbor !== to) continue;

        const hop = { from: current, to: neighbor, pool: edge.pool, tvl: edge.tvl };
        const newPath = [...pathSoFar, hop];

        if (neighbor === to) {
          // Found a complete path
          const minTvl = Math.min(...newPath.map(h => h.tvl));
          paths.push({ hops: newPath, minTvl });
        } else if (newPath.length < maxHops) {
          const newVisited = new Set(visited);
          newVisited.add(neighbor);
          queue.push([neighbor, newPath, newVisited]);
        }
      }
    }

    // Sort by minTvl descending (prefer paths through deep-liquidity pools)
    paths.sort((a, b) => b.minTvl - a.minTvl);
    return paths.slice(0, maxPaths).map(p => p.hops);
  }

  /**
   * BFS pathfinding that returns path shapes annotated with a top-K list of
   * candidate pools per hop, sourced from the multi-edge graph.
   *
   * Why this exists separately from _findPaths:
   *  - _findPaths consumes the single-edge graph (highest-TVL pool per pair),
   *    which is correct for path discovery but loses alternative-pool variants.
   *  - For path *evaluation* we want to try ALL top pools on each hop — a
   *    smaller pool with better A-coefficient can win on small/medium sizes
   *    even when picking pools from the same intermediate token sequence
   *    (mirroring the single-hop _getCurveDirectQuote fix).
   *
   * The returned shape lists token-sequence paths; the caller is responsible
   * for expanding each shape into Cartesian pool variants (capped globally).
   *
   * @param {string} fromToken
   * @param {string} toToken
   * @param {number} maxHops
   * @param {number} maxPaths - cap on number of path shapes returned
   * @param {number} topKPerHop - candidate pools per hop in each shape
   * @returns {Array<Array<{from: string, to: string, candidates: Array<{pool, tvl}>}>>}
   */
  _findPathsMulti(fromToken, toToken, maxHops = 3, maxPaths = 12, topKPerHop = TOP_K_POOLS_PER_HOP) {
    const multiGraph = this._getTokenGraphMulti();
    const from = this._normalizeEthWeth(fromToken.toLowerCase());
    const to = this._normalizeEthWeth(toToken.toLowerCase());

    if (!multiGraph.has(from)) return [];

    const paths = [];
    // BFS state per item: [currentNode, pathSoFar, visited]
    // pathSoFar is array of { from, to, candidates: [{pool,tvl}, ...] }
    const queue = [[from, [], new Set([from])]];

    while (queue.length > 0 && paths.length < maxPaths * 3) {
      const [current, pathSoFar, visited] = queue.shift();
      if (pathSoFar.length >= maxHops) continue;

      const neighbors = multiGraph.get(current);
      if (!neighbors) continue;

      for (const [neighbor, edgeList] of neighbors) {
        if (visited.has(neighbor) && neighbor !== to) continue;
        if (!edgeList || edgeList.length === 0) continue;

        // Pre-sorted descending by TVL in _getTokenGraphMulti
        const candidates = edgeList.slice(0, topKPerHop);
        const hop = { from: current, to: neighbor, candidates };
        const newPath = [...pathSoFar, hop];

        if (neighbor === to) {
          // Path shape's strength is bounded by best-pool TVL at the weakest hop
          const minTvl = Math.min(...newPath.map(h => h.candidates[0].tvl));
          paths.push({ hops: newPath, minTvl });
        } else if (newPath.length < maxHops) {
          const newVisited = new Set(visited);
          newVisited.add(neighbor);
          queue.push([neighbor, newPath, newVisited]);
        }
      }
    }

    paths.sort((a, b) => b.minTvl - a.minTvl);
    return paths.slice(0, maxPaths).map(p => p.hops);
  }

  /**
   * Expand path shapes (each hop has a candidates[] array) into concrete route
   * variants (each hop has one pool). Caps total variants globally.
   *
   * Strategy: for each shape, generate full Cartesian product of pool choices,
   * tag each variant with its min-TVL across hops, then take a global top-N by
   * min-TVL. This naturally retains the single-best-pool variant for every
   * shape AND the deepest expansions, biased toward depth-of-liquidity.
   *
   * @param {Array<Array<{from, to, candidates}>>} pathShapes
   * @param {number} globalCap
   * @returns {Array<{hops: Array<{from, to, pool, tvl}>, minTvl: number}>}
   */
  _expandPathVariants(pathShapes, globalCap = MAX_TOTAL_ROUTE_VARIANTS) {
    const allVariants = [];
    for (const shape of pathShapes) {
      // Cartesian product of candidates across hops
      const dims = shape.map(h => h.candidates);
      const total = dims.reduce((s, d) => s * d.length, 1);
      // Iterate via index tuple
      for (let i = 0; i < total; i++) {
        let idx = i;
        const hops = [];
        let bad = false;
        const usedPools = new Set();
        for (let h = 0; h < dims.length; h++) {
          const choice = dims[h][idx % dims[h].length];
          idx = Math.floor(idx / dims[h].length);
          // Reject variants that reuse the same pool across non-adjacent hops —
          // such routes are degenerate cycles and produce pathological get_dy.
          // Adjacent reuse is impossible because consecutive hops have different
          // (from,to) pairs.
          if (usedPools.has(choice.pool.address)) {
            bad = true;
            break;
          }
          usedPools.add(choice.pool.address);
          hops.push({
            from: shape[h].from,
            to: shape[h].to,
            pool: choice.pool,
            tvl: choice.tvl,
          });
        }
        if (bad) continue;
        const minTvl = Math.min(...hops.map(h => h.tvl));
        allVariants.push({ hops, minTvl });
      }
    }
    allVariants.sort((a, b) => b.minTvl - a.minTvl);
    return allVariants.slice(0, globalCap);
  }

  // ============================================================
  // STRATEGY 1: CURVE DIRECT POOL QUOTES
  // ============================================================

  /**
   * Find the best direct pool swap (single hop).
   *
   * Evaluates ALL pools containing both tokens (not just highest-TVL) via
   * parallel get_dy calls, then picks the pool with the largest output_wei.
   *
   * Why: smaller pools can outperform the dominant pool on small/medium
   * trade sizes (e.g. on USDT/USDC, Curve.fi Strategic USD Reserves at
   * $10.66M TVL outperforms 3pool at $162M for trades ≤100k because its
   * higher A=10000 amplification produces a tighter spread, until reserve
   * depletion kicks in at ~1M). The legacy "highest TVL wins" heuristic
   * silently dropped these opportunities.
   *
   * Broken pools (returning garbage get_dy values orders of magnitude off
   * spot) are filtered using the highest-TVL pool as a trusted baseline:
   * any candidate whose output is more than 1.5x the baseline is rejected
   * as saturated/garbage. Legitimate AMM advantage between two pools on
   * the same pair is sub-1% (bp-level), so a 1.5x ceiling is huge headroom
   * for honest math while ruling out broken-pool poisoning.
   *
   * Uses on-chain get_dy for accurate pricing.
   */
  async _getCurveDirectQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const pools = this._findAllPools(fromToken, toToken);
    if (!pools || pools.length === 0) return null;

    // Cap fanout. Pools are pre-sorted by TVL desc, so we evaluate the most
    // liquid candidates plus a few smaller alternatives. 5 covers the
    // realistic head of the distribution without blowing the RPC budget.
    const MAX_DIRECT_CANDIDATES = 5;
    const candidates = pools.slice(0, MAX_DIRECT_CANDIDATES);

    // Evaluate get_dy on every candidate in parallel. Distinguish "candidate
    // legitimately quoted nothing" (revert / zero output) from "the eth_call
    // itself failed" (RPC 429/timeout): if direct pools EXIST but every probe
    // died on RPC, returning null here silently removes curve-direct from the
    // strategy comparison and a worse multihop wins (Михаил tx 0xb07a082…).
    // Throw instead, so getQuote records the strategy as degraded.
    let rpcFailures = 0;
    const evals = await Promise.all(candidates.map(async (pool) => {
      try {
        const { iFrom, iTo, isCrypto, isUnderlying } = this._getPoolIndices(pool, fromToken, toToken);
        if (iFrom === -1 || iTo === -1) return null;

        const outputWei = await this._getDy(pool, iFrom, iTo, amountWei, !!isUnderlying);
        if (!outputWei || outputWei <= 0n) return null;

        return { pool, iFrom, iTo, isCrypto, isUnderlying: !!isUnderlying, outputWei };
      } catch (e) {
        if (!e || !e._isContractRevert) rpcFailures++;
        return null;
      }
    }));

    // Sanity filter using the highest-TVL pool's output as a trusted
    // baseline. evals[0] corresponds to pools[0] which has the highest
    // TVL among candidates with this token pair — its get_dy is reliable.
    // Reject any candidate whose output is more than 1.5x the baseline:
    // honest AMM advantage between two pools on the same pair is sub-1%,
    // so >50% better always indicates a broken/saturated pool returning
    // garbage (e.g. its full reserve balance instead of swap math).
    const baseline = evals.find(e => e != null);
    if (!baseline) {
      if (rpcFailures > 0) {
        throw new Error(`curve-direct degraded: ${rpcFailures}/${candidates.length} candidates failed on RPC (non-revert)`);
      }
      return null;
    }
    const ceiling = baseline.outputWei * 3n / 2n; // 1.5x

    // Pick the pool with the largest output_wei, ignoring outliers above ceiling.
    let winner = null;
    for (const e of evals) {
      if (!e) continue;
      if (e.outputWei > ceiling) continue;
      if (!winner || e.outputWei > winner.outputWei) winner = e;
    }
    if (!winner) return null;

    const { pool, iFrom, iTo, isCrypto, isUnderlying, outputWei } = winner;
    const outputFormatted = ethers.formatUnits(outputWei, toDecimals);
    const inputFormatted = ethers.formatUnits(amountWei, fromDecimals);
    const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);

    // Real price impact via curve invariant: simulate dy() for a tiny amount
    // (1 unit) to get spot rate, compare with executed rate.
    // Works for all pair types (stable, crypto, exotic), unlike token-list lookup.
    const priceImpact = await this._computeBaselinePriceImpact(
      rate, [{ pool, iFrom, iTo }],
      () => this._simulateSpotThroughHops([{ pool, iFrom, iTo, isUnderlying }], fromDecimals, toDecimals),
    );

    return {
      source: 'curve-direct',
      sourceName: 'Curve Direct' + (isUnderlying ? ' (underlying)' : ''),
      fromToken,
      toToken,
      inputAmountWei: amountWei,
      outputAmountWei: outputWei.toString(),
      outputAmount: outputFormatted,
      rate,
      priceImpact,
      gas: isUnderlying ? 280000 : 180000, // exchange_underlying composes 3pool + meta
      route: [{
        pool: pool.address,
        poolName: pool.name,
        from: fromToken,
        to: toToken,
        iFrom,
        iTo,
        isCrypto,
        isUnderlying: !!isUnderlying,
      }],
      _pool: pool,
    };
  }

  // ============================================================
  // STRATEGY 2: CURVE ROUTER NG (multi-hop via intermediates)
  // ============================================================

  /**
   * Find multi-hop routes (2-hop and 3-hop) using graph-based pathfinding.
   *
   * Strategy:
   * 1. Build token connectivity graph from all pools
   * 2. Discover dynamic intermediate tokens from high-TVL pools
   * 3. Use BFS to find 2-hop and 3-hop paths through the graph
   * 4. Verify top candidates via sequential on-chain get_dy calls
   * 5. Pick the path with the best final output
   */
  async _getCurveRouterQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const from = fromToken.toLowerCase();
    const to = toToken.toLowerCase();

    // Find path shapes (token sequences) via BFS on the multi-edge graph.
    // Each hop carries a top-K list of candidate pools, expanded into concrete
    // route variants below. Mirrors the single-hop _getCurveDirectQuote rationale:
    // smaller pools can outperform highest-TVL pools at small/medium sizes due to
    // amplification coefficient differences (e.g. Strategic USD Reserves vs 3pool).
    const pathShapes = this._findPathsMulti(
      fromToken, toToken, 3,
      MAX_INTERMEDIATE_CANDIDATES + MAX_3HOP_CANDIDATES,
      TOP_K_POOLS_PER_HOP,
    );

    if (pathShapes.length === 0) {
      // Fallback: try dynamic intermediates for 2-hop (in case graph is incomplete)
      return this._getCurveRouterQuoteFallback(fromToken, toToken, amountWei, fromDecimals, toDecimals);
    }

    // Separate 2-hop and 3-hop shapes (preserve original cap semantics)
    const shapes2hop = pathShapes.filter(p => p.length === 2).slice(0, MAX_INTERMEDIATE_CANDIDATES);
    const shapes3hop = pathShapes.filter(p => p.length === 3).slice(0, MAX_3HOP_CANDIDATES);

    // Expand shapes into concrete pool-variants (Cartesian product, globally capped).
    const variants = this._expandPathVariants([...shapes2hop, ...shapes3hop], MAX_TOTAL_ROUTE_VARIANTS);
    if (variants.length === 0) return null;

    // Build a per-shape baseline (highest-TVL pool per hop) lookup. Used as the
    // sanity ceiling: variant.finalOutput > baseline * 1.5x → reject as garbage.
    // Key = token-sequence string (e.g. "USDT->crvUSD->USDC"). Multiple variants
    // share the same baseline.
    const shapeKey = (hops) => hops.map(h => `${h.from}->${h.to}`).join('|');
    const baselinePools = new Map(); // shapeKey -> Array<{pool}> for highest-TVL-per-hop
    for (const shape of [...shapes2hop, ...shapes3hop]) {
      const key = shape.map(h => `${h.from}->${h.to}`).join('|');
      baselinePools.set(key, shape.map(h => h.candidates[0].pool));
    }

    // Each variant becomes a "path" of {from, to, pool, tvl} hops — same shape
    // the downstream verification code expects.
    const candidates = variants.map(v => v.hops);

    // Verify candidates via on-chain get_dy (sequential through hops)
    const quotePromises = candidates.map(async (path) => {
      try {
        let currentAmount = amountWei;
        const hopResults = [];

        for (const hop of path) {
          const { iFrom, iTo, isCrypto } = this._getPoolIndices(hop.pool, hop.from, hop.to);
          if (iFrom === -1 || iTo === -1) return null;

          const outputWei = await this._getDy(hop.pool, iFrom, iTo, currentAmount);
          if (!outputWei || outputWei <= 0n) return null;

          hopResults.push({
            pool: hop.pool,
            from: hop.from,
            to: hop.to,
            iFrom,
            iTo,
            isCrypto,
            inputWei: currentAmount,
            outputWei: outputWei.toString(),
          });

          currentAmount = outputWei.toString();
        }

        return {
          path,
          hopResults,
          finalOutput: currentAmount,
          numHops: path.length,
        };
      } catch {
        return null;
      }
    });

    const rawResults = (await Promise.allSettled(quotePromises))
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (rawResults.length === 0) return null;

    // Per-shape sanity ceiling: any variant of a shape whose finalOutput exceeds
    // baseline (highest-TVL-per-hop variant of the same shape) × 1.5x is rejected
    // as a saturated/depleted pool returning the asymptotic ceiling — same logic
    // and rationale as the single-hop _getCurveDirectQuote 1.5x guard.
    //
    // Implementation: find each shape's baseline output (the result whose hop
    // pools all match baselinePools[shapeKey]); reject siblings that beat it
    // by more than the ratio. If no baseline result exists for a shape (e.g.
    // its get_dy failed) we keep all siblings — defensive, lets rate-sanity
    // gate downstream pick up the slack.
    const baselineOutputByShape = new Map(); // shapeKey -> bigint
    for (const r of rawResults) {
      const key = shapeKey(r.hopResults);
      const baseline = baselinePools.get(key);
      if (!baseline) continue;
      const isBaselineVariant = r.hopResults.every(
        (hr, i) => hr.pool.address.toLowerCase() === baseline[i].address.toLowerCase(),
      );
      if (isBaselineVariant) baselineOutputByShape.set(key, BigInt(r.finalOutput));
    }
    const ratioNum = BigInt(Math.floor(MAX_ROUTER_VARIANT_OUTPUT_RATIO * 1000));
    const ratioDen = 1000n;
    const results = rawResults.filter(r => {
      const key = shapeKey(r.hopResults);
      const baseline = baselineOutputByShape.get(key);
      if (!baseline) return true; // no baseline known → keep
      const out = BigInt(r.finalOutput);
      return out * ratioDen <= baseline * ratioNum;
    });
    if (results.length === 0) return null;

    // Sort by output descending so the path most likely to be selected is checked first
    results.sort((a, b) => {
      const aOut = BigInt(a.finalOutput);
      const bOut = BigInt(b.finalOutput);
      return aOut > bOut ? -1 : aOut < bOut ? 1 : 0;
    });

    // Rate-sanity gate: walk top candidates and pick the first whose executed
    // rate is within MIN_RATE_RATIO_VS_SPOT of the spot rate. Without this,
    // BFS may select a path whose final hop traverses a pool with severely
    // skewed coin balances (e.g. $1 of scrvUSD in a $50k pool), where get_dy
    // returns the asymptotic ceiling instead of an honest swap rate. Falls
    // back to the highest-output path if all probes fail (defensive).
    let best = null;
    for (const r of results) {
      const legs = r.hopResults.map(hr => ({
        pool: hr.pool, fromToken: hr.from, toToken: hr.to,
      }));
      const sane = await this._isPathRateSane(legs, amountWei, r.finalOutput);
      if (sane) { best = r; break; }
    }
    if (!best) return null; // every candidate path is rate-broken; let other strategies try
    const outputFormatted = ethers.formatUnits(best.finalOutput, toDecimals);
    const inputFormatted = ethers.formatUnits(amountWei, fromDecimals);
    const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);

    // Build route array for display and tx building
    const route = best.hopResults.map(hr => ({
      pool: hr.pool.address,
      poolName: hr.pool.name,
      from: hr.from,
      to: hr.to,
      iFrom: hr.iFrom,
      iTo: hr.iTo,
      isCrypto: hr.isCrypto,
    }));

    // Build mid tokens array for tx encoding (and route visualization).
    // Resolve symbol/decimals from the hop's pool first — guaranteed to have the
    // answer for ANY token in the route, including niche tokens missing from
    // the seed/discovered intermediates list (e.g. sdYB, YB, USD3).
    const midTokens = [];
    for (let i = 0; i < best.hopResults.length - 1; i++) {
      const midAddr = best.hopResults[i].to;
      // Either the pool we just exited or the next pool we enter contains midAddr —
      // pass both so _resolveTokenInfo can pick whichever has the symbol.
      const exitPool = best.hopResults[i].pool;
      const enterPool = best.hopResults[i + 1].pool;
      midTokens.push(
        this._resolveTokenInfo(midAddr, exitPool).symbol !== '???'
          ? this._resolveTokenInfo(midAddr, exitPool)
          : this._resolveTokenInfo(midAddr, enterPool),
      );
    }

    // Real price impact via 1-unit simulation through the SAME chosen path.
    const spotHops = best.hopResults.map(hr => ({ pool: hr.pool, iFrom: hr.iFrom, iTo: hr.iTo }));
    const priceImpact = await this._computeBaselinePriceImpact(
      rate, spotHops,
      () => this._simulateSpotThroughHops(spotHops, fromDecimals, toDecimals),
    );

    return {
      source: 'curve-router',
      sourceName: `Curve Router (${best.numHops}-hop)`,
      fromToken,
      toToken,
      inputAmountWei: amountWei,
      outputAmountWei: best.finalOutput.toString(),
      outputAmount: outputFormatted,
      rate,
      priceImpact,
      gas: 200000 * best.numHops, // ~200k per hop
      route,
      _midTokens: midTokens,
      _midToken: midTokens[0] || null, // backward compat for 2-hop
      _midOutput: best.hopResults[0]?.outputWei,
      _hopResults: best.hopResults,
      _numHops: best.numHops,
    };
  }

  /**
   * Fallback 2-hop routing using dynamic intermediates list.
   * Used when graph-based BFS finds no paths (e.g., sparse graph).
   */
  async _getCurveRouterQuoteFallback(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const from = fromToken.toLowerCase();
    const to = toToken.toLowerCase();
    const intermediates = this._getIntermediates();

    const candidates = [];
    for (const mid of intermediates) {
      if (mid.address.toLowerCase() === from || mid.address.toLowerCase() === to) continue;
      const pool1 = this._findBestPool(fromToken, mid.address);
      const pool2 = this._findBestPool(mid.address, toToken);
      if (pool1 && pool2) {
        const minTvl = Math.min(pool1.tvl || 0, pool2.tvl || 0);
        candidates.push({ mid, pool1, pool2, minTvl });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by min TVL, take top candidates
    candidates.sort((a, b) => b.minTvl - a.minTvl);
    const top = candidates.slice(0, MAX_INTERMEDIATE_CANDIDATES);

    const quotePromises = top.map(async (c) => {
      try {
        const { iFrom: i1, iTo: j1, isCrypto: crypto1 } = this._getPoolIndices(c.pool1, fromToken, c.mid.address);
        const { iFrom: i2, iTo: j2, isCrypto: crypto2 } = this._getPoolIndices(c.pool2, c.mid.address, toToken);
        if (i1 === -1 || j1 === -1 || i2 === -1 || j2 === -1) return null;

        const midOutput = await this._getDy(c.pool1, i1, j1, amountWei);
        if (!midOutput || midOutput <= 0n) return null;

        const finalOutput = await this._getDy(c.pool2, i2, j2, midOutput.toString());
        if (!finalOutput || finalOutput <= 0n) return null;

        return { candidate: c, midOutput: midOutput.toString(), finalOutput: finalOutput.toString(),
          indices: { i1, j1, crypto1, i2, j2, crypto2 } };
      } catch { return null; }
    });

    const results = (await Promise.allSettled(quotePromises))
      .filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (results.length === 0) return null;

    results.sort((a, b) => {
      const aOut = BigInt(a.finalOutput); const bOut = BigInt(b.finalOutput);
      return aOut > bOut ? -1 : aOut < bOut ? 1 : 0;
    });

    const best = results[0];
    const outputFormatted = ethers.formatUnits(best.finalOutput, toDecimals);
    const inputFormatted = ethers.formatUnits(amountWei, fromDecimals);
    const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);

    // Real price impact via 1-unit simulation through the SAME 2-hop path.
    const spotHops = [
      { pool: best.candidate.pool1, iFrom: best.indices.i1, iTo: best.indices.j1 },
      { pool: best.candidate.pool2, iFrom: best.indices.i2, iTo: best.indices.j2 },
    ];
    const priceImpact = await this._computeBaselinePriceImpact(
      rate, spotHops,
      () => this._simulateSpotThroughHops(spotHops, fromDecimals, toDecimals),
    );

    return {
      source: 'curve-router',
      sourceName: 'Curve Router (2-hop)',
      fromToken, toToken,
      inputAmountWei: amountWei,
      outputAmountWei: best.finalOutput,
      outputAmount: outputFormatted,
      rate,
      priceImpact,
      gas: 350000,
      route: [
        { pool: best.candidate.pool1.address, poolName: best.candidate.pool1.name,
          from: fromToken, to: best.candidate.mid.address,
          iFrom: best.indices.i1, iTo: best.indices.j1, isCrypto: best.indices.crypto1 },
        { pool: best.candidate.pool2.address, poolName: best.candidate.pool2.name,
          from: best.candidate.mid.address, to: toToken,
          iFrom: best.indices.i2, iTo: best.indices.j2, isCrypto: best.indices.crypto2 },
      ],
      _midToken: best.candidate.mid,
      _midTokens: [best.candidate.mid],
      _midOutput: best.midOutput,
      _numHops: 2,
    };
  }

  // ============================================================
  // STRATEGY 3: CURVE SPLIT ROUTING (large swaps across pools)
  // ============================================================

  /**
   * Split a large swap across multiple Curve pools containing the same pair.
   * Reduces price impact by distributing volume. Only useful when 2+ pools exist.
   *
   * Optimization strategy (binary search for marginal equilibrium):
   * - For 2 pools: binary search the split where marginal output of pool0 = pool1 (8 iterations, 256x precision)
   * - For 3+ pools: TVL-proportional seed for pools 3+, binary search on top-2 pools' split
   * - Each iteration verified via on-chain get_dy for accurate output
   * - get_dy calls cached (5s TTL) to avoid duplicate RPC calls within same quote cycle
   * - Non-linear AMM curves mean optimal split != TVL proportion
   */
  async _getCurveSplitQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const pools = this._findAllPools(fromToken, toToken);
    // Split only makes sense with 2+ pools
    if (pools.length < 2) return null;

    // Cap at top 4 pools by TVL to limit RPC calls
    const topPools = pools.slice(0, 4);

    // Pre-compute pool indices (fail fast if indices are bad)
    const poolMeta = [];
    for (const pool of topPools) {
      const { iFrom, iTo, isCrypto } = this._getPoolIndices(pool, fromToken, toToken);
      if (iFrom === -1 || iTo === -1) continue;
      poolMeta.push({ pool, iFrom, iTo, isCrypto });
    }

    if (poolMeta.length < 2) return null;

    const totalAmount = BigInt(amountWei);

    // === Optimal split search ===
    if (poolMeta.length === 2) {
      // 2 pools: binary search for marginal-output equilibrium (O(log n))
      return this._binarySearch2Pools(poolMeta, totalAmount, fromToken, toToken, fromDecimals, toDecimals);
    } else {
      // 3+ pools: TVL seed + pairwise binary search optimization on top-2 pools
      return this._binarySearchNPools(poolMeta, totalAmount, fromToken, toToken, fromDecimals, toDecimals);
    }
  }

  /**
   * Binary search for 2-pool split: find the split point where marginal output
   * of pool0 equals marginal output of pool1 (optimal equilibrium).
   * O(8 iterations) = 256x precision vs O(5) grid steps.
   */
  async _binarySearch2Pools(poolMeta, totalAmount, fromToken, toToken, fromDecimals, toDecimals) {
    const [pm0, pm1] = poolMeta;

    let lo = totalAmount / 20n; // avoid 0% edge (min 5%)
    let hi = totalAmount - lo;  // max 95%
    const delta = totalAmount / 200n > 0n ? totalAmount / 200n : 1n; // 0.5% step for marginal calc

    for (let iter = 0; iter < 5; iter++) {
      const mid = (lo + hi) / 2n;
      const rest = totalAmount - mid;

      if (mid <= delta || rest <= delta) break; // avoid underflow

      try {
        // Compute marginal output: how much extra output for +delta input at current split
        const [out0_base, out0_plus, out1_base, out1_minus] = await Promise.all([
          this._getDy(pm0.pool, pm0.iFrom, pm0.iTo, mid.toString()),
          this._getDy(pm0.pool, pm0.iFrom, pm0.iTo, (mid + delta).toString()),
          this._getDy(pm1.pool, pm1.iFrom, pm1.iTo, rest.toString()),
          this._getDy(pm1.pool, pm1.iFrom, pm1.iTo, (rest - delta).toString()),
        ]);

        if (!out0_base || !out0_plus || !out1_base || !out1_minus) break;

        const marginal0 = out0_plus - out0_base; // marginal output of pool0
        const marginal1 = out1_base - out1_minus; // marginal output of pool1

        if (marginal0 > marginal1) {
          lo = mid; // pool0 still more efficient, shift more to pool0
        } else {
          hi = mid; // pool1 more efficient, shift more to pool1
        }
      } catch {
        break; // RPC error, use what we have
      }
    }

    // Final split at the converged midpoint
    const optimal0 = (lo + hi) / 2n;
    const optimal1 = totalAmount - optimal0;

    try {
      const [out0, out1] = await Promise.all([
        this._getDy(pm0.pool, pm0.iFrom, pm0.iTo, optimal0.toString()),
        this._getDy(pm1.pool, pm1.iFrom, pm1.iTo, optimal1.toString()),
      ]);

      if (!out0 || !out1 || out0 <= 0n || out1 <= 0n) return null;

      const total = out0 + out1;
      const outputFormatted = ethers.formatUnits(total, toDecimals);
      const inputFormatted = ethers.formatUnits(totalAmount, fromDecimals);
      const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);

      const chunkResults = [
        { pool: pm0.pool, chunkWei: optimal0.toString(), outputWei: out0.toString(),
          iFrom: pm0.iFrom, iTo: pm0.iTo, isCrypto: pm0.isCrypto },
        { pool: pm1.pool, chunkWei: optimal1.toString(), outputWei: out1.toString(),
          iFrom: pm1.iFrom, iTo: pm1.iTo, isCrypto: pm1.isCrypto },
      ];

      return this._buildSplitResult(chunkResults, totalAmount, fromToken, toToken, fromDecimals, toDecimals, rate);
    } catch {
      return null;
    }
  }

  /**
   * Binary search for 3+ pools: TVL-proportional baseline for pools 3+,
   * then binary search optimal split between top-2 pools (which get ~80%+ of volume).
   */
  async _binarySearchNPools(poolMeta, totalAmount, fromToken, toToken, fromDecimals, toDecimals) {
    // Step 1: TVL-proportional baseline
    const totalTvl = poolMeta.reduce((s, pm) => s + (pm.pool.tvl || 1), 0);
    const baseWeights = poolMeta.map(pm => (pm.pool.tvl || 1) / totalTvl);

    // Step 2: Get baseline quotes
    const baseChunks = baseWeights.map((w, i) => {
      const chunk = totalAmount * BigInt(Math.floor(w * 10000)) / 10000n;
      return { pm: poolMeta[i], chunk };
    });

    // Fix rounding
    const allocated = baseChunks.reduce((s, c) => s + c.chunk, 0n);
    if (allocated < totalAmount) baseChunks[0].chunk += (totalAmount - allocated);

    // Get baseline quotes in parallel
    const basePromises = baseChunks.map(async ({ pm, chunk }) => {
      if (chunk <= 0n) return null;
      try {
        const out = await this._getDy(pm.pool, pm.iFrom, pm.iTo, chunk.toString());
        if (!out || out <= 0n) return null;
        return { pool: pm.pool, chunkWei: chunk.toString(), outputWei: out.toString(),
          iFrom: pm.iFrom, iTo: pm.iTo, isCrypto: pm.isCrypto };
      } catch { return null; }
    });

    const baseResults = (await Promise.allSettled(basePromises))
      .filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    if (baseResults.length < 2) return null;

    // Step 3: Binary search optimal split between top-2 pools
    const top2Amount = BigInt(baseResults[0].chunkWei) + BigInt(baseResults[1].chunkWei);
    const restResults = baseResults.slice(2);
    const restTotal = restResults.reduce((s, c) => s + BigInt(c.outputWei), 0n);

    let lo = top2Amount / 20n; // min 5% to pool0
    let hi = top2Amount - lo;  // max 95% to pool0
    const delta = top2Amount / 200n > 0n ? top2Amount / 200n : 1n;

    for (let iter = 0; iter < 5; iter++) {
      const mid = (lo + hi) / 2n;
      const rest2 = top2Amount - mid;

      if (mid <= delta || rest2 <= delta) break;

      try {
        const [out0_base, out0_plus, out1_base, out1_minus] = await Promise.all([
          this._getDy(poolMeta[0].pool, poolMeta[0].iFrom, poolMeta[0].iTo, mid.toString()),
          this._getDy(poolMeta[0].pool, poolMeta[0].iFrom, poolMeta[0].iTo, (mid + delta).toString()),
          this._getDy(poolMeta[1].pool, poolMeta[1].iFrom, poolMeta[1].iTo, rest2.toString()),
          this._getDy(poolMeta[1].pool, poolMeta[1].iFrom, poolMeta[1].iTo, (rest2 - delta).toString()),
        ]);

        if (!out0_base || !out0_plus || !out1_base || !out1_minus) break;

        const marginal0 = out0_plus - out0_base;
        const marginal1 = out1_base - out1_minus;

        if (marginal0 > marginal1) lo = mid;
        else hi = mid;
      } catch {
        break;
      }
    }

    // Final split at converged midpoint
    const optimal0 = (lo + hi) / 2n;
    const optimal1 = top2Amount - optimal0;

    try {
      const [out0, out1] = await Promise.all([
        this._getDy(poolMeta[0].pool, poolMeta[0].iFrom, poolMeta[0].iTo, optimal0.toString()),
        this._getDy(poolMeta[1].pool, poolMeta[1].iFrom, poolMeta[1].iTo, optimal1.toString()),
      ]);

      if (!out0 || !out1 || out0 <= 0n || out1 <= 0n) {
        // Fallback to baseline
        const baseTotalOutput = baseResults.reduce((s, c) => s + BigInt(c.outputWei), 0n);
        const outputFmt = ethers.formatUnits(baseTotalOutput, toDecimals);
        const inputFmt = ethers.formatUnits(totalAmount, fromDecimals);
        return this._buildSplitResult(baseResults, totalAmount, fromToken, toToken, fromDecimals, toDecimals,
          parseFloat(outputFmt) / parseFloat(inputFmt));
      }

      const chunks = [
        { ...baseResults[0], chunkWei: optimal0.toString(), outputWei: out0.toString() },
        { ...baseResults[1], chunkWei: optimal1.toString(), outputWei: out1.toString() },
        ...restResults,
      ];
      const total = out0 + out1 + restTotal;

      // Also check baseline — use whichever is better
      const baseTotalOutput = baseResults.reduce((s, c) => s + BigInt(c.outputWei), 0n);
      const bestChunks = total > baseTotalOutput ? chunks : baseResults;
      const bestTotal = total > baseTotalOutput ? total : baseTotalOutput;

      const outputFormatted = ethers.formatUnits(bestTotal, toDecimals);
      const inputFormatted = ethers.formatUnits(totalAmount, fromDecimals);
      const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);

      return this._buildSplitResult(bestChunks, totalAmount, fromToken, toToken, fromDecimals, toDecimals, rate);
    } catch {
      // Fallback to baseline
      const baseTotalOutput = baseResults.reduce((s, c) => s + BigInt(c.outputWei), 0n);
      const outputFmt = ethers.formatUnits(baseTotalOutput, toDecimals);
      const inputFmt = ethers.formatUnits(totalAmount, fromDecimals);
      return this._buildSplitResult(baseResults, totalAmount, fromToken, toToken, fromDecimals, toDecimals,
        parseFloat(outputFmt) / parseFloat(inputFmt));
    }
  }

  /**
   * Build the final split quote result object.
   */
  async _buildSplitResult(chunkResults, totalAmount, fromToken, toToken, fromDecimals, toDecimals, rate) {
    const totalOutput = chunkResults.reduce((s, c) => s + BigInt(c.outputWei), 0n);

    const outputFormatted = ethers.formatUnits(totalOutput, toDecimals);

    // Real price impact: simulate 1-unit through the deepest pool used in this split.
    // The deepest pool's spot rate is the closest to "true mid-price" — using sum across
    // chunks for spot would overcount fees, so single-pool spot is the right reference.
    const deepestChunk = chunkResults.reduce((best, c) => {
      const tvl = (c.pool && c.pool.tvl) || 0;
      return tvl > ((best.pool && best.pool.tvl) || 0) ? c : best;
    }, chunkResults[0]);
    const priceImpact = await this._computeBaselinePriceImpact(
      rate,
      [{ pool: deepestChunk.pool, iFrom: deepestChunk.iFrom, iTo: deepestChunk.iTo }],
      () => this._simulateSpotThroughHops(
        [{ pool: deepestChunk.pool, iFrom: deepestChunk.iFrom, iTo: deepestChunk.iTo }],
        fromDecimals, toDecimals,
      ),
    );

    return {
      source: 'curve-split',
      sourceName: 'Curve Split',
      fromToken,
      toToken,
      inputAmountWei: totalAmount.toString(),
      outputAmountWei: totalOutput.toString(),
      outputAmount: outputFormatted,
      rate,
      priceImpact,
      gas: 180000 * chunkResults.length, // ~180k per pool swap
      route: chunkResults.map(c => ({
        pool: c.pool.address,
        poolName: c.pool.name,
        from: fromToken,
        to: toToken,
        iFrom: c.iFrom,
        iTo: c.iTo,
        isCrypto: c.isCrypto,
        chunkWei: c.chunkWei,
        outputWei: c.outputWei,
      })),
      _chunks: chunkResults,
    };
  }

  // ============================================================
  // STRATEGY 4: CURVE MULTI-PATH (split across different routes)
  // ============================================================

  /**
   * Find all 1-hop and 2-hop paths between two tokens using the multi-edge graph.
   * Returns array of path objects, each with legs [{pool, fromToken, toToken, tvl}].
   *
   * @param {string} fromToken - source token address (lowercase)
   * @param {string} toToken - destination token address (lowercase)
   * @returns {Array<{legs: Array, estimatedTvl: number}>}
   */
  _findAllMultiPaths(fromToken, toToken) {
    const graph = this._getTokenGraphMulti();
    const from = this._normalizeEthWeth(fromToken.toLowerCase());
    const to = this._normalizeEthWeth(toToken.toLowerCase());
    const paths = [];

    // 1-hop (direct) paths: all pools that have both tokens
    const directEdges = graph.get(from)?.get(to) || [];
    for (const edge of directEdges) {
      paths.push({
        legs: [{ pool: edge.pool, fromToken: from, toToken: to, tvl: edge.tvl }],
        estimatedTvl: edge.tvl,
      });
    }

    // 2-hop paths: from -> mid -> to (through all intermediates)
    const fromNeighbors = graph.get(from);
    if (fromNeighbors) {
      for (const [mid, leg1Edges] of fromNeighbors) {
        if (mid === from || mid === to) continue;
        const leg2Edges = graph.get(mid)?.get(to);
        if (!leg2Edges || leg2Edges.length === 0) continue;

        // For each combination of pools on leg1 and leg2 (cap at top 2 per leg)
        const topLeg1 = leg1Edges.slice(0, 2);
        const topLeg2 = leg2Edges.slice(0, 2);

        for (const e1 of topLeg1) {
          for (const e2 of topLeg2) {
            // Avoid using the same pool for both legs
            if (e1.pool.address === e2.pool.address) continue;
            const minTvl = Math.min(e1.tvl, e2.tvl);
            paths.push({
              legs: [
                { pool: e1.pool, fromToken: from, toToken: mid, tvl: e1.tvl },
                { pool: e2.pool, fromToken: mid, toToken: to, tvl: e2.tvl },
              ],
              estimatedTvl: minTvl,
            });
          }
        }
      }
    }

    // Sort by estimated TVL descending (deep liquidity first)
    paths.sort((a, b) => b.estimatedTvl - a.estimatedTvl);
    // Filter out paths with negligible TVL — can't handle meaningful volume
    return paths.filter(p => p.estimatedTvl >= 10000);
  }

  /**
   * Evaluate a single multi-path route: get_dy through all legs sequentially.
   * Returns final output in wei or null on failure.
   *
   * @param {Array} legs - [{pool, fromToken, toToken}]
   * @param {string} amountWei - input amount
   * @returns {Promise<{outputWei: string, hopResults: Array}|null>}
   */
  async _evaluatePath(legs, amountWei) {
    let currentAmount = amountWei;
    const hopResults = [];

    for (const leg of legs) {
      const { iFrom, iTo, isCrypto } = this._getPoolIndices(leg.pool, leg.fromToken, leg.toToken);
      if (iFrom === -1 || iTo === -1) return null;

      const outputWei = await this._getDy(leg.pool, iFrom, iTo, currentAmount);
      if (!outputWei || outputWei <= 0n) return null;

      hopResults.push({
        pool: leg.pool,
        fromToken: leg.fromToken,
        toToken: leg.toToken,
        iFrom, iTo, isCrypto,
        inputWei: currentAmount,
        outputWei: outputWei.toString(),
      });

      currentAmount = outputWei.toString();
    }

    return { outputWei: currentAmount, hopResults };
  }

  /**
   * Multi-path split routing: finds all 1-2 hop paths and optimizes volume split.
   *
   * Algorithm:
   * 1. Find ALL 1-2 hop paths using multi-edge graph
   * 2. Evaluate top candidates at full volume to rank by output
   * 3. Take top 6 paths, optimize split:
   *    - 2 paths: binary search (reuse _binarySearch2Pools pattern)
   *    - 3+ paths: TVL-proportional seed + pairwise binary search on top-2
   * 4. Return multi-path result with per-path breakdown
   */
  async _getCurveMultiPathQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const allPaths = this._findAllMultiPaths(fromToken, toToken);
    if (allPaths.length < 2) return null; // need at least 2 paths for split to be useful

    // Cap initial evaluation at top 10 paths by TVL
    const candidates = allPaths.slice(0, 10);

    // Evaluate each path at full volume (parallel, get_dy cached)
    const evalPromises = candidates.map(async (path) => {
      try {
        const result = await this._evaluatePath(path.legs, amountWei);
        if (!result) return null;
        return { ...path, output: BigInt(result.outputWei), hopResults: result.hopResults };
      } catch { return null; }
    });

    const evaluated = (await Promise.allSettled(evalPromises))
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (evaluated.length < 2) return null;

    // Sort by output descending, take top 6
    evaluated.sort((a, b) => a.output > b.output ? -1 : a.output < b.output ? 1 : 0);
    const topPaths = evaluated.slice(0, 6);

    const totalAmount = BigInt(amountWei);

    // Optimize split across paths
    let optimizedPaths;
    if (topPaths.length === 2) {
      optimizedPaths = await this._multiPathBinarySearch2(topPaths, totalAmount);
    } else {
      optimizedPaths = await this._multiPathBinarySearchN(topPaths, totalAmount);
    }

    if (!optimizedPaths || optimizedPaths.length === 0) return null;

    // Prune paths contributing < 1% of volume — gas cost outweighs benefit
    const minChunk = totalAmount / 100n; // 1%
    optimizedPaths = optimizedPaths.filter(p => BigInt(p.chunkWei) >= minChunk);
    if (optimizedPaths.length === 0) return null;

    // Re-distribute pruned volume to the best path
    const usedAmount = optimizedPaths.reduce((s, p) => s + BigInt(p.chunkWei), 0n);
    if (usedAmount < totalAmount && optimizedPaths.length > 0) {
      const diff = totalAmount - usedAmount;
      const best = optimizedPaths[0];
      try {
        const newResult = await this._evaluatePath(best.legs, (BigInt(best.chunkWei) + diff).toString());
        if (newResult) {
          best.chunkWei = (BigInt(best.chunkWei) + diff).toString();
          best.outputWei = newResult.outputWei;
        }
      } catch { /* keep existing allocation */ }
    }

    // Calculate total output
    const totalOutput = optimizedPaths.reduce((s, p) => s + BigInt(p.outputWei), 0n);
    if (totalOutput <= 0n) return null;

    const outputFormatted = ethers.formatUnits(totalOutput, toDecimals);
    const inputFormatted = ethers.formatUnits(amountWei, fromDecimals);
    const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);

    // Gas estimate: 180k per hop × number of paths
    const totalGas = optimizedPaths.reduce((s, p) => s + (p.legs.length * 180000), 0);

    // Build route array for display
    const route = optimizedPaths.map(p => {
      const pct = Number(BigInt(p.chunkWei) * 10000n / totalAmount) / 100;
      return {
        pool: p.legs[0].pool.address,
        poolName: p.legs.map(l => l.pool.name).join(' -> '),
        chunkWei: p.chunkWei,
        outputWei: p.outputWei,
        pct,
        legs: p.legs.map(l => ({
          pool: l.pool.address,
          poolName: l.pool.name,
          from: l.fromToken,
          to: l.toToken,
        })),
        _midTokens: p.legs.length > 1 ? p.legs.slice(0, -1).map((l, idx) => {
          // Pass the exit pool so we can resolve symbols even for niche tokens
          // not in seed/discovered intermediates.
          return this._resolveTokenInfo(l.toToken, l.pool);
        }) : [],
      };
    });

    // Real price impact: simulate 1-unit through the BEST (highest-output) path.
    // optimizedPaths is ordered with best first (after sort by output, then prune).
    const bestPath = optimizedPaths[0];
    const spotHops = bestPath.legs.map(leg => {
      const idx = this._getPoolIndices(leg.pool, leg.fromToken, leg.toToken);
      return { pool: leg.pool, iFrom: idx.iFrom, iTo: idx.iTo };
    });
    const priceImpact = await this._computeBaselinePriceImpact(
      rate, spotHops,
      () => this._simulateSpotThroughHops(spotHops, fromDecimals, toDecimals),
    );

    return {
      source: 'curve-multi-path',
      sourceName: `Curve Multi-Path (${optimizedPaths.length} paths)`,
      fromToken,
      toToken,
      inputAmountWei: amountWei,
      outputAmountWei: totalOutput.toString(),
      outputAmount: outputFormatted,
      rate,
      priceImpact,
      gas: totalGas,
      route,
      _paths: optimizedPaths,
    };
  }

  /**
   * Binary search optimal split for 2 multi-paths.
   * Similar to _binarySearch2Pools but works with multi-hop paths.
   */
  async _multiPathBinarySearch2(paths, totalAmount) {
    const [p0, p1] = paths;

    let lo = totalAmount / 20n; // min 5%
    let hi = totalAmount - lo;  // max 95%
    const delta = totalAmount / 200n > 0n ? totalAmount / 200n : 1n;

    for (let iter = 0; iter < 5; iter++) {
      const mid = (lo + hi) / 2n;
      const rest = totalAmount - mid;
      if (mid <= delta || rest <= delta) break;

      try {
        const [r0_base, r0_plus, r1_base, r1_minus] = await Promise.all([
          this._evaluatePath(p0.legs, mid.toString()),
          this._evaluatePath(p0.legs, (mid + delta).toString()),
          this._evaluatePath(p1.legs, rest.toString()),
          this._evaluatePath(p1.legs, (rest - delta).toString()),
        ]);

        if (!r0_base || !r0_plus || !r1_base || !r1_minus) break;

        const marginal0 = BigInt(r0_plus.outputWei) - BigInt(r0_base.outputWei);
        const marginal1 = BigInt(r1_base.outputWei) - BigInt(r1_minus.outputWei);

        if (marginal0 > marginal1) lo = mid;
        else hi = mid;
      } catch { break; }
    }

    const optimal0 = (lo + hi) / 2n;
    const optimal1 = totalAmount - optimal0;

    try {
      const [r0, r1] = await Promise.all([
        this._evaluatePath(p0.legs, optimal0.toString()),
        this._evaluatePath(p1.legs, optimal1.toString()),
      ]);

      if (!r0 || !r1) return null;

      return [
        { legs: p0.legs, chunkWei: optimal0.toString(), outputWei: r0.outputWei },
        { legs: p1.legs, chunkWei: optimal1.toString(), outputWei: r1.outputWei },
      ];
    } catch { return null; }
  }

  /**
   * Optimize split for 3+ multi-paths: TVL-proportional seed + iterative marginal equalization.
   * Equalizes marginal output across ALL paths (not just top-2) for global optimum.
   */
  async _multiPathBinarySearchN(paths, totalAmount) {
    // Step 1: TVL-proportional seed
    const totalTvl = paths.reduce((s, p) => s + (p.estimatedTvl || 1), 0);
    const weights = paths.map(p => (p.estimatedTvl || 1) / totalTvl);
    const chunks = weights.map(w => totalAmount * BigInt(Math.floor(w * 10000)) / 10000n);

    // Fix rounding
    const allocated = chunks.reduce((s, c) => s + c, 0n);
    if (allocated < totalAmount) chunks[0] += (totalAmount - allocated);

    // Step 2: Get baseline outputs
    const basePromises = paths.map(async (p, i) => {
      if (chunks[i] <= 0n) return null;
      try {
        const result = await this._evaluatePath(p.legs, chunks[i].toString());
        if (!result) return null;
        return { legs: p.legs, chunkWei: chunks[i], outputWei: BigInt(result.outputWei), estimatedTvl: p.estimatedTvl };
      } catch { return null; }
    });

    let results = (await Promise.allSettled(basePromises))
      .filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

    if (results.length < 2) return null;

    const delta = totalAmount / 200n > 0n ? totalAmount / 200n : 1n; // 0.5% of total
    const minChunk = totalAmount / 100n; // 1% minimum per path

    // Step 3: Iterative marginal equalization across ALL paths
    for (let iter = 0; iter < 5; iter++) {
      // Compute marginal output for each path
      const marginals = await Promise.all(results.map(async (r) => {
        try {
          const rPlus = await this._evaluatePath(r.legs, (r.chunkWei + delta).toString());
          if (!rPlus) return null;
          return BigInt(rPlus.outputWei) - r.outputWei;
        } catch { return null; }
      }));

      // Find pathMax (highest marginal) and pathMin (lowest marginal)
      let pathMaxIdx = -1, pathMinIdx = -1;
      let maxMarginal = -1n, minMarginal = null;

      for (let i = 0; i < results.length; i++) {
        if (marginals[i] === null) continue;
        if (marginals[i] > maxMarginal) { maxMarginal = marginals[i]; pathMaxIdx = i; }
        if (minMarginal === null || marginals[i] < minMarginal) { minMarginal = marginals[i]; pathMinIdx = i; }
      }

      if (pathMaxIdx === -1 || pathMinIdx === -1 || pathMaxIdx === pathMinIdx) break;

      // Check convergence: marginals are close enough
      if (maxMarginal - minMarginal < delta / 10n) break;

      // Transfer volume from pathMin to pathMax
      const pathMinChunk = results[pathMinIdx].chunkWei;
      let transferAmount = pathMinChunk / 10n; // 10% of pathMin's chunk
      const maxTransfer = totalAmount / 20n; // cap at 5% of total
      if (transferAmount > maxTransfer) transferAmount = maxTransfer;
      if (transferAmount <= 0n) break;

      // Check if pathMin would fall below minimum
      if (pathMinChunk - transferAmount < minChunk) {
        // Prune pathMin: give all its volume to pathMax
        transferAmount = pathMinChunk;
      }

      const newChunkMax = results[pathMaxIdx].chunkWei + transferAmount;
      const newChunkMin = pathMinChunk - transferAmount;

      try {
        const rMax = await this._evaluatePath(results[pathMaxIdx].legs, newChunkMax.toString());
        if (!rMax) break;

        results[pathMaxIdx] = { ...results[pathMaxIdx], chunkWei: newChunkMax, outputWei: BigInt(rMax.outputWei) };

        if (newChunkMin >= minChunk) {
          const rMin = await this._evaluatePath(results[pathMinIdx].legs, newChunkMin.toString());
          if (!rMin) break;
          results[pathMinIdx] = { ...results[pathMinIdx], chunkWei: newChunkMin, outputWei: BigInt(rMin.outputWei) };
        } else {
          // Remove pruned path
          results.splice(pathMinIdx, 1);
        }
      } catch { break; }
    }

    if (results.length === 0) return null;

    // Convert back to string format for compatibility
    return results.map(r => ({
      legs: r.legs,
      chunkWei: r.chunkWei.toString(),
      outputWei: r.outputWei.toString(),
    }));
  }

  /**
   * Build transactions for multi-path execution (one tx per path).
   *   - 1-hop path → direct pool.exchange call (stable: int128, crypto: uint256).
   *   - multi-hop path on mainnet → delegated to curve-js populateSwap (single
   *     Router NG tx for that chunk).
   *   - multi-hop path on non-mainnet → throw; we only run multi-path on
   *     mainnet (it's the only chain whose pool universe needs split-routing
   *     volume).
   *
   * Async: multi-hop chunks require awaiting curve-js. We build each chunk
   * sequentially to keep curve-js's internal route cache consistent.
   */
  async _buildCurveMultiPathTx(quote, userAddress) {
    const isETH = quote.fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const totalMinOutput = BigInt(quote.minOutputWei);
    const totalOutput = BigInt(quote.outputAmountWei);

    const txs = [];
    for (const pathRoute of quote.route) {
      const pathOutput = BigInt(pathRoute.outputWei);
      // Proportional min_dy
      const pathMinDy = totalOutput > 0n ? (totalMinOutput * pathOutput / totalOutput) : 0n;

      if (pathRoute.legs.length === 1) {
        // Direct pool swap
        const leg = pathRoute.legs[0];
        const pool = this._pools.find(p => p.address.toLowerCase() === leg.pool.toLowerCase());
        if (!pool) continue;
        const { iFrom, iTo, isCrypto } = this._getPoolIndices(pool, leg.from, leg.to);

        let iface, data;
        if (isCrypto) {
          iface = new ethers.Interface(['function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)']);
          data = iface.encodeFunctionData('exchange', [iFrom, iTo, pathRoute.chunkWei, pathMinDy.toString()]);
        } else {
          iface = new ethers.Interface(['function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) payable returns (uint256)']);
          data = iface.encodeFunctionData('exchange', [iFrom, iTo, pathRoute.chunkWei, pathMinDy.toString()]);
        }

        txs.push({
          to: leg.pool,
          data,
          value: isETH ? BigInt(pathRoute.chunkWei) : 0n,
          // gasLimit injected at dispatch time via window.estimateGasWithBuffer
          _spender: leg.pool,
        });
      } else {
        // Multi-hop chunk: delegate to curve-js. Only supported on mainnet.
        if (this._chainId !== 1) {
          throw new Error(`Multi-path multi-hop chunk: chainId=${this._chainId} not supported (mainnet curve-js only)`);
        }
        const chunkQuote = {
          source: 'curve-router',
          fromToken: quote.fromToken,
          toToken: quote.toToken,
          fromDecimals: quote.fromDecimals,
          toDecimals: quote.toDecimals,
          inputAmountWei: pathRoute.chunkWei.toString(),
          outputAmountWei: pathOutput.toString(),
          minOutputWei: pathMinDy.toString(),
        };
        const chunkTx = await this._buildMainnetCurveJsTx(chunkQuote, userAddress);
        // value comes from curve-js (handles ETH internally); _spender too.
        txs.push(chunkTx);
      }
    }

    if (txs.length === 0) throw new Error('Failed to build multi-path transactions');

    return {
      multiTx: true,
      txs,
      _spenders: [...new Set(txs.map(t => t._spender))],
    };
  }

  // ============================================================
  // STRATEGY 5: CURVE GRAPH-SPLIT (DAG-based split with shared intermediates)
  // ============================================================

  /**
   * Graph-based split routing: builds a weighted DAG of ALL pools, finds top-K
   * shortest paths using Yen's algorithm, then optimizes volume allocation.
   * Unlike multi-path, this allows shared intermediate nodes — volume can merge
   * and split at any point in the graph (like ODOS/1inch).
   *
   * Key difference from curve-multi-path:
   * - Multi-path: independent paths, volume split only at source
   * - Graph-split: DAG with shared nodes, volume can split/merge at intermediates
   *
   * @param {string} fromToken - source token (address)
   * @param {string} toToken - destination token (address)
   * @param {string} amountWei - input amount in wei
   * @param {number} fromDecimals - source token decimals
   * @param {number} toDecimals - destination token decimals
   * @returns {Promise<QuoteResult|null>}
   */
  async _getCurveGraphSplitQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const graph = this._getTokenGraphMulti();
    const from = this._normalizeEthWeth(fromToken.toLowerCase());
    const to = this._normalizeEthWeth(toToken.toLowerCase());

    // Step 1: Find top-K shortest paths using modified Yen's algorithm
    // "Shortest" = best estimated output (highest, not lowest distance)
    // K=5: balances coverage vs evaluation cost. With max-4-hop paths each,
    // probing 5 paths × 4 hops × 2 dy calls (incl. PI) ≈ 40 RPC calls; doubling
    // to K=8 pushed total wall-clock past the 8s strategy timeout when paths
    // are long. 5 still gives the optimizer enough diversity to find good splits.
    const kPaths = this._yenKShortestPaths(graph, from, to, 5);
    if (kPaths.length < 2) return null; // need 2+ paths for graph-split to add value

    // Step 2: Evaluate each path at probe volume (1/K of total) to determine viability
    // Full-volume eval causes small pools to revert get_dy, hiding valid split paths
    const probeAmount = (BigInt(amountWei) / BigInt(Math.max(kPaths.length, 4))).toString();
    const evalPromises = kPaths.map(async (kPath) => {
      try {
        const result = await this._evaluatePath(kPath.legs, probeAmount);
        if (!result) return null;
        // Scale output proportionally to estimate full-volume (for initial ranking only)
        const scaledOutput = BigInt(result.outputWei) * BigInt(Math.max(kPaths.length, 4));
        return { ...kPath, output: scaledOutput, hopResults: result.hopResults, probeOutput: BigInt(result.outputWei) };
      } catch { return null; }
    });

    const evaluated = (await Promise.allSettled(evalPromises))
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

    if (evaluated.length < 2) return null;

    // Sort by output descending, take top 4. With max-4-hop paths now allowed,
    // each evaluation costs ~4 dy() calls × ~80ms = 320ms; capping at 4 paths
    // keeps the optimization phase (binary search × paths × hops) within the
    // 8s strategy timeout. Original cap of 6 timed out for sdYB→scrvUSD.
    evaluated.sort((a, b) => a.output > b.output ? -1 : a.output < b.output ? 1 : 0);
    const topPaths = evaluated.slice(0, 4);

    const totalAmount = BigInt(amountWei);

    // Step 3: Build DAG — identify shared intermediate nodes
    const dag = this._buildSplitDAG(topPaths, from, to);

    // Step 4: Optimize allocation using iterative marginal equalization
    // This is similar to _multiPathBinarySearchN but DAG-aware:
    // paths sharing an intermediate node's capacity are jointly constrained
    let optimizedPaths;
    if (topPaths.length === 2) {
      optimizedPaths = await this._multiPathBinarySearch2(topPaths, totalAmount);
    } else {
      optimizedPaths = await this._graphSplitOptimize(topPaths, totalAmount, dag);
    }

    if (!optimizedPaths || optimizedPaths.length === 0) return null;

    // NOTE (iter#1.1, 2026-05-26): the previous duplicate-(pool,fromToken,toToken)
    // leg filter (commit 113b65974) overshot — it blocked legitimate split
    // patterns and produced 6 OUR_REVERT + 10 TIE→LOSS regressions in the full
    // bench. The real bug — per-leg get_dy on static pool state overstating
    // output when multiple legs/paths execute against the same pool in one tx —
    // is now caught by an output-ratio sanity check in getQuote aggregator
    // (see ~line 690): graph-split candidates that claim >2% better than the
    // best non-graph-split curve-* strategy are dropped as untrustworthy.

    // Prune paths < 1%
    const minChunk = totalAmount / 100n;
    optimizedPaths = optimizedPaths.filter(p => BigInt(p.chunkWei) >= minChunk);
    if (optimizedPaths.length === 0) return null;

    // Re-distribute pruned volume to best path
    const usedAmount = optimizedPaths.reduce((s, p) => s + BigInt(p.chunkWei), 0n);
    if (usedAmount < totalAmount && optimizedPaths.length > 0) {
      const diff = totalAmount - usedAmount;
      const best = optimizedPaths[0];
      try {
        const newResult = await this._evaluatePath(best.legs, (BigInt(best.chunkWei) + diff).toString());
        if (newResult) {
          best.chunkWei = (BigInt(best.chunkWei) + diff).toString();
          best.outputWei = newResult.outputWei;
        }
      } catch { /* keep existing */ }
    }

    // Calculate total output
    const totalOutput = optimizedPaths.reduce((s, p) => s + BigInt(p.outputWei), 0n);
    if (totalOutput <= 0n) return null;

    const outputFormatted = ethers.formatUnits(totalOutput, toDecimals);
    const inputFormatted = ethers.formatUnits(amountWei, fromDecimals);
    const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);

    // Gas: 180k per hop per path
    const totalGas = optimizedPaths.reduce((s, p) => s + (p.legs.length * 180000), 0);

    // Build route array
    const route = optimizedPaths.map(p => {
      const pct = Number(BigInt(p.chunkWei) * 10000n / totalAmount) / 100;
      return {
        pool: p.legs[0].pool.address,
        poolName: p.legs.map(l => l.pool.name).join(' -> '),
        chunkWei: p.chunkWei,
        outputWei: p.outputWei,
        pct,
        legs: p.legs.map(l => ({
          pool: l.pool.address,
          poolName: l.pool.name,
          from: l.fromToken,
          to: l.toToken,
        })),
        _midTokens: p.legs.length > 1 ? p.legs.slice(0, -1).map(l => {
          return this._resolveTokenInfo(l.toToken, l.pool);
        }) : [],
      };
    });

    // Real price impact: simulate 1-unit through the best (highest-output) path.
    const bestPath = optimizedPaths[0];
    const spotHops = bestPath.legs.map(leg => {
      const idx = this._getPoolIndices(leg.pool, leg.fromToken, leg.toToken);
      return { pool: leg.pool, iFrom: idx.iFrom, iTo: idx.iTo };
    });
    const priceImpact = await this._computeBaselinePriceImpact(
      rate, spotHops,
      () => this._simulateSpotThroughHops(spotHops, fromDecimals, toDecimals),
    );

    return {
      source: 'curve-graph-split',
      sourceName: `Curve Graph-Split (${optimizedPaths.length} paths, ${dag.sharedNodes} shared)`,
      fromToken,
      toToken,
      inputAmountWei: amountWei,
      outputAmountWei: totalOutput.toString(),
      outputAmount: outputFormatted,
      rate,
      priceImpact,
      gas: totalGas,
      route,
      _paths: optimizedPaths,
      _dag: dag,
    };
  }

  /**
   * Yen's K-shortest paths algorithm adapted for token graph.
   * Instead of distance, we use estimated TVL as proxy for path quality.
   * Returns up to K paths from source to destination.
   *
   * @param {Map} graph - token graph (Map<addr, Map<addr, [{pool, tvl}]>>)
   * @param {string} source - source token address
   * @param {string} target - target token address
   * @param {number} K - max number of paths to find
   * @returns {Array<{legs: Array, estimatedTvl: number}>}
   */
  _yenKShortestPaths(graph, source, target, K = 8) {
    // BFS-based shortest path with TVL scoring
    const _bfsPath = (g, src, tgt, excludeEdges, excludeNodes) => {
      if (src === tgt) return null;
      const visited = new Set(excludeNodes || []);
      visited.add(src);
      const queue = [[src, []]]; // [currentNode, legs so far]

      while (queue.length > 0) {
        const [current, legs] = queue.shift();
        // 4 hops: needed when the most-direct edge between two assets requires
        // a non-dust deep-liquidity intermediate (e.g. crvUSD → DOLA → scrvUSD
        // when the only direct crvUSD↔scrvUSD pool is sub-threshold TVL).
        if (legs.length >= 4) continue;

        const neighbors = g.get(current);
        if (!neighbors) continue;

        for (const [neighbor, edges] of neighbors) {
          if (visited.has(neighbor)) continue;

          // Find best non-excluded edge
          let bestEdge = null;
          for (const edge of edges) {
            const edgeKey = current + ':' + neighbor + ':' + edge.pool.address;
            if (excludeEdges && excludeEdges.has(edgeKey)) continue;
            if (!bestEdge || edge.tvl > bestEdge.tvl) bestEdge = edge;
          }
          if (!bestEdge) continue;

          const newLegs = [...legs, {
            pool: bestEdge.pool,
            fromToken: current,
            toToken: neighbor,
            tvl: bestEdge.tvl,
          }];

          if (neighbor === tgt) {
            const minTvl = Math.min(...newLegs.map(l => l.tvl));
            return { legs: newLegs, estimatedTvl: minTvl };
          }

          visited.add(neighbor);
          queue.push([neighbor, newLegs]);
        }
      }
      return null;
    };

    // Find initial shortest path
    const A = []; // confirmed K-shortest paths
    const B = []; // candidate paths (priority queue by TVL desc)
    const pathHashes = new Set();

    const hashPath = (p) => p.legs.map(l => l.pool.address + ':' + l.fromToken + ':' + l.toToken).join('|');

    const first = _bfsPath(graph, source, target, null, null);
    if (!first) return [];
    A.push(first);
    pathHashes.add(hashPath(first));

    for (let k = 1; k < K; k++) {
      const prevPath = A[A.length - 1];

      for (let i = 0; i < prevPath.legs.length; i++) {
        const spurNode = i === 0 ? source : prevPath.legs[i - 1].toToken;
        const rootLegs = prevPath.legs.slice(0, i);

        // Exclude edges from root part of previously found paths
        const excludeEdges = new Set();
        for (const aPath of A) {
          if (aPath.legs.length > i) {
            const matchesRoot = rootLegs.every((leg, j) =>
              aPath.legs[j] && leg.pool.address === aPath.legs[j].pool.address &&
              leg.fromToken === aPath.legs[j].fromToken && leg.toToken === aPath.legs[j].toToken
            );
            if (matchesRoot || i === 0) {
              const edgeLeg = aPath.legs[i];
              if (edgeLeg) {
                excludeEdges.add(edgeLeg.fromToken + ':' + edgeLeg.toToken + ':' + edgeLeg.pool.address);
              }
            }
          }
        }

        // Exclude intermediate nodes from root path (avoid loops)
        const excludeNodes = new Set();
        for (let j = 0; j < i; j++) {
          if (j === 0) excludeNodes.add(source); // handled by visited
          excludeNodes.add(rootLegs[j]?.toToken);
        }
        excludeNodes.delete(spurNode);
        excludeNodes.delete(target);

        const spurPath = _bfsPath(graph, spurNode, target, excludeEdges, excludeNodes);
        if (!spurPath) continue;

        const totalPath = {
          legs: [...rootLegs, ...spurPath.legs],
          estimatedTvl: Math.min(
            ...rootLegs.map(l => l.tvl).concat(spurPath.legs.map(l => l.tvl)),
            spurPath.estimatedTvl
          ),
        };

        const h = hashPath(totalPath);
        if (!pathHashes.has(h)) {
          pathHashes.add(h);
          B.push(totalPath);
        }
      }

      if (B.length === 0) break;

      // Sort by TVL descending (best first)
      B.sort((a, b) => b.estimatedTvl - a.estimatedTvl);
      A.push(B.shift());
    }

    return A;
  }

  /**
   * Build a split DAG: analyze which intermediate nodes are shared across paths.
   * Returns metadata about the DAG structure for optimization constraints.
   *
   * @param {Array} paths - evaluated paths with legs
   * @param {string} source - source token
   * @param {string} target - target token
   * @returns {Object} DAG metadata
   */
  _buildSplitDAG(paths, source, target) {
    const nodeUsage = new Map(); // token -> Set of path indices that use it

    paths.forEach((path, pathIdx) => {
      for (const leg of path.legs) {
        const from = leg.fromToken.toLowerCase();
        const to = leg.toToken.toLowerCase();
        if (!nodeUsage.has(from)) nodeUsage.set(from, new Set());
        if (!nodeUsage.has(to)) nodeUsage.set(to, new Set());
        nodeUsage.get(from).add(pathIdx);
        nodeUsage.get(to).add(pathIdx);
      }
    });

    // Shared nodes = tokens used by 2+ paths (excluding source/target)
    const sharedNodes = [];
    for (const [token, pathSet] of nodeUsage) {
      if (token === source.toLowerCase() || token === target.toLowerCase()) continue;
      if (pathSet.size >= 2) {
        sharedNodes.push({ token, paths: [...pathSet] });
      }
    }

    // Pool usage: which pools appear in multiple paths
    const poolUsage = new Map();
    paths.forEach((path, pathIdx) => {
      for (const leg of path.legs) {
        const addr = leg.pool.address.toLowerCase();
        if (!poolUsage.has(addr)) poolUsage.set(addr, new Set());
        poolUsage.get(addr).add(pathIdx);
      }
    });

    const sharedPools = [];
    for (const [pool, pathSet] of poolUsage) {
      if (pathSet.size >= 2) sharedPools.push({ pool, paths: [...pathSet] });
    }

    return {
      sharedNodes: sharedNodes.length,
      sharedPools: sharedPools.length,
      nodes: sharedNodes,
      pools: sharedPools,
      totalPaths: paths.length,
    };
  }

  /**
   * DAG-aware volume optimization for graph-split routing.
   * Extends _multiPathBinarySearchN with awareness of shared intermediates:
   * paths sharing a pool get penalized when they would collectively exceed
   * the pool's optimal capacity.
   *
   * @param {Array} paths - top paths with legs/output
   * @param {bigint} totalAmount - total input amount
   * @param {Object} dag - DAG metadata from _buildSplitDAG
   * @returns {Promise<Array|null>} optimized path allocations
   */
  async _graphSplitOptimize(paths, totalAmount, dag) {
    // TVL-proportional seed
    const totalTvl = paths.reduce((s, p) => s + (p.estimatedTvl || 1), 0);
    const weights = paths.map(p => (p.estimatedTvl || 1) / totalTvl);
    const chunks = weights.map(w => totalAmount * BigInt(Math.floor(w * 10000)) / 10000n);

    // Fix rounding
    const allocated = chunks.reduce((s, c) => s + c, 0n);
    if (allocated < totalAmount) chunks[0] += (totalAmount - allocated);

    // Evaluate baseline
    const basePromises = paths.map(async (p, i) => {
      if (chunks[i] <= 0n) return null;
      try {
        const result = await this._evaluatePath(p.legs, chunks[i].toString());
        if (!result) return null;
        return { legs: p.legs, chunkWei: chunks[i], outputWei: BigInt(result.outputWei), estimatedTvl: p.estimatedTvl };
      } catch { return null; }
    });

    let results = (await Promise.allSettled(basePromises))
      .filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);

    if (results.length < 2) return null;

    const delta = totalAmount / 200n > 0n ? totalAmount / 200n : 1n;
    const minChunk = totalAmount / 100n;

    // Build shared pool impact map: for each path index, how much "shared pool penalty" it has
    const sharedPoolPaths = new Map(); // pathIdx -> number of shared pools
    if (dag.pools) {
      for (const sp of dag.pools) {
        for (const pathIdx of sp.paths) {
          sharedPoolPaths.set(pathIdx, (sharedPoolPaths.get(pathIdx) || 0) + 1);
        }
      }
    }

    // Iterative marginal equalization with shared-pool awareness
    for (let iter = 0; iter < 6; iter++) {
      const marginals = await Promise.all(results.map(async (r, i) => {
        try {
          const rPlus = await this._evaluatePath(r.legs, (r.chunkWei + delta).toString());
          if (!rPlus) return null;
          let marginal = BigInt(rPlus.outputWei) - r.outputWei;

          // Apply shared-pool penalty: if this path shares pools with others,
          // its marginal benefit is slightly reduced (shared liquidity = more impact)
          const sharedCount = sharedPoolPaths.get(i) || 0;
          if (sharedCount > 0) {
            // Reduce marginal by 5% per shared pool (heuristic)
            const penalty = BigInt(Math.floor(Number(marginal) * sharedCount * 0.05));
            marginal = marginal > penalty ? marginal - penalty : 0n;
          }

          return marginal;
        } catch { return null; }
      }));

      let pathMaxIdx = -1, pathMinIdx = -1;
      let maxMarginal = -1n, minMarginal = null;

      for (let i = 0; i < results.length; i++) {
        if (marginals[i] === null) continue;
        if (marginals[i] > maxMarginal) { maxMarginal = marginals[i]; pathMaxIdx = i; }
        if (minMarginal === null || marginals[i] < minMarginal) { minMarginal = marginals[i]; pathMinIdx = i; }
      }

      if (pathMaxIdx === -1 || pathMinIdx === -1 || pathMaxIdx === pathMinIdx) break;
      if (maxMarginal - minMarginal < delta / 10n) break;

      const pathMinChunk = results[pathMinIdx].chunkWei;
      let transferAmount = pathMinChunk / 10n;
      const maxTransfer = totalAmount / 20n;
      if (transferAmount > maxTransfer) transferAmount = maxTransfer;
      if (transferAmount <= 0n) break;

      if (pathMinChunk - transferAmount < minChunk) {
        transferAmount = pathMinChunk;
      }

      const newChunkMax = results[pathMaxIdx].chunkWei + transferAmount;
      const newChunkMin = pathMinChunk - transferAmount;

      try {
        const rMax = await this._evaluatePath(results[pathMaxIdx].legs, newChunkMax.toString());
        if (!rMax) break;
        results[pathMaxIdx] = { ...results[pathMaxIdx], chunkWei: newChunkMax, outputWei: BigInt(rMax.outputWei) };

        if (newChunkMin >= minChunk) {
          const rMin = await this._evaluatePath(results[pathMinIdx].legs, newChunkMin.toString());
          if (!rMin) break;
          results[pathMinIdx] = { ...results[pathMinIdx], chunkWei: newChunkMin, outputWei: BigInt(rMin.outputWei) };
        } else {
          results.splice(pathMinIdx, 1);
        }
      } catch { break; }
    }

    if (results.length === 0) return null;

    return results.map(r => ({
      legs: r.legs,
      chunkWei: r.chunkWei.toString(),
      outputWei: r.outputWei.toString(),
    }));
  }

  /**
   * Build transactions for graph-split execution.
   * Reuses the same pattern as multi-path: 1-hop = direct, 2+ hop = Router NG.
   */
  _buildCurveGraphSplitTx(quote, userAddress) {
    // Same TX structure as multi-path — shared pools don't change the on-chain execution
    // (each path is still executed independently, shared nodes just appear in graph planning)
    return this._buildCurveMultiPathTx(quote, userAddress);
  }

  // ============================================================
  // BUILD SWAP TRANSACTIONS
  // ============================================================

  /**
   * Build tx for a direct Curve pool swap.
   */
  _buildCurveDirectTx(quote, userAddress) {
    const hop = quote.route[0];
    const isETH = quote.fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const isCrypto = hop.isCrypto;
    const isUnderlying = !!hop.isUnderlying;

    // Selector: exchange or exchange_underlying, with int128/uint256 index
    // depending on pool type (stable vs crypto/twocrypto/tricrypto).
    const fnName = isUnderlying ? 'exchange_underlying' : 'exchange';
    let iface, data;
    if (isCrypto) {
      iface = new ethers.Interface([
        `function ${fnName}(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)`,
      ]);
      data = iface.encodeFunctionData(fnName, [
        hop.iFrom, hop.iTo, quote.inputAmountWei, quote.minOutputWei,
      ]);
    } else {
      iface = new ethers.Interface([
        `function ${fnName}(int128 i, int128 j, uint256 dx, uint256 min_dy) payable returns (uint256)`,
      ]);
      data = iface.encodeFunctionData(fnName, [
        hop.iFrom, hop.iTo, quote.inputAmountWei, quote.minOutputWei,
      ]);
    }

    return {
      to: hop.pool,
      data,
      value: isETH ? BigInt(quote.inputAmountWei) : 0n,
      // gasLimit injected at dispatch time via window.estimateGasWithBuffer
      // (Михаил 2026-05-24 msg 7092 hard rule: never hardcode, always estimate × 1.5).
      // Prior hardcode chronicle, kept here for reviewer context:
      //   isUnderlying ? 450000 : (isCrypto ? 500000 : 250000)
      //   — incident 2026-05-24 Михаил tx 0xba83db60... OOG at 249697/250000.
      _spender: hop.pool,
    };
  }

  /**
   * Build tx for a zap-metapool swap. Single call to
   *   zap.exchange_underlying(uint256 i, uint256 j, uint256 dx, uint256 min_dy)
   * Vyper selector 0x65b2489b. Underlying indexing: 0 = metaCoin,
   * 1+k = baseCoins[k] (so on the EURe zap: 0=EURe, 1=WXDAI, 2=USDC.e, 3=USDT).
   *
   * Approval target is the zap contract itself (not the base pool / metapool).
   * exchange_underlying handles the deposit-into-3pool → metapool.exchange
   * composition inside the zap so the caller only sees a single token transfer.
   */
  _buildZapMetapoolTx(quote, userAddress) {
    const z = quote._zapInfo;
    if (!z) throw new Error('zap quote missing _zapInfo');
    const dxWei = BigInt(quote.inputAmountWei);
    const minDy = BigInt(quote.minOutputWei || quote.outputAmountWei);
    // Gnosis EURe metapool: route через Curve Router NG (single-tx, no native
    // wrap here — caller wraps if needed). Encoded per canonical mapping
    // decoded from tx 0x81b045aa.. on Gnosisscan:
    //   route       = [WXDAI, 3pool, x3CRV, metapool, EURe] (or reverse)
    //   swap_params = [[0,0,4,1,3], [1,0,1,2,2]]  (add_liq → exchange TwoCrypto OLD)
    if (CURVE_ROUTER_NG_BY_CHAIN[this._chainId]) {
      return this._buildGnosisRouterEureTx({ z, dxWei, minDy, userAddress, withWrap: false });
    }
    // Legacy: direct zap.exchange_underlying for non-Gnosis chains.
    const [i, j] = z.direction === 'base_to_meta'
      ? [BigInt(z.baseIdx + 1), 0n]
      : [0n, BigInt(z.baseIdx + 1)];
    const data = '0x65b2489b'
      + this._hex32(i) + this._hex32(j)
      + this._hex32(dxWei) + this._hex32(minDy);
    return {
      to: z.zap,
      data,
      value: 0n,
      // gasLimit injected at dispatch time via window.estimateGasWithBuffer
      _spender: z.zap,
    };
  }

  /**
   * Build single Router NG tx for WXDAI/XDAI ↔ EURe on Gnosis.
   *   withWrap=true + direction=base_to_meta → XDAI→EURe (msg.value=dxWei)
   *   withWrap=false + direction=base_to_meta → WXDAI→EURe (approve required)
   *   withWrap=true + direction=meta_to_base → EURe→XDAI (unwrap last)
   *   withWrap=false + direction=meta_to_base → EURe→WXDAI (approve required)
   *
   * exchange(address[11], uint256[5][5], uint256, uint256, address[5], address)
   * selector 0x5d7c54c3 (computed for full 6-arg version)
   */
  _buildGnosisRouterEureTx({ z, dxWei, minDy, userAddress, withWrap }) {
    const ROUTER = CURVE_ROUTER_NG_BY_CHAIN[100];
    const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
    const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
    const THREE_POOL = '0x7f90122BF0700F9E7e1F688fe926940E8839F353';
    const X3CRV = '0x1337BedC9D22ecbe766dF105c9623922A27963EC';
    const METAPOOL = z.zap === '0xe3fff29d4dc930ebb787fecd49ee5963dadf60b6' ||
                     z.metapool === '0x056C6C5e684CeC248635eD86033378Cc444459B0'
                       ? '0x056C6C5e684CeC248635eD86033378Cc444459B0'
                       : (z.metapool || '0x056C6C5e684CeC248635eD86033378Cc444459B0');
    const EURE = '0xcB444e90D8198415266c6a2724b7900fb12FC56E';

    // Base coin underlying index: 1+baseIdx (0=meta=EURe, 1..3 = WXDAI/USDC/USDT)
    // По canonical Михаил's tx 0x346887... — Router NG использует ZAP как
    // pool в route, METAPOOL в _pools[step]; swap_type=2 (exchange_underlying),
    // pool_type=2 (TwoCrypto OLD), n_coins=4.
    const ZAP = z.zap || '0xe3fff29d4dc930ebb787fecd49ee5963dadf60b6';
    const ZeroAddress = () => '0x0000000000000000000000000000000000000000';
    const BASE = z.baseIdx === 1
      ? '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83'  // USDC.e (Gnosis)
      : (z.baseIdx === 2
          ? '0x4ECaBa5870353805a9F068101A40E0f32ed605C6'  // USDT (Gnosis)
          : WXDAI);  // baseIdx=0 (or default) → WXDAI
    const isWxdaiPath = z.baseIdx === 0 || z.baseIdx == null;

    let route, swapParams, poolsArr;
    if (z.direction === 'base_to_meta') {
      // base → EURe
      const baseUnderlyingIdx = 1 + (z.baseIdx || 0);  // 1=WXDAI, 2=USDC, 3=USDT
      if (withWrap && isWxdaiPath) {
        // XDAI → wrap → zap.exchange_underlying(1,0,...) → EURe
        route       = [NATIVE, WXDAI, WXDAI, ZAP, EURE];
        swapParams  = [[0,0,8,0,0], [baseUnderlyingIdx,0,2,2,4]];
        poolsArr    = [ZeroAddress(), METAPOOL, ZeroAddress(), ZeroAddress(), ZeroAddress()];
      } else {
        // (W)XDAI/USDC/USDT → zap.exchange_underlying → EURe (no wrap step)
        route       = [BASE, ZAP, EURE];
        swapParams  = [[baseUnderlyingIdx,0,2,2,4]];
        poolsArr    = [METAPOOL, ZeroAddress(), ZeroAddress(), ZeroAddress(), ZeroAddress()];
      }
    } else {
      // EURe → base
      const baseUnderlyingIdx = 1 + (z.baseIdx || 0);
      if (withWrap && isWxdaiPath) {
        // EURe → zap.exchange_underlying(0,1,...) → WXDAI → unwrap → XDAI
        route       = [EURE, ZAP, WXDAI, WXDAI, NATIVE];
        swapParams  = [[0,baseUnderlyingIdx,2,2,4], [0,0,8,0,0]];
        poolsArr    = [METAPOOL, ZeroAddress(), ZeroAddress(), ZeroAddress(), ZeroAddress()];
      } else {
        route       = [EURE, ZAP, BASE];
        swapParams  = [[0,baseUnderlyingIdx,2,2,4]];
        poolsArr    = [METAPOOL, ZeroAddress(), ZeroAddress(), ZeroAddress(), ZeroAddress()];
      }
    }

    // Михаил's canonical tx uses 5-arg exchange (no receiver), msg.sender by default.
    const iface = new ethers.Interface([
      'function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy, address[5] _pools) payable returns (uint256)',
    ]);
    const padR = (a) => { const x=[...a]; while(x.length<11) x.push('0x0000000000000000000000000000000000000000'); return x; };
    const padP = (a) => { const r = a.map(x => { const c=[...x]; while(c.length<5) c.push(0); return c.map(n => BigInt(n)); }); while(r.length<5) r.push([0n,0n,0n,0n,0n]); return r; };

    const data = iface.encodeFunctionData('exchange', [padR(route), padP(swapParams), dxWei, minDy, poolsArr]);
    const value = (withWrap && z.direction === 'base_to_meta') ? dxWei : 0n;
    const needsApprove = !withWrap || z.direction === 'meta_to_base';
    return {
      to: ROUTER,
      data,
      value,
      // gasLimit injected at dispatch time via window.estimateGasWithBuffer
      _spender: needsApprove ? ROUTER : null,
    };
  }

  /**
   * Build a mainnet Curve swap tx by delegating to @curvefi/api (curve-js).
   * This is the SINGLE entry point for every Curve quote source on chainId=1
   * (curve-direct / curve-router / curve-split / curve-multi-path /
   * curve-graph-split / curve-zap-metapool). Replaces every hand-rolled
   * Router NG encoder we used to maintain.
   *
   * Flow:
   *   1. Await window.curveJsReadyForChain(1) — lazy init (~1s once per session).
   *   2. Call curve.router.getBestRouteAndOutput(from, to, amount). This caches
   *      the route inside curve-js — required before populateSwap can run.
   *   3. Call curve.router.populateSwap(from, to, amount, slippage_pct).
   *      Returns { to, data, value } — `to` is always Router NG (0x4531...).
   *   4. Return tx in our normal shape, with _spender=Router NG so
   *      ensureApproval() does the one-time approval on the Router.
   *
   * Slippage: derived from quote.minOutputWei / quote.outputAmountWei when both
   * are present (so we honour the user-selected slippage from the UI), with a
   * 0.5% default. We pass the slippage to populateSwap so curve-js uses the
   * same min_dy our quote engine computed.
   *
   * Native ETH handling: curve-js accepts the ETH placeholder
   * `0xEee...EeE` directly — when from=ETH it sets `value` accordingly; when
   * to=ETH it appends a wrap step inside the same Router NG tx (swap_type=8).
   * We do NOT prepend/append wrap/unwrap in this method — that's curve-js's
   * job.
   *
   * gasLimit: NOT set by curve-js. We add it at dispatch time via
   * window.estimateGasWithBuffer (Михаил 2026-05-24 hard rule: never
   * hardcode gas, always estimate × 1.5).
   *
   * @param {Object} quote - QuoteResult from getQuote (curve-* source)
   * @param {string} userAddress - signer address (unused by populateSwap but
   *                               kept in signature for parity with other builders)
   * @returns {Promise<{to:string,data:string,value:bigint,_spender:string}>}
   * @throws Error when curve-js cannot route this pair (caller falls back)
   */
  async _buildMainnetCurveJsTx(quote, userAddress) {
    if (this._chainId !== 1) {
      throw new Error('curve-js tx builder: chainId=1 required');
    }
    if (typeof window === 'undefined' || typeof window.curveJsReadyForChain !== 'function') {
      throw new Error('curve-js tx builder: window.curveJsReadyForChain not loaded');
    }
    const curve = await window.curveJsReadyForChain(1);
    if (!curve?.router?.populateSwap) {
      throw new Error('curve-js tx builder: curve.router.populateSwap missing');
    }

    // amount as decimal string in input-token units (curve-js expects this).
    // Derive from inputAmountWei using the quote's fromToken decimals.
    // We cannot use ethers.formatUnits here without the decimals — but the
    // quote may not carry them. Fall back to looking them up from our pools.
    const fromDecimals = this._decimalsOf(quote.fromToken, quote);
    const amountStr = ethers.formatUnits(BigInt(quote.inputAmountWei), fromDecimals);

    // Slippage % derived from user-selected min vs expected. Default 0.5%.
    let slippagePct = 0.5;
    try {
      const out = BigInt(quote.outputAmountWei || 0);
      const min = BigInt(quote.minOutputWei || 0);
      if (out > 0n && min > 0n && min < out) {
        // pct = (out - min) / out * 100
        const num = Number((out - min) * 1000000n / out) / 10000;
        if (isFinite(num) && num > 0 && num < 50) slippagePct = num;
      }
    } catch {}

    // Step 1: prime curve-js's route cache. populateSwap throws "You must
    // call getBestRouteAndOutput first" without this.
    const cjRes = await curve.router.getBestRouteAndOutput(quote.fromToken, quote.toToken, amountStr);

    // Floor against the DISPLAYED quote: curve-js applies slippagePct to ITS
    // OWN expected output, which may differ from the quote the user approved.
    // Recompute pct so min_dy protects quote.minOutputWei exactly; if the
    // curve-js route can't even reach the displayed min, refuse — the legacy
    // builder (fallback in buildSwapTx) then executes the route as shown.
    try {
      const ourMin = BigInt(quote.minOutputWei || 0);
      if (ourMin > 0n && cjRes && cjRes.output != null) {
        const toDecimals = this._decimalsOf(quote.toToken, quote);
        const cjOutWei = ethers.parseUnits(String(cjRes.output), toDecimals);
        if (cjOutWei <= ourMin) {
          throw new Error(`curve-js route output ${cjRes.output} ≤ displayed min received — not signing a worse route silently`);
        }
        const num = Number((cjOutWei - ourMin) * 1000000n / cjOutWei) / 10000;
        if (isFinite(num) && num > 0 && num < 50) slippagePct = num;
      }
    } catch (e) {
      if (e && /not signing a worse route/.test(e.message || '')) throw e;
      /* decimals/parse hiccup → keep the quote-derived slippagePct */
    }

    // Step 2: build the tx. Returns { to, data, value } per curve-js source.
    const populated = await curve.router.populateSwap(
      quote.fromToken,
      quote.toToken,
      amountStr,
      slippagePct,
    );

    if (!populated?.to || !populated?.data) {
      throw new Error('curve-js tx builder: populateSwap returned empty tx');
    }

    // Router NG address (curve-js always uses it on mainnet).
    const spender = (populated.to || '').toLowerCase();

    return {
      to: populated.to,
      data: populated.data,
      // populated.value is bigint | undefined depending on curve-js version.
      // Native source ⇒ value = inputAmountWei; ERC20 source ⇒ 0n.
      value: populated.value != null ? BigInt(populated.value) : 0n,
      // For native ETH source curve-js puts the amount in `value` and no
      // approve is needed; for ERC20 source we approve the Router.
      _spender: (quote.fromToken || '').toLowerCase() === ETH_ADDRESS.toLowerCase() ? null : spender,
    };
  }

  /**
   * Resolve decimals for `tokenAddr` from the quote (preferred — set by
   * getQuote with the user-selected from/to decimals) or fall back to the
   * pool data we own. Used by _buildMainnetCurveJsTx to format the amount
   * as a decimal string for curve-js.
   *
   * @param {string} tokenAddr
   * @param {Object} quote
   * @returns {number} decimals (18 fallback for unknown tokens)
   */
  _decimalsOf(tokenAddr, quote) {
    const lc = (tokenAddr || '').toLowerCase();
    // Native ETH placeholder is always 18-decimal
    if (lc === ETH_ADDRESS.toLowerCase()) return 18;
    // Quote may carry decimals on either side
    if (quote && lc === (quote.fromToken || '').toLowerCase() && quote.fromDecimals != null) return Number(quote.fromDecimals);
    if (quote && lc === (quote.toToken   || '').toLowerCase() && quote.toDecimals   != null) return Number(quote.toDecimals);
    // Look up in any pool we hold
    if (Array.isArray(this._pools)) {
      for (const p of this._pools) {
        if (!Array.isArray(p.coinsAddresses) || !Array.isArray(p.decimals)) continue;
        for (let i = 0; i < p.coinsAddresses.length; i++) {
          if ((p.coinsAddresses[i] || '').toLowerCase() === lc) {
            return Number(p.decimals[i] || 18);
          }
        }
      }
    }
    return 18;
  }

  /**
   * Build tx for a direct ETH ↔ WETH wrap/unwrap (no Curve, direct WETH9 call).
   *   ETH → WETH: weth.deposit{value: amount}()       selector 0xd0e30db0
   *   WETH → ETH: weth.withdraw(uint256 wad)          selector 0x2e1a7d4d
   * No approval needed in either direction.
   */
  _buildWethWrapTx(quote, userAddress) {
    const direction = quote._wrapDirection;
    // Chain-aware wrapper address. Quote may carry _wrapContract (set by
    // _getWethWrapQuote at quote time) — prefer that to lock in the chain
    // at which the quote was produced. Fallback to current chain.
    const wrapper = (quote._wrapContract || this._getWrappedAddr());
    if (direction === 'wrap') {
      const iface = new ethers.Interface(['function deposit() payable']);
      const data = iface.encodeFunctionData('deposit', []);
      return {
        to: wrapper,
        data,
        value: BigInt(quote.inputAmountWei),
        // gasLimit injected at dispatch time via window.estimateGasWithBuffer
        _spender: null,
      };
    }
    // unwrap: withdraw(uint256)
    const iface = new ethers.Interface(['function withdraw(uint256 wad)']);
    const data = iface.encodeFunctionData('withdraw', [quote.inputAmountWei]);
    return {
      to: wrapper,
      data,
      value: 0n,
      // gasLimit injected at dispatch time via window.estimateGasWithBuffer
      _spender: null,
    };
  }

  /**
   * Wrap an inner quote (computed for the wrapped-native side) into a
   * composite quote that exposes the wrap/unwrap segment to the UI and emits
   * an explicit pre/post deposit()/withdraw() sub-transaction at submit time.
   *
   * Cases:
   *   from = native, to = ERC20   → wrap(native) + inner(wrapped → toToken)
   *   from = ERC20,  to = native  → inner(fromToken → wrapped) + unwrap(wrapped → native)
   *
   * Inner quote preserves all its strategy-specific fields. Output amount,
   * rate and minOutput on the composite mirror inner because wrap/unwrap is
   * exactly 1:1 (modulo gas).
   */
  _wrapNativeComposite(inner, from, to, fromIsNative, toIsNative, amountWei, fromDecimals, toDecimals, slippage) {
    const wrapped = this._getWrappedAddr();
    const direction = fromIsNative ? 'wrap' : 'unwrap';
    const composite = {
      // Mark the source so buildSwapTx dispatches to the right handler.
      source: 'native-wrap-composite',
      sourceName: (fromIsNative ? 'Wrap + ' : '') + (inner.sourceName || inner.source) + (toIsNative ? ' + Unwrap' : ''),
      fromToken: from,
      toToken: to,
      inputAmountWei: amountWei,
      outputAmountWei: inner.outputAmountWei,
      outputAmount: inner.outputAmount,
      rate: inner.rate, // 1:1 wrap doesn't change the rate
      priceImpact: inner.priceImpact,
      // gas: inner swap + 30k for wrap or +35k for unwrap (deposit/withdraw)
      gas: (inner.gas || 200000) + (fromIsNative ? 30000 : 0) + (toIsNative ? 35000 : 0),
      // route includes the wrap segment at start (and/or unwrap at end) so the
      // UI route-viz can render it as a distinct "native wrapper" hop. Inner
      // legs follow with their actual Curve pools.
      route: [],
      _innerQuote: inner,
      _wrapDirection: direction, // tag for build-tx dispatch
      _wrapContract: wrapped,
      // Pass through critical inner fields used by other paths in the UI/build
      _numHops: (inner._numHops || (inner.route ? inner.route.length : 1)) + (fromIsNative ? 1 : 0) + (toIsNative ? 1 : 0),
    };

    // Build display route: optional wrap leg + inner legs + optional unwrap leg.
    if (fromIsNative) {
      composite.route.push({
        pool: wrapped,
        poolName: 'native wrapper',
        from,
        to: wrapped,
        iFrom: 0,
        iTo: 0,
        isCrypto: false,
        _isWrapHop: true,
      });
    }
    if (Array.isArray(inner.route)) {
      // For curve-direct/curve-router this is array of legs.
      // For split/multi-path the array contains paths, not legs — we keep
      // the structure intact since the UI renders these source types
      // differently anyway; the wrap segment is shown by name above.
      composite.route.push(...inner.route);
    }
    if (toIsNative) {
      composite.route.push({
        pool: wrapped,
        poolName: 'native wrapper',
        from: wrapped,
        to,
        iFrom: 0,
        iTo: 0,
        isCrypto: false,
        _isUnwrapHop: true,
      });
    }

    // Slippage / minOutput inherited from inner (wrap leg is exact)
    const minOutput = BigInt(inner.outputAmountWei) * BigInt(Math.floor((1 - slippage / 100) * 10000)) / 10000n;
    composite.minOutputWei = minOutput.toString();
    composite.minOutput = ethers.formatUnits(minOutput, toDecimals);
    composite.slippage = slippage;
    composite.allQuotes = [composite];
    return composite;
  }

  /**
   * Build transactions for a native↔wrapped composite swap.
   * Returns a multi-tx envelope: deposit() (if from=native) → inner exchange
   * → withdraw() (if to=native). The inner exchange is built by recursing
   * into buildSwapTx on the unwrapped inner quote — once the wrapped-native
   * lives in the user's wallet it's a normal ERC20 swap.
   *
   * Note: this is a sequential 2-tx (or 3-tx for from=native AND to=native,
   * which is the pathological native→native case and skipped).
   */
  async _buildNativeWrapCompositeTx(quote, userAddress) {
    const inner = quote._innerQuote;
    if (!inner) throw new Error('composite quote missing _innerQuote');
    // Gnosis EURe single-tx fast path: when inner is zap-metapool на Gnosis,
    // дёрнуть Router NG напрямую с msg.value (для wrap) или approve+exchange
    // (для unwrap). Михаил 2026-05-23 7035: «зачем wxdai аппровить?! Curve UI
    // сам wrapает». Это оно — один tx, no separate wrap+approve+exchange.
    if (
      CURVE_ROUTER_NG_BY_CHAIN[this._chainId] &&
      inner.source === 'curve-zap-metapool' &&
      inner._zapInfo
    ) {
      const dxWei = BigInt(quote.inputAmountWei);
      const minDy = BigInt(quote.minOutputWei || quote.outputAmountWei);
      return this._buildGnosisRouterEureTx({
        z: inner._zapInfo,
        dxWei,
        minDy,
        userAddress,
        withWrap: true,
      });
    }

    // Ethereum mainnet single-tx fast path for ERC20 ↔ ETH via Curve pools.
    // curve-js's populateSwap natively handles ETH placeholder
    // (0xEee...EeE): when from=ETH the populated tx carries `value=amount`
    // and prepends a wrap step inside the Router NG envelope (swap_type=8);
    // when to=ETH it appends an unwrap step. So we pass the COMPOSITE quote
    // straight through with the native side intact — no manual wrap leg
    // juggling required. Mirrors the Gnosis EURe fast path above (which is
    // still custom because curve-js doesn't deploy on Gnosis).
    //
    // Михаил 2026-05-24 7087: «надо чтоб транзакция сама разворачивала
    // WETH а не просила меня это сделать» — это оно, теперь через curve-js.
    if (
      this._chainId === 1 &&
      typeof window !== 'undefined' &&
      typeof window.curveJsReadyForChain === 'function' &&
      (inner.source === 'curve-direct' || inner.source === 'curve-router' ||
       inner.source === 'curve-split' || inner.source === 'curve-multi-path' ||
       inner.source === 'curve-graph-split')
    ) {
      // Build a synthetic curve-* style quote that carries the composite's
      // outer endpoints (which is either {ETH, ERC20} or {ERC20, ETH}). The
      // input/min amounts are the composite's outer values.
      const passthroughQuote = {
        source: inner.source,
        fromToken: quote.fromToken,
        toToken: quote.toToken,
        fromDecimals: quote.fromDecimals != null ? quote.fromDecimals : inner.fromDecimals,
        toDecimals: quote.toDecimals != null ? quote.toDecimals : inner.toDecimals,
        inputAmountWei: quote.inputAmountWei,
        outputAmountWei: quote.outputAmountWei,
        minOutputWei: quote.minOutputWei || quote.outputAmountWei,
      };
      try {
        return await this._buildMainnetCurveJsTx(passthroughQuote, userAddress);
      } catch (e) {
        // Fall through to legacy composite multi-tx envelope on any error
        // — safety net. The hot-fix (router.js _buildCurveDirectTx
        // gasLimit 500k) still applies to the inner direct swap step.
        console.warn('[CurveDEXRouter] mainnet curve-js native-wrap fast-path failed, falling back to composite:', e?.message || e);
      }
    }
    const wrapped = quote._wrapContract || this._getWrappedAddr();
    const txs = [];

    // 1) wrap (deposit) if needed
    if (quote._wrapDirection === 'wrap') {
      const iface = new ethers.Interface(['function deposit() payable']);
      txs.push({
        to: wrapped,
        data: iface.encodeFunctionData('deposit', []),
        value: BigInt(quote.inputAmountWei),
        // gasLimit injected at dispatch time via window.estimateGasWithBuffer
        _spender: null,
        _label: 'wrap',
      });
    }

    // 2) inner swap (recurse buildSwapTx on the inner quote)
    const innerTx = await this.buildSwapTx(inner, userAddress);
    // innerTx may itself be a multi-tx (split/multi-path with multiple chunks).
    if (innerTx && innerTx.type === 'multi-tx' && Array.isArray(innerTx.transactions)) {
      for (const t of innerTx.transactions) {
        // strip native value from inner swap — we already wrapped above
        txs.push({ ...t, value: 0n, _label: t._label || 'swap' });
      }
    } else if (innerTx) {
      txs.push({ ...innerTx, value: 0n, _label: 'swap' });
    }

    // 3) unwrap (withdraw) if to=native
    if (quote._wrapDirection === 'unwrap') {
      const iface = new ethers.Interface(['function withdraw(uint256 wad)']);
      // Use inner outputAmountWei as the unwrap amount (we receive this from inner swap)
      // Conservative: use minOutputWei to avoid revert if router under-delivers
      const unwrapAmount = BigInt(inner.outputAmountWei || quote.inputAmountWei);
      txs.push({
        to: wrapped,
        data: iface.encodeFunctionData('withdraw', [unwrapAmount.toString()]),
        value: 0n,
        // gasLimit injected at dispatch time via window.estimateGasWithBuffer
        _spender: null,
        _label: 'unwrap',
      });
    }

    return {
      type: 'multi-tx',
      transactions: txs,
      _spenders: txs.map(t => t._spender).filter(Boolean),
    };
  }

  /**
   * Build tx for a multi-hop Curve swap via Curve Router NG.
   * Encodes the route as address[11] and swap_params as uint256[5][5].
   * Supports 2-hop, 3-hop, up to 5-hop paths.
   *
   * Route encoding: [tokenIn, pool1, token1, pool2, token2, pool3, token3, ...]
   * Each hop pair occupies 2 slots (pool + output_token), first slot is input token.
   */
  _buildCurveRouterTx(quote, userAddress) {
    const isETH = quote.fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const numHops = quote._numHops || quote.route.length;

    // Build route array: [tokenIn, pool1, midToken1, pool2, midToken2, ..., tokenOut, 0x0, ...]
    const route = new Array(11).fill(ethers.ZeroAddress);
    route[0] = quote.fromToken;

    for (let h = 0; h < numHops; h++) {
      const hop = quote.route[h];
      route[1 + h * 2] = hop.pool;         // pool address
      route[2 + h * 2] = hop.to || quote.toToken; // output token of this hop
    }
    // Ensure last token in route is the final output token
    route[numHops * 2] = quote.toToken;

    // Build swap_params: [[i, j, swap_type, pool_type, n_coins], [...], ...]
    const swapParams = Array.from({ length: 5 }, () => [0n, 0n, 0n, 0n, 0n]);

    for (let h = 0; h < numHops; h++) {
      const hop = quote.route[h];
      swapParams[h] = [
        BigInt(hop.iFrom),
        BigInt(hop.iTo),
        1n, // swap_type: standard exchange
        hop.isCrypto ? 2n : 1n, // pool_type
        BigInt(this._getPoolNCoins(hop)),
      ];
    }

    const iface = new ethers.Interface([
      'function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy) payable returns (uint256)',
    ]);

    const data = iface.encodeFunctionData('exchange', [
      route, swapParams, quote.inputAmountWei, quote.minOutputWei,
    ]);

    return {
      to: CURVE_ROUTER_NG,
      data,
      value: isETH ? BigInt(quote.inputAmountWei) : 0n,
      // gasLimit injected at dispatch time via window.estimateGasWithBuffer
      _spender: CURVE_ROUTER_NG,
    };
  }

  /**
   * Build tx for a split Curve swap.
   * Returns an array of transactions (one per pool chunk) to be sent sequentially.
   * The caller should compute min_dy per chunk from the total slippage budget.
   */
  _buildCurveSplitTx(quote, userAddress) {
    const isETH = quote.fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const totalInput = BigInt(quote.inputAmountWei);
    const totalMinOutput = BigInt(quote.minOutputWei);
    const totalOutput = BigInt(quote.outputAmountWei);

    // Build one tx per chunk, splitting minOutput proportionally
    const txs = quote.route.map(hop => {
      const chunkOutput = BigInt(hop.outputWei);
      // Proportional min_dy for this chunk
      const chunkMinDy = totalOutput > 0n
        ? (totalMinOutput * chunkOutput / totalOutput)
        : 0n;

      let iface, data;
      if (hop.isCrypto) {
        iface = new ethers.Interface([
          'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)',
        ]);
        data = iface.encodeFunctionData('exchange', [
          hop.iFrom, hop.iTo, hop.chunkWei, chunkMinDy.toString(),
        ]);
      } else {
        iface = new ethers.Interface([
          'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) payable returns (uint256)',
        ]);
        data = iface.encodeFunctionData('exchange', [
          hop.iFrom, hop.iTo, hop.chunkWei, chunkMinDy.toString(),
        ]);
      }

      return {
        to: hop.pool,
        data,
        value: isETH ? BigInt(hop.chunkWei) : 0n,
        // gasLimit injected at dispatch time via window.estimateGasWithBuffer
        _spender: hop.pool,
      };
    });

    // Return as multi-tx for split execution
    return {
      type: 'multi-tx',
      transactions: txs,
      // For approval, use the first pool (caller may need to approve all)
      _spenders: txs.map(t => t._spender),
    };
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  /**
   * Find the best pool (highest TVL) for a direct swap between two tokens.
   */
  _findBestPool(fromAddr, toAddr) {
    fromAddr = fromAddr.toLowerCase();
    toAddr = toAddr.toLowerCase();
    // native ↔ wrapped equivalence — search for both variants (chain-aware)
    const ethLower = this._getNativeAddr();
    const wethLower = this._getWrappedAddr();
    const fromVariants = [fromAddr];
    const toVariants = [toAddr];
    if (fromAddr === ethLower) fromVariants.push(wethLower);
    if (fromAddr === wethLower) fromVariants.push(ethLower);
    if (toAddr === ethLower) toVariants.push(wethLower);
    if (toAddr === wethLower) toVariants.push(ethLower);

    let best = null;
    let bestTvl = 0;

    for (const pool of this._pools) {
      if (!pool.coinsAddresses) continue;
      const addrs = pool.coinsAddresses.map(a => a.toLowerCase());
      const hasFrom = fromVariants.some(v => addrs.includes(v));
      const hasTo = toVariants.some(v => addrs.includes(v));
      if (hasFrom && hasTo) {
        const tvl = pool.tvl || 0;
        if (tvl > bestTvl) {
          bestTvl = tvl;
          best = pool;
        }
      }
    }

    return best;
  }

  /**
   * Find ALL pools containing both tokens, sorted by TVL descending.
   * Used by split routing.
   */
  _findAllPools(fromAddr, toAddr) {
    fromAddr = fromAddr.toLowerCase();
    toAddr = toAddr.toLowerCase();
    // native ↔ wrapped equivalence — search for both variants (chain-aware)
    const ethLower = this._getNativeAddr();
    const wethLower = this._getWrappedAddr();
    const fromVariants = [fromAddr];
    const toVariants = [toAddr];
    if (fromAddr === ethLower) fromVariants.push(wethLower);
    if (fromAddr === wethLower) fromVariants.push(ethLower);
    if (toAddr === ethLower) toVariants.push(wethLower);
    if (toAddr === wethLower) toVariants.push(ethLower);

    const matching = [];

    for (const pool of this._pools) {
      if (!pool.coinsAddresses) continue;
      const addrs = pool.coinsAddresses.map(a => a.toLowerCase());
      const hasFrom = fromVariants.some(v => addrs.includes(v));
      const hasTo = toVariants.some(v => addrs.includes(v));
      if (hasFrom && hasTo) {
        matching.push(pool);
        continue;
      }
      // Metapool underlying match (e.g. WXDAI→EURe on Gnosis EURe-3Crv
      // metapool: WXDAI is on the base 3pool side, not a direct coin).
      if (pool.isMetaPool && Array.isArray(pool.underlyingCoinsAddresses) && pool.underlyingCoinsAddresses.length > 0) {
        const u = pool.underlyingCoinsAddresses.map(a => (a || '').toLowerCase());
        const uHasFrom = fromVariants.some(v => u.includes(v));
        const uHasTo = toVariants.some(v => u.includes(v));
        if (uHasFrom && uHasTo) matching.push(pool);
      }
    }

    // Sort by TVL descending
    matching.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
    // Defense-in-depth: drop pools with explicit zero/undefined TVL when at
    // least one liquid candidate exists. Curve API marks dust factory pools
    // with tvl=0 (or null); routing through them yields zero get_dy output
    // and pollutes the candidate set. We DO keep them as a single fallback
    // when every match is zero-TVL — covers freshly seeded pools whose
    // off-chain TVL aggregator hasn't yet catalogued.
    const liquid = matching.filter(p => (p.tvl || 0) > 0);
    return liquid.length > 0 ? liquid : matching;
  }

  /**
   * Get token indices within a pool.
   */
  _getPoolIndices(pool, fromAddr, toAddr) {
    fromAddr = fromAddr.toLowerCase();
    toAddr = toAddr.toLowerCase();
    const addrs = pool.coinsAddresses.map(a => a.toLowerCase());
    let iFrom = addrs.indexOf(fromAddr);
    let iTo = addrs.indexOf(toAddr);
    // native ↔ wrapped fallback: if exact address not found, try the other
    // variant (chain-aware: WETH/ETH, WXDAI/XDAI, WMATIC/MATIC, ...)
    const ethLower = this._getNativeAddr();
    const wethLower = this._getWrappedAddr();
    if (iFrom === -1 && fromAddr === ethLower) iFrom = addrs.indexOf(wethLower);
    if (iFrom === -1 && fromAddr === wethLower) iFrom = addrs.indexOf(ethLower);
    if (iTo === -1 && toAddr === ethLower) iTo = addrs.indexOf(wethLower);
    if (iTo === -1 && toAddr === wethLower) iTo = addrs.indexOf(ethLower);
    const isCrypto = ['crypto', 'factory-crypto', 'factory-twocrypto', 'factory-tricrypto']
      .includes(pool.registryId);
    // Metapool underlying-coin lookup. When one of the tokens is not a direct
    // pool coin but appears in the base-pool stack (e.g. WXDAI on the 3pool
    // base of an EURe/3CRV metapool), Curve exposes exchange_underlying so the
    // user can swap without manually composing 3pool.add_liquidity + meta.exchange.
    // We mark the indices with isUnderlying=true so the builder picks the right
    // selector at submit time.
    let isUnderlying = false;
    if ((iFrom === -1 || iTo === -1) && pool.isMetaPool && Array.isArray(pool.underlyingCoinsAddresses) && pool.underlyingCoinsAddresses.length > 0) {
      const uAddrs = pool.underlyingCoinsAddresses.map(a => (a || '').toLowerCase());
      let uFrom = uAddrs.indexOf(fromAddr);
      let uTo = uAddrs.indexOf(toAddr);
      if (uFrom === -1 && fromAddr === ethLower) uFrom = uAddrs.indexOf(wethLower);
      if (uFrom === -1 && fromAddr === wethLower) uFrom = uAddrs.indexOf(ethLower);
      if (uTo === -1 && toAddr === ethLower) uTo = uAddrs.indexOf(wethLower);
      if (uTo === -1 && toAddr === wethLower) uTo = uAddrs.indexOf(ethLower);
      if (uFrom !== -1 && uTo !== -1) {
        iFrom = uFrom;
        iTo = uTo;
        isUnderlying = true;
      }
    }
    return { iFrom, iTo, isCrypto, isUnderlying };
  }

  /**
   * Get the number of coins in a pool (from route hop info).
   * @param {Object} hop - Route hop with pool address (string or via .pool property)
   */
  _getPoolNCoins(hop) {
    const poolAddr = (typeof hop.pool === 'string' ? hop.pool : hop.pool?.address || '').toLowerCase();
    const pool = this._pools.find(p => p.address.toLowerCase() === poolAddr);
    if (pool && pool.coinsAddresses) return pool.coinsAddresses.length;
    return 2; // default
  }

  /**
   * Call get_dy (or get_dy_underlying) on a pool, trying both int128 and
   * uint256 signatures. Results are cached for 5 seconds.
   * @param {Object} pool
   * @param {number} i source index
   * @param {number} j dest index
   * @param {string} amountWei
   * @param {boolean} [useUnderlying=false] - use get_dy_underlying selector
   *        (for metapool swaps where source/dest is a base-pool coin).
   */
  async _getDy(pool, i, j, amountWei, useUnderlying = false) {
    // Check LRU cache first
    const cacheKey = `${pool.address}:${i}:${j}:${amountWei}:${useUnderlying ? 'u' : 'd'}`;
    const cached = this._getCachedDy(cacheKey);
    if (cached !== null) return cached;

    const fn = useUnderlying ? 'get_dy_underlying' : 'get_dy';
    const iface128 = new ethers.Interface([`function ${fn}(int128 i, int128 j, uint256 dx) view returns (uint256)`]);
    const iface256 = new ethers.Interface([`function ${fn}(uint256 i, uint256 j, uint256 dx) view returns (uint256)`]);
    // Max sane value: 2^128 (~340 undecillion) — anything larger is a broken pool
    const MAX_SANE = 2n ** 128n;

    try {
      const result = await this._rpcCall(
        iface128.encodeFunctionData(fn, [i, j, amountWei]),
        pool.address
      );
      const value = BigInt(result);
      if (value > MAX_SANE) return null; // broken pool overflow
      this._setCachedDy(cacheKey, value);
      return value;
    } catch (e1) {
      // RPC exhaustion is transient infrastructure failure, not a property of
      // the pool — propagate so callers can distinguish it from "no quote"
      // (silently mapping it to null degrades route selection).
      if (e1 && e1._isRpcExhausted) throw e1;
      try {
        const result = await this._rpcCall(
          iface256.encodeFunctionData(fn, [i, j, amountWei]),
          pool.address
        );
        const value = BigInt(result);
        if (value > MAX_SANE) return null; // broken pool overflow
        this._setCachedDy(cacheKey, value);
        return value;
      } catch (e2) {
        if (e2 && e2._isRpcExhausted) throw e2;
        return null;
      }
    }
  }

  /**
   * Pool-aware peg-1 stable detector + rate-based price impact.
   * Convention: signed % where NEGATIVE = user got worse than expected (slippage loss),
   * POSITIVE = premium (executed better than reference). Matches Curve UI convention.
   *
   * Replaces hardcoded address whitelist with Curve pool metadata: each pool exposes
   * per-coin live USD prices via `pool.coinsDetailed[i].usdPrice` (Curve API field).
   * Walking every hop's (iFrom, iTo) and verifying ALL involved coins are within
   * ±PEG_WINDOW of $1.00 yields a peg-1 detector that:
   *   - excludes yield-bearing wrappers (sUSDS $1.09, sUSDe $1.23, sFRAX $1.15, scrvUSD $1.10)
   *     because their pool-side usdPrice reflects redemption value, not $1
   *   - excludes BTC/ETH/crypto pairs (usdPrice ≠ $1)
   *   - lets new $1-pegged stables work the moment Curve indexes them
   *   - reuses data already loaded in cache.json — no extra fetch
   *
   * Route classification rule: "stable iff EVERY coin touched by the route (in/out of
   * each hop) is peg-1". A single non-peg-1 hop (e.g. crypto leg, sUSDS leg) → null,
   * caller falls back to baseline-probe.
   *
   * @param {number} rate - executed rate (output / input)
   * @param {Array<{pool:Object, iFrom:number, iTo:number}>} route - hops with pool objects
   * @returns {number|null} signed PI %, or null if route is not pure peg-1
   */
  _estimatePriceImpact(rate, route) {
    if (!this._isPureStableRoute(route)) return null;
    // Self-consistency guard. The (rate-1) shortcut assumes the no-impact fair
    // cross-rate is ~1.0, which only holds when both coins are genuinely ~$1.
    // Two coins each within ±PEG_WINDOW of $1 can have a fair cross-rate no
    // wider than [(1-w)/(1+w), (1+w)/(1-w)]. An executed rate outside that band
    // means the pool applies a rate oracle / stored_rates scaling that Curve's
    // usdPrice does NOT expose (e.g. apyUSD's per-coin oracle → ~1.364 apxUSD,
    // both still reported ~$1). In that case (rate-1) is meaningless (it yields
    // a bogus +36% premium) — return null so the caller falls back to the
    // spot-rate baseline (1-unit get_dy), which reflects the oracle correctly.
    if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) return null;
    const lo = (1 - PEG_WINDOW) / (1 + PEG_WINDOW);
    const hi = (1 + PEG_WINDOW) / (1 - PEG_WINDOW);
    if (rate < lo || rate > hi) return null;
    return (rate - 1) * 100;
  }

  /**
   * True iff every coin touched by every hop is currently within ±PEG_WINDOW of $1.00,
   * per the pool's own usdPrice (Curve API). This is the SOLE signal — no token list,
   * no symbol heuristic. If any hop lacks coinsDetailed/usdPrice data, returns false
   * (conservative: prefer baseline-probe over a wrong (rate-1) estimate).
   */
  _isPureStableRoute(route) {
    if (!Array.isArray(route) || route.length === 0) return false;
    for (const hop of route) {
      const pool = hop && hop.pool;
      const coins = pool && pool.coinsDetailed;
      if (!Array.isArray(coins) || coins.length === 0) return false;
      const inCoin = coins[hop.iFrom];
      const outCoin = coins[hop.iTo];
      if (!inCoin || !outCoin) return false;
      if (!this._isPegOne(inCoin.usdPrice) || !this._isPegOne(outCoin.usdPrice)) return false;
    }
    return true;
  }

  /**
   * Returns true iff price is a finite number within ±PEG_WINDOW of $1.00.
   * Centralized so the threshold can be tuned in one place.
   */
  _isPegOne(price) {
    const p = typeof price === 'number' ? price : parseFloat(price);
    return typeof p === 'number' && isFinite(p) && Math.abs(p - 1) <= PEG_WINDOW;
  }

  /**
   * Baseline-simulation price impact: when stablecoin whitelist returns null,
   * compute spot rate via 1-unit simulation through the SAME route, then
   * priceImpact = (executed_rate - spot_rate) / spot_rate * 100.
   *
   * Sign convention (Curve UI standard): NEGATIVE = user got less than spot (slippage loss),
   * POSITIVE = user got more than spot (premium, rare). The display layer renders
   * negatives in yellow/red to alert users to slippage cost.
   *
   * @param {number} rate - executed rate (output / input)
   * @param {Array<{pool:Object, iFrom:number, iTo:number}>} route - hops with pool objects
   * @param {Function} simulateSpotFn - async () => Promise<number|null> returning spot rate (1-unit output / 1-unit input)
   * @returns {Promise<number|null>}
   */
  async _computeBaselinePriceImpact(rate, route, simulateSpotFn) {
    const stable = this._estimatePriceImpact(rate, route);
    if (stable != null) return stable;
    if (!rate || !isFinite(rate) || rate <= 0) return null;
    try {
      const spotRate = await simulateSpotFn();
      if (spotRate && isFinite(spotRate) && spotRate > 0) {
        return ((rate - spotRate) / spotRate) * 100;
      }
    } catch { /* swallow — keep null on RPC failure */ }
    return null;
  }

  /**
   * Simulate 1-unit swap through a sequence of (pool, iFrom, iTo) hops.
   * Returns spot rate (output_in_toUnits / 1_in_fromUnits) or null on any failure.
   *
   * @param {Array<{pool, iFrom, iTo}>} hops
   * @param {number} fromDecimals
   * @param {number} toDecimals
   * @returns {Promise<number|null>}
   */
  async _simulateSpotThroughHops(hops, fromDecimals, toDecimals) {
    if (!hops || hops.length === 0) return null;
    try {
      let currentWei = ethers.parseUnits('1', fromDecimals);
      for (const h of hops) {
        const out = await this._getDy(h.pool, h.iFrom, h.iTo, currentWei, !!h.isUnderlying);
        if (!out || out <= 0n) return null;
        currentWei = out;
      }
      return parseFloat(ethers.formatUnits(currentWei, toDecimals));
    } catch {
      return null;
    }
  }

  /**
   * Get the spender address for token approvals.
   */
  _getSpender(quote) {
    switch (quote.source) {
      case 'weth-wrap':
        // WETH9 deposit (ETH→WETH) sends value, no approval. Withdraw (WETH→ETH)
        // is called by the WETH holder on the WETH contract itself, no approval.
        return null;
      case 'native-wrap-composite': {
        // Composite (native + inner swap):
        //   from=native → deposit() needs no approval; inner swap operates on
        //     wrapped-native we just deposited → no ERC20 allowance needed
        //     until the user has wrapped-native already (rare here, since the
        //     user explicitly picked native). Safe to return null.
        //   from=ERC20→native → we still need allowance for the ERC20 on the
        //     inner-quote spender. Delegate.
        const inner = quote._innerQuote;
        if (!inner) return null;
        if (quote._wrapDirection === 'wrap') return null;
        return this._getSpender(inner);
      }
      case 'curve-direct':
        return quote.route[0]?.pool;
      case 'curve-router':
        return CURVE_ROUTER_NG;
      case 'curve-split':
        // For split, approve the pool with the largest chunk
        return quote.route[0]?.pool;
      case 'curve-multi-path':
      case 'curve-graph-split':
        // Multi-path / Graph-split: each path may use different pools.
        // For 1-hop paths, approve the pool directly.
        // For 2-hop paths, use Router NG (all hops atomic).
        // Use Router NG if any path has 2+ legs, otherwise first pool.
        if (quote.route.some(r => r.legs && r.legs.length >= 2)) return CURVE_ROUTER_NG;
        return quote.route[0]?.pool;
      case 'curve-js-baseline':
        // curve-js builds tx for mainnet Router NG regardless of hops, so the
        // ERC20 fromToken must be approved to Router NG. Missing this case let
        // ensureApproval silently return null, then buildSwapTx ran estimateGas
        // on a tx with zero allowance, which reverts and surfaces as "swap
        // failed without wallet popup" (incident 2026-05-26 16:15, Михаил).
        return CURVE_ROUTER_NG;
      case 'curve-zap-metapool':
        // Same silent-skip hazard as curve-js-baseline: this source is in the
        // __isMainnetCurveSrc whitelist (line ~850), so on mainnet it builds
        // through _buildMainnetCurveJsTx → Router NG. On Gnosis it goes
        // through _buildGnosisRouterEureTx → Router NG on chain 100. Legacy
        // path (other non-mainnet) builds zap.exchange_underlying directly.
        if (this._chainId === 1) return CURVE_ROUTER_NG;
        if (CURVE_ROUTER_NG_BY_CHAIN && CURVE_ROUTER_NG_BY_CHAIN[this._chainId]) {
          return CURVE_ROUTER_NG_BY_CHAIN[this._chainId];
        }
        return quote._zapInfo?.zap || null;
      case 'paraswap':
        return quote._paraswapTokenProxy || PARASWAP_AUGUSTUS_V6;
      case 'cow':
        return COW_VAULT_RELAYER;
      case 'odos':
        return ODOS_ROUTER_V2;
      default:
        return null;
    }
  }

  // External aggregators (ParaSwap, CoW, ODOS) moved to aggregators.js
  // Re-enable by loading aggregators.js and setting enableParaSwap/enableCow/enableOdos

  async _getParaSwapQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals, userAddress) {
    const params = new URLSearchParams({
      srcToken: fromToken,
      destToken: toToken,
      amount: amountWei,
      srcDecimals: fromDecimals.toString(),
      destDecimals: toDecimals.toString(),
      side: 'SELL',
      network: this._chainId.toString(),
    });
    if (userAddress) params.set('userAddress', userAddress);

    const resp = await fetch(`${PARASWAP_API}/prices?${params}`);
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ParaSwap API error ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const best = data.priceRoute;
    if (!best || !best.destAmount) throw new Error('No ParaSwap route found');

    const outputAmountWei = best.destAmount;
    const outputAmount = parseFloat(ethers.formatUnits(outputAmountWei, toDecimals));
    const inputAmount = parseFloat(ethers.formatUnits(amountWei, fromDecimals));

    return {
      source: 'paraswap',
      sourceName: 'ParaSwap',
      outputAmount,
      outputAmountWei,
      inputAmountWei: amountWei,
      fromToken,
      toToken,
      rate: inputAmount > 0 ? outputAmount / inputAmount : 0,
      // Signed convention: NEGATIVE = loss vs reference, POSITIVE = premium.
      priceImpact: parseFloat(best.srcUSD) > 0
        ? ((parseFloat(best.destUSD) - parseFloat(best.srcUSD)) / parseFloat(best.srcUSD) * 100)
        : null,
      gas: parseInt(best.gasCost) || 250000,
      route: (best.bestRoute || []).map(r => ({
        poolName: r.swaps?.[0]?.swapExchanges?.[0]?.exchange || 'ParaSwap',
        exchange: r.swaps?.[0]?.swapExchanges?.[0]?.exchange || 'unknown',
        percent: r.percent,
      })),
      _paraswapPriceRoute: best,
      _paraswapTokenProxy: best.tokenTransferProxy,
    };
  }

  /**
   * Build ParaSwap swap transaction.
   * Requires a second API call to /transactions to get calldata.
   */
  async _buildParaSwapTx(quote, userAddress) {
    const body = {
      srcToken: quote.fromToken,
      destToken: quote.toToken,
      srcAmount: quote._paraswapPriceRoute.srcAmount,
      destAmount: quote._paraswapPriceRoute.destAmount,
      priceRoute: quote._paraswapPriceRoute,
      userAddress,
      txOrigin: userAddress,
      srcDecimals: quote._paraswapPriceRoute.srcDecimals,
      destDecimals: quote._paraswapPriceRoute.destDecimals,
    };

    const resp = await fetch(`${PARASWAP_API}/transactions/${this._chainId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ParaSwap tx build error ${resp.status}: ${errText}`);
    }

    const txData = await resp.json();
    return {
      to: txData.to,
      data: txData.data,
      value: txData.value || '0',
      // gasLimit injected at dispatch time via window.estimateGasWithBuffer.
      // ParaSwap's `txData.gas` kept as hint only (NOT used as final gasLimit).
      _aggregatorGasHint: txData.gas ? parseInt(txData.gas) : null,
      chainId: this._chainId,
    };
  }

  // ============================================================
  // STRATEGY 5: COW PROTOCOL (optional, MEV-protected)
  // ============================================================

  /**
   * Get quote from CoW Protocol (intent-based, MEV-protected batch auctions).
   * Requires userAddress for the quote.
   */
  async _getCowQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals, userAddress) {
    // CoW uses WETH internally, not native ETH
    const sellToken = fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase() ? WETH_ADDRESS : fromToken;
    const buyToken = toToken.toLowerCase() === ETH_ADDRESS.toLowerCase() ? WETH_ADDRESS : toToken;

    const body = {
      sellToken,
      buyToken,
      sellAmountBeforeFee: amountWei,
      kind: 'sell',
      from: userAddress,
      receiver: userAddress,
      appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
      partiallyFillable: false,
      sellTokenBalance: 'erc20',
      buyTokenBalance: 'erc20',
    };

    const resp = await fetch(`${COW_API}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`CoW API error ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const quote = data.quote;
    if (!quote || !quote.buyAmount) throw new Error('No CoW quote returned');

    const outputAmountWei = quote.buyAmount;
    const outputAmount = parseFloat(ethers.formatUnits(outputAmountWei, toDecimals));
    const inputAmount = parseFloat(ethers.formatUnits(amountWei, fromDecimals));
    const feeAmount = quote.feeAmount || '0';

    return {
      source: 'cow',
      outputAmount,
      outputAmountWei,
      inputAmountWei: amountWei,
      fromToken,
      toToken,
      rate: inputAmount > 0 ? outputAmount / inputAmount : 0,
      priceImpact: null, // CoW doesn't expose price impact — swap.js will compute via micro-quote
      gas: 0, // No gas for user — CoW solver pays gas
      route: [{ exchange: 'CoW Protocol', percent: 100, mevProtected: true }],
      _cowQuoteId: data.id,
      _cowQuote: quote,
      _cowFrom: data.from,
    };
  }

  /**
   * Build CoW Protocol order.
   * CoW uses EIP-712 signed orders, not regular transactions.
   * Returns order data for signing — the caller must sign and submit to CoW API.
   */
  async _buildCowTx(quote, userAddress) {
    const cowQuote = quote._cowQuote;
    // Calculate min buy amount with slippage
    const buyAmount = BigInt(cowQuote.buyAmount);
    const slippageBps = Math.floor((quote.slippage || 0.5) * 100);
    const minBuyAmount = buyAmount - (buyAmount * BigInt(slippageBps) / 10000n);

    return {
      type: 'cow-order', // Special type — not a regular tx
      sellToken: cowQuote.sellToken,
      buyToken: cowQuote.buyToken,
      sellAmount: cowQuote.sellAmount,
      buyAmount: minBuyAmount.toString(),
      feeAmount: cowQuote.feeAmount,
      validTo: cowQuote.validTo,
      appData: cowQuote.appData,
      kind: 'sell',
      partiallyFillable: false,
      receiver: userAddress,
      quoteId: quote._cowQuoteId,
      // Caller must: 1) approve COW_VAULT_RELAYER, 2) sign EIP-712 order, 3) POST to COW_API/orders
    };
  }

  // ============================================================
  // STRATEGY 6: ODOS (optional, smart split routing)
  // ============================================================

  /**
   * Get quote from ODOS — smart order routing with native split support.
   * Free API, no key needed for basic tier.
   */
  async _getOdosQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals, userAddress) {
    const body = {
      chainId: this._chainId,
      inputTokens: [{ tokenAddress: fromToken, amount: amountWei }],
      outputTokens: [{ tokenAddress: toToken, proportion: 1 }],
      slippageLimitPercent: 0.5,
      userAddr: userAddress || '0x0000000000000000000000000000000000000000',
      referralCode: 0,
      compact: true,
    };

    const resp = await fetch(`${ODOS_API}/sor/quote/v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ODOS API error ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    if (!data.outAmounts || !data.outAmounts[0]) throw new Error('No ODOS route found');

    const outputAmountWei = data.outAmounts[0];
    const outputAmount = parseFloat(ethers.formatUnits(outputAmountWei, toDecimals));
    const inputAmount = parseFloat(ethers.formatUnits(amountWei, fromDecimals));

    return {
      source: 'odos',
      sourceName: 'Odos',
      outputAmount,
      outputAmountWei,
      inputAmountWei: amountWei,
      fromToken,
      toToken,
      rate: inputAmount > 0 ? outputAmount / inputAmount : 0,
      // Signed convention: NEGATIVE = loss, POSITIVE = premium. Odos returns
      // negative for losses already; preserve sign instead of abs().
      priceImpact: data.priceImpact != null ? Number(data.priceImpact) : null,
      gas: parseInt(data.gasEstimate) || 250000,
      route: (data.pathViz || []).map(p => ({
        poolName: p.dex || 'Odos',
        exchange: p.dex || 'unknown',
        percent: p.percent || 100,
      })),
      _odosPathId: data.pathId,
    };
  }

  /**
   * Build ODOS swap transaction.
   * Requires a second API call to /sor/assemble to get calldata.
   */
  async _buildOdosTx(quote, userAddress) {
    const body = {
      userAddr: userAddress,
      pathId: quote._odosPathId,
      simulate: false,
    };

    const resp = await fetch(`${ODOS_API}/sor/assemble`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`ODOS assemble error ${resp.status}: ${errText}`);
    }

    const data = await resp.json();
    const tx = data.transaction;
    if (!tx) throw new Error('ODOS assemble returned no transaction');

    return {
      to: tx.to,
      data: tx.data,
      value: tx.value || '0',
      // gasLimit injected at dispatch time via window.estimateGasWithBuffer.
      // Odos's `tx.gas` kept as hint only (NOT used as final gasLimit).
      _aggregatorGasHint: tx.gas ? parseInt(tx.gas) : null,
      chainId: this._chainId,
    };
  }

  /**
   * Wrap a promise with a timeout. Returns null on timeout instead of throwing.
   */
  async _withTimeout(promise, label, failures) {
    let settled = false;
    // External aggregators get shorter timeout (5s) — they often fail due to CORS/DNS
    const isExternal = ['paraswap', 'odos', 'cow'].includes(label);
    const timeout = isExternal ? Math.min(this._quoteTimeout, 5000) : this._quoteTimeout;
    return Promise.race([
      promise.then(
        result => { settled = true; return result; },
        err => {
          settled = true;
          // External aggregator failures (CORS/DNS) are routine — debug. A
          // Curve-native strategy ERRORING OUT means the route comparison is
          // incomplete (it did not say "no route", it failed to answer) —
          // warn with the reason and record it for _degradedSources.
          if (isExternal) {
            console.debug(`[CurveDEXRouter] ${label} failed:`, err && err.message);
          } else {
            console.warn(`[CurveDEXRouter] strategy ${label} DROPPED (error, not no-route):`, err && err.message);
          }
          if (failures) failures[label] = (err && err.message) || 'error';
          return null;
        }
      ),
      new Promise(resolve => setTimeout(() => {
        if (!settled) {
          if (isExternal) {
            console.debug(`[CurveDEXRouter] ${label} timed out`);
          } else {
            console.warn(`[CurveDEXRouter] strategy ${label} DROPPED (timeout ${timeout}ms)`);
          }
          if (failures) failures[label] = `timeout ${timeout}ms`;
        }
        resolve(null);
      }, timeout)),
    ]);
  }
}


// ============================================================
// CONVENIENCE: Quick quote using Curve Router NG on-chain
// ============================================================

/**
 * Quick quote without instantiating the full router.
 * Uses on-chain Curve pools data to find a direct swap.
 * Requires rpcCall and pools array.
 *
 * @param {Object} opts - { rpcCall, pools, fromToken, toToken, amountWei, fromDecimals, toDecimals }
 * @returns {Promise<Object>} { outputAmount, outputAmountWei, rate, source }
 */
async function quickQuote({ rpcCall, pools, fromToken, toToken, amountWei, fromDecimals, toDecimals }) {
  const router = new CurveDEXRouter({ rpcCall, pools });
  const amount = ethers.formatUnits(amountWei, fromDecimals);
  const quote = await router.getQuote(fromToken, toToken, amount, fromDecimals, toDecimals);
  return {
    outputAmount: quote.outputAmount,
    outputAmountWei: quote.outputAmountWei,
    rate: quote.rate,
    gas: quote.gas,
    source: quote.source,
  };
}


// ============================================================
// EXPORT (works as both ES module and global)
// ============================================================

// Make available globally for the CurveDEX index.html
if (typeof window !== 'undefined') {
  window.CurveDEXRouter = CurveDEXRouter;
  window.quickQuote = quickQuote;
  window.CURVE_ROUTER_NG = CURVE_ROUTER_NG;
}

// Also support CommonJS import
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CurveDEXRouter, quickQuote, CURVE_ROUTER_NG };
}
