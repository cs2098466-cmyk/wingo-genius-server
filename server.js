/* ============================================================
   WINGO GENIUS SERVER — TLS Fingerprint Bypass
   curl-cffi-node के साथ Chrome impersonation
============================================================ */

const express = require('express');
const { Curl } = require('curl-cffi-node');
const db = require('./database');
const eng = require('./engines');

const app = express();
const PORT = process.env.PORT || 3000;

const API_30S = 'https://draw.ar-lottery01.com/WinGo/WinGo_30S/GetHistoryIssuePage.json';
const API_1M = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json';

const state = {
  '30s': { number: { patterns: [], history: [], status: null }, colour: { patterns: [], history: [], status: null }, bigsmall: { patterns: [], history: [], status: null }, lastPeriod: null, combined: false, combinedPrev: null },
  '1m':  { number: { patterns: [], history: [], status: null }, colour: { patterns: [], history: [], status: null }, bigsmall: { patterns: [], history: [], status: null }, lastPeriod: null, combined: false, combinedPrev: null }
};

/* ============================================================
   Fetch API — curl-cffi-node के साथ Chrome impersonation
============================================================ */
async function fetchAPI(apiUrl) {
  const targetUrl = apiUrl + '?ts=' + Date.now();

  try {
    const curl = new Curl();
    // Chrome 120 का पूरा TLS/HTTP2 fingerprint impersonate करें
    curl.impersonateStr('chrome120');
    curl.setoptStr(2, targetUrl);       // CurlOpt.Url
    curl.setoptLong(52, 1);             // FollowLocation
    curl.setoptLong(13, 10);            // MaxRedirs
    curl.setoptLong(155, 30000);        // TimeoutMs

    const result = await curl.performAsync();

    if (result.statusCode !== 200) {
      throw new Error('HTTP ' + result.statusCode);
    }

    const text = result.body.toString();
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

/* ============================================================
   Process one timeframe
============================================================ */
async function processTimeframe(tf) {
  const apiUrl = tf === '30s' ? API_30S : API_1M;
  const list = await fetchAPI(apiUrl);
  if (!list.length) return;

  const latest = list[0];
  const latestPeriod = latest.period;
  const latestNumber = latest.number;
  if (state[tf].lastPeriod === latestPeriod) return;

  const chrono = list.slice(0, 100).reverse();
  const numbers = chrono.map(x => x.number);
  state[tf].number.history = numbers;

  for (const engineType of ['number', 'colour', 'bigsmall']) {
    const engineKey = `${tf}_${engineType}`;
    const lastPred = state[tf][engineType].status;
    if (lastPred && lastPred.period === latestPeriod) {
      const actualSize = eng.sizeOf(latestNumber);
      const actualColour = eng.colourOf(latestNumber);
      const actualNumber = String(latestNumber);
      let win = engineType === 'number' ? (lastPred.prediction === actualNumber) : engineType === 'colour' ? (lastPred.prediction === actualColour) : (lastPred.prediction === actualSize);

      const oldStatus = await db.getEngineStatus(engineKey) || { streak: 0, wins: 0, losses: 0, rounds: 0 };
      const newStreak = win ? (oldStatus.streak || 0) + 1 : 0;
      const newWins = win ? (oldStatus.wins || 0) + 1 : oldStatus.wins || 0;
      const newLosses = win ? oldStatus.losses || 0 : (oldStatus.losses || 0) + 1;
      const newRounds = (oldStatus.rounds || 0) + 1;

      await db.updateEngineStatus(engineKey, { streak: newStreak, wins: newWins, losses: newLosses, rounds: newRounds, last_prediction: lastPred.prediction, last_confidence: lastPred.confidence, last_period: lastPred.period });
      await db.resolvePrediction(engineKey, lastPred.period, engineType === 'number' ? actualNumber : engineType === 'colour' ? actualColour : actualSize);
      console.log(`[${engineKey}] ${win ? 'WIN' : 'LOSS'} · streak=${newStreak}`);
    }
  }

  const existingPatterns = await db.loadAllPatterns(`${tf}_number`);
  const newPatterns = eng.learnPatterns(`${tf}`, numbers, existingPatterns);
  for (const p of newPatterns) {
    await db.upsertPattern(`${tf}_number`, p.context, p);
    await db.upsertPattern(`${tf}_colour`, p.context, p);
    await db.upsertPattern(`${tf}_bigsmall`, p.context, p);
  }
  state[tf].number.patterns = newPatterns;
  state[tf].colour.patterns = newPatterns;
  state[tf].bigsmall.patterns = newPatterns;

  const nextPeriod = (BigInt(latestPeriod) + 1n).toString();
  const context = eng.makeContext(numbers);

  const nPred = eng.predictNumber(context, newPatterns);
  if (nPred) { state[tf].number.status = { period: nextPeriod, ...nPred }; await db.savePrediction(`${tf}_number`, nextPeriod, nPred.prediction, nPred.confidence); }
  const cPred = eng.predictColour(context, newPatterns);
  if (cPred) { state[tf].colour.status = { period: nextPeriod, ...cPred }; await db.savePrediction(`${tf}_colour`, nextPeriod, cPred.prediction, cPred.confidence); }
  const bPred = eng.predictSize(context, newPatterns);
  if (bPred) { state[tf].bigsmall.status = { period: nextPeriod, ...bPred }; await db.savePrediction(`${tf}_bigsmall`, nextPeriod, bPred.prediction, bPred.confidence); }

  const s1 = await db.getEngineStatus(`${tf}_number`) || { streak: 0 };
  const s2 = await db.getEngineStatus(`${tf}_colour`) || { streak: 0 };
  const s3 = await db.getEngineStatus(`${tf}_bigsmall`) || { streak: 0 };
  const allAt100 = (s1.streak >= 100) && (s2.streak >= 100) && (s3.streak >= 100);

  const prevCombined = state[tf].combined;
  state[tf].combined = allAt100;
  await db.updateCombinedState(tf, allAt100);
  if (allAt100 && !prevCombined) console.log(`[${tf}] COMBINED ACTIVE`);
  else if (!allAt100 && prevCombined) console.log(`[${tf}] COMBINED OFF`);

  if (allAt100 && state[tf].combinedPrev && state[tf].combinedPrev.period === latestPeriod) {
    const actualSize = eng.sizeOf(latestNumber);
    const actualColour = eng.colourOf(latestNumber);
    const actualNum = String(latestNumber);
    if (state[tf].combinedPrev.bigsmall === actualSize && state[tf].combinedPrev.colour === actualColour && state[tf].combinedPrev.number === actualNum) {
      await db.incrementJackpot(tf);
      await db.saveJackpot(tf, latestPeriod, state[tf].combinedPrev.bigsmall, state[tf].combinedPrev.colour, state[tf].combinedPrev.number, latestNumber);
      console.log(`[${tf}] JACKPOT! period=${latestPeriod}`);
    }
  }

  if (allAt100) {
    state[tf].combinedPrev = { period: nextPeriod, bigsmall: bPred ? bPred.prediction : null, colour: cPred ? cPred.prediction : null, number: nPred ? nPred.prediction : null };
  }

  state[tf].lastPeriod = latestPeriod;
  console.log(`[${tf}] period=${latestPeriod} num=${latestNumber} ctx=${context} | num=${nPred ? nPred.prediction : '-'} col=${cPred ? cPred.prediction : '-'} bs=${bPred ? bPred.prediction : '-'} | combined=${allAt100}`);
}

async function mainLoop() {
  try { await processTimeframe('30s'); } catch (e) { console.error('[30s ERROR]', e.message); }
  try { await processTimeframe('1m'); } catch (e) { console.error('[1m ERROR]', e.message); }
}

app.get('/', (req, res) => { res.json({ name: 'WinGo Genius AI Server', status: 'running', uptime: process.uptime(), time: new Date().toISOString() }); });

app.get('/api/status', async (req, res) => {
  try {
    const result = {};
    for (const tf of ['30s', '1m']) {
      result[tf] = {};
      for (const et of ['number', 'colour', 'bigsmall']) {
        const key = `${tf}_${et}`;
        const status = await db.getEngineStatus(key) || {};
        const recentPreds = await db.getRecentPredictions(key, 20);
        result[tf][et] = { streak: status.streak || 0, wins: status.wins || 0, losses: status.losses || 0, rounds: status.rounds || 0, accuracy: (status.wins + status.losses) > 0 ? Math.round(status.wins / (status.wins + status.losses) * 100) : 0, last_prediction: status.last_prediction, last_confidence: status.last_confidence, last_period: status.last_period, recent: recentPreds.map(p => ({ period: p.period, prediction: p.prediction, actual: p.actual, status: p.status, confidence: p.confidence })) };
      }
      const cs = await db.getCombinedState(tf) || {};
      result[tf].combined = { active: cs.active || false, jackpots: cs.jackpot_count || 0, recentJackpots: (await db.getRecentJackpots(tf, 10)).map(j => ({ period: j.period, number: j.actual_number, bigsmall: j.bigsmall_pred, colour: j.colour_pred, number_pred: j.number_pred })) };
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function start() {
  console.log('[SERVER] Starting...');
  await db.initDB();
  console.log('[SERVER] DB ready');
  await mainLoop();
  setInterval(mainLoop, 30 * 1000);
  app.listen(PORT, () => { console.log(`[SERVER] Listening on port ${PORT}`); });
}

start().catch(e => { console.error('[FATAL]', e); process.exit(1); });