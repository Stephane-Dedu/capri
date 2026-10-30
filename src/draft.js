// Draft math for League champ select: a chance of winning for each pick, from
// pro and high-elo solo queue games (prodata.js) and the player's own games. In log-odds, so the
// parts add up:
//
//   win = how the champion does in pro play and high-elo solo queue in that role
//       + its record against the lane opponent (both of them in bot lane),
//         and less so against the other enemies
//       + its record with the teammates' champions
//       + the player's own edge on it: their recent games on it (match
//         history), pulled toward what their mastery and pool say
//
// Small samples are pulled toward a prior (shrink), so one lucky 3-0 doesn't
// outrank a 300-game record. Enemy roles are hidden in ranked champ select,
// so they're guessed from where pros play each champion. Expect most picks
// between 45% and 60%: a single draft rarely moves a game more than that.

const { ROLES, ROLE_NAMES } = require('./prodata');

// Games' worth of pull toward the prior. Real differences are small (a
// champion's win rate in its role spreads about 3 points, a lane matchup
// about 4), so it takes hundreds of games before a record says much:
// that's what keeps a 2-0 from looking like a hard counter.
const PRIOR = { role: 300, lane: 150, pair: 300 };
const SKILL_PRIOR = 25; // the player's own record on a champion
// Fewest games before a matchup shows up as a reason.
const SHOW = { lane: 8, pair: 15 };
// Role-aware records (Sylas mid against Lee Sin jungle) take over from
// any-role ones once they have this many games.
const ROLE_PAIR = 20;
const LANE = 1; // weight of the lane opponent
const BOT_LANE = 0.6; // the other half of bot lane, for a bot or support
const OTHER_ENEMY = 0.35;
const ALLY = 0.3;
const MIN_GAMES = 5; // games in the role before it's a candidate
const POPULAR = 0.06; // bans only: per log-game, pros playing it says it's strong
const TARGETED_BAN = 0.15; // bans: a carry threat from league.js's list
// Bans: heavy CC that still wins when its player is behind, from the high-elo
// profiles (per 100% more CC than the role's usual, and per log-odds of
// low-damage resilience).
const LOCKDOWN_CC = 0.15;
const LOCKDOWN_LOW = 0.3;
// A player's damage level (squad.js) away from 1 by this much leans fully on
// how the champion does in its low- or high-damage games.
const LEVEL_SPAN = 0.34;
const SPLIT_PRIOR = 60;

const clamp = (p) => Math.min(0.97, Math.max(0.03, p));
const logit = (p) => Math.log(clamp(p) / (1 - clamp(p)));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const shrink = (rec, prior, k) => (rec.w + k * prior) / (rec.g + k);
const pct = (p) => `${Math.round(p * 100)}%`;

// Most likely roles for champions whose role isn't known: the assignment of
// free roles that pros' habits make most likely. Brute force, at most 5!.
function inferRoles(stats, champs, taken = []) {
  const free = ROLES.filter((role) => !taken.includes(role));
  let best = { score: -Infinity, roles: [] };
  const share = (key, role) => {
    const roles = stats.roles(key);
    const total = Object.values(roles).reduce((sum, r) => sum + r.g, 0);
    return Math.log((roles[role].g + 0.1) / (total + 0.5));
  };
  const walk = (i, used, roles, score) => {
    if (i === champs.length) {
      if (score > best.score) best = { score, roles: [...roles] };
      return;
    }
    for (const role of free) {
      if (used.has(role)) continue;
      used.add(role);
      roles.push(role);
      walk(i + 1, used, roles, score + share(champs[i], role));
      roles.pop();
      used.delete(role);
    }
  };
  if (champs.length <= free.length) walk(0, new Set(), [], 0);
  return champs.map((key, i) => best.roles[i] ?? stats.roleShares(key)[0][0]);
}

// Fills in missing roles on both teams. draft: { role, allies: [{ key, role }],
// enemies: [{ key, role }] }.
function withRoles(stats, draft) {
  const fill = (team, taken) => {
    const unknown = team.filter((p) => !p.role);
    const guessed = inferRoles(stats, unknown.map((p) => p.key), [...taken, ...team.filter((p) => p.role).map((p) => p.role)]);
    return team.map((p) => (p.role ? p : { ...p, role: guessed[unknown.indexOf(p)], guessed: true }));
  };
  return { ...draft, allies: fill(draft.allies, draft.role ? [draft.role] : []), enemies: fill(draft.enemies, []) };
}

