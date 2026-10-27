// The netlink chat panel: her side of a Claude Code session. Replies stream
// in with a decode-scramble effect (the hidden [[mood]] tag at the start of
// each message goes to the rig), tool calls show up as live activity lines,
// and permission prompts become cards to allow or deny.

window.Capri = window.Capri || {};

(() => {
  const SCRAMBLE = '!<>-_\\/[]{}=+^?#░▒▓01';
  const MOOD_TAGS = /\[\[(hype|smug|curious|mischief|annoyed|soft|glitch)\]\]\s*/g;
  const LEADING_TAG = /^\s*\[\[(\w+)\]\]\s*/;
  const PARTIAL_TAG = /^\s*(\[(\[\w*\]?)?)?$/;
  const TOOLS_SHOWN = 4;
  const STATUS = {
    ok: 'online',
    busy: 'thinking',
    work: 'working',
    ask: 'needs you',
  };

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  // "opus 5.5" from "claude-opus-5-5".
  const shortModel = (model) => String(model ?? '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2');

  // Just enough markdown for a chat panel: fenced code, inline code, bold,
  // headings and bullets.
  function render(text) {
    const parts = text.split('```');
    return parts
      .map((part, i) => {
        if (i % 2 === 1) {
          const nl = part.indexOf('\n');
          const code = nl === -1 ? '' : part.slice(nl + 1).replace(/\n$/, '');
          return `<pre><code>${esc(code)}</code></pre>`;
        }
        let html = esc(part)
          .replace(/^#{1,6} +(.+)$/gm, '<b>$1</b>')
          .replace(/^(\s*)[-*] /gm, '$1• ')
          .replace(/`([^`\n]+)`/g, '<code>$1</code>')
          .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
        if (i > 0) html = html.replace(/^\n+/, '');
        if (i < parts.length - 1) html = html.replace(/\n+$/, '');
        return html.replace(/\n/g, '<br>');
      })
      .join('');
  }

  // Diffs get their +/- lines colored.
  function renderDetail(detail) {
    if (!detail?.text) return '';
    if (detail.kind === 'plan') return `<div class="plan">${render(detail.text)}</div>`;
    const lines = detail.text.split('\n').map((line) => {
      if (detail.kind === 'diff' && line.startsWith('+ ')) return `<span class="add">${esc(line)}</span>`;
      if (detail.kind === 'diff' && line.startsWith('- ')) return `<span class="del">${esc(line)}</span>`;
      return esc(line);
    });
    return `<pre class="detail">${lines.join('\n')}</pre>`;
  }

  class Reply {
    constructor(el, onMood) {
      this.el = el;
      this.onMood = onMood;
      this.raw = '';
      this.tagDone = false;
      this.shown = 0;
      this.painted = -1;
      this.finished = false;
    }

    push(delta) {
      this.raw += delta;
      if (this.tagDone) return;
      const match = this.raw.match(LEADING_TAG);
      if (match) {
        this.tagDone = true;
        this.raw = this.raw.slice(match[0].length);
        this.onMood(match[1]);
      } else if (!PARTIAL_TAG.test(this.raw)) {
        this.tagDone = true;
      }
    }

    get text() {
      return this.tagDone ? this.raw.replace(MOOD_TAGS, '') : '';
    }

    get typing() {
      return this.shown < this.text.length;
    }

    finish() {
      this.finished = true;
      this.tagDone = true;
    }

    // Reveal a few more characters, trailed by a short run of noise.
    step() {
      const text = this.text;
      const backlog = text.length - this.shown;
      if (backlog <= 0) {
        if (this.painted !== this.shown) this.paint(text, 0);
        return false;
      }
      this.shown += Math.max(1, Math.ceil(backlog / 10));
      this.paint(text, Math.min(3, text.length - this.shown));
      return true;
    }

    paint(text, noise) {
      let tail = '';
      for (let i = 0; i < noise; i++) tail += SCRAMBLE[Math.floor(Math.random() * SCRAMBLE.length)];
      const html = render(text.slice(0, this.shown) + (tail ? `\u0001${tail}\u0002` : ''));
      this.el.innerHTML = html.replace('\u0001', '<span class="scr">').replace('\u0002', '</span>');
      this.painted = this.shown;
    }
  }

  class Chat {
    constructor(root, { onSend, onEscape, onAnswer }) {
      this.root = root;
      this.log = root.querySelector('#log');
      this.input = root.querySelector('#input');
      this.statusEl = root.querySelector('#status');
      this.subEl = root.querySelector('.sub');
      this.modeEl = root.querySelector('#mode');
      this.brainEl = root.querySelector('#brain');
      this.onAnswer = onAnswer;
      this.replies = [];
      this.sent = [];
      this.recall = -1;
      this.opened = false;
      this.toolBox = null;
      this.tools = new Map();
      this.asks = new Map();
      this.placeholder = this.input.placeholder;

      root.querySelector('#ask').addEventListener('submit', (e) => {
        e.preventDefault();
        this.submit(onSend);
      });
      this.input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.submit(onSend);
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          onEscape();
        } else if (e.key === 'ArrowUp' && this.sent.length && (!this.input.value || this.recall >= 0)) {
          e.preventDefault();
          this.recall = this.recall < 0 ? this.sent.length - 1 : Math.max(0, this.recall - 1);
          this.setInput(this.sent[this.recall]);
        } else if (e.key === 'ArrowDown' && this.recall >= 0) {
          e.preventDefault();
          this.recall = this.recall + 1 < this.sent.length ? this.recall + 1 : -1;
          this.setInput(this.recall < 0 ? '' : this.sent[this.recall]);
        }
      });
      this.input.addEventListener('input', () => this.fitInput());
      root.querySelector('#close').addEventListener('click', () => onEscape(true));

      this.log.addEventListener('click', (e) => {
        // Permission buttons.
        const button = e.target.closest('button[data-choice]');
        if (button) {
          const card = button.closest('.perm');
          this.answer(Number(card.dataset.id), button.dataset.choice);
          return;
        }
        // Expand a folded run of tool lines.
        const more = e.target.closest('.tools .more');
        if (more) {
          more.parentElement.classList.toggle('open');
          return;
        }
        // Click a code block to copy it.
        const pre = e.target.closest('pre');
        if (!pre || pre.classList.contains('detail')) return;
        navigator.clipboard.writeText(pre.innerText).then(() => {
          pre.classList.add('copied');
          setTimeout(() => pre.classList.remove('copied'), 700);
        });
      });
    }

    get isOpen() {
      return !this.root.hidden;
    }

    get typing() {
      return this.replies.some((r) => r.typing);
    }

    get pendingAsk() {
      for (const [id, card] of this.asks) if (!card.classList.contains('answered')) return id;
      return null;
    }

    setInfo({ project, model, routing, modeLabel, mode }) {
      this.subEl.textContent = `//${project ?? 'netlink'}`;
      this.subEl.title = model ? `model: ${model}` : '';
      // "haiku" from "claude-haiku-5-5"; the full name is in the tooltip.
      const family = String(model ?? '').replace(/^claude-/, '').split(/[-\s]/)[0];
      this.brainEl.textContent = family;
      this.brainEl.dataset.tier = /opus|fable|mythos/.test(family) ? 'deep' : 'fast';
      this.brainEl.title = `${shortModel(model)}: ${routing ? 'switches model by task (/model to change)' : 'pinned with /model'}`;
      this.brainEl.hidden = !family;
      this.modeEl.textContent = mode && mode !== 'default' ? modeLabel : '';
      this.modeEl.hidden = !this.modeEl.textContent;
    }

    open() {
      this.opened = true;
      if (!this.isOpen) {
        this.root.hidden = false;
        this.root.classList.remove('glitch-in');
        void this.root.offsetWidth; // restart the animation
        this.root.classList.add('glitch-in');
        this.scroll(true);
      }
      this.input.focus();
    }

    close() {
      this.root.hidden = true;
    }

    submit(onSend) {
      const text = this.input.value.trim();
      if (!text) return;
      this.sent.push(text);
      this.recall = -1;
      this.setInput('');
      onSend(text);
    }

    shake() {
      this.root.classList.remove('shake');
      void this.root.offsetWidth;
      this.root.classList.add('shake');
    }

    setInput(value) {
      this.input.value = value;
      this.fitInput();
    }

    fitInput() {
      this.input.style.height = 'auto';
      this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
    }

    setStatus(kind) {
      this.statusEl.textContent = STATUS[kind] ?? STATUS.ok;
      this.statusEl.dataset.kind = kind;
    }

    line(kind, html) {
      this.toolBox = null;
      const div = document.createElement('div');
      div.className = `msg ${kind}`;
      div.innerHTML = html;
      this.log.append(div);
      this.scroll(true);
      return div;
    }

    addUser(text) {
      this.line('user', esc(text).replace(/\n/g, '<br>'));
    }

    addSys(text) {
      this.line('sys', esc(text).replace(/\n/g, '<br>'));
    }

    addCapri(text) {
      this.line('capri', render(text));
    }

    // Something from outside the chat: another Claude Code session, or one
    // of her asides.
    addNotice({ kind, project, text }) {
      const tag = project ? `<span class="tag">${esc(project)}</span>` : '';
      this.line(`notice ${kind}`, `${tag}${esc(text)}`);
    }

    beginReply(onMood) {
      const reply = new Reply(this.line('capri typing', ''), onMood);
      this.replies.push(reply);
      return reply;
    }

    failReply(reply) {
      reply.finish();
      if (!reply.text.trim()) reply.el.remove();
    }

    // Tool calls stack up in one box; long runs fold down to the last few.
    addTool({ id, summary }) {
      if (!this.toolBox) {
        this.toolBox = document.createElement('div');
        this.toolBox.className = 'tools';
        this.toolBox.innerHTML = '<div class="more" hidden></div>';
        this.log.append(this.toolBox);
      }
      const row = document.createElement('div');
      row.className = 'tool running';
      row.innerHTML = `<i></i>${esc(summary)}`;
      this.toolBox.append(row);
      this.tools.set(id, row);
      const rows = this.toolBox.querySelectorAll('.tool');
      const hidden = rows.length - TOOLS_SHOWN;
      const more = this.toolBox.querySelector('.more');
      more.hidden = hidden <= 0;
      more.textContent = `+${hidden} more`;
      rows.forEach((r, i) => r.classList.toggle('old', i < hidden));
      this.scroll(true);
    }

    toolDone({ id, error }) {
      const row = this.tools.get(id);
      if (!row) return;
      row.classList.remove('running');
      row.classList.add(error ? 'err' : 'ok');
      this.tools.delete(id);
    }

    // A tool call waiting on the user.
    addPermission(p) {
      const card = this.line(
        'perm',
        [
          `<div class="head">▲ ${p.tool === 'ExitPlanMode' ? 'PLAN' : 'PERMISSION'}</div>`,
          `<div class="what">${esc(p.summary)}</div>`,
          renderDetail(p.detail),
          p.reason ? `<div class="why">${esc(p.reason)}</div>` : '',
          '<div class="choices">',
          `<button type="button" data-choice="allow">${p.tool === 'ExitPlanMode' ? 'go' : 'allow'}</button>`,
          p.canAlways ? `<button type="button" data-choice="always">${p.tool === 'ExitPlanMode' ? 'go + auto-edit' : 'always'}</button>` : '',
          '<button type="button" data-choice="deny">no</button>',
          '</div>',
        ].join(''),
      );
      card.dataset.id = p.id;
      card.classList.add('hit');
      this.asks.set(p.id, card);
      this.input.placeholder = 'or tell me what to do instead…';
    }

    answer(id, choice, note) {
      const card = this.asks.get(id);
      if (!card || card.classList.contains('answered')) return;
      this.onAnswer(id, choice, note);
      this.settle(id, choice === 'deny' ? (note ? `no: ${note}` : 'no') : choice === 'always' ? 'always' : 'yes');
    }

    // Main closed the prompt (answered, or cancelled by an interrupt).
    closePermission(id) {
      this.settle(id, 'cancelled');
    }

    settle(id, verdict) {
      const card = this.asks.get(id);
      if (!card) return;
      if (!card.classList.contains('answered')) {
        card.classList.add('answered', verdict === 'yes' || verdict === 'always' ? 'yes' : 'no');
        card.querySelector('.choices').innerHTML = `<span class="verdict">${esc(verdict)}</span>`;
        card.querySelector('.detail, .plan')?.remove();
      }
      this.asks.delete(id);
      if (this.pendingAsk === null) this.input.placeholder = this.placeholder;
    }

    step() {
      let moved = false;
      for (const reply of this.replies) moved = reply.step() || moved;
      this.replies = this.replies.filter((reply) => {
        if (!reply.finished || reply.typing) return true;
        reply.el.classList.remove('typing');
        if (reply.el.isConnected && !reply.text.trim()) reply.el.remove();
        return false;
      });
      if (moved) this.scroll(false);
    }

    scroll(force) {
      const { log } = this;
      if (force || log.scrollHeight - log.scrollTop - log.clientHeight < 80) log.scrollTop = log.scrollHeight;
    }

    clear() {
      this.log.innerHTML = '';
      this.replies = [];
      this.toolBox = null;
      this.tools.clear();
      this.asks.clear();
      this.input.placeholder = this.placeholder;
    }

    // Sit beside Capri, on whichever side has more room.
    anchor(pos, size) {
      const w = this.root.offsetWidth;
      const h = this.root.offsetHeight;
      const m = 10;
      const right = pos.x + size.w / 2 < innerWidth / 2;
      const x = clamp(right ? pos.x + size.w + 4 : pos.x - w - 4, m, innerWidth - w - m);
      const y = clamp(pos.y + size.h * 0.55 - h / 2, m, innerHeight - h - m);
      this.root.style.left = `${Math.round(x)}px`;
      this.root.style.top = `${Math.round(y)}px`;
    }
  }

  window.Capri.Chat = Chat;
  window.Capri.shortModel = shortModel;
})();
