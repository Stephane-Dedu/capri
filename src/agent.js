// Capri's brain: a live Claude Code session through the Claude Agent SDK. It
// is the same engine as the claude CLI, with the same tools, settings,
// CLAUDE.md files and sign-in; she just does the talking. Tool calls and
// permission prompts are surfaced as events so her chat panel can show them.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { z } = require('zod');
const { AGENT_PROMPT, transcriptPrompt } = require('./persona');

let sdk = null;
const loadSdk = async () => (sdk ??= await import('@anthropic-ai/claude-agent-sdk')); // ESM-only

const MODES = ['default', 'acceptEdits', 'plan', 'auto'];

// Two brains in one session: a fast one for chat and quick jobs, a strong one
// for real work. Each message picks one (pickTier), and the fast one can hand
// a task up mid-turn with the escalate tool; the switch applies from its next
// step, with the whole conversation still in context.
const TIERS = {
  fast: { model: process.env.CAPRI_FAST_MODEL || 'claude-haiku-5-5', effort: 'medium' },
  deep: { model: process.env.CAPRI_DEEP_MODEL || 'claude-opus-5-5', effort: 'high' },
};
const ESCALATE = 'mcp__capri__escalate';
// Follow-ups this soon after a job on the strong model stay on it.
const STICKY_MS = 10 * 60000;
const DEEP_HINTS =
  /\b(ultrathink|think (?:hard|harder|deeply|carefully)|use opus|deep[- ]dive|architect\w*|refactor\w*|redesign\w*|rewrite|migrat\w*|implement\w*|debug\w*|investigat\w*|root[- ]cause|optimi[sz]\w*|profil\w*|security|audit|review|from scratch|end[- ]to[- ]end|whole (?:app|project|codebase|repo))\b/i;
const DEEP_COMMANDS = /^\/(init|review|security-review|code-review|simplify)\b/i;
const SMALL_TALK = /^(thanks?( you)?|thx|ty|ok(ay)?|k|cool|nice|great|lol|lmao|hi|hey|yo|sup|gg|wow|love it)\b[\s!.?~]*$/i;

// Claude Code prefers an ANTHROPIC_API_KEY in its environment over your
// login, so a stale one (like the placeholder in an old .env) breaks her
// sign-in. She uses the login unless CAPRI_USE_API_KEY=1. CAPRI_SELF lets the
// hook script skip events from her own sessions.
function claudeEnv() {
  const env = { ...process.env, CAPRI_SELF: '1' };
  if (!process.env.CAPRI_USE_API_KEY) delete env.ANTHROPIC_API_KEY;
  return env;
}

// An async-iterable queue: the SDK reads user messages from it for as long as
// the session lives.
class Inbox {
  constructor() {
    this.items = [];
    this.waiting = null;
    this.closed = false;
  }

  push(item) {
    if (this.waiting) {
      this.waiting({ value: item, done: false });
      this.waiting = null;
    } else {
      this.items.push(item);
    }
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s) => String(s ?? '').split('\n')[0];
const prefixLines = (s, mark) => String(s ?? '').split('\n').map((line) => `${mark} ${line}`).join('\n');

class Agent extends EventEmitter {
  constructor({ cwd, model }) {
    super();
    this.cwd = cwd;
    // A model pinned with /model; unset means routing between the tiers.
    this.fixed = model && model !== 'auto' ? model : undefined;
    this.tier = 'fast';
    this.mode = 'default';
    this.session = null;
    this.sessionId = null;
    this.resumeId = null;
    this.transcripts = null; // her always-on transcript folder, which she may read
    this.busy = false;
    this.idleSince = 0;
    this.interrupted = false;
    this.streamed = 0;
    this.pending = new Map();
    this.nextAsk = 1;
    this.hidden = new Set();
  }

  get modelName() {
    return this.fixed ?? TIERS[this.tier].model;
  }

