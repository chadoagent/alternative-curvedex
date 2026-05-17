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
  const from = parseInt(req.query.from) || 0;
  const to = parseInt(req.query.to) || Math.floor(Date.now() / 1000);

  let db;
  try {
    db = openDB();
  } catch (err) {
    return res.status(500).json({ error: 'Database not found. Run collect_trades.js first.' });
  }

  try {
    // Check pool exists
    const poolCheck = db.prepare('SELECT COUNT(*) as cnt FROM trades WHERE pool = ?').get(pool);
    if (poolCheck.cnt === 0) {
      db.close();
      return res.status(404).json({ error: `No trades found for pool ${pool}` });
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
      WHERE pool = ? AND timestamp >= ? AND timestamp <= ?
      GROUP BY day_start
      ORDER BY day_start ASC
    `).all(pool, from, to);

    // Get total stats
    const total = db.prepare(`
      SELECT COUNT(*) as trades, SUM(usd_value) as volume_usd,
             MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
      FROM trades WHERE pool = ? AND timestamp >= ? AND timestamp <= ?
    `).get(pool, from, to);

    db.close();

    res.json({
      pool,
      from,
      to,
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
      SELECT pool, COUNT(*) as trades, SUM(usd_value) as volume_usd,
             MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
      FROM trades GROUP BY pool ORDER BY volume_usd DESC
    `).all();

    db.close();
    res.json({
      count: rows.length,
      pools: rows.map(r => ({
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
