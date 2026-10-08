/* ============================================================
   DATABASE — PostgreSQL
   हर engine का data अलग save होगा
============================================================ */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

/* Tables बनाओ अगर नहीं हैं */
async function initDB() {
  const client = await pool.connect();
  try {
    /* Patterns table — हर pattern हमेशा ज़िंदा */
    await client.query(`
      CREATE TABLE IF NOT EXISTS patterns (
        id SERIAL PRIMARY KEY,
        engine VARCHAR(20) NOT NULL,
        context VARCHAR(20) NOT NULL,
        big_count INTEGER DEFAULT 0,
        small_count INTEGER DEFAULT 0,
        red_count INTEGER DEFAULT 0,
        green_count INTEGER DEFAULT 0,
        violet_count INTEGER DEFAULT 0,
        numbers JSONB DEFAULT '{}',
        weight INTEGER DEFAULT 100,
        hits INTEGER DEFAULT 0,
        misses INTEGER DEFAULT 0,
        sleeping BOOLEAN DEFAULT false,
        last_seen BIGINT DEFAULT 0,
        created_at BIGINT DEFAULT 0,
        UNIQUE(engine, context)
      )
    `);

    /* Engine status table */
    await client.query(`
      CREATE TABLE IF NOT EXISTS engine_status (
        id SERIAL PRIMARY KEY,
        engine VARCHAR(20) UNIQUE NOT NULL,
        streak INTEGER DEFAULT 0,
        wins INTEGER DEFAULT 0,
        losses INTEGER DEFAULT 0,
        rounds INTEGER DEFAULT 0,
        last_prediction VARCHAR(20),
        last_confidence INTEGER DEFAULT 0,
        last_period VARCHAR(50),
        updated_at BIGINT DEFAULT 0
      )
    `);

    /* Prediction history */
    await client.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        engine VARCHAR(20) NOT NULL,
        period VARCHAR(50) NOT NULL,
        prediction VARCHAR(20) NOT NULL,
        confidence INTEGER DEFAULT 0,
        actual VARCHAR(20),
        status VARCHAR(20) DEFAULT 'PENDING',
        created_at BIGINT DEFAULT 0,
        UNIQUE(engine, period)
      )
    `);

    /* JACKPOT history */
    await client.query(`
      CREATE TABLE IF NOT EXISTS jackpots (
        id SERIAL PRIMARY KEY,
        timeframe VARCHAR(10) NOT NULL,
        period VARCHAR(50) NOT NULL,
        bigsmall_pred VARCHAR(20),
        colour_pred VARCHAR(20),
        number_pred VARCHAR(20),
        actual_number INTEGER,
        created_at BIGINT DEFAULT 0
      )
    `);

    /* Combined state */
    await client.query(`
      CREATE TABLE IF NOT EXISTS combined_state (
        id SERIAL PRIMARY KEY,
        timeframe VARCHAR(10) UNIQUE NOT NULL,
        active BOOLEAN DEFAULT false,
        jackpot_count INTEGER DEFAULT 0,
        last_check BIGINT DEFAULT 0
      )
    `);

    /* Initialize engine status rows if missing */
    const engines = [
      '30s_number', '30s_colour', '30s_bigsmall',
      '1m_number', '1m_colour', '1m_bigsmall'
    ];
    for (const e of engines) {
      await client.query(
        `INSERT INTO engine_status (engine, updated_at) VALUES ($1, $2)
         ON CONFLICT (engine) DO NOTHING`,
        [e, Date.now()]
      );
    }
    const timeframes = ['30s', '1m'];
    for (const tf of timeframes) {
      await client.query(
        `INSERT INTO combined_state (timeframe, last_check) VALUES ($1, $2)
         ON CONFLICT (timeframe) DO NOTHING`,
        [tf, Date.now()]
      );
    }

    console.log('[DB] Tables ready');
  } finally {
    client.release();
  }
}

/* Pattern save/load */
async function upsertPattern(engine, context, data) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO patterns (engine, context, big_count, small_count,
        red_count, green_count, violet_count, numbers, weight, hits, misses,
        sleeping, last_seen, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (engine, context) DO UPDATE SET
        big_count = $3, small_count = $4,
        red_count = $5, green_count = $6, violet_count = $7,
        numbers = $8, weight = $9, hits = $10, misses = $11,
        sleeping = $12, last_seen = $13
    `, [
      engine, context,
      data.big_count || 0, data.small_count || 0,
      data.red_count || 0, data.green_count || 0, data.violet_count || 0,
      JSON.stringify(data.numbers || {}),
      data.weight || 100, data.hits || 0, data.misses || 0,
      data.sleeping || false, data.last_seen || 0,
      data.created_at || Date.now()
    ]);
  } finally {
    client.release();
  }
}

