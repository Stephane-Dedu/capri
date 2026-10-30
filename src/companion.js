// Capri keeping an eye on you. Claude Code sessions in your terminals report
// to her through hooks (tools/capri-hook.js posts each event to a local
// port), and she watches the project folder for files you save. Finished
// tasks and permission prompts are always announced; everything else gets a
// one-line reaction now and then, written by a small fast model.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { QUIP_PROMPT, MOODS } = require('./persona');
const { loadSdk, claudeEnv } = require('./agent');
const costs = require('./costs');

const PORT = Number(process.env.CAPRI_PORT) || 47913;
const QUIP_MODEL = process.env.CAPRI_QUIP_MODEL || 'claude-haiku-5-5';
const QUIP_TIMEOUT = 20000;
const MAX_BODY = 64 * 1024;

// Random reactions: the chance that an event gets one, and the quiet time
// after any reaction.
const CHANCE = { prompt: 0.35, edit: 0.15, command: 0.12, failed: 0.5, save: 0.3 };
const GAP = 60000;
// "Task done" lines are always shown; they're written fresh only this often.
const DONE_GAP = 12000;

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', '__pycache__', '.venv', 'venv', 'env', 'target', '.idea', '.vscode', 'AppData']);
const CODE_EXT = new Set('js mjs cjs ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php lua sh ps1 bat sql css scss sass less html vue svelte astro md mdx json yml yaml toml ini cfg glsl hlsl shader gd zig ex exs hs ml clj dart r jl'.split(' '));

const DONE_LINES = ['done in {p}! go look.', 'claude wrapped up {p}. your turn, choom.', '{p}: finished. *bzzt*', 'task flatlined... in a good way. {p} is done.'];
const FAIL_LINES = ['claude choked in {p}: {e}', '{p} went sideways: {e}'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const fill = (line, vars) => line.replace(/\{(\w)\}/g, (_, k) => vars[k] ?? '');
const project = (cwd) => (cwd ? path.basename(cwd) : 'some terminal');

class Companion extends EventEmitter {
  // isSelf(sessionId): is this Capri's own session? isBusy(): is she working
  // on something herself (her own edits shouldn't get reactions)?
  constructor({ isSelf, isBusy, reactions = true }) {
    super();
    this.isSelf = isSelf;
    this.isBusy = isBusy;
    this.reactions = reactions;
    this.server = null;
    this.watcher = null;
    this.root = null;
    this.quipping = false;
    this.lastReaction = 0;
    this.lastDone = 0;
    this.fileTimers = new Map();
    this.touched = new Map();
  }

  // ---- hooks --------------------------------------------------------------

  start() {
    this.server = http.createServer((req, res) => {
      // The custom header forces a CORS preflight, so a web page can't post here.
      if (req.method !== 'POST' || req.url !== '/hook' || req.headers['x-capri'] !== '1') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) req.destroy();
      });
      req.on('end', () => {
        res.writeHead(204).end();
        try {
          this.onHook(JSON.parse(body));
        } catch {
          // Not a hook event.
        }
      });
    });
    this.server.on('error', (err) => console.warn(`[capri] hook listener off: ${err.message}`));
    this.server.listen(PORT, '127.0.0.1');
  }

  stop() {
    this.server?.close();
    this.watcher?.close();
  }

  onHook(e) {
    if (!e || typeof e.event !== 'string' || this.isSelf(e.session)) return;
    this.emit('activity');
    const p = project(e.cwd);
    switch (e.event) {
      case 'Stop':
        this.announceDone(p, String(e.message ?? ''));
        break;
      case 'StopFailure':
        this.notice({ kind: 'failed', project: p, mood: 'annoyed', text: fill(pick(FAIL_LINES), { p, e: e.error ?? 'error' }) });
        break;
      case 'Notification':
        // The idle nudge repeats what the Stop announcement already said.
        if (e.kind === 'idle_prompt') return;
        this.notice({ kind: 'attention', project: p, mood: 'curious', text: `claude @ ${p}: ${cut(String(e.message ?? 'needs you'), 120)}` });
        break;
      case 'UserPromptSubmit':
        this.maybeReact('prompt', p, `The user just typed this into Claude Code (project ${p}):\n${e.prompt ?? ''}`);
        break;
      case 'PostToolUse':
        this.onToolUse(e, p);
        break;
    }
  }

  onToolUse(e, p) {
    const input = e.input ?? {};
    if (input.file_path) this.touched.set(path.resolve(String(input.file_path)), Date.now());
    if (e.tool === 'Bash' || e.tool === 'PowerShell') {
      const failed = Boolean(e.failed);
      this.maybeReact(
        failed ? 'failed' : 'command',
        p,
        `Claude Code just ran a command for the user (project ${p})${failed ? ' and it failed' : ''}:\n$ ${input.command ?? ''}\n${e.output ? `Output:\n${e.output}` : ''}`,
      );
    } else if (input.file_path) {
      this.maybeReact('edit', p, `Claude Code just used ${e.tool} on ${path.basename(String(input.file_path))} for the user (project ${p}):\n${input.change ?? ''}`);
    }
  }

  async announceDone(p, message) {
    const fallback = { kind: 'done', project: p, mood: 'hype', text: fill(pick(DONE_LINES), { p }) };
    const now = Date.now();
    if (this.quipping || now - this.lastDone < DONE_GAP) {
      this.notice(fallback);
      return;
    }
    this.lastDone = now;
    const line = await this.quip(`Claude Code just finished a task in project ${p}. Tell the user it's done, in your words. Its final message to them was:\n${message || '(empty)'}`);
    this.notice(line ? { ...fallback, ...line } : fallback);
  }

  // ---- file saves ---------------------------------------------------------

  // Watch the folder she works in. Not the home folder or a drive root: too
  // much churn to be worth it.
  watch(dir) {
    this.watcher?.close();
    this.watcher = null;
    this.root = dir;
    const resolved = path.resolve(dir);
    if (resolved === os.homedir() || resolved === path.parse(resolved).root) return;
    try {
      this.watcher = fs.watch(resolved, { recursive: true }, (_type, name) => name && this.onFile(resolved, String(name)));
      this.watcher.on('error', () => {});
    } catch {
      this.watcher = null;
    }
  }

  onFile(root, name) {
    const parts = name.split(/[\\/]/);
    if (parts.some((part) => SKIP_DIRS.has(part) || part.startsWith('.#'))) return;
    const ext = path.extname(name).slice(1).toLowerCase();
    if (!CODE_EXT.has(ext)) return;
    const file = path.join(root, name);
    this.emit('activity');
    // Editors fire several events per save; wait for the burst to end.
    clearTimeout(this.fileTimers.get(file));
    this.fileTimers.set(
      file,
      setTimeout(() => {
        this.fileTimers.delete(file);
        this.onSave(root, file);
      }, 1500),
    );
  }

  async onSave(root, file) {
    const now = Date.now();
    // Her own edits and Claude Code's don't count as "what you do".
    if (this.isBusy() || now - (this.touched.get(file) ?? 0) < 8000) return;
    if (!this.ready('save')) return;
    const rel = path.relative(root, file).replaceAll('\\', '/');
    const change = await describeChange(root, file);
    if (change === null) return;
    this.react(project(root), `The user just saved ${rel} in project ${project(root)}.\n${change}`);
  }

  // ---- reactions ----------------------------------------------------------

  ready(kind) {
    return this.reactions && !this.quipping && Date.now() - this.lastReaction > GAP && Math.random() < CHANCE[kind];
  }

  maybeReact(kind, p, note) {
    if (this.ready(kind)) this.react(p, note);
  }

  async react(p, note) {
    this.lastReaction = Date.now();
    const line = await this.quip(note);
    if (line) this.notice({ kind: 'quip', project: p, ...line });
  }

  // One line from a small model, with no tools and no settings, so it costs
  // a fraction of a cent and can't touch anything.
  async quip(note) {
    if (this.quipping || costs.over) return null;
    this.quipping = true;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), QUIP_TIMEOUT);
    try {
      const { query } = await loadSdk();
      const q = query({
        prompt: cut(note, 4000),
        options: {
          model: QUIP_MODEL,
          effort: 'low',
          systemPrompt: QUIP_PROMPT,
          tools: [],
          maxTurns: 1,
          settingSources: [],
          persistSession: false,
          cwd: os.tmpdir(),
          abortController,
          env: claudeEnv(),
        },
      });
      for await (const m of q) {
        if (m.type !== 'result') continue;
        costs.add(QUIP_MODEL, m.total_cost_usd);
        return m.subtype === 'success' && !m.is_error ? parseLine(m.result) : null;
      }
      return null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      this.quipping = false;
    }
  }

  notice(n) {
    this.emit('notice', n);
  }
}

function parseLine(text) {
  const match = String(text ?? '').match(/^\s*\[\[(\w+)\]\]\s*/);
  const mood = match && MOODS.includes(match[1]) ? match[1] : 'mischief';
  const line = (match ? text.slice(match[0].length) : String(text ?? '')).replace(/\[\[\w+\]\]/g, '').trim();
  return line ? { mood, text: tighten(line.split('\n')[0]) } : null;
}

// Small models run long. Keep whole sentences while they fit.
function tighten(line, max = 130) {
  if (line.length <= max) return line;
  let out = '';
  for (const sentence of line.match(/[^.!?]+[.!?]+\S*\s*|[^.!?]+$/g) ?? [line]) {
    if (out && (out + sentence).length > max) break;
    out += sentence;
  }
  return cut(out.trim(), max);
}

// What changed in a saved file: its uncommitted diff in a git repo, or the
// top of the file. null for files that aren't worth a look.
function describeChange(root, file) {
  return new Promise((resolve) => {
    execFile('git', ['-C', root, 'diff', '--no-color', '-U1', '--', file], { timeout: 3000, windowsHide: true }, (err, stdout) => {
      const diff = err ? '' : String(stdout).split('\n').slice(4).join('\n').trim();
      if (diff) {
        resolve(`Their uncommitted changes:\n${cut(diff, 2000)}`);
        return;
      }
      fs.stat(file, (statErr, st) => {
        if (statErr || !st.isFile() || st.size > 300000) return resolve(null);
        fs.readFile(file, 'utf8', (readErr, text) => {
          if (readErr || text.includes('\u0000')) return resolve(null);
          resolve(`Top of the file:\n${cut(text, 1500)}`);
        });
      });
    });
  });
}

module.exports = { Companion, PORT, parseLine };
