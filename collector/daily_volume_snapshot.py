#!/usr/bin/env python3
"""Daily pool volume snapshot collector (long-history).

Pulls per-pool daily trading_volume_usd time-series for the last ~400 days from
Curve's internal Metabase Postgres (https://metabase-prices.curve.finance).

Why: prices.curve.finance public OHLC/volume API only retains ~60 days.
Internal pool_prices table goes back to 2020-02-10 (per-tx, 11M+ rows) and
daily_pool_stats has materialized daily aggregates from 2025-12-26 onward.

Strategy (cheap + complete):
  Layer A (recent, 0..~120d): daily_pool_stats — pre-aggregated, fast.
  Layer B (older, 120..400d): pool_prices SUM(usd_main_volume) GROUP BY day —
                              chunked per ≤5 pools per query (Metabase 2000-row cap).

Output: collector/daily_volumes.json
  { <lower_pool_address>: {
        "chain_id": 1,
        "name": "...",
        "days": [
          { "day": "2025-04-01", "vol_usd": 12345.67 },
          ...
        ]
    },
    ...
  }

Idempotent: re-runnable, overwrites JSON each invocation.

Run via cron daily, e.g.:
    15 7 * * *  python3 path/to/collector/daily_volume_snapshot.py \\
        >> /tmp/daily_volume_snapshot.log 2>&1

Requires Metabase credentials in CURVE_METABASE_CREDENTIALS (path to JSON with
{url, auth_endpoint, username, password}).  Operators outside the Curve team
will not have these — this script is a reference for self-hosting mirrors.
"""
from __future__ import annotations

import json
import os
import sys
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ---------------- config -----------------
HERE = Path(__file__).resolve().parent
OUT_PATH = HERE / "daily_volumes.json"
INDEX_PATH = HERE / "daily_volumes_index.json"

CRED_PATH = os.environ.get(
    "CURVE_METABASE_CREDENTIALS",
    str(HERE / ".metabase_credentials.json"),
)
TOK_PATH = os.environ.get("CURVE_METABASE_TOKEN_CACHE", "/tmp/.metabase_token")

# Metabase per-query row cap is 2000. To stay under it we batch:
# - daily_pool_stats: ~125 days × N pools per query → ≤16 pools.
# - pool_prices (older, ~275 days): ≤7 pools per query.
DAILY_BATCH = 12     # safety margin
PRICES_BATCH = 6
LOOKBACK_DAYS = 400
DAILY_STATS_CUTOFF = "2025-12-26"   # earliest date in daily_pool_stats

# Parallel workers for slow Layer B. Metabase has internal connection pooling;
# 4 has empirically been a safe sweet-spot for shared internal Postgres views.
LAYER_B_WORKERS = 4

# Top-N pools by recent TVL (from pools.tvl_usd in Metabase). 200 covers ~all
# meaningful volume; long-tail empty pools are excluded to keep JSON small
# and Layer-B runtime under ~10 minutes.
TOP_N = 200

# ---------------- metabase auth -----------------


def get_token(force_refresh: bool = False) -> tuple[str, dict]:
    cred = json.load(open(CRED_PATH))
    if not force_refresh and os.path.exists(TOK_PATH):
        try:
            cache = json.load(open(TOK_PATH))
            age_days = (time.time() - cache["created_at"]) / 86400
            if age_days < 13:
                return cache["token"], cred
        except Exception:
            pass
    r = requests.post(
        cred["url"] + cred["auth_endpoint"],
        json={"username": cred["username"], "password": cred["password"]},
        verify=False,
        timeout=15,
    )
    r.raise_for_status()
    tok = r.json()["id"]
    with open(TOK_PATH, "w") as f:
        json.dump({"token": tok, "created_at": time.time()}, f)
    os.chmod(TOK_PATH, 0o600)
    return tok, cred


