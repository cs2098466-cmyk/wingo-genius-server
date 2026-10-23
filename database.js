/* ============================================================
   DATABASE — PostgreSQL (Fixed Exports & Auto Cleanup)
============================================================ */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS patterns (
        id SERIAL PRIMARY KEY, engine VARCHAR(20) NOT NULL, context VARCHAR(20) NOT NULL,
        big_count INTEGER DEFAULT 0, small_count INTEGER DEFAULT 0,
        red_count INTEGER DEFAULT 0, green_count INTEGER DEFAULT 0, violet_count INTEGER DEFAULT 0,
        numbers JSONB DEFAULT '{}', weight INTEGER DEFAULT 100,
        hits INTEGER DEFAULT 0, misses INTEGER DEFAULT 0,
        sleeping BOOLEAN DEFAULT false, last_seen BIGINT DEFAULT 0, created_at BIGINT DEFAULT 0,
        UNIQUE(engine, context)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS engine_status (
        id SERIAL PRIMARY KEY, engine VARCHAR(20) UNIQUE NOT NULL,
        streak INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0, rounds INTEGER DEFAULT 0,
        last_prediction VARCHAR(20), last_confidence INTEGER DEFAULT 0,
        last_period VARCHAR(50), updated_at BIGINT DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY, engine VARCHAR(20) NOT NULL, period VARCHAR(50) NOT NULL,
        prediction VARCHAR(20) NOT NULL, confidence INTEGER DEFAULT 0,
        actual VARCHAR(20), status VARCHAR(20) DEFAULT 'PENDING', created_at BIGINT DEFAULT 0,
        UNIQUE(engine, period)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS prediction_sources (
        id SERIAL PRIMARY KEY, timeframe VARCHAR(10) NOT NULL, engine VARCHAR(20) NOT NULL,
        period VARCHAR(50) NOT NULL, source VARCHAR(10) NOT NULL, prediction VARCHAR(20) NOT NULL,
        confidence INTEGER DEFAULT 0, method VARCHAR(40), actual VARCHAR(20), status VARCHAR(20) DEFAULT 'PENDING',
        created_at BIGINT DEFAULT 0, UNIQUE(timeframe, engine, period, source)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS source_accuracy (
        id SERIAL PRIMARY KEY, timeframe VARCHAR(10) NOT NULL, engine VARCHAR(20) NOT NULL,
        source VARCHAR(10) NOT NULL, wins INTEGER DEFAULT 0, losses INTEGER DEFAULT 0,
        accuracy REAL DEFAULT 0.0, updated_at BIGINT DEFAULT 0,
        UNIQUE(timeframe, engine, source)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS combined_state (
        id SERIAL PRIMARY KEY, timeframe VARCHAR(10) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT false, jackpot_count INTEGER DEFAULT 0, last_check BIGINT DEFAULT 0
      )
    `);

    const engines = ['30s_number', '30s_colour', '30s_bigsmall', '1m_number', '1m_colour', '1m_bigsmall', '3m_number', '3m_colour', '3m_bigsmall', '5m_number', '5m_colour', '5m_bigsmall'];
    for (const e of engines) {
      await client.query(`INSERT INTO engine_status (engine, updated_at) VALUES ($1, $2) ON CONFLICT (engine) DO NOTHING`, [e, Date.now()]);
    }
    
    const timeframes = ['30s', '1m', '3m', '5m'];
    for (const tf of timeframes) {
      await client.query(`INSERT INTO combined_state (timeframe, last_check) VALUES ($1, $2) ON CONFLICT (timeframe) DO NOTHING`, [tf, Date.now()]);
    }

    console.log('[DB] Tables ready (Fixed)');
  } finally {
    client.release();
  }
}

// 🟢 यह फंक्शन पुराने डेटा को डिलीट करके स्पेस बचाएगा 🟢
async function cleanOldData(days = 7) {
  const client = await pool.connect();
  try {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    await client.query('DELETE FROM prediction_sources WHERE created_at < $1', [cutoff]);
    await client.query('DELETE FROM predictions WHERE created_at < $1', [cutoff]);
    console.log(`[DB CLEANUP] Deleted data older than ${days} days.`);
  } finally {
    client.release();
  }
}

async function upsertPattern(engine, context, data) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO patterns (engine, context, big_count, small_count, red_count, green_count, violet_count, numbers, weight, hits, misses, sleeping, last_seen, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (engine, context) DO UPDATE SET
        big_count = $3, small_count = $4, red_count = $5, green_count = $6, violet_count = $7,
        numbers = $8, weight = $9, hits = $10, misses = $11, sleeping = $12, last_seen = $13
    `, [engine, context, data.big_count || 0, data.small_count || 0, data.red_count || 0, data.green_count || 0, data.violet_count || 0, JSON.stringify(data.numbers || {}), data.weight || 100, data.hits || 0, data.misses || 0, data.sleeping || false, data.last_seen || 0, data.created_at || Date.now()]);
  } finally {
    client.release();
  }
}

async function loadAllPatterns(engine) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM patterns WHERE engine = $1 ORDER BY weight DESC`, [engine]);
    return r.rows;
  } finally { client.release(); }
}

async function getEngineStatus(engine) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM engine_status WHERE engine = $1`, [engine]);
    return r.rows[0] || null;
  } finally { client.release(); }
}

