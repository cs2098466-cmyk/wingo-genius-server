/* ============================================================
   WINGO GENIUS SERVER (Ensemble Learning Enabled)
   - Local (APK) + Server predictions tracked separately
   - Weighted combined prediction
============================================================ */

const express = require('express');
const db = require('./database');
const eng = require('./engines');

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- CORS & JSON Middleware ---------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));

/* ---------- Constants ---------- */
const TRAINING_ROUNDS = 100;
const COMBINED_ACTIVE = 50;
const COMBINED_FULL = 100;

/* ---------- Engine state ---------- */
function blankEngine() {
  return {
    rounds: 0, wins: 0, losses: 0, correctCount: 0, currentStreak: 0,
    status: 'TRAINING', pending: null, lastPrediction: null,
    lastActual: null, lastResult: null, recent: []
  };
}

function createTimeframeState() {
  return {
    number: blankEngine(),
    colour: blankEngine(),
    bigsmall: blankEngine(),
    combined: { status: 'WAITING', jackpots: 0, pendingCombined: null, history: [] },
    lastPeriod: null,
    apiHistory: []
  };
}

const state = {
  '30s': createTimeframeState(),
  '1m':  createTimeframeState(),
  '3m':  createTimeframeState(),
  '5m':  createTimeframeState()
};

/* ---------- Helpers ---------- */
function engineKeyFor(tf, engineType) {
  const map = { number: 'number', colour: 'colour', bigsmall: 'bigsmall' };
  return `${tf}_${map[engineType] || engineType}`;
}

function actualFor(engineType, number) {
  if (engineType === 'number') return String(number);
  if (engineType === 'colour') return eng.colourOf(number);
  return eng.sizeOf(number);
}

/* ---------- Resolve a pending prediction (server-side engine) ---------- */
function resolveEngine(tf, engineType, latestPeriod, latestNumber) {
  const e = state[tf][engineType];
  if (!e.pending) return;
  if (e.pending.period !== latestPeriod) return;

  const pred = e.pending.prediction;
  const actual = actualFor(engineType, latestNumber);
  const win = (pred === actual);

  e.lastPrediction = pred;
  e.lastActual = actual;
  e.lastResult = win ? 'WIN' : 'LOSS';
  if (win) {
    e.wins++;
    e.correctCount++;
    e.currentStreak = e.currentStreak > 0 ? e.currentStreak + 1 : 1;
  } else {
    e.losses++;
    e.currentStreak = e.currentStreak < 0 ? e.currentStreak - 1 : -1;
  }
  e.recent.unshift({ period: latestPeriod, prediction: pred, actual, status: win ? 'WIN' : 'LOSS' });
  if (e.recent.length > 30) e.recent.pop();
  e.pending = null;
}

/* ---------- Make server-side prediction ---------- */
function makePrediction(tf, engineType, patterns, latestPeriod, numbers) {
  const e = state[tf][engineType];
  if (e.rounds < TRAINING_ROUNDS) return;

  const nextPeriod = (BigInt(latestPeriod) + 1n).toString();
  const context = eng.makeContext(numbers);

  let pred = null;
  if (engineType === 'number') pred = eng.predictNumber(context, patterns);
  else if (engineType === 'colour') pred = eng.predictColour(context, patterns);
  else pred = eng.predictSize(context, patterns);

  if (pred) {
    e.pending = { period: nextPeriod, prediction: pred.prediction, confidence: pred.confidence || 0 };
  }
}

/* ---------- Combined status (server-side 3-in-1) ---------- */
function updateCombined(tf) {
  const s = state[tf];
  const n = s.number.correctCount, c = s.colour.correctCount, b = s.bigsmall.correctCount;
  if (n >= COMBINED_FULL && c >= COMBINED_FULL && b >= COMBINED_FULL) s.combined.status = 'FULL';
  else if (n >= COMBINED_ACTIVE && c >= COMBINED_ACTIVE && b >= COMBINED_ACTIVE) s.combined.status = 'ACTIVE';
  else s.combined.status = 'WAITING';
}

/* ---------- Save server-side predictions to DB ---------- */
async function saveServerPredictions(tf, latestPeriod) {
  for (const et of ['number', 'colour', 'bigsmall']) {
    const e = state[tf][et];
    if (e.pending && e.pending.period) {
      await db.savePredictionSource(
        tf,
        et === 'bigsmall' ? 'size' : et,
        e.pending.period,
        'server',
        e.pending.prediction,
        e.pending.confidence || 0,
        'server-engine'
      );
    }
  }
}

/* ---------- Process incoming list ---------- */
async function ingestList(tf, list, localPred) {
  if (!list || !list.length) return 0;

  const latest = list[0];
  const latestPeriod = latest.period;
  const latestNumber = latest.number;

  if (state[tf].lastPeriod === latestPeriod) return 0;
  state[tf].lastPeriod = latestPeriod;

  /* 1. Resolve server engines */
  for (const et of ['number', 'colour', 'bigsmall']) {
    resolveEngine(tf, et, latestPeriod, latestNumber);
  }

  /* 2. Resolve ensemble sources from DB (local + server for this period) */
  for (const et of ['number', 'colour', 'bigsmall']) {
    const dbEngine = (et === 'bigsmall') ? 'size' : et;
    const actual = actualFor(et, latestNumber);
    await db.resolvePredictionSources(tf, dbEngine, latestPeriod, actual);
  }

  /* 3. apiHistory */
  state[tf].apiHistory.unshift({
    period: latestPeriod,
    number: latestNumber,
    size: eng.sizeOf(latestNumber),
    colour: eng.colourOf(latestNumber)
  });
  if (state[tf].apiHistory.length > 40) state[tf].apiHistory.pop();

  /* 4. Learn patterns */
  const chrono = list.slice(0, 100).reverse();
  const numbers = chrono.map(x => x.number);

  const existingPatterns = await db.loadAllPatterns(`${tf}_number`);
  const newPatterns = eng.learnPatterns(`${tf}`, numbers, existingPatterns);

  for (const p of newPatterns) {
    await db.upsertPattern(`${tf}_number`, p.context, p);
    await db.upsertPattern(`${tf}_colour`, p.context, p);
    await db.upsertPattern(`${tf}_bigsmall`, p.context, p);
  }

  /* 5. Increment rounds */
  state[tf].number.rounds++;
  state[tf].colour.rounds++;
  state[tf].bigsmall.rounds++;

  /* 6. Make server-side predictions for next period */
  for (const et of ['number', 'colour', 'bigsmall']) {
    makePrediction(tf, et, newPatterns, latestPeriod, numbers);
  }

  /* 7. Save server predictions to DB as 'server' source */
  await saveServerPredictions(tf, latestPeriod);

  /* 8. Save local (APK) prediction for the NEXT period from previous data
        NOTE: APK sends localPred that corresponds to the NEXT period.
        We save it now so that when the next result arrives, it gets resolved. */
  if (localPred && typeof localPred === 'object') {
    const nextPeriod = (BigInt(latestPeriod) + 1n).toString();

    if (localPred.number != null) {
      await db.savePredictionSource(tf, 'number', nextPeriod, 'local',
        String(localPred.number), localPred.conf || 0, localPred.method || 'apk-engine');
    }
    if (localPred.size != null) {
      await db.savePredictionSource(tf, 'size', nextPeriod, 'local',
        String(localPred.size), localPred.conf || 0, localPred.method || 'apk-engine');
    }
    if (localPred.colour != null) {
      await db.savePredictionSource(tf, 'colour', nextPeriod, 'local',
        String(localPred.colour), localPred.conf || 0, localPred.method || 'apk-engine');
    }
  }

  /* 9. Combined status */
  updateCombined(tf);

  const s = state[tf];
  console.log(`[INGEST][${tf}] ${latestPeriod.slice(-6)} num=${latestNumber} | rounds N${s.number.rounds}/C${s.colour.rounds}/B${s.bigsmall.rounds} | combined ${s.combined.status}`);

  return list.length;
}

