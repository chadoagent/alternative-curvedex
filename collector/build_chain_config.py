#!/usr/bin/env python3
"""Multi-chain config builder for CurveDEX.

Fetches Curve platforms (chains supported by curve.finance API), enriches each
with chainid.network metadata (chainId, native currency, RPC endpoints,
explorers), drops template-RPCs that require API keys, attaches the standard
Multicall3 address (same on every EVM chain) and a hardcoded aggregator
support map. Output: sites/curvedex/chains_config.json — consumed by app.js
at runtime to build the network dropdown and parameterise per-chain API/RPC
URL builders.

Idempotent. Safe to re-run; cron suggestion: daily at 03:11 UTC.
    11 3 * * *  python3 path/to/curvedex/collector/build_chain_config.py \\
        >> path/to/curvedex/collector/build_chain_config.log 2>&1
"""
from __future__ import annotations

import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib import request


# ---------- sources --------------------------------------------------------
CURVE_PLATFORMS_URL = "https://api.curve.finance/api/getPlatforms"
CHAINID_REGISTRY_URL = "https://chainid.network/chains.json"

MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"  # same on every EVM L2/L1

# Curve API uses custom slugs that don't always match chainid.network shortName.
# Authoritative mapping curated by hand; verified against curve.finance/dex/<slug>/.
CURVE_TO_CHAIN_ID: dict[str, int] = {
    "ethereum": 1,
    "polygon": 137,
    "fantom": 250,
    "arbitrum": 42161,
    "avalanche": 43114,
    "optimism": 10,
    "xdai": 100,            # Gnosis Chain
    "aurora": 1313161554,
    "harmony": 1666600000,
    "moonbeam": 1284,
    "kava": 2222,
    "celo": 42220,
    "zkevm": 1101,          # Polygon zkEVM
    "zksync": 324,          # zkSync Era
    "base": 8453,
    "fraxtal": 252,
    "bsc": 56,
    "x-layer": 196,
    "mantle": 5000,
    "sonic": 146,
    "hyperliquid": 999,     # HyperEVM
}

