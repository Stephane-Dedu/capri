// Capri in League of Legends champ select (never in game). She reads the
// draft from the League client (lcu.js), scores picks and bans from pro games
// and high-elo solo queue games (prodata.js, soloq.js, draft.js) and your squad's pools (squad.js), and:
// - tells you your best ban and pick when your turn comes up,
// - answers draft questions in chat with her league_* tools,
// - drafts for you while you're away ("brb"): accepts the queue, bans, and
//   locks in what you hovered, or her best pick from your pool, a few seconds
//   before the timer runs out. Change the hover yourself and she backs off.
// The watcher is off until you turn it on (/league on, or the tray); brb
// turns it on for as long as you're away.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { z } = require('zod');
const { LCU } = require('./lcu');
const { ProData, keyOf, ROLE_NAMES } = require('./prodata');
const { suggestPicks, suggestBans, scorePool, withRoles, teamCheck, tags, banTags, why, whyBan, pct } = require('./draft');
const { Squad, describe: describePlayer } = require('./squad');
const { SoloQ, PLATFORMS } = require('./soloq');

const IDLE_EVERY = 4000; // waiting for a game
const AWAY_EVERY = 10000; // the client isn't running
const DRAFT_EVERY = 1000; // in champ select
const TURN_EVERY = 400; // brb, and it's your turn
const LOCK_LEFT = 6000; // brb locks in with this much time left
const HISTORY_GAMES = 100; // your recent games she reads for your own record
const HISTORY_FRESH = 10 * 60000;
// Summoner's Rift queues: draft, ranked solo/flex, blind, quickplay, swiftplay, clash.
const RIFT_QUEUES = new Set([400, 420, 430, 440, 480, 490, 700]);

const FROM_LCU = { top: 'top', jungle: 'jng', middle: 'mid', bottom: 'bot', utility: 'sup' };
const FROM_WORDS = { top: 'top', jungle: 'jng', jng: 'jng', jg: 'jng', mid: 'mid', middle: 'mid', bot: 'bot', bottom: 'bot', adc: 'bot', support: 'sup', sup: 'sup', supp: 'sup', utility: 'sup' };
const SQUAD_ROLE = { top: 'top', jng: 'jungle', mid: 'mid', bot: 'bot', sup: 'support' };
// The client's internal names that aren't its display names.
const ALIASES = { monkeyking: 'wukong', nunu: 'nunuwillump', renata: 'renataglasc' };
const ACT = 'mcp__capri__league_act';
const PLAYERS_EVERY = 6 * 3600e3;
const MIN_SHOWN = 15; // games before a matchup is listed as best or worst // squad players' own games, refreshed this often
// Carry threats: champions that shut down a skilled player. Point-and-click
// or near-certain hard CC (stun, root, suppression, taunt, fear, polymorph,
// knock-up, silence), and easy champions whose lockdown works even when
// their player is behind (Lux, Veigar). The default for carry-threats.json in
// her League folder, which you can edit; the high-elo profiles add the same kind
// of champion on their own (heavy CC that still wins from behind, draft.js).
const CARRY_THREATS = ['Alistar', 'Annie', 'Fiddlesticks', 'Garen', 'Hecarim', 'Leona', 'Lissandra', 'Lulu', 'Lux', 'Malzahar', 'Maokai', 'Nautilus', 'Nocturne', 'Pantheon', 'Poppy', 'Rammus', 'Renekton', 'Ryze', 'Singed', 'Twisted Fate', 'Vayne', 'Veigar', 'Vi', 'Volibear', 'Xin Zhao'];

const PROMPT = `League of Legends
- You help the user draft in League of Legends, out of game only: champ select picks and bans, matchups, the pro meta, and who on their squad plays what. league_draft reads their live champ select from the League client and scores picks and bans from recent pro games (Oracle's Elixir) and high-elo solo queue games on their server (Riot API), and their squad's pools; it also takes a draft they describe. league_stats answers questions about a champion, a matchup or a role's meta. league_squad keeps the people they play with: in-game names, roles, champion pools, how they play. league_act hovers, picks or bans in their champ select. league_brb drafts for them while they're away.
- For any "what should I / they pick" question, call league_draft first, with the enemies (and allies, bans) they named and players for everyone asked about ("me" for the user, squad names, "name:role" when the role is known).
- Lead with what's strongest into the enemy comp by the numbers (draft %), and why (the matchups). Then say whether the player's own pool is close enough: a pool pick within about 2 points is a fine call, further than that say what it costs. For which role someone should play, compare the strongest options per role. Squad notes are for playstyle tips and who takes which role, not a reason to pick a weaker champion.
- Answer from the tools' numbers, not from memory: the meta moves every patch. Give sample sizes when they're small. The data is pro play and high-elo solo queue, not their elo: say so when it changes the answer. If the tools say there's no data, say that in a line and don't dress up a guess as a recommendation.
- Players aren't equal: a squad player's damage level (set by hand, or measured from their Riot ID's games) says how much damage they really deal. For players below average, prefer champions that hold up when their player deals little (engage, tankiness, utility) over ones whose only job is damage; the tools already fold this in. Use league_team to check a full comp: damage, AD/AP, CC, frontline, who carries.
- Carry threats (point-and-click CC, and easy champions whose lockdown works even when their player is behind, like Vi, Lux, Veigar) are what shuts the squad's carries down: flag them on the enemy team and lean bans toward them.
- When they tell you about someone they play with (or themselves), save it with league_squad, Riot ID included.
- Lock in or ban only when the user asks you to. When they say they're stepping away during queue or champ select ("brb", "afk", "grabbing food"), turn league_brb on and tell them in a line.
- Nothing in game, and nothing about players outside their own party beyond the champions in the draft.`;

class League extends EventEmitter {
  constructor() {
    super();
    this.lcu = new LCU();
    this.squad = new Squad();
    this.data = null;
    this.dir = null;
    this.enabled = false; // the watcher, from her settings
    this.brb = false;
    this.timer = null;
    this.phase = null;
    this.connected = false;
    // Every champion: { port, byId: Map id -> { key, name }, byKey: Map key -> id,
    // catalog: Map key -> { id, name, classes } }, from the client or its cached copy.
    this.champs = null;
    this.resetDraft();
  }

  // Her League folder: pro data, the squad, the champion list.
  init(dir) {
    this.dir = dir;
    this.data = new ProData(dir);
    this.squad.init(dir);
    // high-elo solo queue games from Riot's API, with your key (soloq.js).
    this.soloq = new SoloQ({ dir, key: () => this.riotKey || process.env.RIOT_API_KEY || null, platform: () => this.platform() });
    this.soloq.on('refused', (message) => this.notice('attention', `solo queue data stopped: ${message}. /league key RGAPI-… with a new one.`, 'annoyed'));
    // Whenever there's a key: the numbers are ready when you ask.
    this.soloq.start();
    // Squad players' own games (Riot IDs), in the background so answers never wait on them.
    setTimeout(() => this.refreshPlayers(), 10000);
    this.playersTimer = setInterval(() => this.refreshPlayers(), PLAYERS_EVERY);
  }