async function updateEngineStatus(engine, data) {
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE engine_status SET streak = $2, wins = $3, losses = $4, rounds = $5, last_prediction = $6, last_confidence = $7, last_period = $8, updated_at = $9 WHERE engine = $1
    `, [engine, data.streak || 0, data.wins || 0, data.losses || 0, data.rounds || 0, data.last_prediction || null, data.last_confidence || 0, data.last_period || null, Date.now()]);
  } finally { client.release(); }
}

async function savePrediction(engine, period, prediction, confidence, method) {
  const client = await pool.connect();
  try {
    await client.query(`INSERT INTO predictions (engine, period, prediction, confidence, status, created_at) VALUES ($1, $2, $3, $4, 'PENDING', $5) ON CONFLICT (engine, period) DO NOTHING`, [engine, period, prediction, confidence, Date.now()]);
  } finally { client.release(); }
}

async function resolvePrediction(engine, period, actual) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM predictions WHERE engine = $1 AND period = $2`, [engine, period]);
    if (!r.rows.length) return null;
    const p = r.rows[0];
    if (p.actual) return p;
    let status = 'MISS';
    if (p.prediction === actual) status = 'WIN';
    await client.query(`UPDATE predictions SET actual = $1, status = $2 WHERE id = $3`, [actual, status, p.id]);
    return { ...p, actual, status };
  } finally { client.release(); }
}

async function savePredictionSource(tf, engine, period, source, pred, conf, method) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO prediction_sources (timeframe, engine, period, source, prediction, confidence, method, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
      ON CONFLICT (timeframe, engine, period, source) DO UPDATE SET prediction = $5, confidence = $6, method = $7
    `, [tf, engine, period, source, pred, conf, method || '', Date.now()]);
  } finally { client.release(); }
}

async function resolvePredictionSources(tf, engine, period, actual) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM prediction_sources WHERE timeframe = $1 AND engine = $2 AND period = $3 AND actual IS NULL`, [tf, engine, period]);
    for (const row of r.rows) {
      const win = (row.prediction === actual);
      await client.query(`UPDATE prediction_sources SET actual = $1, status = $2 WHERE id = $3`, [actual, win ? 'WIN' : 'LOSS', row.id]);
      await updateSourceAccuracy(tf, engine, row.source, win);
    }
    return r.rows.length;
  } finally { client.release(); }
}

async function updateSourceAccuracy(tf, engine, source, win) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM source_accuracy WHERE timeframe = $1 AND engine = $2 AND source = $3`, [tf, engine, source]);
    if (r.rows.length === 0) {
      await client.query(`INSERT INTO source_accuracy (timeframe, engine, source, wins, losses, accuracy, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [tf, engine, source, win ? 1 : 0, win ? 0 : 1, win ? 100 : 0, Date.now()]);
    } else {
      const row = r.rows[0];
      const wins = row.wins + (win ? 1 : 0);
      const losses = row.losses + (win ? 0 : 1);
      const acc = wins / (wins + losses) * 100;
      await client.query(`UPDATE source_accuracy SET wins = $1, losses = $2, accuracy = $3, updated_at = $4 WHERE id = $5`, [wins, losses, acc, Date.now(), row.id]);
    }
  } finally { client.release(); }
}

async function getSourceAccuracy(tf, engine, source) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM source_accuracy WHERE timeframe = $1 AND engine = $2 AND source = $3`, [tf, engine, source]);
    return r.rows[0] || { wins: 0, losses: 0, accuracy: 0 };
  } finally { client.release(); }
}

async function getAllSourceAccuracies(tf) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM source_accuracy WHERE timeframe = $1`, [tf]);
    return r.rows;
  } finally { client.release(); }
}

async function getLatestPendingPrediction(tf, engine, source) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM prediction_sources WHERE timeframe = $1 AND engine = $2 AND source = $3 AND status = 'PENDING' ORDER BY created_at DESC LIMIT 1`, [tf, engine, source]);
    return r.rows[0] || null;
  } finally { client.release(); }
}

async function getSourceHistory(tf, engine, source, limit = 30) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM prediction_sources WHERE timeframe = $1 AND engine = $2 AND source = $3 ORDER BY created_at DESC LIMIT $4`, [tf, engine, source, limit]);
    return r.rows;
  } finally { client.release(); }
}

async function getCombinedState(timeframe) {
  const client = await pool.connect();
  try {
    const r = await client.query(`SELECT * FROM combined_state WHERE timeframe = $1`, [timeframe]);
    return r.rows[0] || null;
  } finally { client.release(); }
}

async function updateCombinedState(timeframe, active) {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE combined_state SET active = $2, last_check = $3 WHERE timeframe = $1`, [timeframe, active, Date.now()]);
  } finally { client.release(); }
}

async function incrementJackpot(timeframe) {
  const client = await pool.connect();
  try {
    await client.query(`UPDATE combined_state SET jackpot_count = jackpot_count + 1 WHERE timeframe = $1`, [timeframe]);
  } finally { client.release(); }
}

module.exports = {
  pool, initDB, cleanOldData, // Added CleanOldData
  upsertPattern, loadAllPatterns, getEngineStatus, updateEngineStatus,
  savePrediction, resolvePrediction, getCombinedState, updateCombinedState, incrementJackpot,
  savePredictionSource, resolvePredictionSources, updateSourceAccuracy, getSourceAccuracy,
  getAllSourceAccuracies, getLatestPendingPrediction, getSourceHistory
};