// The player's own edge on a champion, in log-odds: how much better they do
// on it than on everything else (draft.history: Map key -> { n, w }), so a
// player who wins a lot overall doesn't get every pick inflated. Their record
// on it is pulled toward their overall rate, nudged up a little by mastery
// and their pool before any games. Champions they don't play count as their
// average, not as a penalty. Records with roles (from a Riot ID) count the
// same role fully and the champion's other roles half.
function record(draft, key, role) {
  const rec = draft.history?.get(key);
  if (!rec) return { n: 0, w: 0 };
  if (!rec.roles || !role) return rec;
  const same = rec.roles[role] ?? { n: 0, w: 0 };
  return { n: same.n + 0.5 * (rec.n - same.n), w: same.w + 0.5 * (rec.w - same.w) };
}

function skill(draft, key, role) {
  if (!draft.history) return 0;
  let n = 0;
  let w = 0;
  for (const rec of draft.history.values()) {
    n += rec.n;
    w += rec.w;
  }
  const overall = (w + 20 * 0.5) / (n + 20);
  const mine = record(draft, key, role);
  const points = draft.mastery?.get(key) ?? 0;
  const prior = overall + Math.min(0.03, 0.01 * Math.log2(1 + points / 20000)) + (draft.favorites?.has(key) ? 0.01 : 0);
  return logit((mine.w + SKILL_PRIOR * prior) / (mine.n + SKILL_PRIOR)) - logit(overall);
}

// How a champion suits a player who deals less (or more) damage than
// average: its win rate in its own low- (high-) damage games, next to the
// role's. A safe tank barely drops when its player deals little; a mage
// whose only job is damage drops a lot. In log-odds, with the evidence.
function levelEdge(stats, key, role, level) {
  if (!level || Math.abs(level - 1) < 0.05 || !stats.roleSplit) return { edge: 0 };
  const side = level < 1 ? 'low' : 'high';
  const prof = stats.profileOf(key, role);
  const avgRec = stats.roleSplit[role][side];
  const avg = avgRec.g ? avgRec.w / avgRec.g : 0.5;
  if (!prof) return { edge: 0 };
  const mine = shrink(prof[side], avg, SPLIT_PRIOR);
  const weight = Math.min(1, Math.abs(1 - level) / LEVEL_SPAN);
  return { edge: weight * (logit(mine) - logit(avg)), side, wr: prof[side].g ? prof[side].w / prof[side].g : null, avg, n: prof[side].n };
}

// The chance of winning with one champion in a role, with the evidence.
// draft.level: the player's damage level (1 average).
function scorePick(stats, draft, key, role) {
  const rec = stats.roles(key)[role];
  const base = shrink(rec, 0.5, PRIOR.role);
  const fit = levelEdge(stats, key, role, draft.level);
  const parts = { pro: logit(base), lane: 0, enemies: 0, allies: 0, you: skill(draft, key, role), level: fit.edge };
  const evidence = { lane: null, enemies: [], allies: [] };
  const botLane = { bot: 'sup', sup: 'bot' }[role];
  for (const enemy of draft.enemies) {
    if (enemy.role === role) {
      const r = stats.laneRec(role, key, enemy.key);
      parts.lane += LANE * (logit(shrink(r, base, PRIOR.lane)) - logit(base));
      evidence.lane = { vs: stats.name(enemy.key), n: r.n, wr: r.g ? r.w / r.g : null, guessed: Boolean(enemy.guessed) };
    } else {
      const inRoles = enemy.role && stats.crossRec ? stats.crossRec(role, key, enemy.role, enemy.key) : null;
      const r = inRoles?.n >= ROLE_PAIR ? inRoles : stats.vsRec(key, enemy.key);
      const delta = (enemy.role === botLane ? BOT_LANE : OTHER_ENEMY) * (logit(shrink(r, base, PRIOR.pair)) - logit(base));
      parts.enemies += delta;
      if (r.n) evidence.enemies.push({ vs: stats.name(enemy.key), n: r.n, wr: r.w / r.g, delta });
    }
  }
  for (const ally of draft.allies) {
    const inRoles = ally.role && stats.mateRec ? stats.mateRec(role, key, ally.role, ally.key) : null;
    const r = inRoles?.n >= ROLE_PAIR ? inRoles : stats.duoRec(key, ally.key);
    const delta = ALLY * (logit(shrink(r, base, PRIOR.pair)) - logit(base));
    parts.allies += delta;
    if (r.n) evidence.allies.push({ with: stats.name(ally.key), n: r.n, wr: r.w / r.g, delta });
  }
  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return {
    key,
    name: stats.name(key),
    role,
    win: sigmoid(score),
    // The draft alone: this champion into these enemies, with these allies,
    // whoever plays it.
    draft: sigmoid(score - parts.you - parts.level),
    fit: fit.side ? fit : null,
    score,
    parts,
    games: rec.n,
    wr: rec.g ? rec.w / rec.g : null,
    mastery: draft.mastery?.get(key) ?? 0,
    mine: draft.history ? record(draft, key, role) : null,
    favorite: Boolean(draft.favorites?.has(key)),
    ...evidence,
  };
}

// The best picks for the player, by chance of winning. draft: { role (or
// null: every free role), allies, enemies, unavailable: Set of keys, allowed:
// Set of keys or null (what they own), mastery: Map key -> points, history:
// Map key -> { n, w }, intent: key they hovered, favorites: Set of keys from
// their pool }. Their intent and favorites are candidates even with few pro
// games.
function suggestPicks(stats, draft, n = 5) {
  draft = withRoles(stats, draft);
  const roles = draft.role ? [draft.role] : ROLES.filter((r) => !draft.allies.some((a) => a.role === r));
  const always = new Set([...(draft.favorites ?? []), ...(draft.intent ? [draft.intent] : [])]);
  const out = [];
  for (const role of roles) {
    for (const key of new Set([...stats.role.keys(), ...always])) {
      if (draft.unavailable?.has(key) || (draft.allowed && !draft.allowed.has(key))) continue;
      if (stats.roles(key)[role].n < MIN_GAMES && !always.has(key)) continue;
      out.push(scorePick(stats, draft, key, role));
    }
  }
  return { picks: out.sort((a, b) => b.score - a.score).slice(0, n), draft };
}

// One player's own pool for their role, scored for this draft, best first.
function scorePool(stats, draft, keys, role) {
  draft = withRoles(stats, { ...draft, role });
  return [...keys].filter((key) => !draft.unavailable?.has(key)).map((key) => scorePick(stats, draft, key, role)).sort((a, b) => b.score - a.score);
}

// Bans: champions that are strong in pro play, banned a lot by pros, and
// good against what the player wants to play. Never one a teammate hovered.
function suggestBans(stats, draft, n = 3) {
  draft = withRoles(stats, draft);
  const mine = draft.intent ?? null;
  const out = [];
  for (const [key, byRole] of stats.role) {
    if (draft.unavailable?.has(key) || (draft.allowed && !draft.allowed.has(key)) || key === mine) continue;
    const [main] = stats.roleShares(key)[0];
    const rec = byRole[main];
    if (rec.n < MIN_GAMES) continue;
    const base = shrink(rec, 0.5, PRIOR.role);
    const banned = stats.bans.get(key)?.g ?? 0;
    let score = logit(base) + POPULAR * Math.log1p(rec.g) + 0.08 * Math.log1p(banned);
    let threat = null;
    const targeted = Boolean(draft.targeted?.has(key));
    if (targeted) score += TARGETED_BAN;
    // Lockdown that works from behind: the "easy champion that still shuts
    // down a good player" kind, measured.
    const prof = stats.profileOf?.(key, main);
    const avg = stats.roleAvg?.[main];
    let lockdown = 0;
    if (prof?.n >= 20 && avg?.cc) {
      const moreCc = Math.max(0, (prof.cc ?? 0) / avg.cc - 1);
      const fromBehind = Math.max(0, levelEdge(stats, key, main, 0.66).edge);
      lockdown = LOCKDOWN_CC * Math.min(1, moreCc) + LOCKDOWN_LOW * fromBehind;
      score += lockdown;
    }
    if (mine && draft.role && main === draft.role) {
      const r = stats.laneRec(draft.role, key, mine);
      const delta = Math.max(0, logit(shrink(r, base, PRIOR.lane)) - logit(base));
      score += delta;
      if (r.n) threat = { vs: stats.name(mine), n: r.n, wr: r.w / r.g };
    }
    out.push({ key, name: stats.name(key), role: main, score, games: rec.n, wr: rec.g ? rec.w / rec.g : null, presence: stats.presence(key).rate, threat, targeted, lockdown });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, n);
}

