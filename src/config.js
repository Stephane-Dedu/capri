// Capri's settings, kept across restarts in the app's user-data folder.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const DEFAULTS = {
  cwd: process.env.CAPRI_CWD || os.homedir(),
  model: process.env.CAPRI_MODEL || '',
  reactions: true,
  wander: true,
  follow: true, // follow you to whichever desktop / Space you switch to
  look: true, // one look at your screen each time you summon her
  listen: false, // the always-on transcript (mic + computer audio)
  wake: false, // listen for "Capri"
  ptt: true, // hold a key to talk to her
  talk: true, // she answers out loud when you talked to her
  dance: false, // dance when music plays (follows the computer's audio)
  ci: false, // watch CI on your own repos' open PRs
  dailyCap: 0, // stop spending past this many dollars a day (0: no cap)
  sessions: {}, // project folder -> her last session there, for /resume
};

let file = null;
let data = null;

const isDir = (dir) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};

function get() {
  if (data) return data;
  file = path.join(app.getPath('userData'), 'config.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
  if (!isDir(data.cwd)) data.cwd = DEFAULTS.cwd;
  return data;
}

function set(patch) {
  Object.assign(get(), patch);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`[capri] could not save settings: ${err.message}`);
  }
}

module.exports = { get, set, isDir };
