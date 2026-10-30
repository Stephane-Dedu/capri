// Pro match data for her League drafts: Oracle's Elixir's yearly CSVs of
// every pro game (champions per role, bans, results, league, patch), from
// its public Google Drive folder. Each year is boiled down to a small JSON of
// games in her data folder and refreshed every few days. A CSV you download
// yourself from oracleselixir.com and drop in that folder counts too, which
// helps when Drive says the file is over its download quota.
//
// Her draft advice is computed from these games (draft.js), never from a
// model's memory of the meta.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Readable } = require('node:stream');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const FOLDER = '1gLSw0RLjBbtaNy0dgnGQDAZOHIgCe-HH';
const LISTING = `https://drive.google.com/embeddedfolderview?id=${FOLDER}`;
const download = (id) => `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
const STALE_MS = 3 * 24 * 3600e3;
// Early in the year, last year's games fill in.
const ENOUGH_GAMES = 1500;
// Older games count less: a game this many days older than the newest one
// weighs half as much.
const HALF_LIFE_DAYS = 60;
const MAX_AGE_DAYS = 365;
const PRO_WEIGHT = 0.5; // a pro game, next to high-elo solo queue games
const REBUILD_MS = 20 * 60000; // new solo queue games are picked up this often

const ROLES = ['top', 'jng', 'mid', 'bot', 'sup'];
const ROLE_NAMES = { top: 'top', jng: 'jungle', mid: 'mid', bot: 'bot', sup: 'support' };

// "Kai'Sa", "Nunu & Willump" -> "kaisa", "nunuwillump": the same key for
// Oracle's Elixir names, the League client's names and what you type.
const keyOf = (name) =>
  String(name ?? '')
    .normalize('NFD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

// One CSV line into fields, with Oracle's Elixir's "quoted, fields".
function fields(line) {
  const out = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') {
      let value = '';
      let j = i + 1;
      for (;;) {
        const q = line.indexOf('"', j);
        if (q < 0) {
          value += line.slice(j);
          i = line.length + 1;
          break;
        }
        value += line.slice(j, q);
        if (line[q + 1] === '"') {
          value += '"';
          j = q + 2;
          continue;
        }
        i = q + 2;
        break;
      }
      out.push(value);
    } else {
      const comma = line.indexOf(',', i);
      const end = comma < 0 ? line.length : comma;
      out.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return out;
}

// Oracle's Elixir rows (one per player and one per team, per game) into
// compact games:
//   { id, league, date: 'YYYY-MM-DD', patch, teams: [blue, red], win: 0 (blue) | 1 (red),
//     champs: [[top, jng, mid, bot, sup] for blue, [...] for red], bans: [[...], [...]] }
// Games missing a champion are dropped.
async function parse(lines) {
  let col = null;
  const games = new Map();
  for await (const line of lines) {
    if (!line) continue;
    const f = fields(line);
    if (!col) {
      col = Object.fromEntries(f.map((name, i) => [name.trim().toLowerCase(), i]));
      if (col.gameid === undefined || col.position === undefined || col.champion === undefined) throw new Error("that's not an Oracle's Elixir match data CSV");
      continue;
    }
    const get = (name) => (col[name] === undefined ? '' : (f[col[name]] ?? '').trim());
    const id = get('gameid');
    const side = get('side').toLowerCase() === 'red' ? 1 : get('side').toLowerCase() === 'blue' ? 0 : -1;
    if (!id || side < 0) continue;
    let game = games.get(id);
    if (!game) {
      game = { id, league: get('league'), date: get('date').slice(0, 10), patch: get('patch'), teams: ['', ''], win: -1, champs: [Array(5).fill(''), Array(5).fill('')], bans: [[], []] };
      games.set(id, game);
    }
    if (get('result') === '1') game.win = side;
    else if (get('result') === '0' && game.win < 0) game.win = 1 - side;
    if (get('teamname')) game.teams[side] = get('teamname');
    const role = ROLES.indexOf(get('position').toLowerCase());
    if (role >= 0 && get('champion')) game.champs[side][role] = get('champion');
    for (let b = 1; b <= 5; b++) {
      const ban = get(`ban${b}`);
      if (ban && !game.bans[side].includes(ban)) game.bans[side].push(ban);
    }
  }
  if (!col) throw new Error('empty file');
  return [...games.values()].filter((g) => g.win >= 0 && g.date && g.champs.every((team) => team.every(Boolean)));
}

// ---- the data folder ---------------------------------------------------------

class ProData {
  constructor(dir) {
    this.dir = dir;
    this.stats = null;
    this.loaded = []; // { year, source, fetched, games }
    this.error = null; // the last refresh problem, for /league
    this.refreshing = null;
  }

  // Cached years, dropped-in CSVs and the solo queue games (soloq.js), then
  // stats over them all, built in a worker thread (tens of thousands of games
  // take a few seconds). Cheap when nothing changed; the solo queue crawl
  // adds games all the time, so they're picked up at most every 20 minutes.
  async load() {
    fs.mkdirSync(this.dir, { recursive: true });
    await this.importDropped();
    const names = fs.readdirSync(this.dir);
    const stampOf = (files) => files.map((name) => `${name}:${fs.statSync(path.join(this.dir, name)).mtimeMs}`).join('|');
    const pro = names.filter((name) => /^games-\d{4}\.json$/.test(name));
    const solo = names.filter((name) => /^soloq-[a-z0-9]+\.jsonl$/.test(name));
    const stamp = { pro: stampOf(pro), solo: stampOf(solo) };
    const fresh = Date.now() - (this.builtAt ?? 0) < REBUILD_MS;
    if (this.stats && stamp.pro === this.stamp?.pro && (stamp.solo === this.stamp?.solo || fresh)) return this.stats;
    // One build at a time; meanwhile the last stats still answer.
    if (this.building) return this.stats ?? this.building;
    this.building = buildStats(this.dir, pro, solo)
      .then(({ stats, loaded, soloq }) => {
        this.stats = stats;
        this.loaded = loaded;
        this.soloq = soloq;
        this.stamp = stamp;
        this.builtAt = Date.now();
        return stats;
      })
      .finally(() => (this.building = null));
    return this.stats ?? this.building;
  }

  // CSVs you dropped in the folder, parsed once (again when they change).
  async importDropped() {
    for (const name of fs.readdirSync(this.dir).filter((n) => n.toLowerCase().endsWith('.csv'))) {
      const file = path.join(this.dir, name);
      const mtime = fs.statSync(file).mtimeMs;
      const year = Number(name.match(/(?:19|20)\d\d/)?.[0]) || new Date(mtime).getFullYear();
      const out = path.join(this.dir, `games-${year}.json`);
      // Checked once per run; the cached copy is big.
      this.imported ??= new Map();
      if (this.imported.get(name) === mtime) continue;
      const cached = readJson(out);
      if (cached?.source === name && cached.mtime === mtime) {
        this.imported.set(name, mtime);
        continue;
      }
      try {
        const games = await parse(readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity }));
        writeJson(out, { year, source: name, mtime, fetched: new Date().toISOString(), games });
        this.imported.set(name, mtime);
      } catch (err) {
        this.error = `${name}: ${err.message}`;
      }
    }
  }

  // Downloads this year's file (and last year's, early in the year) when the
  // cached copy is missing or a few days old. Keeps the old copy on failure.
  refresh({ force = false } = {}) {
    this.refreshing ??= this.doRefresh(force).finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  async doRefresh(force) {
    fs.mkdirSync(this.dir, { recursive: true });
    const year = new Date().getFullYear();
    try {
      let files = null;
      for (const y of [year, year - 1]) {
        const out = path.join(this.dir, `games-${y}.json`);
        const cached = readJson(out);
        // A CSV you dropped in yourself wins over the download. Past years
        // don't change.
        const dropped = String(cached?.source).endsWith('.csv') && fs.existsSync(path.join(this.dir, cached.source));
        const fresh = cached && (y < year || Date.now() - Date.parse(cached.fetched) < STALE_MS);
        let games = cached?.games ?? [];
        if (!dropped && (!fresh || (force && y === year))) {
          files ??= await listing();
          if (files[y]) {
            games = await fetchYear(files[y]);
            writeJson(out, { year: y, source: 'drive', fetched: new Date().toISOString(), games });
          }
        }
        if (games.length >= ENOUGH_GAMES) break;
      }
      this.error = null;
    } catch (err) {
      this.error = err.message;
    }
    return this.load();
  }

  // For /league and the tools: what she knows, from when.
  describe() {
    if (!this.stats) return this.error ? `no pro data yet (${this.error}). Drop an Oracle's Elixir CSV in ${this.dir}.` : 'no pro data yet.';
    const s = this.stats;
    const parts = [];
    if (s.sources.pro) {
      const years = this.loaded.map((y) => `${y.year} (${y.source === 'drive' ? `downloaded ${y.fetched.slice(0, 10)}` : y.source})`).join(', ');
      parts.push(`${s.sources.pro.toLocaleString('en')} pro games (top leagues ${s.leagues.filter((l) => l !== 'solo queue').slice(0, 5).join(', ')}; Oracle's Elixir ${years})`);
    }
    for (const q of this.soloq ?? []) {
      if (q.n) parts.push(`${q.n.toLocaleString('en')} ${q.tier ?? 'high-elo'} solo queue games on ${String(q.platform).toUpperCase()} (Riot API, ${q.days} days)`);
    }
    return `${parts.join(' + ')}, ${s.first} to ${s.last}.${this.error ? ` Last pro data refresh failed: ${this.error}` : ''}`;
  }
}

