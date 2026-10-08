export default async function handler(req, res) {
  /* CORS headers */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const target = req.query.url;

  if (!target) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8',
        'Referer': 'https://draw.ar-lottery01.com/'
      }
    });

    const body = await response.text();

    res.setHeader('Content-Type', 'application/json');
    res.status(response.status).send(body);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