async function loadAllPatterns(engine) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT * FROM patterns WHERE engine = $1 ORDER BY weight DESC`,
      [engine]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

/* Engine status */
async function getEngineStatus(engine) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT * FROM engine_status WHERE engine = $1`,
      [engine]
    );
    return r.rows[0] || null;
  } finally {
    client.release();
  }
}

async function updateEngineStatus(engine, data) {
  const client = await pool.connect();
  try {
    await client.query(`
      UPDATE engine_status SET
        streak = $2, wins = $3, losses = $4, rounds = $5,
        last_prediction = $6, last_confidence = $7,
        last_period = $8, updated_at = $9
      WHERE engine = $1
    `, [
      engine,
      data.streak || 0, data.wins || 0, data.losses || 0, data.rounds || 0,
      data.last_prediction || null, data.last_confidence || 0,
      data.last_period || null, Date.now()
    ]);
  } finally {
    client.release();
  }
}

/* Predictions */
async function savePrediction(engine, period, prediction, confidence) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO predictions (engine, period, prediction, confidence, status, created_at)
      VALUES ($1, $2, $3, $4, 'PENDING', $5)
      ON CONFLICT (engine, period) DO NOTHING
    `, [engine, period, prediction, confidence, Date.now()]);
  } finally {
    client.release();
  }
}

async function resolvePrediction(engine, period, actual) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT * FROM predictions WHERE engine = $1 AND period = $2`,
      [engine, period]
    );
    if (!r.rows.length) return null;
    const p = r.rows[0];
    if (p.actual) return p;

    let status = 'MISS';
    if (p.prediction === actual) status = 'WIN';
    await client.query(
      `UPDATE predictions SET actual = $1, status = $2 WHERE id = $3`,
      [actual, status, p.id]
    );
    return { ...p, actual, status };
  } finally {
    client.release();
  }
}

async function getRecentPredictions(engine, limit = 30) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT * FROM predictions WHERE engine = $1
       ORDER BY created_at DESC LIMIT $2`,
      [engine, limit]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

/* Combined state */
async function getCombinedState(timeframe) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT * FROM combined_state WHERE timeframe = $1`,
      [timeframe]
    );
    return r.rows[0] || null;
  } finally {
    client.release();
  }
}

async function updateCombinedState(timeframe, active) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE combined_state SET active = $2, last_check = $3 WHERE timeframe = $1`,
      [timeframe, active, Date.now()]
    );
  } finally {
    client.release();
  }
}

async function incrementJackpot(timeframe) {
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE combined_state SET jackpot_count = jackpot_count + 1 WHERE timeframe = $1`,
      [timeframe]
    );
  } finally {
    client.release();
  }
}

async function saveJackpot(timeframe, period, bs, col, num, actual) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO jackpots (timeframe, period, bigsmall_pred, colour_pred, number_pred, actual_number, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [timeframe, period, bs, col, num, actual, Date.now()]);
  } finally {
    client.release();
  }
}

async function getRecentJackpots(timeframe, limit = 20) {
  const client = await pool.connect();
  try {
    const r = await client.query(
      `SELECT * FROM jackpots WHERE timeframe = $1 ORDER BY created_at DESC LIMIT $2`,
      [timeframe, limit]
    );
    return r.rows;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDB,
  upsertPattern,
  loadAllPatterns,
  getEngineStatus,
  updateEngineStatus,
  savePrediction,
  resolvePrediction,
  getRecentPredictions,
  getCombinedState,
  updateCombinedState,
  incrementJackpot,
  saveJackpot,
  getRecentJackpots
};