def Q(sql: str, timeout: int = 240) -> tuple[list[str], list[list]]:
    """Run a native SQL query, with one transparent token-refresh retry."""
    tok, cred = get_token()
    h = {"X-Metabase-Session": tok, "Content-Type": "application/json"}
    payload = {"database": 2, "type": "native", "native": {"query": sql}}
    r = requests.post(
        cred["url"] + cred["dataset_endpoint"],
        headers=h, json=payload, verify=False, timeout=timeout,
    )
    j = r.json()
    if "errors" in j and "session" in str(j).lower():
        tok, _ = get_token(force_refresh=True)
        h["X-Metabase-Session"] = tok
        r = requests.post(
            cred["url"] + cred["dataset_endpoint"],
            headers=h, json=payload, verify=False, timeout=timeout,
        )
        j = r.json()
    cols = [c["name"] for c in j.get("data", {}).get("cols", [])]
    rows = j.get("data", {}).get("rows", [])
    if not cols and rows == [] and ("errors" in j or "error" in j):
        raise RuntimeError(f"Metabase query failed: {j.get('error', j.get('errors'))}")
    return cols, rows


# ---------------- helpers -----------------


def chunked(seq: list, n: int):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def quoted_addresses_sql(addrs: list[str]) -> str:
    """Return safe `LOWER(address) IN ('0x..', '0x..')` clause body.

    Addresses are validated as 0x + 40 hex chars before SQL inlining (no params
    in Metabase native queries).
    """
    safe = []
    for a in addrs:
        a = a.lower().strip()
        if not (a.startswith("0x") and len(a) == 42 and all(ch in "0123456789abcdef" for ch in a[2:])):
            raise ValueError(f"Bad address: {a!r}")
        safe.append(f"'{a}'")
    return ", ".join(safe)


# ---------------- main pipeline -----------------


def fetch_top_pools() -> list[dict]:
    """List top-N (by tvl_usd) Curve pools across all chains, with id+address+name."""
    sql = f"""
    SELECT id, LOWER(address) AS address, chain_id, name,
           COALESCE(tvl_usd, 0) AS tvl_usd
    FROM pools
    WHERE is_active = true
      AND address IS NOT NULL
    ORDER BY COALESCE(tvl_usd, 0) DESC NULLS LAST
    LIMIT {TOP_N}
    """
    cols, rows = Q(sql, timeout=60)
    out = []
    for r in rows:
        out.append({
            "id": int(r[0]),
            "address": r[1],
            "chain_id": int(r[2]),
            "name": r[3] or "",
            "tvl_usd": float(r[4] or 0),
        })
    return out


def fetch_daily_stats_window(addrs: list[str]) -> dict[str, list[tuple[str, float]]]:
    """Layer A: daily_pool_stats from cutoff onward, batch addresses."""
    out: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for batch in chunked(addrs, DAILY_BATCH):
        sql = f"""
        SELECT LOWER(p.address) AS addr,
               dps.date::text AS day,
               dps.trading_volume AS vol_usd
        FROM daily_pool_stats dps
        JOIN pools p ON p.id = dps.pool_id
        WHERE LOWER(p.address) IN ({quoted_addresses_sql(batch)})
          AND dps.date >= DATE '{DAILY_STATS_CUTOFF}'
          AND dps.date >= NOW() - INTERVAL '{LOOKBACK_DAYS} days'
          AND dps.trading_volume > 0
        ORDER BY 1, 2
        """
        cols, rows = Q(sql, timeout=120)
        for r in rows:
            out[r[0]].append((r[1], float(r[2] or 0.0)))
    return out


def _layer_b_one_batch(idx: int, total: int, batch: list[str]) -> tuple[int, list[tuple[str, str, float]]]:
    sql = f"""
    SELECT LOWER(p.address) AS addr,
           date_trunc('day', pp.dt)::date::text AS day,
           SUM(pp.usd_main_volume) AS vol_usd
    FROM pool_prices pp
    JOIN pool_pairs ppair ON ppair.id = pp.pool_pair_id
    JOIN pools p ON p.id = ppair.pool_id
    WHERE LOWER(p.address) IN ({quoted_addresses_sql(batch)})
      AND pp.dt >= NOW() - INTERVAL '{LOOKBACK_DAYS} days'
      AND pp.dt < DATE '{DAILY_STATS_CUTOFF}'
      AND pp.is_relevant = true
    GROUP BY 1, 2
    HAVING SUM(pp.usd_main_volume) > 0
    ORDER BY 1, 2
    """
    t0 = time.time()
    cols, rows = Q(sql, timeout=300)
    triples = [(r[0], r[1], float(r[2] or 0.0)) for r in rows]
    print(f"  prices batch {idx}/{total}: {len(rows)} rows ({len(batch)} pools, {time.time()-t0:.1f}s)")
    return idx, triples


def fetch_prices_older_window(addrs: list[str]) -> dict[str, list[tuple[str, float]]]:
    """Layer B: pool_prices SUM aggregate for dates before DAILY_STATS_CUTOFF.

    Runs ``LAYER_B_WORKERS`` queries in parallel — Metabase's API can handle
    this comfortably and brings the wall-clock from ~50 min down to ~10–12.
    """
    out: dict[str, list[tuple[str, float]]] = defaultdict(list)
    batches = list(chunked(addrs, PRICES_BATCH))
    total = len(batches)
    with ThreadPoolExecutor(max_workers=LAYER_B_WORKERS) as ex:
        futures = [ex.submit(_layer_b_one_batch, i + 1, total, b) for i, b in enumerate(batches)]
        for fut in as_completed(futures):
            try:
                _, triples = fut.result()
            except Exception as e:
                print(f"  [WARN] batch failed, skipping: {e!r}")
                continue
            for addr, d, v in triples:
                out[addr].append((d, v))
    return out


def main() -> int:
    started = time.time()

    print(f"[INFO] Authenticating to Metabase...")
    get_token()  # warm cache

    print(f"[INFO] Fetching top {TOP_N} pools by TVL...")
    pools = fetch_top_pools()
    print(f"[INFO] Got {len(pools)} pools.")

    addrs = [p["address"] for p in pools]
    addr_to_meta = {p["address"]: p for p in pools}

    print(f"[INFO] Layer A: daily_pool_stats ({DAILY_STATS_CUTOFF}..now), {DAILY_BATCH} pools/batch...")
    layer_a = fetch_daily_stats_window(addrs)
    sumA = sum(len(v) for v in layer_a.values())
    print(f"[INFO]   collected {sumA} day-rows for {len(layer_a)} pools")

    print(f"[INFO] Layer B: pool_prices (older), {PRICES_BATCH} pools/batch...")
    layer_b = fetch_prices_older_window(addrs)
    sumB = sum(len(v) for v in layer_b.values())
    print(f"[INFO]   collected {sumB} day-rows for {len(layer_b)} pools")

    # Merge per address; if a day exists in both layers, prefer A (closer to authoritative)
    out: dict[str, dict] = {}
    for addr in addrs:
        meta = addr_to_meta[addr]
        per_day: dict[str, float] = {}
        for d, v in layer_b.get(addr, []):
            per_day[d] = v
        for d, v in layer_a.get(addr, []):
            per_day[d] = v  # A wins on conflict
        if not per_day:
            continue
        days = sorted(
            ({"day": d, "vol_usd": round(v, 2)} for d, v in per_day.items()),
            key=lambda r: r["day"],
        )
        out[addr] = {
            "chain_id": meta["chain_id"],
            "name": meta["name"],
            "tvl_usd_at_snapshot": round(meta["tvl_usd"], 2),
            "days": days,
        }

    duration = round(time.time() - started, 2)

    payload = {
        "generated_ts": int(time.time()),
        "generated_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "lookback_days": LOOKBACK_DAYS,
        "layer_cutoff": DAILY_STATS_CUTOFF,
        "n_pools": len(out),
        "duration_s": duration,
        "pools": out,
    }
    OUT_PATH.write_text(json.dumps(payload, separators=(",", ":")) + "\n")
    print(f"[OK] Wrote {OUT_PATH.name}: {len(out)} pools, {duration}s, {OUT_PATH.stat().st_size//1024} KB")

    # Lightweight index for the frontend (just the list of pool addrs covered)
    INDEX_PATH.write_text(
        json.dumps(
            {
                "generated_ts": payload["generated_ts"],
                "n_pools": len(out),
                "pools": sorted(out.keys()),
            },
            separators=(",", ":"),
        )
        + "\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
