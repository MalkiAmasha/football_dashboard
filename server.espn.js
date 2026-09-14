/**
 * ESPN-backed build of the Football Score Table backend.
 *
 * Kept as a fallback: Sofascore's edge returns a flat 403 to some networks for
 * every request (browser included), and when that happens `server.js` can't
 * fetch anything. Run this one instead — `node server.espn.js` — for a version
 * that works without Sofascore. It serves the same routes but ESPN publishes no
 * player ratings and no passing/tackle/interception counts, so the scorecard
 * columns in public/index.html would need matching edits (see git history or
 * README) to display its stat set.
 */
const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 8080;
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer';

/** Competitions we scan, most-followed first (drives the picker's order). */
const LEAGUES = [
  { slug: 'eng.1', name: 'Premier League', category: 'England' },
  { slug: 'esp.1', name: 'LaLiga', category: 'Spain' },
  { slug: 'ita.1', name: 'Serie A', category: 'Italy' },
  { slug: 'ger.1', name: 'Bundesliga', category: 'Germany' },
  { slug: 'fra.1', name: 'Ligue 1', category: 'France' },
  { slug: 'uefa.champions', name: 'Champions League', category: 'Europe' },
  { slug: 'uefa.europa', name: 'Europa League', category: 'Europe' },
  { slug: 'uefa.europa.conf', name: 'Conference League', category: 'Europe' },
  { slug: 'eng.2', name: 'Championship', category: 'England' },
  { slug: 'eng.fa', name: 'FA Cup', category: 'England' },
  { slug: 'eng.league_cup', name: 'Carabao Cup', category: 'England' },
  { slug: 'esp.2', name: 'LaLiga 2', category: 'Spain' },
  { slug: 'ita.2', name: 'Serie B', category: 'Italy' },
  { slug: 'ger.2', name: '2. Bundesliga', category: 'Germany' },
  { slug: 'fra.2', name: 'Ligue 2', category: 'France' },
  { slug: 'ned.1', name: 'Eredivisie', category: 'Netherlands' },
  { slug: 'por.1', name: 'Primeira Liga', category: 'Portugal' },
  { slug: 'bel.1', name: 'Pro League', category: 'Belgium' },
  { slug: 'tur.1', name: 'Super Lig', category: 'Turkey' },
  { slug: 'sco.1', name: 'Premiership', category: 'Scotland' },
  { slug: 'aut.1', name: 'Bundesliga', category: 'Austria' },
  { slug: 'sui.1', name: 'Super League', category: 'Switzerland' },
  { slug: 'den.1', name: 'Superliga', category: 'Denmark' },
  { slug: 'nor.1', name: 'Eliteserien', category: 'Norway' },
  { slug: 'swe.1', name: 'Allsvenskan', category: 'Sweden' },
  { slug: 'usa.1', name: 'MLS', category: 'USA' },
  { slug: 'mex.1', name: 'Liga MX', category: 'Mexico' },
  { slug: 'bra.1', name: 'Brasileirão Serie A', category: 'Brazil' },
  { slug: 'arg.1', name: 'Liga Profesional', category: 'Argentina' },
  { slug: 'conmebol.libertadores', name: 'Copa Libertadores', category: 'South America' },
  { slug: 'jpn.1', name: 'J.League', category: 'Japan' },
  { slug: 'chn.1', name: 'Chinese Super League', category: 'China' },
  { slug: 'ksa.1', name: 'Saudi Pro League', category: 'Saudi Arabia' },
  { slug: 'ksa.kings.cup', name: "King's Cup", category: 'Saudi Arabia' },
  { slug: 'aus.1', name: 'A-League Men', category: 'Australia' },
  { slug: 'ind.1', name: 'Indian Super League', category: 'India' },
  { slug: 'fifa.world', name: 'World Cup', category: 'International' },
];
const LEAGUE_BY_SLUG = Object.fromEntries(LEAGUES.map((l) => [l.slug, l]));
// Rank doubles as the "popularity" sort key the client already understands.
const rankOf = (slug) => LEAGUES.length - LEAGUES.findIndex((l) => l.slug === slug);

