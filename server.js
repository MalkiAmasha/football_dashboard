/**
 * Football Score Table — cricket-style scorecard viewer for football matches.
 *
 * Sofascore sits behind Cloudflare bot protection, so plain HTTP requests get
 * 403. We keep one warm headless-Chromium page parked on sofascore.com and run
 * every API fetch from inside that page context (page.evaluate), which passes
 * the challenge and is allowed to call api.sofascore.com by CORS.
 */
const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const PORT = process.env.PORT || 8080;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Sofascore's edge blocks whole IP ranges outright — datacenter ranges and, at
 * times, consumer ones — answering every request with a bare 403 instead of a
 * Cloudflare challenge. When that happens nothing here can help; the request
 * has to leave from a different address. Set SOFA_PROXY to route the browser
 * through one:
 *
 *   SOFA_PROXY=http://host:port                     (PowerShell: $env:SOFA_PROXY='…')
 *   SOFA_PROXY=http://user:pass@host:port
 *
 * A system-wide VPN needs nothing set — the traffic already leaves elsewhere.
 */
function proxyConfig() {
  const raw = process.env.SOFA_PROXY;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const cfg = { server: `${u.protocol}//${u.host}` };
    if (u.username) cfg.username = decodeURIComponent(u.username);
    if (u.password) cfg.password = decodeURIComponent(u.password);
    return cfg;
  } catch (e) {
    console.log(`  Ignoring unparseable SOFA_PROXY (${raw}):`, e.message);
    return undefined;
  }
}

let browser = null;
let page = null;
let initPromise = null;

async function initBrowser() {
  if (page && !page.isClosed()) return;
  // Tear down any previous browser first. Without this, every rebuild after a
  // network failure leaks a live Chromium, and enough of them exhaust the
  // machine until launch() itself starts failing with "spawn UNKNOWN".
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
  const proxy = proxyConfig();
  if (proxy) console.log(`  Routing Sofascore traffic through proxy ${proxy.server}`);
  browser = await chromium.launch({ headless: true, proxy });
  const ctx = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  page = await ctx.newPage();
  // Block heavy resources we never need; keep the page light and fast.
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    route.continue();
  });
  const resp = await page.goto('https://www.sofascore.com/', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  // A 403 on the homepage itself means the IP is blocked, not that a challenge
  // needs solving — say so plainly instead of failing silently later.
  if (resp && resp.status() === 403) {
    console.log(
      '  Sofascore returned 403 on the homepage — this IP is blocked at their edge.\n' +
        '  Every request will come back empty. Run behind a VPN, or set SOFA_PROXY\n' +
        '  to a proxy on an unblocked address.'
    );
  }
  await page.waitForTimeout(2500);
}

function ensureBrowser() {
  if (!initPromise) initPromise = initBrowser().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

/** Fetch a JSON API url from inside the warm page. Retries once through a
 *  re-navigation if Cloudflare blocks us. */
async function sofaFetch(url) {
  await ensureBrowser();
  const run = () =>
    // Race the in-page fetch against a 20s timeout so a dropped network
    // fails fast instead of hanging the HTTP request forever.
    Promise.race([
      page.evaluate(async (u) => {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 18000);
        try {
          const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: c.signal });
          const text = await r.text();
          let json = null;
          try { json = JSON.parse(text); } catch (e) {}
          return { status: r.status, json };
        } finally { clearTimeout(t); }
      }, url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('sofaFetch timeout')), 20000)),
    ]);

  let res;
  try {
    res = await run();
  } catch (e) {
    // Page died — rebuild and retry once.
    initPromise = null;
    page = null;
    await ensureBrowser();
    res = await run();
  }
  if (res.status === 403) {
    // Challenge came back; re-warm and retry once.
    await page.goto('https://www.sofascore.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    res = await run();
  }
  return res;
}

const API = 'https://api.sofascore.com/api/v1';

/** Fetch many JSON urls from inside the warm page, `limit` at a time so we
 *  never open 150 sockets at once when scanning every league on a date. */
async function sofaFetchMany(urls, limit = 20) {
  await ensureBrowser();
  return page.evaluate(async ({ urls, limit }) => {
    const out = new Array(urls.length).fill(null);
    let next = 0;
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= urls.length) return;
        try {
          const r = await fetch(urls[i], { headers: { Accept: 'application/json' } });
          out[i] = r.status === 200 ? await r.json() : null;
        } catch (e) {
          out[i] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
    return out;
  }, { urls, limit });
}