# Aggregator coverage (which third-party reward sources work per chain).
# Source: aggregator docs + UI smoke. False = no coverage at all; True = supported.
AGGREGATOR_SUPPORT: dict[str, dict[str, bool]] = {
    # Convex Sidechain is only deployed on ETH/Arbitrum/Polygon/Fraxtal as of
    # 2026-05 (verified via convex-eth/sidechain-platform repo). Base/Optimism/
    # BSC etc. have NO Booster contract.
    # StakeDAO covers ETH plus a curated set of sidechains (verified via
    # hub.stakedao.org/v1/vaults vault count per chainId).
    "ethereum":  {"merkl": True,  "convex": True,  "stakedao": True,  "cow": True},
    "arbitrum":  {"merkl": True,  "convex": True,  "stakedao": True,  "cow": True},
    "polygon":   {"merkl": True,  "convex": True,  "stakedao": False, "cow": True},
    "fraxtal":   {"merkl": True,  "convex": True,  "stakedao": True,  "cow": False},
    "base":      {"merkl": True,  "convex": False, "stakedao": True,  "cow": True},
    "optimism":  {"merkl": True,  "convex": False, "stakedao": True,  "cow": True},
    "sonic":     {"merkl": True,  "convex": False, "stakedao": True,  "cow": False},
    "avalanche": {"merkl": True,  "convex": False, "stakedao": False, "cow": False},
    "bsc":       {"merkl": True,  "convex": False, "stakedao": False, "cow": True},
    "fantom":    {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "xdai":      {"merkl": False, "convex": False, "stakedao": False, "cow": True},
    "celo":      {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "kava":      {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "moonbeam":  {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "aurora":    {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "harmony":   {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "zkevm":     {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "zksync":    {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "mantle":    {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "x-layer":   {"merkl": False, "convex": False, "stakedao": False, "cow": False},
    "hyperliquid": {"merkl": False, "convex": False, "stakedao": False, "cow": False},
}

# Per-chain Convex Sidechain Booster addresses (only chains where Convex is
# actually deployed). Mainnet has its own Booster handled separately.
CONVEX_SIDECHAIN_BOOSTERS: dict[str, str] = {
    "arbitrum": "0xF403C135812408BFbE8713b5A23a04b3D48AAE31",
    "polygon":  "0xF403C135812408BFbE8713b5A23a04b3D48AAE31",
    "fraxtal":  "0xd3327cb05a8E0095A543D582b5B3Ce3e19270389",
}

# Per-chain CRV (Curve DAO Token) addresses — bridged versions on sidechains.
# Used by the on-chain Convex Sidechain APR reader to price reward emissions.
# Verified live against prices.curve.finance/v1/usd_price/<chain>/<addr> 2026-05-16.
CRV_TOKEN_ADDRESSES: dict[str, str] = {
    "ethereum": "0xD533a949740bb3306d119cc777fa900ba034cd52",
    "arbitrum": "0x11cDb42B0EB46D95f990BeDD4695A6e3fA034978",
    "polygon":  "0x172370d5Cd63279eFa6d502DAB29171933a610AF",
    "fraxtal":  "0x331B9182088e2A7d6D3Fe4742AbA1fB231aEcc56",
}


# ---------- helpers --------------------------------------------------------
def _fetch_json(url: str, timeout: int = 30) -> dict | list:
    req = request.Request(url, headers={"User-Agent": "curvedex-build-chains/1"})
    with request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _clean_rpcs(rpc_list: list[str], cap: int = 6) -> list[str]:
    """Keep public HTTPS endpoints; drop wss, template-keys, regional rotators."""
    seen: set[str] = set()
    out: list[str] = []
    for rpc in rpc_list:
        if not isinstance(rpc, str):
            continue
        if not rpc.startswith("https://"):
            continue
        if "${" in rpc or "API_KEY" in rpc or "{key}" in rpc.lower():
            continue
        if rpc in seen:
            continue
        seen.add(rpc)
        out.append(rpc)
        if len(out) >= cap:
            break
    return out


def _probe_rpc(url: str, timeout: float = 5.0) -> bool:
    """eth_blockNumber smoke against a public RPC.  True only on JSON-RPC
    success with a valid 0x-prefixed block result — covers 4xx/5xx, network
    errors, CORS-from-server, and stale relays that return non-hex.  Used to
    drop dead endpoints from chains_config so the frontend's rotation pool
    isn't seeded with garbage."""
    payload = json.dumps({"jsonrpc": "2.0", "method": "eth_blockNumber", "params": [], "id": 1}).encode()
    try:
        req = request.Request(url, data=payload, headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 curvedex-build-chains",
        })
        with request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read())
            res = d.get("result")
            return isinstance(res, str) and res.startswith("0x") and len(res) > 2
    except Exception:
        return False


def _probe_rpcs_parallel(rpc_list: list[str], timeout: float = 5.0) -> list[str]:
    """Run _probe_rpc on every URL in parallel; preserve original ordering for
    survivors so latency-bench order from chainid.network registry is kept
    intact (it's roughly best-first)."""
    if not rpc_list:
        return []
    with ThreadPoolExecutor(max_workers=min(len(rpc_list), 12)) as ex:
        results = list(ex.map(lambda u: (u, _probe_rpc(u, timeout=timeout)), rpc_list))
    return [u for u, ok in results if ok]


def _count_pools(curve_key: str, registries: list[str], timeout: int = 12) -> int:
    """Sum pool count across all registries for a Curve chain. Returns 0 when
    every registry endpoint either errors out or yields no pools — the signal
    the caller uses to drop the chain from the published config (no point
    showing a network with zero Curve activity to the user)."""
    total = 0
    for reg in registries:
        url = f"https://api.curve.finance/api/getPools/{curve_key}/{reg}"
        try:
            d = _fetch_json(url, timeout=timeout)
            pools = (d.get("data") or {}).get("poolData") or []
            total += len(pools)
        except Exception as e:
            print(f"  [WARN] getPools {curve_key}/{reg} failed: {e}", file=sys.stderr)
    return total


def _explorer_url(chain_meta: dict) -> str | None:
    """Pick first non-block explorer with a usable URL."""
    for exp in chain_meta.get("explorers") or []:
        u = exp.get("url")
        if u and u.startswith("https://"):
            return u.rstrip("/")
    return None


# ---------- main -----------------------------------------------------------
def build() -> dict:
    print(f"[{time.strftime('%H:%M:%S')}] fetching Curve platforms...", file=sys.stderr)
    cp = _fetch_json(CURVE_PLATFORMS_URL)
    if not cp.get("success"):
        raise RuntimeError(f"getPlatforms failed: {cp}")
    platforms: dict[str, list[str]] = cp["data"]["platforms"]
    print(f"  {len(platforms)} chains from Curve", file=sys.stderr)

    print(f"[{time.strftime('%H:%M:%S')}] fetching chainid.network registry...", file=sys.stderr)
    registry: list[dict] = _fetch_json(CHAINID_REGISTRY_URL)
    by_id: dict[int, dict] = {c["chainId"]: c for c in registry if "chainId" in c}
    print(f"  {len(by_id)} chains in registry", file=sys.stderr)

    chains: dict[str, dict] = {}
    skipped: list[str] = []
    for curve_key, registries in platforms.items():
        chain_id = CURVE_TO_CHAIN_ID.get(curve_key)
        if chain_id is None:
            skipped.append(curve_key)
            continue
        meta = by_id.get(chain_id)
        if meta is None:
            skipped.append(f"{curve_key}(no registry for chainId={chain_id})")
            continue

        rpcs = _clean_rpcs(meta.get("rpc") or [])
        # Live-probe everything that survived the static filter — many
        # registries publish endpoints that are stale (rate-limited / 403 /
        # gone).  Keep only the URLs that actually respond to eth_blockNumber
        # right now.  Done at build time so users never pay the cost.
        if rpcs:
            live = _probe_rpcs_parallel(rpcs)
            if len(live) < len(rpcs):
                dropped = [u for u in rpcs if u not in live]
                print(f"  [WARN] {curve_key}: dropped {len(dropped)}/{len(rpcs)} dead RPCs", file=sys.stderr)
            rpcs = live
        if not rpcs:
            # Zero live RPCs — wallet ops + multicall can't run.  Skip so the
            # chain doesn't show up as a clickable option that breaks on use.
            skipped.append(f"{curve_key}(no live RPCs)")
            continue
        explorer = _explorer_url(meta)
        native = meta.get("nativeCurrency") or {}

        chains[curve_key] = {
            "curveKey": curve_key,
            "chainId": chain_id,
            "name": meta.get("name") or curve_key.title(),
            "shortName": meta.get("shortName") or curve_key,
            "nativeCurrency": {
                "name": native.get("name"),
                "symbol": native.get("symbol"),
                "decimals": native.get("decimals", 18),
            },
            "rpc": rpcs,
            "explorer": explorer,
            "multicall3": MULTICALL3,
            "curveSlug": curve_key,           # path segment in curve.finance/dex/<slug>/
            "registries": registries,
            "aggregators": AGGREGATOR_SUPPORT.get(curve_key, {
                "merkl": False, "convex": False, "stakedao": False, "cow": False,
            }),
            "convexBooster": CONVEX_SIDECHAIN_BOOSTERS.get(curve_key),
            "crvAddress": CRV_TOKEN_ADDRESSES.get(curve_key),
        }

    if skipped:
        print(f"[WARN] unmapped chains: {skipped}", file=sys.stderr)

    # Drop chains that have zero Curve pools across every registry.  These
    # show up in /getPlatforms (Curve once supported them) but have nothing
    # for users to interact with today — leaving them in the dropdown wastes
    # a click and confuses users.  If/when activity returns, the next cron
    # run picks them back up automatically.  Probed in parallel: 21 chains
    # × ~5 registries × ~1s = serial would be too slow.
    print(f"[{time.strftime('%H:%M:%S')}] probing pool counts to drop empty chains...", file=sys.stderr)
    empty: list[str] = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        futures = {ex.submit(_count_pools, k, c["registries"]): k for k, c in chains.items()}
        for fut in as_completed(futures):
            k = futures[fut]
            try:
                n = fut.result()
            except Exception as e:
                n = 0
                print(f"  [WARN] pool-count probe {k} failed: {e}", file=sys.stderr)
            if n == 0:
                empty.append(k)
            else:
                chains[k]["poolCount"] = n
    for k in empty:
        del chains[k]
    if empty:
        print(f"  dropped (zero pools): {sorted(empty)}", file=sys.stderr)

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "version": 1,
        "source": {
            "platforms": CURVE_PLATFORMS_URL,
            "registry": CHAINID_REGISTRY_URL,
        },
        "chains": chains,
    }


def main() -> int:
    out = build()
    out_path = Path(__file__).resolve().parents[1] / "chains_config.json"
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n")
    print(f"[{time.strftime('%H:%M:%S')}] wrote {out_path} ({len(out['chains'])} chains)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