  // Fetches each squad player's recent games by Riot ID (soloq.js caches them).
  async refreshPlayers() {
    if (!(this.riotKey || process.env.RIOT_API_KEY) || this.refreshingPlayers) return;
    this.refreshingPlayers = true;
    try {
      for (const player of this.squad.players()) for (const id of [].concat(player.riotId ?? [])) await this.soloq.history(id).catch(() => null);
    } finally {
      this.refreshingPlayers = false;
    }
  }

  // A squad player's own games: their record per champion (the "you" part,
  // for them), and their damage level, measured as their share of team damage
  // next to the high-elo average on the same champion and role (median over their
  // games). A level set by hand in the squad wins. fallback: the League
  // client's history, for the user without a Riot ID.
  playerData(member, stats, fallback = null) {
    // Every account of theirs (riotId can be a list), newest games of each.
    const games = [].concat(member?.riotId ?? []).flatMap((id) => this.soloq?.cachedHistory(id)?.games ?? []);
    // The squad's accounts, to find the games they played together.
    const squadIds = new Set(
      this.squad
        .players()
        .filter((p) => p !== member && p.name !== member?.name)
        .flatMap((p) => [].concat(p.riotId ?? []))
        .map((id) => this.soloq?.cachedHistory(id)?.puuid)
        .filter(Boolean),
    );
    let history = fallback;
    let measured = null;
    if (games.length) {
      history = new Map();
      const ratios = [];
      const together = [];
      for (const game of games) {
        const key = this.resolveAny(game.champ, stats);
        const rec = history.get(key) ?? { n: 0, w: 0, roles: {} };
        const inRole = (rec.roles[game.role] ??= { n: 0, w: 0 });
        rec.n += 1;
        inRole.n += 1;
        if (game.win) {
          rec.w += 1;
          inRole.w += 1;
        }
        history.set(key, rec);
        const prof = stats.profileOf(key, game.role);
        if (prof?.n >= 20 && prof.dmg > 0) {
          ratios.push(game.dmg / prof.dmg);
          if (game.mates?.some((p) => squadIds.has(p))) together.push(game.dmg / prof.dmg);
        }
      }
      // Games with the squad first: that's the lobby the draft is for.
      const use = together.length >= 8 ? together : ratios;
      if (use.length >= 8) {
        use.sort((a, b) => a - b);
        measured = { level: Math.round(Math.min(2, Math.max(0.3, use[Math.floor(use.length / 2)])) * 100) / 100, n: use.length, squad: use === together };
      }
    }
    const level = member?.level ?? measured?.level ?? 1;
    const source = member?.level ? 'set by hand' : measured ? `measured over ${measured.n} ${measured.squad ? 'games with the squad' : 'of their own games'}` : null;
    return { history, level, source, measured, games: games.length };
  }

  // The carry threats list (carry-threats.json, made from the default the first time).
  targeted(stats) {
    const file = this.dir && path.join(this.dir, 'carry-threats.json');
    let list = CARRY_THREATS;
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8')).champions ?? CARRY_THREATS;
    } catch {
      try {
        if (file) fs.writeFileSync(file, `${JSON.stringify({ note: 'Champions that shut down a skilled player: point-and-click hard CC, or easy lockdown that works even when their player is behind. Edit freely.', champions: CARRY_THREATS }, null, 2)}\n`);
      } catch {
        // Only a default.
      }
    }
    return new Set(list.map((name) => this.resolveAny(name, stats)).filter(Boolean));
  }

  // Your Riot API key (/league key), which wins over RIOT_API_KEY in .env.
  setRiotKey(key) {
    this.riotKey = key;
    this.soloq?.start();
  }

  // Your League server for Riot's API: from the client when it's running,
  // else CAPRI_RIOT_PLATFORM, else EU West.
  async platform() {
    if (this.server) return this.server;
    const region = await this.lcu.get('/riotclient/region-locale').catch(() => null);
    const found = PLATFORMS[String(region?.region ?? '').toUpperCase()];
    if (found) this.server = found;
    return found ?? process.env.CAPRI_RIOT_PLATFORM ?? 'euw1';
  }

  resetDraft() {
    this.seen = new Set(); // actions she already told you about
    this.mine = new Map(); // brb: action id -> the champion she hovered
    this.failed = new Set(); // brb: champions that wouldn't lock this draft
    this.did = []; // brb: what she picked and banned
    this.why = new Map(); // brb: champion id -> why she picked it
    this.mastery = null;
    this.history = null; // { at, byKey: Map key -> { n, w } }: your recent games
    this.party = null; // puuid / summoner id -> in-game name, for your premades
  }

  // ---- watching ---------------------------------------------------------------

  enable(on) {
    this.enabled = on;
    clearInterval(this.dataTimer);
    if (on) {
      this.start();
      // Drive refuses the pro data now and then: try again every hour (a
      // no-op once it's fresh).
      this.dataTimer = setInterval(() => this.data?.refresh().catch(() => {}), 3600e3);
    } else if (!this.brb) this.stop();
    this.emit('change');
  }

  start() {
    if (this.timer) return;
    this.data?.refresh().catch(() => {});
    this.timer = setTimeout(() => this.tick(), 0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
    this.phase = null;
  }

  // Capri is quitting: everything off.
  shutdown() {
    clearInterval(this.dataTimer);
    clearInterval(this.playersTimer);
    this.soloq?.stop();
    this.stop();
  }

  async tick() {
    let next = IDLE_EVERY;
    let phase = null;
    try {
      phase = await this.lcu.get('/lol-gameflow/v1/gameflow-phase');
      this.connected = true;
    } catch {
      this.connected = false;
      next = AWAY_EVERY;
    }
    if (phase !== this.phase) this.phaseChanged(this.phase, phase);
    this.phase = phase;
    try {
      if (phase === 'ReadyCheck' && this.brb) {
        await this.accept();
        next = DRAFT_EVERY; // champ select is seconds away
      }
      if (phase === 'ChampSelect') next = await this.champSelect();
    } catch (err) {
      // A hiccup mid-draft: look again soon, the timer is running.
      if (phase === 'ChampSelect') next = TURN_EVERY;
      if (process.env.CAPRI_DEBUG) console.warn(`[capri] league: ${err.message}`);
    }
    if (this.timer) this.timer = setTimeout(() => this.tick(), next);
  }

  phaseChanged(from, to) {
    if (to === 'ChampSelect') this.resetDraft();
    if (from === 'ChampSelect' && (to === 'GameStart' || to === 'InProgress') && this.brb) {
      const pick = this.did.find((d) => d.type === 'pick');
      this.notice('attention', pick ? `game's loading and you're on ${pick.name}. get back here, choom!` : "game's loading. get back here, choom!", 'hype');
      this.setBrb(false);
    } else if (from === 'ChampSelect' && to !== 'GameStart' && to !== 'InProgress' && this.brb) {
      this.notice('quip', 'champ select fell through. still covering for you.', 'annoyed');
    }
    this.emit('change');
  }

  async accept() {
    const check = await this.lcu.get('/lol-matchmaking/v1/ready-check');
    if (check?.state !== 'InProgress' || check.playerResponse !== 'None') return;
    await this.lcu.post('/lol-matchmaking/v1/ready-check/accept');
    this.notice('quip', 'queue popped. accepted it for you.', 'hype');
  }

  async champSelect() {
    const session = await this.lcu.get('/lol-champ-select/v1/session');
    if (!session || session.isSpectating) return DRAFT_EVERY;
    const live = await this.read(session);
    if (this.brb) return this.drive(live);
    const turn = live.turn;
    if (turn && !this.seen.has(turn.id)) {
      this.seen.add(turn.id);
      await this.announce(live, turn.type).catch(() => {});
    }
    return DRAFT_EVERY;
  }

  // Your turn: her card with the best bans or picks, and a line about the top one.
  async announce(live, type) {
    if (!(await this.stats(false))) return;
    if (type === 'ban') {
      const bans = await this.suggest(live, 'ban', 3);
      if (bans.length) this.emit('card', await this.banCard(bans, `ban ${bans[0].name}. ${pct(bans[0].presence)} pick/ban rate.`, true));
    } else if (type === 'pick') {
      const picks = await this.suggest(live, 'pick', 4);
      if (picks.length) this.emit('card', await this.pickCard(picks, `${live.role ? `${ROLE_NAMES[live.role]}: ` : ''}${reason(picks[0])}`, true));
    }
  }

  // Her draft card: champion icons with a chance of winning (picks) or pro
  // presence (bans). `turn`: it's your turn, so she comes and tells you.
  async pickCard(picks, line, turn = false, title = null) {
    const icons = await this.icons(picks.map((p) => p.key));
    return {
      kind: 'pick',
      turn,
      line,
      title,
      rows: picks.map((p, i) => ({ name: p.name, icon: icons[i], value: p.win, role: ROLE_NAMES[p.role], tags: tags(p).slice(0, 3), mine: p.favorite })),
    };
  }

  async banCard(bans, line, turn = false) {
    const icons = await this.icons(bans.map((b) => b.key));
    return {
      kind: 'ban',
      turn,
      line,
      rows: bans.map((b, i) => ({ name: b.name, icon: icons[i], value: b.presence, role: ROLE_NAMES[b.role], tags: banTags(b).slice(0, 2) })),
    };
  }

  // Champions' square icons as data URLs, from her folder, fetched from the
  // client (and kept) the first time. Null where there's none: the card
  // shows initials.
  async icons(keys) {
    return Promise.all(
      keys.map(async (key) => {
        const id = this.champs?.byKey.get(key);
        if (!id || !this.dir) return null;
        const file = path.join(this.dir, 'icons', `${id}.png`);
        if (!fs.existsSync(file) && this.lcu.creds) {
          const png = await this.lcu.bytes(`/lol-game-data/assets/v1/champion-icons/${id}.png`).catch(() => null);
          if (png?.length) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, png);
          }
        }
        try {
          return `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;
        } catch {
          return null;
        }
      }),
    );
  }

  // ---- brb ---------------------------------------------------------------

  setBrb(on, line) {
    if (this.brb === on) return;
    this.brb = on;
    this.mine.clear();
    this.failed.clear();
    if (on) this.start();
    else if (!this.enabled) this.stop();
    if (line) this.notice('quip', line, on ? 'smug' : 'soft');
    this.emit('change');
  }

  async drive(live) {
    const turn = live.turn;
    if (!turn) {
      // Planning phase: say what "you" want to play, so teammates don't ban it.
      if (live.phase === 'PLANNING' && live.pickAction && !live.intent && !this.mine.has('intent')) {
        this.mine.set('intent', 0);
        const id = await this.choose(live, 'pick');
        if (id) await this.lcu.patch(`/lol-champ-select/v1/session/actions/${live.pickAction.id}`, { championId: id }).catch(() => {});
      }
      return DRAFT_EVERY;
    }
    const chosen = this.mine.get(turn.id);
    if (chosen === undefined) {
      // First look at this turn: keep what's hovered (your intent), else her pick.
      const ok = await this.available(turn.type);
      const id = turn.championId && ok.has(turn.championId) && !this.failed.has(turn.championId) ? turn.championId : await this.choose(live, turn.type);
      if (!id) return DRAFT_EVERY;
      if (turn.championId !== id) {
        try {
          await this.lcu.patch(`/lol-champ-select/v1/session/actions/${turn.id}`, { championId: id });
        } catch {
          this.failed.add(id);
          return TURN_EVERY;
        }
      }
      this.mine.set(turn.id, id);
      return TURN_EVERY;
    }
    if (turn.championId && turn.championId !== chosen) {
      this.setBrb(false, "you're back! it's all yours.");
      return DRAFT_EVERY;
    }
    if (live.deadline - Date.now() > LOCK_LEFT) return TURN_EVERY;
    try {
      await this.lcu.post(`/lol-champ-select/v1/session/actions/${turn.id}/complete`);
      const { name } = this.champ(chosen);
      this.did.push({ type: turn.type, name });
      if (turn.type === 'ban') this.notice('quip', `banned ${name} for you.`, 'mischief');
      else this.notice('done', `locked in ${name} for you.${this.why.has(chosen) ? ` ${this.why.get(chosen)}` : ''}`, 'hype');
    } catch {
      // Taken or banned in the meantime: pick again next look.
      this.failed.add(chosen);
      this.mine.delete(turn.id);
    }
    return TURN_EVERY;
  }

  // brb's choice: your intent if it's still there, else her best one, from
  // your own pool when it has anything left.
  async choose(live, type) {
    if (type === 'pick' && live.intent && !this.failed.has(live.intent) && (await this.available('pick')).has(live.intent)) return live.intent;
    const [best] = await this.suggest(live, type, 1, { skip: this.failed, onlyPool: type === 'pick' });
    const id = best && this.champs.byKey.get(best.key);
    if (id) {
      if (type === 'pick') this.why.set(id, reason(best));
      return id;
    }
    // No pro data on anything you can play: anything that's allowed.
    const [any] = [...(await this.available(type))].filter((c) => !this.failed.has(c));
    return any ?? null;
  }

  // ---- reading the client ---------------------------------------------------

  // Every champion, from the client (refetched when it restarts), or from the
  // copy saved last time, so names and classes work without it.
  async champions() {
    const port = (await this.lcu.connect().catch(() => null))?.port;
    if (this.champs && this.champs.port === port && this.champs.byId.size) return this.champs;
    const cache = this.dir && path.join(this.dir, 'champions.json');
    let list = port ? await this.lcu.get('/lol-game-data/assets/v1/champion-summary.json').catch(() => null) : null;
    if (list?.length && cache) {
      try {
        fs.writeFileSync(cache, JSON.stringify(list.filter((c) => c.id > 0).map(({ id, name, alias, roles }) => ({ id, name, alias, roles }))));
      } catch {
        // Only a cache.
      }
    }
    if (!list?.length && cache) {
      try {
        list = JSON.parse(fs.readFileSync(cache, 'utf8'));
      } catch {
        list = [];
      }
    }
    const byId = new Map();
    const byKey = new Map();
    const catalog = new Map();
    for (const c of list ?? []) {
      if (!(c.id > 0)) continue;
      // The display name can be translated; the alias never is.
      const alias = keyOf(c.alias);
      const key = ALIASES[alias] ?? (alias || keyOf(c.name));
      byId.set(c.id, { key, name: c.name });
      byKey.set(key, c.id);
      catalog.set(key, { id: c.id, name: c.name, classes: c.roles ?? [] });
    }
    this.champs = { port, byId, byKey, catalog };
    return this.champs;
  }

  champ(id) {
    const c = this.champs?.byId.get(id);
    return c ? { key: c.key, name: this.data?.stats?.names.get(c.key) ?? c.name } : { key: String(id), name: `#${id}` };
  }

  async available(type) {
    const ids = await this.lcu.get(`/lol-champ-select/v1/${type === 'ban' ? 'bannable' : 'pickable'}-champion-ids`).catch(() => null);
    return new Set(ids ?? []);
  }

  async masteryByKey() {
    if (this.mastery) return this.mastery;
    const list = await this.lcu.get('/lol-champion-mastery/v1/local-player/champion-mastery').catch(() => null);
    if (!list?.length) return null;
    this.mastery = new Map(list.map((m) => [this.champ(m.championId).key, m.championPoints ?? 0]));
    return this.mastery;
  }

  // Your own record per champion over your last Summoner's Rift games, from
  // your match history in the client: the "you" part of her win chances.
  async historyByKey() {
    if (this.history && Date.now() - this.history.at < HISTORY_FRESH) return this.history.byKey;
    const byKey = new Map();
    const seen = new Set();
    for (let begin = 0; begin < HISTORY_GAMES; begin += 20) {
      const page = await this.lcu.get(`/lol-match-history/v1/products/lol/current-summoner/matches?begIndex=${begin}&endIndex=${begin + 20}`).catch(() => null);
      const games = page?.games?.games ?? [];
      for (const game of games) {
        const me = game.participants?.[0];
        if (seen.has(game.gameId) || !RIFT_QUEUES.has(game.queueId) || !me) continue;
        seen.add(game.gameId);
        const key = this.champ(me.championId).key;
        const rec = byKey.get(key) ?? { n: 0, w: 0 };
        rec.n += 1;
        if (me.stats?.win) rec.w += 1;
        byKey.set(key, rec);
      }
      if (games.length < 20) break;
    }
    // Nothing read (the client is closed): no "you" part rather than a fake one.
    this.history = { at: Date.now(), byKey: seen.size ? byKey : null };
    return this.history.byKey;
  }

  // In-game names of the people in your party, so friends on your squad are
  // recognized even when champ select hides names (ranked solo/duo).
  async partyNames() {
    if (this.party) return this.party;
    const lobby = await this.lcu.get('/lol-lobby/v2/lobby').catch(() => null);
    this.party = new Map();
    for (const m of lobby?.members ?? []) {
      const name = m.gameName || m.summonerName;
      if (!name) continue;
      if (m.puuid) this.party.set(m.puuid, name);
      if (m.summonerId) this.party.set(String(m.summonerId), name);
    }
    return this.party;
  }

  // The champ select session in her terms.
  async read(session) {
    await this.champions();
    const party = await this.partyNames();
    const cell = session.localPlayerCellId;
    const me = (session.myTeam ?? []).find((p) => p.cellId === cell);
    const actions = (session.actions ?? []).flat();
    const mine = actions.filter((a) => a.actorCellId === cell);
    const locked = new Set(actions.filter((a) => a.type === 'pick' && a.completed).map((a) => a.actorCellId));
    const player = (p, id) => ({ id, ...this.champ(id), role: FROM_LCU[p.assignedPosition] ?? null, locked: locked.has(p.cellId) });
    const pickAction = mine.find((a) => a.type === 'pick' && !a.completed) ?? null;
    const bans = new Set([...(session.bans?.myTeamBans ?? []), ...(session.bans?.theirTeamBans ?? []), ...actions.filter((a) => a.type === 'ban' && a.completed).map((a) => a.championId)]);
    bans.delete(0);
    const myLock = mine.find((a) => a.type === 'pick' && a.completed);
    // Teammates on your squad: by the name the client shows, else your party's.
    const friend = (p) => {
      const visible = p.nameVisibilityType !== 'HIDDEN' && p.gameName;
      return this.squad.find(visible ? p.gameName : (party.get(p.puuid) ?? party.get(String(p.summonerId)) ?? ''));
    };
    return {
      phase: session.timer?.phase ?? null,
      deadline: Date.now() + Math.max(0, session.timer?.adjustedTimeLeftInPhase ?? 0),
      role: FROM_LCU[me?.assignedPosition] ?? null,
      intent: me?.championPickIntent || (pickAction?.championId ?? 0),
      locked: myLock ? this.champ(myLock.championId) : null,
      turn: mine.find((a) => a.isInProgress && !a.completed) ?? null,
      pickAction,
      allies: (session.myTeam ?? []).filter((p) => p.cellId !== cell && (p.championId || p.championPickIntent)).map((p) => player(p, p.championId || p.championPickIntent)),
      friends: (session.myTeam ?? [])
        .filter((p) => p.cellId !== cell)
        .map((p) => ({ member: friend(p), role: FROM_LCU[p.assignedPosition] ?? null, id: p.championId || p.championPickIntent || 0, locked: locked.has(p.cellId) }))
        .filter((f) => f.member),
      enemies: (session.theirTeam ?? []).filter((p) => p.championId).map((p) => player(p, p.championId)),
      bans: [...bans].map((id) => ({ id, ...this.champ(id) })),
    };
  }

  // Live champ select, or null when there isn't one.
  async live() {
    const phase = await this.lcu.get('/lol-gameflow/v1/gameflow-phase');
    if (phase !== 'ChampSelect') return { phase };
    const session = await this.lcu.get('/lol-champ-select/v1/session');
    return session ? { phase, draft: await this.read(session) } : { phase };
  }

  // A squad player's pool for a role (or all their roles) as champion keys.
  poolOf(player, role, stats) {
    if (!player) return new Set();
    const roles = role ? [SQUAD_ROLE[role]] : Object.keys(player.champions ?? {});
    const keys = new Set();
    for (const r of roles) {
      for (const key of this.squad.pool(player, r, { resolve: (name) => this.resolve(name, stats), catalog: this.champs?.catalog ?? new Map() })) keys.add(key);
    }
    return keys;
  }

  // Everything you (in your role) and the squad friends in this draft (in
  // theirs) play, which she never suggests banning.
  squadPools(friends, myRole, stats) {
    const keys = new Set(this.poolOf(this.squad.me(), myRole, stats));
    for (const f of friends ?? []) {
      const role = f.role ?? FROM_WORDS[keyOf(f.member?.roles?.[0] ?? '')] ?? null;
      for (const key of this.poolOf(f.member, role, stats)) keys.add(key);
    }
    return keys;
  }

  // A champion name to a key: the client's list first, then pro data.
  resolve(name, stats) {
    const want = keyOf(name);
    if (this.champs?.catalog.has(want)) return want;
    const alias = ALIASES[want];
    if (alias) return alias;
    return stats?.find(name) ?? [...(this.champs?.catalog.keys() ?? [])].find((key) => key.startsWith(want)) ?? null;
  }

  // Like resolve, but a champion with no games and no catalog entry still
  // counts (as itself): an enemy you named is in the draft either way.
  resolveAny(name, stats) {
    return this.resolve(name, stats) ?? (keyOf(name) || null);
  }

  // Scored picks or bans for a live draft. onlyPool: from your squad pool
  // when anything in it is available (brb).
  async suggest(live, type, n, { skip = new Set(), onlyPool = false } = {}) {
    const stats = await this.stats(false);
    if (!stats) return [];
    const ok = new Set([...(await this.available(type))].map((id) => this.champ(id).key));
    const skipKeys = new Set([...skip].map((id) => this.champ(id).key));
    const taken = [...live.bans, ...live.enemies, ...live.allies.filter((a) => a.locked)].map((p) => p.key);
    const draft = {
      role: live.role,
      allies: live.allies.map(({ key, role }) => ({ key, role })),
      enemies: live.enemies.map(({ key, role }) => ({ key, role })),
      intent: live.intent ? this.champ(live.intent).key : null,
      mastery: await this.masteryByKey(),
    };
    const mine = this.playerData(this.squad.me(), stats, type === 'pick' ? await this.historyByKey() : null);
    draft.history = type === 'pick' ? mine.history : null;
    draft.level = mine.level;
    draft.targeted = this.targeted(stats);
    if (type === 'ban') {
      // Never ban what a teammate wants, or what you or your squad play.
      draft.unavailable = new Set([...taken, ...live.allies.map((a) => a.key), ...skipKeys, ...this.squadPools(live.friends, live.role, stats)]);
      draft.allowed = ok.size ? ok : null;
      return suggestBans(stats, draft, n);
    }
    draft.unavailable = new Set([...taken, ...skipKeys]);
    draft.allowed = ok.size ? ok : null;
    draft.favorites = new Set([...this.poolOf(this.squad.me(), live.role, stats)].filter((key) => !draft.allowed || draft.allowed.has(key)));
    if (onlyPool && [...draft.favorites].some((key) => !draft.unavailable.has(key))) draft.allowed = draft.favorites;
    return suggestPicks(stats, draft, n).picks;
  }

  // Pro stats, loading (and downloading, the first time) if needed.
  async stats(wait = true) {
    if (!this.data) return null;
    let stats = await this.data.load().catch(() => null);
    if (!stats && wait) stats = await this.data.refresh();
    // Champions pros never play still get their real names.
    if (stats) for (const [key, c] of (await this.champions()).catalog) if (!stats.names.has(key)) stats.names.set(key, c.name);
    return stats;
  }

  notice(kind, text, mood) {
    this.emit('notice', { kind, project: 'champ select', text, mood });
  }

  // For /league.
  async describe() {
    await this.data?.load().catch(() => {});
    const client = this.connected ? `client: connected${this.phase ? ` (${this.phase})` : ''}` : 'client: not seen';
    const squad = this.squad.players();
    const key = this.riotKey || process.env.RIOT_API_KEY;
    const solo = !key ? 'no Riot API key (/league key RGAPI-…)' : `${this.soloq.running ? this.soloq.status : 'paused'}${this.soloq.error ? ` (${this.soloq.error})` : ''}`;
    return `champ select watch: ${this.enabled ? 'ON' : 'off'} · brb: ${this.brb ? 'ON' : 'off'} · ${client}\nsquad: ${squad.length ? squad.map((p) => p.name + (p.me ? ' (you)' : '')).join(', ') : 'nobody yet'}\nhigh-elo solo queue: ${solo}\ndata: ${this.data?.describe() ?? 'none'}`;
  }

  // ---- her tools ----------------------------------------------------------------

  // True when a tool call should go through the permission card: locking in
  // or banning is final.
  asks(name, input) {
    return name === ACT && Boolean(input?.lock);
  }

  tools(tool) {
    const role = z.enum(['top', 'jungle', 'mid', 'bot', 'support']);
    const names = z.array(z.string());
    const text = (t) => ({ content: [{ type: 'text', text: t }] });
    const guard = (fn) => async (args) => {
      try {
        return text(await fn(args));
      } catch (err) {
        return { content: [{ type: 'text', text: `League: ${err.message}` }], isError: true };
      }
    };
    return [
      tool(
        'league_draft',
        "League of Legends pick advice against an enemy comp: for the user and squad members, the champions strongest into that comp per role (win rates in the role plus every matchup and synergy, from recent pro and high-elo solo queue games), their own pools next to it, the user's own record, and bans. Reads the live champ select from the League client, or takes a draft they describe (enemies/allies/bans). Shows the user a card with champion icons.",
        {
          role: role.optional().describe("The user's role, if the client doesn't assign one"),
          enemies: names.optional().describe('Enemy champions, to use instead of the live draft'),
          allies: names.optional().describe("Teammates' champions, to use instead of the live draft"),
          bans: names.optional().describe('Banned champions, to use instead of the live draft'),
          players: names.optional().describe('Who to plan for: "me" for the user, squad names, "name:role" when the role is fixed; without a role, every role they play is compared'),
        },
        guard((args) => this.draftReport(args)),
        { alwaysLoad: true },
      ),
      tool(
        'league_stats',
        "League of Legends stats from recent pro games and high-elo solo queue: a champion's roles, win rate, pick/ban presence, what it does in a game (damage share, CC, tankiness), its worst and best matchups against its lane and the enemy jungle (or the enemy role you pass as against), and best teammates; one matchup (vs) or duo (with); or a role's most played champions (role without champion).",
        {
          champion: z.string().optional(),
          role: role.optional(),
          vs: z.string().optional().describe('Another champion: their head-to-head record'),
          with: z.string().optional().describe('Another champion: their record on the same team'),
          against: role.optional().describe("List the champion's worst and best matchups against this enemy role (default: its lane and the jungle)"),
        },
        guard((args) => this.statsReport(args)),
      ),
      tool(
        'league_squad',
        "The people the user plays League with (and the user, marked me): in-game name, roles, champion pools per role, notes on how they play. list shows them; save adds a player or updates the fields given (champions maps a role to champion names or a class: tanks, fighters, mages, assassins, marksmen); remove deletes one.",
        {
          action: z.enum(['list', 'save', 'remove']),
          name: z.string().optional().describe('In-game name, without the #tag'),
          me: z.boolean().optional().describe('This player is the user'),
          roles: names.optional().describe('Roles they play, best first'),
          champions: z.record(z.string(), names).optional().describe('Role -> champions, e.g. { "support": ["Shaco", "Pyke"] }'),
          notes: z.string().optional().describe('Rank, strengths, weaknesses, habits'),
          riotId: z.string().optional().describe('Their Riot ID, "name#tag" (several accounts: comma-separated): she reads their recent games for their record and damage level'),
          aka: names.optional().describe('Nicknames the user calls them by'),
          level: z.number().nullable().optional().describe('Damage they deal next to an average player on the same champion: 1 average, 0.66 two thirds. null to measure it from their games instead'),
        },
        guard((args) => this.squadTool(args)),
      ),
      tool(
        'league_team',
        "Checks a whole League team comp for the user's squad: projected damage (each champion's usual share of its team's damage times its player's damage level), AD/AP split, CC, frontline, who carries, the enemy's carry threats (point-and-click CC, easy lockdown), how each pick holds up for its player's level, and better fits for players below average damage.",
        {
          team: names.describe('The picks, as "player:role:champion" ("me" for the user), or "role:champion"'),
          enemies: names.optional().describe('Enemy champions, if known'),
        },
        guard((args) => this.teamReport(args)),
      ),
      tool(
        'league_act',
        "Hover, pick or ban a champion in the user's live League champ select. Without lock it only hovers (or declares their pick intent before their turn); with lock it locks the pick or ban in, which can't be undone. Lock only when the user asked you to.",
        { action: z.enum(['pick', 'ban']), champion: z.string(), lock: z.boolean().optional() },
        guard((args) => this.act(args)),
      ),
      tool(
        'league_brb',
        "Turns League \"brb\" mode on or off. While it's on, Capri accepts the queue for the user, bans for them, and locks in the champion they hovered (or her best pick from their pool) a few seconds before their timer runs out; it turns itself off when their game loads or they change the hover themselves. Turn it on when the user says they're stepping away during queue or champ select.",
        { on: z.boolean() },
        guard(async ({ on }) => {
          this.setBrb(on);
          return on ? 'brb mode on: she accepts the queue, bans, and locks in their hover or her best pick from their pool a few seconds before the timer ends.' : 'brb mode off.';
        }),
      ),
    ];
  }

  async squadTool({ action, name, me, roles, champions, notes, riotId, aka, level }) {
    if (action === 'list') {
      const players = this.squad.players();
      return players.length ? players.map(describePlayer).join('\n') : 'No squad saved yet.';
    }
    if (!name) throw new Error('name is required');
    if (action === 'remove') return this.squad.remove(name) ? `Removed ${name}.` : `No player called ${name}.`;
    const saved = this.squad.save({ name, me, roles, champions, notes, riotId, aka, level });
    if (riotId) this.refreshPlayers();
    return `Saved: ${describePlayer(saved)}`;
  }

  async draftReport({ role, enemies, allies, bans, players } = {}) {
    const stats = await this.stats();
    if (!stats) throw new Error(this.noData());
    const lines = [];
    let live = null;
    try {
      const state = await this.live();
      live = state.draft ?? null;
      if (!live) lines.push(`No live champ select (client: ${state.phase ?? 'unknown'}).`);
    } catch (err) {
      lines.push(`No live champ select (${err.message}).`);
    }
    const resolve = (list) => (list ?? []).map((name) => this.resolveAny(name, stats)).filter(Boolean);
    const described = Boolean(enemies || allies || bans);
    const base = {
      allies: allies ? resolve(allies).map((key) => ({ key, role: null })) : (live?.allies ?? []).map(({ key, role: r }) => ({ key, role: r })),
      enemies: enemies ? resolve(enemies).map((key) => ({ key, role: null })) : (live?.enemies ?? []).map(({ key, role: r }) => ({ key, role: r })),
    };
    const history = this.lcu.creds ? await this.historyByKey() : null;
    const mastery = this.lcu.creds ? await this.masteryByKey() : null;
    const banned = bans ? resolve(bans) : (live?.bans ?? []).map((b) => b.key);
    const taken = new Set([...banned, ...base.enemies.map((e) => e.key), ...(live?.allies ?? []).filter((a) => a.locked).map((a) => a.key), ...(allies ? base.allies.map((a) => a.key) : [])]);
    const owned = live ? new Set([...(await this.available('pick'))].map((id) => this.champ(id).key)) : null;
    const me = this.squad.me();

    // Who to plan for: the players asked about, else you and the squad
    // friends in your lobby. Each gets their given or assigned role, or else
    // every role they play, to compare.
    const myRole = FROM_WORDS[role] ?? live?.role ?? null;
    let plan = players
      ? players.map((entry) => {
          const [name, r] = String(entry).split(':');
          const isMe = /^(me|you|myself)$/i.test(name.trim()) || (me && this.squad.find(name) === me) || false;
          return { name: isMe && me ? me.name : name.trim(), member: isMe ? me : this.squad.find(name), isMe, role: FROM_WORDS[keyOf(r ?? '')] ?? (isMe ? myRole : null) };
        })
      : [{ name: me?.name ?? 'you', member: me, isMe: true, role: myRole }, ...(live?.friends ?? []).map((f) => ({ name: f.member.name, member: f.member, role: f.role, id: f.id, locked: f.locked }))];
    if (players && role && !plan.some((x) => x.isMe)) plan = [{ name: me?.name ?? 'you', member: me, isMe: true, role: myRole }, ...plan];

    if (live && !described) {
      const left = Math.max(0, Math.round((live.deadline - Date.now()) / 1000));
      const turn = live.turn ? `your ${live.turn.type} is in progress, ${left}s left` : live.locked ? `you locked ${live.locked.name}` : 'not your turn';
      lines.push(`Live champ select (${live.phase ?? '?'}): ${turn}.${live.intent && !live.locked ? ` You're hovering ${this.champ(live.intent).name}.` : ''}`);
    } else {
      lines.push('Draft as described (not from the client).');
    }
    const filled = withRoles(stats, { ...base, role: myRole });
    const who = (team) => team.map((x) => `${stats.name(x.key)} (${ROLE_NAMES[x.role] ?? '?'}${x.guessed ? ', guessed' : ''})`).join(', ') || 'none yet';
    lines.push(`Enemies: ${who(filled.enemies)}. Allies: ${who(filled.allies)}.${banned.length ? ` Bans: ${banned.map((k) => stats.name(k)).join(', ')}.` : ''}`);
    lines.push("'draft %' is the champion's chance into these enemies with these allies, whoever plays it: its win rate in the role plus every matchup and synergy, recency-weighted, small samples pulled toward average.");

    const odds = (x) => pct(x.draft);
    const targeted = this.targeted(stats);
    const theirCc = filled.enemies.filter((e) => targeted.has(e.key)).map((e) => stats.name(e.key));
    if (theirCc.length) lines.push(`Enemy carry threats (point-and-click CC or easy lockdown, aimed at your carries): ${theirCc.join(', ')}.`);
    const cards = [];
    const comp = []; // each planned player's best pick in their first role, for the team check
    for (const player of plan) {
      const roles = player.role ? [player.role] : [...new Set((player.member?.roles ?? []).map((r) => FROM_WORDS[keyOf(r)]).filter(Boolean))].slice(0, 3);
      const label = `${player.name}${player.isMe ? ' (the user)' : ''}`;
      const pd = this.playerData(player.member, stats, player.isMe ? history : null);
      lines.push('', player.member ? `${describePlayer(player.member)}` : `${label}: not on the squad, no pool or notes.`);
      if (pd.source) lines.push(`Damage level: ${pct(pd.level)} of an average player (${pd.source}${pd.measured && player.member?.level ? `; measured ${pct(pd.measured.level)} over ${pd.measured.n} games` : ''}).`);
      if (pd.history && pd.games) lines.push(`Their own record: ${pd.games} recent games from their Riot ID.`);
      if (player.id) lines.push(`On ${this.champ(player.id).name} (${player.locked ? 'locked' : 'hovering'}).`);
      if (!roles.length) lines.push(`No role known for ${player.name}: pass it as "${player.name}:role".`);
      for (const r of roles) {
        const favorites = this.poolOf(player.member, r, stats);
        const context = { ...base, role: r, level: pd.level, unavailable: taken, allowed: player.isMe && owned?.size ? owned : null, intent: player.isMe && live?.intent ? this.champ(live.intent).key : null };
        const own = { ...context, favorites, history: pd.history, mastery: player.isMe ? mastery : null };
        // Every champion: what's strong into this comp, for this player's level.
        const strongest = suggestPicks(stats, { ...context, favorites: new Set() }, 6).picks;
        const fits = Math.abs(pd.level - 1) >= 0.05;
        const show = (x) => `${x.name} ${pct(x.win)}${fits ? ` (draft ${odds(x)}, fit for their level ${x.win >= x.draft ? '+' : ''}${Math.round((x.win - x.draft) * 100)})` : ''} [${why(x)}]`;
        lines.push(`${player.name} as ${ROLE_NAMES[r]}, strongest into this comp${fits ? ` for a player at ${pct(pd.level)} damage` : ''}: ${strongest.map((x, i) => `${i + 1}. ${show(x)}`).join('; ') || 'nothing with enough games'}.`);
        const top = strongest[0]?.win ?? 0;
        let pool = [];
        if (favorites.size) {
          pool = scorePool(stats, own, favorites, r);
          lines.push(`  Their pool there: ${pool.slice(0, 4).map((x) => `${x.name} ${pct(x.win)}${top ? ` (${Math.round((x.win - top) * 100)} vs the strongest)` : ''}`).join(', ')}.`);
        }
        let mine = [];
        if (pd.history) {
          mine = suggestPicks(stats, own, 4).picks;
          lines.push(`  Counting their own record (relative to their overall win rate): ${mine.map((x) => `${x.name} ${pct(x.win)} (them ${x.parts.you >= 0 ? '+' : ''}${Math.round((x.win - sigmoidOf(x.score - x.parts.you)) * 100)})`).join(', ')}.`);
        }
        if (r === roles[0]) {
          // Their card: the strongest, plus their own best option.
          const keys = new Set(strongest.slice(0, 4).map((x) => x.key));
          const best = mine[0] ?? pool[0];
          if (best) keys.add(best.key);
          const rows = scorePool(stats, own, keys, r);
          cards.push({ title: `${player.name} · ${ROLE_NAMES[r]}`, picks: rows });
          if (rows[0]) comp.push({ key: rows[0].key, role: r, level: pd.level, name: player.name });
        }
      }
    }
    if (plan.some((x) => x.isMe) && !history && !this.playerData(me, stats).history) lines.push('', "(The user's own record isn't counted: no Riot ID in the squad and the League client isn't running.)");
    // The team they'd field with those picks (and the allies already known).
    for (const ally of filled.allies) if (!comp.some((m) => m.role === ally.role)) comp.push({ key: ally.key, role: ally.role, level: 1 });
    if (comp.length >= 3) {
      const check = teamCheck(stats, comp);
      lines.push('', `Team check, if they take those picks: ${check.lines.join(' ')}${check.warnings?.length ? ` Warnings: ${check.warnings.join('; ')}.` : ''}`);
    }

    let bansFor = [];
    if (!live || live.turn?.type === 'ban' || !banned.length) {
      const mine = plan.find((x) => x.isMe);
      const myTop = mine?.role ? suggestPicks(stats, { ...base, role: mine.role, unavailable: taken }, 1).picks[0]?.key : null;
      const friends = plan.filter((x) => !x.isMe && x.member).map((x) => ({ member: x.member, role: x.role }));
      bansFor = suggestBans(stats, { ...base, targeted, role: mine?.role ?? null, intent: (live?.intent ? this.champ(live.intent).key : null) ?? myTop, unavailable: new Set([...taken, ...base.allies.map((a) => a.key), ...this.squadPools(friends, mine?.role ?? null, stats)]), allowed: null }, 3);
      lines.push('', `Best bans: ${bansFor.map((b, i) => `${i + 1}. ${b.name} (${whyBan(b)})`).join('; ')}.`);
    }
    if (live?.turn?.type === 'ban' && bansFor.length) this.emit('card', await this.banCard(bansFor, ''));
    else for (const card of cards) if (card.picks.length) this.emit('card', await this.pickCard(card.picks, '', false, card.title));

    lines.push('', `Data: ${this.data.describe()}`);
    return lines.join('\n');
  }

  // What to say when there's nothing to score with.
  noData() {
    const key = this.riotKey || process.env.RIOT_API_KEY;
    const solo = !key
      ? 'No Riot API key, so no high-elo solo queue games (/league key RGAPI-…).'
      : this.soloq?.running
        ? `high-elo solo queue: ${this.soloq.status}; the first numbers come within minutes.`
        : `high-elo solo queue: not running${this.soloq?.error ? ` (${this.soloq.error})` : ''}.`;
    return `No data to score with yet. Pro data: ${this.data?.describe() ?? 'none'} ${solo} Say so; don't recommend picks from memory as if they were data.`;
  }

  async teamReport({ team, enemies = [] }) {
    const stats = await this.stats();
    if (!stats) throw new Error(this.noData());
    const me = this.squad.me();
    const members = team.map((entry) => {
      const parts = String(entry).split(':').map((x) => x.trim());
      const [player, role, champ] = parts.length >= 3 ? parts : [null, ...parts];
      const member = player ? (/^(me|you)$/i.test(player) ? me : this.squad.find(player)) : null;
      const r = FROM_WORDS[keyOf(role ?? '')];
      if (!r) throw new Error(`no role in "${entry}" (top, jungle, mid, bot, support)`);
      const pd = this.playerData(member, stats, member === me ? this.history?.byKey ?? null : null);
      return { player: member?.name ?? player, member, role: r, key: this.resolveAny(champ, stats), level: pd.level, pd };
    });
    const foes = withRoles(stats, { role: null, allies: [], enemies: enemies.map((name) => ({ key: this.resolveAny(name, stats), role: null })) }).enemies;
    const check = teamCheck(stats, members.map((m) => ({ key: m.key, role: m.role, level: m.level, name: m.player })));
    const lines = [...check.lines];
    if (check.warnings.length) lines.push(`Warnings: ${check.warnings.join('; ')}.`);
    const targeted = this.targeted(stats);
    const theirCc = foes.filter((e) => targeted.has(e.key)).map((e) => stats.name(e.key));
    if (enemies.length) lines.push(theirCc.length ? `Enemy carry threats (point-and-click CC or easy lockdown): ${theirCc.join(', ')}.` : 'No carry threats on the enemy team.');
    for (const m of members) {
      const allies = members.filter((x) => x !== m).map((x) => ({ key: x.key, role: x.role }));
      const context = { role: m.role, allies, enemies: foes, level: m.level, history: m.pd.history, unavailable: new Set([...members.map((x) => x.key), ...foes.map((e) => e.key)]) };
      const [now] = scorePool(stats, { ...context, unavailable: new Set(foes.map((e) => e.key)) }, new Set([m.key]), m.role);
      const head = `${m.player ?? ROLE_NAMES[m.role]} on ${stats.name(m.key)} (${ROLE_NAMES[m.role]}${m.level !== 1 ? `, damage level ${pct(m.level)}${m.pd.source ? ` ${m.pd.source}` : ''}` : ''}): ${now ? `${pct(now.win)} [${why(now)}]` : 'no data'}`;
      let better = '';
      if (m.level < 0.9 || (now && now.win < 0.49)) {
        const alt = suggestPicks(stats, context, 3).picks.filter((x) => x.win > (now?.win ?? 0) + 0.005);
        if (alt.length) better = ` Better fits there: ${alt.map((x) => `${x.name} ${pct(x.win)} [${why(x)}]`).join('; ')}.`;
      }
      lines.push(`- ${head}.${better}`);
    }
    lines.push('', `Data: ${this.data.describe()}`);
    return lines.join('\n');
  }

  async statsReport({ champion, role, vs, with: duo, against } = {}) {
    const stats = await this.stats();
    if (!stats) throw new Error(this.noData());
    const find = (name) => {
      const key = stats.find(name);
      if (!key) throw new Error(`no games with "${name}"`);
      return key;
    };
    const r = FROM_WORDS[role] ?? null;
    const rate = (rec) => (rec.g ? `${pct(rec.w / rec.g)} in ${rec.n}` : 'no games');
    if (!champion) {
      const roles = r ? [r] : ['top', 'jng', 'mid', 'bot', 'sup'];
      return roles.map((x) => `${ROLE_NAMES[x]}: ${stats.top(x, r ? 12 : 6).map((c) => `${c.name} ${rate(c.rec)}`).join(', ')}`).join('\n') + `\n\nData: ${this.data.describe()}`;
    }
    const key = find(champion);
    const name = stats.name(key);
    const main = r ?? stats.roleShares(key)[0][0];
    const lines = [];
    if (vs) {
      const other = find(vs);
      lines.push(`${name} vs ${stats.name(other)}: ${rate(stats.laneRec(main, key, other))} as lane opponents (${ROLE_NAMES[main]}), ${rate(stats.vsRec(key, other))} on opposite teams in any role.`);
    }
    if (duo) {
      const other = find(duo);
      lines.push(`${name} with ${stats.name(other)}: ${rate(stats.duoRec(key, other))} on the same team.`);
    }
    if (!vs && !duo) {
      const p = stats.presence(key);
      lines.push(`${name}: picked in ${p.picks}, banned in ${p.bans} of ${stats.total.n} games (${pct(p.rate)} presence).`);
      const prof = stats.profileOf(key, main);
      if (prof?.n >= 10) lines.push(`In high-elo solo queue as ${ROLE_NAMES[main]} (${prof.n} games): ${pct(prof.dmg)} of its team's damage (${pct(prof.ap)} magic), ${prof.cc?.toFixed(1) ?? '?'} enemies immobilized a game, takes ${pct(prof.tank)} of its team's damage. Wins ${prof.low.g ? pct(prof.low.w / prof.low.g) : '?'} of its low-damage games and ${prof.high.g ? pct(prof.high.w / prof.high.g) : '?'} of its high-damage ones.`);
      lines.push(`Roles: ${stats.roleShares(key).filter(([, share]) => share > 0.02).map(([x, share]) => `${ROLE_NAMES[x]} ${pct(share)} (${rate(stats.roles(key)[x])})`).join(', ')}.`);
      // Matchups by enemy role (its lane, the jungle, the other half of bot
      // lane), ranked by the win rate pulled toward its average, so a 2-0
      // doesn't top the list; only records with MIN_SHOWN games.
      const base = stats.roles(key)[main];
      const avg = (base.w + 300 * 0.5) / (base.g + 300);
      const adjusted = (r) => (r.w + 100 * avg) / (r.g + 100);
      const roles = against ? [FROM_WORDS[keyOf(against)]].filter(Boolean) : [...new Set([main, main === 'jng' ? 'mid' : 'jng', ...(main === 'bot' ? ['sup'] : main === 'sup' ? ['bot'] : [])])];
      for (const enemyRole of roles) {
        const list = [];
        for (const [k, rec] of stats.cross) {
          const [ra, a, rb, b] = k.split('|');
          if (ra === main && a === key && rb === enemyRole && rec.n >= MIN_SHOWN) list.push({ vs: stats.name(b), rec, adj: adjusted(rec) });
        }
        list.sort((x, y) => x.adj - y.adj);
        const label = enemyRole === main ? `lane (${ROLE_NAMES[main]})` : `enemy ${ROLE_NAMES[enemyRole]}`;
        if (!list.length) {
          lines.push(`Against the ${label}: no matchup with ${MIN_SHOWN}+ games yet.`);
          continue;
        }
        const show = (x) => `${x.vs} ${rate(x.rec)} (adjusted ${pct(x.adj)})`;
        lines.push(`Worst against the ${label}: ${list.slice(0, 4).map(show).join(', ')}.`);
        lines.push(`Best against the ${label}: ${list.slice(-4).reverse().map(show).join(', ')}.`);
      }
      const mates = [];
      for (const [k, rec] of stats.duo) {
        const [a, b] = k.split('|');
        if (a === key && rec.n >= MIN_SHOWN) mates.push({ name: stats.name(b), rec, adj: adjustedPair(rec, avg) });
      }
      mates.sort((a, b) => b.adj - a.adj);
      if (mates.length) lines.push(`Best teammates (${MIN_SHOWN}+ games): ${mates.slice(0, 4).map((m) => `${m.name} ${rate(m.rec)}`).join(', ')}.`);
    }
    lines.push(`Data: ${this.data.describe()}`);
    return lines.join('\n');
  }

  async act({ action, champion, lock = false }) {
    const state = await this.live();
    if (!state.draft) throw new Error(`not in champ select (client: ${state.phase ?? 'unknown'})`);
    const live = state.draft;
    const key = this.resolve(champion, await this.stats(false));
    const id = key && this.champs.byKey.get(key);
    if (!id) throw new Error(`no champion called "${champion}"`);
    const { name } = this.champ(id);
    if (!(await this.available(action)).has(id)) throw new Error(`${name} can't be ${action === 'ban' ? 'banned' : 'picked'} right now (taken, banned, or not owned)`);
    const turn = live.turn?.type === action ? live.turn : null;
    const target = turn ?? (action === 'pick' ? live.pickAction : null);
    if (!target) throw new Error(`it's not your ${action} turn`);
    await this.lcu.patch(`/lol-champ-select/v1/session/actions/${target.id}`, { championId: id });
    // Her own hover isn't you coming back.
    if (this.brb) this.mine.set(target.id, id);
    if (!lock) return turn ? `Hovering ${name}.` : `Declared ${name} as the pick intent (not their turn yet).`;
    if (!turn) return `Hovered ${name}, but it's not their ${action} turn yet, so it can't be locked.`;
    await this.lcu.post(`/lol-champ-select/v1/session/actions/${target.id}/complete`);
    return `${action === 'ban' ? 'Banned' : 'Locked in'} ${name}.`;
  }
}

const sigmoidOf = (x) => 1 / (1 + Math.exp(-x));
const adjustedPair = (r, avg) => (r.w + 300 * avg) / (r.g + 300);

// The most telling reason for a pick, in a few words.
function reason(pick) {
  const odds = `${pick.name}, ${pct(pick.win)} to win`;
  if (pick.mine?.n >= 5 && pick.parts.you > 0.15) return `${odds}: you're ${pct(pick.mine.w / pick.mine.n)} on it.`;
  if (pick.lane?.n >= 5) return `${odds}: ${pct(pick.lane.wr)} vs ${pick.lane.vs} (${pick.lane.n} games).`;
  const ally = [...pick.allies].sort((a, b) => b.delta - a.delta)[0];
  if (ally?.n >= 5 && ally.delta > 0.05) return `${odds}: ${pct(ally.wr)} with ${ally.with} (${ally.n} games).`;
  if (pick.favorite) return `${odds}, your pool's best into this.`;
  return `${odds}.`;
}

const league = new League();
league.PROMPT = PROMPT;
module.exports = league;
