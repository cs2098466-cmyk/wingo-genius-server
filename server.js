async function fetchAPI(apiUrl) {
  const targetUrl = apiUrl + '?ts=' + Date.now();

  try {
    const r = await fetch(targetUrl, {
      method: 'GET',
      cache: 'no-store',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
        'Referer': 'https://draw.ar-lottery01.com/'
      }
    });

    if (!r.ok) throw new Error('HTTP ' + r.status);

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