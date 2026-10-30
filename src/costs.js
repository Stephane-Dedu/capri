// What she's spent today, per model: the SDK's own estimates (not a bill),
// from her chat, her one-liners, her screen looks and CI diagnoses. Kept per
// day in the app's data folder, so the meter survives restarts. An optional
// daily cap stops new spending once it's reached.

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app } = require('electron');
const config = require('./config');

const pad = (n) => String(n).padStart(2, '0');
const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

class Costs extends EventEmitter {
  constructor() {
    super();
    this.file = null;
    this.data = null;
  }

  load() {
    if (this.data && this.data.day === today()) return this.data;
    this.file ??= path.join(app.getPath('userData'), 'spend.json');
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = null;
    }
    if (this.data?.day !== today()) this.data = { day: today(), models: {} };
    return this.data;
  }

  add(model, usd) {
    if (!(usd > 0)) return;
    const data = this.load();
    data.models[model] = (data.models[model] ?? 0) + usd;
    try {
      fs.writeFileSync(this.file, JSON.stringify(data));
    } catch {
      // The meter is a convenience; never fail a reply over it.
    }
    this.emit('change');
  }

  get total() {
    return Object.values(this.load().models).reduce((a, b) => a + b, 0);
  }

  get models() {
    return { ...this.load().models };
  }

  // The daily cap in dollars, or 0 for none.
  get cap() {
    return Number(config.get().dailyCap) || 0;
  }

  get over() {
    return this.cap > 0 && this.total >= this.cap;
  }
}

module.exports = new Costs();
