// The always-on log: one Markdown file per day, a line per thing said, kept
// for two weeks in the app's data folder. She reads it (Read / Grep) when you
// ask what was said.

const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = Number(process.env.CAPRI_TRANSCRIPT_DAYS) || 14;

const pad = (n) => String(n).padStart(2, '0');
const day = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const time = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

class Transcript {
  constructor(dir) {
    this.dir = dir;
  }

  // source: 'me' (the mic) or 'call' (the computer's audio).
  add(source, text, at = new Date()) {
    this.write(at, `${time(at)} [${source}] ${text}`);
  }

  // A line about the log itself (listening on / off).
  mark(text, at = new Date()) {
    this.write(at, `${time(at)} -- ${text}`);
  }

  write(at, line) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const file = path.join(this.dir, `${day(at)}.md`);
      const head = fs.existsSync(file) ? '' : `# ${day(at)}\n\n[me] is the microphone (you and anyone in the room), [call] is the computer's audio. Speech recognition, so names and jargon can be off.\n\n`;
      fs.appendFileSync(file, `${head}${line}\n`);
    } catch (err) {
      console.warn(`[capri] transcript: ${err.message}`);
    }
  }

  prune(now = Date.now()) {
    const cutoff = day(new Date(now - KEEP_DAYS * 86400000));
    for (const name of list(this.dir)) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name) && name.slice(0, 10) < cutoff) fs.rmSync(path.join(this.dir, name), { force: true });
    }
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

module.exports = { Transcript };