/** Every football competition that has matches on a date. */
async function listTournamentsForDate(date, maxPages = 8) {
  const utids = [];
  const seen = new Set();
  for (let pg = 1; pg <= maxPages; pg++) {
    const r = await sofaFetch(`${API}/sport/football/scheduled-tournaments/${date}/page/${pg}`);
    if (r.status !== 200 || !r.json || !Array.isArray(r.json.scheduled)) break;
    for (const s of r.json.scheduled) {
      const ut = s.tournament && s.tournament.uniqueTournament;
      if (ut && !seen.has(ut.id)) {
        seen.add(ut.id);
        utids.push({
          id: ut.id,
          name: ut.name,
          category: (ut.category && ut.category.name) || '',
          userCount: ut.userCount || 0,
          hasStats: !!ut.hasEventPlayerStatistics,
        });
      }
    }
    if (!r.json.hasNextPage) break;
  }
  return utids;
}

const app = express();

// When a real client last asked for data. The background refresher uses this to
// go quiet while nobody is watching, instead of polling Sofascore forever.
let lastClientHit = Date.now();
app.use('/api', (req, res, next) => {
  lastClientHit = Date.now();
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/** List all football matches for a date, grouped by competition. */
app.get('/api/matches', async (req, res) => {
  const date = req.query.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  }
  try {
    // 1) Every competition that has matches on this date (paginated).
    const utids = await listTournamentsForDate(date);

    // 2) Fetch each competition's events for the date, batched inside the page.
    const jsons = await sofaFetchMany(
      utids.map((u) => `${API}/unique-tournament/${u.id}/scheduled-events/${date}`)
    );
    const evResp = utids.map((u, i) => ({ id: u.id, events: (jsons[i] && jsons[i].events) || [] }));

    const metaById = Object.fromEntries(utids.map((u) => [u.id, u]));
    const groups = [];
    for (const { id, events } of evResp) {
      if (!events.length) continue;
      const meta = metaById[id] || { name: 'Football', category: '', userCount: 0, hasStats: false };
      groups.push({
        tournamentId: id,
        tournament: (events[0].tournament && events[0].tournament.name) || meta.name,
        category: meta.category,
        userCount: meta.userCount,
        hasStats: meta.hasStats,
        matches: events.map((e) => ({
          id: e.id,
          home: e.homeTeam && e.homeTeam.name,
          away: e.awayTeam && e.awayTeam.name,
          homeScore: e.homeScore ? e.homeScore.current : null,
          awayScore: e.awayScore ? e.awayScore.current : null,
          status: e.status ? e.status.type : 'notstarted', // finished | inprogress | notstarted
          statusText: e.status ? e.status.description : '',
          startTimestamp: e.startTimestamp,
        })),
      });
    }
    // Most-followed competitions first (userCount), then by name.
    groups.sort((a, b) => b.userCount - a.userCount || a.tournament.localeCompare(b.tournament));
    res.json({ date, groups });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Finished matches for one date across every competition playing that day.
 *  `opts.statsOnly` keeps only competitions that carry per-player statistics
 *  (the ones a scorecard can actually be built from). */
async function getFinishedForDay(date, opts = {}) {
  let utids = await listTournamentsForDate(date);
  if (opts.statsOnly) utids = utids.filter((u) => u.hasStats);
  if (!utids.length) return [];

  const jsons = await sofaFetchMany(
    utids.map((u) => `${API}/unique-tournament/${u.id}/scheduled-events/${date}`)
  );

  const out = [];
  utids.forEach((u, i) => {
    const events = (jsons[i] && jsons[i].events) || [];
    for (const e of events) {
      if (!e.status || e.status.type !== 'finished') continue;
      out.push({
        id: e.id,
        tournamentId: u.id,
        tournament: (e.tournament && e.tournament.name) || u.name,
        category: u.category,
        userCount: u.userCount,
        hasStats: u.hasStats,
        home: e.homeTeam && e.homeTeam.name,
        away: e.awayTeam && e.awayTeam.name,
        homeScore: e.homeScore ? e.homeScore.current : null,
        awayScore: e.awayScore ? e.awayScore.current : null,
        startTimestamp: e.startTimestamp,
        statusText: (e.status && e.status.description) || 'FT',
      });
    }
  });
  return out;
}

function lastNDates(n) {
  const out = [];
  const base = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(base);
    d.setDate(base.getDate() - i);
    out.push(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    );
  }
  return out;
}

// Caches, kept warm by a background refresher.
const recentCache = new Map(); // cacheKey -> { at, data }
const recentInFlight = new Map(); // cacheKey -> Promise
const leaguesCache = new Map(); // date -> { at, data }
const scorecardCache = new Map(); // id -> { at, data }
const scorecardInFlight = new Map(); // id -> Promise

/** Recent finished matches for one specific competition, walking its season's
 *  already-played ("last") pages back from the newest. */
async function recentForLeague(leagueId, count, statsOnly) {
  const seasons = await sofaFetch(`${API}/unique-tournament/${leagueId}/seasons`);
  const seasonId =
    seasons.json && seasons.json.seasons && seasons.json.seasons[0] && seasons.json.seasons[0].id;
  if (!seasonId) return [];

  const events = [];
  for (const pg of [0, 1, 2]) {
    const r = await sofaFetch(`${API}/unique-tournament/${leagueId}/season/${seasonId}/events/last/${pg}`);
    if (!r.json || !Array.isArray(r.json.events) || !r.json.events.length) break;
    events.push(...r.json.events);
    if (events.filter((e) => e.status && e.status.type === 'finished').length >= count) break;
    if (r.json.hasNextPage === false) break;
  }

  return events
    .filter((e) => e.status && e.status.type === 'finished')
    .map((e) => ({
      id: e.id,
      tournamentId: leagueId,
      tournament: (e.tournament && e.tournament.name) || '',
      category: (e.tournament && e.tournament.category && e.tournament.category.name) || '',
      userCount: 0,
      hasStats: true,
      home: e.homeTeam && e.homeTeam.name,
      away: e.awayTeam && e.awayTeam.name,
      homeScore: e.homeScore ? e.homeScore.current : null,
      awayScore: e.awayScore ? e.awayScore.current : null,
      startTimestamp: e.startTimestamp,
      statusText: (e.status && e.status.description) || 'FT',
    }));
}

/**
 * The most recent finished matches across ALL football competitions (or one
 * competition when `leagueId` is given). Walks backwards a day at a time and
 * stops as soon as it has enough — a single busy day usually covers it.
 */
async function computeRecent(count, opts = {}) {
  const { leagueId = null, statsOnly = true, maxDays = 10 } = opts;
  const key = recentKey(count, opts);

  let matches;
  if (leagueId) {
    matches = await recentForLeague(leagueId, count, statsOnly);
  } else {
    matches = [];
    const seen = new Set();
    for (const date of lastNDates(maxDays)) {
      const day = await getFinishedForDay(date, { statsOnly });
      for (const m of day) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        matches.push(m);
      }
      if (matches.length >= count) break;
    }
  }

  matches = matches
    .sort(
      (a, b) =>
        (b.startTimestamp || 0) - (a.startTimestamp || 0) ||
        (b.userCount || 0) - (a.userCount || 0)
    )
    .slice(0, count);

  const data = { matches };
  recentCache.set(key, { at: Date.now(), data });
  return data;
}

function recentKey(count, opts = {}) {
  return `${count}|${opts.leagueId || 'all'}|${opts.statsOnly === false ? 'any' : 'stats'}`;
}

/** The N most recently finished football matches (default 3), any league.
 *  `league=<uniqueTournamentId>` narrows to one competition;
 *  `all=1` also includes competitions without per-player stats. */
app.get('/api/recent', async (req, res) => {
  const count = Math.min(50, Math.max(1, parseInt(req.query.count, 10) || 3));
  const leagueId = /^\d+$/.test(req.query.league || '') ? Number(req.query.league) : null;
  const opts = { leagueId, statsOnly: req.query.all !== '1' };
  const key = recentKey(count, opts);
  try {
    const cached = recentCache.get(key);
    if (cached && Date.now() - cached.at < 120000) return res.json(cached.data);
    // Coalesce concurrent cold requests for the same view into one fetch.
    let inflight = recentInFlight.get(key);
    if (!inflight) {
      inflight = computeRecent(count, opts).finally(() => recentInFlight.delete(key));
      recentInFlight.set(key, inflight);
    }
    res.json(await inflight);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/**
 * Competitions that should always be selectable, even on days they aren't
 * playing — the picker is otherwise built from whatever ran in the last three
 * days, so cup competitions with long gaps between rounds keep vanishing from
 * it. Ids are Sofascore uniqueTournament ids, the number in a tournament URL:
 * .../tournament/saudi-arabia/kings-cup/2058 -> 2058
 */
const PINNED_LEAGUES = [
  { id: 955, name: 'Saudi Pro League', category: 'Saudi Arabia', userCount: 188329, hasStats: true },
  { id: 2058, name: "King's Cup", category: 'Saudi Arabia', userCount: 0, hasStats: true },
];

/** Every competition with matches on a date (default today) — powers the
 *  league picker. `all=1` includes competitions without per-player stats. */
app.get('/api/leagues', async (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : lastNDates(1)[0];
  const withoutStats = req.query.all === '1';
  try {
    const cached = leaguesCache.get(date);
    let leagues = cached && Date.now() - cached.at < 600000 ? cached.data : null;
    if (!leagues) {
      // Merge a few days so weekly competitions aren't missing from the picker.
      const seen = new Map();
      for (const d of lastNDates(3)) {
        for (const u of await listTournamentsForDate(d)) if (!seen.has(u.id)) seen.set(u.id, u);
      }
      // Pinned competitions stay in the list whether or not they played this
      // week. Keep discovery's live metadata when it found them, but trust the
      // pin over its hasStats flag: Sofascore reports hasEventPlayerStatistics
      // false for some cups (King's Cup among them) that do publish full
      // per-player stats, and the picker filters on that flag.
      for (const p of PINNED_LEAGUES) {
        const found = seen.get(p.id);
        seen.set(p.id, found ? { ...found, hasStats: true } : p);
      }
      leagues = [...seen.values()].sort(
        (a, b) => b.userCount - a.userCount || a.name.localeCompare(b.name)
      );
      leaguesCache.set(date, { at: Date.now(), data: leagues });
    }
    res.json({ date, leagues: withoutStats ? leagues : leagues.filter((l) => l.hasStats) });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Full per-player scorecard for one match. */
app.get('/api/scorecard', async (req, res) => {
  const id = req.query.id;
  if (!/^\d+$/.test(id || '')) return res.status(400).json({ error: 'numeric id required' });
  try {
    const cached = scorecardCache.get(id);
    // Serve fresh cache instantly — repeat loads no longer re-scrape Sofascore.
    if (cached && Date.now() - cached.at < 120000) return res.json(cached.data);
    // Coalesce concurrent requests for the same match into one fetch.
    let inflight = scorecardInFlight.get(id);
    if (!inflight) {
      inflight = computeScorecard(id).finally(() => scorecardInFlight.delete(id));
      scorecardInFlight.set(id, inflight);
    }
    if (cached) {
      // Stale-while-revalidate: serve the stale copy and let the refresh run in
      // the background. It must own its failure — an unhandled rejection here
      // would take the whole process down.
      inflight.catch((err) =>
        console.log(`  Background scorecard refresh failed (${id}):`, err.message)
      );
      return res.json(cached.data);
    }
    const data = await inflight;
    if (data && data.notFound) return res.status(404).json({ error: 'match not found' });
    return res.json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** Fetch + assemble one match's scorecard, cached for 120s. */
async function computeScorecard(id) {
    const [ev, lu, inc] = await Promise.all([
      sofaFetch(`${API}/event/${id}`),
      sofaFetch(`${API}/event/${id}/lineups`),
      sofaFetch(`${API}/event/${id}/incidents`),
    ]);
    if (!ev.json || !ev.json.event) return { notFound: true };
    const e = ev.json.event;
    const header = {
      id: e.id,
      tournament: e.tournament && e.tournament.name,
      season: e.season && e.season.name,
      round: e.roundInfo && e.roundInfo.name,
      status: e.status ? e.status.type : 'notstarted',
      statusText: e.status ? e.status.description : '',
      startTimestamp: e.startTimestamp,
      home: e.homeTeam && e.homeTeam.name,
      away: e.awayTeam && e.awayTeam.name,
      homeScore: e.homeScore ? e.homeScore.current : null,
      awayScore: e.awayScore ? e.awayScore.current : null,
    };

    const hasLineups = lu.json && lu.json.home && Array.isArray(lu.json.home.players);

    // Build per-player event tallies (cards, own goals, penalties) from the
    // incidents feed — these aren't in the per-player statistics object.
    const incMap = {}; // playerId -> {yellow,red,ownGoal,penMissed,penSaved}
    const bump = (pid, key) => {
      if (pid == null) return;
      (incMap[pid] = incMap[pid] || { yellow: 0, red: 0, ownGoal: 0, penMissed: 0, penSaved: 0 })[key]++;
    };
    // Goalkeeper (most minutes) per side, for penalty-saved / clean-sheet credit.
    const gkId = (players) => {
      let best = null, bestMin = -1;
      for (const pl of players || []) {
        const pos = pl.position || (pl.player && pl.player.position);
        if (pos === 'G') {
          const m = (pl.statistics && pl.statistics.minutesPlayed) || 0;
          if (m > bestMin) { bestMin = m; best = pl.player && pl.player.id; }
        }
      }
      return best;
    };
    const homeGk = hasLineups ? gkId(lu.json.home.players) : null;
    const awayGk = hasLineups ? gkId(lu.json.away.players) : null;
    const incidents = (inc.json && inc.json.incidents) || [];
    for (const i of incidents) {
      const pid = i.player && i.player.id;
      if (i.incidentType === 'card') {
        if (i.incidentClass === 'yellow') bump(pid, 'yellow');
        else bump(pid, 'red'); // red or yellowRed (second yellow)
      } else if (i.incidentType === 'goal' && i.incidentClass === 'ownGoal') {
        bump(pid, 'ownGoal');
      } else if (i.incidentType === 'inGamePenalty' && i.incidentClass !== 'scored') {
        bump(pid, 'penMissed');
        bump(i.isHome ? awayGk : homeGk, 'penSaved'); // opposing keeper
      }
    }

    const teams = hasLineups
      ? {
          home: mapTeam(lu.json.home, header.home, incMap, header.awayScore === 0),
          away: mapTeam(lu.json.away, header.away, incMap, header.homeScore === 0),
        }
      : null;

    const data = { header, teams, lineupsAvailable: hasLineups };
    scorecardCache.set(id, { at: Date.now(), data });
    return data;
}

function mapTeam(side, name, incMap, teamCleanSheet) {
  return {
    name,
    formation: side.formation || null,
    players: (side.players || []).map((p) => {
      const st = p.statistics || {};
      const pl = p.player || {};
      const position = p.position || pl.position; // G D M F
      const played = st.minutesPlayed != null || Object.keys(st).length > 0;
      const ev = (incMap && incMap[pl.id]) || { yellow: 0, red: 0, ownGoal: 0, penMissed: 0, penSaved: 0 };
      return {
        name: pl.name,
        shortName: pl.shortName,
        shirt: p.shirtNumber != null ? p.shirtNumber : pl.jerseyNumber,
        position,
        substitute: !!p.substitute,
        captain: !!p.captain,
        avgRating: p.avgRating != null ? Number(p.avgRating) : null,
        played,
        stats: st,
        events: ev,
        // Clean sheet credited to a goalkeeper who played when the team conceded 0.
        cleanSheet: !!(teamCleanSheet && position === 'G' && played),
      };
    }),
  };
}

// Last-resort net: Sofascore/Playwright can fail in ways we do not anticipate,
// and a long-running server must not die on one stray background rejection.
process.on('unhandledRejection', (err) => {
  console.log('  Unhandled rejection (ignored):', (err && err.message) || err);
});

app.listen(PORT, () => {
  console.log(`\n  Football Score Table running:  http://localhost:${PORT}\n`);
  // Warm the browser, then pre-fetch the recent matches so the first page
  // load is instant, and keep them fresh in the background.
  ensureBrowser().then(
    async () => {
      console.log('  Browser ready (Cloudflare bypass warm).');

      // Background refresh, deliberately restrained. A metronomic every-60s poll
      // that retries hard through an outage is exactly the traffic shape that
      // gets an IP blocked at Sofascore's edge, so this one:
      //   - sleeps entirely while no client has asked for data recently
      //   - backs off exponentially on failure instead of hammering
      //   - jitters each delay so it never looks like a timer
      const BASE_MS = 120000; // 2 min when someone is actually watching
      const MAX_MS = 1800000; // 30 min ceiling once things are failing
      const IDLE_AFTER_MS = 300000; // no client in 5 min => stop refreshing
      let failures = 0;

      const jitter = (ms) => Math.round(ms * (0.8 + Math.random() * 0.4));

      const tick = async () => {
        const idle = Date.now() - lastClientHit > IDLE_AFTER_MS;
        if (!idle) {
          try {
            const d = await computeRecent(3, { leagueId: null, statsOnly: true });
            failures = 0;
            console.log(`  Recent matches ready (${d.matches.length} cached).`);
          } catch (e) {
            failures++;
            console.log(`  Recent warm-up failed (${failures}):`, e.message);
          }
        }
        // Back off on failure; idle checks just re-poll the clock, not Sofascore.
        const delay = failures
          ? Math.min(BASE_MS * 2 ** failures, MAX_MS)
          : idle
            ? IDLE_AFTER_MS
            : BASE_MS;
        setTimeout(tick, jitter(delay)).unref?.();
      };

      await tick();
    },
    (e) => console.log('  Browser warm-up failed:', e.message)
  );
});
