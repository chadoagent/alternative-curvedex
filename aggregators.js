/**
 * CurveDEX External Aggregators — ParaSwap, CoW Protocol, ODOS
 *
 * Extracted from router.js for separate development.
 * To re-enable: import this file and pass enableParaSwap/enableCow/enableOdos to CurveDEXRouter.
 *
 * These methods were part of the CurveDEXRouter class.
 * To integrate back, add them as methods and enable flags in constructor.
 */

// ParaSwap (cross-DEX aggregator, 70+ DEXes, free API)
const PARASWAP_API = 'https://api.paraswap.io';
const PARASWAP_AUGUSTUS_V6 = '0x6a000f20005980200259b80c5102003040001068';

// CoW Protocol (intent-based MEV-protected swaps)
const COW_API = 'https://api.cow.fi/mainnet/api/v1';
const COW_VAULT_RELAYER = '0xC92E8bdf79f0507f65a392b0ab4667716BFE0110';

// ODOS (smart order routing with native split)
const ODOS_API = 'https://api.odos.xyz';
const ODOS_ROUTER_V2 = '0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559';

const ETH_ADDRESS_AGG = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const WETH_ADDRESS_AGG = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';


// ============================================================
// PARASWAP
// ============================================================

async function getParaSwapQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals, chainId, userAddress) {
  const params = new URLSearchParams({
    srcToken: fromToken,
    destToken: toToken,
    amount: amountWei,
    srcDecimals: fromDecimals.toString(),
    destDecimals: toDecimals.toString(),
    side: 'SELL',
    network: chainId.toString(),
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
    // ParaSwap's srcUSD is input USD value, destUSD is output USD value;
    // user loses when destUSD<srcUSD → impact must be negative.
    priceImpact: parseFloat(best.srcUSD) > 0
      ? ((parseFloat(best.destUSD) - parseFloat(best.srcUSD)) / parseFloat(best.srcUSD) * 100)
      : 0,
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

async function buildParaSwapTx(quote, userAddress, chainId) {
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

  const resp = await fetch(`${PARASWAP_API}/transactions/${chainId}`, {
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
    // ParaSwap's `txData.gas` kept as hint only.
    _aggregatorGasHint: txData.gas ? parseInt(txData.gas) : null,
    chainId,
  };
}


// ============================================================
// COW PROTOCOL
// ============================================================

async function getCowQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals, userAddress) {
  const sellToken = fromToken.toLowerCase() === ETH_ADDRESS_AGG.toLowerCase() ? WETH_ADDRESS_AGG : fromToken;
  const buyToken = toToken.toLowerCase() === ETH_ADDRESS_AGG.toLowerCase() ? WETH_ADDRESS_AGG : toToken;

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

  return {
    source: 'cow',
    outputAmount,
    outputAmountWei,
    inputAmountWei: amountWei,
    fromToken,
    toToken,
    rate: inputAmount > 0 ? outputAmount / inputAmount : 0,
    priceImpact: 0,
    gas: 0,
    route: [{ exchange: 'CoW Protocol', percent: 100, mevProtected: true }],
    _cowQuoteId: data.id,
    _cowQuote: quote,
    _cowFrom: data.from,
  };
}

async function buildCowTx(quote, userAddress) {
  const cowQuote = quote._cowQuote;
  const buyAmount = BigInt(cowQuote.buyAmount);
  const slippageBps = Math.floor((quote.slippage || 0.5) * 100);
  const minBuyAmount = buyAmount - (buyAmount * BigInt(slippageBps) / 10000n);

  return {
    type: 'cow-order',
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
  };
}


// ============================================================
// ODOS
// ============================================================

async function getOdosQuote(fromToken, toToken, amountWei, fromDecimals, toDecimals, chainId, userAddress) {
  const body = {
    chainId,
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
    // Signed convention: NEGATIVE = loss, POSITIVE = premium.
    // Odos API returns negative for losses already; preserve sign instead of abs().
    priceImpact: data.priceImpact != null ? Number(data.priceImpact) : 0,
    gas: parseInt(data.gasEstimate) || 250000,
    route: (data.pathViz || []).map(p => ({
      poolName: p.dex || 'Odos',
      exchange: p.dex || 'unknown',
      percent: p.percent || 100,
    })),
    _odosPathId: data.pathId,
  };
}

async function buildOdosTx(quote, userAddress) {
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
    _aggregatorGasHint: parseInt(tx.gas) || null,
    chainId: (typeof window !== 'undefined' && window.getChainId ? window.getChainId() : 1),
  };
}

// Export for potential future use
if (typeof window !== 'undefined') {
  window.CurveDEXAggregators = {
    getParaSwapQuote, buildParaSwapTx,
    getCowQuote, buildCowTx,
    getOdosQuote, buildOdosTx,
    PARASWAP_API, COW_API, ODOS_API,
  };
}
