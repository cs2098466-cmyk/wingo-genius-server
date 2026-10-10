/* ============================================================
   ENGINES — हर engine का pattern logic
   (Updated: No strict thresholds, always predicts best guess)
============================================================ */

/* size निकालो */
function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

/* colour निकालो */
function colourOf(n) {
  if (n === 0 || n === 5) return 'VIOLET';
  if ([1, 3, 7, 9].includes(n)) return 'GREEN';
  return 'RED';
}

/* context बनाओ — पिछले 3 sizes */
function makeContext(history) {
  if (history.length < 1) return '';
  const last = history.slice(-3);
  return last.map(x => sizeOf(x)).join('');
}

/* ============================================================
   Pattern discovery
============================================================ */
function learnPatterns(engine, numbers, existingPatterns) {
  const patternMap = {};
  existingPatterns.forEach(p => {
    patternMap[p.context] = {
      context: p.context,
      big_count: p.big_count || 0,
      small_count: p.small_count || 0,
      red_count: p.red_count || 0,
      green_count: p.green_count || 0,
      violet_count: p.violet_count || 0,
      numbers: p.numbers || {},
      weight: p.weight || 100,
      hits: p.hits || 0,
      misses: p.misses || 0,
      sleeping: p.sleeping || false,
      last_seen: p.last_seen || 0,
      created_at: p.created_at || Date.now()
    };
  });

  const sizes = numbers.map(sizeOf);
  for (let i = 1; i < numbers.length; i++) {
    for (let L = 1; L <= 3; L++) {
      if (i - L < 0) continue;
      const ctx = sizes.slice(i - L, i).join('');
      const actualNum = numbers[i];
      const actualSize = sizeOf(actualNum);
      const actualColour = colourOf(actualNum);

      if (!patternMap[ctx]) {
        patternMap[ctx] = {
          context: ctx,
          big_count: 0, small_count: 0,
          red_count: 0, green_count: 0, violet_count: 0,
          numbers: {},
          weight: 100, hits: 0, misses: 0,
          sleeping: false, last_seen: 0,
          created_at: Date.now()
        };
      }
      const p = patternMap[ctx];
      if (actualSize === 'BIG') p.big_count++;
      else p.small_count++;

      if (actualColour === 'RED') p.red_count++;
      else if (actualColour === 'GREEN') p.green_count++;
      else p.violet_count++;

      p.numbers[actualNum] = (p.numbers[actualNum] || 0) + 1;
      p.last_seen = Date.now();
    }
  }

  return Object.values(patternMap);
}

/* ============================================================
   Prediction (Ab hamesha best guess dega)
============================================================ */
function predictSize(currentContext, patterns) {
  const p = patterns.find(x => x.context === currentContext);
  if (!p || p.sleeping) return null;
  const total = p.big_count + p.small_count;
  if (total < 3) return null;

  if (p.big_count >= p.small_count) {
    return { prediction: 'BIG', confidence: Math.round((p.big_count / total) * 100) };
  } else {
    return { prediction: 'SMALL', confidence: Math.round((p.small_count / total) * 100) };
  }
}

function predictColour(currentContext, patterns) {
  const p = patterns.find(x => x.context === currentContext);
  if (!p || p.sleeping) return null;
  const total = p.red_count + p.green_count + p.violet_count;
  if (total < 3) return null;

  if (p.red_count >= p.green_count && p.red_count >= p.violet_count) {
    return { prediction: 'RED', confidence: Math.round((p.red_count / total) * 100) };
  } else if (p.green_count >= p.red_count && p.green_count >= p.violet_count) {
    return { prediction: 'GREEN', confidence: Math.round((p.green_count / total) * 100) };
  } else {
    return { prediction: 'VIOLET', confidence: Math.round((p.violet_count / total) * 100) };
  }
}

function predictNumber(currentContext, patterns) {
  const p = patterns.find(x => x.context === currentContext);
  if (!p || p.sleeping) return null;
  const total = Object.values(p.numbers).reduce((a, b) => a + b, 0);
  if (total < 3) return null;

  let bestNum = null, bestCount = 0;
  for (const [num, count] of Object.entries(p.numbers)) {
    if (count > bestCount) { bestCount = count; bestNum = parseInt(num); }
  }
  // 40% ki shart hata di hai
  const pct = bestCount / total;
  return { prediction: String(bestNum), confidence: Math.round(pct * 100) };
}

/* ============================================================
   Update pattern weights based on actual result
============================================================ */
function updatePatternWeights(patterns, context, actualNum) {
  const actualSize = sizeOf(actualNum);
  const actualColour = colourOf(actualNum);
  patterns.forEach(p => {
    if (p.context !== context) return;
    const total = p.big_count + p.small_count;
    if (total === 0) return;

    let predictedSize = p.big_count > p.small_count ? 'BIG' : 'SMALL';

    if (predictedSize === actualSize) {
      p.hits = (p.hits || 0) + 1;
      p.weight = Math.min(400, (p.weight || 100) + 15);
    } else {
      p.misses = (p.misses || 0) + 1;
      p.weight = Math.max(10, (p.weight || 100) - 8);
    }

    const tot = p.hits + p.misses;
    if (tot >= 20) {
      const acc = p.hits / tot;
      if (acc < 0.10) p.sleeping = true;
      else if (acc >= 0.55) p.sleeping = false;
    }
  });
  return patterns;
}

module.exports = {
  sizeOf,
  colourOf,
  makeContext,
  learnPatterns,
  predictSize,
  predictColour,
  predictNumber,
  updatePatternWeights
};