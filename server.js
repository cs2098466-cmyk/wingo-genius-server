/* ============================================================
   WINGO GENIUS SERVER (10-Expert Ensemble Enabled)
============================================================ */

const express = require('express');
const db = require('./database');
const eng = require('./engines');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '50mb' }));

// ट्रेनिंग राउंड कम कर दिए ताकि जल्दी प्रेडिक्शन शुरू हो
const TRAINING_ROUNDS = 10; 

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

function actualFor(engineType, number) {
  if (engineType === 'number') return String(number);
  if (engineType === 'colour') return eng.colourOf(number);
  return eng.sizeOf(number);
}

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

// 🟢 नया 10-एक्सपर्ट वाला प्रेडिक्शन फंक्शन
function makePrediction(tf, latestPeriod, numbers) {
  const s = state[tf];
  if (s.number.rounds < TRAINING_ROUNDS) return;

  // हमारा नया 10-दिमाग वाला AI
  const prediction = eng.predictWithExperts(numbers);
  if (!prediction) return;

  const nextPeriod = (BigInt(latestPeriod) + 1n).toString();

  s.bigsmall.pending = { period: nextPeriod, prediction: prediction.size, confidence: prediction.confidence };
  s.number.pending = { period: nextPeriod, prediction: String(prediction.number), confidence: prediction.confidence };
  s.colour.pending = { period: nextPeriod, prediction: prediction.colour, confidence: prediction.confidence };
}

async function saveServerPredictions(tf, latestPeriod) {
  const s = state[tf];
  if (s.bigsmall.pending) {
    await db.savePredictionSource(tf, 'size', s.bigsmall.pending.period, 'server', s.bigsmall.pending.prediction, s.bigsmall.pending.confidence, '10-Experts');
  }
  if (s.number.pending) {
    await db.savePredictionSource(tf, 'number', s.number.pending.period, 'server', s.number.pending.prediction, s.number.pending.confidence, '10-Experts');
  }
  if (s.colour.pending) {
    await db.savePredictionSource(tf, 'colour', s.colour.pending.period, 'server', s.colour.pending.prediction, s.colour.pending.confidence, '10-Experts');
  }
}

async function ingestList(tf, list, localPred) {
  if (!list || !list.length) return 0;

  const latest = list[0];
  const latestPeriod = latest.period;
  const latestNumber = latest.number;

  if (state[tf].lastPeriod === latestPeriod) return 0;
  state[tf].lastPeriod = latestPeriod;

  // 1. Resolve server engines
  for (const et of ['number', 'colour', 'bigsmall']) {
    resolveEngine(tf, et, latestPeriod, latestNumber);
  }

  // 2. Resolve DB sources (local & server)
  for (const et of ['number', 'colour', 'bigsmall']) {
    const dbEngine = (et === 'bigsmall') ? 'size' : et;
    const actual = actualFor(et, latestNumber);
    await db.resolvePredictionSources(tf, dbEngine, latestPeriod, actual);
  }

  // 3. apiHistory
  state[tf].apiHistory.unshift({
    period: latestPeriod,
    number: latestNumber,
    size: eng.sizeOf(latestNumber),
    colour: eng.colourOf(latestNumber)
  });
  if (state[tf].apiHistory.length > 40) state[tf].apiHistory.pop();

  // 4. Learn Patterns (For N-Gram, though we mostly use 10-Experts now)
  const chrono = list.slice(0, 100).reverse();
  const numbers = chrono.map(x => x.number);
  const existingPatterns = await db.loadAllPatterns(`${tf}_number`);
  const newPatterns = eng.learnPatterns(`${tf}`, numbers, existingPatterns);

  for (const p of newPatterns) {
    await db.upsertPattern(`${tf}_number`, p.context, p);
    await db.upsertPattern(`${tf}_colour`, p.context, p);
    await db.upsertPattern(`${tf}_bigsmall`, p.context, p);
  }

  // 5. Increase rounds
  state[tf].number.rounds++;
  state[tf].colour.rounds++;
  state[tf].bigsmall.rounds++;

  // 6. Make server-side predictions
  makePrediction(tf, latestPeriod, numbers);

  // 7. Save server predictions
  await saveServerPredictions(tf, latestPeriod);

  // 8. Save APK (Local) prediction
  // हम इसे 'local' सोर्स के रूप में सेव करेंगे ताकि APK और Server की हिस्ट्री अलग रहे
  if (localPred && typeof localPred === 'object') {
    const nextPeriod = (BigInt(latestPeriod) + 1n).toString();

    if (localPred.number != null) {
      await db.savePredictionSource(tf, 'number', nextPeriod, 'local', String(localPred.number), localPred.conf || 0, 'APK');
    }
    if (localPred.size != null) {
      await db.savePredictionSource(tf, 'size', nextPeriod, 'local', String(localPred.size), localPred.conf || 0, 'APK');
    }
    if (localPred.colour != null) {
      await db.savePredictionSource(tf, 'colour', nextPeriod, 'local', String(localPred.colour), localPred.conf || 0, 'APK');
    }
  }

  return list.length;
}

