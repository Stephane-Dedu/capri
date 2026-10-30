// The Node side of tools/capri-mac.swift: builds it on first use (Xcode
// command line tools), keeps it running, and turns its JSON lines into
// promises and events. macOS only; elsewhere every call resolves to nothing.
// It needs Accessibility (selection, replace, notifications) and Calendar
// access (the meeting autopilot), for Electron or the terminal you start her
// from.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { app } = require('electron');

const TIMEOUT = 5000;

class Mac extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.starting = null;
    this.waiting = new Map();
    this.next = 1;
    this.buf = '';
    this.watchingNotifications = false;
  }

  get supported() {
    return process.platform === 'darwin';
  }

  // The text selected in the front app: { app, bundle, text } or null.
  async selection() {
    const r = await this.ask('selection');
    return r?.text ? r : null;
  }

  // Replaces the front app's selection with `text`.
  async replace(text) {
    return (await this.ask('replace', { text })) ?? { ok: false };
  }

  // { text, age (seconds since it changed), concealed } or null.
  clipboard() {
    return this.ask('clipboard');
  }

  // Calendar events from an hour ago to `hours` ahead, or { error }.
  events(hours = 12) {
    return this.ask('events', { hours }, 60000); // the first time, macOS asks you
  }

  notifications(on) {
    this.watchingNotifications = on;
    if (on || this.child) this.start().then((ok) => ok && this.write({ op: 'notifications', on }));
  }

  async ask(op, args = {}, timeout = TIMEOUT) {
    if (!(await this.start())) return null;
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(null);
      }, timeout);
      this.waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.write({ id, op, ...args });
    });
  }

  write(message) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  start() {
    if (!this.supported) return Promise.resolve(false);
    if (this.child) return Promise.resolve(true);
    this.starting ??= this.boot()
      .then(() => true)
      .catch((err) => {
        this.emit('warn', `my mac helper won't start: ${err.message.split('\n')[0]}`);
        return false;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async boot() {
    const bin = await build();
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.stdout.on('data', (data) => this.read(data));
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      for (const resolve of this.waiting.values()) resolve(null);
      this.waiting.clear();
      // Crashed while watching: start again in a bit.
      if (this.watchingNotifications) setTimeout(() => this.notifications(true), 5000);
    });
    if (this.watchingNotifications) this.write({ op: 'notifications', on: true });
  }

  read(data) {
    this.buf += data;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.event) {
        this.emit(message.event, message);
        continue;
      }
      this.waiting.get(message.id)?.(message);
      this.waiting.delete(message.id);
    }
  }

  stop() {
    this.watchingNotifications = false;
    this.child?.kill();
    this.child = null;
  }
}

function build() {
  const src = path.join(__dirname, '..', 'tools', 'capri-mac.swift');
  const bin = path.join(app.getPath('userData'), 'bin', 'capri-mac');
  try {
    if (fs.statSync(bin).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve(bin);
  } catch {
    // Not built yet.
  }
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  return new Promise((resolve, reject) => {
    execFile('swiftc', ['-O', '-parse-as-library', src, '-o', bin], { timeout: 240000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(bin)));
  });
}

module.exports = new Mac();
