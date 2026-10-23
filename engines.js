/* ============================================================
   ENGINES — Server ka 10-Expert Deep Brain
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
   N-Gram Pattern Discovery (Database ke liye)
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
   🔥 10-EXPERT VOTING ALGORITHM (Server ka naya dimaag)
   Input: Pichle 20-30 numbers ki array
   Output: Best prediction (BIG/SMALL), Number, Colour, Confidence
============================================================ */
function predictWithExperts(numbers) {
  if (numbers.length < 5) return null;

  const history = numbers.map(sizeOf); // ['BIG', 'SMALL', 'BIG'...]
  const len = history.length;
  const last = history[len-1];

  let votes = { BIG: 0, SMALL: 0 };

  // 1. Trend Expert
  let streak = 1;
  for(let i = len-1; i > 0; i--) { if(history[i] === history[i-1]) streak++; else break; }
  let trendVote = (streak >= 2) ? last : (last === 'BIG' ? 'SMALL' : 'BIG');
  votes[trendVote]++;

  // 2. Reverse Expert
  let reverseVote = (streak >= 2) ? (last === 'BIG' ? 'SMALL' : 'BIG') : last;
  votes[reverseVote]++;

  // 3. Alternate Expert
  let altVote = (last === 'BIG') ? 'SMALL' : 'BIG';
  votes[altVote]++;

  // 4. Markov Expert
  let b_to_s = 0, s_to_b = 0;
  for (let i = Math.max(0, len - 15); i < len - 1; i++) {
    if (history[i] === 'BIG' && history[i+1] === 'SMALL') b_to_s++;
    if (history[i] === 'SMALL' && history[i+1] === 'BIG') s_to_b++;
  }
  let markovVote = (last === 'BIG') ? (b_to_s > 2 ? 'SMALL' : 'BIG') : (s_to_b > 2 ? 'BIG' : 'SMALL');
  votes[markovVote]++;

  // 5. Momentum Expert
  let recentB = 0, recentS = 0;
  for(let i = Math.max(0, len-10); i < len; i++) { if(history[i] === 'BIG') recentB++; else recentS++; }
  let momentumVote = (recentB > recentS) ? 'BIG' : 'SMALL';
  votes[momentumVote]++;

  // 6. Block Expert
  let blockVote = last;
  if (len >= 4 && history[len-1] === history[len-2] && history[len-2] !== history[len-3]) blockVote = (last === 'BIG') ? 'SMALL' : 'BIG';
  else if (len >= 6 && history[len-1] === history[len-2] && history[len-2] === history[len-3]) blockVote = (last === 'BIG') ? 'SMALL' : 'BIG';
  votes[blockVote]++;

  // 7. Fibonacci Expert
  let fib = [1, 1, 2, 3, 5, 8];
  let fibVote = history[fib[fib.length - 1] % len] || last;
  votes[fibVote]++;

  // 8. Parity Expert (Even/Odd based on actual numbers)
  let evens = numbers.slice(-5).filter(n => n % 2 === 0).length;
  let parityVote = (evens >= 3) ? 'SMALL' : 'BIG'; // Simple proxy
  votes[parityVote]++;

  // 9. Hot Expert
  let bCount = history.slice(-15).filter(x => x === 'BIG').length;
  let sCount = history.slice(-15).filter(x => x === 'SMALL').length;
  votes[bCount > sCount ? 'BIG' : 'SMALL']++;

  // 10. Cold Expert
  votes[bCount < sCount ? 'BIG' : 'SMALL']++;

  // --- Calculate Final Decision ---
  let finalPrediction = (votes.BIG > votes.SMALL) ? 'BIG' : 'SMALL';
  let winningVotes = Math.max(votes.BIG, votes.SMALL);
  let confidence = Math.round((winningVotes / 10) * 100);

  // --- Predict Number & Color based on Final Size ---
  let predictedNum = 0;
  let numFreq = {};
  
  if (finalPrediction === 'BIG') {
    for(let i=5; i<=9; i++) numFreq[i] = 0;
    numbers.slice(-15).forEach(n => { if(n >= 5) numFreq[n]++; });
  } else {
    for(let i=0; i<=4; i++) numFreq[i] = 0;
    numbers.slice(-15).forEach(n => { if(n < 5) numFreq[n]++; });
  }

  // Find max frequency number in that bracket
  let maxNum = finalPrediction === 'BIG' ? 7 : 2;
  let maxCount = -1;
  for(let n in numFreq) {
    if (numFreq[n] > maxCount) { maxCount = numFreq[n]; maxNum = parseInt(n); }
    else if (numFreq[n] === maxCount) {
       // Tie breaker: Choose the one that appeared most recently
       let lastIdx1 = numbers.lastIndexOf(parseInt(n));
       let lastIdx2 = numbers.lastIndexOf(maxNum);
       if (lastIdx1 > lastIdx2) maxNum = parseInt(n);
    }
  }
  predictedNum = maxNum;

  return {
    size: finalPrediction,
    number: predictedNum,
    colour: colourOf(predictedNum),
    confidence: confidence
  };
}

/* ============================================================
   Update pattern weights based on actual result
============================================================ */
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
  sizeOf,
  colourOf,
  makeContext,
  learnPatterns,
  updatePatternWeights,
  predictWithExperts // <-- Yahan naya expert system add ho gaya
};