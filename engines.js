/* ============================================================
   ENGINES — Server ka 10-Expert Deep Brain
============================================================ */

function sizeOf(n) { return n >= 5 ? 'BIG' : 'SMALL'; }

function colourOf(n) {
  if (n === 0 || n === 5) return 'VIOLET';
  if ([1, 3, 7, 9].includes(n)) return 'GREEN';
  return 'RED';
}

function makeContext(history) {
  if (history.length < 1) return '';
  const last = history.slice(-3);
  return last.map(x => sizeOf(x)).join('');
}

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
          numbers: {}, weight: 100, hits: 0, misses: 0,
          sleeping: false, last_seen: 0, created_at: Date.now()
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

function predictWithExperts(numbers) {
  if (numbers.length < 5) return null;

  const history = numbers.map(sizeOf);
  const len = history.length;
  const last = history[len-1];

  let votes = { BIG: 0, SMALL: 0 };

  // 1. Trend
  let streak = 1;
  for(let i = len-1; i > 0; i--) { if(history[i] === history[i-1]) streak++; else break; }
  votes[(streak >= 2) ? last : (last === 'BIG' ? 'SMALL' : 'BIG')]++;

  // 2. Reverse
  votes[(streak >= 2) ? (last === 'BIG' ? 'SMALL' : 'BIG') : last]++;

  // 3. Alternate
  votes[(last === 'BIG') ? 'SMALL' : 'BIG']++;

  // 4. Markov
  let b_to_s = 0, s_to_b = 0;
  for (let i = Math.max(0, len - 15); i < len - 1; i++) {
    if (history[i] === 'BIG' && history[i+1] === 'SMALL') b_to_s++;
    if (history[i] === 'SMALL' && history[i+1] === 'BIG') s_to_b++;
  }
  votes[(last === 'BIG') ? (b_to_s > 2 ? 'SMALL' : 'BIG') : (s_to_b > 2 ? 'BIG' : 'SMALL')]++;

  // 5. Momentum
  let recentB = history.slice(-10).filter(x => x === 'BIG').length;
  let recentS = history.slice(-10).filter(x => x === 'SMALL').length;
  votes[(recentB > recentS) ? 'BIG' : 'SMALL']++;

  // 6. Block
  let blockVote = last;
  if (len >= 4 && history[len-1] === history[len-2] && history[len-2] !== history[len-3]) blockVote = (last === 'BIG') ? 'SMALL' : 'BIG';
  else if (len >= 6 && history[len-1] === history[len-2] && history[len-2] === history[len-3]) blockVote = (last === 'BIG') ? 'SMALL' : 'BIG';
  votes[blockVote]++;

  // 7. Fibonacci
  let fib = [1, 1, 2, 3, 5, 8];
  votes[history[fib[fib.length - 1] % len] || last]++;

  // 8. Parity (Even/Odd)
  let evens = numbers.slice(-5).filter(n => n % 2 === 0).length;
  votes[(evens >= 3) ? 'SMALL' : 'BIG']++;

  // 9. Hot
  let bCount = history.slice(-15).filter(x => x === 'BIG').length;
  let sCount = history.slice(-15).filter(x => x === 'SMALL').length;
  votes[bCount > sCount ? 'BIG' : 'SMALL']++;

  // 10. Cold
  votes[bCount < sCount ? 'BIG' : 'SMALL']++;

  let finalPrediction = (votes.BIG > votes.SMALL) ? 'BIG' : 'SMALL';
  let confidence = Math.round((Math.max(votes.BIG, votes.SMALL) / 10) * 100);

  // Number & Color
  let predictedNum = 0;
  let numFreq = {};
  if (finalPrediction === 'BIG') {
    for(let i=5; i<=9; i++) numFreq[i] = 0;
    numbers.slice(-15).forEach(n => { if(n >= 5) numFreq[n]++; });
  } else {
    for(let i=0; i<=4; i++) numFreq[i] = 0;
    numbers.slice(-15).forEach(n => { if(n < 5) numFreq[n]++; });
  }

  let maxNum = finalPrediction === 'BIG' ? 7 : 2;
  let maxCount = -1;
  for(let n in numFreq) {
    if (numFreq[n] > maxCount) { maxCount = numFreq[n]; maxNum = parseInt(n); }
    else if (numFreq[n] === maxCount) {
       if (numbers.lastIndexOf(parseInt(n)) > numbers.lastIndexOf(maxNum)) maxNum = parseInt(n);
    }
  }
  predictedNum = maxNum;

  return { size: finalPrediction, number: predictedNum, colour: colourOf(predictedNum), confidence: confidence };
}

function updatePatternWeights(patterns, context, actualNum) {
  const actualSize = sizeOf(actualNum);
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
  });
  return patterns;
}

module.exports = {
  sizeOf, colourOf, makeContext, learnPatterns, updatePatternWeights, predictWithExperts
};