# CurveDEX

CEX-style frontend for Curve Finance — multi-chain unified swap, yield, and portfolio in one interface.

## What is this

CurveDEX is an alternative interface for [Curve Finance](https://curve.finance/) that aggregates pools, gauges, and trade history across every chain Curve supports into a single CEX-style view. It is a static single-page application that talks directly to user-supplied RPC endpoints and Curve's public APIs — there is no proprietary backend in the request path.

Compared to the canonical interface:

- **Multi-chain unified view.** Pools from all 12+ supported chains live in one searchable table; no manual network switching to look around.
- **Native trading UX.** Order-book-style trade tab with OHLC chart and Curve-native route preview. Aggregator and external DEX integrations (ParaSwap, CoW, Odos) are scaffolded in `aggregators.js` but disabled in this build — Curve routing is currently the only quote engine.
- **Portfolio + yield in one place.** Wallet positions across every chain on one screen, including LP/gauge/locker breakdowns and historical fee revenue.
- **IPFS hosting.** The bundled build is content-addressed and served via IPFS through an ENS contenthash, so the frontend is censorship- and registrar-resistant. The classical HTTPS mirror is hosted alongside.

## Live deployment

| URL | Notes |
| --- | --- |
| <https://curvedex.eth.limo> | IPFS bundle resolved through `eth.limo` gateway |
| `curvedex.eth/` | Direct in ENS-aware browsers (Brave, MetaMask, Status) |
| <https://llama.box/curvedex/> | Classical HTTPS mirror, identical bundle |

Both targets are served from the same source tree; the IPFS bundle is content-pinned per release and its CID is recorded in [`build/cid_history.jsonl`](build/cid_history.jsonl).

## Architecture

The frontend is plain JavaScript — no bundler, no transpiler, no framework runtime. The browser loads `index.html` which `<script>`-includes ~10 module files in order:

```
index.html
  ├─ styles.css
  ├─ chains_config.json          (chain metadata + RPC fallbacks)
  ├─ app.js                      (entry point: wallet, network switch, pool list)
  ├─ trade.js                    (trade view: OHLC chart, route, history)
  ├─ swap.js                     (swap form, slippage, aggregator routing)
  ├─ router.js                   (Curve router + aggregator quote layer)
  ├─ portfolio.js                (multi-chain wallet positions)
  ├─ yield.js                    (deposit/withdraw, gauge stake, vecrv locker)
  ├─ panels.js                   (UI panels / drawers)
  ├─ info_tab.js                 (pool detail + risk info)
  ├─ gauge_weights.js            (weekly gauge weight snapshot)
  ├─ aggregators.js              (1inch / KyberSwap / Paraswap / Odos clients)
  ├─ logo.svg / icons.svg
  └─ bench_rpc.html              (standalone RPC latency benchmark page)
```

### Dynamic data

Two data sources are fetched at runtime rather than bundled:

| Variable | Default | What it serves |
| --- | --- | --- |
| `window.__DYNAMIC_BASE` | `https://llama.box` | `cache.json`, `chains_config.json` updates, daily volume snapshots, gauge weight snapshots |
| `window.__CDX_API_BASE` | `https://t.llama.box/cdx-api` | Trade history server (OHLC and per-pool trade list) |

These are injected into `index.html` at IPFS publish time (see `build/publish_ipfs.sh`). When you serve the source tree directly (`python3 -m http.server`) the defaults above apply, so the development bundle still gets live data without running any backend.

To point the frontend at your own data plane, override the globals before the modules execute:

```html
<script>
  window.__DYNAMIC_BASE  = 'https://your.host';
  window.__CDX_API_BASE = 'https://your.host/cdx-api';
</script>
```

## Local development

```bash
git clone https://github.com/chadoagent/alternative-curvedex.git
cd alternative-curvedex
python3 -m http.server 8000
# open http://localhost:8000
```

The page will fetch dynamic data from `llama.box` by default. To override at runtime without editing files, set the globals from DevTools before reloading:

```js
window.__DYNAMIC_BASE  = 'https://your.host';
window.__CDX_API_BASE = 'https://your.host/cdx-api';
location.reload();
```

No build step, no `npm install` required for the frontend.

## Collector daemons

The `collector/` directory contains optional Node.js / Python daemons that produce the dynamic data files served at `__DYNAMIC_BASE`. Operators running their own mirror need them; ordinary contributors do not.

| Script | Purpose | Output |
| --- | --- | --- |
| `collector/build_chain_config.py` | Build per-chain metadata from Curve's `/api/getPlatforms` + `chainid.network`. | `chains_config.json` |
| `collector/collect_trades.js` | Index on-chain swap events into a local SQLite DB. | `collector/trades.db` |
| `collector/serve_trades.js` | Express server exposing `/trades/:pool` and `/pools` on port 3010. | HTTP API |

Install the Node deps once: `cd collector && npm install`. The Python daemons use the standard library plus `web3` and `requests` (install via `pip install web3 requests`).

## Build and deploy (IPFS publish)

```bash
./build/publish_ipfs.sh
```

Requires a `kubo` IPFS daemon reachable over SSH on the host configured as `ovh` in your `~/.ssh/config` (see the script header for the exact remote layout). The script:

1. Stages the static file list under `/tmp/curvedex_ipfs_bundle/` on the remote.
2. Bakes the production `__DYNAMIC_BASE` and `__CDX_API_BASE` into `index.html`.
3. Runs `ipfs add -r --cid-version=0 -Q`, pins the result, and republishes the IPNS record under key `curvedex`.
4. Appends `{cid, ts, dynamic_base, cdx_api_base}` to `build/cid_history.jsonl`.

The ENS contenthash for `curvedex.eth` points at the IPNS name, so the record only needs to be updated once at registration; every release replaces the underlying CID transparently.

## Contributing

Pull requests welcome. A few conventions:

- Plain ES (no modules, no transpiler). Each script is loaded via `<script>` and exports via `window.*`. Keep it that way; the no-build property is load-bearing.
- Match the existing code style in the file you are editing (indentation, naming, comment density).
- Keep diffs minimal. The frontend touches user funds; large reorganisations should land in their own PRs.

## Security

If you find a vulnerability that could compromise user funds or wallet integrity, please report privately rather than opening a public issue. Contact: see repository owner profile on GitHub.

## License

[MIT](LICENSE) (c) 2026 CurveDEX contributors.
