// ============================================================
// SWAP VIEW: Clean swap interface without chart
// Reuses: CurveDEXRouter (router.js), token data (app.js globals)
// ============================================================

// FEATURE FLAGS
// Hide "Quote Comparison" panel until multiple aggregators are wired up.
// Flip to true once ParaSwap/CoW/ODOS quotes can be compared meaningfully.
const SHOW_QUOTE_COMPARISON_SWAP = false;

// Swap view state
let swapSelectedFrom = null;
let swapSelectedTo = null;
let swapRouterInstance = null;
let swapQuoteDebounce = null;
// Monotonic request counter for last-request-wins guard in fetchSwapQuote.
// User typing "1234567890" fast → multiple in-flight quotes; only the LAST
// captured id is allowed to write to UI. Stale results (network slower, or
// failed) must not leave smaller-input quote on screen.
let swapQuoteRequestId = 0;
let swapTokenModalTarget = 'from';
let swapSlippage = 0.5;
let swapLastQuote = null;

// ============================================================
// INIT & ROUTER
// ============================================================
function getSwapRouter() {
  if (!swapRouterInstance && typeof CurveDEXRouter !== 'undefined') {
    // Quote engine config: 12s timeout to accommodate graph-split's 4-hop paths
    // for niche tokens (e.g. sdYB→scrvUSD). strategies=null → use all 5 core Curve
    // strategies. For free-form any→any swaps this gives best route discovery.
    swapRouterInstance = new CurveDEXRouter({
      rpcCall: rpcCall,
      pools: allPools,
      chainId: (window.getChainId ? window.getChainId() : 1),
      quoteTimeout: 12000,
      enableParaSwap: false,
      enableCow: false,
      enableOdos: false,
    });
  }
  return swapRouterInstance;
}

function resetSwapRouter() { swapRouterInstance = null; }

function initSwapView() {
  if (!allPools.length) return;
  // Populate tokens from allPools (reuse tradeTokenList from trade.js)
  if (!tradeTokenList || tradeTokenList.length === 0) {
    populateTradeTokens();
  }
  // Default from: native gas-token if pool has one (ETH/xDAI/MATIC/AVAX/...), else first
  if (!swapSelectedFrom) {
    swapSelectedFrom = tradeTokenList.find(t => t._isNativeETH) ||
                       tradeTokenList[0];
  }
  // Pick To if unset, OR fix-up if From==To (by addr OR by symbol — multiple
  // tokens can share a symbol like 'USDC' on Ethereum, both result in confusing
  // 'USDC ↔ USDC' display).
  const _fromAddrLc = () => ((swapSelectedFrom && swapSelectedFrom.address) || '').toLowerCase();
  const _fromSym = () => (swapSelectedFrom && swapSelectedFrom.symbol) || '';
  const _eqFrom = (t) => t && (
    (t.address || '').toLowerCase() === _fromAddrLc() ||
    t.symbol === _fromSym()
  );
  const _pickTo = () => {
    const pick = (sym) => sym !== _fromSym() && tradeTokenList.find(t => t.symbol === sym && !_eqFrom(t));
    return pick('USDC') || pick('crvUSD') || pick('USDT') ||
           pick('USDS') || pick('DAI') || pick('WETH') || pick('WBTC') ||
           tradeTokenList.find(t => !_eqFrom(t)) || null;
  };
  if (!swapSelectedTo || _eqFrom(swapSelectedTo)) {
    swapSelectedTo = _pickTo();
  }
  // Also fix-up From if it's not in new chain's token list (chain switch).
  if (swapSelectedFrom && !tradeTokenList.some(t => (t.address || '').toLowerCase() === _fromAddrLc())) {
    swapSelectedFrom = tradeTokenList.find(t => t._isNativeETH) || tradeTokenList[0] || null;
    if (swapSelectedTo && _eqFrom(swapSelectedTo)) {
      swapSelectedTo = _pickTo();
    }
  }
  updateSwapTokenUI('from', swapSelectedFrom);
  updateSwapTokenUI('to', swapSelectedTo);
  // Smart slippage default: stable↔stable → stable bucket (0.02%), otherwise crypto bucket (0.1%) (no-op if
  // user has touched slippage in this session).
  if (typeof window._applySmartSlippageForPair === 'function' && swapSelectedFrom && swapSelectedTo) {
    window._applySmartSlippageForPair(swapSelectedFrom.symbol, swapSelectedTo.symbol);
  }
  updateSwapViewButton();
  if (walletAddress) loadSwapBalances();
}

// ============================================================
// TOKEN UI
// ============================================================
function updateSwapTokenUI(side, token) {
  const nameEl = document.getElementById(side === 'from' ? 'swapViewFromName' : 'swapViewToName');
  const iconElId = side === 'from' ? 'swapViewFromIcon' : 'swapViewToIcon';
  if (token) {
    if (nameEl) nameEl.textContent = token.symbol;
    if (typeof _setTokenIcon === 'function') {
      _setTokenIcon(iconElId, token.address, token.symbol);
    }
  } else {
    if (nameEl) nameEl.textContent = 'Select';
    const iconEl = document.getElementById(iconElId);
    if (iconEl) {
      iconEl.style.backgroundImage = '';
      iconEl.style.color = '';
      iconEl.textContent = '?';
    }
  }
}

// ============================================================
// TOKEN MODAL
// ============================================================
function openSwapTokenModal(target) {
  swapTokenModalTarget = target;
  const searchInput = document.getElementById('swapTokenSearchInput');
  if (searchInput) searchInput.value = '';
  renderSwapTokenModalList('');
  document.getElementById('swapTokenModal').classList.add('show');
  setTimeout(() => { if (searchInput) searchInput.focus(); }, 100);
}

function closeSwapTokenModal() {
  document.getElementById('swapTokenModal').classList.remove('show');
}

// See trade.js for the symmetric helper. We duplicate here (instead of
// hoisting to app.js) because the row template references swap-specific
// state (swapSelectedFrom/To, swapTokenModalTarget, selectSwapToken).
let _swapTokenModalRenderToken = 0;