  // Which brain takes a message: the strong one for anything that reads like
  // a real job, for plan mode and for follow-ups to a job it just did.
  pickTier(text) {
    const t = String(text).trim();
    if (SMALL_TALK.test(t)) return { tier: 'fast', reason: 'small talk' };
    if (this.mode === 'plan') return { tier: 'deep', reason: 'plan mode' };
    const command = t.match(DEEP_COMMANDS);
    if (command) return { tier: 'deep', reason: command[0] };
    const hint = t.match(DEEP_HINTS);
    if (hint) return { tier: 'deep', reason: hint[0].toLowerCase() };
    if (t.length > 700 || t.split('\n').length > 12) return { tier: 'deep', reason: 'long brief' };
    if (this.tier === 'deep' && Date.now() - this.idleSince < STICKY_MS) return { tier: 'deep', reason: 'follow-up' };
    return { tier: 'fast', reason: 'quick one' };
  }

  // Switch brains. by: 'auto' (picked for a message) or 'escalate' (the fast
  // one handed the task up).
  async useTier({ tier, reason }, by) {
    if (tier === this.tier) return;
    this.tier = tier;
    if (this.session) {
      await this.session.q.setModel(TIERS[tier].model).catch(() => {});
      await this.session.q.applyFlagSettings({ effortLevel: TIERS[tier].effort }).catch(() => {});
    }
    this.emit('route', { tier, model: this.modelName, reason, by });
  }

  async escalate(reason) {
    if (this.fixed || this.tier === 'deep') return 'There is no stronger model to hand this to. Carry on with the task yourself.';
    await this.useTier({ tier: 'deep', reason }, 'escalate');
    return `You are now running on ${TIERS.deep.model}, and the task is yours. Continue it from where it stands; the user has already seen the messages above.`;
  }

  rel(file) {
    if (!file) return '';
    const r = path.relative(this.cwd, String(file));
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.replaceAll('\\', '/') : String(file);
  }

  // A one-line label for a tool call, like the CLI's transcript shows.
  summarize(name, input = {}) {
    switch (name) {
      case 'Bash':
      case 'PowerShell':
        return `$ ${cut(firstLine(input.command), 90)}`;
      case 'Read':
      case 'Edit':
      case 'MultiEdit':
      case 'Write':
        return `${name} ${this.rel(input.file_path)}`;
      case 'NotebookEdit':
        return `${name} ${this.rel(input.notebook_path)}`;
      case 'Glob':
      case 'Grep':
        return `${name} ${cut(String(input.pattern ?? ''), 60)}`;
      case 'WebFetch':
        return `WebFetch ${cut(String(input.url ?? ''), 70)}`;
      case 'WebSearch':
        return `WebSearch ${cut(String(input.query ?? ''), 70)}`;
      case 'Task':
      case 'Agent':
        return `${name}: ${cut(String(input.description ?? ''), 70)}`;
      case 'TodoWrite':
        return 'updating the todo list';
      case 'ExitPlanMode':
        return 'plan ready';
      default:
        return name;
    }
  }

  // What a permission prompt shows under the summary. Diffs use "- "/"+ "
  // line prefixes, which the panel colors.
  detail(name, input = {}) {
    if (name === 'Bash' || name === 'PowerShell') return { kind: 'cmd', text: cut(String(input.command ?? ''), 1200) };
    if (name === 'Edit') return { kind: 'diff', text: cut(`${prefixLines(input.old_string, '-')}\n${prefixLines(input.new_string, '+')}`, 1500) };
    if (name === 'MultiEdit') {
      const edits = (input.edits ?? []).map((e) => `${prefixLines(e.old_string, '-')}\n${prefixLines(e.new_string, '+')}`);
      return { kind: 'diff', text: cut(edits.join('\n…\n'), 1500) };
    }
    if (name === 'Write') return { kind: 'diff', text: cut(prefixLines(input.content, '+'), 1200) };
    if (name === 'ExitPlanMode') return { kind: 'plan', text: cut(String(input.plan ?? ''), 4000) };
    if (name === 'WebFetch') return { kind: 'text', text: String(input.url ?? '') };
    return { kind: 'text', text: cut(JSON.stringify(input, null, 1), 800) };
  }

