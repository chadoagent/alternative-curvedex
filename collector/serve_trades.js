#!/usr/bin/env node
/**
 * Simple Express server for aggregated trade volume data.
 * GET /trades/:pool_address?from=UNIX_TS&to=UNIX_TS
 * Returns daily volume buckets.
 *
 * Port: 3010
 */

const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'trades.db');
const PORT = 3010;

const app = express();
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

function openDB() {
  const db = new Database(DB_PATH, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

// GET /trades/:pool_address?from=TIMESTAMP&to=TIMESTAMP
app.get('/trades/:pool_address', (req, res) => {
  const pool = req.params.pool_address.toLowerCase();
  // Pool addresses are not unique across chains, so the chain is part of the
  // key. Old clients that send none still get Ethereum, as before.
  const chain = (req.query.chain || 'ethereum').toLowerCase();
  const from = parseInt(req.query.from) || 0;
  const to = parseInt(req.query.to) || Math.floor(Date.now() / 1000);
  // Sub-daily resolution for intraday charts. Without it the client had to
  // smear one daily figure over the day's candles, so a 4H chart drew the same
  // bar six times (Alexandr crvecodev/1828). 60s floor, 1 day default.
  const bucketSec = Math.max(60, parseInt(req.query.bucket) || 86400);
  // The chart's grid is not the UTC grid: Curve's 4H candles sit at 02:00,
  // 06:00, ... so buckets aligned to 00:00/04:00 matched no candle at all.
  // The caller passes its own phase; 0 means plain UTC alignment.
  const bucketOff = ((parseInt(req.query.offset) || 0) % bucketSec + bucketSec) % bucketSec;

  let db;
  try {
    db = openDB();
  } catch (err) {
    return res.status(500).json({ error: 'Database not found. Run collect_trades.js first.' });
  }

  try {
    // Check pool exists
    const poolCheck = db.prepare('SELECT COUNT(*) as cnt FROM trades WHERE chain = ? AND pool = ?').get(chain, pool);
    if (poolCheck.cnt === 0) {
      db.close();
      return res.status(404).json({ error: `No trades found for pool ${pool} on ${chain}` });
    }

    // Aggregate into daily buckets (86400s = 1 day)
    // day_start = timestamp rounded down to midnight UTC
    const rows = db.prepare(`
      SELECT
        (timestamp / 86400) * 86400 AS day_start,
        COUNT(*)                    AS trade_count,
        SUM(usd_value)             AS volume_usd,
        SUM(amount_in)             AS total_in,
        SUM(amount_out)            AS total_out,
        MIN(timestamp)             AS first_trade,
        MAX(timestamp)             AS last_trade
      FROM trades
      WHERE chain = ? AND pool = ? AND timestamp >= ? AND timestamp <= ?
      GROUP BY day_start
      ORDER BY day_start ASC
    `).all(chain, pool, from, to);

    // Get total stats
    const total = db.prepare(`
      SELECT COUNT(*) as trades, SUM(usd_value) as volume_usd,
             MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
      FROM trades WHERE chain = ? AND pool = ? AND timestamp >= ? AND timestamp <= ?
    `).get(chain, pool, from, to);

    // Only computed when the caller wants something other than days — the
    // daily array still feeds 1D/1W and the long-history merge.
    const buckets = bucketSec === 86400 ? null : db.prepare(`
      SELECT ((timestamp - CAST(? AS INTEGER)) / CAST(? AS INTEGER)) * CAST(? AS INTEGER) + CAST(? AS INTEGER) AS bucket_start,
             COUNT(*)            AS trade_count,
             SUM(usd_value)      AS volume_usd
      FROM trades
      WHERE chain = ? AND pool = ? AND timestamp >= ? AND timestamp <= ?
      GROUP BY bucket_start
      ORDER BY bucket_start ASC
    `).all(bucketOff, bucketSec, bucketSec, bucketOff, chain, pool, from, to);

    db.close();

    res.json({
      pool,
      chain,
      from,
      to,
      bucket_sec: bucketSec,
      buckets: buckets && buckets.map(r => ({
        timestamp: r.bucket_start,
        trade_count: r.trade_count,
        volume_usd: Math.round((r.volume_usd || 0) * 100) / 100,
      })),
      summary: {
        total_trades: total.trades,
        total_volume_usd: Math.round((total.volume_usd || 0) * 100) / 100,
        first_trade: total.first_ts ? new Date(total.first_ts * 1000).toISOString() : null,
        last_trade: total.last_ts ? new Date(total.last_ts * 1000).toISOString() : null,
      },
      daily: rows.map(r => ({
        date: new Date(r.day_start * 1000).toISOString().split('T')[0],
        timestamp: r.day_start,
        trade_count: r.trade_count,
        volume_usd: Math.round((r.volume_usd || 0) * 100) / 100,
        first_trade: r.first_trade,
        last_trade: r.last_trade,
      })),
    });
  } catch (err) {
    db.close();
    res.status(500).json({ error: err.message });
  }
});

// GET /pools — list all pools in DB with stats
app.get('/pools', (req, res) => {
  let db;
  try {
    db = openDB();
  } catch (err) {
    return res.status(500).json({ error: 'Database not found.' });
  }

  try {
    const rows = db.prepare(`
      SELECT chain, pool, COUNT(*) as trades, SUM(usd_value) as volume_usd,
             MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
      FROM trades GROUP BY chain, pool ORDER BY volume_usd DESC
    `).all();

    db.close();
    res.json({
      count: rows.length,
      pools: rows.map(r => ({
        chain: r.chain,
        pool: r.pool,
        trades: r.trades,
        volume_usd: Math.round((r.volume_usd || 0) * 100) / 100,
        first_trade: new Date(r.first_ts * 1000).toISOString(),
        last_trade: new Date(r.last_ts * 1000).toISOString(),
      })),
    });
  } catch (err) {
    db.close();
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Trade server listening on http://localhost:${PORT}`);
  console.log(`  GET /trades/:pool_address?from=TS&to=TS`);
  console.log(`  GET /pools`);
});
