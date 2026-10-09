/* ============================================================
   WINGO GENIUS SERVER
   ScraperAPI + Training Phase + Two Timeframes
============================================================ */

const express = require('express');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const db = require('./database');
const eng = require('./engines');

const app = express();
const PORT = process.env.PORT || 3000;

/* CORS */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const SCRAPERAPI_KEY = process.env.SCRAPERAPI_KEY || '48a41579427a541a33283973894cef24';

const API_30S = 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';
const API_1M = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json';

const TRAINING_ROUNDS = 100;
const COMBINED_ACTIVE = 50;
const COMBINED_FULL = 100;

/* ---------- Engine state ---------- */
function blankEngine() {
  return {
    rounds: 0,
    wins: 0,
    losses: 0,
    correctCount: 0,
    currentStreak: 0,
    status: 'TRAINING',
    pending: null,
    lastPrediction: null,
    lastActual: null,
    lastResult: null,
    recent: []
  };
}

const state = {
  '30s': {
    number: blankEngine(),
    colour: blankEngine(),
    bigsmall: blankEngine(),
    combined: { status: 'WAITING', jackpots: 0, pendingCombined: null, history: [] },
    lastPeriod: null,
    apiHistory: []
  },
  '1m': {
    number: blankEngine(),
    colour: blankEngine(),
    bigsmall: blankEngine(),
    combined: { status: 'WAITING', jackpots: 0, pendingCombined: null, history: [] },
    lastPeriod: null,
    apiHistory: []
  }
};

/* ---------- Fetch via ScraperAPI ---------- */
async function fetchAPI(apiUrl) {
  const targetUrl = apiUrl + '?ts=' + Date.now();
  const scraperUrl = 'https://api.scraperapi.com/?api_key=' + SCRAPERAPI_KEY + '&url=' + encodeURIComponent(targetUrl);
  try {
    const r = await fetch(scraperUrl, { method: 'GET', cache: 'no-store' });
    if (r.status !== 200) throw new Error('ScraperAPI HTTP ' + r.status);
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error('bad JSON'); }
    if (!j || !j.data || !j.data.list) throw new Error('wrong shape');
    const list = j.data.list.map(x => ({
      period: String(x.issueNumber),
      number: parseInt(x.number, 10)
    })).filter(x => Number.isInteger(x.number) && x.number >= 0 && x.number <= 9)
      .sort((a, b) => BigInt(b.period) > BigInt(a.period) ? 1 : -1);
    console.log(`[API] OK · ${list.length} periods`);
    return list;
  } catch (e) {
    console.error('[API ERROR]', e.message);
    return [];
  }
}

/* ---------- Resolve a pending prediction ---------- */
function resolveEngine(tf, engineType, latestPeriod, latestNumber) {
  const e = state[tf][engineType];
  if (!e.pending) return;
  if (e.pending.period !== latestPeriod) return;

  const pred = e.pending.prediction;
  let actual = null;
  if (engineType === 'number') actual = String(latestNumber);
  else if (engineType === 'colour') actual = eng.colourOf(latestNumber);
  else actual = eng.sizeOf(latestNumber);

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

  e.recent.unshift({
    period: latestPeriod,
    prediction: pred,
    actual: actual,
    status: win ? 'WIN' : 'LOSS'
  });
  if (e.recent.length > 30) e.recent.pop();

  e.pending = null;
}

/* ---------- Make prediction for next period ---------- */
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
    e.pending = { period: nextPeriod, prediction: pred.prediction };
  }
}

/* ---------- Update combined status ---------- */
function updateCombined(tf) {
  const s = state[tf];
  const n = s.number.correctCount;
  const c = s.colour.correctCount;
  const b = s.bigsmall.correctCount;

  if (n >= COMBINED_FULL && c >= COMBINED_FULL && b >= COMBINED_FULL) {
    s.combined.status = 'FULL';
  } else if (n >= COMBINED_ACTIVE && c >= COMBINED_ACTIVE && b >= COMBINED_ACTIVE) {
    s.combined.status = 'ACTIVE';
  } else {
    s.combined.status = 'WAITING';
  }
}

/* ---------- Record combined prediction ---------- */
function makeCombinedPrediction(tf, latestPeriod) {
  const s = state[tf];
  if (s.combined.status === 'WAITING') return;
  const n = s.number.pending;
  const c = s.colour.pending;
  const b = s.bigsmall.pending;
  const nextP = (BigInt(latestPeriod) + 1n).toString();
  if (n && c && b && n.period === nextP && c.period === nextP && b.period === nextP) {
    s.combined.pendingCombined = {
      period: nextP,
      number: n.prediction,
      colour: c.prediction,
      bigsmall: b.prediction
    };
  }
}