app.post('/api/ingest', async (req, res) => {
  try {
    const { timeframe, raw, localPred } = req.body;
    if (!timeframe || !raw) return res.status(400).json({ error: 'missing timeframe or raw' });
    
    const j = raw;
    if (!j || !j.data || !j.data.list) return res.status(400).json({ error: 'bad shape' });

    const list = j.data.list.map(x => ({
      period: String(x.issueNumber),
      number: parseInt(x.number, 10)
    }))
      .filter(x => Number.isInteger(x.number) && x.number >= 0 && x.number <= 9)
      .sort((a, b) => {
        try { return BigInt(b.period) > BigInt(a.period) ? 1 : -1; } catch (e) { return 0; }
      });

    if (!list.length) return res.json({ ok: true, processed: 0 });

    const processed = await ingestList(timeframe, list, localPred);
    console.log(`[INGEST] ${timeframe} · ${list[0].period} · APK & Server saved separately.`);
    res.json({ ok: true, processed });
  } catch (e) {
    console.error('[INGEST ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// APK और सर्वर की हिस्ट्री अलग दिखाने के लिए API
app.get('/api/combined/:timeframe', async (req, res) => {
  const tf = req.params.timeframe;
  try {
    const result = {};
    for (const engine of ['number', 'size', 'colour']) {
      const localAcc = await db.getSourceAccuracy(tf, engine, 'local');
      const serverAcc = await db.getSourceAccuracy(tf, engine, 'server');
      const localPred = await db.getLatestPendingPrediction(tf, engine, 'local');
      const serverPred = await db.getLatestPendingPrediction(tf, engine, 'server');

      // जोड़कर (Combined) प्रेडिक्शन
      let combined = null;
      if (localPred && serverPred) {
        if (localPred.prediction === serverPred.prediction) {
          combined = { pred: localPred.prediction, conf: Math.min(99, (localPred.confidence || 0) + 10), source: 'both' };
        } else if ((localAcc.accuracy || 0) >= (serverAcc.accuracy || 0)) {
          combined = { pred: localPred.prediction, conf: localPred.confidence || 0, source: 'local' };
        } else {
          combined = { pred: serverPred.prediction, conf: serverPred.confidence || 0, source: 'server' };
        }
      } else if (localPred) {
        combined = { pred: localPred.prediction, conf: localPred.confidence || 0, source: 'local' };
      } else if (serverPred) {
        combined = { pred: serverPred.prediction, conf: serverPred.confidence || 0, source: 'server' };
      }

      result[engine] = { combined, local: localPred, server: serverPred };
    }
    res.json({ [tf]: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// अलग-अलग हिस्ट्री देखने के लिए API
app.get('/api/sources/:timeframe', async (req, res) => {
  const tf = req.params.timeframe;
  try {
    const out = {};
    for (const engine of ['number', 'size', 'colour']) {
      out[engine] = {
        local: await db.getSourceHistory(tf, engine, 'local', 20),
        server: await db.getSourceHistory(tf, engine, 'server', 20),
      };
    }
    res.json({ [tf]: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/status', (req, res) => {
  const result = {};
  for (const tf of ['30s', '1m', '3m', '5m']) {
    const s = state[tf];
    result[tf] = {
      number: s.number,
      colour: s.colour,
      bigsmall: s.bigsmall,
      combined: s.combined,
      apiHistory: s.apiHistory.slice(0, 25),
      lastPeriod: s.lastPeriod
    };
  }
  res.json(result);
});

async function start() {
  console.log('[SERVER] Starting (10-Expert Ensemble)...');
  await db.initDB();
  app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });