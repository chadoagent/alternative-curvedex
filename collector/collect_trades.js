#!/usr/bin/env node
/**
 * Curve DEX trade collector.
 * Fetches trades from prices.curve.finance and stores them in SQLite.
 *
 * Usage:
 *   node collect_trades.js                          # top 200 pools by TVL
 *   node collect_trades.js --pools pools.json       # custom pool list
 *   node collect_trades.js --pool 0xbEbc44...       # single pool (auto-discovers coins)
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'trades.db');
const RATE_LIMIT_MS = 200;
const MAX_PAGES_FIRST_RUN = 20;   // 20 * 100 = 2000 trades
const PER_PAGE = 100;
const CURVE_POOLS_REGISTRIES = ['main', 'crypto', 'factory-stable-ng', 'factory-crypto', 'factory-twocrypto', 'factory-tricrypto'];
const TOP_N = 500;

// --------------- helpers ---------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// --------------- DB setup ---------------

function initDB() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      pool       TEXT    NOT NULL,
      tx_hash    TEXT    UNIQUE NOT NULL,
      timestamp  INTEGER NOT NULL,
      token_in   TEXT    NOT NULL,
      token_out  TEXT    NOT NULL,
      amount_in  REAL    NOT NULL,
      amount_out REAL    NOT NULL,
      usd_value  REAL    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_trades_pool_ts ON trades(pool, timestamp);
  `);
  return db;
}

// --------------- fetch pools from Curve API ---------------

async function fetchTopPools(n = TOP_N) {
  console.log(`Fetching pools from Curve API (top ${n} by TVL)...`);
  const allPools = [];

  for (const registry of CURVE_POOLS_REGISTRIES) {
    try {
      const url = `https://api.curve.finance/v1/getPools/ethereum/${registry}`;
      const data = await fetchJSON(url);
      const pools = data?.data?.poolData || [];
      for (const p of pools) {
        const coins = p.coins || [];
        if (coins.length < 2) continue;
        allPools.push({
          address: p.address.toLowerCase(),
          tvl: parseFloat(p.usdTotal || 0),
          coin0: coins[0].address,
          coin1: coins[1].address,
          name: p.name || p.id || p.address,
        });
      }
      console.log(`  ${registry}: ${pools.length} pools`);
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      console.warn(`  ${registry}: failed — ${err.message}`);
    }
  }

  allPools.sort((a, b) => b.tvl - a.tvl);
  const top = allPools.slice(0, n);
  console.log(`Selected ${top.length} pools. Top TVL: $${(top[0]?.tvl / 1e6).toFixed(1)}M`);
  return top;
}

// --------------- fetch pool coins via trades API probe ---------------

async function discoverCoins(poolAddress) {
  // Use the Curve pools API to find coins for a single pool
  for (const registry of CURVE_POOLS_REGISTRIES) {
    try {
      const data = await fetchJSON(`https://api.curve.finance/v1/getPools/ethereum/${registry}`);
      const pools = data?.data?.poolData || [];
      const found = pools.find(p => p.address.toLowerCase() === poolAddress.toLowerCase());
      if (found && found.coins?.length >= 2) {
        return { coin0: found.coins[0].address, coin1: found.coins[1].address, name: found.name || found.id };
      }
    } catch { /* skip */ }
    await sleep(RATE_LIMIT_MS);
  }
  return null;
}

// --------------- load pools from JSON config ---------------

function loadPoolsFromJSON(filePath) {
  const fs = require('fs');
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  // Expect: [{ address, coin0, coin1, name? }]
  return raw.map(p => ({
    address: p.address.toLowerCase(),
    coin0: p.coin0,
    coin1: p.coin1,
    name: p.name || p.address,
    tvl: p.tvl || 0,
  }));
}

// --------------- collect trades for one pool ---------------