function resolveCombined(tf, latestPeriod, latestNumber) {
  const s = state[tf];
  const pc = s.combined.pendingCombined;
  if (!pc || pc.period !== latestPeriod) return;
  const actualNum = String(latestNumber);
  const actualCol = eng.colourOf(latestNumber);
  const actualSize = eng.sizeOf(latestNumber);
  const win = pc.number === actualNum && pc.colour === actualCol && pc.bigsmall === actualSize;

  s.combined.history.unshift({
    period: latestPeriod,
    predicted: `${pc.number} · ${pc.colour} · ${pc.bigsmall}`,
    actual: `${actualNum} · ${actualCol} · ${actualSize}`,
    status: win ? 'JACKPOT' : 'MISS'
  });
  if (s.combined.history.length > 30) s.combined.history.pop();
  if (win) s.combined.jackpots++;
  s.combined.pendingCombined = null;
}

/* ---------- Process one timeframe ---------- */
async function processTimeframe(tf) {
  const apiUrl = tf === '30s' ? API_30S : API_1M;
  const list = await fetchAPI(apiUrl);
  if (!list.length) return;

  const latest = list[0];
  const latestPeriod = latest.period;
  const latestNumber = latest.number;

  if (state[tf].lastPeriod === latestPeriod) return;
  state[tf].lastPeriod = latestPeriod;

  /* 1. Resolve previous predictions */
  for (const et of ['number', 'colour', 'bigsmall']) {
    resolveEngine(tf, et, latestPeriod, latestNumber);
  }
  resolveCombined(tf, latestPeriod, latestNumber);

  /* 2. Add to apiHistory */
  state[tf].apiHistory.unshift({
    period: latestPeriod,
    number: latestNumber,
    size: eng.sizeOf(latestNumber),
    colour: eng.colourOf(latestNumber)
  });
  if (state[tf].apiHistory.length > 40) state[tf].apiHistory.pop();

  /* 3. Learn patterns */
  const chrono = list.slice(0, 100).reverse();
  const numbers = chrono.map(x => x.number);

  const existingPatterns = await db.loadAllPatterns(`${tf}_number`);
  const newPatterns = eng.learnPatterns(`${tf}`, numbers, existingPatterns);
  for (const p of newPatterns) {
    await db.upsertPattern(`${tf}_number`, p.context, p);
    await db.upsertPattern(`${tf}_colour`, p.context, p);
    await db.upsertPattern(`${tf}_bigsmall`, p.context, p);
  }

  /* 4. Increment rounds */
  state[tf].number.rounds++;
  state[tf].colour.rounds++;
  state[tf].bigsmall.rounds++;

  /* 5. Make predictions */
  for (const et of ['number', 'colour', 'bigsmall']) {
    makePrediction(tf, et, newPatterns, latestPeriod, numbers);
  }

  /* 6. Update combined */
  updateCombined(tf);
  makeCombinedPrediction(tf, latestPeriod);

  const s = state[tf];
  console.log(`[${tf}] ${latestPeriod.slice(-6)} num=${latestNumber} | rounds N${s.number.rounds}/C${s.colour.rounds}/B${s.bigsmall.rounds} | status ${s.number.status}/${s.colour.status}/${s.bigsmall.status} | combined ${s.combined.status}`);
}

async function loop30S() { try { await processTimeframe('30s'); } catch (e) { console.error('[30s]', e.message); } }
async function loop1M()  { try { await processTimeframe('1m');  } catch (e) { console.error('[1m]', e.message); } }

/* ---------- Serialize for API ---------- */
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
    status: e.rounds < TRAINING_ROUNDS ? 'TRAINING' : (e.correctCount > 0 || total > 0 ? 'LIVE' : 'READY'),
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
  res.json({ name: 'WinGo Genius AI Server', status: 'running', uptime: process.uptime() });
});

app.get('/api/status', (req, res) => {
  const result = {};
  for (const tf of ['30s', '1m']) {
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
  console.log('[SERVER] Starting...');
  await db.initDB();
  console.log('[SERVER] DB ready');

  await loop30S();
  setInterval(loop30S, 30 * 1000);
  console.log('[SERVER] 30S loop started');

  await loop1M();
  setInterval(loop1M, 60 * 1000);
  console.log('[SERVER] 1M loop started');

  app.listen(PORT, () => console.log(`[SERVER] Listening on port ${PORT}`));
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });