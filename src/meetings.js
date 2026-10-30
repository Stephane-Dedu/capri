// Meeting autopilot: reads your calendar on this Mac every few minutes
// (EventKit, through the mac helper; nothing is fetched from a server). A
// minute before a meeting she pops up; while it runs she keeps the transcript
// on; when it ends she offers /recap. Only events with a video link or other
// attendees count. Titles stay local: they reach a model only inside a
// transcript you ask her to recap.

const { EventEmitter } = require('node:events');

const REFRESH = 5 * 60000;
const SOON = 60000;
const GRACE = 2 * 60000; // meetings overrun

class Meetings extends EventEmitter {
  constructor({ mac }) {
    super();
    this.mac = mac;
    this.timers = new Map(); // "title@start" -> timeouts
    this.live = new Set(); // meetings running now
    this.interval = null;
  }

  start() {
    if (this.interval) return;
    this.refresh();
    this.interval = setInterval(() => this.refresh(), REFRESH);
  }

  stop() {
    clearInterval(this.interval);
    this.interval = null;
    for (const list of this.timers.values()) list.forEach(clearTimeout);
    this.timers.clear();
    for (const key of this.live) this.emit('end', { title: key.split('@')[0], last: true });
    this.live.clear();
  }

  async refresh() {
    const reply = await this.mac.events(12);
    if (!reply) return;
    if (reply.error) {
      this.emit('warn', "i can't read your calendar: allow Calendars for Electron (or your terminal) in System Settings › Privacy & Security.");
      this.stop();
      return;
    }
    const now = Date.now();
    for (const event of reply.events) {
      if (!event.link && event.attendees < 2) continue;
      const start = Date.parse(event.start);
      const end = Date.parse(event.end) + GRACE;
      const key = `${event.title}@${start}`;
      if (this.timers.has(key) || end <= now) continue;
      const at = (when, fn) => setTimeout(fn, Math.max(0, when - now));
      const meeting = { title: event.title, start, end: Date.parse(event.end) };
      const timers = [];
      if (start - SOON > now) timers.push(at(start - SOON, () => this.emit('soon', meeting)));
      timers.push(
        at(start, () => {
          this.live.add(key);
          this.emit('start', meeting);
        }),
      );
      timers.push(
        at(end, () => {
          this.live.delete(key);
          this.emit('end', { ...meeting, last: this.live.size === 0 });
        }),
      );
      this.timers.set(key, timers);
    }
  }
}

module.exports = { Meetings };