  async send(text) {
    this.interrupted = false;
    if (!this.fixed) await this.useTier(this.pickTier(text), 'auto');
    if (!this.session) await this.open();
    this.setBusy(true);
    this.session.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  async open() {
    const { query, createSdkMcpServer, tool } = await loadSdk();
    const inbox = new Inbox();
    const escalate = tool(
      'escalate',
      `Hand the current task to ${TIERS.deep.model}, a stronger model, which continues it in this same conversation. Call it first, before doing any of the work, when the task is demanding: changes across several files, debugging a failure whose cause isn't obvious, design or architecture decisions, reviews, or anything where a mistake would be costly or you aren't confident. Don't call it for chat, quick questions, lookups or small single edits.`,
      { reason: z.string().describe('Why, in a few words') },
      async ({ reason }) => ({ content: [{ type: 'text', text: await this.escalate(String(reason).slice(0, 120)) }] }),
      // Loaded up front, so the fast model sees it without a tool search.
      { alwaysLoad: true },
    );
    const q = query({
      prompt: inbox,
      options: {
        cwd: this.cwd,
        model: this.modelName,
        effort: this.fixed ? undefined : TIERS[this.tier].effort,
        permissionMode: this.mode,
        resume: this.resumeId ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: this.transcripts ? `${AGENT_PROMPT}\n\n${transcriptPrompt(this.transcripts)}` : AGENT_PROMPT },
        additionalDirectories: this.transcripts ? [this.transcripts] : undefined,
        includePartialMessages: true,
        // She asks her questions in chat instead of through a dialog.
        disallowedTools: ['AskUserQuestion'],
        mcpServers: { capri: createSdkMcpServer({ name: 'capri', tools: [escalate] }) },
        // The hand-off never needs your OK.
        canUseTool: (name, input, opts) => (name === ESCALATE ? Promise.resolve({ behavior: 'allow', updatedInput: input }) : this.ask(name, input, opts)),
        env: claudeEnv(),
        stderr: process.env.CAPRI_DEBUG ? (d) => console.warn('[agent]', d.trimEnd()) : undefined,
      },
    });
    this.resumeId = null;
    const session = { q, inbox };
    this.session = session;
    this.pump(session);
  }

  async pump(session) {
    try {
      for await (const message of session.q) {
        if (this.session === session) this.handle(message);
      }
    } catch (err) {
      if (this.session === session) this.emit('error', { kind: 'engine', message: String(err.message ?? err) });
    } finally {
      if (this.session === session) {
        this.session = null;
        this.cancelAsks();
        this.setBusy(false);
      }
    }
  }

