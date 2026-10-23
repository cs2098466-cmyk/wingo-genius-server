/* ============================================================
   DATABASE — PostgreSQL (Ensemble Learning Enabled)
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
    // ... (बाकी सारे CREATE TABLE वैसे ही रहेंगे जैसे आपके पास हैं) ...
    // मैंने यहाँ पूरा कोड नहीं दिया है ताकि कन्फ्यूजन न हो, 
    // आप अपनी पुरानी database.js का कोड ही इस्तेमाल करें, उसमें कोई बदलाव की जरुरत नहीं है।
    // बस नीचे दिए गए functions को चेक कर लें कि वो मौजूद हैं।
    
    console.log('[DB] Tables ready (with Ensemble)');
  } finally {
    client.release();
  }
}

// ... (initDB और बाकी functions जैसे upsertPattern, getEngineStatus वैसे ही रहेंगे) ...

/* ============ ENSEMBLE FUNCTIONS ============ */

async function savePredictionSource(tf, engine, period, source, pred, conf, method) {
  const client = await pool.connect();
  try {
    await client.query(`
      INSERT INTO prediction_sources 
        (timeframe, engine, period, source, prediction, confidence, method, status, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8)
      ON CONFLICT (timeframe, engine, period, source) DO UPDATE SET
        prediction = $5, confidence = $6, method = $7
    `, [tf, engine, period, source, pred, conf, method || '', Date.now()]);
  } finally {
    client.release();
  }
}

async function resolvePredictionSources(tf, engine, period, actual) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT * FROM prediction_sources 
      WHERE timeframe = $1 AND engine = $2 AND period = $3 AND actual IS NULL
    `, [tf, engine, period]);
    
    for (const row of r.rows) {
      const win = (row.prediction === actual);
      await client.query(`
        UPDATE prediction_sources SET actual = $1, status = $2 WHERE id = $3
      `, [actual, win ? 'WIN' : 'LOSS', row.id]);
      
      await updateSourceAccuracy(tf, engine, row.source, win);
    }
    return r.rows.length;
  } finally {
    client.release();
  }
}

async function updateSourceAccuracy(tf, engine, source, win) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT * FROM source_accuracy WHERE timeframe = $1 AND engine = $2 AND source = $3
    `, [tf, engine, source]);
    
    if (r.rows.length === 0) {
      await client.query(`
        INSERT INTO source_accuracy (timeframe, engine, source, wins, losses, accuracy, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `, [tf, engine, source, win ? 1 : 0, win ? 0 : 1, win ? 100 : 0, Date.now()]);
    } else {
      const row = r.rows[0];
      const wins = row.wins + (win ? 1 : 0);
      const losses = row.losses + (win ? 0 : 1);
      const acc = wins / (wins + losses) * 100;
      await client.query(`
        UPDATE source_accuracy SET wins = $1, losses = $2, accuracy = $3, updated_at = $4 WHERE id = $5
      `, [wins, losses, acc, Date.now(), row.id]);
    }
  } finally {
    client.release();
  }
}

async function getSourceAccuracy(tf, engine, source) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT * FROM source_accuracy WHERE timeframe = $1 AND engine = $2 AND source = $3
    `, [tf, engine, source]);
    return r.rows[0] || { wins: 0, losses: 0, accuracy: 0 };
  } finally {
    client.release();
  }
}

async function getLatestPendingPrediction(tf, engine, source) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT * FROM prediction_sources 
      WHERE timeframe = $1 AND engine = $2 AND source = $3 
        AND status = 'PENDING'
      ORDER BY created_at DESC LIMIT 1
    `, [tf, engine, source]);
    return r.rows[0] || null;
  } finally {
    client.release();
  }
}

async function getSourceHistory(tf, engine, source, limit = 30) {
  const client = await pool.connect();
  try {
    const r = await client.query(`
      SELECT * FROM prediction_sources 
      WHERE timeframe = $1 AND engine = $2 AND source = $3 
      ORDER BY created_at DESC LIMIT $4
    `, [tf, engine, source, limit]);
    return r.rows;
  } finally {
    client.release();
  }
}

// ... (बाकी functions module.exports में जोड़ दें) ...

module.exports = {
  pool,
  initDB,
  upsertPattern,
  loadAllPatterns,
  getEngineStatus,
  updateEngineStatus,
  savePrediction,
  resolvePrediction,
  getCombinedState,
  updateCombinedState,
  incrementJackpot,
  savePredictionSource,
  resolvePredictionSources,
  updateSourceAccuracy,
  getSourceAccuracy,
  getLatestPendingPrediction,
  getSourceHistory
};