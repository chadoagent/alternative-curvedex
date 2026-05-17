// ============================================================
// PORTFOLIO MODULE — User LP positions dashboard (Phase 0)
// ============================================================
// Reads via Multicall3:
//   - LP token balanceOf(wallet)        (LP in wallet)
//   - Gauge balanceOf(wallet)           (LP staked)
//   - Gauge claimable_tokens(wallet)    (pending CRV)
// Then renders a card grid + total stat bar with bulk Claim All.
//
// Depends on globals from app.js: provider, signer, walletAddress,
// allPools, ethers, ERC20_ABI, GAUGE_ABI, ETH_RPCS,
// fmt$, fmtPct, shortAddr, _tokenIconUrl, _fetchUsdPrice, navigate.

(function (global) {
  'use strict';

  const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
  const MULTICALL3_ABI = [
    'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])',
  ];
  const PORTFOLIO_CACHE_KEY = 'curvedex_portfolio_v1';
  const PORTFOLIO_CACHE_TTL = 5 * 60 * 1000; // 5 min
  const ZERO_ADDR = '0x0000000000000000000000000000000000000000';
  const CRV_ADDR = '0xD533a949740bb3306d119CC777fa900bA034cd52';
  const ETHERSCAN_TX = 'https://etherscan.io/tx/';
  // CRV emissions are minted via the Minter contract, NOT gauge.claim_rewards()
  // (claim_rewards only handles extra reward tokens like FXS sponsor incentives).
  const MINTER_ADDR = '0xd061D61a4d941c39E5453435B6345Dc261C2fcE0';
  const MINTER_ABI = [
    'function mint(address gauge_addr) external',
    'function mint_many(address[8] gauge_addrs) external',
  ];
  // Local extension over GAUGE_ABI from app.js (we add reward_count + allowance here).
  const GAUGE_EXTRA_ABI = [
    'function reward_count() view returns (uint256)',
    'function reward_tokens(uint256) view returns (address)',
    'function claimable_reward(address, address) view returns (uint256)',
  ];

  // -------- Cross-platform: Convex + StakeDAO --------
  // Convex Booster is the central registry for all curve-pool adapters on Convex.
  // poolInfo(pid) → (lptoken, token, gauge, crvRewards, stash, shutdown).
  // crvRewards is the BaseRewardPool address (one per Convex pool).
  const CONVEX_BOOSTER = '0xF403C135812408BFbE8713b5A23a04b3D48AAE31';
  const CONVEX_BOOSTER_ABI = [
    'function poolInfo(uint256 pid) view returns (address lptoken, address token, address gauge, address crvRewards, address stash, bool shutdown)',
  ];
  // BaseRewardPool ABI subset — V1 / legacy form, stable across Convex versions.
  const CONVEX_BRP_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function earned(address) view returns (uint256)',
  ];
  // Standard StakeDAO sd-gauge ABI subset (StakeDAO sd-gauges expose ERC20-like balanceOf for receipt LP).
  const SD_GAUGE_ABI = [
    'function balanceOf(address) view returns (uint256)',
  ];

  // Cache: pid → crvRewards (BaseRewardPool) address. Mostly static — only changes
  // when Convex deploys a new pool or shuts an existing one. Persists for the page session.
  const _convexPidToBRPCache = new Map();
  // Cache: poolAddr (lower) → BaseRewardPool address (post-resolution).
  const _convexPoolToBRPCache = new Map();
  // Concurrency cap for cross-platform multicalls — same as portfolio loader.
  const CROSS_PLATFORM_CONCURRENCY = 3;
  // Pool batch ceiling for cross-platform reads (matches POOLS_PER_BATCH=25 — keeps us well under
  // public RPC eth_call payload caps that have rejected larger Multicall3 payloads in prod).
  const CROSS_PLATFORM_BATCH = 50;

  // Cache of extra reward token info per gauge address (lower-cased).
  // Shape: { tokens: [{ address, symbol, decimals, claimable }] | [] }
  // Cleared on claim or modal-close so users see fresh amounts after re-open.
  const _extrasCache = new Map();

  let _loadInflight = null;
  let _lastPositions = [];
  let _preloadInflight = null;
  let _crossInflight = null;

  // -------- helpers --------
  function _gaugePools() {
    if (!Array.isArray(global.allPools)) return [];
    const pools = global.allPools.filter(p => {
      const g = (p.gaugeAddress || '').toLowerCase();
      return g && g !== ZERO_ADDR && p.lpTokenAddress;
    });
    // Sort by TVL desc so high-value pools render first (incremental UX)
    pools.sort((a, b) => (b.tvl || 0) - (a.tvl || 0));
    return pools;
  }

  function _readCache(addr) {
    try {
      const raw = localStorage.getItem(PORTFOLIO_CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || obj.wallet !== addr.toLowerCase()) return null;
      if (Date.now() - obj.ts > PORTFOLIO_CACHE_TTL) return null;
      _refreshMyPoolSet(obj.positions);
      return obj.positions || [];
    } catch (e) { return null; }
  }
  function _invalidateCache() {
    try { localStorage.removeItem(PORTFOLIO_CACHE_KEY); } catch (e) {}
    global._myPoolAddrs = null;
    if (typeof renderPoolList === 'function') renderPoolList();
  }
  // Expose Set of pool addresses where the connected wallet has any position
  // (LP + staked + cross-platform). Used by app.js getFilteredPools for the
  // "My Assets" filter checkbox without coupling app.js to portfolio internals.
  function _refreshMyPoolSet(positions) {
    if (!Array.isArray(positions)) { global._myPoolAddrs = null; return; }
    const set = new Set();
    for (const p of positions) {
      if (!p || !p.poolAddress) continue;
      const hasCurve = (Number(p.walletLP) > 0) || (Number(p.stakedLP) > 0);
      const hasCvx = p.convex && Number(p.convex.staked) > 0;
      const hasSd = p.stakedao && Number(p.stakedao.staked) > 0;
      if (hasCurve || hasCvx || hasSd) set.add(p.poolAddress.toLowerCase());
    }
    if (typeof console !== 'undefined' && console.debug) {
      console.debug('[portfolio] _refreshMyPoolSet:', set.size, 'pools with positions out of', positions.length);
    }
    global._myPoolAddrs = set;
    if (typeof renderPoolList === 'function') renderPoolList();
  }
  function _writeCache(addr, positions) {
    try {
      localStorage.setItem(PORTFOLIO_CACHE_KEY, JSON.stringify({
        wallet: addr.toLowerCase(),
        ts: Date.now(),
        positions: positions.map(p => ({
          poolAddress: p.poolAddress,
          poolName: p.poolName,
          walletLP: p.walletLP, // string (formatted)
          stakedLP: p.stakedLP,
          totalLP: p.totalLP,
          usdValue: p.usdValue,
          dailyApy: p.dailyApy,
          gaugeCrvApy: p.gaugeCrvApy,
          pendingCRV: p.pendingCRV,
          coinAddrs: p.coinAddrs,
          gaugeAddress: p.gaugeAddress,
          lpTokenAddress: p.lpTokenAddress,
          virtualPrice: p.virtualPrice,
          totalSupplyLP: p.totalSupplyLP,
          // Cross-platform sub-positions (numbers, not BigInt — easier to serialize)
          convex: p.convex ? {
            staked: p.convex.staked, pendingCRV: p.convex.pendingCRV,
            apr: p.convex.apr, pid: p.convex.pid, usd: p.convex.usd,
          } : undefined,
          stakedao: p.stakedao ? {
            staked: p.stakedao.staked, apr: p.stakedao.apr,
            gaugeAddr: p.stakedao.gaugeAddr, lpAddr: p.stakedao.lpAddr,
            usd: p.stakedao.usd,
          } : undefined,
        })),
      }));
      _refreshMyPoolSet(positions);
    } catch (e) { /* localStorage full / disabled — silent */ }
  }

  // Decode a batch of pool results into positions array (mutates output).
  // 4 calls per pool: walletLP, stakedLP, claimable_tokens, totalSupply
  function _decodeBatch(poolsBatch, results, lpIface, gaugeIface, out) {
    for (let i = 0; i < poolsBatch.length; i++) {
      const pool = poolsBatch[i];
      const base = i * 4;
      const r0 = results[base];
      const r1 = results[base + 1];
      const r2 = results[base + 2];
      const r3 = results[base + 3];
      let walletBn = 0n, stakedBn = 0n, pendingBn = 0n, totalSupplyBn = 0n;
      try { if (r0?.success) [walletBn] = lpIface.decodeFunctionResult('balanceOf', r0.returnData); } catch (e) {}
      try { if (r1?.success) [stakedBn] = lpIface.decodeFunctionResult('balanceOf', r1.returnData); } catch (e) {}
      try { if (r2?.success) [pendingBn] = gaugeIface.decodeFunctionResult('claimable_tokens', r2.returnData); } catch (e) {}
      try { if (r3?.success) [totalSupplyBn] = lpIface.decodeFunctionResult('totalSupply', r3.returnData); } catch (e) {}
      if (walletBn === 0n && stakedBn === 0n) continue;

      const totalBn = walletBn + stakedBn;
      const walletLP = parseFloat(global.ethers.formatUnits(walletBn, 18));
      const stakedLP = parseFloat(global.ethers.formatUnits(stakedBn, 18));
      const totalLP = parseFloat(global.ethers.formatUnits(totalBn, 18));
      const pendingCRV = parseFloat(global.ethers.formatUnits(pendingBn, 18));
      const totalSupplyLP = parseFloat(global.ethers.formatUnits(totalSupplyBn, 18));

      // Prefer on-chain totalSupply (works for factory pools where pool.totalSupply=0).
      // Fallback to API totalSupply, then virtualPrice.
      let usdValue = 0;
      if (pool.tvl > 0 && totalSupplyLP > 0) {
        usdValue = totalLP * (pool.tvl / totalSupplyLP);
      } else if (pool.tvl && pool.totalSupply > 0) {
        usdValue = totalLP * (pool.tvl / pool.totalSupply);
      } else if (pool.virtualPrice && pool.virtualPrice > 0) {
        usdValue = totalLP * (pool.virtualPrice / 1e18);
      }

      const coinAddrs = (pool.coinsAddresses || []).filter(a => a && a !== ZERO_ADDR);
      const gaugeApy = Array.isArray(pool.gaugeCrvApy) ? pool.gaugeCrvApy : [0, 0];
      out.push({
        poolAddress: pool.address,
        poolName: pool.name,
        walletLP, stakedLP, totalLP,
        usdValue,
        dailyApy: pool.dailyApy || 0,
        gaugeCrvApy: gaugeApy,
        pendingCRV,
        coinAddrs,
        gaugeAddress: pool.gaugeAddress,
        lpTokenAddress: pool.lpTokenAddress,
        virtualPrice: pool.virtualPrice || 0,
        totalSupplyLP,
      });
    }
  }

  // -------- core: load positions via multicall (parallel batches) --------
  // opts.onProgress(done, total) — called after each batch completes
  // opts.onPartial(positionsSoFar) — called incrementally with merged sorted positions
  async function loadPortfolioPositions(walletAddr, opts) {
    opts = opts || {};
    if (!walletAddr) return [];
    if (typeof global.ethers === 'undefined') {
      console.warn('[portfolio] ethers not loaded');
      return [];
    }
    // Pool of public JsonRpcProviders — round-robin per batch + automatic
    // failover. Never use the wallet's BrowserProvider here (its serial RPC
    // queue would freeze tx submit / signer / balance reads while we load
    // 2000+ pools). batchMaxCount: 1 disables ethers v6 auto-batching so
    // each request is one HTTP POST (fits drpc.org free tier limit of 3
    // batched calls).
    // Wait for the cold-start probe so the provider pool is built in
    // latency-sorted order. Resolves immediately once the warm-up Promise
    // has settled (usually <1.2s on first page load, instant after).
    if (typeof global._warmRpcs === 'function') {
      try { await global._warmRpcs(); } catch { /* non-fatal */ }
    }
    if (!global._portfolioReadProviderPool || !global._portfolioReadProviderPool.length) {
      // Use getOrderedRpcs() so cooldown-demoted endpoints go to the back.
      const rpcs = (typeof global.getOrderedRpcs === 'function')
        ? global.getOrderedRpcs()
        : ((global.ETH_RPCS && global.ETH_RPCS.length)
            ? global.ETH_RPCS
            : ['https://ethereum-rpc.publicnode.com']);
      // staticNetwork: skip _detectNetwork (which retries every 1s on dead
      // RPCs, contributing the bulk of "everything is slow"). We hardcode
      // mainnet (chainId 1) since this dApp is mainnet-only.
      const mainnet = global.ethers.Network.from(1);
      const pool = [];
      const urls = [];
      // Wallet provider first when connected: uses the user's wallet RPC
      // (Rabby/MetaMask premium endpoint), bypasses CORS + per-IP rate
      // limits hitting our public pool from the llama.box origin. Public
      // ETH_RPCS stay as fallback so disconnect-state still works and a
      // wallet-RPC outage transparently rolls onto public providers.
      if (global.provider && typeof global.provider.call === 'function') {
        pool.push(global.provider);
        urls.push(null); // null sentinel skips _markRpc* tracking
      }
      for (const url of rpcs) {
        pool.push(new global.ethers.JsonRpcProvider(url, mainnet, {
          batchMaxCount: 1,
          staticNetwork: mainnet,
        }));
        urls.push(url);
      }
      global._portfolioReadProviderPool = pool;
      // Track URLs alongside providers so portfolio batch can call
      // _markRpcFail with the actual URL on per-provider failure.
      global._portfolioReadProviderUrls = urls;
    }
    const providerPool = global._portfolioReadProviderPool;
    const providerUrls = global._portfolioReadProviderUrls || [];
    const pools = _gaugePools(); // already TVL-sorted desc
    if (pools.length === 0) return [];

    const lpIface = new global.ethers.Interface(global.ERC20_ABI);
    const gaugeIface = new global.ethers.Interface(global.GAUGE_ABI);
    const balanceOfData = lpIface.encodeFunctionData('balanceOf', [walletAddr]);
    const claimableData = gaugeIface.encodeFunctionData('claimable_tokens', [walletAddr]);
    const totalSupplyData = lpIface.encodeFunctionData('totalSupply', []);
    // One Multicall3 contract instance per provider (round-robin pool).
    const multicallByProvider = providerPool.map(p =>
      new global.ethers.Contract(MULTICALL3, MULTICALL3_ABI, p)
    );

    // Pool batch size: 25 pools = 100 calls per multicall (4 calls/pool).
    // Multiple public RPCs (cloudflare-eth, drpc, 1rpc) reject larger
    // multicalls intermittently with "missing revert data" — likely an
    // internal eth_call gas/payload cap. 100 calls per multicall stays
    // well under the limit on every RPC tested. More batches but each
    // one passes on the first try.
    const POOLS_PER_BATCH = 25;
    const poolBatches = [];
    for (let i = 0; i < pools.length; i += POOLS_PER_BATCH) {
      poolBatches.push(pools.slice(i, i + POOLS_PER_BATCH));
    }

    const allPositions = [];
    let done = 0;
    const yieldToUI = () => new Promise(r => setTimeout(r, 0));

    async function runBatch(batch, batchIdx) {
      const calls = [];
      for (const p of batch) {
        calls.push({ target: p.lpTokenAddress, allowFailure: true, callData: balanceOfData });
        calls.push({ target: p.gaugeAddress, allowFailure: true, callData: balanceOfData });
        calls.push({ target: p.gaugeAddress, allowFailure: true, callData: claimableData });
        calls.push({ target: p.lpTokenAddress, allowFailure: true, callData: totalSupplyData });
      }
      // Try up to N RPCs in round-robin order before giving up. This handles
      // per-RPC rate limits AND transient outages — public free-tier RPCs
      // come and go, we can't depend on any single one. When a wallet
      // provider is present (urls[0] === null), it is always attempt #0
      // regardless of batchIdx — round-robin then walks the public pool
      // for fallback only.
      let res = null;
      const MAX_TRIES = providerPool.length;
      const PER_TRY_MS = 2500;
      const _walletFirst = providerUrls[0] === null;
      const _publicLen = _walletFirst ? providerPool.length - 1 : providerPool.length;
      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        let provIdx;
        if (_walletFirst && attempt === 0) {
          provIdx = 0; // wallet provider always tried first
        } else {
          const adj = _walletFirst ? attempt - 1 : attempt;
          provIdx = (_walletFirst ? 1 : 0) + ((batchIdx + adj) % _publicLen);
        }
        try {
          const callPromise = multicallByProvider[provIdx].aggregate3.staticCall(calls);
          const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('rpc-timeout')), PER_TRY_MS)
          );
          res = await Promise.race([callPromise, timeout]);
          // Record success so the cooldown / latency map stays current.
          if (typeof global._markRpcOk === 'function' && providerUrls[provIdx]) {
            global._markRpcOk(providerUrls[provIdx]);
          }
          break;
        } catch (e) {
          const m = (e && e.message) ? String(e.message).slice(0, 120) : 'unknown';
          console.warn(`[portfolio] batch ${batchIdx} via RPC[${provIdx}] failed:`, m);
          // Mark this URL on cooldown so subsequent rpcCall() / future
          // portfolio loads demote it. Persisted across this page session.
          if (typeof global._markRpcFail === 'function' && providerUrls[provIdx]) {
            global._markRpcFail(providerUrls[provIdx]);
          }
          // try next RPC
        }
      }
      if (!res) res = calls.map(() => ({ success: false, returnData: '0x' }));
      const batchPositions = [];
      _decodeBatch(batch, res, lpIface, gaugeIface, batchPositions);
      for (const p of batchPositions) allPositions.push(p);
      done++;
      try { if (opts.onProgress) opts.onProgress(done, poolBatches.length); } catch (e) {}
      // Yield to the browser between batches so clicks/scroll/render get
      // a slice. Without this, ethers' synchronous ABI decoding of 5+
      // concurrent multicalls saturates main thread → "everything frozen".
      await yieldToUI();
    }

    // Low concurrency keeps decode bursts manageable — main thread stays
    // responsive. Round-robin across providerPool spreads load + survives
    // any single RPC dying mid-load.
    const CONCURRENCY = 3;
    let cursor = 0;
    async function worker() {
      while (cursor < poolBatches.length) {
        const idx = cursor++;
        await runBatch(poolBatches[idx], idx);
      }
    }
    const workers = [];
    for (let i = 0; i < Math.min(CONCURRENCY, poolBatches.length); i++) workers.push(worker());
    await Promise.all(workers);
    allPositions.sort((a, b) => b.usdValue - a.usdValue);
    return allPositions;
  }

  // -------- Cross-platform: Convex + StakeDAO --------
  // Returns Maps keyed by lower-case Curve pool address (with lpToken fallback).
  //   convex:   poolAddrLower → { staked: bigint, pendingCRV: bigint, apr: number,
  //                              pid: number, brpAddr: string, lpAddr: string }
  //   stakedao: poolAddrLower → { staked: bigint, apr: number, gaugeAddr: string,
  //                              lpAddr: string }
  // Skips users with zero balances. Failures are swallowed → empty maps.
  // Multicall round trips:
  //   1) Convex Booster.poolInfo(pid) for each pid (batched)                          — once per session, cached
  //   2) Convex BaseRewardPool.balanceOf + cvxLP.balanceOf(wallet), summed per pid    — every load
  //      (covers Booster.deposit(_stake=true) AND Booster.deposit(_stake=false))
  //   3) Convex BaseRewardPool.earned(wallet) for non-zero balances                   — every load
  //   4) StakeDAO sd-gauge.balanceOf + sd-vault.balanceOf(wallet), summed per entry   — every load
  //      (covers auto-stake-on-deposit AND deposit-only-no-stake flows)
  // Total: 3-4 multicall round-trips after first call (1 cached). Adding the
  // BRP+cvxLP and gauge+vault fallbacks roughly doubles balance-query call count
  // — stays under batch=50 ceiling and concurrency=3 caps.
  async function loadCrossPlatformPositions(walletAddr) {
    if (!walletAddr) return { convex: new Map(), stakedao: new Map() };
    if (typeof global.ethers === 'undefined') return { convex: new Map(), stakedao: new Map() };
    if (typeof global.fetchConvexYields !== 'function' || typeof global.fetchStakeDaoYields !== 'function') {
      // yield.js not loaded yet — caller will retry on next refresh.
      return { convex: new Map(), stakedao: new Map() };
    }

    // Reuse the same provider pool so we share connection state with portfolio loads.
    if (typeof global._warmRpcs === 'function') {
      try { await global._warmRpcs(); } catch { /* non-fatal */ }
    }
    if (!global._portfolioReadProviderPool || !global._portfolioReadProviderPool.length) {
      const rpcs = (typeof global.getOrderedRpcs === 'function')
        ? global.getOrderedRpcs()
        : ((global.ETH_RPCS && global.ETH_RPCS.length)
            ? global.ETH_RPCS
            : ['https://ethereum-rpc.publicnode.com']);
      const mainnet = global.ethers.Network.from(1);
      const pool = [];
      const urls = [];
      // Same wallet-first ordering as loadPortfolioPositions — without this the
      // rewards path (Convex/StakeDAO) keeps hammering the public pool even
      // when a wallet is connected, which negates the wallet-primary fix.
      if (global.provider && typeof global.provider.call === 'function') {
        pool.push(global.provider);
        urls.push(null);
      }
      for (const url of rpcs) {
        pool.push(new global.ethers.JsonRpcProvider(url, mainnet, {
          batchMaxCount: 1,
          staticNetwork: mainnet,
        }));
        urls.push(url);
      }
      global._portfolioReadProviderPool = pool;
      global._portfolioReadProviderUrls = urls;
    }
    const providerPool = global._portfolioReadProviderPool;
    const providerUrls = global._portfolioReadProviderUrls || [];
    const multicalls = providerPool.map(p =>
      new global.ethers.Contract(MULTICALL3, MULTICALL3_ABI, p)
    );

    // ---- Convex pid → BaseRewardPool resolution (cached) ----
    const convexMap = await global.fetchConvexYields();
    // Build [{ pid, lpAddr, apr, total }] entries (dedupe on pid — convexMap stores both
    // pool and lp address with same entry, dedupe).
    const cvxByPid = new Map();
    for (const [keyAddr, entry] of convexMap.entries()) {
      if (!entry || entry.pid == null) continue;
      const pid = Number(entry.pid);
      if (!Number.isFinite(pid) || pid < 0) continue;
      if (!cvxByPid.has(pid)) {
        cvxByPid.set(pid, { pid, lpOrPoolAddrs: [keyAddr], total: entry.total });
      } else {
        cvxByPid.get(pid).lpOrPoolAddrs.push(keyAddr);
      }
    }
    const allPids = Array.from(cvxByPid.keys());

    if (allPids.length > 600) {
      // Sanity guard — production has ~530 pids today; cap at 600 leaves headroom but
      // protects against runaway sets. Owner spec used 250 as upper bound concern,
      // but with batch=50 + concurrency=3 we comfortably handle 600 in ~4 round trips.
      console.warn(`[portfolio] Convex pids = ${allPids.length}, capping at 600 for v1 multicall load`);
      allPids.length = 600;
    }

    const boosterIface = new global.ethers.Interface(CONVEX_BOOSTER_ABI);
    const brpIface = new global.ethers.Interface(CONVEX_BRP_ABI);
    const sdIface = new global.ethers.Interface(SD_GAUGE_ABI);

    // Helper: call Multicall3 with round-robin retry. Wallet provider
    // (urls[0] === null) always tried first regardless of batchIdx; public
    // pool round-robins for fallback only. Mirrors loadPortfolioPositions.
    async function _multicallRR(calls, batchIdx) {
      const MAX_TRIES = providerPool.length;
      const PER_TRY_MS = 3000;
      const _walletFirst = providerUrls && providerUrls[0] === null;
      const _publicLen = _walletFirst ? providerPool.length - 1 : providerPool.length;
      for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
        let provIdx;
        if (_walletFirst && attempt === 0) {
          provIdx = 0;
        } else {
          const adj = _walletFirst ? attempt - 1 : attempt;
          provIdx = (_walletFirst ? 1 : 0) + (((batchIdx | 0) + adj) % _publicLen);
        }
        try {
          const callPromise = multicalls[provIdx].aggregate3.staticCall(calls);
          const timeout = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('rpc-timeout')), PER_TRY_MS)
          );
          return await Promise.race([callPromise, timeout]);
        } catch (e) {
          // try next RPC
        }
      }
      return calls.map(() => ({ success: false, returnData: '0x' }));
    }

    // Step 1: poolInfo(pid) for pids whose BRP address isn't cached yet.
    const uncachedPids = allPids.filter(pid => !_convexPidToBRPCache.has(pid));
    if (uncachedPids.length > 0) {
      const piBatches = [];
      for (let i = 0; i < uncachedPids.length; i += CROSS_PLATFORM_BATCH) {
        piBatches.push(uncachedPids.slice(i, i + CROSS_PLATFORM_BATCH));
      }
      // Run batches with bounded concurrency
      let cursor = 0;
      async function piWorker() {
        while (cursor < piBatches.length) {
          const idx = cursor++;
          const batch = piBatches[idx];
          const calls = batch.map(pid => ({
            target: CONVEX_BOOSTER,
            allowFailure: true,
            callData: boosterIface.encodeFunctionData('poolInfo', [pid]),
          }));
          const res = await _multicallRR(calls, idx);
          for (let i = 0; i < batch.length; i++) {
            const pid = batch[i];
            try {
              if (res[i]?.success) {
                const decoded = boosterIface.decodeFunctionResult('poolInfo', res[i].returnData);
                const lpToken = decoded[0];   // Curve LP
                const cvxLP = decoded[1];     // Convex deposit-receipt token (held by user when deposit(_stake=false))
                const brpAddr = decoded[3];   // crvRewards (BaseRewardPool)
                const shutdown = decoded[5];
                _convexPidToBRPCache.set(pid, {
                  brpAddr,
                  lpToken: (lpToken || '').toLowerCase(),
                  cvxLP: (cvxLP || '').toLowerCase(),
                  shutdown: !!shutdown,
                });
              }
            } catch (e) { /* skip pid */ }
          }
        }
      }
      const piWorkers = [];
      for (let i = 0; i < Math.min(CROSS_PLATFORM_CONCURRENCY, piBatches.length); i++) piWorkers.push(piWorker());
      await Promise.all(piWorkers);
    }

    // Filter: pids we have BRP for, not shutdown. Build [{ pid, brp, lpToken, cvxLP, apr }].
    const cvxLive = [];
    for (const pid of allPids) {
      const info = _convexPidToBRPCache.get(pid);
      if (!info || info.shutdown) continue;
      if (!info.brpAddr || info.brpAddr === ZERO_ADDR) continue;
      const meta = cvxByPid.get(pid);
      cvxLive.push({
        pid,
        brpAddr: info.brpAddr,
        lpToken: info.lpToken,
        cvxLP: info.cvxLP || '',
        apr: meta ? (meta.total || 0) : 0,
      });
    }

    // Step 2: BaseRewardPool.balanceOf(wallet) AND cvxLP.balanceOf(wallet) — sum both.
    // Most users deposit via Booster.deposit(pid, amount, _stake=true) → cvxLP auto-stakes
    // into BRP and BRP.balanceOf is canonical. But Booster.deposit(_stake=false) leaves
    // cvxLP in the user's wallet → BRP.balanceOf=0 while the deposit is real.
    // Adding the cvxLP wallet check is a cheap safety net (~doubles call count, still
    // well under the 50-per-batch ceiling and 3-way concurrency).
    const cvxCalls = []; // flat list of {target, allowFailure, callData}
    const cvxCallMeta = []; // parallel: { liveIdx, kind: 'brp'|'cvxLP' }
    for (let li = 0; li < cvxLive.length; li++) {
      const x = cvxLive[li];
      cvxCalls.push({
        target: x.brpAddr,
        allowFailure: true,
        callData: brpIface.encodeFunctionData('balanceOf', [walletAddr]),
      });
      cvxCallMeta.push({ liveIdx: li, kind: 'brp' });
      if (x.cvxLP && x.cvxLP !== ZERO_ADDR && x.cvxLP !== x.brpAddr.toLowerCase()) {
        cvxCalls.push({
          target: x.cvxLP,
          allowFailure: true,
          callData: brpIface.encodeFunctionData('balanceOf', [walletAddr]),
        });
        cvxCallMeta.push({ liveIdx: li, kind: 'cvxLP' });
      }
    }
    // Per-live-entry running totals
    const cvxBalSum = new Array(cvxLive.length).fill(0n);
    {
      const balBatches = [];
      for (let i = 0; i < cvxCalls.length; i += CROSS_PLATFORM_BATCH) {
        balBatches.push({
          calls: cvxCalls.slice(i, i + CROSS_PLATFORM_BATCH),
          metas: cvxCallMeta.slice(i, i + CROSS_PLATFORM_BATCH),
        });
      }
      let cursor = 0;
      async function balWorker() {
        while (cursor < balBatches.length) {
          const idx = cursor++;
          const { calls, metas } = balBatches[idx];
          const res = await _multicallRR(calls, idx);
          for (let i = 0; i < metas.length; i++) {
            try {
              if (res[i]?.success) {
                const [bal] = brpIface.decodeFunctionResult('balanceOf', res[i].returnData);
                if (bal > 0n) cvxBalSum[metas[i].liveIdx] += bal;
              }
            } catch (e) { /* skip */ }
          }
        }
      }
      const ws = [];
      for (let i = 0; i < Math.min(CROSS_PLATFORM_CONCURRENCY, balBatches.length); i++) ws.push(balWorker());
      await Promise.all(ws);
    }
    const cvxNonZero = []; // [{ pid, brpAddr, lpToken, apr, staked }]
    for (let li = 0; li < cvxLive.length; li++) {
      if (cvxBalSum[li] > 0n) cvxNonZero.push({ ...cvxLive[li], staked: cvxBalSum[li] });
    }

    // Step 3: earned(wallet) only for non-zero pids.
    if (cvxNonZero.length > 0) {
      const earnedCalls = cvxNonZero.map(x => ({
        target: x.brpAddr,
        allowFailure: true,
        callData: brpIface.encodeFunctionData('earned', [walletAddr]),
      }));
      const eBatches = [];
      for (let i = 0; i < earnedCalls.length; i += CROSS_PLATFORM_BATCH) {
        eBatches.push({
          calls: earnedCalls.slice(i, i + CROSS_PLATFORM_BATCH),
          items: cvxNonZero.slice(i, i + CROSS_PLATFORM_BATCH),
        });
      }
      let cursor = 0;
      async function eWorker() {
        while (cursor < eBatches.length) {
          const idx = cursor++;
          const { calls, items } = eBatches[idx];
          const res = await _multicallRR(calls, idx);
          for (let i = 0; i < items.length; i++) {
            try {
              if (res[i]?.success) {
                const [earned] = brpIface.decodeFunctionResult('earned', res[i].returnData);
                items[i].pendingCRV = earned;
              }
            } catch (e) { items[i].pendingCRV = 0n; }
          }
        }
      }
      const ws = [];
      for (let i = 0; i < Math.min(CROSS_PLATFORM_CONCURRENCY, eBatches.length); i++) ws.push(eWorker());
      await Promise.all(ws);
    }

    // ---- StakeDAO ----
    // SD users deposit Curve LP into a vault (ERC4626-ish wrapper at `vault` field).
    // Some pools auto-stake into the SD gauge on deposit, others don't:
    //   - staked: vault.balanceOf(user) == 0, gauge.balanceOf(user) > 0
    //   - deposited but not staked: vault.balanceOf(user) > 0, gauge.balanceOf(user) == 0
    // We must sum both balances per entry to detect all positions.
    const sdCache = await global.fetchStakeDaoYields();
    const sdEntries = []; // [{ vaultAddr, gaugeAddr, lpAddr, apr }]
    if (sdCache && sdCache.byGaugeAddr) {
      // Build reverse map: gauge → lp address by reference-equality on entry obj.
      // ingestVault writes the SAME entry object into byLpAddr and byGaugeAddr.
      const lpForGauge = new Map(); // gaugeLower → lpLower
      for (const [lpKey, lpEntry] of sdCache.byLpAddr.entries()) {
        for (const [gKey, gEntry] of sdCache.byGaugeAddr.entries()) {
          if (gEntry === lpEntry) lpForGauge.set(gKey, lpKey);
        }
      }
      for (const [gaugeKey, entry] of sdCache.byGaugeAddr.entries()) {
        if (!entry) continue;
        const vaultAddr = (entry.vault && typeof entry.vault === 'string') ? entry.vault.toLowerCase() : null;
        sdEntries.push({
          gaugeAddr: gaugeKey,
          vaultAddr,
          lpAddr: lpForGauge.get(gaugeKey) || null,
          apr: entry.total || 0,
        });
      }
    }

    const sdNonZero = []; // [{ gaugeAddr, vaultAddr, lpAddr, apr, staked }]
    if (sdEntries.length > 0) {
      // Dedup guard: SD vaults sometimes stake into the NATIVE Curve gauge
      // (no separate sd-gauge — e.g. pool LL-CRV-rec). Reading gauge.balanceOf
      // here AND in the Curve branch double-counts the same balance. Skip the
      // SD-side gauge call when the gauge is shared with a Curve pool.
      const curveGaugesLower = new Set(
        (global.allPools || [])
          .map(p => (p.gaugeAddress || '').toLowerCase())
          .filter(Boolean)
      );
      // Two balanceOf calls per entry (gauge + vault) flattened into one stream.
      const sdCalls = [];
      const sdCallMeta = []; // parallel: { entryIdx, source: 'gauge'|'vault' }
      for (let ei = 0; ei < sdEntries.length; ei++) {
        const e = sdEntries[ei];
        if (e.gaugeAddr && !curveGaugesLower.has(e.gaugeAddr.toLowerCase())) {
          sdCalls.push({
            target: e.gaugeAddr,
            allowFailure: true,
            callData: sdIface.encodeFunctionData('balanceOf', [walletAddr]),
          });
          sdCallMeta.push({ entryIdx: ei, source: 'gauge' });
        }
        if (e.vaultAddr && e.vaultAddr !== e.gaugeAddr) {
          sdCalls.push({
            target: e.vaultAddr,
            allowFailure: true,
            callData: sdIface.encodeFunctionData('balanceOf', [walletAddr]),
          });
          sdCallMeta.push({ entryIdx: ei, source: 'vault' });
        }
      }
      const sdBalSum = new Array(sdEntries.length).fill(0n);
      const sdBatches = [];
      for (let i = 0; i < sdCalls.length; i += CROSS_PLATFORM_BATCH) {
        sdBatches.push({
          calls: sdCalls.slice(i, i + CROSS_PLATFORM_BATCH),
          metas: sdCallMeta.slice(i, i + CROSS_PLATFORM_BATCH),
        });
      }
      let cursor = 0;
      async function sdWorker() {
        while (cursor < sdBatches.length) {
          const idx = cursor++;
          const { calls, metas } = sdBatches[idx];
          const res = await _multicallRR(calls, idx);
          for (let i = 0; i < metas.length; i++) {
            try {
              if (res[i]?.success) {
                const [bal] = sdIface.decodeFunctionResult('balanceOf', res[i].returnData);
                if (bal > 0n) sdBalSum[metas[i].entryIdx] += bal;
              }
            } catch (e) { /* skip */ }
          }
        }
      }
      const ws = [];
      for (let i = 0; i < Math.min(CROSS_PLATFORM_CONCURRENCY, sdBatches.length); i++) ws.push(sdWorker());
      await Promise.all(ws);
      for (let ei = 0; ei < sdEntries.length; ei++) {
        if (sdBalSum[ei] > 0n) sdNonZero.push({ ...sdEntries[ei], staked: sdBalSum[ei] });
      }
    }

    // ---- Build output maps keyed by Curve pool address (allPools-resolved) ----
    // We need to map LP token → Curve pool address. Use allPools.
    const lpToCurvePool = new Map(); // lpLower → poolAddrLower
    const allPoolAddrs = new Set();  // poolLower
    for (const p of (global.allPools || [])) {
      const poolLower = (p.address || '').toLowerCase();
      if (!poolLower) continue;
      allPoolAddrs.add(poolLower);
      const lpLower = (p.lpTokenAddress || '').toLowerCase();
      if (lpLower) lpToCurvePool.set(lpLower, poolLower);
      // factory pools have lp == pool — also map pool address itself
      lpToCurvePool.set(poolLower, poolLower);
    }

    const convexOut = new Map();
    for (const it of cvxNonZero) {
      const lp = it.lpToken;
      const poolLower = lpToCurvePool.get(lp) || lp;
      // Convex stake page uses pid — keep it for link.
      convexOut.set(poolLower, {
        staked: it.staked,
        pendingCRV: it.pendingCRV || 0n,
        apr: it.apr || 0,
        pid: it.pid,
        brpAddr: it.brpAddr,
        lpAddr: lp,
      });
    }
    const stakedaoOut = new Map();
    for (const it of sdNonZero) {
      const lp = it.lpAddr;
      const poolLower = lp ? (lpToCurvePool.get(lp) || lp) : (it.gaugeAddr); // last-resort key
      stakedaoOut.set(poolLower, {
        staked: it.staked,
        apr: it.apr || 0,
        gaugeAddr: it.gaugeAddr,
        lpAddr: lp,
      });
    }

    return { convex: convexOut, stakedao: stakedaoOut };
  }

  // -------- rendering --------
  function _skeletonHTML(n) {
    let out = '';
    for (let i = 0; i < n; i++) {
      out += `<div class="position-card position-card-skeleton">
        <div class="pc-skel pc-skel-line" style="width:60%"></div>
        <div class="pc-skel pc-skel-line" style="width:40%"></div>
        <div class="pc-skel pc-skel-line" style="width:80%"></div>
        <div class="pc-skel pc-skel-line" style="width:50%"></div>
      </div>`;
    }
    return out;
  }

  function _emptyHTML() {
    return `<div class="portfolio-empty">
      <div class="portfolio-empty-icon"><svg class="icon"><use href="#icon-chart-bar"/></svg></div>
      <h3>No positions yet</h3>
      <p>You haven't provided liquidity to any Curve pools.</p>
      <button class="portfolio-empty-btn" onclick="navigate('#/yield')">Browse pools &rarr;</button>
    </div>`;
  }

  function _coinIconsHTML(coinAddrs) {
    if (!coinAddrs || !coinAddrs.length) return '';
    return `<div class="pc-coin-icons">${coinAddrs.slice(0, 4).map(a =>
      `<img src="${global._tokenIconUrl(a)}" onerror="this.style.display='none'" alt="">`
    ).join('')}</div>`;
  }

  // Render one platform sub-row inside a position card.
  // platform: 'curve' | 'convex' | 'stakedao'
  function _renderSubRow(p, idx, platform) {
    let lpAmount = 0, aprText = '', pendingText = '', manageHTML = '', label = '';
    if (platform === 'curve') {
      const wallet = p.walletLP || 0;
      const staked = p.stakedLP || 0;
      lpAmount = wallet + staked;
      label = '<span class="pc-src pc-src-curve">Curve</span>';
      const aprParts = [];
      if (p.dailyApy > 0) aprParts.push(`vAPY ${global.fmtPct(p.dailyApy)}`);
      if (Array.isArray(p.gaugeCrvApy)) {
        const lo = p.gaugeCrvApy[0] || 0;
        const hi = p.gaugeCrvApy[1] || 0;
        if (lo > 0 || hi > 0) {
          aprParts.push(`tAPR ${lo === hi ? global.fmtPct(lo) : `${lo.toFixed(2)}-${global.fmtPct(hi)}`}`);
        }
      }
      aprText = aprParts.join(' · ');
      const breakdown = [];
      if (wallet > 0) breakdown.push(`${wallet.toFixed(4)} wallet`);
      if (staked > 0) breakdown.push(`${staked.toFixed(4)} staked`);
      const breakdownText = breakdown.length ? ` <span class="pc-sub-breakdown">(${breakdown.join(' + ')})</span>` : '';
      const hasPending = p.pendingCRV > 0;
      pendingText = hasPending ? `<span class="pc-sub-pending">+${p.pendingCRV.toFixed(4)} CRV pending</span>` : '';
      const lpHTML = lpAmount > 0
        ? `<span class="pc-sub-lp">${lpAmount.toFixed(4)} LP</span>${breakdownText}`
        : '<span class="pc-bal-zero" style="font-size:11px">0 LP</span>';
      const aprHTML = aprText ? `<span class="pc-sub-apr">@ ${aprText}</span>` : '';
      const manage = (lpAmount > 0 || hasPending)
        ? `<button class="pc-sub-manage" onclick="Portfolio.openManageModal(${idx})" title="Manage on Curve">Manage</button>`
        : '';
      return `<div class="pc-sub-row pc-sub-curve">
        <div class="pc-sub-main">${label}${lpHTML}${aprHTML}</div>
        <div class="pc-sub-extras">${pendingText}${manage}</div>
      </div>`;
    }
    if (platform === 'convex' && p.convex) {
      const c = p.convex;
      label = '<span class="pc-src pc-src-convex">Convex</span>';
      const lpHTML = `<span class="pc-sub-lp">${c.staked.toFixed(4)} LP</span>`;
      const aprHTML = c.apr > 0 ? `<span class="pc-sub-apr">@ ${global.fmtPct(c.apr)}</span>` : '';
      const pendingHTML = c.pendingCRV > 0 ? `<span class="pc-sub-pending">+${c.pendingCRV.toFixed(4)} CRV pending</span>` : '';
      const url = c.pid != null ? `https://www.convexfinance.com/stake/ethereum/${c.pid}` : 'https://www.convexfinance.com/stake';
      const manageHTML = `<a class="pc-sub-manage pc-sub-manage-link" href="${url}" target="_blank" rel="noopener" title="Manage on Convex Finance">Manage &#8599;</a>`;
      return `<div class="pc-sub-row pc-sub-convex">
        <div class="pc-sub-main">${label}${lpHTML}${aprHTML}</div>
        <div class="pc-sub-extras">${pendingHTML}${manageHTML}</div>
      </div>`;
    }
    if (platform === 'stakedao' && p.stakedao) {
      const s = p.stakedao;
      label = '<span class="pc-src pc-src-stakedao">StakeDAO</span>';
      const lpHTML = `<span class="pc-sub-lp">${s.staked.toFixed(4)} LP</span>`;
      const aprHTML = s.apr > 0 ? `<span class="pc-sub-apr">@ ${global.fmtPct(s.apr)}</span>` : '';
      const lpForUrl = (s.lpAddr || p.lpTokenAddress || '').toLowerCase();
      const url = lpForUrl
        ? `https://www.stakedao.org/yield?protocol=curve&search=${lpForUrl}`
        : 'https://www.stakedao.org/yield';
      const manageHTML = `<a class="pc-sub-manage pc-sub-manage-link" href="${url}" target="_blank" rel="noopener" title="Manage on StakeDAO">Manage &#8599;</a>`;
      return `<div class="pc-sub-row pc-sub-stakedao">
        <div class="pc-sub-main">${label}${lpHTML}${aprHTML}</div>
        <div class="pc-sub-extras">${manageHTML}</div>
      </div>`;
    }
    return '';
  }

  function _renderPositionCard(p, idx) {
    // Build sub-rows for each platform user has presence on.
    const rows = [];
    // Curve sub-row appears if user has any Curve LP (wallet OR staked) OR pending CRV.
    if ((p.walletLP || 0) > 0 || (p.stakedLP || 0) > 0 || (p.pendingCRV || 0) > 0) {
      rows.push(_renderSubRow(p, idx, 'curve'));
    }
    if (p.convex && p.convex.staked > 0) rows.push(_renderSubRow(p, idx, 'convex'));
    if (p.stakedao && p.stakedao.staked > 0) rows.push(_renderSubRow(p, idx, 'stakedao'));
    // Edge case: nothing to show — shouldn't happen but render minimal placeholder.
    if (rows.length === 0) {
      rows.push('<div class="pc-sub-row pc-sub-curve"><div class="pc-sub-main"><span class="pc-bal-zero">No LP</span></div></div>');
    }

    // Bulk Claim CRV (Curve gauge) only if pending CRV from Curve gauge > 0.
    const hasPending = p.pendingCRV > 0;
    const claimBtn = hasPending
      ? `<button class="pc-btn pc-btn-claim" onclick="Portfolio.claimOne(${idx})" title="Claim CRV from Curve gauge">Claim ${p.pendingCRV.toFixed(2)} CRV</button>`
      : '';

    // Escape API-sourced poolName before any DOM interpolation. poolAddress
    // is hex from on-chain — left as-is but treated as untrusted in attrs.
    const _esc = (typeof window !== 'undefined' && window.escapeHtml) ? window.escapeHtml : (s => String(s == null ? '' : s));
    const safePoolName = _esc(p.poolName);
    return `<div class="position-card" data-pool="${p.poolAddress}">
      <div class="pc-head">
        ${_coinIconsHTML(p.coinAddrs)}
        <div class="pc-title-block">
          <div class="pc-title" title="${safePoolName}">${safePoolName}</div>
          <a class="pc-pool-link" href="#/yield/${p.poolAddress}" title="Open pool">View pool &rarr;</a>
        </div>
        <div class="pc-usd">${global.fmt$(p.usdValue)}</div>
      </div>
      <div class="pc-sub-rows">${rows.join('')}</div>
      ${claimBtn ? `<div class="pc-actions">${claimBtn}</div>` : ''}
    </div>`;
  }

  function _renderStatBar(positions) {
    // Total Portfolio = sum of usdValue (already merged across Curve+Convex+SD per pool).
    const totalUsd = positions.reduce((s, p) => s + (p.usdValue || 0), 0);
    // Pending CRV: sum across Curve gauge + Convex BaseRewardPool.
    const totalCrv = positions.reduce((s, p) => {
      let v = (p.pendingCRV || 0);
      if (p.convex && p.convex.pendingCRV) v += p.convex.pendingCRV;
      return s + v;
    }, 0);
    // Claim All only acts on Curve gauge (Convex CRV is claimed via Convex contract — not in scope for v1).
    const claimable = positions.filter(p => p.pendingCRV > 0).length;
    const claimAllDisabled = claimable === 0 ? 'disabled' : '';
    return `<div class="portfolio-stat-bar">
      <div class="ps-stat">
        <span class="ps-label">Total Portfolio</span>
        <span class="ps-value">${global.fmt$(totalUsd)}</span>
      </div>
      <div class="ps-stat">
        <span class="ps-label">Pending CRV</span>
        <span class="ps-value ps-value-green">${totalCrv.toFixed(4)}</span>
      </div>
      <div class="ps-stat">
        <span class="ps-label">Positions</span>
        <span class="ps-value">${positions.length}</span>
      </div>
      <button class="ps-claim-all" ${claimAllDisabled} onclick="Portfolio.claimAll()" title="Claims CRV from Curve gauges only (use Convex.com for Convex rewards)">Claim All (${claimable})</button>
    </div>`;
  }

  function _renderInto(container, positions, opts) {
    opts = opts || {};
    const cached = !!opts.cached;
    const progress = opts.progress; // {done, total} or null
    let banner = '';
    if (cached) {
      banner = '<div class="portfolio-stale">Cached data &mdash; refreshing&hellip;</div>';
    } else if (progress && progress.done < progress.total) {
      banner = `<div class="portfolio-stale">Scanning ${progress.done}/${progress.total} pool batches&hellip;</div>`;
    }
    if (positions.length === 0) {
      container.innerHTML = banner + _renderStatBar([]) + _emptyHTML();
      return;
    }
    const cards = positions.map((p, i) => _renderPositionCard(p, i)).join('');
    container.innerHTML = banner + _renderStatBar(positions) + `<div class="position-grid">${cards}</div>`;
  }

  // -------- merge: Curve + Convex + StakeDAO into unified positions --------
  // Each position is keyed by Curve pool address. If user has only Curve, behavior
  // unchanged. If user has Convex/SD on a Curve pool that's NOT in Curve positions
  // (i.e. zero LP in Curve gauge but staked on Convex), we synthesize a new card
  // with curve.staked=0 + cross-platform sub-row.
  function _mergeCrossPlatform(positions, cross) {
    if (!cross) return positions;
    const cvxMap = cross.convex || new Map();
    const sdMap = cross.stakedao || new Map();

    // Index existing positions by lowercase pool address
    const byPool = new Map();
    for (const p of positions) {
      byPool.set((p.poolAddress || '').toLowerCase(), p);
    }

    // Helper: extract apy estimate for a synthesized "Curve-only" pool that we need
    // to attach Convex/SD to (when user has zero Curve LP).
    function _findPoolMeta(poolLower) {
      const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === poolLower);
      return pool || null;
    }

    function _attachCvx(target, entry) {
      // entry.staked is BigInt LP wei; pendingCRV BigInt (or 0n).
      const staked = parseFloat(global.ethers.formatUnits(entry.staked, 18));
      const pendingCRV = entry.pendingCRV ? parseFloat(global.ethers.formatUnits(entry.pendingCRV, 18)) : 0;
      // USD value: same per-LP price as Curve sub-row (totalSupplyLP from on-chain, fallback to virtualPrice)
      let perLpUsd = 0;
      if (target.totalSupplyLP > 0 && target.usdValue > 0 && target.totalLP > 0) {
        perLpUsd = target.usdValue / target.totalLP;
      } else if (target.virtualPrice > 0) {
        perLpUsd = target.virtualPrice / 1e18;
      } else {
        const pool = _findPoolMeta((target.poolAddress || '').toLowerCase());
        if (pool && pool.totalSupply > 0 && pool.tvl > 0) perLpUsd = pool.tvl / pool.totalSupply;
        else if (pool && pool.virtualPrice > 0) perLpUsd = pool.virtualPrice / 1e18;
      }
      const usd = staked * perLpUsd;
      target.convex = {
        staked,
        pendingCRV,
        apr: entry.apr || 0,
        pid: entry.pid,
        usd,
      };
      // Header USD sums across platforms.
      target.usdValue = (target.usdValue || 0) + usd;
    }

    function _attachSd(target, entry) {
      const staked = parseFloat(global.ethers.formatUnits(entry.staked, 18));
      let perLpUsd = 0;
      if (target.totalSupplyLP > 0 && target.usdValue > 0 && target.totalLP > 0) {
        perLpUsd = target.usdValue / target.totalLP;
      } else if (target.virtualPrice > 0) {
        perLpUsd = target.virtualPrice / 1e18;
      } else {
        const pool = _findPoolMeta((target.poolAddress || '').toLowerCase());
        if (pool && pool.totalSupply > 0 && pool.tvl > 0) perLpUsd = pool.tvl / pool.totalSupply;
        else if (pool && pool.virtualPrice > 0) perLpUsd = pool.virtualPrice / 1e18;
      }
      const usd = staked * perLpUsd;
      target.stakedao = {
        staked,
        apr: entry.apr || 0,
        gaugeAddr: entry.gaugeAddr,
        lpAddr: entry.lpAddr,
        usd,
      };
      target.usdValue = (target.usdValue || 0) + usd;
    }

    // Synthesize a position for a pool we don't have yet (user has cvx/sd but no Curve LP).
    function _synthesize(poolLower) {
      const pool = _findPoolMeta(poolLower);
      if (!pool) return null;
      const coinAddrs = (pool.coinsAddresses || []).filter(a => a && a !== ZERO_ADDR);
      const gaugeApy = Array.isArray(pool.gaugeCrvApy) ? pool.gaugeCrvApy : [0, 0];
      return {
        poolAddress: pool.address,
        poolName: pool.name,
        walletLP: 0, stakedLP: 0, totalLP: 0,
        usdValue: 0,
        dailyApy: pool.dailyApy || 0,
        gaugeCrvApy: gaugeApy,
        pendingCRV: 0,
        coinAddrs,
        gaugeAddress: pool.gaugeAddress,
        lpTokenAddress: pool.lpTokenAddress,
        virtualPrice: pool.virtualPrice || 0,
        totalSupplyLP: 0,
      };
    }

    // Attach Convex
    for (const [poolLower, entry] of cvxMap.entries()) {
      let target = byPool.get(poolLower);
      if (!target) {
        target = _synthesize(poolLower);
        if (!target) continue;
        positions.push(target);
        byPool.set(poolLower, target);
      }
      _attachCvx(target, entry);
    }
    // Attach StakeDAO
    for (const [poolLower, entry] of sdMap.entries()) {
      let target = byPool.get(poolLower);
      if (!target) {
        target = _synthesize(poolLower);
        if (!target) continue;
        positions.push(target);
        byPool.set(poolLower, target);
      }
      _attachSd(target, entry);
    }

    positions.sort((a, b) => (b.usdValue || 0) - (a.usdValue || 0));
    return positions;
  }

  // Helper: load both Curve + cross-platform in parallel, then merge.
  // Returns merged positions array (Curve cards augmented with .convex / .stakedao).
  async function _loadAllPositions(walletAddr) {
    const [curvePositions, cross] = await Promise.all([
      loadPortfolioPositions(walletAddr),
      loadCrossPlatformPositions(walletAddr).catch(e => {
        console.warn('[portfolio] cross-platform load failed:', e?.message);
        return { convex: new Map(), stakedao: new Map() };
      }),
    ]);
    return _mergeCrossPlatform(curvePositions, cross);
  }

  // -------- public: silent preload (background, after wallet connect) --------
  // Fires from app.js after connectWallet/auto-reconnect/accountsChanged so that
  // by the time the user clicks Dashboard, the cache is warm. Non-blocking,
  // de-duplicated by _preloadInflight, errors swallowed.
  async function _preloadPositions() {
    if (!global.walletAddress) return null;
    if (_preloadInflight) return _preloadInflight;
    if (_loadInflight) return _loadInflight; // open() already running, no need to duplicate
    _preloadInflight = (async () => {
      try {
        const addr = global.walletAddress;
        const positions = await _loadAllPositions(addr);
        // Wallet may have changed mid-flight — only cache if still same address
        if (global.walletAddress && global.walletAddress.toLowerCase() === addr.toLowerCase()) {
          _lastPositions = positions;
          _writeCache(addr, positions);
        }
        return positions;
      } catch (e) {
        console.debug('[portfolio] preload failed:', e?.message);
        return null;
      } finally {
        _preloadInflight = null;
      }
    })();
    return _preloadInflight;
  }

  // -------- public: open dashboard --------
  async function openPortfolio() {
    // Write into #portfolio-content (child of view-portfolio). The wrapper +
    // static header live in index.html so switchView paints them instantly
    // before openPortfolio fires async work.
    const view = document.getElementById('portfolio-content')
      || document.getElementById('view-portfolio'); // fallback if HTML not updated
    if (!view) return;
    if (!global.walletAddress) {
      view.innerHTML = `<div class="portfolio-empty">
        <h3>Wallet not connected</h3>
        <p>Connect your wallet to see your positions.</p>
      </div>`;
      return;
    }
    // Show cached immediately if present
    const cached = _readCache(global.walletAddress);
    if (cached && cached.length) {
      _lastPositions = cached;
      _renderInto(view, cached, { cached: true });
    } else {
      view.innerHTML = `<div class="portfolio-loading">
        <div class="portfolio-loading-banner">
          <span class="spinner" aria-hidden="true"></span>
          <span>Loading your positions&hellip;</span>
        </div>
        ${_renderStatBar([])}
        <div class="position-grid">${_skeletonHTML(4)}</div>
      </div>`;
    }
    // Refresh
    if (_loadInflight) return _loadInflight;
    // If a silent background preload is already in flight, render its result
    // when it lands instead of starting a duplicate multicall.
    if (_preloadInflight && (!cached || !cached.length)) {
      const inflight = _preloadInflight;
      _loadInflight = (async () => {
        try {
          const positions = await inflight;
          if (positions) {
            _lastPositions = positions;
            _renderInto(view, positions);
          }
        } finally {
          _loadInflight = null;
        }
      })();
      return _loadInflight;
    }
    _loadInflight = (async () => {
      try {
        // No onPartial: per-batch DOM rewrites (29 innerHTML writes for 2160
        // pools) caused visible UI choppiness. Single render after all
        // batches resolve. With public RPC + Multicall3 this takes 1-3s.
        // Cross-platform (Convex + StakeDAO) fires in parallel inside _loadAllPositions.
        const positions = await _loadAllPositions(global.walletAddress);
        _lastPositions = positions;
        _writeCache(global.walletAddress, positions);
        _renderInto(view, positions);
      } catch (e) {
        console.error('[portfolio] load failed', e);
        if (!cached || !cached.length) {
          view.innerHTML = `<div class="portfolio-empty">
            <h3>Could not load positions</h3>
            <p>${(e && e.message) || 'Unknown error'}</p>
            <button class="portfolio-empty-btn" onclick="Portfolio.open()">Retry</button>
          </div>`;
        }
      } finally {
        _loadInflight = null;
      }
    })();
    return _loadInflight;
  }

  // -------- actions --------
  // Always fetch a fresh signer at tx time so that account switches in the wallet
  // (Rabby / MetaMask) don't cause "from should be same as current address" errors.
  // BrowserProvider handles account switches transparently; signer is what changes.
  async function _ensureSigner() {
    if (!global.walletAddress) {
      if (typeof global.connectWallet === 'function') await global.connectWallet();
      if (!global.walletAddress) return null;
    }
    if (!window.ethereum || !global.ethers) return null;
    try {
      const provider = new global.ethers.BrowserProvider(window.ethereum);
      const signer = await provider.getSigner();
      global.signer = signer; // keep cache up-to-date for non-tx code paths
      return signer;
    } catch (e) {
      console.error('[portfolio] getSigner failed', e);
      return null;
    }
  }

  // Fetch extra reward tokens for a gauge in a single Multicall3 round-trip:
  //   1) reward_count
  //   2) reward_tokens(0..N-1) + claimable_reward(wallet, token_i) + symbol(token_i) + decimals(token_i)
  // Returns { tokens: [{ address, symbol, decimals, claimable (number) }] }.
  // Returns { tokens: [] } if gauge has no reward_count or extras enumeration fails.
  // Cached per gauge until invalidated.
  async function _fetchExtras(gaugeAddr, walletAddr) {
    const key = (gaugeAddr || '').toLowerCase();
    if (_extrasCache.has(key)) return _extrasCache.get(key);
    if (!global.ethers || !walletAddr) return { tokens: [] };
    try {
      const provider = global.provider
        || global._portfolioReadProvider
        || (global._portfolioReadProviderPool ? global._portfolioReadProviderPool[0] : null)
        || (window.ethereum ? new global.ethers.BrowserProvider(window.ethereum) : null);
      if (!provider) return { tokens: [] };

      const gaugeIface = new global.ethers.Interface(
        global.GAUGE_ABI.concat(GAUGE_EXTRA_ABI)
      );
      const erc20Iface = new global.ethers.Interface(
        global.ERC20_ABI.concat(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])
      );
      const multicall = new global.ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);

      // Step 1: reward_count
      const rcCall = [{
        target: gaugeAddr,
        allowFailure: true,
        callData: gaugeIface.encodeFunctionData('reward_count', []),
      }];
      const rcRes = await multicall.aggregate3.staticCall(rcCall);
      let count = 0n;
      try { if (rcRes[0]?.success) [count] = gaugeIface.decodeFunctionResult('reward_count', rcRes[0].returnData); } catch (e) {}
      const n = Number(count);
      if (!n || n <= 0) {
        const result = { tokens: [] };
        _extrasCache.set(key, result);
        return result;
      }

      // Step 2: reward_tokens(i) for i in [0, n)
      const tokenCalls = [];
      for (let i = 0; i < n; i++) {
        tokenCalls.push({
          target: gaugeAddr,
          allowFailure: true,
          callData: gaugeIface.encodeFunctionData('reward_tokens', [i]),
        });
      }
      const tokenRes = await multicall.aggregate3.staticCall(tokenCalls);
      const tokenAddrs = [];
      for (let i = 0; i < n; i++) {
        try {
          if (tokenRes[i]?.success) {
            const [t] = gaugeIface.decodeFunctionResult('reward_tokens', tokenRes[i].returnData);
            if (t && t !== ZERO_ADDR) tokenAddrs.push(t);
          }
        } catch (e) {}
      }
      if (tokenAddrs.length === 0) {
        const result = { tokens: [] };
        _extrasCache.set(key, result);
        return result;
      }

      // Step 3: per token — claimable_reward + symbol + decimals (single multicall)
      const detailCalls = [];
      for (const t of tokenAddrs) {
        detailCalls.push({
          target: gaugeAddr,
          allowFailure: true,
          callData: gaugeIface.encodeFunctionData('claimable_reward', [walletAddr, t]),
        });
        detailCalls.push({
          target: t,
          allowFailure: true,
          callData: erc20Iface.encodeFunctionData('symbol', []),
        });
        detailCalls.push({
          target: t,
          allowFailure: true,
          callData: erc20Iface.encodeFunctionData('decimals', []),
        });
      }
      const detailRes = await multicall.aggregate3.staticCall(detailCalls);

      const tokens = tokenAddrs.map((addr, i) => {
        const off = i * 3;
        let claimableBn = 0n, symbol = addr.slice(0, 6) + '…', decimals = 18;
        try { if (detailRes[off]?.success) [claimableBn] = gaugeIface.decodeFunctionResult('claimable_reward', detailRes[off].returnData); } catch (e) {}
        try { if (detailRes[off + 1]?.success) [symbol] = erc20Iface.decodeFunctionResult('symbol', detailRes[off + 1].returnData); } catch (e) {}
        try { if (detailRes[off + 2]?.success) [decimals] = erc20Iface.decodeFunctionResult('decimals', detailRes[off + 2].returnData); } catch (e) {}
        const claimable = parseFloat(global.ethers.formatUnits(claimableBn, Number(decimals)));
        return { address: addr, symbol: String(symbol), decimals: Number(decimals), claimable };
      });
      const result = { tokens };
      _extrasCache.set(key, result);
      return result;
    } catch (e) {
      console.debug('[portfolio] _fetchExtras failed:', e?.shortMessage || e?.message);
      return { tokens: [] };
    }
  }

  // Best-effort: claim extra reward tokens (FXS-style sponsor incentives) from a gauge.
  // Only invokes claim_rewards() when reward_count > 0; silently skips if missing.
  async function _claimExtrasBestEffort(gaugeAddr, signer) {
    try {
      const gauge = new global.ethers.Contract(gaugeAddr, global.GAUGE_ABI, signer);
      let hasExtras = false;
      try {
        const rc = await gauge.reward_count();
        hasExtras = rc > 0n;
      } catch (e) { /* method missing on this gauge — skip */ }
      if (hasExtras) {
        const txClaim = await gauge.claim_rewards();
        await txClaim.wait();
      }
    } catch (e) {
      console.debug('[portfolio] extras claim skipped:', e?.shortMessage || e?.message);
    }
  }

  async function claimOne(idx) {
    const p = _lastPositions[idx];
    if (!p || p.pendingCRV <= 0) return;
    const signer = await _ensureSigner();
    if (!signer) return;
    try {
      // CRV emissions: Minter.mint(gauge) — NOT gauge.claim_rewards() (that's for extras only).
      const minter = new global.ethers.Contract(MINTER_ADDR, MINTER_ABI, signer);
      const tx = await minter.mint(p.gaugeAddress);
      console.log('[portfolio] mint sent', tx.hash, ETHERSCAN_TX + tx.hash);
      await tx.wait();
      await _claimExtrasBestEffort(p.gaugeAddress, signer);
      await openPortfolio();
    } catch (e) {
      console.error('[portfolio] claim failed', e);
      alert('Claim failed: ' + ((e && (e.shortMessage || e.message)) || e));
    }
  }

  async function claimAll() {
    const signer = await _ensureSigner();
    if (!signer) return;
    const claimable = _lastPositions.filter(p => p.pendingCRV > 0);
    if (claimable.length === 0) return;
    // Minter.mint_many takes batches of 8 gauges per tx — much cheaper than N individual mints.
    const batches = Math.ceil(claimable.length / 8);
    const ok = confirm(`Claim CRV from ${claimable.length} gauge${claimable.length === 1 ? '' : 's'}?\n${batches} transaction${batches === 1 ? '' : 's'} (Minter.mint_many, batched in 8s).`);
    if (!ok) return;
    const minter = new global.ethers.Contract(MINTER_ADDR, MINTER_ABI, signer);
    let success = 0, failed = 0;
    for (let i = 0; i < claimable.length; i += 8) {
      const slice = claimable.slice(i, i + 8);
      const batch = slice.map(p => p.gaugeAddress);
      while (batch.length < 8) batch.push(ZERO_ADDR);
      try {
        const tx = await minter.mint_many(batch);
        await tx.wait();
        success += slice.length;
      } catch (e) {
        console.warn('[portfolio] mint_many batch failed', e?.message);
        failed += slice.length;
      }
    }
    // Best-effort: claim extra rewards per gauge sequentially (failures swallowed).
    for (const p of claimable) {
      await _claimExtrasBestEffort(p.gaugeAddress, signer);
    }
    if (failed > 0) alert(`Claimed ${success}/${claimable.length}. ${failed} failed (see console).`);
    await openPortfolio();
  }

  function gotoStake(poolAddr) {
    if (typeof global.navigate === 'function') global.navigate('#/yield/' + poolAddr);
    setTimeout(() => {
      if (typeof global.switchYieldTab === 'function') global.switchYieldTab('stake');
    }, 300);
  }
  function gotoUnstake(poolAddr) {
    if (typeof global.navigate === 'function') global.navigate('#/yield/' + poolAddr);
    setTimeout(() => {
      if (typeof global.switchYieldTab === 'function') global.switchYieldTab('withdraw');
    }, 300);
  }

  // -------- inline stake/unstake modal --------
  // Curve LP tokens are universally 18 decimals (matches loadPortfolioPositions hardcoding).
  const LP_DECIMALS = 18;
  // Modes: 'stake', 'unstake' (legacy direct), or 'manage' (tabbed wrapper).
  let _modalCtx = null;

  // -------- Yield-panel DOM rehoming (Variant B) --------
  // Physically move tab-deposit / tab-withdraw nodes from view-yield-right into
  // pmBody while modal is open. Same DOM = same IDs/handlers/globals "just work".
  // Restore original placement on close to keep /yield page functional.
  let _rehomedNode = null;
  let _rehomeOrigParent = null;
  let _rehomeNextSibling = null;
  let _savedSelectedPool = undefined; // undefined = nothing saved; null is a valid saved value
  function _rehomeYieldPanel(panelId, pool) {
    const node = document.getElementById(panelId);
    const dest = document.getElementById('pmBody');
    if (!node || !dest) return false;
    // If a different panel is already rehomed, restore it first.
    if (_rehomedNode && _rehomedNode !== node) _restoreRehomedYieldPanel();
    if (_rehomedNode === node) {
      // Same node already rehomed — just update pool if changed.
      if (pool && global.selectedPool !== pool) {
        global.selectedPool = pool;
        if (typeof global.buildDepositUI === 'function') global.buildDepositUI();
        if (typeof global.buildWithdrawUI === 'function') global.buildWithdrawUI();
        if (global.walletAddress && typeof global.loadAllYieldBalances === 'function') {
          global.loadAllYieldBalances();
        }
      }
      return true;
    }
    _rehomedNode = node;
    _rehomeOrigParent = node.parentNode;
    _rehomeNextSibling = node.nextSibling;
    if (_savedSelectedPool === undefined) _savedSelectedPool = global.selectedPool;
    if (pool) global.selectedPool = pool;
    dest.innerHTML = '';
    dest.appendChild(node);
    node.style.display = '';
    node.classList.add('active');
    // Repopulate panel content for the position's pool
    if (panelId === 'tab-deposit' && typeof global.buildDepositUI === 'function') global.buildDepositUI();
    if (panelId === 'tab-withdraw' && typeof global.buildWithdrawUI === 'function') global.buildWithdrawUI();
    if (global.walletAddress && typeof global.loadAllYieldBalances === 'function') {
      global.loadAllYieldBalances();
    }
    return true;
  }
  function _restoreRehomedYieldPanel() {
    if (!_rehomedNode) return;
    _rehomedNode.style.display = 'none';
    _rehomedNode.classList.remove('active');
    if (_rehomeOrigParent) {
      if (_rehomeNextSibling && _rehomeNextSibling.parentNode === _rehomeOrigParent) {
        _rehomeOrigParent.insertBefore(_rehomedNode, _rehomeNextSibling);
      } else {
        _rehomeOrigParent.appendChild(_rehomedNode);
      }
    }
    _rehomedNode = null;
    _rehomeOrigParent = null;
    _rehomeNextSibling = null;
    if (_savedSelectedPool !== undefined) {
      global.selectedPool = _savedSelectedPool;
      _savedSelectedPool = undefined;
    }
  }
  // Manage modal sub-tab definitions: top tab → ordered list of sub tabs.
  const MANAGE_SUB_TABS = {
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
  };

  function _ensureModalDOM() {
    let overlay = document.getElementById('portfolioModalOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.className = 'portfolio-modal-overlay';
    overlay.id = 'portfolioModalOverlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="portfolio-modal portfolio-modal-large" role="dialog" aria-modal="true">
        <div class="pm-header">
          <h3 class="pm-title" id="pmTitle">Manage Position</h3>
          <button class="pm-close" onclick="Portfolio.closeModal()" aria-label="Close">&times;</button>
        </div>
        <div class="pm-tabs-top" id="pmTopTabs" hidden>
          <button class="pm-top active" data-top="deposit" onclick="Portfolio.setManageTopTab('deposit')">Deposit</button>
          <button class="pm-top" data-top="withdraw" onclick="Portfolio.setManageTopTab('withdraw')">Withdraw</button>
        </div>
        <div class="pm-tabs-sub" id="pmSubTabs" hidden></div>
        <div class="pm-body" id="pmBody"></div>
        <button class="pm-action" id="pmAction" hidden>Submit</button>
      </div>`;
    document.body.appendChild(overlay);
    // Close on overlay click (not modal)
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    // Action button (delegated)
    overlay.querySelector('#pmAction').addEventListener('click', _onActionClick);
    return overlay;
  }

  // Render legacy stake/unstake body (input + presets + status). Used by openStakeModal / openUnstakeModal.
  function _renderLegacyAmountForm(modeLabel, available) {
    const body = document.getElementById('pmBody');
    if (!body) return;
    body.innerHTML = `
      <div class="pm-balance">Available: <span id="pmAvailable">${available}</span> LP</div>
      <input type="number" class="pm-input" id="pmAmountInput" placeholder="0.0" inputmode="decimal" min="0" step="any">
      <div class="pm-presets">
        <button data-pct="25">25%</button>
        <button data-pct="50">50%</button>
        <button data-pct="75">75%</button>
        <button data-pct="100">MAX</button>
      </div>
      <div class="pm-gas-row"><span>Network fee</span><span id="pmGas" class="gas-value">--</span></div>
      <div class="pm-status" id="pmStatus" style="display:none"></div>
    `;
    body.querySelectorAll('.pm-presets button').forEach(btn => {
      btn.addEventListener('click', () => {
        const pct = parseFloat(btn.getAttribute('data-pct'));
        _applyPreset(pct);
      });
    });
    body.querySelector('#pmAmountInput').addEventListener('input', _onAmountInput);
    body.querySelector('#pmAmountInput').addEventListener('input', _scheduleManageGas);
  }

  function _maxAmount() {
    if (!_modalCtx) return 0;
    const p = _lastPositions[_modalCtx.idx];
    if (!p) return 0;
    // Manage modal sets mode='manage' + activeOp per sub-tab. Legacy quick
    // stake/unstake modals set mode directly. Pick whichever's set.
    const op = _modalCtx.activeOp || _modalCtx.mode;
    if (op === 'stake') return p.walletLP || 0;
    if (op === 'unstake') return p.stakedLP || 0;
    return 0;
  }

  function _applyPreset(pct) {
    const max = _maxAmount();
    const v = max * (pct / 100);
    const input = document.getElementById('pmAmountInput');
    if (input) {
      // Trim trailing zeros, cap at 18 places
      input.value = v > 0 ? v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '0';
      _onAmountInput();
    }
  }

  function _setStatus(msg, kind) {
    const el = document.getElementById('pmStatus');
    if (!el) return;
    if (!msg) {
      el.style.display = 'none';
      el.textContent = '';
      el.className = 'pm-status';
      return;
    }
    el.style.display = 'block';
    el.textContent = msg;
    el.className = 'pm-status' + (kind ? ' ' + kind : '');
  }

  function _onAmountInput() {
    const input = document.getElementById('pmAmountInput');
    const action = document.getElementById('pmAction');
    if (!input || !action) return;
    const raw = (input.value || '').trim();
    const v = parseFloat(raw);
    const max = _maxAmount();
    let invalid = false;
    let statusMsg = '';
    if (!raw || isNaN(v) || v <= 0) {
      invalid = true;
    } else if (v > max + Math.max(max * 1e-6, 1e-12)) {
      // Same scaled tolerance as _onWithdrawAmountInput — absorbs toFixed(8)
      // round-trip error when user clicks MAX.
      invalid = true;
      statusMsg = 'Insufficient balance';
    }
    input.classList.toggle('pm-input-error', invalid && !!statusMsg);
    action.disabled = invalid;
    if (statusMsg) _setStatus(statusMsg, 'error');
    else _setStatus('', '');
  }

  async function _updateActionLabel() {
    const action = document.getElementById('pmAction');
    if (!action || !_modalCtx) return;
    if (_modalCtx.mode === 'unstake') {
      action.textContent = 'Unstake';
      return;
    }
    // Stake: default label until we know allowance
    action.textContent = 'Approve + Stake';
    try {
      const p = _lastPositions[_modalCtx.idx];
      if (!p || !global.walletAddress || !window.ethereum || !global.ethers) return;
      const provider = new global.ethers.BrowserProvider(window.ethereum);
      const lp = new global.ethers.Contract(p.lpTokenAddress, global.ERC20_ABI, provider);
      const allowance = await lp.allowance(global.walletAddress, p.gaugeAddress);
      // If allowance covers the full wallet balance, we can label "Stake" directly.
      const walletWei = global.ethers.parseUnits((p.walletLP || 0).toFixed(LP_DECIMALS).replace(/0+$/, '').replace(/\.$/, '') || '0', LP_DECIMALS);
      if (allowance >= walletWei && walletWei > 0n) {
        action.textContent = 'Stake';
      }
    } catch (e) { /* keep default label */ }
  }

  function openStakeModal(idx) {
    const p = _lastPositions[idx];
    if (!p) return;
    _modalCtx = { idx, mode: 'stake' };
    const overlay = _ensureModalDOM();
    document.getElementById('pmTitle').textContent = `Stake — ${p.poolName}`;
    // Hide tabs (legacy direct mode)
    document.getElementById('pmTopTabs').hidden = true;
    document.getElementById('pmSubTabs').hidden = true;
    _renderLegacyAmountForm('stake', (p.walletLP || 0).toFixed(4));
    const action = document.getElementById('pmAction');
    action.hidden = false;
    action.disabled = true;
    overlay.hidden = false;
    _updateActionLabel();
    _scheduleManageGas();
  }

  function openUnstakeModal(idx) {
    const p = _lastPositions[idx];
    if (!p) return;
    _modalCtx = { idx, mode: 'unstake' };
    const overlay = _ensureModalDOM();
    document.getElementById('pmTitle').textContent = `Unstake — ${p.poolName}`;
    document.getElementById('pmTopTabs').hidden = true;
    document.getElementById('pmSubTabs').hidden = true;
    _renderLegacyAmountForm('unstake', (p.stakedLP || 0).toFixed(4));
    const action = document.getElementById('pmAction');
    action.hidden = false;
    action.disabled = true;
    overlay.hidden = false;
    _updateActionLabel();
    _scheduleManageGas();
  }

  // -------- Manage modal (tabbed: 6 actions mirroring /yield) --------
  function openManageModal(idx) {
    const p = _lastPositions[idx];
    if (!p) return;
    _modalCtx = { idx, mode: 'manage', topTab: 'deposit', subTab: 'stake' };
    // Default sub-tab: pick the most useful one given current state
    if (p.walletLP > 0) _modalCtx.subTab = 'stake';
    else if (p.stakedLP > 0 || p.pendingCRV > 0) {
      _modalCtx.topTab = 'withdraw';
      _modalCtx.subTab = p.pendingCRV > 0 ? 'claim-rewards' : 'unstake';
    }
    // Cross-route state desync fix (Nik msgs 449-455 2026-05-02):
    // resolve the pool object once at modal open and pin it as the canonical
    // selectedPool for all sub-tab branches. Without this, sub-tab branches
    // that don't explicitly reseed (stake / unstake / deposit-and-stake) read
    // stale selectedPool left over from /yield route, so user opens Manage
    // for pool A but Deposit form renders coins from pool B (last visited on
    // /yield). Each branch may still reseed on its own (deposit/withdraw do)
    // but this guarantees coherent state from the very first render.
    try {
      const pool = (global.allPools || []).find(x =>
        (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase()
      );
      if (pool) global.selectedPool = pool;
    } catch (_e) { /* allPools may not be loaded yet — branches will retry */ }
    const overlay = _ensureModalDOM();
    document.getElementById('pmTitle').textContent = `Manage — ${p.poolName}`;
    document.getElementById('pmTopTabs').hidden = false;
    document.getElementById('pmSubTabs').hidden = false;
    _renderManageTabs();
    _renderManageBody();
    overlay.hidden = false;
  }

  function setManageTopTab(top) {
    if (!_modalCtx || _modalCtx.mode !== 'manage') return;
    _modalCtx.topTab = top;
    _modalCtx.subTab = MANAGE_SUB_TABS[top][0].id;
    _renderManageTabs();
    _renderManageBody();
  }

  function setManageSubTab(sub) {
    if (!_modalCtx || _modalCtx.mode !== 'manage') return;
    _modalCtx.subTab = sub;
    _renderManageTabs();
    _renderManageBody();
  }

  function _renderManageTabs() {
    const top = _modalCtx.topTab;
    const sub = _modalCtx.subTab;
    document.querySelectorAll('#pmTopTabs .pm-top').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-top') === top);
    });
    const subContainer = document.getElementById('pmSubTabs');
    if (!subContainer) return;
    subContainer.innerHTML = MANAGE_SUB_TABS[top].map(s =>
      `<button class="pm-sub${s.id === sub ? ' active' : ''}" data-sub="${s.id}" onclick="Portfolio.setManageSubTab('${s.id}')">${s.label}</button>`
    ).join('');
  }

  function _renderManageBody() {
    const idx = _modalCtx.idx;
    const p = _lastPositions[idx];
    if (!p) return;
    const sub = _modalCtx.subTab;
    const action = document.getElementById('pmAction');
    // Restore any rehomed yield panel before non-rehome branches render their own body.
    if (sub !== 'deposit' && sub !== 'withdraw') _restoreRehomedYieldPanel();
    if (sub === 'stake') {
      _modalCtx.activeOp = 'stake';
      _renderManageAmountForm('stake', p.walletLP || 0, 'Available LP in wallet');
      action.hidden = false;
      action.disabled = true;
      action.textContent = 'Stake';
      _updateActionLabel();
    } else if (sub === 'unstake') {
      _modalCtx.activeOp = 'unstake';
      _renderManageAmountForm('unstake', p.stakedLP || 0, 'Staked LP');
      action.hidden = false;
      action.disabled = true;
      action.textContent = 'Unstake';
    } else if (sub === 'claim-rewards') {
      _modalCtx.activeOp = 'claim-rewards';
      _renderClaimRewardsForm(p);
      // Per-row Claim buttons replace the global action button.
      action.hidden = true;
    } else if (sub === 'deposit-and-stake') {
      _modalCtx.activeOp = 'deposit-and-stake';
      _renderDepositLikeForm(p, 'deposit-and-stake');
      action.hidden = false;
      action.disabled = true;
      action.textContent = 'Deposit & Stake';
    } else if (sub === 'deposit') {
      _modalCtx.activeOp = 'deposit';
      const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
      _rehomeYieldPanel('tab-deposit', pool);
      // Eagerly seed the per-coin input rows from the pool object even when
      // _rehomeYieldPanel short-circuits (same-node-already-rehomed branch
      // skips buildDepositUI when selectedPool object identity matches) or
      // when allPools lookup transiently misses. Mirrors the withdraw fix
      // pattern (commit 30cbdb8c) — guarantees the form renders this pool's
      // coins instead of leaving the static "Select a pool to deposit"
      // placeholder. loadDepositBalances() runs inside buildDepositUI when
      // wallet is connected, populating per-coin balances asynchronously.
      try {
        if (pool) {
          global.selectedPool = pool;
          if (typeof global.buildDepositUI === 'function') global.buildDepositUI();
        }
      } catch (_e) { /* non-fatal: rehome already attempted the same path */ }
      // Submit lives inside rehomed panel (handleDepositSubmit on #depositSubmit).
      action.hidden = true;
    } else if (sub === 'withdraw') {
      _modalCtx.activeOp = 'withdraw';
      const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
      _rehomeYieldPanel('tab-withdraw', pool);
      // Mirror the deposit fix (commit 30cbdb8c): explicitly reseed
      // selectedPool + rebuild the withdraw form even when _rehomeYieldPanel
      // short-circuits (same-node-rehomed branch skips buildWithdrawUI when
      // selectedPool object identity matches) or when allPools lookup
      // transiently misses. Without this, opening Manage Withdraw from the
      // main panel for a pool the user has never visited on /yield leaves
      // selectedPool unset → loadAllYieldBalances() early-returns →
      // chip-presets (25/50/75/MAX) silently fail because lpBalanceRaw stays
      // 0n. Tester 266249857 (Nik msg 13:21) reported this as the original
      // Withdraw rehome bug, separate from RPC ERR_CONNECTION_CLOSED.
      try {
        if (pool) {
          global.selectedPool = pool;
          if (typeof global.buildWithdrawUI === 'function') global.buildWithdrawUI();
          if (global.walletAddress && typeof global.loadAllYieldBalances === 'function') {
            global.loadAllYieldBalances();
          }
        }
      } catch (_e) { /* non-fatal: rehome already attempted the same path */ }
      // Seed LP balance display from cached portfolio scan (same source as Stake tab),
      // so the value is visible immediately even before yield's async loadLPBalance() resolves.
      // Fix: Withdraw tab previously showed "Balance: --" while Stake tab + Dashboard were correct.
      // loadLPBalance() will overwrite with live on-chain value when it completes.
      try {
        const walletLP = Number(p.walletLP || 0);
        // Match native curve.finance display: positive sub-1e-5 collapses to
        // "<0.00001" so micro-dust balances are visible (Nik msg 449 2026-05-02).
        // Mirrors yield.js _formatLP — kept inline to avoid cross-file dep here.
        const formatted = (walletLP > 0 && walletLP < 1e-5)
          ? '<0.00001'
          : walletLP.toFixed(6);
        const wEl = document.getElementById('withdrawLPBalance');
        if (wEl) wEl.textContent = 'Balance: ' + formatted;
        const sEl = document.getElementById('stakeLpBalance');
        if (sEl) sEl.textContent = formatted;
        // Also seed lpBalanceRaw (BigInt wei) so 25/50/75/MAX preset chips work
        // before loadLPBalance() resolves. Chip handlers bail out if lpBalanceRaw === 0n.
        if (typeof global.ethers !== 'undefined' && walletLP > 0) {
          // toFixed(18) preserves precision; trim trailing zeros so parseUnits doesn't choke.
          const lpStr = walletLP.toFixed(18).replace(/0+$/, '').replace(/\.$/, '') || '0';
          try { window.lpBalanceRaw = global.ethers.parseUnits(lpStr, 18); } catch (_pe) {}
        }
      } catch (_e) { /* non-fatal: loadLPBalance will populate once it resolves */ }
      action.hidden = true;
    } else {
      // For other branches (stake/unstake/claim), make sure rehomed panel is gone.
      _restoreRehomedYieldPanel();
    }
    if (sub !== 'deposit' && sub !== 'withdraw') {
      _scheduleManageGas();
    }
  }

  // Amount form for Stake / Unstake (within tabbed manage modal)
  function _renderManageAmountForm(op, available, label) {
    const body = document.getElementById('pmBody');
    if (!body) return;
    body.innerHTML = `
      <div class="pm-balance">${label}: <span id="pmAvailable">${available.toFixed(4)}</span> LP</div>
      <input type="number" class="pm-input" id="pmAmountInput" placeholder="0.0" inputmode="decimal" min="0" step="any">
      <div class="pm-presets">
        <button data-pct="25">25%</button>
        <button data-pct="50">50%</button>
        <button data-pct="75">75%</button>
        <button data-pct="100">MAX</button>
      </div>
      <div class="pm-gas-row"><span>Network fee</span><span id="pmGas" class="gas-value">--</span></div>
      <div class="pm-status" id="pmStatus" style="display:none"></div>
    `;
    body.querySelectorAll('.pm-presets button').forEach(btn => {
      btn.addEventListener('click', () => {
        const pct = parseFloat(btn.getAttribute('data-pct'));
        _applyPreset(pct);
      });
    });
    body.querySelector('#pmAmountInput').addEventListener('input', _onAmountInput);
    body.querySelector('#pmAmountInput').addEventListener('input', _scheduleManageGas);
  }

  function _renderClaimRewardsForm(p) {
    const body = document.getElementById('pmBody');
    if (!body) return;
    const idx = _modalCtx ? _modalCtx.idx : -1;
    const hasCrv = p.pendingCRV > 0;
    const crvRow = `
      <div class="pm-claim-row">
        <span class="pm-claim-label">CRV</span>
        <span class="pm-claim-amount">${p.pendingCRV.toFixed(4)}</span>
        <button class="pm-claim-btn" onclick="Portfolio.claimCRV(${idx})" ${hasCrv ? '' : 'disabled'}>Claim</button>
      </div>
    `;
    body.innerHTML = `
      <div class="pm-claim-list" id="pmClaimList">
        ${crvRow}
        <div class="pm-claim-row pm-claim-extras-loading" id="pmClaimExtrasSlot">
          <span class="pm-claim-label">Extra rewards</span>
          <span class="pm-claim-amount">loading…</span>
          <button class="pm-claim-btn" disabled>Claim</button>
        </div>
      </div>
      <div class="pm-status" id="pmStatus" style="display:none"></div>
    `;
    // Async fetch extras and replace placeholder row(s).
    _renderExtrasRows(p, idx);
  }

  // Replaces #pmClaimExtrasSlot with one row per extra (≤2 tokens) or one collapsed row (≥2 tokens).
  // Hides the slot entirely if there are no extras.
  async function _renderExtrasRows(p, idx) {
    const slot = document.getElementById('pmClaimExtrasSlot');
    if (!slot) return;
    let extras;
    try {
      extras = await _fetchExtras(p.gaugeAddress, global.walletAddress);
    } catch (e) {
      slot.outerHTML = `
        <div class="pm-claim-row pm-claim-extras-error">
          <span class="pm-claim-label">Extras</span>
          <span class="pm-claim-amount" style="color:var(--text-dim);font-size:11px;">Could not load</span>
          <button class="pm-claim-btn" disabled>Claim</button>
        </div>
      `;
      return;
    }
    // If modal subtab changed while we were fetching, abort silently.
    if (!_modalCtx || _modalCtx.activeOp !== 'claim-rewards') return;
    const tokens = extras.tokens || [];
    if (tokens.length === 0) {
      // No extras at all — remove slot.
      slot.remove();
      return;
    }
    // Curve gauges' claim_rewards() is all-or-nothing per gauge.
    // If multiple extras, collapse into single row to make this clear.
    let html = '';
    if (tokens.length === 1) {
      const t = tokens[0];
      const has = t.claimable > 0;
      html = `
        <div class="pm-claim-row">
          <span class="pm-claim-label">${_escape(t.symbol)}</span>
          <span class="pm-claim-amount">${t.claimable.toFixed(4)}</span>
          <button class="pm-claim-btn" onclick="Portfolio.claimExtras(${idx})" ${has ? '' : 'disabled'}>Claim</button>
        </div>
      `;
    } else {
      const totalLabel = tokens.map(t => _escape(t.symbol)).join(', ');
      const amounts = tokens.map(t => `${t.claimable.toFixed(4)} ${_escape(t.symbol)}`).join(' · ');
      const anyClaimable = tokens.some(t => t.claimable > 0);
      html = `
        <div class="pm-claim-row">
          <span class="pm-claim-label" title="${totalLabel}">Extras</span>
          <span class="pm-claim-amount" title="${amounts}">${amounts}</span>
          <button class="pm-claim-btn" onclick="Portfolio.claimExtras(${idx})" ${anyClaimable ? '' : 'disabled'}>Claim All</button>
        </div>
      `;
    }
    slot.outerHTML = html;
  }

  function _escape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  function _renderDepositLikeForm(p, op) {
    const body = document.getElementById('pmBody');
    if (!body) return;
    const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
    const coins = pool && Array.isArray(pool.coins) ? pool.coins : [];
    const addrs = pool && Array.isArray(pool.coinsAddresses) ? pool.coinsAddresses : (p.coinAddrs || []);
    if (coins.length === 0) {
      body.innerHTML = `
        <p class="pm-claim-hint">Token data unavailable. Open the pool page for advanced deposit.</p>
        <a class="pm-link-btn" href="#/yield/${p.poolAddress}" onclick="Portfolio.closeModal()">Open /yield &rarr;</a>
        <div class="pm-status" id="pmStatus" style="display:none"></div>
      `;
      return;
    }
    const inputs = coins.map((sym, i) => `
      <div class="pm-coin-row">
        <label class="pm-coin-label">
          <img class="pm-coin-icon" src="${global._tokenIconUrl(addrs[i])}" alt="" onerror="this.style.display='none'">
          ${sym}
        </label>
        <input type="number" class="pm-input pm-coin-amount" data-coin-idx="${i}" placeholder="0.0" inputmode="decimal" min="0" step="any">
        <span class="pm-coin-bal" id="pmDepBal_${i}">--</span>
      </div>
    `).join('');
    body.innerHTML = `
      <div class="pm-balance">Enter amounts (single-token or balanced)</div>
      <div class="pm-coin-list">${inputs}</div>
      <div class="pm-coin-actions">
        <a class="pm-link-inline" href="#/yield/${p.poolAddress}" onclick="Portfolio.closeModal()">Use /yield for advanced UX &rarr;</a>
      </div>
      <div class="pm-gas-row"><span>Network fee (total)</span><span id="pmGas" class="gas-value">--</span></div>
      <div class="pm-status" id="pmStatus" style="display:none"></div>
    `;
    // Wire up onchange on each input to enable Submit when any > 0
    body.querySelectorAll('.pm-coin-amount').forEach(inp => {
      inp.addEventListener('input', _onCoinAmountInput);
      inp.addEventListener('input', _scheduleManageGas);
    });
    // Best-effort: load on-chain wallet balances for these tokens
    _loadCoinBalances(p, addrs, pool ? (pool.decimals || []) : []);
  }

  function _renderLinkOutForm(p, op) {
    const body = document.getElementById('pmBody');
    if (!body) return;
    const label = op === 'deposit' ? 'Deposit' : 'Withdraw';
    body.innerHTML = `
      <p class="pm-claim-hint">${label} requires per-token amount controls and slippage settings best presented on the dedicated pool page.</p>
      <a class="pm-link-btn" href="#/yield/${p.poolAddress}" onclick="Portfolio.closeModal()">Open ${label} on /yield &rarr;</a>
    `;
  }

  // Withdraw form: LP amount input + percent presets + per-coin "you'll receive" preview.
  // Proportional withdraw via remove_liquidity (with min_amounts=0 — best-effort,
  // matches /yield's "balanced" mode default).
  function _renderWithdrawLikeForm(p) {
    const body = document.getElementById('pmBody');
    if (!body) return;
    const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
    const coins = pool && Array.isArray(pool.coins) ? pool.coins : [];
    const addrs = pool && Array.isArray(pool.coinsAddresses) ? pool.coinsAddresses : (p.coinAddrs || []);
    const walletLP = p.walletLP || 0;
    if (coins.length === 0) {
      body.innerHTML = `
        <p class="pm-claim-hint">Token data unavailable. Open the pool page for advanced withdraw.</p>
        <a class="pm-link-btn" href="#/yield/${p.poolAddress}" onclick="Portfolio.closeModal()">Open /yield &rarr;</a>
        <div class="pm-status" id="pmStatus" style="display:none"></div>
      `;
      return;
    }
    const _esc = (typeof window !== 'undefined' && window.escapeHtml) ? window.escapeHtml : (s => String(s == null ? '' : s));
    const previewRows = coins.map((sym, i) => `
      <div class="pm-coin-row">
        <label class="pm-coin-label">
          <img class="pm-coin-icon" src="${global._tokenIconUrl(addrs[i])}" alt="" onerror="this.style.display='none'">
          ${_esc(sym)}
        </label>
        <span class="pm-coin-bal" id="pmWdRecv_${i}">--</span>
      </div>
    `).join('');
    body.innerHTML = `
      <div class="pm-balance">LP in wallet: <span id="pmAvailable">${walletLP.toFixed(4)}</span> LP</div>
      <input type="number" class="pm-input" id="pmAmountInput" placeholder="0.0" inputmode="decimal" min="0" step="any">
      <div class="pm-presets">
        <button data-pct="25">25%</button>
        <button data-pct="50">50%</button>
        <button data-pct="75">75%</button>
        <button data-pct="100">MAX</button>
      </div>
      <div class="pm-balance" style="margin-top:12px">You will receive (proportional)</div>
      <div class="pm-coin-list">${previewRows}</div>
      <div class="pm-coin-actions">
        <a class="pm-link-inline" href="#/yield/${p.poolAddress}" onclick="Portfolio.closeModal()">Use /yield for advanced UX (single-coin, slippage) &rarr;</a>
      </div>
      <div class="pm-gas-row"><span>Network fee</span><span id="pmGas" class="gas-value">--</span></div>
      <div class="pm-status" id="pmStatus" style="display:none"></div>
    `;
    body.querySelectorAll('.pm-presets button').forEach(btn => {
      btn.addEventListener('click', () => {
        const pct = parseFloat(btn.getAttribute('data-pct'));
        _applyWithdrawPreset(pct);
      });
    });
    const inp = body.querySelector('#pmAmountInput');
    inp.addEventListener('input', _onWithdrawAmountInput);
    inp.addEventListener('input', _scheduleManageGas);
    inp.addEventListener('input', _scheduleWithdrawPreview);
  }

  function _applyWithdrawPreset(pct) {
    if (!_modalCtx) return;
    const p = _lastPositions[_modalCtx.idx];
    if (!p) return;
    const max = p.walletLP || 0;
    const v = max * (pct / 100);
    const input = document.getElementById('pmAmountInput');
    if (input) {
      input.value = v > 0 ? v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') : '0';
      _onWithdrawAmountInput();
      _scheduleManageGas();
      _scheduleWithdrawPreview();
    }
  }

  function _onWithdrawAmountInput() {
    const input = document.getElementById('pmAmountInput');
    const action = document.getElementById('pmAction');
    if (!input || !action || !_modalCtx) return;
    const p = _lastPositions[_modalCtx.idx];
    const max = p ? (p.walletLP || 0) : 0;
    const raw = (input.value || '').trim();
    const v = parseFloat(raw);
    let invalid = false, statusMsg = '';
    if (!raw || isNaN(v) || v <= 0) {
      invalid = true;
    } else if (v > max + Math.max(max * 1e-6, 1e-12)) {
      // Tolerance scales with magnitude to absorb toFixed(8) rounding when
      // the user clicks MAX (input value can be slightly larger than the
      // exact float in `max` after string round-trip).
      invalid = true;
      statusMsg = 'Insufficient LP balance';
    }
    input.classList.toggle('pm-input-error', invalid && !!statusMsg);
    action.disabled = invalid;
    if (statusMsg) _setStatus(statusMsg, 'error');
    else _setStatus('', '');
  }

  let _wdPreviewTimer = null;
  function _scheduleWithdrawPreview() {
    clearTimeout(_wdPreviewTimer);
    _wdPreviewTimer = setTimeout(_updateWithdrawPreview, 400);
  }

  // Estimated per-coin USD value: each coin gets share of the pool's TVL
  // proportional to lp_amount / totalSupply. Per-coin token amounts would
  // need an extra multicall (pool.balances(i)) — not worth the RPC cost
  // for a preview. USD value is the meaningful quick-look number anyway.
  function _updateWithdrawPreview() {
    if (!_modalCtx) return;
    const p = _lastPositions[_modalCtx.idx];
    if (!p) return;
    const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
    if (!pool) return;
    const coins = pool.coins || [];
    const usdTotal = pool.usdTotal || pool.tvl || 0;
    const totalSupplyLP = p.totalSupplyLP || pool.totalSupply || 0;
    const lpVal = parseFloat(document.getElementById('pmAmountInput')?.value || '0');
    if (!(lpVal > 0) || totalSupplyLP <= 0 || usdTotal <= 0) {
      coins.forEach((_, i) => { const el = document.getElementById(`pmWdRecv_${i}`); if (el) el.textContent = '--'; });
      return;
    }
    const share = lpVal / totalSupplyLP;
    // Equal split across coins as USD estimate (Curve pools are roughly
    // balanced; deviations resolve at remove_liquidity time).
    const perCoinUsd = (usdTotal * share) / Math.max(coins.length, 1);
    coins.forEach((sym, i) => {
      const el = document.getElementById(`pmWdRecv_${i}`);
      if (!el) return;
      el.textContent = perCoinUsd > 0 ? `~$${perCoinUsd.toFixed(perCoinUsd < 1 ? 4 : 2)}` : '--';
    });
  }

  // Best-effort: read wallet balances for pool tokens, render into pmDepBal_*
  async function _loadCoinBalances(p, addrs, decimalsArr) {
    if (!global.walletAddress || !global.ethers) return;
    try {
      const provider = global.provider
        || global._portfolioReadProvider
        || (window.ethereum ? new global.ethers.BrowserProvider(window.ethereum) : null);
      if (!provider) return;
      const ETH_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      const erc20Iface = new global.ethers.Interface(global.ERC20_ABI);
      const balData = erc20Iface.encodeFunctionData('balanceOf', [global.walletAddress]);
      for (let i = 0; i < addrs.length; i++) {
        const addr = (addrs[i] || '').toLowerCase();
        const dec = parseInt(decimalsArr[i]) || 18;
        let bal = 0n;
        try {
          if (!addr || addr === ETH_PSEUDO) {
            bal = await provider.getBalance(global.walletAddress);
          } else {
            const ret = await provider.call({ to: addrs[i], data: balData });
            [bal] = erc20Iface.decodeFunctionResult('balanceOf', ret);
          }
        } catch (e) { /* skip */ }
        const el = document.getElementById(`pmDepBal_${i}`);
        if (el) {
          const formatted = parseFloat(global.ethers.formatUnits(bal, dec));
          el.textContent = formatted.toFixed(formatted > 0 && formatted < 1 ? 6 : 4);
          el.dataset.bal = formatted;
        }
      }
    } catch (e) { /* swallow */ }
  }

  function _onCoinAmountInput() {
    const action = document.getElementById('pmAction');
    if (!action) return;
    const inputs = document.querySelectorAll('.pm-coin-amount');
    let hasAny = false;
    inputs.forEach(inp => {
      const v = parseFloat(inp.value);
      if (v > 0) hasAny = true;
    });
    action.disabled = !hasAny;
  }

  function closeModal() {
    _restoreRehomedYieldPanel();
    const overlay = document.getElementById('portfolioModalOverlay');
    if (overlay) overlay.hidden = true;
    _modalCtx = null;
    // Drop extras cache so next open shows fresh on-chain claimable amounts.
    _extrasCache.clear();
  }

  function _isUserRejection(e) {
    const code = e?.code || e?.error?.code;
    if (code === 4001 || code === 'ACTION_REJECTED') return true;
    const msg = (e?.shortMessage || e?.message || '').toLowerCase();
    return msg.includes('user rejected') || msg.includes('user denied');
  }

  async function _onActionClick() {
    if (!_modalCtx) return;
    const action = document.getElementById('pmAction');
    if (action) action.disabled = true;
    try {
      const op = _modalCtx.mode === 'manage' ? _modalCtx.activeOp : _modalCtx.mode;
      if (op === 'stake') {
        const amountStr = (document.getElementById('pmAmountInput')?.value || '').trim();
        if (!amountStr) return;
        await executeStake(_modalCtx.idx, amountStr);
      } else if (op === 'unstake') {
        const amountStr = (document.getElementById('pmAmountInput')?.value || '').trim();
        if (!amountStr) return;
        await executeUnstake(_modalCtx.idx, amountStr);
      } else if (op === 'claim-rewards') {
        await executeClaimRewards(_modalCtx.idx);
      } else if (op === 'deposit-and-stake') {
        await executeDepositAndStake(_modalCtx.idx);
      } else if (op === 'deposit') {
        await executeDeposit(_modalCtx.idx);
      } else if (op === 'withdraw') {
        const amountStr = (document.getElementById('pmAmountInput')?.value || '').trim();
        if (!amountStr) return;
        await executeWithdraw(_modalCtx.idx, amountStr);
      }
    } finally {
      // Re-enable in case of error path; on success closeModal already nulls ctx.
      if (action && _modalCtx) action.disabled = false;
    }
  }

  // -------- Gas estimation for Manage modal --------
  // Computes gas for the currently-active op (stake/unstake/claim/deposit&stake)
  // and renders into #pmGas. Debounced via _manageGasTimer.
  let _manageGasTimer = null;
  let _manageGasStamp = null;
  const ETH_PSEUDO_PORTFOLIO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

  function _scheduleManageGas() {
    clearTimeout(_manageGasTimer);
    _manageGasTimer = setTimeout(_updateManageGas, 500);
  }

  async function _updateManageGas() {
    const gasEl = document.getElementById('pmGas');
    if (!gasEl || !_modalCtx) return;
    if (typeof window.estimateMultiStepGas !== 'function') {
      gasEl.textContent = 'unavailable';
      gasEl.className = 'gas-value error';
      return;
    }
    const op = _modalCtx.mode === 'manage' ? _modalCtx.activeOp : _modalCtx.mode;
    const p = _lastPositions[_modalCtx.idx];
    if (!p) return;
    const stamp = (_manageGasStamp = Date.now() + ':' + Math.random());
    gasEl.textContent = 'estimating...';
    gasEl.className = 'gas-value loading';
    try {
      const steps = await _buildManageSteps(op, p);
      if (stamp !== _manageGasStamp) return;
      if (!steps || steps.length === 0) {
        gasEl.textContent = '--';
        gasEl.className = 'gas-value';
        return;
      }
      const r = await window.estimateMultiStepGas(steps, global.walletAddress || null);
      if (stamp !== _manageGasStamp) return;
      window.renderGasLine(gasEl, r, { hasWallet: !!global.walletAddress });
    } catch (e) {
      if (stamp !== _manageGasStamp) return;
      console.warn('[portfolio] manage gas:', e);
      gasEl.textContent = 'unavailable';
      gasEl.className = 'gas-value error';
    }
  }

  // Build calldata-based steps for the given op + position. Returns [] when nothing to estimate.
  async function _buildManageSteps(op, p) {
    if (!global.ethers) return [];
    const ethersLib = global.ethers;
    if (op === 'stake') {
      const amountStr = (document.getElementById('pmAmountInput')?.value || '').trim();
      if (!amountStr || parseFloat(amountStr) <= 0) return [];
      let amount;
      try { amount = ethersLib.parseUnits(amountStr, LP_DECIMALS); } catch { return []; }
      if (amount <= 0n) return [];
      const steps = [];
      const lpAddr = p.lpTokenAddress;
      const gauge = p.gaugeAddress;
      if (global.walletAddress) {
        const allowance = await window._readAllowance(lpAddr, global.walletAddress, gauge);
        if (allowance < amount) {
          steps.push({
            label: 'Approve LP',
            to: lpAddr,
            data: window._buildApproveCalldata(gauge, ethersLib.MaxUint256),
            fallback: window._GAS_FALLBACK.approve,
          });
        }
      }
      const gIface = new ethersLib.Interface(['function deposit(uint256)']);
      steps.push({
        label: 'Stake',
        to: gauge,
        data: gIface.encodeFunctionData('deposit', [amount]),
        fallback: window._GAS_FALLBACK.gaugeDeposit,
      });
      return steps;
    }
    if (op === 'unstake') {
      const amountStr = (document.getElementById('pmAmountInput')?.value || '').trim();
      if (!amountStr || parseFloat(amountStr) <= 0) return [];
      let amount;
      try { amount = ethersLib.parseUnits(amountStr, LP_DECIMALS); } catch { return []; }
      if (amount <= 0n) return [];
      const gIface = new ethersLib.Interface(['function withdraw(uint256)']);
      return [{
        label: 'Unstake',
        to: p.gaugeAddress,
        data: gIface.encodeFunctionData('withdraw', [amount]),
        fallback: window._GAS_FALLBACK.gaugeWithdraw,
      }];
    }
    if (op === 'claim-rewards') {
      if (!(p.pendingCRV > 0)) return [];
      const minterIface = new ethersLib.Interface(['function mint(address)']);
      return [{
        label: 'Claim CRV',
        to: MINTER_ADDR,
        data: minterIface.encodeFunctionData('mint', [p.gaugeAddress]),
        fallback: window._GAS_FALLBACK.minterMint,
      }];
    }
    if (op === 'deposit' || op === 'deposit-and-stake') {
      const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
      if (!pool || !Array.isArray(pool.coins)) return [];
      const n = pool.coins.length;
      const amounts = [];
      let hasAny = false;
      for (let i = 0; i < n; i++) {
        const inp = document.querySelector(`.pm-coin-amount[data-coin-idx="${i}"]`);
        const val = inp ? parseFloat(inp.value) : 0;
        const dec = parseInt((pool.decimals || [])[i]) || 18;
        if (val > 0) hasAny = true;
        try { amounts.push(val > 0 ? ethersLib.parseUnits(val.toFixed(dec > 8 ? 8 : dec), dec) : 0n); }
        catch { amounts.push(0n); }
      }
      if (!hasAny) return [];
      const steps = [];
      // Approval steps
      if (global.walletAddress) {
        for (let i = 0; i < n; i++) {
          if (amounts[i] === 0n) continue;
          const addr = (pool.coinsAddresses[i] || '').toLowerCase();
          if (!addr || addr === ETH_PSEUDO_PORTFOLIO) continue;
          const allowance = await window._readAllowance(pool.coinsAddresses[i], global.walletAddress, pool.address);
          if (allowance >= amounts[i]) continue;
          steps.push({
            label: `Approve ${pool.coins[i]}`,
            to: pool.coinsAddresses[i],
            data: window._buildApproveCalldata(pool.address, ethersLib.MaxUint256),
            fallback: window._GAS_FALLBACK.approve,
          });
        }
      }
      // add_liquidity
      const addIface = new ethersLib.Interface([`function add_liquidity(uint256[${n}] amounts, uint256 min_mint_amount) payable returns (uint256)`]);
      let ethValue = 0n;
      for (let i = 0; i < n; i++) {
        if ((pool.coinsAddresses[i] || '').toLowerCase() === ETH_PSEUDO_PORTFOLIO) ethValue = amounts[i];
      }
      steps.push({
        label: 'Add liquidity',
        to: pool.address,
        data: addIface.encodeFunctionData('add_liquidity', [amounts, 0n]),
        value: ethValue,
        fallback: window._GAS_FALLBACK.addLiquidity,
      });
      if (op === 'deposit-and-stake') {
        // LP approve + stake (will need fallback because LP doesn't exist yet)
        steps.push({
          label: 'Approve LP',
          to: pool.lpTokenAddress || pool.address,
          data: window._buildApproveCalldata(p.gaugeAddress, ethersLib.MaxUint256),
          fallback: window._GAS_FALLBACK.approve,
        });
        const gIface = new ethersLib.Interface(['function deposit(uint256)']);
        steps.push({
          label: 'Stake LP',
          to: p.gaugeAddress,
          data: gIface.encodeFunctionData('deposit', [1n]),
          fallback: window._GAS_FALLBACK.gaugeDeposit,
        });
      }
      return steps;
    }
    if (op === 'withdraw') {
      const amountStr = (document.getElementById('pmAmountInput')?.value || '').trim();
      if (!amountStr || parseFloat(amountStr) <= 0) return [];
      let amount;
      try { amount = ethersLib.parseUnits(amountStr, LP_DECIMALS); } catch { return []; }
      if (amount <= 0n) return [];
      const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
      if (!pool || !Array.isArray(pool.coins)) return [];
      const n = pool.coins.length;
      const minAmounts = new Array(n).fill(0n);
      const rmIface = new ethersLib.Interface([`function remove_liquidity(uint256 _amount, uint256[${n}] min_amounts) returns (uint256[${n}])`]);
      return [{
        label: 'Withdraw',
        to: pool.address,
        data: rmIface.encodeFunctionData('remove_liquidity', [amount, minAmounts]),
        fallback: window._GAS_FALLBACK.addLiquidity,
      }];
    }
    return [];
  }

  async function executeStake(idx, amountStr) {
    const p = _lastPositions[idx];
    if (!p) return;
    const signer = await _ensureSigner();
    if (!signer) { _setStatus('Wallet not connected', 'error'); return; }
    let amountWei;
    try { amountWei = global.ethers.parseUnits(amountStr, LP_DECIMALS); }
    catch (e) { _setStatus('Invalid amount', 'error'); return; }
    if (amountWei <= 0n) { _setStatus('Amount must be > 0', 'error'); return; }
    try {
      const lp = new global.ethers.Contract(p.lpTokenAddress, global.ERC20_ABI, signer);
      const allowance = await lp.allowance(global.walletAddress, p.gaugeAddress);
      if (allowance < amountWei) {
        _setStatus('Approving LP token…', '');
        const txA = await lp.approve(p.gaugeAddress, global.ethers.MaxUint256);
        await txA.wait();
      }
      _setStatus('Staking…', '');
      const gauge = new global.ethers.Contract(p.gaugeAddress, global.GAUGE_ABI, signer);
      // Factory V5/V6 NG gauges may not implement single-arg deposit(uint256).
      // Probe richer signatures first; estimateGas (run by ethers before send) reverts
      // with require(false) when selector doesn't dispatch — caught and we try next.
      const walletAddr = global.walletAddress;
      let tx;
      try {
        tx = await gauge['deposit(uint256,address,bool)'](amountWei, walletAddr, false);
      } catch (e1) {
        try {
          tx = await gauge['deposit(uint256,address)'](amountWei, walletAddr);
        } catch (e2) {
          tx = await gauge['deposit(uint256)'](amountWei);
        }
      }
      console.log('[portfolio] deposit sent', tx.hash, ETHERSCAN_TX + tx.hash);
      await tx.wait();
      _setStatus('Staked', 'success');
      await _refreshOnePosition(idx);
      closeModal();
    } catch (e) {
      console.error('[portfolio] stake failed', e);
      if (_isUserRejection(e)) _setStatus('Transaction rejected', 'error');
      else _setStatus('Stake failed: ' + (e?.shortMessage || e?.message || 'unknown'), 'error');
    }
  }

  async function executeUnstake(idx, amountStr) {
    const p = _lastPositions[idx];
    if (!p) return;
    const signer = await _ensureSigner();
    if (!signer) { _setStatus('Wallet not connected', 'error'); return; }
    let amountWei;
    try { amountWei = global.ethers.parseUnits(amountStr, LP_DECIMALS); }
    catch (e) { _setStatus('Invalid amount', 'error'); return; }
    if (amountWei <= 0n) { _setStatus('Amount must be > 0', 'error'); return; }
    try {
      _setStatus('Unstaking…', '');
      const gauge = new global.ethers.Contract(p.gaugeAddress, global.GAUGE_ABI, signer);
      // Factory V5/V6 NG gauges may not implement single-arg withdraw(uint256).
      // Try 2-arg form first (most modern factory NG), fallback to classic.
      let tx;
      try {
        tx = await gauge['withdraw(uint256,bool)'](amountWei, false);
      } catch (e1) {
        tx = await gauge['withdraw(uint256)'](amountWei);
      }
      console.log('[portfolio] withdraw sent', tx.hash, ETHERSCAN_TX + tx.hash);
      await tx.wait();
      _setStatus('Unstaked', 'success');
      await _refreshOnePosition(idx);
      closeModal();
    } catch (e) {
      console.error('[portfolio] unstake failed', e);
      if (_isUserRejection(e)) _setStatus('Transaction rejected', 'error');
      else _setStatus('Unstake failed: ' + (e?.shortMessage || e?.message || 'unknown'), 'error');
    }
  }

  async function executeClaimRewards(idx) {
    const p = _lastPositions[idx];
    if (!p) return;
    const signer = await _ensureSigner();
    if (!signer) { _setStatus('Wallet not connected', 'error'); return; }
    try {
      _setStatus('Claiming CRV…', '');
      const minter = new global.ethers.Contract(MINTER_ADDR, MINTER_ABI, signer);
      const tx = await minter.mint(p.gaugeAddress);
      console.log('[portfolio] mint sent', tx.hash, ETHERSCAN_TX + tx.hash);
      await tx.wait();
      // Best-effort extras (FXS-style sponsor incentives)
      _setStatus('Claiming extras…', '');
      await _claimExtrasBestEffort(p.gaugeAddress, signer);
      _setStatus('Claimed', 'success');
      await _refreshOnePosition(idx);
      // Re-render claim form to show new (zero) pending value
      if (_modalCtx && _modalCtx.mode === 'manage' && _modalCtx.activeOp === 'claim-rewards') {
        _renderManageBody();
      } else {
        closeModal();
      }
    } catch (e) {
      console.error('[portfolio] claim failed', e);
      if (_isUserRejection(e)) _setStatus('Transaction rejected', 'error');
      else _setStatus('Claim failed: ' + (e?.shortMessage || e?.message || 'unknown'), 'error');
    }
  }

  // Per-row claim handlers (mirror classical curve.finance: separate "Claim CRV" + "Claim X" buttons).
  // Each fires a single tx; user can pick which to claim instead of forcing both.
  async function claimCRV(idx) {
    const p = _lastPositions[idx];
    if (!p || p.pendingCRV <= 0) return;
    const signer = await _ensureSigner();
    if (!signer) { _setStatus('Wallet not connected', 'error'); return; }
    try {
      _setStatus('Claiming CRV…', '');
      const minter = new global.ethers.Contract(MINTER_ADDR, MINTER_ABI, signer);
      const tx = await minter.mint(p.gaugeAddress);
      console.log('[portfolio] mint sent', tx.hash, ETHERSCAN_TX + tx.hash);
      await tx.wait();
      _setStatus('CRV claimed', 'success');
      _extrasCache.delete((p.gaugeAddress || '').toLowerCase());
      await _refreshOnePosition(idx);
      if (_modalCtx && _modalCtx.mode === 'manage' && _modalCtx.activeOp === 'claim-rewards') {
        _renderManageBody();
      }
    } catch (e) {
      console.error('[portfolio] claimCRV failed', e);
      if (_isUserRejection(e)) _setStatus('Transaction rejected', 'error');
      else _setStatus('Claim CRV failed: ' + (e?.shortMessage || e?.message || 'unknown'), 'error');
    }
  }

  // Note: Curve gauges don't expose per-token extras claim — claim_rewards()
  // is all-or-nothing per gauge. UI collapses 2+ extras into a single "Claim All" row.
  async function claimExtras(idx) {
    const p = _lastPositions[idx];
    if (!p) return;
    const signer = await _ensureSigner();
    if (!signer) { _setStatus('Wallet not connected', 'error'); return; }
    try {
      _setStatus('Claiming extras…', '');
      const gauge = new global.ethers.Contract(p.gaugeAddress, global.GAUGE_ABI, signer);
      const tx = await gauge.claim_rewards();
      console.log('[portfolio] claim_rewards sent', tx.hash, ETHERSCAN_TX + tx.hash);
      await tx.wait();
      _setStatus('Extras claimed', 'success');
      _extrasCache.delete((p.gaugeAddress || '').toLowerCase());
      if (_modalCtx && _modalCtx.mode === 'manage' && _modalCtx.activeOp === 'claim-rewards') {
        _renderManageBody();
      }
    } catch (e) {
      console.error('[portfolio] claimExtras failed', e);
      if (_isUserRejection(e)) _setStatus('Transaction rejected', 'error');
      else _setStatus('Claim extras failed: ' + (e?.shortMessage || e?.message || 'unknown'), 'error');
    }
  }

  async function executeDepositAndStake(idx) {
    const p = _lastPositions[idx];
    if (!p) return;
    const signer = await _ensureSigner();
    if (!signer) { _setStatus('Wallet not connected', 'error'); return; }
    const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
    if (!pool || !Array.isArray(pool.coins) || pool.coins.length === 0) {
      _setStatus('Pool data unavailable', 'error');
      return;
    }
    const n = pool.coins.length;
    const ETH_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const SLIPPAGE_BPS = 50; // 0.5%
    // Read amounts from inputs
    const amounts = [];
    let hasAny = false;
    for (let i = 0; i < n; i++) {
      const inp = document.querySelector(`.pm-coin-amount[data-coin-idx="${i}"]`);
      const val = inp ? parseFloat(inp.value) : 0;
      const dec = parseInt((pool.decimals || [])[i]) || 18;
      if (val > 0) hasAny = true;
      try {
        amounts.push(val > 0 ? global.ethers.parseUnits(val.toFixed(dec > 8 ? 8 : dec), dec) : 0n);
      } catch (e) {
        amounts.push(0n);
      }
    }
    if (!hasAny) { _setStatus('Enter at least one amount', 'error'); return; }
    const gauge = p.gaugeAddress;
    if (!gauge || gauge === ZERO_ADDR) { _setStatus('No gauge for this pool', 'error'); return; }
    try {
      // Step 1: approvals for each non-ETH input.
      _setStatus('Step 1/3: approving deposit tokens…', '');
      for (let i = 0; i < n; i++) {
        if (amounts[i] === 0n) continue;
        const addr = (pool.coinsAddresses[i] || '').toLowerCase();
        if (!addr || addr === ETH_PSEUDO) continue;
        const token = new global.ethers.Contract(pool.coinsAddresses[i], global.ERC20_ABI, signer);
        const allowance = await token.allowance(global.walletAddress, pool.address);
        if (allowance < amounts[i]) {
          await (await token.approve(pool.address, global.ethers.MaxUint256)).wait();
        }
      }
      // Step 2: add_liquidity
      _setStatus('Step 2/3: adding liquidity…', '');
      const ifaceMap = {
        2: new global.ethers.Interface(['function calc_token_amount(uint256[2] amounts, bool deposit) view returns (uint256)']),
        3: new global.ethers.Interface(['function calc_token_amount(uint256[3] amounts, bool deposit) view returns (uint256)']),
        4: new global.ethers.Interface(['function calc_token_amount(uint256[4] amounts, bool deposit) view returns (uint256)']),
      };
      const calcIface = ifaceMap[n];
      let minMint = 0n;
      try {
        if (calcIface) {
          const provider = signer.provider || global.provider;
          const ret = await provider.call({ to: pool.address, data: calcIface.encodeFunctionData('calc_token_amount', [amounts, true]) });
          const [out] = calcIface.decodeFunctionResult('calc_token_amount', ret);
          minMint = (out * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
        }
      } catch (e) { /* leave minMint=0 (no slippage protection — best-effort) */ }
      const addIface = new global.ethers.Interface([`function add_liquidity(uint256[${n}] amounts, uint256 min_mint_amount) payable returns (uint256)`]);
      const poolContract = new global.ethers.Contract(pool.address, addIface, signer);
      let ethValue = 0n;
      for (let i = 0; i < n; i++) {
        if ((pool.coinsAddresses[i] || '').toLowerCase() === ETH_PSEUDO) ethValue = amounts[i];
      }
      await (await poolContract.add_liquidity(amounts, minMint, { value: ethValue })).wait();

      // Step 3: approve LP for gauge → gauge.deposit(lpBal)
      _setStatus('Step 3/3: staking LP…', '');
      const lpAddr = pool.lpTokenAddress || pool.address;
      const lpToken = new global.ethers.Contract(lpAddr, global.ERC20_ABI, signer);
      const lpBal = await lpToken.balanceOf(global.walletAddress);
      if (lpBal === 0n) {
        _setStatus('LP balance 0 after deposit — staking aborted.', 'error');
        return;
      }
      const allowance = await lpToken.allowance(global.walletAddress, gauge);
      if (allowance < lpBal) {
        await (await lpToken.approve(gauge, global.ethers.MaxUint256)).wait();
      }
      // Overload chain (commit de89f481)
      const gaugeContract = new global.ethers.Contract(gauge, [
        'function deposit(uint256)',
        'function deposit(uint256,address)',
        'function deposit(uint256,address,bool)',
      ], signer);
      try {
        await (await gaugeContract['deposit(uint256,address,bool)'](lpBal, global.walletAddress, false)).wait();
      } catch (_) {
        try {
          await (await gaugeContract['deposit(uint256,address)'](lpBal, global.walletAddress)).wait();
        } catch (__) {
          await (await gaugeContract['deposit(uint256)'](lpBal)).wait();
        }
      }
      _setStatus('Done', 'success');
      await _refreshOnePosition(idx);
      closeModal();
    } catch (e) {
      console.error('[portfolio] deposit&stake failed', e);
      if (_isUserRejection(e)) _setStatus('Transaction rejected', 'error');
      else _setStatus('Failed: ' + (e?.shortMessage || e?.message || 'unknown'), 'error');
    }
  }

  // Plain deposit (add_liquidity only, no auto-stake).
  // Mirrors executeDepositAndStake but stops after add_liquidity.
  async function executeDeposit(idx) {
    const p = _lastPositions[idx];
    if (!p) return;
    const signer = await _ensureSigner();
    if (!signer) { _setStatus('Wallet not connected', 'error'); return; }
    const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
    if (!pool || !Array.isArray(pool.coins) || pool.coins.length === 0) {
      _setStatus('Pool data unavailable', 'error');
      return;
    }
    const n = pool.coins.length;
    const ETH_PSEUDO = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    // Match /yield: read global depositSlippage from app.js (defaults 0.5%)
    const slipPct = typeof global.depositSlippage === 'number' ? global.depositSlippage : 0.5;
    const amounts = [];
    let hasAny = false;
    for (let i = 0; i < n; i++) {
      const inp = document.querySelector(`.pm-coin-amount[data-coin-idx="${i}"]`);
      const val = inp ? parseFloat(inp.value) : 0;
      const dec = parseInt((pool.decimals || [])[i]) || 18;
      if (val > 0) hasAny = true;
      try {
        amounts.push(val > 0 ? global.ethers.parseUnits(val.toFixed(dec > 8 ? 8 : dec), dec) : 0n);
      } catch (e) { amounts.push(0n); }
    }
    if (!hasAny) { _setStatus('Enter at least one amount', 'error'); return; }
    try {
      _setStatus('Step 1/2: approving deposit tokens…', '');
      for (let i = 0; i < n; i++) {
        if (amounts[i] === 0n) continue;
        const addr = (pool.coinsAddresses[i] || '').toLowerCase();
        if (!addr || addr === ETH_PSEUDO) continue;
        const token = new global.ethers.Contract(pool.coinsAddresses[i], global.ERC20_ABI, signer);
        const allowance = await token.allowance(global.walletAddress, pool.address);
        if (allowance < amounts[i]) {
          await (await token.approve(pool.address, global.ethers.MaxUint256)).wait();
        }
      }
      _setStatus('Step 2/2: adding liquidity…', '');
      const ifaceMap = {
        2: new global.ethers.Interface(['function calc_token_amount(uint256[2] amounts, bool deposit) view returns (uint256)']),
        3: new global.ethers.Interface(['function calc_token_amount(uint256[3] amounts, bool deposit) view returns (uint256)']),
        4: new global.ethers.Interface(['function calc_token_amount(uint256[4] amounts, bool deposit) view returns (uint256)']),
      };
      const calcIface = ifaceMap[n];
      let minMint = 0n;
      try {
        if (calcIface) {
          const provider = signer.provider || global.provider;
          const ret = await provider.call({ to: pool.address, data: calcIface.encodeFunctionData('calc_token_amount', [amounts, true]) });
          const [out] = calcIface.decodeFunctionResult('calc_token_amount', ret);
          minMint = (out * BigInt(Math.round((1 - slipPct / 100) * 10000))) / 10000n;
        }
      } catch (e) { /* leave minMint=0 best-effort */ }
      const addIface = new global.ethers.Interface([`function add_liquidity(uint256[${n}] amounts, uint256 min_mint_amount) payable returns (uint256)`]);
      const poolContract = new global.ethers.Contract(pool.address, addIface, signer);
      let ethValue = 0n;
      for (let i = 0; i < n; i++) {
        if ((pool.coinsAddresses[i] || '').toLowerCase() === ETH_PSEUDO) ethValue = amounts[i];
      }
      await (await poolContract.add_liquidity(amounts, minMint, { value: ethValue })).wait();
      _setStatus('Deposited', 'success');
      await _refreshOnePosition(idx);
      closeModal();
    } catch (e) {
      console.error('[portfolio] deposit failed', e);
      if (_isUserRejection(e)) _setStatus('Transaction rejected', 'error');
      else _setStatus('Deposit failed: ' + (e?.shortMessage || e?.message || 'unknown'), 'error');
    }
  }

  // Proportional withdraw via remove_liquidity. min_amounts=0 (no slippage protection)
  // matches /yield's "balanced" mode default. Single-coin withdraw stays on /yield.
  async function executeWithdraw(idx, amountStr) {
    const p = _lastPositions[idx];
    if (!p) return;
    const signer = await _ensureSigner();
    if (!signer) { _setStatus('Wallet not connected', 'error'); return; }
    const pool = (global.allPools || []).find(x => (x.address || '').toLowerCase() === (p.poolAddress || '').toLowerCase());
    if (!pool || !Array.isArray(pool.coins) || pool.coins.length === 0) {
      _setStatus('Pool data unavailable', 'error');
      return;
    }
    let amountWei;
    try { amountWei = global.ethers.parseUnits(amountStr, LP_DECIMALS); }
    catch (e) { _setStatus('Invalid amount', 'error'); return; }
    if (amountWei <= 0n) { _setStatus('Amount must be > 0', 'error'); return; }
    try {
      _setStatus('Withdrawing…', '');
      const n = pool.coins.length;
      const minAmounts = new Array(n).fill(0n);
      const iface = new global.ethers.Interface([`function remove_liquidity(uint256 _amount, uint256[${n}] min_amounts) returns (uint256[${n}])`]);
      const contract = new global.ethers.Contract(pool.address, iface, signer);
      const tx = await contract.remove_liquidity(amountWei, minAmounts);
      console.log('[portfolio] withdraw sent', tx.hash, ETHERSCAN_TX + tx.hash);
      await tx.wait();
      _setStatus('Withdrawn', 'success');
      await _refreshOnePosition(idx);
      closeModal();
    } catch (e) {
      console.error('[portfolio] withdraw failed', e);
      if (_isUserRejection(e)) _setStatus('Transaction rejected', 'error');
      else _setStatus('Withdraw failed: ' + (e?.shortMessage || e?.message || 'unknown'), 'error');
    }
  }

  // Refresh ONE position (walletLP, stakedLP, claimable_tokens) and re-render its card.
  async function _refreshOnePosition(idx) {
    const p = _lastPositions[idx];
    if (!p || !global.walletAddress || !global.ethers) return;
    try {
      const provider = global.provider
        || global._portfolioReadProvider
        || (window.ethereum ? new global.ethers.BrowserProvider(window.ethereum) : null);
      if (!provider) return;
      const lpIface = new global.ethers.Interface(global.ERC20_ABI);
      const gaugeIface = new global.ethers.Interface(global.GAUGE_ABI);
      const balanceOfData = lpIface.encodeFunctionData('balanceOf', [global.walletAddress]);
      const claimableData = gaugeIface.encodeFunctionData('claimable_tokens', [global.walletAddress]);
      const totalSupplyData = lpIface.encodeFunctionData('totalSupply', []);
      const multicall = new global.ethers.Contract(MULTICALL3, MULTICALL3_ABI, provider);
      const calls = [
        { target: p.lpTokenAddress, allowFailure: true, callData: balanceOfData },
        { target: p.gaugeAddress, allowFailure: true, callData: balanceOfData },
        { target: p.gaugeAddress, allowFailure: true, callData: claimableData },
        { target: p.lpTokenAddress, allowFailure: true, callData: totalSupplyData },
      ];
      const res = await multicall.aggregate3.staticCall(calls);
      let walletBn = 0n, stakedBn = 0n, pendingBn = 0n, totalSupplyBn = 0n;
      try { if (res[0]?.success) [walletBn] = lpIface.decodeFunctionResult('balanceOf', res[0].returnData); } catch (e) {}
      try { if (res[1]?.success) [stakedBn] = lpIface.decodeFunctionResult('balanceOf', res[1].returnData); } catch (e) {}
      try { if (res[2]?.success) [pendingBn] = gaugeIface.decodeFunctionResult('claimable_tokens', res[2].returnData); } catch (e) {}
      try { if (res[3]?.success) [totalSupplyBn] = lpIface.decodeFunctionResult('totalSupply', res[3].returnData); } catch (e) {}
      const totalBn = walletBn + stakedBn;
      p.walletLP = parseFloat(global.ethers.formatUnits(walletBn, LP_DECIMALS));
      p.stakedLP = parseFloat(global.ethers.formatUnits(stakedBn, LP_DECIMALS));
      p.totalLP = parseFloat(global.ethers.formatUnits(totalBn, LP_DECIMALS));
      p.pendingCRV = parseFloat(global.ethers.formatUnits(pendingBn, LP_DECIMALS));
      const totalSupplyLP = parseFloat(global.ethers.formatUnits(totalSupplyBn, LP_DECIMALS));
      if (totalSupplyLP > 0) p.totalSupplyLP = totalSupplyLP;
      // Recompute USD using on-chain totalSupply (factory pools), fallback to API/virtualPrice
      const pool = (global.allPools || []).find(x => x.address === p.poolAddress);
      const tvl = pool ? pool.tvl : 0;
      if (tvl > 0 && p.totalSupplyLP > 0) {
        p.usdValue = p.totalLP * (tvl / p.totalSupplyLP);
      } else if (pool && pool.tvl && pool.totalSupply > 0) {
        p.usdValue = p.totalLP * (pool.tvl / pool.totalSupply);
      } else if (p.virtualPrice && p.virtualPrice > 0) {
        p.usdValue = p.totalLP * (p.virtualPrice / 1e18);
      }
      // Re-render only this card
      const view = document.getElementById('view-portfolio');
      const card = view && view.querySelector(`.position-card[data-pool="${p.poolAddress}"]`);
      if (card) {
        const tmp = document.createElement('div');
        tmp.innerHTML = _renderPositionCard(p, idx);
        const next = tmp.firstElementChild;
        if (next) card.replaceWith(next);
      }
      _writeCache(global.walletAddress, _lastPositions);
    } catch (e) {
      console.warn('[portfolio] refresh one failed', e?.message);
    }
  }

  // -------- wallet dropdown menu --------
  let _menuClickHandler = null;
  function openWalletMenu() {
    const btn = document.getElementById('walletBtn');
    if (!btn) return;
    let menu = document.getElementById('walletMenu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'walletMenu';
      menu.className = 'wallet-menu';
      document.body.appendChild(menu);
    }
    if (menu.style.display === 'block') {
      closeWalletMenu();
      return;
    }
    const addr = global.walletAddress || '';
    menu.innerHTML = `
      <div class="wm-item wm-addr" title="${addr}">${addr ? addr.slice(0,6) + '\u2026' + addr.slice(-4) : '--'}</div>
      <button class="wm-item wm-action" onclick="Portfolio.menuDashboard()">Dashboard</button>
      <button class="wm-item wm-action" onclick="Portfolio.menuCopyAddr()">Copy address</button>
      <button class="wm-item wm-action" onclick="Portfolio.menuEtherscan()">View on Etherscan</button>
      <button class="wm-item wm-action wm-action-danger" onclick="Portfolio.menuDisconnect()">Disconnect</button>
    `;
    // Position below button, right-aligned
    const r = btn.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = (r.bottom + 4) + 'px';
    menu.style.right = (window.innerWidth - r.right) + 'px';
    menu.style.left = 'auto';
    menu.style.display = 'block';
    btn.setAttribute('aria-expanded', 'true');
    // Close on outside click
    setTimeout(() => {
      _menuClickHandler = (e) => {
        if (!menu.contains(e.target) && e.target !== btn) closeWalletMenu();
      };
      document.addEventListener('click', _menuClickHandler);
    }, 0);
  }
  function closeWalletMenu() {
    const menu = document.getElementById('walletMenu');
    if (menu) menu.style.display = 'none';
    const btn = document.getElementById('walletBtn');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (_menuClickHandler) {
      document.removeEventListener('click', _menuClickHandler);
      _menuClickHandler = null;
    }
  }
  function menuDashboard() {
    closeWalletMenu();
    if (typeof global.navigate === 'function') global.navigate('#/portfolio');
    else openPortfolio();
  }
  function menuCopyAddr() {
    closeWalletMenu();
    const addr = global.walletAddress || '';
    if (!addr) return;
    if (navigator.clipboard) navigator.clipboard.writeText(addr).catch(() => {});
  }
  function menuEtherscan() {
    closeWalletMenu();
    const addr = global.walletAddress || '';
    if (addr) window.open(window.getExplorerAddressUrl ? window.getExplorerAddressUrl(addr) : 'https://etherscan.io/address/' + addr, '_blank');
  }
  function menuDisconnect() {
    closeWalletMenu();
    try {
      localStorage.removeItem('curvedex_wallet_connected');
      localStorage.removeItem('curvedex_wallet_address');
      localStorage.removeItem(PORTFOLIO_CACHE_KEY);
    } catch (e) {}
    global.walletAddress = null;
    global.signer = null;
    if (typeof global._resetWalletBalanceCache === 'function') global._resetWalletBalanceCache();
    const btn = document.getElementById('walletBtn');
    if (btn) {
      btn.innerHTML = '<span class="wallet-btn-icon" aria-hidden="true"><svg class="icon"><use href="#icon-wallet"/></svg></span><span class="wallet-btn-text">Connect Wallet</span>';
      btn.className = 'wallet-btn';
      btn.onclick = global.connectWallet;
    }
    if (typeof global.updateSwapButton === 'function') global.updateSwapButton();
    if (typeof global.updateDepositButton === 'function') global.updateDepositButton();
    if (typeof global.updateWithdrawButton === 'function') global.updateWithdrawButton();
    if (typeof global.updateTradePairButton === 'function') global.updateTradePairButton();
    // If on portfolio view, redirect
    if (window.location.hash === '#/portfolio') global.navigate('#/yield');
  }

  // After successful connect, swap button onclick to open menu instead of connect.
  function attachWalletDropdown() {
    const btn = document.getElementById('walletBtn');
    if (!btn) return;
    btn.onclick = (e) => { e.stopPropagation(); openWalletMenu(); };
  }

  // -------- expose --------
  global.Portfolio = {
    open: openPortfolio,
    load: loadPortfolioPositions,
    loadCrossPlatform: loadCrossPlatformPositions,
    claimOne, claimAll, claimCRV, claimExtras, gotoStake, gotoUnstake,
    openStakeModal, openUnstakeModal, closeModal,
    openManageModal, setManageTopTab, setManageSubTab,
    executeStake, executeUnstake, executeClaimRewards, executeDepositAndStake,
    executeDeposit, executeWithdraw,
    openWalletMenu, closeWalletMenu, attachWalletDropdown,
    menuDashboard, menuCopyAddr, menuEtherscan, menuDisconnect,
    _invalidateCache,
    _preloadPositions,
    _fetchExtras,
  };
})(window);
