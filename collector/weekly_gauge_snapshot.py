#!/usr/bin/env python3
"""Weekly gauge weight snapshot collector.

Fetches all active mainnet Curve gauges from the official API, then queries
gauge_controller.gauge_relative_weight(addr, ts) at the previous Thursday
00:00 UTC boundary via Multicall3. Output: collector/gauge_weights_<week_idx>.json.

Idempotent: re-runs for the same week_idx exit early.

Run weekly via cron (Thursday 00:05 UTC, just after gauge epoch flips):
    5 0 * * 4  python3 path/to/curvedex/collector/weekly_gauge_snapshot.py \\
        >> path/to/curvedex/collector/weekly_gauge_snapshot.log 2>&1
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from urllib import request

from web3 import Web3

# ---------- constants -------------------------------------------------------
GAUGE_CONTROLLER = Web3.to_checksum_address(
    "0x2F50D538606Fa9EDD2B11E2446BEb18C9D5846bB"
)
MULTICALL3 = Web3.to_checksum_address(
    "0xcA11bde05977b3631167028862bE2a173976CA11"
)
SEL_GAUGE_RELATIVE_WEIGHT = "0xd3078c94"  # gauge_relative_weight(address,uint256)
WEEK = 604800

API_URL = "https://api.curve.finance/api/getAllGauges"

RPC_ENDPOINTS = (
    "https://eth.llamarpc.com",
    "https://eth.drpc.org",
    "https://rpc.ankr.com/eth",
    "https://cloudflare-eth.com",
)

OUT_DIR = Path(__file__).resolve().parent
INDEX_PATH = OUT_DIR / "gauge_weights_index.json"

# Multicall3 aggregate3 selector + tuple[].
# We use w3.eth.contract for the encode side, but the call_data we build manually
# below is more compact and has no ABI dep for the inner gauge_relative_weight.
MULTICALL3_ABI = json.loads("""[
{"inputs":[{"components":[
  {"internalType":"address","name":"target","type":"address"},
  {"internalType":"bool","name":"allowFailure","type":"bool"},
  {"internalType":"bytes","name":"callData","type":"bytes"}],
  "internalType":"struct Multicall3.Call3[]","name":"calls","type":"tuple[]"}],
 "name":"aggregate3",
 "outputs":[{"components":[
   {"internalType":"bool","name":"success","type":"bool"},
   {"internalType":"bytes","name":"returnData","type":"bytes"}],
   "internalType":"struct Multicall3.Result[]","name":"returnData","type":"tuple[]"}],
 "stateMutability":"payable","type":"function"}
]""")


# ---------- helpers ---------------------------------------------------------
def prev_thursday_ts(now: int | None = None) -> tuple[int, int]:
    """Return (week_idx, snapshot_ts) for the most recent past Thursday 00:00 UTC.

    Curve's gauge_controller buckets votes into WEEK-aligned epochs starting
    from Thursday (Unix epoch 0 was a Thursday: 1970-01-01 == Thu).
    floor(ts / WEEK) * WEEK == most recent Thursday 00:00 UTC <= ts.
    """
    n = int(time.time()) if now is None else int(now)
    snapshot_ts = (n // WEEK) * WEEK
    return snapshot_ts // WEEK, snapshot_ts


def fetch_active_mainnet_gauges() -> list[str]:
    """Call getAllGauges, return lowercase mainnet active gauge addresses."""
    req = request.Request(
        API_URL,
        headers={"User-Agent": "curvedex-collector/1.0"},
    )
    with request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    raw = data.get("data", data)
    out: list[str] = []
    for _name, info in raw.items():
        if not isinstance(info, dict):
            continue
        if info.get("is_killed"):
            continue
        if info.get("side_chain"):
            continue
        bc = (info.get("blockchainId") or "").lower()
        if bc and bc != "ethereum":
            continue
        gauge = info.get("gauge")
        if isinstance(gauge, str) and gauge.startswith("0x") and len(gauge) == 42:
            out.append(gauge.lower())
    # de-dup, preserve order
    seen: set[str] = set()
    uniq: list[str] = []
    for a in out:
        if a in seen:
            continue
        seen.add(a)
        uniq.append(a)
    return uniq


def encode_grw_calldata(gauge_addr: str, ts: int) -> bytes:
    """Encode gauge_relative_weight(address,uint256) calldata."""
    addr_padded = bytes.fromhex(gauge_addr.replace("0x", "").lower().rjust(64, "0"))
    ts_padded = ts.to_bytes(32, "big")
    return bytes.fromhex(SEL_GAUGE_RELATIVE_WEIGHT.replace("0x", "")) + addr_padded + ts_padded


def try_connect_w3() -> tuple[Web3, str]:
    """Try RPCs in order until one responds with chain_id == 1."""
    last_err: Exception | None = None
    for rpc in RPC_ENDPOINTS:
        try:
            w3 = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 30}))
            cid = w3.eth.chain_id
            if cid != 1:
                continue
            return w3, rpc
        except Exception as e:  # noqa: BLE001 — try next
            last_err = e
            continue
    raise RuntimeError(f"All RPCs failed: {last_err!r}")


def call_multicall3_aggregate3(
    w3: Web3, calls: list[tuple[str, bool, bytes]]
) -> list[tuple[bool, bytes]]:
    mc = w3.eth.contract(address=MULTICALL3, abi=MULTICALL3_ABI)
    return mc.functions.aggregate3(calls).call()


def chunks(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def update_index(week_idx: int) -> list[int]:
    """Refresh collector/gauge_weights_index.json by scanning the directory."""
    weeks: list[int] = []
    for p in OUT_DIR.glob("gauge_weights_*.json"):
        if p.name == INDEX_PATH.name:
            continue
        stem = p.stem.replace("gauge_weights_", "")
        try:
            weeks.append(int(stem))
        except ValueError:
            continue
    weeks = sorted(set(weeks))
    INDEX_PATH.write_text(
        json.dumps(
            {
                "weeks": weeks,
                "latest": weeks[-1] if weeks else None,
                "updated_ts": int(time.time()),
            },
            indent=2,
        )
        + "\n"
    )
    return weeks


# ---------- main ------------------------------------------------------------
def main() -> int:
    started = time.time()
    week_idx, snapshot_ts = prev_thursday_ts()
    out_path = OUT_DIR / f"gauge_weights_{week_idx}.json"

    if out_path.exists():
        print(f"[OK] Snapshot already exists for week_idx={week_idx}: {out_path.name} — skip.")
        update_index(week_idx)
        return 0

    snapshot_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(snapshot_ts))
    print(f"[INFO] Snapshot week_idx={week_idx}, ts={snapshot_ts} ({snapshot_iso})")

    print("[INFO] Fetching active mainnet gauges from", API_URL)
    gauges = fetch_active_mainnet_gauges()
    print(f"[INFO] Active mainnet gauges: {len(gauges)}")
    if not gauges:
        print("[ERROR] No gauges returned, aborting.", file=sys.stderr)
        return 1

    print("[INFO] Connecting RPC...")
    w3, rpc_used = try_connect_w3()
    print(f"[INFO] Connected to {rpc_used}, block {w3.eth.block_number}")

    weights: dict[str, float | None] = {}
    BATCH = 250  # Multicall3 handles this comfortably
    for batch in chunks(gauges, BATCH):
        calls: list[tuple[str, bool, bytes]] = []
        for ga in batch:
            calls.append(
                (
                    GAUGE_CONTROLLER,
                    True,  # allowFailure — old gauges may revert
                    encode_grw_calldata(ga, snapshot_ts),
                )
            )
        # Multi-RPC retry on each batch
        results = None
        last_err: Exception | None = None
        for rpc in [rpc_used, *(r for r in RPC_ENDPOINTS if r != rpc_used)]:
            try:
                w3b = Web3(Web3.HTTPProvider(rpc, request_kwargs={"timeout": 60}))
                results = call_multicall3_aggregate3(w3b, calls)
                rpc_used = rpc
                break
            except Exception as e:  # noqa: BLE001
                last_err = e
                continue
        if results is None:
            raise RuntimeError(f"Multicall failed across all RPCs: {last_err!r}")

        for ga, (ok, ret) in zip(batch, results, strict=True):
            if not ok or len(ret) != 32:
                weights[ga] = None
                continue
            wei = int.from_bytes(ret, "big")
            # weight is gauge_relative_weight in 1e18 (fraction of total). Convert to %:
            pct = (wei * 10000) // (10**18) / 100.0  # 4 decimals retained
            weights[ga] = pct

    valid_pcts = [v for v in weights.values() if isinstance(v, float)]
    total_pct = sum(valid_pcts)
    duration_s = round(time.time() - started, 2)

    payload = {
        "week_idx": week_idx,
        "snapshot_ts": snapshot_ts,
        "snapshot_iso": snapshot_iso,
        "weights": weights,
        "total_active_gauges": len(gauges),
        "total_weight_pct": round(total_pct, 4),
        "rpc_used": rpc_used,
        "duration_s": duration_s,
    }
    out_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(
        f"[OK] Wrote {out_path.name}: {len(gauges)} gauges, "
        f"sum={total_pct:.2f}%, duration={duration_s}s"
    )

    weeks = update_index(week_idx)
    print(f"[OK] Index now lists {len(weeks)} weeks: {weeks[-5:]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