function _sortSwapTokensByBalance(tokens, balMap) {
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

function _renderSwapTokenModalRows(showList, balMap) {
  return showList.map(t => {
    const poolCount = t.pools ? t.pools.size : 0;
    const isSelected = (swapTokenModalTarget === 'from' && swapSelectedFrom && swapSelectedFrom.address === t.address) ||
                       (swapTokenModalTarget === 'to' && swapSelectedTo && swapSelectedTo.address === t.address);
    const iconUrl = _tokenIconUrl(t.address);
    const e = balMap ? balMap.get(t.address.toLowerCase()) : null;
    const balStr = e ? _fmtTokenBalance(e.balance) : '';
    const usdStr = e ? _fmtTokenUsd(e.usdValue) : '';
    const balLine = balStr
      ? `<div class="token-bal">${balStr}${usdStr ? ` <span class="token-usd">(${usdStr})</span>` : ''}</div>`
      : '';
    return `<div class="token-modal-item${isSelected ? ' selected' : ''}" onclick="selectSwapToken('${t.address}')">
      <img class="token-icon" src="${iconUrl}" alt="" width="28" height="28" style="border-radius:50%;object-fit:cover" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="token-icon" style="display:none">${t.symbol.slice(0, 2)}</div>
      <div class="token-modal-info">
        <div class="token-name">${t.symbol}</div>
        <div class="token-addr"><a href="${window.getExplorerTokenUrl ? window.getExplorerTokenUrl(t.address) : 'https://etherscan.io/token/' + t.address}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()" title="${t.address}">${t.address.slice(0, 6)}...${t.address.slice(-4)}</a></div>
        <div class="token-pools">${poolCount} pool${poolCount !== 1 ? 's' : ''}</div>
      </div>
      ${balLine}
    </div>`;
  }).join('');
}

function renderSwapTokenModalList(query) {
  const list = document.getElementById('swapTokenModalList');
  let tokens = tradeTokenList || [];
  if (query) {
    const q = query.toLowerCase();
    tokens = tokens.filter(t =>
      t.symbol.toLowerCase().includes(q) ||
      t.address.toLowerCase().includes(q)
    );
  }

  const cachedBalMap = (typeof _walletBalanceCache !== 'undefined' && walletAddress &&
    _walletBalanceCache.walletAddress &&
    _walletBalanceCache.walletAddress.toLowerCase() === walletAddress.toLowerCase())
    ? _walletBalanceCache.entries
    : null;

  let display = tokens;
  if (cachedBalMap && cachedBalMap.size > 0) {
    display = _sortSwapTokensByBalance(tokens, cachedBalMap);
  }
  const show = display.slice(0, 100);
  list.innerHTML = _renderSwapTokenModalRows(show, cachedBalMap);
  if (show.length === 0) {
    list.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim);font-size:12px;">No tokens found</div>';
    return;
  }

  if (!walletAddress || typeof getWalletTokenBalances !== 'function') return;
  const myToken = ++_swapTokenModalRenderToken;
  const fetchScope = tokens.slice(0, 100);
  getWalletTokenBalances(fetchScope, walletAddress).then(balMap => {
    if (myToken !== _swapTokenModalRenderToken) return;
    if (!balMap || balMap.size === 0) return;
    const sorted = _sortSwapTokensByBalance(tokens, balMap);
    const show2 = sorted.slice(0, 100);
    list.innerHTML = _renderSwapTokenModalRows(show2, balMap);
  }).catch(() => { /* swallow */ });
}

function selectSwapToken(address) {
  const token = tradeTokenList.find(t => t.address === address);
  if (!token) return;

  if (swapTokenModalTarget === 'from') {
    if (swapSelectedTo && swapSelectedTo.address === address) {
      swapSelectedTo = swapSelectedFrom;
      updateSwapTokenUI('to', swapSelectedTo);
    }
    swapSelectedFrom = token;
    updateSwapTokenUI('from', token);
  } else {
    if (swapSelectedFrom && swapSelectedFrom.address === address) {
      swapSelectedFrom = swapSelectedTo;
      updateSwapTokenUI('from', swapSelectedFrom);
    }
    swapSelectedTo = token;
    updateSwapTokenUI('to', token);
  }

  // Smart slippage default: stable↔stable pair auto-selects the stable bucket (0.02%),
  // otherwise the crypto bucket (0.1%). No-op if the user has overridden manually in this session.
  if (typeof window._applySmartSlippageForPair === 'function' && swapSelectedFrom && swapSelectedTo) {
    window._applySmartSlippageForPair(swapSelectedFrom.symbol, swapSelectedTo.symbol);
  }

  closeSwapTokenModal();
  onSwapTokensChanged();
}

// ============================================================
// TOKEN CHANGE HANDLER
// ============================================================
function onSwapTokensChanged() {
  // Show loading placeholders for all quote-derived fields so stale values
  // from previous token pair don't linger while new quote is being fetched.
  const _fromAmt = document.getElementById('swapViewFromAmt')?.value;
  if (_fromAmt && parseFloat(_fromAmt) > 0 && typeof _setSwapQuoteLoading === 'function') {
    _setSwapQuoteLoading();
  } else {
    // No amount yet — at least refresh balances and clear any old state
    const fromBal = document.getElementById('swapViewFromBal');
    if (fromBal) fromBal.textContent = 'Balance: ...';
    const toBal = document.getElementById('swapViewToBal');
    if (toBal) toBal.textContent = 'Balance: ...';
  }

  updateSwapViewButton();
  if (walletAddress) loadSwapBalances();

  // Update static route preview (synchronously re-renders the Sankey viz
  // we just cleared, before the async quote arrives)
  updateSwapRoutePreview();

  // Re-fetch quote if amount entered
  const fromAmt = document.getElementById('swapViewFromAmt')?.value;
  if (fromAmt && parseFloat(fromAmt) > 0) {
    clearTimeout(swapQuoteDebounce);
    swapQuoteDebounce = setTimeout(fetchSwapQuote, 600);
  }
}

