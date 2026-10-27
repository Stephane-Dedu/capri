// Adds or removes the Claude Code hooks that report to Capri, in the user's
// ~/.claude/settings.json. Only Capri's own entries are touched, and the
// file is backed up before the first change.
//
// CLI: node src/hooks.js status|install|uninstall [settings.json]

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SCRIPT = path.join(__dirname, '..', 'tools', 'capri-hook.js');
const MARK = 'capri-hook.js';

// Event -> tool matcher (null: every occurrence).
const EVENTS = {
  Stop: null,
  StopFailure: null,
  Notification: null,
  UserPromptSubmit: null,
  PostToolUse: 'Edit|MultiEdit|Write|Bash|PowerShell',
};

// `node "<script>"` runs the same in Git Bash and PowerShell, whichever
// shell Claude Code uses for hooks.
const command = () => `node "${SCRIPT.replaceAll('\\', '/')}"`;

function read(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  if (!text.trim()) return {};
  // Never overwrite a file we can't parse.
  return JSON.parse(text);
}

const ours = (hook) => typeof hook?.command === 'string' && hook.command.includes(MARK);

// Settings with every Capri hook taken out.
function strip(settings) {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !ours(hook)) }))
      .filter((group) => group.hooks.length);
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  const out = { ...settings, hooks };
  if (!Object.keys(hooks).length) delete out.hooks;
  return out;
}

function status(file = SETTINGS) {
  let settings;
  try {
    settings = read(file);
  } catch {
    return 'unreadable';
  }
  const found = Object.keys(EVENTS).filter((event) => (settings.hooks?.[event] ?? []).some((group) => (group.hooks ?? []).some(ours)));
  if (found.length === Object.keys(EVENTS).length) return 'installed';
  return found.length ? 'partial' : 'missing';
}

function write(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = `${file}.capri-backup`;
  if (fs.existsSync(file) && !fs.existsSync(backup)) fs.copyFileSync(file, backup);
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

function install(file = SETTINGS) {
  const settings = strip(read(file));
  settings.hooks ??= {};
  for (const [event, matcher] of Object.entries(EVENTS)) {
    const group = { hooks: [{ type: 'command', command: command(), async: true, timeout: 5 }] };
    if (matcher) group.matcher = matcher;
    settings.hooks[event] = [...(settings.hooks[event] ?? []), group];
  }
  write(file, settings);
}

function uninstall(file = SETTINGS) {
  write(file, strip(read(file)));
}

module.exports = { SETTINGS, EVENTS, status, install, uninstall };

if (require.main === module) {
  const [action = 'status', file = SETTINGS] = process.argv.slice(2);
  if (action === 'install') install(file);
  else if (action === 'uninstall') uninstall(file);
  else if (action !== 'status') {
    console.error('usage: node src/hooks.js status|install|uninstall [settings.json]');
    process.exit(1);
  }
  console.log(`capri hooks in ${file}: ${status(file)}`);
}
