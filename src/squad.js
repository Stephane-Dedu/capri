// Her League squad: the people you play with, by in-game name (no #tag),
// with their roles, champion pools and how they play. You tell her in chat
// (her league_squad tool saves it) or edit squad.json in her League folder.
// Draft advice reads it: your own pool ("me") shapes your suggestions and
// what brb locks in, and friends she spots in your lobby get their pools
// scored against the enemy comp, with your notes on how they play.
//
//   { "players": [{ "name": "Slave Knight", "me": true, "riotId": "Slave Knight#gaell", "aka": ["SK"],
//                   "roles": ["support", "mid"], "level": 1.2,
//                   "champions": { "support": ["Shaco", "Neeko"], "mid": ["Sylas"] },
//                   "notes": "…" }] }
//
// riotId (one, or a list for several accounts) lets her read their recent games (their record per champion, and a
// measured level). level is how much damage they deal next to an average
// player on the same champion: 1 is average, 0.66 two thirds. Set it by hand,
// or leave it out and she measures it from their games.
//
// A pool entry can also be a class: tanks, fighters, mages, assassins,
// marksmen (those come from the League client's champion list).

const fs = require('node:fs');
const path = require('node:path');
const { keyOf } = require('./prodata');

const ROLE_WORDS = { top: 'top', jungle: 'jungle', jng: 'jungle', jg: 'jungle', mid: 'mid', middle: 'mid', bot: 'bot', bottom: 'bot', adc: 'bot', support: 'support', sup: 'support', supp: 'support', utility: 'support' };
const CLASSES = { tank: 'tank', tanks: 'tank', fighter: 'fighter', fighters: 'fighter', bruiser: 'fighter', bruisers: 'fighter', mage: 'mage', mages: 'mage', assassin: 'assassin', assassins: 'assassin', marksman: 'marksman', marksmen: 'marksman', adcs: 'marksman', anyadc: 'marksman' };

const role = (word) => ROLE_WORDS[keyOf(word)] ?? null;

class Squad {
  constructor() {
    this.file = null;
  }

  init(dir) {
    this.file = path.join(dir, 'squad.json');
  }

  players() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return Array.isArray(data.players) ? data.players : [];
    } catch {
      return [];
    }
  }

  write(players) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify({ players }, null, 2)}\n`);
  }

  me() {
    return this.players().find((p) => p.me) ?? null;
  }

  // By in-game name or nickname (aka), ignoring case, spaces and a #tag.
  find(name) {
    const want = keyOf(String(name ?? '').split('#')[0]);
    if (!want) return null;
    const players = this.players();
    return players.find((p) => keyOf(p.name) === want) ?? players.find((p) => (p.aka ?? []).some((a) => keyOf(a) === want)) ?? null;
  }

  // Adds a player or updates the fields given.
  save({ name, me, riotId, aka, roles, champions, notes, level }) {
    const clean = String(name ?? '').split('#')[0].trim();
    if (!clean) throw new Error('a player needs a name');
    const players = this.players();
    let player = players.find((p) => keyOf(p.name) === keyOf(clean)) ?? players.find((p) => (p.aka ?? []).some((a) => keyOf(a) === keyOf(clean)));
    if (!player) players.push((player = { name: clean, roles: [], champions: {}, notes: '' }));
    if (me) for (const p of players) delete p.me;
    if (me) player.me = true;
    if (roles) player.roles = roles.map(role).filter(Boolean);
    if (champions) {
      for (const [r, list] of Object.entries(champions)) {
        const key = role(r);
        if (key) player.champions[key] = list.map((c) => String(c).trim()).filter(Boolean);
      }
    }
    if (notes !== undefined) player.notes = String(notes).trim();
    // One Riot ID, or several (other accounts): "A#1, B#2" or a list.
    if (riotId) {
      const ids = [].concat(riotId).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
      player.riotId = ids.length === 1 ? ids[0] : ids;
    }
    if (aka) player.aka = aka.map((a) => String(a).trim()).filter(Boolean);
    if (level !== undefined) {
      if (level === null) delete player.level;
      else player.level = Math.round(Math.min(2, Math.max(0.3, Number(level) || 1)) * 100) / 100;
    }
    this.write(players);
    return player;
  }

  remove(name) {
    const players = this.players();
    const kept = players.filter((p) => keyOf(p.name) !== keyOf(String(name).split('#')[0]));
    if (kept.length === players.length) return false;
    this.write(kept);
    return true;
  }

  // A player's pool for a role as champion keys. resolve(name) -> key or
  // null; classOf(key) -> the client's classes for it.
  pool(player, roleWord, { resolve, catalog }) {
    const entries = player?.champions?.[role(roleWord) ?? roleWord] ?? [];
    const keys = new Set();
    for (const entry of entries) {
      const cls = CLASSES[keyOf(entry)];
      if (cls) {
        for (const [key, c] of catalog) if (c.classes?.includes(cls)) keys.add(key);
      } else {
        const key = resolve(entry);
        if (key) keys.add(key);
      }
    }
    return keys;
  }
}

function describe(player) {
  const pools = Object.entries(player.champions ?? {})
    .filter(([, list]) => list.length)
    .map(([r, list]) => `${r}: ${list.join(', ')}`)
    .join('; ');
  const level = player.level ? ` Damage level ${Math.round(player.level * 100)}% of an average player (set by hand).` : '';
  const aka = player.aka?.length ? ` (aka ${player.aka.join(', ')})` : '';
  return `${player.name}${aka}${player.me ? ' (the user)' : ''}: plays ${player.roles?.join(', ') || 'any role'}${pools ? ` (${pools})` : ''}.${level}${player.notes ? ` ${player.notes}` : ''}`;
}

module.exports = { Squad, describe, role };
