// Watches CI on your open pull requests with the gh CLI (your own login),
// every two minutes. When a PR's checks go red, she reads the failed job's
// log and one small-model call says what broke; when a red PR goes green,
// she says so for free. The first look at each PR only sets a baseline, so
// starting her doesn't replay old failures.
//
// Only repos owned by the accounts in CAPRI_CI_OWNERS (default: the account
// gh is logged in as) are ever queried: the owner filter is part of the
// search itself, so work orgs never see a request from her.

const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const EVERY = Number(process.env.CAPRI_CI_EVERY) * 1000 || 120000;
const LOG_LINES = 80;

class CI extends EventEmitter {
  // diagnose(note) -> one line, or null.
  constructor({ diagnose }) {
    super();
    this.diagnose = diagnose;
    this.seen = new Map(); // "owner/repo#123" -> 'pass' | 'fail' | 'pending'
    this.timer = null;
    this.polling = false;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), EVERY);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.seen.clear();
  }

  // The accounts whose repos she may look at.
  async owners() {
    this.allowed ??= (process.env.CAPRI_CI_OWNERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!this.allowed.length) this.allowed = [(await run(['api', 'user', '--jq', '.login'])).trim()];
    return this.allowed;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const owners = await this.owners();
      const prs = [];
      for (const owner of owners) {
        prs.push(...(await gh(['search', 'prs', '--author', '@me', '--owner', owner, '--state', 'open', '--json', 'number,title,repository,url', '--limit', '30'])));
      }
      const open = new Set();
      for (const pr of prs) {
        const repo = pr.repository.nameWithOwner;
        if (!owners.includes(repo.split('/')[0])) continue; // never anything else
        const key = `${repo}#${pr.number}`;
        open.add(key);
        const checks = await gh(['pr', 'checks', String(pr.number), '--repo', repo, '--json', 'name,state,bucket,link,workflow']).catch(() => null);
        if (!checks?.length) continue;
        const failed = checks.filter((c) => c.bucket === 'fail');
        const now = failed.length ? 'fail' : checks.some((c) => c.bucket === 'pending') ? 'pending' : 'pass';
        const before = this.seen.get(key);
        this.seen.set(key, now);
        if (!before || before === now) continue;
        if (now === 'fail') this.failed(pr, repo, failed);
        else if (now === 'pass' && before === 'fail') this.emit('notice', { kind: 'done', project: short(repo, pr), text: `CI is green again: ${pr.title}`, mood: 'hype' });
      }
      // Merged or closed: forget them.
      for (const key of this.seen.keys()) if (!open.has(key)) this.seen.delete(key);
    } catch (err) {
      this.emit('warn', err.message);
    } finally {
      this.polling = false;
    }
  }

  async failed(pr, repo, failed) {
    const first = failed[0];
    const job = first.link?.match(/\/job\/(\d+)/)?.[1];
    const log = job ? await run(['run', 'view', '--job', job, '--repo', repo, '--log-failed']).catch(() => '') : '';
    const names = failed.map((c) => c.name).join(', ');
    const line = log
      ? await this.diagnose(`A CI check failed on the user's pull request "${pr.title}" (${repo}#${pr.number}): ${names}. The end of the failed job's log:\n${tail(log)}\n\nSay in one line what broke and, if it's obvious, the fix.`)
      : null;
    this.emit('notice', { kind: 'attention', project: short(repo, pr), text: line?.text ?? `${names} failed`, mood: line?.mood ?? 'annoyed', url: pr.url });
  }
}

const short = (repo, pr) => `${repo.split('/')[1]}#${pr.number}`;

// The last lines of a gh log, without its "job<TAB>step<TAB>timestamp" prefixes.
function tail(log) {
  return log
    .split('\n')
    .map((line) => line.replace(/^[^\t]*\t[^\t]*\t\S+Z /, ''))
    .filter((line) => line.trim())
    .slice(-LOG_LINES)
    .join('\n')
    .slice(-6000);
}

function run(args) {
  return new Promise((resolve, reject) => {
    // gh exits non-zero when checks fail or are pending, with the output still on stdout.
    execFile('gh', args, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (stdout ? resolve(stdout) : reject(err ?? new Error('no output'))));
  });
}

async function gh(args) {
  return JSON.parse(await run(args));
}

module.exports = { CI };
