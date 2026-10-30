// Voice notes and reminders, handled right here with no model call: "note:
// …" lands in a dated Markdown file, "remind me in 20 minutes to …" sets a
// timer that survives restarts. French and English. Anything that doesn't
// match goes to her as a normal message.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app } = require('electron');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const NOTE = /^\W*(?:note(?:\s+(?:that|que))?|take a note|write (?:this )?down|prends? (?:une )?note|note[- ]le)\s*[:,.-]?\s+(.+)$/is;
const REMIND = /^\W*(?:remind me|rappelle[- ]moi)\s+(.+)$/is;
const UNIT = { s: 1, sec: 1, second: 1, seconde: 1, m: 60, min: 60, minute: 60, h: 3600, hr: 3600, hour: 3600, heure: 3600 };
// "in 20 minutes to check X" / "dans 20 min de vérifier X"
const IN = /^(?:in|dans)\s+(\d+(?:[.,]\d+)?)\s*([a-zé]+?)s?\b\s*(?:to|de|d'|that|que|of|:)?\s*(.+)$/i;
// "at 15:30 to call Y" / "à 15h30 d'appeler Y"
const AT = /^(?:at|à|a)\s+(\d{1,2})(?:[:h](\d{2})?)?\s*(am|pm)?\s*(?:to|de|d'|that|que|:)?\s*(.+)$/i;

class Notes extends EventEmitter {
  constructor() {
    super();
    this.timers = new Map();
  }

  get notesFile() {
    return path.join(app.getPath('userData'), 'notes.md');
  }

  get remindersFile() {
    return path.join(app.getPath('userData'), 'reminders.json');
  }

  // What to do with something you said: { kind: 'note', text } |
  // { kind: 'remind', at, text } | null.
  parse(said, now = new Date()) {
    const note = said.match(NOTE);
    if (note) return { kind: 'note', text: note[1].trim() };
    const remind = said.match(REMIND);
    if (!remind) return null;
    const rest = remind[1].trim();
    const inMatch = rest.match(IN);
    if (inMatch) {
      const unit = UNIT[inMatch[2].toLowerCase().replace(/s$/, '')] ?? (inMatch[2].toLowerCase().startsWith('min') ? 60 : null);
      if (unit) return { kind: 'remind', at: now.getTime() + Number(inMatch[1].replace(',', '.')) * unit * 1000, text: inMatch[3].trim() };
    }
    const atMatch = rest.match(AT);
    if (atMatch) {
      let hour = Number(atMatch[1]);
      if (atMatch[3]?.toLowerCase() === 'pm' && hour < 12) hour += 12;
      const at = new Date(now);
      at.setHours(hour, Number(atMatch[2] ?? 0), 0, 0);
      if (at <= now) at.setDate(at.getDate() + 1);
      return { kind: 'remind', at: at.getTime(), text: atMatch[4].trim() };
    }
    return null;
  }

  addNote(text, now = new Date()) {
    const head = fs.existsSync(this.notesFile) ? '' : '# Notes\n\nWhat you told Capri to note down.\n\n';
    fs.appendFileSync(this.notesFile, `${head}- ${stamp(now)} ${text}\n`);
  }

  // ---- reminders ---------------------------------------------------------------

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.remindersFile, 'utf8'));
    } catch {
      return [];
    }
  }

  save(list) {
    fs.writeFileSync(this.remindersFile, JSON.stringify(list, null, 2));
  }

  addReminder(at, text) {
    const reminder = { id: `${at}-${Math.random().toString(36).slice(2, 7)}`, at, text };
    this.save([...this.load(), reminder]);
    this.schedule(reminder);
    return reminder;
  }

  list() {
    return this.load().sort((a, b) => a.at - b.at);
  }

  cancel(id) {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.save(this.load().filter((r) => r.id !== id));
  }

  // At start: schedule what's pending; anything missed while she was off
  // fires now.
  start() {
    for (const reminder of this.load()) this.schedule(reminder);
  }

  schedule(reminder) {
    const delay = Math.max(0, reminder.at - Date.now());
    // setTimeout tops out at ~24.8 days; check back later for longer ones.
    const timer = setTimeout(() => (delay > 2 ** 31 - 1 ? this.schedule(reminder) : this.fire(reminder)), Math.min(delay, 2 ** 31 - 1));
    this.timers.set(reminder.id, timer);
  }

  fire(reminder) {
    this.timers.delete(reminder.id);
    this.save(this.load().filter((r) => r.id !== reminder.id));
    this.emit('due', reminder);
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

// "in 20 min" / "at 15:30", for her confirmation.
function when(at, now = Date.now()) {
  const minutes = Math.round((at - now) / 60000);
  if (minutes < 60) return `in ${Math.max(1, minutes)} min`;
  const d = new Date(at);
  return `at ${pad(d.getHours())}:${pad(d.getMinutes())}${d.getDate() !== new Date(now).getDate() ? ' tomorrow' : ''}`;
}

module.exports = { notes: new Notes(), when };