  handle(m) {
    // Subagents' own chatter stays out of her panel; their work shows up as
    // the parent's Task line.
    if (m.parent_tool_use_id) return;
    if (m.type === 'system' && m.subtype === 'init') {
      this.sessionId = m.session_id;
      this.emit('ready', { model: m.model, cwd: m.cwd, sessionId: m.session_id, commands: m.slash_commands ?? [] });
    } else if (m.type === 'stream_event') {
      const e = m.event;
      if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
        this.setBusy(true);
        this.streamed += e.delta.text.length;
        this.emit('text', e.delta.text);
      }
    } else if (m.type === 'assistant') {
      if (m.error) {
        this.streamed = 0;
        this.emit('warn', { kind: m.error, message: textOf(m.message) });
        return;
      }
      for (const block of m.message.content) {
        if (block.type === 'text') {
          // Text that never came through as stream deltas (rare) still shows.
          if (!this.streamed && block.text) this.emit('text', block.text);
          this.streamed = 0;
        } else if (block.type === 'tool_use') {
          this.setBusy(true);
          // The hand-off shows up as a route event, not as a tool call.
          if (block.name === ESCALATE) this.hidden.add(block.id);
          else this.emit('tool', { id: block.id, name: block.name, summary: this.summarize(block.name, block.input) });
        }
      }
    } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
      for (const block of m.message.content) {
        if (block.type !== 'tool_result' || this.hidden.delete(block.tool_use_id)) continue;
        this.emit('tool-done', { id: block.tool_use_id, error: Boolean(block.is_error) });
      }
    } else if (m.type === 'result') {
      this.setBusy(false);
      this.emit('done', {
        ok: m.subtype === 'success' && !m.is_error,
        interrupted: this.interrupted,
        subtype: m.subtype,
        text: m.result ?? '',
        ms: m.duration_ms,
        turns: m.num_turns,
        cost: m.total_cost_usd,
      });
      this.interrupted = false;
    }
  }

  ask(name, input, { signal, suggestions, decisionReason } = {}) {
    const id = this.nextAsk++;
    return new Promise((resolve) => {
      const finish = (answer) => {
        if (!this.pending.delete(id)) return;
        this.emit('permission-closed', { id });
        resolve(answer);
      };
      this.pending.set(id, { finish, name, input, suggestions });
      signal?.addEventListener('abort', () => finish({ behavior: 'deny', message: 'Cancelled.' }));
      this.emit('permission', {
        id,
        tool: name,
        summary: this.summarize(name, input),
        detail: this.detail(name, input),
        reason: typeof decisionReason === 'string' ? decisionReason : undefined,
        canAlways: name === 'ExitPlanMode' || Boolean(suggestions?.length),
      });
    });
  }

  // choice: 'allow' | 'always' | 'deny'. A note with a denial tells Claude
  // what to do instead, like typing at the CLI's prompt.
  answer(id, choice, note) {
    const ask = this.pending.get(id);
    if (!ask) return;
    if (choice === 'deny') {
      ask.finish({ behavior: 'deny', message: note ? `The user said no: ${note}` : 'The user said no.' });
      return;
    }
    let updatedPermissions = choice === 'always' ? ask.suggestions : undefined;
    // Approving a plan leaves plan mode, as in the CLI: "always" means
    // auto-accept the edits that follow.
    if (ask.name === 'ExitPlanMode') {
      this.mode = choice === 'always' ? 'acceptEdits' : 'default';
      updatedPermissions = [{ type: 'setMode', mode: this.mode, destination: 'session' }];
      this.emit('mode', this.mode);
    }
    ask.finish({ behavior: 'allow', updatedInput: ask.input, updatedPermissions });
  }

  cancelAsks() {
    for (const ask of [...this.pending.values()]) ask.finish({ behavior: 'deny', message: 'Cancelled.' });
  }

  async interrupt() {
    if (!this.busy) return false;
    this.interrupted = true;
    this.cancelAsks();
    try {
      await this.session?.q.interrupt();
    } catch {
      // Nothing running.
    }
    return true;
  }

  reset() {
    const session = this.session;
    this.session = null;
    this.sessionId = null;
    this.cancelAsks();
    this.setBusy(false);
    if (session) {
      session.inbox.close();
      session.q.close();
    }
  }

  // The next message continues an earlier session instead of a fresh one.
  resume(sessionId) {
    this.reset();
    this.resumeId = sessionId;
  }

  setCwd(dir) {
    this.reset();
    this.cwd = dir;
  }

  // Pin a model, or go back to routing with '' or 'auto'.
  async setModel(model) {
    this.fixed = model && model !== 'auto' ? model : undefined;
    if (!this.session) return;
    await this.session.q.setModel(this.modelName).catch(() => {});
    await this.session.q.applyFlagSettings({ effortLevel: this.fixed ? null : TIERS[this.tier].effort }).catch(() => {});
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) return false;
    this.mode = mode;
    await this.session?.q.setPermissionMode(mode).catch(() => {});
    this.emit('mode', mode);
    return true;
  }

  setBusy(busy) {
    if (busy === this.busy) return;
    this.busy = busy;
    if (!busy) this.idleSince = Date.now();
    this.emit('busy', busy);
  }
}

function textOf(message) {
  return (message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

module.exports = { Agent, MODES, TIERS, loadSdk, claudeEnv };