// Short reasons for a pick, most telling first, for her card and the tools.
// pool: how to say it's in the player's pool.
// Matchups first: what makes it strong or weak into this comp, then the
// player, then its overall record in the role.
function tags(pick, { pool = 'your pool' } = {}) {
  const out = [];
  if (pick.lane?.n >= SHOW.lane) out.push(`${pct(pick.lane.wr)} vs ${pick.lane.vs} (${pick.lane.n})`);
  for (const enemy of [...pick.enemies].filter((e) => e.n >= SHOW.pair && Math.abs(e.delta) > 0.01).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 2)) {
    out.push(`${pct(enemy.wr)} vs ${enemy.vs} (${enemy.n})`);
  }
  const ally = [...pick.allies].sort((a, b) => b.delta - a.delta)[0];
  if (ally && ally.n >= SHOW.pair && ally.delta > 0.01) out.push(`${pct(ally.wr)} with ${ally.with} (${ally.n})`);
  if (pick.fit?.n >= 10 && Math.abs(pick.parts.level) > 0.02) out.push(`${pct(pick.fit.wr)} in its ${pick.fit.side}-damage games (role ${pct(pick.fit.avg)})`);
  const edge = Math.round((pick.win - pick.draft) * 100);
  if (pick.mine?.n >= 1) out.push(`you ${pct(pick.mine.w / pick.mine.n)} in ${Math.round(pick.mine.n)} (${edge >= 0 ? '+' : ''}${edge})`);
  else if (pick.favorite) out.push(pool);
  else if (pick.mine && pick.mastery < 10000) out.push("you don't play it");
  out.push(pick.games ? `${pct(pick.wr ?? 0.5)} ${ROLE_NAMES[pick.role]} (${pick.games})` : `no games ${ROLE_NAMES[pick.role]}`);
  return out;
}

function why(pick, opts) {
  return tags(pick, opts).join(' · ');
}

function banTags(ban) {
  const out = [`${pct(ban.presence)} pick/ban`, `${pct(ban.wr ?? 0.5)} ${ROLE_NAMES[ban.role]} (${ban.games})`];
  if (ban.lockdown > 0.04) out.unshift('lockdown that wins from behind');
  if (ban.targeted) out.unshift('carry threat');
  if (ban.threat?.n >= SHOW.lane) out.unshift(`${pct(ban.threat.wr)} vs ${ban.threat.vs} (${ban.threat.n})`);
  return out;
}

function whyBan(ban) {
  return banTags(ban).join(' · ');
}

// A whole team at a glance: team = [{ key, role, level, name }]. Damage is
// each champion's usual share of its team's damage times its player's level,
// so 1.0 is a usual team; with AD/AP split, CC (enemies immobilized per
// game), frontline (share of damage taken), who carries, and warnings.
function teamCheck(stats, team) {
  if (!stats.roleAvg) return { lines: ['No team stats yet: they come from high-elo solo queue games with per-player stats.'], warnings: [] };
  const rows = team.map((m) => {
    const prof = stats.profileOf(m.key, m.role);
    const avg = stats.roleAvg[m.role];
    const use = prof?.n >= 10 ? prof : avg;
    const level = m.level ?? 1;
    return { ...m, typical: use.dmg, dmg: use.dmg * level, ap: use.ap, cc: use.cc ?? avg.cc, tank: use.tank, guessed: !(prof?.n >= 10) };
  });
  const damage = rows.reduce((sum, r) => sum + r.dmg, 0);
  const usual = team.reduce((sum, m) => sum + stats.roleAvg[m.role].dmg, 0) || 1;
  const ap = rows.reduce((sum, r) => sum + r.dmg * r.ap, 0) / (damage || 1);
  const cc = rows.reduce((sum, r) => sum + r.cc, 0);
  const usualCc = team.reduce((sum, m) => sum + stats.roleAvg[m.role].cc, 0) || 1;
  const front = Math.max(...rows.map((r) => r.tank));
  const warnings = [];
  const ratio = damage / usual;
  if (ratio < 0.9) warnings.push(`low damage: about ${pct(ratio)} of a usual team's`);
  if (ap < 0.25) warnings.push(`almost all AD (${pct(1 - ap)}): armor shuts it down`);
  if (ap > 0.75) warnings.push(`almost all AP (${pct(ap)}): magic resist shuts it down`);
  if (cc < usualCc * 0.8) warnings.push('little CC');
  if (front < 0.24) warnings.push('no real frontline');
  const carry = [...rows].sort((a, b) => b.dmg - a.dmg);
  const lines = [
    `Damage: ${pct(ratio)} of a usual team's, ${pct(1 - ap)} AD / ${pct(ap)} AP. CC: ${cc.toFixed(1)} immobilizations a game (usual ${usualCc.toFixed(1)}). Frontline: takes up to ${pct(front)} of the team's damage.`,
    `Who deals it: ${carry.map((r) => `${r.name ?? stats.name(r.key)} on ${stats.name(r.key)} ${pct(r.dmg / (damage || 1))}${r.level && r.level !== 1 ? ` (level ${pct(r.level)})` : ''}${r.guessed ? ', role average' : ''}`).join(', ')}.`,
  ];
  return { lines, warnings, ratio, ap, cc, front };
}

module.exports = { teamCheck, levelEdge, suggestPicks, suggestBans, scorePool, inferRoles, withRoles, tags, why, banTags, whyBan, pct };