// Reads every game file and builds the stats, in a worker thread when it can.
// Returns { stats, loaded: pro years without their games, soloq: [{ platform, n, days, tier }] }.
function buildStats(dir, pro, solo) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(__filename, { workerData: { job: 'prostats', dir, pro, solo } });
    } catch {
      resolve(collect(dir, pro, solo));
      return;
    }
    worker.once('message', (msg) => {
      if (msg.stats) Object.setPrototypeOf(msg.stats, ProStats.prototype);
      resolve(msg);
    });
    worker.once('error', () => resolve(collect(dir, pro, solo)));
    worker.once('exit', (code) => code && reject(new Error(`stats worker exited with ${code}`)));
  });
}

function collect(dir, pro, solo) {
  const years = pro.map((name) => readJson(path.join(dir, name))).filter(Boolean).sort((a, b) => b.year - a.year);
  const queues = solo.map((name) => {
    const games = readLines(path.join(dir, name));
    return { platform: name.match(/^soloq-([a-z0-9]+)\.jsonl$/)[1], tier: games.at(-1)?.tier, games };
  });
  const games = [...years.flatMap((y) => y.games.map((g) => ({ ...g, source: 'pro' }))), ...queues.flatMap((q) => q.games.map((g) => ({ ...g, source: 'soloq' })))];
  // Solo queue is closer to how you play: once there is some, a pro game counts half.
  const weights = { pro: queues.some((q) => q.games.length) ? PRO_WEIGHT : 1, soloq: 1 };
  return {
    stats: games.length ? new ProStats(games, weights) : null,
    loaded: years.map(({ games: list, ...year }) => ({ ...year, n: list.length })),
    soloq: queues.map((q) => ({ platform: q.platform, tier: q.tier, n: q.games.length, days: new Set(q.games.map((g) => g.date)).size })),
  };
}

// One JSON game per line (soloq.js appends to these).
function readLines(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line cut short by a crash: skip it.
    }
  }
  return out;
}

// Year -> Drive file id, from the folder's public listing.
async function listing() {
  const res = await fetch(LISTING, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Drive listing: HTTP ${res.status}`);
  const html = await res.text();
  const years = {};
  for (const [, id, title] of html.matchAll(/\/file\/d\/([\w-]+)[\s\S]*?flip-entry-title">([^<]+)/g)) {
    const year = title.match(/^((?:19|20)\d\d)_LoL_esports_match_data/)?.[1];
    if (year) years[year] = id;
  }
  if (!Object.keys(years).length) throw new Error("couldn't read Oracle's Elixir's Drive folder");
  return years;
}

async function fetchYear(id) {
  const res = await fetch(download(id), { signal: AbortSignal.timeout(10 * 60000) });
  if (!res.ok) throw new Error(`download: HTTP ${res.status}`);
  // Drive answers with a web page instead of the file when it's over quota.
  if ((res.headers.get('content-type') ?? '').includes('text/html')) {
    await res.body?.cancel();
    throw new Error('Google Drive says the file is over its download quota; it usually clears within a day');
  }
  return parse(readline.createInterface({ input: Readable.fromWeb(res.body), crlfDelay: Infinity }));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

// ---- stats -------------------------------------------------------------------

// Records are { n, g, w }: games, recency-weighted games, weighted wins.
const blank = () => ({ n: 0, g: 0, w: 0 });
const add = (rec, weight, won) => {
  rec.n += 1;
  rec.g += weight;
  if (won) rec.w += weight;
};

// Counts over a list of games: per champion and role, lane matchups, any-role
// matchups, teammates, bans.
class ProStats {
  // weights: how much a game from each source counts ({ pro, soloq }).
  constructor(games, weights = {}) {
    const days = (date) => Date.parse(date) / 86400e3;
    const newest = Math.max(...games.map((g) => days(g.date)));
    games = games.filter((g) => newest - days(g.date) <= MAX_AGE_DAYS);
    this.sources = { pro: 0, soloq: 0 };
    for (const game of games) this.sources[game.source ?? 'pro'] += 1;
    this.names = new Map(); // key -> display name
    this.role = new Map(); // key -> { top: rec, ... }
    this.lane = new Map(); // `${role}|${a}|${b}` -> a's record against b, same role
    this.vs = new Map(); // `${a}|${b}` -> a's record against b, any roles
    this.duo = new Map(); // `${a}|${b}` -> a's record with b on its team
    // Role-aware: `${roleA}|${a}|${roleB}|${b}` -> a (in roleA) against or with b (in roleB).
    this.cross = new Map();
    this.mate = new Map();
    this.bans = new Map(); // key -> { n, g }
    // `${key}|${role}` -> what the champion does in a game (solo queue
    // games with per-player stats): see profileOf.
    this.profiles = new Map();
    const rows = new Map(); // same keys -> [[damage share, won, weight]]
    this.total = blank();
    const leagues = new Map();
    const dates = games.map((g) => g.date).sort();
    this.first = dates[0];
    this.last = dates.at(-1);
    for (const game of games) {
      const weight = (weights[game.source ?? 'pro'] ?? 1) * 0.5 ** ((newest - days(game.date)) / HALF_LIFE_DAYS);
      add(this.total, weight, true);
      leagues.set(game.league, (leagues.get(game.league) ?? 0) + 1);
      const keys = game.champs.map((team) => team.map((name) => this.key(name)));
      for (let side = 0; side < 2; side++) {
        const won = game.win === side;
        const mine = keys[side];
        const theirs = keys[1 - side];
        for (let r = 0; r < 5; r++) {
          const a = mine[r];
          const roles = this.role.get(a) ?? Object.fromEntries(ROLES.map((role) => [role, blank()]));
          this.role.set(a, roles);
          add(roles[ROLES[r]], weight, won);
          add(rec(this.lane, `${ROLES[r]}|${a}|${theirs[r]}`), weight, won);
          const st = game.stats?.[side]?.[r];
          if (st) {
            const id = `${a}|${ROLES[r]}`;
            const prof = this.profiles.get(id) ?? { n: 0, g: 0, dmg: 0, ap: 0, cc: 0, ccg: 0, tank: 0 };
            prof.n += 1;
            prof.g += weight;
            prof.dmg += weight * st[0];
            prof.ap += weight * st[1];
            prof.tank += weight * st[3];
            if (st[2] !== null) {
              prof.cc += weight * st[2];
              prof.ccg += weight;
            }
            this.profiles.set(id, prof);
            if (!rows.has(id)) rows.set(id, []);
            rows.get(id).push([st[0], won, weight]);
          }
          for (let o = 0; o < 5; o++) {
            add(rec(this.vs, `${a}|${theirs[o]}`), weight, won);
            add(rec(this.cross, `${ROLES[r]}|${a}|${ROLES[o]}|${theirs[o]}`), weight, won);
            if (o === r) continue;
            add(rec(this.duo, `${a}|${mine[o]}`), weight, won);
            add(rec(this.mate, `${ROLES[r]}|${a}|${ROLES[o]}|${mine[o]}`), weight, won);
          }
        }
      }
      // Once per game, even when both teams ban it (solo queue allows that).
      for (const key of new Set(game.bans.flat().map((name) => this.key(name)))) {
        const ban = this.bans.get(key) ?? { n: 0, g: 0 };
        ban.n += 1;
        ban.g += weight;
        this.bans.set(key, ban);
      }
    }
    this.leagues = [...leagues.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    this.finishProfiles(rows);
  }

  // Averages, and how each champion does when its player deals little or a
  // lot of damage: its win rate in its own bottom and top third of games by
  // damage share. Everyone loses more when they deal little, so these only
  // mean something next to the role's average (roleSplit).
  finishProfiles(rows) {
    const split = Object.fromEntries(ROLES.map((role) => [role, { low: blank(), high: blank() }]));
    for (const [id, prof] of this.profiles) {
      prof.dmg /= prof.g;
      prof.ap /= prof.g;
      prof.tank /= prof.g;
      prof.cc = prof.ccg ? prof.cc / prof.ccg : null;
      const list = rows.get(id).sort((a, b) => a[0] - b[0]);
      const third = Math.floor(list.length / 3);
      prof.low = blank();
      prof.high = blank();
      const role = id.split('|')[1];
      list.slice(0, third).forEach(([, won, w]) => (add(prof.low, w, won), add(split[role].low, w, won)));
      list.slice(list.length - third).forEach(([, won, w]) => (add(prof.high, w, won), add(split[role].high, w, won)));
    }
    this.roleSplit = split;
    // Each role's usual champion, weighted by games, for the team check.
    const avg = {};
    for (const role of ROLES) {
      const list = [...this.profiles.entries()].filter(([id]) => id.endsWith(`|${role}`)).map(([, prof]) => prof);
      const g = list.reduce((sum, prof) => sum + prof.g, 0);
      if (!g) continue;
      const mean = (field) => list.reduce((sum, prof) => sum + (prof[field] ?? 0) * prof.g, 0) / g;
      avg[role] = { dmg: mean('dmg'), ap: mean('ap'), cc: mean('cc'), tank: mean('tank') };
    }
    this.roleAvg = Object.keys(avg).length === ROLES.length ? avg : null;
  }

  // What a champion does in a role, or null without solo queue stats:
  // { n, dmg: share of team damage, ap: magic share of it, cc: enemies
  // immobilized per game, tank: share of team damage taken, low / high:
  // records in its low- and high-damage games }.
  profileOf(key, role) {
    return this.profiles.get(`${key}|${role}`) ?? null;
  }

  key(name) {
    const key = keyOf(name);
    if (!this.names.has(key)) this.names.set(key, name);
    return key;
  }

  name(key) {
    return this.names.get(key) ?? key;
  }

  roles(key) {
    return this.role.get(key) ?? Object.fromEntries(ROLES.map((role) => [role, blank()]));
  }

  // A champion's games across roles.
  games(key) {
    return Object.values(this.roles(key)).reduce((sum, r) => sum + r.g, 0);
  }

  // Where pros play it, most played first, as [role, share of its games].
  roleShares(key) {
    const total = this.games(key);
    return ROLES.map((role) => [role, total ? this.roles(key)[role].g / total : 0]).sort((a, b) => b[1] - a[1]);
  }

  laneRec(role, a, b) {
    return this.lane.get(`${role}|${a}|${b}`) ?? blank();
  }

  vsRec(a, b) {
    return this.vs.get(`${a}|${b}`) ?? blank();
  }

  // a in roleA against b in roleB (lane matchups are the same-role case).
  crossRec(roleA, a, roleB, b) {
    return this.cross.get(`${roleA}|${a}|${roleB}|${b}`) ?? blank();
  }

  mateRec(roleA, a, roleB, b) {
    return this.mate.get(`${roleA}|${a}|${roleB}|${b}`) ?? blank();
  }

  duoRec(a, b) {
    return this.duo.get(`${a}|${b}`) ?? blank();
  }

  // Share of games in which it was picked or banned.
  presence(key) {
    const picks = Object.values(this.roles(key)).reduce((sum, r) => sum + r.n, 0);
    const bans = this.bans.get(key)?.n ?? 0;
    return { picks, bans, rate: this.total.n ? (picks + bans) / this.total.n : 0 };
  }

  // The champions pros play most in a role.
  top(role, n = 10) {
    return [...this.role.entries()]
      .filter(([, roles]) => roles[role].n > 0)
      .sort((a, b) => b[1][role].g - a[1][role].g)
      .slice(0, n)
      .map(([key, roles]) => ({ key, name: this.name(key), rec: roles[role] }));
  }

  // What you typed ("kaisa", "Lee", "tf", "nunu") to a champion key, or null.
  find(text) {
    const want = keyOf(text);
    if (!want) return null;
    if (this.role.has(want) || this.bans.has(want)) return want;
    const keys = [...new Set([...this.role.keys(), ...this.bans.keys()])];
    const initials = (key) => String(this.name(key)).split(/[^A-Za-z]+/).filter(Boolean).map((w) => w[0].toLowerCase()).join('');
    return (
      keys.find((key) => key.startsWith(want)) ??
      keys.find((key) => want.length >= 2 && initials(key) === want) ??
      keys.find((key) => want.length >= 3 && key.includes(want)) ??
      null
    );
  }
}

function rec(map, key) {
  let r = map.get(key);
  if (!r) map.set(key, (r = blank()));
  return r;
}

module.exports = { ProData, ProStats, parse, fields, keyOf, ROLES, ROLE_NAMES };

// The stats worker (buildStats).
if (!isMainThread && workerData?.job === 'prostats') {
  parentPort.postMessage(collect(workerData.dir, workerData.pro, workerData.solo));
}
