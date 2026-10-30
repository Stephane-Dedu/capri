// Solo queue games from the top of the ladder, for her League drafts: the
// players at or above a tier on your server (Diamond by default:
// CAPRI_SOLOQ_TIER), from Riot's API with your own key
// (developer.riotgames.com). Their ranked solo games are kept when at least
// MIN_TOP of the 10 players are at that level right now, so it's a Diamond+
// lobby, not an Emerald game with one Diamond in it.
//
// A development key allows about 100 requests every 2 minutes, roughly 2,500
// games an hour, so this is a crawl in the background: the ladder once a
// day, then random players' new games, appended to a file as they come
// (one game per line) and resumed after a restart. Games are stored like the
// pro games (prodata.js), with no player names or ids; the file is trimmed
// to the newest MAX_GAMES of the last KEEP_DAYS days once a day.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const REGIONS = {
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  kr: 'asia', jp1: 'asia',
  oc1: 'sea', sg2: 'sea', tw2: 'sea', vn2: 'sea', ph2: 'sea', th2: 'sea',
};
// The client's region names (lol /riotclient/region-locale) to API platforms.
const PLATFORMS = { EUW: 'euw1', EUNE: 'eun1', TR: 'tr1', RU: 'ru', ME: 'me1', NA: 'na1', BR: 'br1', LAN: 'la1', LAS: 'la2', KR: 'kr', JP: 'jp1', OCE: 'oc1', SG: 'sg2', TW: 'tw2', VN: 'vn2', PH: 'ph2', TH: 'th2' };
const POSITIONS = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'];
// Champion names by numeric id, from Riot's public Data Dragon (no key):
// matches only carry ids for bans, and internal names ("MonkeyKing") for picks.
const DDRAGON = 'https://ddragon.leagueoflegends.com';

// The ladder from the top down to this tier.
const TIERS = ['challenger', 'grandmaster', 'master', 'diamond', 'emerald'];
const FLOOR = TIERS.includes(String(process.env.CAPRI_SOLOQ_TIER).toLowerCase()) ? String(process.env.CAPRI_SOLOQ_TIER).toLowerCase() : 'diamond';
const APEX = { challenger: 'challengerleagues', grandmaster: 'grandmasterleagues', master: 'masterleagues' };
const DIVISIONS = ['I', 'II', 'III', 'IV'];
const MIN_TOP = Number(process.env.CAPRI_SOLOQ_MIN_TOP) || 5; // players at that level out of 10: a majority
const KEEP_DAYS = Number(process.env.CAPRI_SOLOQ_DAYS) || 21;
const MAX_GAMES = Number(process.env.CAPRI_SOLOQ_MAX) || 60000;
const FIRST_DAYS = 7; // how far back a player's first look goes
const LADDER_EVERY = 24 * 3600e3;
const PLAYER_EVERY = 24 * 3600e3; // look at a player's games again after this
const SAVE_EVERY = 100; // new games between saves
const MIN_LENGTH = 15 * 60; // seconds; shorter games are remakes and early surrenders
const PER_PASS = 20; // players looked at per pass
// Version of what's kept per game. 2 added each player's damage, CC and
// tankiness (games from before stay, without them).
const VERSION = 2;
const HISTORY_GAMES = 60; // a squad player's recent games, for their own record and level
const HISTORY_EVERY = 6 * 3600e3;
// Ranked solo, ranked flex, draft, quickplay: games where a player's own champion and role mean something.
const HISTORY_QUEUES = new Set([420, 440, 400, 490]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Riot's app rate limits ("20:1,100:120": 20 per second, 100 per 2 minutes
// for a development key), read from each answer's X-App-Rate-Limit.
class Limiter {
  constructor() {
    this.limits = [
      [20, 1000],
      [100, 120000],
    ];
    this.stamps = [];
  }

  update(header) {
    const limits = String(header ?? '')
      .split(',')
      .map((part) => part.split(':').map(Number))
      .filter(([count, secs]) => count > 0 && secs > 0)
      .map(([count, secs]) => [count, secs * 1000]);
    if (limits.length) this.limits = limits;
  }

  async take() {
    for (;;) {
      const now = Date.now();
      const longest = Math.max(...this.limits.map(([, ms]) => ms));
      this.stamps = this.stamps.filter((t) => now - t < longest);
      let wait = 0;
      for (const [count, ms] of this.limits) {
        const recent = this.stamps.filter((t) => now - t < ms);
        if (recent.length >= count) wait = Math.max(wait, recent[recent.length - count] + ms - now);
      }
      if (!wait) {
        this.stamps.push(now);
        return;
      }
      await sleep(wait + 25);
    }
  }
}

class SoloQ extends EventEmitter {
  // key() -> your Riot API key or null. platform() -> 'euw1'… (async).
  constructor({ dir, key, platform, base, perPass = PER_PASS }) {
    super();
    this.perPass = perPass;
    this.names = null; // champion id -> English name
    this.dir = dir;
    this.key = key;
    this.platform = platform;
    this.base = base; // tests: a fake API instead of *.api.riotgames.com
    this.limiter = new Limiter();
    this.running = false;
    this.status = 'idle'; // for /league
    this.error = null;
  }

  files(platform) {
    const at = (suffix) => path.join(this.dir, `soloq-${platform}${suffix}`);
    return { games: at('.jsonl'), legacy: at('.json'), state: at('.state.json'), ladder: at('.ladder.json') };
  }

  url(host, route) {
    return this.base ? `${this.base}/${host}${route}` : `https://${host}.api.riotgames.com${route}`;
  }

  // One API call, within the rate limits. Retries after a 429 or a 5xx;
  // throws with .status on 401/403 (bad or expired key) and 404.
  async get(host, route) {
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.limiter.take();
      const key = this.key();
      if (!key) throw Object.assign(new Error('no Riot API key'), { status: 401 });
      const res = await fetch(this.url(host, route), { headers: { 'X-Riot-Token': key }, signal: AbortSignal.timeout(20000) });
      this.limiter.update(res.headers.get('x-app-rate-limit'));
      if (res.ok) return res.json();
      if (res.status === 429 || res.status >= 500) {
        await sleep((Number(res.headers.get('retry-after')) || 2 ** attempt * 2) * 1000);
        continue;
      }
      throw Object.assign(new Error(res.status === 401 || res.status === 403 ? 'the Riot API key was refused (development keys expire after 24 hours)' : `Riot API: HTTP ${res.status} on ${route}`), { status: res.status });
    }
    throw new Error(`Riot API: gave up on ${route}`);
  }

  // Checks the key and the server, for /league key.
  async check() {
    const platform = await this.platform();
    const status = await this.get(platform, '/lol/status/v4/platform-data');
    return `${status?.name ?? platform} (${platform})`;
  }

  start() {
    if (this.running || !this.key()) return;
    this.running = true;
    this.loop().finally(() => (this.running = false));
  }

  stop() {
    this.running = false;
  }

  async loop() {
    while (this.running) {
      try {
        const busy = await this.crawl();
        this.error = null;
        // Caught up: look again in a while.
        if (!busy) await this.pause(15 * 60000);
      } catch (err) {
        this.error = err.message;
        this.status = 'stopped';
        if (err.status === 401 || err.status === 403) {
          this.emit('refused', err.message);
          this.running = false;
          return;
        }
        await this.pause(5 * 60000);
      }
    }
  }

  async pause(ms) {
    const until = Date.now() + ms;
    while (this.running && Date.now() < until) await sleep(1000);
  }

  // One pass: the ladder if it's a day old, then the players due a look, a
  // few at a time. True when there's more to do right away.
  async crawl() {
    const platform = await this.platform();
    const region = REGIONS[platform];
    if (!region) throw new Error(`unknown League server "${platform}"`);
    const files = this.files(platform);
    const state = readJson(files.state) ?? { version: VERSION, players: {}, seen: [] };
    state.version = VERSION;
    this.migrate(files, state);
    const seen = new Set(state.seen);
    this.count ??= countLines(files.games);

    let ladder = readJson(files.ladder);
    if (!ladder || ladder.tier !== FLOOR || Date.now() - ladder.at > LADDER_EVERY) {
      ladder = await this.ladder(platform);
      writeJson(files.ladder, ladder);
      this.compact(files);
    }
    await this.champions();
    const top = new Set(ladder.puuids);
    // Random players not looked at today: tens of thousands of them, so
    // there's always someone with new games.
    const due = ladder.puuids.filter((p) => Date.now() - (state.players[p] ?? 0) > PLAYER_EVERY);
    if (!due.length) {
      this.status = `up to date: ${this.count.toLocaleString('en')} games`;
      return false;
    }
    shuffle(due);

    let batch = [];
    const save = () => {
      if (batch.length) {
        fs.mkdirSync(path.dirname(files.games), { recursive: true });
        fs.appendFileSync(files.games, `${batch.map((g) => JSON.stringify(g)).join('\n')}\n`);
        this.count += batch.length;
        batch = [];
      }
      state.seen = [...seen].slice(-300000);
      writeJson(files.state, state);
      if (this.count > MAX_GAMES * 1.2) this.compact(files);
      this.emit('saved', this.count);
    };
    for (const puuid of due.slice(0, this.perPass)) {
      if (!this.running) break;
      this.status = `crawling ${FLOOR}+ games: ${this.count.toLocaleString('en')} so far`;
      const since = Math.floor(Math.max(state.players[puuid] ?? 0, Date.now() - FIRST_DAYS * 86400e3) / 1000);
      const ids = await this.get(region, `/lol/match/v5/matches/by-puuid/${puuid}/ids?queue=420&type=ranked&startTime=${since}&start=0&count=100`);
      for (const id of ids ?? []) {
        if (seen.has(id) || !this.running) continue;
        seen.add(id);
        const match = await this.get(region, `/lol/match/v5/matches/${id}`).catch((err) => {
          if (err.status === 401 || err.status === 403) throw err;
          return null;
        });
        const game = match && this.toGame(match, top);
        if (!game) continue;
        batch.push(game);
        if (batch.length >= SAVE_EVERY) save();
      }
      state.players[puuid] = Date.now();
    }
    save();
    return true;
  }

  // Everyone on the ladder from the top down to FLOOR, as puuids.
  async ladder(platform) {
    const puuids = [];
    const floor = TIERS.indexOf(FLOOR);
    for (const tier of TIERS.slice(0, floor + 1)) {
      if (APEX[tier]) {
        this.status = `reading the ladder: ${tier}`;
        const list = await this.get(platform, `/lol/league/v4/${APEX[tier]}/by-queue/RANKED_SOLO_5x5`);
        for (const entry of list?.entries ?? []) if (entry.puuid) puuids.push(entry.puuid);
        continue;
      }
      for (const division of DIVISIONS) {
        for (let page = 1; ; page++) {
          this.status = `reading the ladder: ${tier} ${division}, page ${page}`;
          const list = await this.get(platform, `/lol/league/v4/entries/RANKED_SOLO_5x5/${tier.toUpperCase()}/${division}?page=${page}`);
          if (!list?.length) break;
          for (const entry of list) if (entry.puuid) puuids.push(entry.puuid);
        }
      }
    }
    return { at: Date.now(), tier: FLOOR, puuids };
  }

  // The newest MAX_GAMES of the last KEEP_DAYS days.
  compact(files) {
    if (!fs.existsSync(files.games)) return;
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString().slice(0, 10);
    const lines = fs.readFileSync(files.games, 'utf8').split('\n').filter(Boolean);
    const kept = lines.filter((line) => (line.match(/"date":"([\d-]+)"/)?.[1] ?? '') >= cutoff).slice(-MAX_GAMES);
    fs.writeFileSync(`${files.games}.tmp`, kept.length ? `${kept.join('\n')}\n` : '');
    fs.renameSync(`${files.games}.tmp`, files.games);
    this.count = kept.length;
  }

  // From the first versions: one JSON of games, the ladder in the state.
  migrate(files, state) {
    const old = readJson(files.legacy);
    if (old?.games?.length) fs.appendFileSync(files.games, `${old.games.map((g) => JSON.stringify(g)).join('\n')}\n`);
    if (old) fs.rmSync(files.legacy, { force: true });
    delete state.ladder;
  }

  // Champion names by id, from Data Dragon's latest version, once per run.
  async champions() {
    if (this.names) return this.names;
    const host = this.base ? `${this.base}/ddragon` : DDRAGON;
    const [version] = await (await fetch(`${host}/api/versions.json`, { signal: AbortSignal.timeout(20000) })).json();
    const { data } = await (await fetch(`${host}/cdn/${version}/data/en_US/champion.json`, { signal: AbortSignal.timeout(20000) })).json();
    this.names = Object.fromEntries(Object.values(data).map((c) => [Number(c.key), c.name]));
    // The same champion list the League client gives (league.js), for names
    // and classes ("tanks", "marksmen") when the client isn't running.
    const catalog = path.join(this.dir, 'champions.json');
    if (!fs.existsSync(catalog)) writeJson(catalog, Object.values(data).map((c) => ({ id: Number(c.key), name: c.name, alias: c.id, roles: c.tags.map((t) => t.toLowerCase()) })));
    return this.names;
  }

  // A match-v5 match as a compact game, or null if it's not a full GM+
  // ranked solo game with all ten roles.
  toGame(match, top) {
    const names = this.names ?? {};
    const info = match.info;
    if (!info || info.queueId !== 420 || info.gameDuration < MIN_LENGTH) return null;
    const players = info.participants ?? [];
    if (players.length !== 10 || players.some((p) => p.gameEndedInEarlySurrender)) return null;
    if (players.filter((p) => top.has(p.puuid)).length < MIN_TOP) return null;
    const teams = [100, 200].map((teamId) => players.filter((p) => p.teamId === teamId));
    const champs = teams.map((team) => POSITIONS.map((pos) => team.find((p) => p.teamPosition === pos)));
    if (champs.some((team) => team.some((p) => !p))) return null;
    const bans = [100, 200].map((teamId) =>
      (info.teams?.find((t) => t.teamId === teamId)?.bans ?? []).map((b) => names[b.championId]).filter(Boolean),
    );
    const blue = info.teams?.find((t) => t.teamId === 100);
    if (!blue || champs.flat().some((p) => !names[p.championId])) return null;
    // Per player: [share of team damage to champions, magic share of their
    // damage, enemies immobilized, share of team damage taken (incl. mitigated)].
    const stats = champs.map((team) => {
      const dealt = team.reduce((sum, p) => sum + (p.totalDamageDealtToChampions ?? 0), 0) || 1;
      const taken = team.reduce((sum, p) => sum + (p.totalDamageTaken ?? 0) + (p.damageSelfMitigated ?? 0), 0) || 1;
      return team.map((p) => [
        round((p.totalDamageDealtToChampions ?? 0) / dealt, 3),
        round((p.magicDamageDealtToChampions ?? 0) / (p.totalDamageDealtToChampions || 1), 2),
        p.challenges?.enemyChampionImmobilizations ?? null,
        round(((p.totalDamageTaken ?? 0) + (p.damageSelfMitigated ?? 0)) / taken, 3),
      ]);
    });
    return {
      id: match.metadata?.matchId,
      league: 'solo queue',
      tier: `${FLOOR}+`,
      date: new Date(info.gameCreation).toISOString().slice(0, 10),
      patch: String(info.gameVersion ?? '').split('.').slice(0, 2).join('.'),
      teams: ['', ''],
      win: blue.win ? 0 : 1,
      champs: champs.map((team) => team.map((p) => names[p.championId])),
      bans,
      stats,
    };
  }

  // ---- squad players' own games ------------------------------------------

  // A player's recent games by Riot ID ("Slave Knight#gaell"): per game their
  // champion, role, result and the same stats as above. Cached in the folder
  // and refreshed every few hours; null when the Riot ID isn't found.
  async history(riotId) {
    const [name, tag] = String(riotId).split('#').map((s) => s.trim());
    if (!name || !tag) throw new Error(`"${riotId}" isn't a Riot ID (name#tag)`);
    const platform = await this.platform();
    const region = REGIONS[platform];
    const file = this.historyFile(riotId);
    const cached = readJson(file);
    // Fresh, and from this version (with teammates): no need to ask Riot.
    if (cached && Date.now() - cached.at < HISTORY_EVERY && cached.games.every((g) => g.mates)) return cached;
    await this.champions();
    const account = await this.get(region, `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`).catch((err) => {
      if (err.status === 404) return null;
      throw err;
    });
    if (!account?.puuid) return null;
    const ids = await this.get(region, `/lol/match/v5/matches/by-puuid/${account.puuid}/ids?start=0&count=100`);
    // Games saved before teammates were kept get fetched again.
    const known = new Map((cached?.puuid === account.puuid ? cached.games : []).filter((g) => g.mates).map((g) => [g.id, g]));
    const games = [];
    for (const id of ids ?? []) {
      if (games.length >= HISTORY_GAMES) break;
      if (known.has(id)) {
        games.push(known.get(id));
        continue;
      }
      const match = await this.get(region, `/lol/match/v5/matches/${id}`).catch(() => null);
      const game = match && this.ownGame(match, account.puuid);
      if (game) games.push(game);
    }
    const out = { at: Date.now(), riotId: `${account.gameName}#${account.tagLine}`, puuid: account.puuid, games };
    writeJson(file, out);
    return out;
  }

  historyFile(riotId) {
    const [name, tag] = String(riotId).split('#').map((x) => x.trim());
    return path.join(this.dir, 'players', `${encodeURIComponent(`${name}#${tag}`.toLowerCase())}.json`);
  }

  // What history() saved last, without asking Riot (for answers that can't wait).
  cachedHistory(riotId) {
    return readJson(this.historyFile(riotId));
  }

  // One of a player's games, from their side: null for other modes, remakes
  // and games without all five roles.
  ownGame(match, puuid) {
    const info = match.info;
    if (!info || !HISTORY_QUEUES.has(info.queueId) || info.gameDuration < MIN_LENGTH) return null;
    const me = info.participants?.find((p) => p.puuid === puuid);
    const team = info.participants?.filter((p) => p.teamId === me?.teamId) ?? [];
    const role = POSITIONS.indexOf(me?.teamPosition);
    if (!me || role < 0 || team.length !== 5 || me.gameEndedInEarlySurrender) return null;
    const dealt = team.reduce((sum, p) => sum + (p.totalDamageDealtToChampions ?? 0), 0) || 1;
    return {
      id: match.metadata?.matchId,
      date: new Date(info.gameCreation).toISOString().slice(0, 10),
      queue: info.queueId,
      champ: this.names?.[me.championId] ?? me.championName,
      role: ['top', 'jng', 'mid', 'bot', 'sup'][role],
      win: Boolean(me.win),
      dmg: round((me.totalDamageDealtToChampions ?? 0) / dealt, 3),
      // Teammates, so games played with the squad can be told apart.
      mates: team.filter((p) => p.puuid !== puuid).map((p) => p.puuid),
    };
  }
}

const round = (x, digits) => Math.round(x * 10 ** digits) / 10 ** digits;

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function countLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  } catch {
    return 0;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data));
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = { SoloQ, PLATFORMS, REGIONS, MIN_TOP, KEEP_DAYS, FLOOR };
