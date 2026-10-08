# WinGo Genius AI Server

24/7 training server for WinGo 30S and 1M games.

## Engines

- 30s Number
- 30s Colour
- 30s Big-Small
- 1m Number
- 1m Colour
- 1m Big-Small

## Rules

- हर engine का data अलग
- 30S और 1M कभी mix नहीं होंगे
- हर engine का streak counter अलग (0-100)
- Combined तभी चालू जब तीनों के streak 100 पर हों
- Streak टूटे तो 0
- JACKPOT तब जब Combined में तीनों सही
- कोई pattern नहीं मरता

## Endpoints

- `GET /` — Server status
- `GET /api/status` — पूरा data (dashboard के लिए)

## Deploy on Render

1. GitHub पर repo बनाओ
2. यह 5 files upload करो
3. Render.com पर account बनाओ
4. New Web Service
5. GitHub repo चुनो
6. Build command: `npm install`
7. Start command: `npm start`
8. PostgreSQL database बनाओ
9. `DATABASE_URL` environment variable में डालो
10. Deploy