/** GET JSON with a hard timeout and one retry — ESPN occasionally 502s. */
async function getJson(url, tries = 2) {
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, {
        signal: ctl.signal,
        headers: { Accept: 'application/json', 'User-Agent': 'football-score-table/2.0' },
      });
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      if (i === tries - 1) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Run `urls` through getJson, `limit` in flight at a time. */
async function getMany(urls, limit = 8) {
  const out = new Array(urls.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= urls.length) return;
      out[i] = await getJson(urls[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- dates
const yyyymmdd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
/** ESPN accepts an inclusive YYYYMMDD-YYYYMMDD window on /scoreboard. */
const dateRange = (backDays) => `${yyyymmdd(daysAgo(backDays))}-${yyyymmdd(daysAgo(0))}`;

// ------------------------------------------------------- event → match
/** Scoreboard record per match id. The summary endpoint's own header can lag
 *  (no score, status frozen mid-match), so we keep the scoreboard's version. */
const matchIndex = new Map();

const isFinished = (e) => !!(e.status && e.status.type && e.status.type.completed);
const epochSec = (iso) => Math.floor(new Date(iso).getTime() / 1000);

function toMatch(e, slug) {
  const comp = (e.competitions && e.competitions[0]) || {};
  const cs = comp.competitors || [];
  const home = cs.find((c) => c.homeAway === 'home') || cs[0] || {};
  const away = cs.find((c) => c.homeAway === 'away') || cs[1] || {};
  const meta = LEAGUE_BY_SLUG[slug] || { name: slug, category: '' };
  const st = e.status && e.status.type;
  const m = {
    id: String(e.id),
    tournamentId: slug,
    tournament: meta.name,
    category: meta.category,
    userCount: rankOf(slug),
    hasStats: true,
    home: home.team && (home.team.displayName || home.team.name),
    away: away.team && (away.team.displayName || away.team.name),
    homeScore: home.score != null ? Number(home.score) : null,
    awayScore: away.score != null ? Number(away.score) : null,
    startTimestamp: epochSec(e.date),
    status: st ? (st.completed ? 'finished' : st.state === 'in' ? 'inprogress' : 'notstarted') : 'notstarted',
    statusText: (st && (st.shortDetail || st.description)) || '',
  };
  matchIndex.set(m.id, m);
  return m;
}

// ------------------------------------------------------------- caches
const recentCache = new Map(); // key -> { at, data }
const recentInFlight = new Map();
const scorecardCache = new Map(); // id -> { at, data }
const scorecardInFlight = new Map();

const recentKey = (count, opts = {}) => `${count}|${opts.leagueId || 'all'}`;

/**
 * The most recent finished matches across every tracked competition (or one,
 * when `leagueId` is a league slug). Widens the date window if a short one
 * doesn't turn up enough — useful in the pre-season gaps.
 */
async function computeRecent(count, opts = {}) {
  const { leagueId = null } = opts;
  const slugs = leagueId ? [leagueId] : LEAGUES.map((l) => l.slug);

  let matches = [];
  for (const back of [7, 30, 120]) {
    const lists = await getMany(slugs.map((s) => `${ESPN}/${s}/scoreboard?dates=${dateRange(back)}`));
    const seen = new Set();
    matches = [];
    lists.forEach((j, i) => {
      for (const e of (j && j.events) || []) {
        if (!isFinished(e) || seen.has(String(e.id))) continue;
        seen.add(String(e.id));
        matches.push(toMatch(e, slugs[i]));
      }
    });
    if (matches.length >= count) break;
  }

  matches = matches
    .sort(
      (a, b) =>
        (b.startTimestamp || 0) - (a.startTimestamp || 0) || (b.userCount || 0) - (a.userCount || 0)
    )
    .slice(0, count);

  const data = { matches };
  recentCache.set(recentKey(count, opts), { at: Date.now(), data });
  return data;
}

// ------------------------------------------------------ scorecard build
/** Accent- and punctuation-insensitive key for matching commentary names to
 *  roster names ("Agustin Resch" in the text vs "Agustín Resch" on the sheet). */
const normName = (s) =>
  (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z ]/g, '')
    .trim();

/**
 * Commentary prose doesn't always spell a player the way the team sheet does
 * ("Patrick Ouotro" for Vignon Ouotro, "Beni Mukendi" for Beni), so match on
 * the full name first, then on a surname — but only where that surname is
 * unique across both squads.
 */
function makeNameResolver(rosters) {
  const alias = new Map(); // alias -> canonical roster key
  const clash = new Set();
  const add = (a, key) => {
    if (!a || a.length < 3) return;
    if (alias.has(a) && alias.get(a) !== key) clash.add(a);
    else alias.set(a, key);
  };
  for (const r of rosters) {
    for (const p of r.roster || []) {
      const ath = p.athlete || {};
      const key = normName(ath.displayName || ath.fullName);
      if (!key) continue;
      alias.set(key, key);
      add(normName(ath.fullName), key);
      add(normName(ath.shortName), key);
      const parts = key.split(' ');
      if (parts.length > 1) add(parts[parts.length - 1], key);
    }
  }
  for (const a of clash) alias.delete(a);

  return (raw) => {
    const n = normName(raw);
    if (!n) return null;
    if (alias.has(n)) return alias.get(n);
    const parts = n.split(' ');
    const last = parts[parts.length - 1];
    if (alias.has(last)) return alias.get(last);
    if (alias.has(parts[0])) return alias.get(parts[0]);
    return null;
  };
}

/** Drop trailing commentary clauses: "…replaces X because of an injury." */
const trimClause = (s) => (s || '').replace(/\s+(because|due|following|after)\s.*$/i, '').trim();

const clockMin = (ev) => {
  const t = (ev.clock && ev.clock.displayValue) || '';
  const m = t.match(/(\d+)/);
  return m ? Number(m[1]) : null;
};

/**
 * Per-player minutes, penalty misses and penalty saves, read out of the key
 * events feed — ESPN's per-player stat block carries none of them.
 * Substitution/red-card lines name players only in their prose, so we parse it.
 */
function parseKeyEvents(keyEvents, fullTime, resolve, isStarter) {
  const on = {}; // roster key -> minute came on
  const off = {}; // roster key -> minute went off (sub or red card)
  const penMissed = {};
  const penSaved = {};
  const set = (bag, raw, min) => {
    const k = resolve(raw);
    if (k) bag[k] = min;
  };
  const bump = (bag, raw) => {
    const k = resolve(raw);
    if (k) bag[k] = (bag[k] || 0) + 1;
  };

  for (const ev of keyEvents || []) {
    const text = ev.text || '';
    const type = (ev.type && ev.type.text) || '';
    const min = clockMin(ev);

    if (/substitution/i.test(type) && min != null) {
      // Two prose shapes in the wild:
      //   "Substitution, Team. A replaces B."     — both players named
      //   "A (Team) Substitution at 73'"          — one player, side unstated,
      //                                             so the team sheet says which way
      const pair = text.match(/\.\s*([^.]+?)\s+replaces\s+(.+?)\.?$/i);
      if (pair) {
        set(on, pair[1], min);
        set(off, trimClause(pair[2]), min);
        continue;
      }
      const solo = text.match(/^\s*(.+?)\s*\([^)]*\)\s*Substitution/i);
      if (solo) {
        const k = resolve(solo[1]);
        if (k) (isStarter(k) ? off : on)[k] = min;
      }
      continue;
    }
    if (/red card/i.test(type) && min != null) {
      const m = text.match(/^\s*([^(]+?)\s*\(/);
      if (m) set(off, m[1], min);
      continue;
    }
    if (/penalt/i.test(type + ' ' + text) && /miss|saved/i.test(type + ' ' + text)) {
      // "Penalty missed! ... Bruno Fernandes (Man Utd) ... saved by Alisson."
      const taker = text.match(/([A-ZÀ-Ý][^(.!]*?)\s*\(/);
      if (taker) bump(penMissed, taker[1]);
      const keeper = text.match(/saved by\s+([^.,]+)/i);
      if (keeper) bump(penSaved, keeper[1]);
    }
  }
  return { on, off, penMissed, penSaved, fullTime };
}

/** ESPN slot abbreviations (CD-L, AM-R, …) collapsed to G / D / M / F. */
function toPosition(abbr, isSub) {
  const a = (abbr || '').toUpperCase();
  if (a === 'G' || a === 'GK') return 'G';
  if (/^(CD|D|LB|RB|WB|LWB|RWB|FB|SW)/.test(a)) return 'D';
  if (/M/.test(a)) return 'M';
  if (/^(F|ST|CF|LF|RF|LW|RW|W)/.test(a)) return 'F';
  return isSub ? '' : 'M';
}

const statVal = (stats, name) => {
  const s = (stats || []).find((x) => x.name === name);
  return s ? Number(s.value) : 0;
};

function mapRoster(side, ke, teamCleanSheet) {
  const players = (side.roster || []).map((p) => {
    const ath = p.athlete || {};
    const raw = p.stats || [];
    const key = normName(ath.displayName || ath.fullName);
    const cameOn = !!p.subbedIn || statVal(raw, 'subIns') > 0;
    const played = !!p.starter || cameOn || statVal(raw, 'appearances') > 0;
    const position = toPosition(p.position && p.position.abbreviation, !p.starter);

    // Minutes: starters run to full time unless subbed off or sent off; subs
    // run from when they came on. When the commentary doesn't pin the minute
    // down, leave it blank rather than invent a full 90.
    const onMin = ke.on[key];
    const offMin = ke.off[key];
    let minutes = null;
    if (p.starter) {
      minutes = offMin != null ? offMin : p.subbedOut ? null : ke.fullTime;
    } else if (played && onMin != null) {
      minutes = Math.max(0, (offMin != null ? offMin : ke.fullTime) - onMin);
    }

    return {
      name: ath.displayName || ath.fullName,
      shortName: ath.shortName,
      shirt: p.jersey != null ? p.jersey : null,
      position,
      substitute: !p.starter,
      captain: !!p.captain,
      avgRating: null, // ESPN publishes no player ratings
      played,
      stats: {
        minutesPlayed: minutes,
        goals: statVal(raw, 'totalGoals'),
        assists: statVal(raw, 'goalAssists'),
        shots: statVal(raw, 'totalShots'),
        shotsOnTarget: statVal(raw, 'shotsOnTarget'),
        offsides: statVal(raw, 'offsides'),
        foulsCommitted: statVal(raw, 'foulsCommitted'),
        foulsSuffered: statVal(raw, 'foulsSuffered'),
        saves: statVal(raw, 'saves'),
        goalsConceded: statVal(raw, 'goalsConceded'),
      },
      events: {
        yellow: statVal(raw, 'yellowCards'),
        red: statVal(raw, 'redCards'),
        ownGoal: statVal(raw, 'ownGoals'),
        penMissed: ke.penMissed[key] || 0,
        penSaved: ke.penSaved[key] || 0,
      },
      cleanSheet: !!(teamCleanSheet && position === 'G' && played),
    };
  });

  return {
    name: (side.team && (side.team.displayName || side.team.name)) || 'Team',
    formation: side.formation || null,
    players,
  };
}

/** Fetch + assemble one match's scorecard. */
async function computeScorecard(id) {
  // The summary endpoint is league-agnostic, so one slug serves every match.
  const sum = await getJson(`${ESPN}/eng.1/summary?event=${id}`);
  if (!sum || !sum.header) return { notFound: true };

  const hdr = sum.header;
  const comp = (hdr.competitions && hdr.competitions[0]) || {};
  const cs = comp.competitors || [];
  const home = cs.find((c) => c.homeAway === 'home') || cs[0] || {};
  const away = cs.find((c) => c.homeAway === 'away') || cs[1] || {};
  const st = comp.status && comp.status.type;

  const header = {
    id: String(hdr.id),
    tournament: (hdr.league && hdr.league.name) || '',
    season: (hdr.season && hdr.season.name) || '',
    round: (comp.notes && comp.notes[0] && comp.notes[0].headline) || '',
    status: st ? (st.completed ? 'finished' : st.state === 'in' ? 'inprogress' : 'notstarted') : 'notstarted',
    statusText: (st && (st.description || st.shortDetail)) || '',
    startTimestamp: comp.date ? epochSec(comp.date) : null,
    home: home.team && (home.team.displayName || home.team.name),
    away: away.team && (away.team.displayName || away.team.name),
    homeScore: home.score != null ? Number(home.score) : null,
    awayScore: away.score != null ? Number(away.score) : null,
    venue: (sum.gameInfo && sum.gameInfo.venue && sum.gameInfo.venue.fullName) || '',
  };

  const rosters = sum.rosters || [];
  const hasLineups = rosters.length === 2 && rosters.every((r) => (r.roster || []).length);

  // Extra time pushes the last whistle past 90; take the cue from the clock.
  const lastMin = Math.max(0, ...(sum.keyEvents || []).map((e) => clockMin(e) || 0));
  const starters = new Set();
  for (const r of rosters) {
    for (const p of r.roster || []) {
      if (p.starter) starters.add(normName((p.athlete || {}).displayName || (p.athlete || {}).fullName));
    }
  }
  const ke = parseKeyEvents(
    sum.keyEvents,
    lastMin > 100 ? 120 : 90,
    makeNameResolver(rosters),
    (key) => starters.has(key)
  );

  const byHomeAway = (side) => {
    const c = cs.find((x) => x.team && side.team && String(x.team.id) === String(side.team.id));
    return c ? c.homeAway : null;
  };
  const homeSide = rosters.find((r) => byHomeAway(r) === 'home') || rosters[0];
  const awaySide = rosters.find((r) => byHomeAway(r) === 'away') || rosters[1];

  // The summary header can come back scoreless with a frozen mid-match status
  // long after full time. Prefer the scoreboard record; failing that, add the
  // goals up off the team sheets.
  const known = matchIndex.get(String(id));
  if (header.homeScore == null || header.awayScore == null) {
    if (known && known.homeScore != null) {
      header.homeScore = known.homeScore;
      header.awayScore = known.awayScore;
    } else if (hasLineups) {
      const tally = (side, opponent) =>
        (side.roster || []).reduce((n, p) => n + statVal(p.stats, 'totalGoals'), 0) +
        (opponent.roster || []).reduce((n, p) => n + statVal(p.stats, 'ownGoals'), 0);
      header.homeScore = tally(homeSide, awaySide);
      header.awayScore = tally(awaySide, homeSide);
    }
  }
  if (comp.isFinal || (known && known.status === 'finished')) {
    header.status = 'finished';
    header.statusText = 'Full Time';
  } else if (known) {
    header.statusText = known.statusText || header.statusText;
  }

  const teams = hasLineups
    ? {
        home: mapRoster(homeSide, ke, header.awayScore === 0),
        away: mapRoster(awaySide, ke, header.homeScore === 0),
      }
    : null;

  const data = { header, teams, lineupsAvailable: hasLineups };
  scorecardCache.set(String(id), { at: Date.now(), data });
  return data;
}

// -------------------------------------------------------------- routes
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

/** Every competition we can show — powers the league picker. */
app.get('/api/leagues', (req, res) => {
  res.json({
    leagues: LEAGUES.map((l) => ({
      id: l.slug,
      name: l.name,
      category: l.category,
      userCount: rankOf(l.slug),
      hasStats: true,
    })),
  });
});

/** All matches on a date, grouped by competition. */
app.get('/api/matches', async (req, res) => {
  const date = req.query.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
    return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  }
  try {
    const stamp = date.replace(/-/g, '');
    const slugs = LEAGUES.map((l) => l.slug);
    const lists = await getMany(slugs.map((s) => `${ESPN}/${s}/scoreboard?dates=${stamp}`));
    const groups = [];
    lists.forEach((j, i) => {
      const events = (j && j.events) || [];
      if (!events.length) return;
      const meta = LEAGUE_BY_SLUG[slugs[i]];
      groups.push({
        tournamentId: slugs[i],
        tournament: meta.name,
        category: meta.category,
        userCount: rankOf(slugs[i]),
        hasStats: true,
        matches: events.map((e) => toMatch(e, slugs[i])),
      });
    });
    groups.sort((a, b) => b.userCount - a.userCount || a.tournament.localeCompare(b.tournament));
    res.json({ date, groups });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

/** The N most recently finished matches (default 3). `league=<slug>` narrows. */
app.get('/api/recent', async (req, res) => {
  const count = Math.min(50, Math.max(1, parseInt(req.query.count, 10) || 3));
  const leagueId = LEAGUE_BY_SLUG[req.query.league] ? req.query.league : null;
  const opts = { leagueId };
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

/** Full per-player scorecard for one match. */
app.get('/api/scorecard', async (req, res) => {
  const id = req.query.id;
  if (!/^\d+$/.test(id || '')) return res.status(400).json({ error: 'numeric id required' });
  try {
    const cached = scorecardCache.get(id);
    if (cached && Date.now() - cached.at < 120000) return res.json(cached.data);
    let inflight = scorecardInFlight.get(id);
    if (!inflight) {
      inflight = computeScorecard(id).finally(() => scorecardInFlight.delete(id));
      scorecardInFlight.set(id, inflight);
    }
    if (cached) {
      // Stale-while-revalidate: serve the stale copy, refresh behind it. The
      // background refresh must own its failure or it takes the process down.
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

// A long-running server must not die on one stray background rejection.
process.on('unhandledRejection', (err) => {
  console.log('  Unhandled rejection (ignored):', (err && err.message) || err);
});

app.listen(PORT, () => {
  console.log(`\n  Football Score Table (ESPN build) running:  http://localhost:${PORT}\n`);
  // Pre-fetch the default view so the first page load is instant, and keep it
  // warm in the background.
  const warm = () =>
    computeRecent(3, {})
      .then((d) => console.log(`  Recent matches ready (${d.matches.length} cached).`))
      .catch((e) => console.log('  Recent warm-up failed:', e.message));
  warm();
  setInterval(warm, 120000);
});
