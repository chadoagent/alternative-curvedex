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

// External aggregators moved to aggregators.js (ParaSwap, CoW, ODOS)

// Native ETH placeholder used across DeFi protocols
const ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WETH_ADDRESS = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

// Seed intermediate tokens for multi-hop routing (always included)
// Additional intermediates are discovered dynamically from pool data
const SEED_INTERMEDIATES = [
  { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
  { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
  { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', symbol: 'DAI', decimals: 18 },
  { address: '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', symbol: 'crvUSD', decimals: 18 },
  { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', decimals: 8 },
  { address: '0xD533a949740bb3306d119CC777fa900bA034cd52', symbol: 'CRV', decimals: 18 },
  { address: '0xae78736Cd615f374D3085123A210448E74Fc6393', symbol: 'rETH', decimals: 18 },
  { address: '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', symbol: 'stETH', decimals: 18 },
  { address: '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', symbol: 'wstETH', decimals: 18 },
];

// Minimum pool TVL (USD) to consider for intermediate token discovery
const MIN_TVL_FOR_INTERMEDIATE = 500000; // $500k
// Minimum number of pools a token must appear in to be considered an intermediate
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
// Maximum number of intermediate candidates to try on-chain (performance cap)
const MAX_INTERMEDIATE_CANDIDATES = 8;
// Maximum number of 3-hop paths to try on-chain
const MAX_3HOP_CANDIDATES = 4;
// Split routing grid search: number of ratio steps
const SPLIT_GRID_STEPS = 5; // legacy, kept for reference — replaced by binary search (8 iterations)

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
    // Cache for token decimals
    this._decimalsCache = new Map();
    // Pre-populate known decimals
    SEED_INTERMEDIATES.forEach(t => this._decimalsCache.set(t.address.toLowerCase(), t.decimals));
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
   * Score a quote factoring in estimated gas costs relative to swap value.
   * For large swaps gas is negligible; for small swaps it can dominate.
   * Returns a numeric score — higher is better.
   * @param {Object} quote - Quote result with source, outputAmountWei, gas
   * @returns {number} Gas-adjusted score
   */
  _gasAwareScore(quote) {
    const gasCosts = {
      'curve-direct': 150000,
      'curve-router': 300000,
      'curve-split': 250000,
      'curve-multi-path': 500000,
      'curve-graph-split': 550000,
      'paraswap': 200000,
      'odos': 200000,
      'cow': 0, // solver pays gas
    };
    const gasUsed = quote.gas || gasCosts[quote.source] || 200000;
    const output = parseFloat(quote.outputAmount || '0');
    // Estimate gas cost in USD terms (~30 gwei gas price, ~$2500 ETH)
    const gasCostETH = gasUsed * 30e-9;
    const gasCostUSD = gasCostETH * 2500;
    // Use output as proxy for swap value (most Curve outputs are stablecoins or near-dollar)
    const gasPenaltyPct = Math.min(gasCostUSD / Math.max(output, 1), 0.5); // cap at 50%
    return output * (1 - gasPenaltyPct);
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

    // ETH ↔ WETH special case: bypass Curve entirely, return synthetic 1:1 quote.
    // Direct WETH9 deposit/withdraw — no slippage, no price impact, ~30k gas.
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

    // Launch Curve strategies in parallel with individual timeouts
    const s = this._strategies; // null = all
    const allStrategies = [
      { name: 'curve-direct', fn: () => this._getCurveDirectQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-router', fn: () => this._getCurveRouterQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-split', fn: () => this._getCurveSplitQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-multi-path', fn: () => this._getCurveMultiPathQuote(from, to, amountWei, fromDecimals, toDecimals) },
      { name: 'curve-graph-split', fn: () => this._getCurveGraphSplitQuote(from, to, amountWei, fromDecimals, toDecimals) },
    ];
    const quotePromises = allStrategies
      .filter(st => !s || s.includes(st.name))
      .map(st => this._withTimeout(st.fn(), st.name));
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

    // Sort by gas-aware score (descending) — best quote first
    // Factors in both output amount and estimated gas cost
    quotes.sort((a, b) => {
      const aScore = this._gasAwareScore(a);
      const bScore = this._gasAwareScore(b);
      return bScore - aScore;
    });

    const best = quotes[0];

    // Compute min received with slippage
    const minOutput = BigInt(best.outputAmountWei) * BigInt(Math.floor((1 - slippage / 100) * 10000)) / 10000n;
    best.minOutputWei = minOutput.toString();
    best.minOutput = ethers.formatUnits(minOutput, toDecimals);
    best.slippage = slippage;
    best.allQuotes = quotes; // Include all quotes for comparison UI

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

    switch (quote.source) {
      case 'weth-wrap':
        return this._buildWethWrapTx(quote, userAddress);
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

    // Approve max to save gas on future swaps
    const tx = await token.approve(spender, ethers.MaxUint256);
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
   * Normalize ETH/WETH: treat native ETH and WETH as the same node in graphs.
   * @param {string} addr - lowercase token address
   * @returns {string} normalized address (WETH for both ETH and WETH)
   */
  _normalizeEthWeth(addr) {
    return addr === ETH_ADDRESS.toLowerCase() ? WETH_ADDRESS.toLowerCase() : addr;
  }

  /**
   * Detect ETH ↔ WETH wrap/unwrap. This is not a swap — it's a 1:1 deposit/withdraw
   * on the WETH9 contract. Curve has no pools that ingest one and emit the other,
   * so any "swap" engine returns garbage (revert: Received nothing).
   * Production aggregators (Uniswap UI, 1inch, CowSwap) all detect and shortcut.
   *
   * @param {string} fromAddr - source token address (any case)
   * @param {string} toAddr - destination token address (any case)
   * @returns {'wrap'|'unwrap'|null} 'wrap'=ETH→WETH, 'unwrap'=WETH→ETH, null=not applicable
   */
  _isWrapUnwrap(fromAddr, toAddr) {
    const a = (fromAddr || '').toLowerCase();
    const b = (toAddr || '').toLowerCase();
    const E = ETH_ADDRESS.toLowerCase();
    const W = WETH_ADDRESS.toLowerCase();
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
    return {
      source: 'weth-wrap',
      sourceName: direction === 'wrap' ? 'Wrap (WETH9 deposit)' : 'Unwrap (WETH9 withdraw)',
      fromToken,
      toToken,
      inputAmountWei: amountWei,
      outputAmountWei: amountWei,
      outputAmount: formatted,
      rate: 1,
      priceImpact: 0,
      gas: direction === 'wrap' ? 30000 : 35000, // realistic deposit/withdraw cost
      route: [{
        pool: WETH_ADDRESS,
        poolName: 'WETH9',
        from: fromToken,
        to: toToken,
        iFrom: 0,
        iTo: 0,
        isCrypto: false,
      }],
      _wrapDirection: direction,
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
   * Discover intermediate tokens dynamically from pool data.
   * A token qualifies as an intermediate if it appears in multiple pools
   * with sufficient TVL — indicating it's a good routing hub.
   *
   * Returns merged list: SEED_INTERMEDIATES + discovered tokens, deduplicated.
   * @returns {Array<{address: string, symbol: string, decimals: number}>}
   */
  _getIntermediates() {
    if (this._dynamicIntermediates) return this._dynamicIntermediates;

    // Count how many qualifying pools each token appears in, sum TVL
    const tokenStats = new Map(); // addr -> { count, totalTvl, symbol, decimals }

    for (const pool of this._pools) {
      if (!pool.coinsAddresses) continue;
      const tvl = pool.tvl || 0;
      if (tvl < MIN_TVL_FOR_INTERMEDIATE) continue;

      const coins = pool.coinsAddresses;
      const symbols = pool.coins || [];
      const decimals = pool.coinDecimals || [];

      for (let i = 0; i < coins.length; i++) {
        const addr = coins[i].toLowerCase();
        const stat = tokenStats.get(addr) || {
          count: 0, totalTvl: 0,
          symbol: symbols[i]?.symbol || symbols[i] || '???',
          decimals: decimals[i] || 18,
        };
        stat.count++;
        stat.totalTvl += tvl;
        tokenStats.set(addr, stat);
      }
    }

    // Start with seed intermediates
    const seedSet = new Set(SEED_INTERMEDIATES.map(t => t.address.toLowerCase()));
    const result = [...SEED_INTERMEDIATES];

    // Add discovered tokens that meet criteria
    const discovered = [];
    for (const [addr, stat] of tokenStats) {
      if (seedSet.has(addr)) continue;
      if (stat.count >= MIN_POOLS_FOR_INTERMEDIATE) {
        discovered.push({ address: addr, symbol: stat.symbol, decimals: stat.decimals, totalTvl: stat.totalTvl });
      }
    }

    // Sort discovered by total TVL descending, take top ones
    discovered.sort((a, b) => b.totalTvl - a.totalTvl);
    const maxExtra = 20; // cap dynamic additions
    for (const d of discovered.slice(0, maxExtra)) {
      result.push({ address: d.address, symbol: d.symbol, decimals: d.decimals });
      // Also cache decimals
      this._decimalsCache.set(d.address, d.decimals);
    }

    this._dynamicIntermediates = result;
    console.log(`[CurveDEXRouter] Intermediates: ${SEED_INTERMEDIATES.length} seed + ${Math.min(discovered.length, maxExtra)} discovered = ${result.length} total`);
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

  // ============================================================
  // STRATEGY 1: CURVE DIRECT POOL QUOTES
  // ============================================================

  /**
   * Find the best direct pool swap (single hop, highest TVL pool).
   * Uses on-chain get_dy for accurate pricing.
   */
  async _getCurveDirectQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals) {
    const pool = this._findBestPool(fromToken, toToken);
    if (!pool) return null;

    const { iFrom, iTo, isCrypto } = this._getPoolIndices(pool, fromToken, toToken);
    if (iFrom === -1 || iTo === -1) return null;

    const outputWei = await this._getDy(pool, iFrom, iTo, amountWei);
    if (!outputWei || outputWei <= 0n) return null;

    const outputFormatted = ethers.formatUnits(outputWei, toDecimals);
    const inputFormatted = ethers.formatUnits(amountWei, fromDecimals);
    const rate = parseFloat(outputFormatted) / parseFloat(inputFormatted);

    // Real price impact via curve invariant: simulate dy() for a tiny amount
    // (1 unit) to get spot rate, compare with executed rate.
    // Works for all pair types (stable, crypto, exotic), unlike token-list lookup.
    const priceImpact = await this._computeBaselinePriceImpact(
      rate, [{ pool, iFrom, iTo }],
      () => this._simulateSpotThroughHops([{ pool, iFrom, iTo }], fromDecimals, toDecimals),
    );

    return {
      source: 'curve-direct',
      sourceName: 'Curve Direct',
      fromToken,
      toToken,
      inputAmountWei: amountWei,
      outputAmountWei: outputWei.toString(),
      outputAmount: outputFormatted,
      rate,
      priceImpact,
      gas: 180000,
      route: [{
        pool: pool.address,
        poolName: pool.name,
        from: fromToken,
        to: toToken,
        iFrom,
        iTo,
        isCrypto,
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

    // Find all paths up to 3 hops via BFS on the token graph
    const allPaths = this._findPaths(fromToken, toToken, 3, MAX_INTERMEDIATE_CANDIDATES + MAX_3HOP_CANDIDATES);

    if (allPaths.length === 0) {
      // Fallback: try dynamic intermediates for 2-hop (in case graph is incomplete)
      return this._getCurveRouterQuoteFallback(fromToken, toToken, amountWei, fromDecimals, toDecimals);
    }

    // Separate 2-hop and 3-hop paths
    const paths2hop = allPaths.filter(p => p.length === 2).slice(0, MAX_INTERMEDIATE_CANDIDATES);
    const paths3hop = allPaths.filter(p => p.length === 3).slice(0, MAX_3HOP_CANDIDATES);
    const candidates = [...paths2hop, ...paths3hop];

    if (candidates.length === 0) return null;

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

    const results = (await Promise.allSettled(quotePromises))
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);

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
   * Build transactions for multi-path execution.
   * Each 1-hop path = direct pool exchange.
   * Each 2-hop path = Router NG exchange (atomic multi-hop).
   */
  _buildCurveMultiPathTx(quote, userAddress) {
    const isETH = quote.fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const totalMinOutput = BigInt(quote.minOutputWei);
    const totalOutput = BigInt(quote.outputAmountWei);

    const txs = quote.route.map(pathRoute => {
      const pathOutput = BigInt(pathRoute.outputWei);
      // Proportional min_dy
      const pathMinDy = totalOutput > 0n ? (totalMinOutput * pathOutput / totalOutput) : 0n;

      if (pathRoute.legs.length === 1) {
        // Direct pool swap
        const leg = pathRoute.legs[0];
        const pool = this._pools.find(p => p.address.toLowerCase() === leg.pool.toLowerCase());
        if (!pool) return null;
        const { iFrom, iTo, isCrypto } = this._getPoolIndices(pool, leg.from, leg.to);

        let iface, data;
        if (isCrypto) {
          iface = new ethers.Interface(['function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)']);
          data = iface.encodeFunctionData('exchange', [iFrom, iTo, pathRoute.chunkWei, pathMinDy.toString()]);
        } else {
          iface = new ethers.Interface(['function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) payable returns (uint256)']);
          data = iface.encodeFunctionData('exchange', [iFrom, iTo, pathRoute.chunkWei, pathMinDy.toString()]);
        }

        return {
          to: leg.pool,
          data,
          value: isETH ? BigInt(pathRoute.chunkWei) : 0n,
          gasLimit: 250000,
          _spender: leg.pool,
        };
      } else {
        // Multi-hop via Router NG (reuse Router NG encoding pattern)
        const routeArr = new Array(11).fill(ethers.ZeroAddress);
        const swapParams = Array.from({ length: 5 }, () => [0n, 0n, 0n, 0n, 0n]);

        routeArr[0] = quote.fromToken;
        for (let i = 0; i < pathRoute.legs.length; i++) {
          const leg = pathRoute.legs[i];
          const pool = this._pools.find(p => p.address.toLowerCase() === leg.pool.toLowerCase());
          if (!pool) return null;
          const { iFrom, iTo, isCrypto } = this._getPoolIndices(pool, leg.from, leg.to);
          const nCoins = pool.coinsAddresses ? pool.coinsAddresses.length : 2;
          const poolType = isCrypto ? 2n : 1n;

          routeArr[1 + i * 2] = leg.pool;
          routeArr[2 + i * 2] = i < pathRoute.legs.length - 1 ? pathRoute.legs[i + 1]?.from || leg.to : quote.toToken;
          swapParams[i] = [BigInt(iFrom), BigInt(iTo), 1n, poolType, BigInt(nCoins)];
        }

        const iface = new ethers.Interface([
          'function exchange(address[11] _route, uint256[5][5] _swap_params, uint256 _amount, uint256 _min_dy) payable returns (uint256)',
        ]);
        const data = iface.encodeFunctionData('exchange', [routeArr, swapParams, pathRoute.chunkWei, pathMinDy.toString()]);

        return {
          to: CURVE_ROUTER_NG,
          data,
          value: isETH ? BigInt(pathRoute.chunkWei) : 0n,
          gasLimit: 350000,
          _spender: CURVE_ROUTER_NG,
        };
      }
    }).filter(Boolean);

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

    let iface, data;
    if (isCrypto) {
      iface = new ethers.Interface([
        'function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) payable returns (uint256)',
      ]);
      data = iface.encodeFunctionData('exchange', [
        hop.iFrom, hop.iTo, quote.inputAmountWei, quote.minOutputWei,
      ]);
    } else {
      iface = new ethers.Interface([
        'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) payable returns (uint256)',
      ]);
      data = iface.encodeFunctionData('exchange', [
        hop.iFrom, hop.iTo, quote.inputAmountWei, quote.minOutputWei,
      ]);
    }

    return {
      to: hop.pool,
      data,
      value: isETH ? BigInt(quote.inputAmountWei) : 0n,
      gasLimit: 250000,
      _spender: hop.pool,
    };
  }

  /**
   * Build tx for a direct ETH ↔ WETH wrap/unwrap (no Curve, direct WETH9 call).
   *   ETH → WETH: weth.deposit{value: amount}()       selector 0xd0e30db0
   *   WETH → ETH: weth.withdraw(uint256 wad)          selector 0x2e1a7d4d
   * No approval needed in either direction.
   */
  _buildWethWrapTx(quote, userAddress) {
    const direction = quote._wrapDirection;
    if (direction === 'wrap') {
      const iface = new ethers.Interface(['function deposit() payable']);
      const data = iface.encodeFunctionData('deposit', []);
      return {
        to: WETH_ADDRESS,
        data,
        value: BigInt(quote.inputAmountWei),
        gasLimit: 60000, // empirical: deposit() ≈ 27-50k, headroom for safety
        _spender: null,
      };
    }
    // unwrap: withdraw(uint256)
    const iface = new ethers.Interface(['function withdraw(uint256 wad)']);
    const data = iface.encodeFunctionData('withdraw', [quote.inputAmountWei]);
    return {
      to: WETH_ADDRESS,
      data,
      value: 0n,
      gasLimit: 60000, // withdraw() ≈ 30-40k, headroom for safety
      _spender: null,
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
      gasLimit: 250000 + 150000 * numHops, // base + per-hop
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
        gasLimit: 250000,
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
    // ETH/WETH equivalence — search for both variants
    const ethLower = ETH_ADDRESS.toLowerCase();
    const wethLower = WETH_ADDRESS.toLowerCase();
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
    // ETH/WETH equivalence — search for both variants
    const ethLower = ETH_ADDRESS.toLowerCase();
    const wethLower = WETH_ADDRESS.toLowerCase();
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
      }
    }

    // Sort by TVL descending
    matching.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
    return matching;
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
    // ETH/WETH fallback: if exact address not found, try the other variant
    const ethLower = ETH_ADDRESS.toLowerCase();
    const wethLower = WETH_ADDRESS.toLowerCase();
    if (iFrom === -1 && fromAddr === ethLower) iFrom = addrs.indexOf(wethLower);
    if (iFrom === -1 && fromAddr === wethLower) iFrom = addrs.indexOf(ethLower);
    if (iTo === -1 && toAddr === ethLower) iTo = addrs.indexOf(wethLower);
    if (iTo === -1 && toAddr === wethLower) iTo = addrs.indexOf(ethLower);
    const isCrypto = ['crypto', 'factory-crypto', 'factory-twocrypto', 'factory-tricrypto']
      .includes(pool.registryId);
    return { iFrom, iTo, isCrypto };
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
   * Call get_dy on a pool, trying both int128 and uint256 signatures.
   * Results are cached for 5 seconds to avoid duplicate RPC calls within a quote cycle.
   */
  async _getDy(pool, i, j, amountWei) {
    // Check LRU cache first
    const cacheKey = `${pool.address}:${i}:${j}:${amountWei}`;
    const cached = this._getCachedDy(cacheKey);
    if (cached !== null) return cached;

    const iface128 = new ethers.Interface(['function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)']);
    const iface256 = new ethers.Interface(['function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)']);
    // Max sane value: 2^128 (~340 undecillion) — anything larger is a broken pool
    const MAX_SANE = 2n ** 128n;

    try {
      const result = await this._rpcCall(
        iface128.encodeFunctionData('get_dy', [i, j, amountWei]),
        pool.address
      );
      const value = BigInt(result);
      if (value > MAX_SANE) return null; // broken pool overflow
      this._setCachedDy(cacheKey, value);
      return value;
    } catch {
      try {
        const result = await this._rpcCall(
          iface256.encodeFunctionData('get_dy', [i, j, amountWei]),
          pool.address
        );
        const value = BigInt(result);
        if (value > MAX_SANE) return null; // broken pool overflow
        this._setCachedDy(cacheKey, value);
        return value;
      } catch {
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
    const PEG_WINDOW = 0.01; // ±1% of $1.00
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
        const out = await this._getDy(h.pool, h.iFrom, h.iTo, currentWei);
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
      gasLimit: txData.gas ? parseInt(txData.gas) : 300000,
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
      gasLimit: parseInt(tx.gas) || 300000,
      chainId: this._chainId,
    };
  }

  /**
   * Wrap a promise with a timeout. Returns null on timeout instead of throwing.
   */
  async _withTimeout(promise, label) {
    let settled = false;
    // External aggregators get shorter timeout (5s) — they often fail due to CORS/DNS
    const isExternal = ['paraswap', 'odos', 'cow'].includes(label);
    const timeout = isExternal ? Math.min(this._quoteTimeout, 5000) : this._quoteTimeout;
    return Promise.race([
      promise.then(
        result => { settled = true; return result; },
        err => {
          settled = true;
          // Strategy failures (network, no-route, etc.) are expected — we have multiple
          // strategies racing; one failing is normal. Use debug so it doesn't pollute the
          // console. fetchSwapQuote still gets the null and falls back to other strategies.
          console.debug(`[CurveDEXRouter] ${label} failed:`, err && err.message);
          return null;
        }
      ),
      new Promise(resolve => setTimeout(() => {
        if (!settled) {
          // Timeout is an expected soft-fail in a parallel race — debug, not warn.
          console.debug(`[CurveDEXRouter] ${label} timed out`);
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