async function collectPool(db, pool) {
  const { address, coin0, coin1, name } = pool;

  // Get latest timestamp already in DB
  const row = db.prepare('SELECT MAX(timestamp) as max_ts FROM trades WHERE pool = ?').get(address);
  const latestTs = row?.max_ts || 0;
  const isFirstRun = latestTs === 0;
  const maxPages = isFirstRun ? MAX_PAGES_FIRST_RUN : 100;

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO trades (pool, tx_hash, timestamp, token_in, token_out, amount_in, amount_out, usd_value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Resolve token symbols once via a 1-trade probe
  let symbolByIndex = {};
  try {
    const probe = await fetchJSON(
      `https://prices.curve.finance/v1/trades/ethereum/${address}?main_token=${coin0}&reference_token=${coin1}&per_page=1&page=1`
    );
    symbolByIndex[probe.main_token.pool_index] = probe.main_token.symbol;
    symbolByIndex[probe.reference_token.pool_index] = probe.reference_token.symbol;
    await sleep(RATE_LIMIT_MS);
  } catch (err) {
    console.warn(`  Could not resolve symbols: ${err.message}`);
    symbolByIndex = { 0: coin0.slice(0, 10), 1: coin1.slice(0, 10) };
  }

  let totalInserted = 0;
  let page = 1;

  while (page <= maxPages) {
    const url = `https://prices.curve.finance/v1/trades/ethereum/${address}?main_token=${coin0}&reference_token=${coin1}&per_page=${PER_PAGE}&page=${page}`;

    let data;
    try {
      const resp = await fetchJSON(url);
      data = resp.data || [];
    } catch (err) {
      console.error(`  Page ${page} error: ${err.message}`);
      break;
    }

    if (data.length === 0) break;

    let hitOld = false;
    let pageInserted = 0;

    const insertMany = db.transaction((trades) => {
      for (const t of trades) {
        const ts = Math.floor(new Date(t.time + 'Z').getTime() / 1000);

        if (!isFirstRun && ts <= latestTs) {
          hitOld = true;
          break;
        }

        const tokenIn = symbolByIndex[t.sold_id] || `coin${t.sold_id}`;
        const tokenOut = symbolByIndex[t.bought_id] || `coin${t.bought_id}`;
        const usdValue = Math.max(t.tokens_sold_usd || 0, t.tokens_bought_usd || 0);

        const result = insertStmt.run(
          address, t.transaction_hash, ts,
          tokenIn, tokenOut, t.tokens_sold, t.tokens_bought, usdValue
        );
        if (result.changes > 0) pageInserted++;
      }
    });

    insertMany(data);
    totalInserted += pageInserted;

    if (hitOld) {
      console.log(`  Page ${page}: ${pageInserted} new, hit existing — stopping`);
      break;
    }

    if (data.length < PER_PAGE) {
      console.log(`  Page ${page}: ${pageInserted} new (last page)`);
      break;
    }

    console.log(`  Page ${page}: ${pageInserted} new`);
    page++;
    await sleep(RATE_LIMIT_MS);
  }

  return totalInserted;
}

// --------------- main ---------------

async function main() {
  const args = process.argv.slice(2);
  let pools = [];

  // Parse args
  const poolsFileIdx = args.indexOf('--pools');
  const singlePoolIdx = args.indexOf('--pool');

  if (poolsFileIdx !== -1 && args[poolsFileIdx + 1]) {
    pools = loadPoolsFromJSON(args[poolsFileIdx + 1]);
    console.log(`Loaded ${pools.length} pools from ${args[poolsFileIdx + 1]}`);
  } else if (singlePoolIdx !== -1 && args[singlePoolIdx + 1]) {
    const addr = args[singlePoolIdx + 1].toLowerCase();
    console.log(`Discovering coins for pool ${addr}...`);
    const info = await discoverCoins(addr);
    if (!info) {
      console.error(`Could not find pool ${addr} in Curve registries`);
      process.exit(1);
    }
    pools = [{ address: addr, coin0: info.coin0, coin1: info.coin1, name: info.name, tvl: 0 }];
    console.log(`Found: ${info.name} (${info.coin0.slice(0, 10)}... / ${info.coin1.slice(0, 10)}...)`);
  } else {
    pools = await fetchTopPools(TOP_N);
  }

  const db = initDB();
  console.log(`\nDB: ${DB_PATH}`);
  console.log(`Collecting trades for ${pools.length} pool(s)...\n`);

  let totalAll = 0;
  const startTime = Date.now();

  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const existing = db.prepare('SELECT COUNT(*) as cnt FROM trades WHERE pool = ?').get(pool.address);
    console.log(`[${i + 1}/${pools.length}] ${pool.name} (${pool.address.slice(0, 10)}...) — ${existing.cnt} existing trades`);

    try {
      const inserted = await collectPool(db, pool);
      totalAll += inserted;
      console.log(`  => +${inserted} trades\n`);
    } catch (err) {
      console.error(`  => ERROR: ${err.message}\n`);
    }

    if (i < pools.length - 1) await sleep(RATE_LIMIT_MS);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totalRows = db.prepare('SELECT COUNT(*) as cnt FROM trades').get().cnt;
  console.log(`Done. Inserted ${totalAll} new trades in ${elapsed}s. Total in DB: ${totalRows}`);

  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