/* ============================================================
   POST /api/ingest
============================================================ */
app.post('/api/ingest', async (req, res) => {
  try {
    const { timeframe, raw, localPred } = req.body;

    if (!timeframe || !raw) {
      console.log('[REJECTED] missing timeframe or raw');
      return res.status(400).json({ error: 'missing timeframe or raw' });
    }
    if (!['30s', '1m', '3m', '5m'].includes(timeframe)) {
      console.log('[REJECTED] invalid timeframe:', timeframe);
      return res.status(400).json({ error: 'invalid timeframe' });
    }
    const j = raw;
    if (!j || !j.data || !j.data.list) {
      console.log('[REJECTED] bad shape');
      return res.status(400).json({ error: 'bad shape: raw.data.list not found' });
    }

    const list = j.data.list.map(x => ({
      period: String(x.issueNumber),
      number: parseInt(x.number, 10)
    }))
      .filter(x => Number.isInteger(x.number) && x.number >= 0 && x.number <= 9)
      .sort((a, b) => {
        try { return BigInt(b.period) > BigInt(a.period) ? 1 : -1; }
        catch (e) { return 0; }
      });

    if (!list.length) return res.json({ ok: true, processed: 0 });

    const processed = await ingestList(timeframe, list, localPred);

    console.log(`[INGEST SUCCESS] ${timeframe} · ${list.length} periods · ${list[0].period}`);
    res.json({ ok: true, processed });
  } catch (e) {
    console.error('[INGEST ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   GET /api/combined/:timeframe
   Returns weighted combined prediction per engine
============================================================ */
app.get('/api/combined/:timeframe', async (req, res) => {
  const tf = req.params.timeframe;
  if (!['30s', '1m', '3m', '5m'].includes(tf)) {
    return res.status(400).json({ error: 'invalid timeframe' });
  }

  try {
    const result = {};

    for (const engine of ['number', 'size', 'colour']) {
      const localAcc = await db.getSourceAccuracy(tf, engine, 'local');
      const serverAcc = await db.getSourceAccuracy(tf, engine, 'server');
      const localPred = await db.getLatestPendingPrediction(tf, engine, 'local');
      const serverPred = await db.getLatestPendingPrediction(tf, engine, 'server');

      const totalAcc = (localAcc.accuracy || 0) + (serverAcc.accuracy || 0);
      let wLocal = 0.5, wServer = 0.5;
      if (totalAcc > 0) {
        wLocal = (localAcc.accuracy || 0) / totalAcc;
        wServer = (serverAcc.accuracy || 0) / totalAcc;
      }

      let combined = null;
      if (localPred && serverPred) {
        if (localPred.prediction === serverPred.prediction) {
          combined = {
            pred: localPred.prediction,
            conf: Math.min(99, Math.max(localPred.confidence || 0, serverPred.confidence || 0) + 10),
            source: 'both',
            method: 'AGREE'
          };
        } else if (wLocal >= wServer) {
          combined = {
            pred: localPred.prediction,
            conf: localPred.confidence || 0,
            source: 'local',
            method: localPred.method || 'apk'
          };
        } else {
          combined = {
            pred: serverPred.prediction,
            conf: serverPred.confidence || 0,
            source: 'server',
            method: serverPred.method || 'server'
          };
        }
      } else if (localPred) {
        combined = {
          pred: localPred.prediction,
          conf: localPred.confidence || 0,
          source: 'local',
          method: localPred.method || 'apk'
        };
      } else if (serverPred) {
        combined = {
          pred: serverPred.prediction,
          conf: serverPred.confidence || 0,
          source: 'server',
          method: serverPred.method || 'server'
        };
      }

      result[engine] = {
        combined,
        local: localPred ? {
          pred: localPred.prediction,
          conf: localPred.confidence,
          method: localPred.method,
          accuracy: Math.round((localAcc.accuracy || 0) * 10) / 10,
          wins: localAcc.wins, losses: localAcc.losses
        } : null,
        server: serverPred ? {
          pred: serverPred.prediction,
          conf: serverPred.confidence,
          method: serverPred.method,
          accuracy: Math.round((serverAcc.accuracy || 0) * 10) / 10,
          wins: serverAcc.wins, losses: serverAcc.losses
        } : null,
        weights: { local: Math.round(wLocal * 100) / 100, server: Math.round(wServer * 100) / 100 }
      };
    }

    res.json({ [tf]: result });
  } catch (e) {
    console.error('[COMBINED ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* ============================================================
   GET /api/sources/:timeframe
   Full source history + accuracies
============================================================ */
app.get('/api/sources/:timeframe', async (req, res) => {
  const tf = req.params.timeframe;
  if (!['30s', '1m', '3m', '5m'].includes(tf)) {
    return res.status(400).json({ error: 'invalid timeframe' });
  }
  try {
    const out = {};
    for (const engine of ['number', 'size', 'colour']) {
      out[engine] = {
        local: await db.getSourceHistory(tf, engine, 'local', 20),
        server: await db.getSourceHistory(tf, engine, 'server', 20),
        localAcc: await db.getSourceAccuracy(tf, engine, 'local'),
        serverAcc: await db.getSourceAccuracy(tf, engine, 'server')
      };
    }
    res.json({ [tf]: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------- Serialize engine for /api/status ---------- */
function serializeEngine(e) {
  const total = e.wins + e.losses;
  return {
    rounds: e.rounds,
    trainingProgress: Math.min(100, Math.round(e.rounds / TRAINING_ROUNDS * 100)),
    wins: e.wins,
    losses: e.losses,
    accuracy: total > 0 ? Math.round(e.wins / total * 100) : 0,
    correctCount: e.correctCount,
    currentStreak: e.currentStreak,
    status: e.rounds < TRAINING_ROUNDS ? 'TRAINING' : 'LIVE',
    lastPrediction: e.pending ? e.pending.prediction : e.lastPrediction,
    lastActual: e.lastActual,
    lastResult: e.lastResult,
    pendingPeriod: e.pending ? e.pending.period : null,
    pendingPrediction: e.pending ? e.pending.prediction : null,
    recent: e.recent.slice(0, 15)
  };
}

/* ---------- Routes ---------- */
app.get('/', (req, res) => {
  res.json({ name: 'WinGo Genius AI Server (Ensemble)', status: 'running', uptime: process.uptime() });
});

app.get('/api/status', (req, res) => {
  const result = {};
  for (const tf of ['30s', '1m', '3m', '5m']) {
    const s = state[tf];
    result[tf] = {
      number: serializeEngine(s.number),
      colour: serializeEngine(s.colour),
      bigsmall: serializeEngine(s.bigsmall),
      combined: {
        status: s.combined.status,
        jackpots: s.combined.jackpots,
        history: s.combined.history.slice(0, 20)
      },
      apiHistory: s.apiHistory.slice(0, 25),
      lastPeriod: s.lastPeriod
    };
  }
  res.json(result);
});

/* ---------- Start ---------- */
async function start() {
  console.log('[SERVER] Starting (Ensemble)...');
  await db.initDB();
  console.log('[SERVER] DB ready');
  app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });