# ⚽ Football Score Table

A **cricket-scorecard-style** viewer for football matches across **every league**
Sofascore covers. Pick a competition, pick a match, and see **every player's full
stats in one table** — no more clicking Sofascore player-by-player.

Both teams are shown as separate tables (like an innings each), players go
row-by-row, and all their metrics are columns: rating, goals, assists, shots,
xG/xA, passing, tackles, and goalkeeper stats (saves, goals prevented, etc.).

## Data source

Stats come from **Sofascore**. Their API is behind Cloudflare bot protection, so
the server keeps one warm headless-Chromium page parked on sofascore.com and runs
every request from inside that page (which passes the challenge). No API key needed.

## Run it with Docker (easiest)

The image is published on Docker Hub — no source code, no npm install, no
Chromium setup. Everything is baked in:

```bash
docker run -p 8080:8080 --shm-size=1gb --init malkiamasha/football-score-table
```

Then open **http://localhost:8080**.

`--shm-size=1gb` matters: Chromium crashes on Docker's default 64MB `/dev/shm`.

## Run it from source

```bash
npm install
npx playwright install chromium   # one-time, downloads the browser
npm start
cloudflared tunnel --url http://localhost:8080
node check-ip.js
```

Then open **http://localhost:8080**.

- The list shows the most recent finished matches across **all leagues**, newest first.
- Use the **League** dropdown to narrow to one competition (Champions League,
  Premier League, Brasileirão, MLS, …), and **Show latest** to change how many.
- Click a match to load its scorecard.
- Click any column header to sort that team's players by it.

## API

| Endpoint | What it returns |
| --- | --- |
| `GET /api/recent?count=8` | Most recent finished matches from every league |
| `GET /api/recent?count=8&league=7` | Same, limited to one unique-tournament id |
| `GET /api/recent?...&all=1` | Also include leagues without per-player stats |
| `GET /api/leagues` | Competitions playing over the last 3 days (powers the picker) |
| `GET /api/matches?date=YYYY-MM-DD` | All matches on a date, grouped by competition |
| `GET /api/scorecard?id=<eventId>` | Full per-player scorecard for one match |

## Notes

- Player stats appear once a match **kicks off**; upcoming matches show lineups
  only when Sofascore publishes them.
- Some minor competitions don't provide per-player stats (flagged internally as
  `hasStats: false`) — those matches will show the header but no stat table.
- First request after startup waits a few seconds while the browser warms up.

## If Sofascore returns 403

Sofascore's edge blocks some networks outright: every request — API, homepage,
headless **and** real Chrome — comes back `403 Forbidden` from `Server: Varnish`,
so the Cloudflare-bypass page never gets a session and the match list shows
"No finished matches found". That is a network-level block, not a bug; the fix is
to run from a different network, VPN, or proxy. The server prints a warning at
startup when it detects this.

A system-wide VPN needs no configuration. To send just this app's traffic through
a proxy instead, set `SOFA_PROXY` before starting:

```powershell
$env:SOFA_PROXY = 'http://user:pass@host:port'
npm start
```

Public relay services (allorigins, r.jina.ai, codetabs) do **not** work as a
substitute — Sofascore blocks their datacenter addresses too. It has to be a
residential or mobile address.

`server.espn.js` is a standalone fallback backend built on ESPN's public API
(no key, no bot challenge) — `node server.espn.js`. It serves the same routes,
but ESPN publishes no player ratings and no passing/tackle/interception counts,
so the scorecard columns in `public/index.html` need matching edits to show its
stat set (Shots, Offside, Fouls, Conceded in place of Rating, Key Pass, Pass,
Tackle Won, Intercept Won).

## Files

- `server.js` — Express backend + Playwright Sofascore proxy.
- `server.espn.js` — fallback backend using ESPN's public API.
- `public/index.html` — the whole frontend (self-contained).
- `_probe.js` — browser smoke test: loads the page, prints what rendered,
  screenshots it (`SHOT=path node _probe.js`).