let _swapRoutePreviewSeq = 0;
async function updateSwapRoutePreview() {
  const routeViz = document.getElementById('swapRouteViz');
  const routePath = document.getElementById('swapRoutePath');
  const emptyMsg = document.getElementById('swapRouteEmpty');

  if (!swapSelectedFrom || !swapSelectedTo) {
    if (routeViz) routeViz.style.display = 'none';
    if (emptyMsg) emptyMsg.style.display = '';
    return;
  }

  const fromAddr = _resolveTokenAddr(swapSelectedFrom);
  const toAddr = _resolveTokenAddr(swapSelectedTo);
  if (fromAddr === toAddr) {
    if (routeViz) routeViz.style.display = 'none';
    if (emptyMsg) { emptyMsg.style.display = ''; emptyMsg.textContent = 'Select different tokens'; }
    return;
  }

  const seq = ++_swapRoutePreviewSeq;

  // Async router probe via shared helper. Until it returns, hide viz so
  // we don't flash a misleading TVL-best pool that doesn't match the swap.
  if (routeViz) routeViz.style.display = 'none';
  if (emptyMsg) { emptyMsg.style.display = ''; emptyMsg.textContent = 'Resolving route…'; }

  try { await loadEthers(); } catch {}
  const router = getSwapRouter();
  const fromDec = Number.isFinite(swapSelectedFrom.decimals) ? swapSelectedFrom.decimals : 18;
  const toDec = Number.isFinite(swapSelectedTo.decimals) ? swapSelectedTo.decimals : 18;
  const quote = (typeof _getRoutePreview === 'function')
    ? await _getRoutePreview(router, fromAddr, toAddr, fromDec, toDec)
    : null;

  // Race guard: another token-change happened while we were probing.
  if (seq !== _swapRoutePreviewSeq) return;
  if (!swapSelectedFrom || !swapSelectedTo) return;
  if (_resolveTokenAddr(swapSelectedFrom) !== fromAddr || _resolveTokenAddr(swapSelectedTo) !== toAddr) return;

  if (quote && quote.route && quote.route.length >= 1) {
    // Build the diagram straight from the quote's own legs. Unlike the old
    // allPools.find(...).filter(Boolean) mapping, this does NOT drop legs whose
    // pool isn't a Curve pool in the cache (ERC-4626 vault redeem/deposit legs),
    // and supports arbitrary multi-hop. Returns null for parallel/split routes —
    // same as the old code did (their branch objects had no .pool → empty map).
    const multiPaths = (typeof _buildRouteVizPaths === 'function')
      ? _buildRouteVizPaths(quote, router) : null;
    if (!multiPaths) {
      if (routeViz) routeViz.style.display = 'none';
      if (emptyMsg) { emptyMsg.style.display = ''; emptyMsg.textContent = 'No Curve route (aggregators available)'; }
      return;
    }
    if (routePath) routePath.innerHTML = _buildMultiPathSVG(swapSelectedFrom.symbol, swapSelectedTo.symbol, multiPaths);
    if (routeViz) routeViz.style.display = '';
    if (emptyMsg) emptyMsg.style.display = 'none';
    return;
  }

  // Router probe failed for all 3 amounts — fall back to legacy TVL lookup
  // so we still show something useful instead of an indefinite spinner.
  const bestPool = findBestPool(fromAddr, toAddr);
  if (bestPool) {
    const poolName = bestPool.name || '?';
    const tvl = bestPool.tvl || 0;
    const multiPaths = [{ poolNames: [poolName], midTokenSyms: [], pct: 100, tvl }];
    if (routePath) routePath.innerHTML = _buildMultiPathSVG(swapSelectedFrom.symbol, swapSelectedTo.symbol, multiPaths);
    if (routeViz) routeViz.style.display = '';
    if (emptyMsg) emptyMsg.style.display = 'none';
  } else {
    const multiRoute = findMultiHopRoute(fromAddr, toAddr);
    if (multiRoute && multiRoute.length > 0) {
      const poolNames = multiRoute.map(p => p.name || '?');
      const midTokenSyms = [];
      if (multiRoute.length >= 2) {
        const pool1Addrs = (multiRoute[0].coinsAddresses || []).map(a => a.toLowerCase());
        const pool2Addrs = (multiRoute[1].coinsAddresses || []).map(a => a.toLowerCase());
        const common = pool1Addrs.filter(a => pool2Addrs.includes(a) && a !== fromAddr.toLowerCase() && a !== toAddr.toLowerCase());
        if (common.length > 0) {
          const midPool = allPools.find(p => (p.coinsAddresses || []).map(a => a.toLowerCase()).includes(common[0]));
          if (midPool) {
            const idx = midPool.coinsAddresses.findIndex(a => a.toLowerCase() === common[0]);
            midTokenSyms.push(midPool.coins[idx] || '?');
          }
        }
      }
      const tvl = Math.min(...multiRoute.map(p => p.tvl || 0));
      const multiPaths = [{ poolNames, midTokenSyms, pct: 100, tvl }];
      if (routePath) routePath.innerHTML = _buildMultiPathSVG(swapSelectedFrom.symbol, swapSelectedTo.symbol, multiPaths);
      if (routeViz) routeViz.style.display = '';
      if (emptyMsg) emptyMsg.style.display = 'none';
    } else {
      if (routeViz) routeViz.style.display = 'none';
      if (emptyMsg) { emptyMsg.style.display = ''; emptyMsg.textContent = 'No Curve route (aggregators available)'; }
    }
  }
}

