/* ============================================================
   WINGO GENIUS SERVER (10-Expert Ensemble + Render Optimized)
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

app.use(express.json({ limit: '10mb' })); // RAM बचाने के लिए लिमिट कम की

const TRAINING_ROUNDS = 10; // जल्दी ट्रेनिंग खत्म होने के लिए

function blankEngine() {
  return { rounds: 0, wins: 0, losses: 0, correctCount: 0, currentStreak: 0, status: 'TRAINING', pending: null, lastPrediction: null, lastActual: null, lastResult: null, recent: [] };
}

function createTimeframeState() {
  return { number: blankEngine(), colour: blankEngine(), bigsmall: blankEngine(), combined: { status: 'WAITING', jackpots: 0, history: [] }, lastPeriod: null, apiHistory: [] };
}

const state = { '30s': createTimeframeState(), '1m': createTimeframeState(), '3m': createTimeframeState(), '5m': createTimeframeState() };

function actualFor(engineType, number) {
  if (engineType === 'number') return String(number);
  if (engineType === 'colour') return eng.colourOf(number);
  return eng.sizeOf(number);
}

function resolveEngine(tf, engineType, latestPeriod, latestNumber) {
  const e = state[tf][engineType];
  if (!e.pending || e.pending.period !== latestPeriod) return;

  const actual = actualFor(engineType, latestNumber);
  const win = (e.pending.prediction === actual);

  e.lastPrediction = e.pending.prediction;
  e.lastActual = actual;
  e.lastResult = win ? 'WIN' : 'LOSS';
  if (win) { e.wins++; e.correctCount++; e.currentStreak = e.currentStreak > 0 ? e.currentStreak + 1 : 1; }
  else { e.losses++; e.currentStreak = e.currentStreak < 0 ? e.currentStreak - 1 : -1; }
  
  e.recent.unshift({ period: latestPeriod, prediction: e.pending.prediction, actual, status: win ? 'WIN' : 'LOSS' });
  if (e.recent.length > 20) e.recent.pop();
  e.pending = null;
}

function makePrediction(tf, latestPeriod, numbers) {
  const s = state[tf];
  if (s.number.rounds < TRAINING_ROUNDS) return;

  const prediction = eng.predictWithExperts(numbers);
  if (!prediction) return;

  const nextPeriod = (BigInt(latestPeriod) + 1n).toString();
  s.bigsmall.pending = { period: nextPeriod, prediction: prediction.size, confidence: prediction.confidence };
  s.number.pending = { period: nextPeriod, prediction: String(prediction.number), confidence: prediction.confidence };
  s.colour.pending = { period: nextPeriod, prediction: prediction.colour, confidence: prediction.confidence };
}

async function saveServerPredictions(tf) {
  const s = state[tf];
  if (s.bigsmall.pending) await db.savePredictionSource(tf, 'size', s.bigsmall.pending.period, 'server', s.bigsmall.pending.prediction, s.bigsmall.pending.confidence, '10-Experts');
  if (s.number.pending) await db.savePredictionSource(tf, 'number', s.number.pending.period, 'server', s.number.pending.prediction, s.number.pending.confidence, '10-Experts');
  if (s.colour.pending) await db.savePredictionSource(tf, 'colour', s.colour.pending.period, 'server', s.colour.pending.prediction, s.colour.pending.confidence, '10-Experts');
}

async function ingestList(tf, list, localPred) {
  if (!list || !list.length) return 0;
  const latest = list[0];
  const latestPeriod = latest.period;
  const latestNumber = latest.number;

  if (state[tf].lastPeriod === latestPeriod) return 0;
  state[tf].lastPeriod = latestPeriod;

  for (const et of ['number', 'colour', 'bigsmall']) resolveEngine(tf, et, latestPeriod, latestNumber);

  for (const et of ['number', 'colour', 'bigsmall']) {
    const dbEngine = (et === 'bigsmall') ? 'size' : et;
    const actual = actualFor(et, latestNumber);
    await db.resolvePredictionSources(tf, dbEngine, latestPeriod, actual);
  }

  state[tf].apiHistory.unshift({ period: latestPeriod, number: latestNumber, size: eng.sizeOf(latestNumber), colour: eng.colourOf(latestNumber) });
  if (state[tf].apiHistory.length > 30) state[tf].apiHistory.pop();

  const chrono = list.slice(0, 50).reverse();
  const numbers = chrono.map(x => x.number);
  
  // केवल ज़रूरी पैटर्न्स ही लर्न करें ताकि डेटाबेस न भरे
  const existingPatterns = await db.loadAllPatterns(`${tf}_number`);
  const newPatterns = eng.learnPatterns(`${tf}`, numbers, existingPatterns);
  for (const p of newPatterns) {
    if (p.big_count + p.small_count >= 3) { // सिर्फ 3 बार से ज्यादा आए पैटर्न्स सेव करें
      await db.upsertPattern(`${tf}_number`, p.context, p);
      await db.upsertPattern(`${tf}_colour`, p.context, p);
      await db.upsertPattern(`${tf}_bigsmall`, p.context, p);
    }
  }

  state[tf].number.rounds++;
  state[tf].colour.rounds++;
  state[tf].bigsmall.rounds++;

  makePrediction(tf, latestPeriod, numbers);
  await saveServerPredictions(tf);

  if (localPred && typeof localPred === 'object') {
    const nextPeriod = (BigInt(latestPeriod) + 1n).toString();
    if (localPred.number != null) await db.savePredictionSource(tf, 'number', nextPeriod, 'local', String(localPred.number), localPred.conf || 0, 'APK');
    if (localPred.size != null) await db.savePredictionSource(tf, 'size', nextPeriod, 'local', String(localPred.size), localPred.conf || 0, 'APK');
    if (localPred.colour != null) await db.savePredictionSource(tf, 'colour', nextPeriod, 'local', String(localPred.colour), localPred.conf || 0, 'APK');
  }

  return list.length;
}

app.post('/api/ingest', async (req, res) => {
  try {
    const { timeframe, raw, localPred } = req.body;
    if (!timeframe || !raw || !raw.data || !raw.data.list) return res.status(400).json({ error: 'Bad Request' });

    const list = raw.data.list.map(x => ({ period: String(x.issueNumber), number: parseInt(x.number, 10) }))
      .filter(x => Number.isInteger(x.number) && x.number >= 0 && x.number <= 9)
      .sort((a, b) => { try { return BigInt(b.period) > BigInt(a.period) ? 1 : -1; } catch (e) { return 0; } });

    if (!list.length) return res.json({ ok: true, processed: 0 });
    const processed = await ingestList(timeframe, list, localPred);
    res.json({ ok: true, processed });
  } catch (e) {
    console.error('[INGEST ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/combined/:timeframe', async (req, res) => {
  const tf = req.params.timeframe;
  try {
    const result = {};
    for (const engine of ['number', 'size', 'colour']) {
      const localAcc = await db.getSourceAccuracy(tf, engine, 'local');
      const serverAcc = await db.getSourceAccuracy(tf, engine, 'server');
      const localPred = await db.getLatestPendingPrediction(tf, engine, 'local');
      const serverPred = await db.getLatestPendingPrediction(tf, engine, 'server');

      let combined = null;
      if (localPred && serverPred) {
        if (localPred.prediction === serverPred.prediction) combined = { pred: localPred.prediction, conf: Math.min(99, (localPred.confidence || 0) + 10), source: 'both' };
        else if ((localAcc.accuracy || 0) >= (serverAcc.accuracy || 0)) combined = { pred: localPred.prediction, conf: localPred.confidence || 0, source: 'local' };
        else combined = { pred: serverPred.prediction, conf: serverPred.confidence || 0, source: 'server' };
      } else if (localPred) combined = { pred: localPred.prediction, conf: localPred.confidence || 0, source: 'local' };
      else if (serverPred) combined = { pred: serverPred.prediction, conf: serverPred.confidence || 0, source: 'server' };

      result[engine] = { combined, local: localPred, server: serverPred };
    }
    res.json({ [tf]: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/sources/:timeframe', async (req, res) => {
  const tf = req.params.timeframe;
  try {
    const out = {};
    for (const engine of ['number', 'size', 'colour']) {
      out[engine] = { local: await db.getSourceHistory(tf, engine, 'local', 20), server: await db.getSourceHistory(tf, engine, 'server', 20) };
    }
    res.json({ [tf]: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/status', (req, res) => {
  const result = {};
  for (const tf of ['30s', '1m', '3m', '5m']) {
    const s = state[tf];
    result[tf] = { number: s.number, colour: s.colour, bigsmall: s.bigsmall, combined: s.combined, apiHistory: s.apiHistory.slice(0, 25), lastPeriod: s.lastPeriod };
  }
  res.json(result);
});

// 🟢 ऑटोमेटिक डेटाबेस क्लीनअप (हर 12 घंटे में) 🟢
setInterval(async () => {
  try {
    await db.cleanOldData(7); // 7 दिन से पुराना डेटा डिलीट कर देगा
  } catch(e) { console.log("Cleanup error:", e.message); }
}, 12 * 60 * 60 * 1000);

async function start() {
  console.log('[SERVER] Starting (10-Expert Ensemble)...');
  await db.initDB();
  app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });