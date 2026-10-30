// Her notes about you: a short Markdown list she keeps herself, through her
// remember / forget tools, and reads at the start of every conversation. Your
// name, how you like to work, running jokes, what you shipped. Not task
// details, and never secrets. You can read and edit the file (tray › Open
// memory).

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const MAX_LINES = 80;
const HEAD = "# Capri's notes\n\nWhat she remembers about you between conversations. Edit freely.\n\n";

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function file() {
  return path.join(app.getPath('userData'), 'memory.md');
}

function notes() {
  try {
    return fs
      .readFileSync(file(), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('- '));
  } catch {
    return [];
  }
}

function save(lines) {
  fs.writeFileSync(file(), HEAD + lines.slice(-MAX_LINES).join('\n') + '\n');
}

function remember(fact) {
  const text = String(fact).replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!text) return 'nothing to remember.';
  const lines = notes();
  if (lines.some((line) => line.toLowerCase().includes(text.toLowerCase()))) return 'already noted.';
  save([...lines, `- ${text} (${stamp()})`]);
  return 'noted.';
}

// Drops every note that contains `text`.
function forget(text) {
  const needle = String(text).trim().toLowerCase();
  if (!needle) return 'forget what?';
  const lines = notes();
  const kept = lines.filter((line) => !line.toLowerCase().includes(needle));
  if (kept.length === lines.length) return 'no note matches that.';
  save(kept);
  return `forgot ${lines.length - kept.length} note${lines.length - kept.length === 1 ? '' : 's'}.`;
}

// For her prompt at the start of a conversation.
function prompt() {
  const lines = notes();
  return lines.length ? `What you remember about the user (your own notes):\n${lines.join('\n')}` : 'You have no notes about the user yet.';
}

module.exports = { file, notes, remember, forget, prompt };