// ============================================================
// QUOTE FETCH
// ============================================================
async function fetchSwapQuote() {
  if (!swapSelectedFrom || !swapSelectedTo) return;
  const fromAmt = document.getElementById('swapViewFromAmt')?.value;
  if (!fromAmt || parseFloat(fromAmt) <= 0) {
    hideSwapQuoteDetails();
    return;
  }

  // Capture request id — only the LAST issued request is allowed to write
  // to the UI. Stale in-flight results (typing-race or post-failure) are
  // dropped silently to avoid digit-by-digit flicker + smaller-substring
  // values appearing as final output.
  const myId = ++swapQuoteRequestId;

  // Show loading state
  const toInput = document.getElementById('swapViewToAmt');
  if (toInput) { toInput.value = ''; toInput.placeholder = 'Loading...'; }
  const btn = document.getElementById('swapViewBtn');
  if (btn) { btn.textContent = 'Fetching quote...'; btn.className = 'swap-submit disabled'; }

  await loadEthers();
  if (myId !== swapQuoteRequestId) return; // a newer request superseded us
  const router = getSwapRouter();
  if (!router) { if (toInput) toInput.placeholder = '0.0'; return; }

  try {
    // Use _resolveTokenAddr (from trade.js) to normalize ETH→WETH for pool lookups
    // Router internally also normalizes, but be explicit for parity with /trade logic
    const fromAddr = (typeof _resolveTokenAddr === 'function')
      ? _resolveTokenAddr(swapSelectedFrom)
      : swapSelectedFrom.address;
    const toAddr = (typeof _resolveTokenAddr === 'function')
      ? _resolveTokenAddr(swapSelectedTo)
      : swapSelectedTo.address;

    const quote = await router.getQuote(
      swapSelectedFrom.address,
      swapSelectedTo.address,
      fromAmt,
      swapSelectedFrom.decimals,
      swapSelectedTo.decimals,
      swapSlippage,
      walletAddress || null
    );

    // Drop if a newer request superseded us mid-flight. Without this, the
    // smaller-substring quote (e.g. "12") could land AFTER the larger ("12345")
    // because earlier in-flight RPCs raced — leaving wrong value on screen.
    if (myId !== swapQuoteRequestId) return;

    if (toInput) toInput.placeholder = '0.0';
    if (!quote) { hideSwapQuoteDetails(); return; }
    swapLastQuote = quote;
    // Route resolved → re-classify slippage bucket from resolved pool types
    // (authoritative; corrects the provisional symbol-based pre-route guess).
    if (typeof window._applySmartSlippageForRoute === 'function') window._applySmartSlippageForRoute(quote);

    // Update To amount
    if (toInput) toInput.value = parseFloat(quote.outputAmount).toFixed(6);

    // Update swap details
    const detailsEl = document.getElementById('swapViewDetails');
    if (detailsEl) detailsEl.style.display = '';

    const rateEl = document.getElementById('swapViewRate');
    if (rateEl) rateEl.textContent = `1 ${swapSelectedFrom.symbol} = ${quote.rate.toFixed(6)} ${swapSelectedTo.symbol}`;

    const impactEl = document.getElementById('swapViewImpact');
    if (impactEl) {
      let impact = quote.priceImpact;
      if (impact == null) {
        // Fallback: compute via micro-quote (router preferred path is invariant
        // simulation; this is safety net for sources that don't return priceImpact).
        // Signed convention: NEGATIVE = loss, POSITIVE = premium.
        try {
          const microQuote = await router.getQuote(
            fromAddr, toAddr,
            '0.01',
            swapSelectedFrom.decimals || 18,
            swapSelectedTo.decimals || 18,
            swapSlippage, null
          );
          if (microQuote && microQuote.rate > 0) {
            const computed = (quote.rate - microQuote.rate) / microQuote.rate * 100;
            if (Math.abs(computed) > 1e-6) impact = computed;
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

    const routeInfoEl = document.getElementById('swapViewRouteInfo');
    if (routeInfoEl) {
      // Format depends on routing strategy:
      // - Sequential routes (curve-direct, curve-router): join hops with ' -> '
      // - Parallel split routes (curve-split, curve-multi-path, curve-graph-split):
      //   summarize as "N paths via X, Y, ..." — concatenating poolName chains for each
      //   path produces a misleading cycle-looking string ("sdYB/YB -> YB/crvUSD -> ... -> sdYB/YB -> ...").
      //   The SVG sankey diagram below conveys the parallel structure visually; this
      //   text just needs to give a 1-line summary that matches what the diagram shows.
      const isSplit = quote.source === 'curve-split'
        || quote.source === 'curve-multi-path'
        || quote.source === 'curve-graph-split';
      let routeText;
      if (isSplit && Array.isArray(quote.route) && quote.route.length > 1) {
        // For parallel split routes, the diagram shows each branch in full — the text
        // just gives a per-path summary so the user can see how the volume splits.
        // We pick the LAST pool of each path because in graph-split routes all paths
        // typically share a common prefix (e.g. sdYB/YB → YB/crvUSD → crvUSD/DOLA),
        // so the differentiating step is at the tail. Cap at 4 distinct names so the
        // line stays readable on narrow viewports.
        const reps = [];
        const seen = new Set();
        for (const path of quote.route) {
          const legs = path.legs || [];
          const lastLeg = legs.length > 0 ? legs[legs.length - 1] : null;
          const repName = _shortPoolName(
            lastLeg?.poolName ||
            (path.poolName || '').split(' -> ').pop() ||
            '?'
          );
          if (repName && repName !== '?' && !seen.has(repName)) {
            seen.add(repName);
            reps.push(repName);
            if (reps.length >= 4) break;
          }
        }
        const more = quote.route.length > reps.length ? ` +${quote.route.length - reps.length}` : '';
        const lead = reps.length > 0 ? ` via ${reps.join(', ')}${more}` : '';
        routeText = `${quote.route.length} parallel paths${lead}`;
      } else {
        const routeParts = quote.route.map(r => _shortPoolName(r.poolName || r.exchange || '?')).filter(x => x && x !== '?');
        routeText = routeParts.length > 0 ? routeParts.join(' -> ') : (quote.sourceName || quote.source || 'Direct');
      }
      routeInfoEl.textContent = routeText;
    }

    // Refresh the SVG route diagram to match THIS quote (the one that executes
    // at the user's real amount). The pre-amount preview draws the diagram from
    // fixed probe amounts (1000/100/1); since the best route is amount-dependent,
    // that diagram can show a different (e.g. simpler single-pool) path than the
    // real swap. Re-render it here from the actual quote's legs so the picture
    // always equals what gets submitted. Split/parallel routes return null →
    // we leave the preview diagram (their text summary above already conveys it).
    {
      const routePathEl = document.getElementById('swapRoutePath');
      const routeVizEl = document.getElementById('swapRouteViz');
      const routeEmptyEl = document.getElementById('swapRouteEmpty');
      if (routePathEl && typeof _buildRouteVizPaths === 'function' && typeof _buildMultiPathSVG === 'function') {
        const vizPaths = _buildRouteVizPaths(quote, router);
        if (vizPaths) {
          routePathEl.innerHTML = _buildMultiPathSVG(swapSelectedFrom.symbol, swapSelectedTo.symbol, vizPaths);
          if (routeVizEl) routeVizEl.style.display = '';
          if (routeEmptyEl) routeEmptyEl.style.display = 'none';
        }
      }
    }

    // Eff. fee (current/dynamic fee): on-chain dynamic_fee(i,j) for the
    // FIRST hop of the route — the pool where the input token enters. This is
    // the deviation-adjusted fee the tester asked for. StableSwapNG-only;
    // crypto/legacy pools revert dynamic_fee → we hide the row gracefully.
    // Race-guarded by the same `myId !== swapQuoteRequestId` check used above.
    const dynFeeRow = document.getElementById('swapViewDynFeeRow');
    const dynFeeEl = document.getElementById('swapViewDynFee');
    if (dynFeeRow && dynFeeEl) {
      dynFeeRow.style.display = 'none'; // default hidden until we have a value
      const firstLeg = Array.isArray(quote.route) && quote.route.length > 0 ? quote.route[0] : null;
      const legPoolAddr = firstLeg && (firstLeg.pool || '');
      const iFrom = firstLeg && Number.isInteger(firstLeg.iFrom) ? firstLeg.iFrom : -1;
      const iTo = firstLeg && Number.isInteger(firstLeg.iTo) ? firstLeg.iTo : -1;
      const legPool = legPoolAddr
        ? allPools.find(p => (p.address || '').toLowerCase() === legPoolAddr.toLowerCase())
        : null;
      if (legPool && iFrom >= 0 && iTo >= 0 && iFrom !== iTo
          && typeof window.fetchPoolOnchainFeeOracle === 'function') {
        const _fmt = (p) => (typeof _fmtPctTrim === 'function' ? _fmtPctTrim(p) : (p != null ? p.toFixed(4) + '%' : null));
        window.fetchPoolOnchainFeeOracle(legPool, [[iFrom, iTo]]).then((info) => {
          if (myId !== swapQuoteRequestId) return; // stale quote, drop
          const pct = info && info.dynFeePct ? info.dynFeePct[iFrom + '-' + iTo] : null;
          if (pct != null && isFinite(pct)) {
            dynFeeEl.textContent = _fmt(pct) || '--';
            dynFeeRow.style.display = '';
          } else {
            dynFeeRow.style.display = 'none';
          }
        }).catch((e) => {
          // dynamic_fee not supported on this pool (crypto/legacy) — hide.
          if (myId !== swapQuoteRequestId) return;
          dynFeeRow.style.display = 'none';
        });
      }
    }

    // Update route visualization from quote (reuse trade.js functions)
    updateSwapRouteVizFromQuote(quote);

    // Render aggregator comparison
    renderSwapAggComparison(quote);

    // Render gas estimation (async, non-blocking)
    _lastSwapQuoteForGas = quote;
    renderSwapGasEstimate(quote, router);

    updateSwapViewButton();

  } catch (e) {
    console.warn('Swap quote error:', e);
    // Only mutate UI if WE are still the latest request — a stale failure
    // must not clobber a successful newer quote that already painted.
    if (myId !== swapQuoteRequestId) return;
    const toInputErr = document.getElementById('swapViewToAmt');
    if (toInputErr) { toInputErr.value = ''; toInputErr.placeholder = '—'; }
    hideSwapQuoteDetails();
    const btnErr = document.getElementById('swapViewSubmit');
    if (btnErr) { btnErr.textContent = 'Quote failed — retry'; btnErr.className = 'swap-submit disabled'; }
  }
}

function hideSwapQuoteDetails() {
  const detailsEl = document.getElementById('swapViewDetails');
  if (detailsEl) detailsEl.style.display = 'none';
  const toInput = document.getElementById('swapViewToAmt');
  if (toInput) toInput.value = '';
  const aggContainer = document.getElementById('swapAggCompare');
  if (aggContainer) aggContainer.classList.remove('show');
  swapLastQuote = null;
  // Reset dynamic-fee row so a stale value from a prior pair doesn't linger
  // when the details panel is next shown for a pool without dynamic_fee.
  const dynFeeRowReset = document.getElementById('swapViewDynFeeRow');
  if (dynFeeRowReset) dynFeeRowReset.style.display = 'none';
  // Reset gas estimate UI
  _lastSwapQuoteForGas = null;
  const gasEl = document.getElementById('swapViewGas');
  if (gasEl) { gasEl.textContent = '--'; gasEl.className = 'gas-value'; }
  // Breakdown rows stay in-flow (parent #swapViewDetails is hidden above); reset
  // text only, so they reserve constant height and never shift layout when the
  // async gas estimate lands.
  const baEl = document.getElementById('swapViewGasApprove');
  if (baEl) baEl.textContent = '--';
  const bsEl = document.getElementById('swapViewGasSwap');
  if (bsEl) bsEl.textContent = '--';
  updateSwapViewButton();
}

// ============================================================
// LOADING STATE: called at start of every token-change path so
// stale quote/rate/route/gas/balance values don't linger while a
// fresh quote is being fetched (~200-400ms gap looked broken).
// ============================================================
function _setSwapQuoteLoading() {
  // Output amount input
  const toInput = document.getElementById('swapViewToAmt');
  if (toInput) { toInput.value = ''; toInput.placeholder = 'Loading...'; }

  // Show details container so loading dots are visible
  const detailsEl = document.getElementById('swapViewDetails');
  if (detailsEl) detailsEl.style.display = '';

  // Rate / impact / route info
  const rateEl = document.getElementById('swapViewRate');
  if (rateEl) rateEl.textContent = '...';
  const impactEl = document.getElementById('swapViewImpact');
  if (impactEl) { impactEl.textContent = '...'; impactEl.style.color = ''; }
  const routeEl = document.getElementById('swapViewRouteInfo');
  if (routeEl) routeEl.textContent = '...';

  // Gas total + breakdown
  const gasEl = document.getElementById('swapViewGas');
  if (gasEl) { gasEl.textContent = '...'; gasEl.className = 'gas-value loading'; }
  const gApprove = document.getElementById('swapViewGasApprove');
  if (gApprove) gApprove.textContent = '...';
  const gSwap = document.getElementById('swapViewGasSwap');
  if (gSwap) gSwap.textContent = '...';

  // Route Sankey viz — clear inner SVG (static preview will repopulate it
  // synchronously via updateSwapRoutePreview after onSwapTokensChanged)
  const routePath = document.getElementById('swapRoutePath');
  if (routePath) routePath.innerHTML = '';

  // Balances refetch on token change
  const fromBal = document.getElementById('swapViewFromBal');
  if (fromBal) fromBal.textContent = 'Balance: ...';
  const toBal = document.getElementById('swapViewToBal');
  if (toBal) toBal.textContent = 'Balance: ...';

  // Invalidate cached quote so stale gas estimate result is discarded
  swapLastQuote = null;
  _lastSwapQuoteForGas = null;
}

// Stale-quote guard for gas estimation (latest quote wins).
let _lastSwapQuoteForGas = null;

async function renderSwapGasEstimate(quote, router) {
  const gasEl = document.getElementById('swapViewGas');
  const breakdownApprove = document.getElementById('swapViewGasBreakdown');
  const breakdownSwap = document.getElementById('swapViewGasSwapBreakdown');
  const approveEl = document.getElementById('swapViewGasApprove');
  const swapEl = document.getElementById('swapViewGasSwap');
  if (!gasEl) return;

  gasEl.textContent = 'estimating...';
  gasEl.className = 'gas-value loading';
  if (approveEl) approveEl.textContent = '...';
  if (swapEl) swapEl.textContent = '...';

  if (typeof window.estimateSwapGas !== 'function') {
    gasEl.textContent = 'unavailable';
    gasEl.className = 'gas-value error';
    if (approveEl) approveEl.textContent = '—';
    if (swapEl) swapEl.textContent = '—';
    return;
  }

  try {
    const r = await window.estimateSwapGas(quote, router, walletAddress || null);
    // Stale-quote guard
    if (quote !== _lastSwapQuoteForGas) return;

    const isETH = quote.fromToken && typeof ETH_ADDRESS !== 'undefined' &&
                  quote.fromToken.toLowerCase() === ETH_ADDRESS.toLowerCase();
    const isWrap = quote.source === 'weth-wrap';
    if (!r.gasPrice || r.gasPrice === 0n) {
      gasEl.textContent = 'unavailable';
      gasEl.className = 'gas-value error';
      if (approveEl) approveEl.textContent = '—';
      if (swapEl) swapEl.textContent = '—';
      return;
    }
    const totalGas = r.approveGas + r.swapGas;
    const totalLabel = window._formatGasCost(totalGas, r.gasPrice, r.ethPrice);
    const fallbackHint = (r.swapGasFallback || r.approveGasFallback) ? ' (est)' : '';
    const walletHint = walletAddress ? '' : ' (preview)';
    gasEl.textContent = totalLabel + fallbackHint + walletHint;
    gasEl.className = 'gas-value';

    if (breakdownApprove && breakdownSwap && approveEl && swapEl) {
      breakdownApprove.style.display = '';
      if (r.approveNeeded) {
        approveEl.textContent = window._formatGasCost(r.approveGas, r.gasPrice, r.ethPrice);
      } else if (isWrap) {
        approveEl.textContent = 'not needed (wrap)';
      } else {
        approveEl.textContent = isETH ? 'not needed (ETH)' : (walletAddress ? 'not needed' : 'check on connect');
      }
      breakdownSwap.style.display = '';
      swapEl.textContent = window._formatGasCost(r.swapGas, r.gasPrice, r.ethPrice);
    }
  } catch (e) {
    if (quote !== _lastSwapQuoteForGas) return;
    console.warn('gas estimate (swap) failed:', e);
    gasEl.textContent = 'unavailable';
    gasEl.className = 'gas-value error';
    if (approveEl) approveEl.textContent = '—';
    if (swapEl) swapEl.textContent = '—';
  }
}

// ============================================================
// ROUTE VIZ FROM QUOTE (adapted from trade.js updateRouteVizFromQuote)
// ============================================================
function updateSwapRouteVizFromQuote(quote) {
  const routeViz = document.getElementById('swapRouteViz');
  const routePath = document.getElementById('swapRoutePath');
  const emptyMsg = document.getElementById('swapRouteEmpty');
  if (!routeViz || !routePath || !quote.route) return;

  const fromSym = swapSelectedFrom.symbol;
  const toSym = swapSelectedTo.symbol;

  // Always use Sankey (d3-sankey) visualization for all route types
  let multiPaths = [];

  if (quote.source === 'curve-split' && quote.route.length > 1) {
    // Split: parallel paths through different pools
    const totalInput = BigInt(quote.inputAmountWei);
    multiPaths = quote.route.map(leg => {
      const pct = totalInput > 0n ? Number(BigInt(leg.chunkWei || 0) * 10000n / totalInput) / 100 : 0;
      const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
      const poolName = leg.poolName || (pool ? pool.name : '?');
      const tvl = pool ? (pool.tvl || 0) : 0;
      return { poolNames: [_shortPoolName(poolName)], midTokenSyms: [], pct, tvl };
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
  } else if (quote.source === 'native-wrap-composite' && Array.isArray(quote.route) && quote.route.length >= 1) {
    // Composite (wrap + inner swap [+ unwrap]). Render hops left-to-right so
    // user sees the explicit native-wrapper segment alongside Curve pool hops.
    // Mid-tokens between legs: wrapped-native (after wrap), inner mid-tokens,
    // native (before unwrap). For simplicity emit wrapped/native sym in mids.
    const poolNames = [];
    const midTokenSyms = [];
    const nativeSym = (typeof getNativeSymbol === 'function') ? getNativeSymbol() : 'ETH';
    const wrappedSym = 'W' + nativeSym;
    for (let i = 0; i < quote.route.length; i++) {
      const leg = quote.route[i];
      const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
      const isWrap = !!leg._isWrapHop;
      const isUnwrap = !!leg._isUnwrapHop;
      const name = isWrap ? (nativeSym + ' wrapper')
                 : isUnwrap ? (nativeSym + ' unwrapper')
                 : _shortPoolName(leg.poolName || (pool ? pool.name : '?'));
      poolNames.push(name);
      if (i < quote.route.length - 1) {
        // Mid-token between current and next leg
        const nextLeg = quote.route[i + 1];
        if (isWrap) midTokenSyms.push(wrappedSym);
        else if (nextLeg && nextLeg._isUnwrapHop) midTokenSyms.push(wrappedSym);
        else midTokenSyms.push('?');
      }
    }
    multiPaths = [{ poolNames, midTokenSyms, pct: 100, tvl: 0 }];
  } else if (quote.route.length === 1) {
    const leg = quote.route[0];
    const pool = allPools.find(p => p.address.toLowerCase() === (leg.pool || '').toLowerCase());
    multiPaths = [{ poolNames: [_shortPoolName(leg.poolName || (pool ? pool.name : '?'))], midTokenSyms: [], pct: 100, tvl: pool ? (pool.tvl || 0) : 0 }];
  }

  if (multiPaths.length > 0) {
    // Sankey can throw "circular link" on multi-path routes where the same pool
    // node appears in distinct paths in a way that creates a cycle. Isolate the
    // SVG build so a viz failure never breaks the quote display itself.
    try {
      routePath.innerHTML = _buildMultiPathSVG(fromSym, toSym, multiPaths);
    } catch (e) {
      console.debug('Route viz failed, falling back to text:', e && e.message);
      // Inline text fallback: SRC → pool1 → mid1 → pool2 → ... → TGT per path.
      try {
        const lines = multiPaths.map(p => {
          const parts = [fromSym];
          const pools = p.poolNames || [];
          const mids = p.midTokenSyms || [];
          for (let i = 0; i < pools.length; i++) {
            parts.push(pools[i]);
            if (i < mids.length) parts.push(mids[i]);
          }
          parts.push(toSym);
          const pct = (typeof p.pct === 'number' && p.pct > 0 && p.pct < 100)
            ? ` <span style="color:var(--text-dim)">(${p.pct.toFixed(1)}%)</span>` : '';
          return `<div style="font:12px/1.6 ui-monospace,monospace;color:var(--text);padding:4px 8px;">${parts.join(' &rarr; ')}${pct}</div>`;
        });
        routePath.innerHTML =
          `<div style="padding:8px 4px;">${lines.join('')}<div style="color:var(--text-dim);font-size:11px;padding:6px 8px 0;">Route too complex to visualize as graph.</div></div>`;
      } catch {
        routePath.innerHTML = `<div style="padding:12px;color:var(--text-dim);font-size:12px;">Route preview unavailable.</div>`;
      }
    }
  }

  routeViz.style.display = '';
  if (emptyMsg) emptyMsg.style.display = 'none';
}

// ============================================================
// AGG COMPARISON (adapted from trade.js renderAggComparison)
// ============================================================
function renderSwapAggComparison(bestQuote) {
  const container = document.getElementById('swapAggCompare');
  const rowsEl = document.getElementById('swapAggRows');
  if (!container || !rowsEl) return;

  // Feature-flagged: hide until multiple aggregators are integrated.
  if (!SHOW_QUOTE_COMPARISON_SWAP) {
    container.classList.remove('show');
    // Hide the parent .swap-route-card too so we don't show an empty "Quote Comparison" header.
    const card = container.closest('.swap-route-card');
    if (card) card.style.display = 'none';
    const empty = document.getElementById('swapAggEmpty');
    if (empty) empty.style.display = 'none';
    return;
  }

  const allQuotes = bestQuote.allQuotes || [bestQuote];
  if (allQuotes.length <= 1) {
    container.classList.remove('show');
    return;
  }

  const toSym = swapSelectedTo.symbol;

  const curveQuotes = allQuotes.filter(q => (q.source || '').startsWith('curve-'));
  const otherQuotes = allQuotes.filter(q => !(q.source || '').startsWith('curve-'));
  const bestCurve = curveQuotes.length > 0 ? curveQuotes.reduce((a, b) => a.outputAmount > b.outputAmount ? a : b) : null;
  const consolidated = [];
  if (bestCurve) {
    consolidated.push({ ...bestCurve, sourceName: 'Curve', _curveType: bestCurve.source.replace('curve-', '') });
  }
  consolidated.push(...otherQuotes);
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

// ============================================================
// BALANCES
// ============================================================
async function loadSwapBalances() {
  if (!walletAddress || !provider) return;
  try {
    if (swapSelectedFrom) {
      const rawWei = await getTokenBalanceRaw(swapSelectedFrom, walletAddress);
      const el = document.getElementById('swapViewFromBal');
      if (el) {
        el.dataset.rawWei = rawWei.toString();
        el.dataset.decimals = String(swapSelectedFrom.decimals);
        el.textContent = 'Balance: ' + parseFloat(ethers.formatUnits(rawWei, swapSelectedFrom.decimals)).toFixed(4);
      }
    }
    if (swapSelectedTo) {
      const rawWei = await getTokenBalanceRaw(swapSelectedTo, walletAddress);
      const el = document.getElementById('swapViewToBal');
      if (el) {
        el.dataset.rawWei = rawWei.toString();
        el.dataset.decimals = String(swapSelectedTo.decimals);
        el.textContent = 'Balance: ' + parseFloat(ethers.formatUnits(rawWei, swapSelectedTo.decimals)).toFixed(4);
      }
    }
  } catch (e) {
    console.warn('Failed to load swap balances:', e);
  }
}

// Raw BigInt balance — used by MAX/preset (lossless wei → formatUnits → parseUnits round-trip)
async function getTokenBalanceRaw(token, address) {
  if (!token || !address) return 0n;
  if (token._isNativeETH || token.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    return await provider.getBalance(address);
  }
  const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
  return await contract.balanceOf(address);
}

async function getTokenBalance(token, address) {
  if (!token || !address) return '0';
  if (token._isNativeETH || token.address === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
    const bal = await provider.getBalance(address);
    return ethers.formatEther(bal);
  }
  const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
  const bal = await contract.balanceOf(address);
  return ethers.formatUnits(bal, token.decimals);
}

// ============================================================
// PRESETS & DIRECTION
// ============================================================
function swapViewSetMax() {
  const balEl = document.getElementById('swapViewFromBal');
  if (!balEl || !balEl.dataset.rawWei) return;
  const raw = BigInt(balEl.dataset.rawWei);
  const decimals = parseInt(balEl.dataset.decimals || '18', 10);
  if (raw > 0n) {
    document.getElementById('swapViewFromAmt').value = ethers.formatUnits(raw, decimals);
    clearTimeout(swapQuoteDebounce);
    swapQuoteDebounce = setTimeout(fetchSwapQuote, 600);
    updateSwapViewButton();
  }
}

function swapViewSetPreset(pct) {
  const balEl = document.getElementById('swapViewFromBal');
  if (!balEl || !balEl.dataset.rawWei) return;
  const raw = BigInt(balEl.dataset.rawWei);
  const decimals = parseInt(balEl.dataset.decimals || '18', 10);
  if (raw > 0n) {
    // BigInt math: pct ∈ {0.25, 0.5, 0.75, 1} → integer percent via × 10000
    const pctInt = BigInt(Math.round(pct * 10000));
    const amount = (raw * pctInt) / 10000n;
    document.getElementById('swapViewFromAmt').value = ethers.formatUnits(amount, decimals);
    clearTimeout(swapQuoteDebounce);
    swapQuoteDebounce = setTimeout(fetchSwapQuote, 600);
    updateSwapViewButton();
  }
}

function swapViewDirection() {
  if (!swapSelectedFrom || !swapSelectedTo) return;
  const tmp = swapSelectedFrom;
  swapSelectedFrom = swapSelectedTo;
  swapSelectedTo = tmp;
  updateSwapTokenUI('from', swapSelectedFrom);
  updateSwapTokenUI('to', swapSelectedTo);
  onSwapTokensChanged();
}

// ============================================================
// BUTTON STATE
// ============================================================
function updateSwapViewButton() {
  const btn = document.getElementById('swapViewSubmit');
  if (!btn) return;
  if (!walletAddress) {
    btn.textContent = 'Connect Wallet';
    btn.className = 'swap-submit connect';
    return;
  }
  if (!swapSelectedFrom || !swapSelectedTo) {
    btn.textContent = 'Select Tokens';
    btn.className = 'swap-submit disabled';
    return;
  }
  const fromAmt = document.getElementById('swapViewFromAmt')?.value;
  if (!fromAmt || parseFloat(fromAmt) <= 0) {
    btn.textContent = 'Enter Amount';
    btn.className = 'swap-submit disabled';
    return;
  }
  btn.textContent = `Swap ${swapSelectedFrom.symbol} for ${swapSelectedTo.symbol}`;
  btn.className = 'swap-submit swap-ready';
}

async function handleSwapViewSubmit() {
  if (!walletAddress) { connectWallet(); return; }
  if (!swapSelectedFrom || !swapSelectedTo) return;
  if (!swapLastQuote) { alert('Enter an amount first'); return; }

  const btn = document.getElementById('swapViewSubmit');
  btn.textContent = 'Processing...';
  btn.className = 'swap-submit disabled';

  try {
    await loadEthers();
    const provider = new ethers.BrowserProvider(window.ethereum);
    const signer = await provider.getSigner();
    const router = getSwapRouter();

    btn.textContent = 'Approving...';
    await router.ensureApproval(swapLastQuote, walletAddress, signer);

    btn.textContent = 'Swapping...';
    const txParams = await router.buildSwapTx(swapLastQuote, walletAddress);
    // Apply Michwill EIP-1559 gas strategy: tip=5% of base, maxFee=2.05×base.
    const gasOv = await window.computeMichwillGasParams(provider);

    // Multi-tx composite (native wrap + inner zap/curve, or +unwrap): dispatch
    // sequentially. Approve middle leg if its spender wasn't covered by the
    // outer ensureApproval (e.g. composite XDAI→EURe needs WXDAI approve to
    // zap that ensureApproval skips because outer fromToken = native).
    if (txParams && txParams.type === 'multi-tx' && Array.isArray(txParams.transactions)) {
      const inner = swapLastQuote._innerQuote || swapLastQuote;
      for (const sub of txParams.transactions) {
        if (sub._spender) {
          const approveToken = inner.fromToken;
          if (approveToken && approveToken.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
            const erc20 = new ethers.Contract(approveToken, ERC20_ABI, signer);
            const have = await erc20.allowance(walletAddress, sub._spender);
            const need = BigInt(inner.inputAmountWei || '0');
            if (have < need) {
              btn.textContent = 'Approving WXDAI...';
              // Build raw approve tx so we can estimateGas × 1.5 ourselves.
              const approveData = erc20.interface.encodeFunctionData('approve', [sub._spender, ethers.MaxUint256]);
              const approveTx = { to: approveToken, data: approveData, value: 0n };
              approveTx.gasLimit = await window.estimateGasWithBuffer(provider, approveTx, walletAddress);
              const a = await signer.sendTransaction({ ...approveTx, ...gasOv });
              await a.wait();
            }
          }
        }
        btn.textContent = sub._label === 'wrap' ? 'Wrapping...'
          : sub._label === 'unwrap' ? 'Unwrapping...'
          : 'Swapping...';
        const subTx = {
          to: sub.to,
          data: sub.data,
          value: sub.value || 0n,
        };
        // Per-sub-tx estimateGas × 1.5 (Михаил hard rule msg 7092 2026-05-24).
        subTx.gasLimit = await window.estimateGasWithBuffer(provider, subTx, walletAddress);
        const t = await signer.sendTransaction({ ...subTx, ...gasOv });
        await t.wait();
      }
    } else {
      // Single-tx path. Per-tx estimateGas × 1.5.
      const singleTx = {
        to: txParams.to,
        data: txParams.data,
        value: txParams.value || 0n,
      };
      singleTx.gasLimit = await window.estimateGasWithBuffer(provider, singleTx, walletAddress);
      const tx = await signer.sendTransaction({ ...singleTx, ...gasOv });
      btn.textContent = 'Confirming...';
      await tx.wait();
    }

    btn.textContent = 'Swap Successful!';
    btn.className = 'swap-submit swap-ready';
    // Token balances changed -> invalidate modal cache so next open re-fetches.
    if (typeof _resetWalletBalanceCache === 'function') _resetWalletBalanceCache();
    setTimeout(() => {
      document.getElementById('swapViewFromAmt').value = '';
      document.getElementById('swapViewToAmt').value = '';
      const detailsEl = document.getElementById('swapViewDetails');
      if (detailsEl) detailsEl.style.display = 'none';
      swapLastQuote = null;
      updateSwapViewButton();
      loadSwapBalances();
    }, 2000);
  } catch (e) {
    console.error('Swap error:', e);
    btn.textContent = e.code === 'ACTION_REJECTED' ? 'Transaction Rejected' : 'Swap Failed';
    btn.className = 'swap-submit disabled';
    setTimeout(() => updateSwapViewButton(), 3000);
  }
}

// ============================================================
// SLIPPAGE
// ============================================================
function initSwapSlippage() {
  document.querySelectorAll('.swap-view-slip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.swap-view-slip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      swapSlippage = parseFloat(btn.dataset.slip);
      const customInput = document.getElementById('swapViewSlippageCustom');
      if (customInput) customInput.value = '';
      // Persist the manual choice to the CURRENT bucket (stable/crypto) only —
      // see trade.js per-bucket model. Mirror onto the /trade buttons too.
      if (typeof window._persistSlipManual === 'function') window._persistSlipManual(btn.dataset.slip);
      // Re-fetch quote if amount entered
      const fromAmt = document.getElementById('swapViewFromAmt')?.value;
      if (fromAmt && parseFloat(fromAmt) > 0) {
        clearTimeout(swapQuoteDebounce);
        swapQuoteDebounce = setTimeout(fetchSwapQuote, 600);
      }
    });
  });
}

// Apply the active slippage bucket on init. The per-bucket model lives in
// trade.js (loaded first); here we just sync swapSlippage + the swap-view UI to
// whatever bucket is currently active (its persisted-or-default value).
function applySavedSwapSlippage() {
  if (typeof window._applySlippageBucket === 'function' && window._currentSlipBucket) {
    window._applySlippageBucket(window._currentSlipBucket);
    if (typeof window._readSlipBucket === 'function') {
      const v = parseFloat(window._readSlipBucket(window._currentSlipBucket));
      if (!isNaN(v)) swapSlippage = v;
    }
  }
}

// ============================================================
// EVENT LISTENERS (called after DOM ready)
// ============================================================
function initSwapEventListeners() {
  // Amount input -> debounced quote
  const fromInput = document.getElementById('swapViewFromAmt');
  if (fromInput) {
    fromInput.addEventListener('input', () => {
      clearTimeout(swapQuoteDebounce);
      swapQuoteDebounce = setTimeout(fetchSwapQuote, 600);
      updateSwapViewButton();
    });
  }

  // Token modal overlay click to close
  const modal = document.getElementById('swapTokenModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSwapTokenModal();
    });
  }

  // Token search input
  const searchInput = document.getElementById('swapTokenSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      renderSwapTokenModalList(e.target.value.trim());
    });
  }

  // Slippage buttons
  initSwapSlippage();

  // Custom slippage
  const customSlip = document.getElementById('swapViewSlippageCustom');
  if (customSlip) {
    customSlip.addEventListener('input', () => {
      const val = parseFloat(customSlip.value);
      if (!isNaN(val) && val > 0 && val < 50) {
        swapSlippage = val;
        document.querySelectorAll('.swap-view-slip').forEach(b => b.classList.remove('active'));
        // Persist custom value to the CURRENT bucket only.
        if (typeof window._persistSlipManual === 'function') window._persistSlipManual(val);
      }
    });
  }

  // Apply persisted slippage (shared key with /trade)
  applySavedSwapSlippage();
}

// Auto-init when DOM is ready (called from init flow)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSwapEventListeners);
} else {
  // DOM already loaded, init after a tick to ensure elements exist
  setTimeout(initSwapEventListeners, 0);
}
