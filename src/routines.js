// Prompts for her routines, sent like a message you typed: /recap (the last
// call, from the transcript) and /standup (your work since the last working
// day, from git and your Claude Code sessions). Built here so they carry the
// right folders. Both read local files only: no fetch, no gh, no tickets,
// nothing that reaches a work server.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const LOCAL_ONLY = "Read local files only: no git fetch or pull, no gh, no network calls, and don't create tickets, issues, messages or files anywhere.";

function recap(dir, focus) {
  return [
    `Recap the last call from my transcript in ${dir} (today's file unless I say otherwise). If it has "-- meeting start: <title>" and "-- meeting end: <title>" lines, the last call is the latest meeting between them, and its title is the meeting's; otherwise it's the latest stretch of [call] lines, with the [me] lines around them, back to the previous long gap.`,
    focus ? `Focus on: ${focus}.` : '',
    'Give one line on what it was about, then the decisions, the action items (who → what, with any dates said) and the open questions. Quote times. Keep it short, it goes in the chat.',
    LOCAL_ONLY,
  ]
    .filter(Boolean)
    .join('\n');
}

function standup(dir, extra) {
  const since = lastWorkday();
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${since.getFullYear()}-${pad(since.getMonth() + 1)}-${pad(since.getDate())}`;
  const projects = recentProjects(since);
  return [
    `Draft my standup: what I did since ${day}, what I'm on today, and blockers.`,
    projects.length ? `Folders I worked in, from my Claude Code sessions: ${projects.join(', ')}.` : '',
    `Use \`git log --since="${day} 00:00" --author="$(git config user.email)" --oneline\` in those folders, my Claude Code sessions there if that helps, and my transcript in ${dir} for meetings.`,
    LOCAL_ONLY,
    'Then write 3 to 8 short bullets in English, plain and without persona, ready to paste.',
    extra ? `Also: ${extra}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// Midnight on the last working day: Friday on a Monday, yesterday otherwise.
function lastWorkday(now = new Date()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (d.getDay() === 1 ? 3 : d.getDay() === 0 ? 2 : 1));
  return d;
}

// Folders with a Claude Code session since `since`, from the "cwd" each
// session file records.
function recentProjects(since) {
  const found = new Set();
  for (const name of list(PROJECTS)) {
    const dir = path.join(PROJECTS, name);
    for (const file of list(dir).filter((f) => f.endsWith('.jsonl'))) {
      const full = path.join(dir, file);
      try {
        if (fs.statSync(full).mtimeMs < since.getTime()) continue;
        const head = fs.readFileSync(full, 'utf8').slice(0, 20000);
        const cwd = head.match(/"cwd":"([^"]+)"/)?.[1];
        if (cwd && cwd !== os.homedir()) found.add(cwd);
        break;
      } catch {
        // Unreadable session file: skip it.
      }
    }
  }
  return [...found].slice(0, 12);
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

module.exports = { recap, standup, lastWorkday };
