// Push-to-talk on a held key, from any app, through uiohook-napi (a global
// key listener; on macOS it needs Accessibility permission). Holding the key
// on its own talks: 'start' on press, 'stop' on release. Any other key or a
// click while it's down means you're typing (⌥-characters, AltGr) or
// clicking, so that's a 'cancel', and so is a tap too short to be speech.

const { EventEmitter } = require('node:events');
const { systemPreferences } = require('electron');

const KEY = process.env.CAPRI_PTT_KEY || 'AltRight';
const MIN_HOLD = 350;

class PushToTalk extends EventEmitter {
  constructor() {
    super();
    this.hook = null;
    this.downAt = 0;
    this.dirty = false;
  }

  // The key's name for menus: "right ⌥" rather than "AltRight".
  static get label() {
    const mac = process.platform === 'darwin';
    return { AltRight: mac ? 'right ⌥' : 'right Alt', MetaRight: mac ? 'right ⌘' : 'right Win', CtrlRight: 'right Ctrl' }[KEY] ?? KEY;
  }

  // Returns why it can't start, or null.
  start() {
    if (this.hook) return null;
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(true)) {
      return 'push-to-talk needs Accessibility permission (System Settings › Privacy & Security › Accessibility), for Electron or the terminal you start me from. then restart me.';
    }
    let lib;
    try {
      lib = require('uiohook-napi');
    } catch (err) {
      return `push-to-talk is unavailable: ${err.message}`;
    }
    const code = lib.UiohookKey[KEY];
    if (code === undefined) return `unknown push-to-talk key ${KEY}`;
    const hook = lib.uIOhook;
    hook.on('keydown', (e) => {
      if (e.keycode === code) {
        if (this.downAt) return; // auto-repeat
        this.downAt = Date.now();
        this.dirty = false;
        this.emit('start');
      } else {
        this.spoil();
      }
    });
    hook.on('mousedown', () => this.spoil());
    hook.on('keyup', (e) => {
      if (e.keycode !== code || !this.downAt) return;
      const held = Date.now() - this.downAt;
      this.downAt = 0;
      if (this.dirty) return;
      this.emit(held >= MIN_HOLD ? 'stop' : 'cancel');
    });
    try {
      hook.start();
    } catch (err) {
      return `push-to-talk couldn't start: ${err.message}`;
    }
    this.hook = hook;
    return null;
  }

  spoil() {
    if (!this.downAt || this.dirty) return;
    this.dirty = true;
    this.emit('cancel');
  }

  stop() {
    try {
      this.hook?.stop();
    } catch {
      // Already stopped.
    }
    this.hook?.removeAllListeners();
    this.hook = null;
    this.downAt = 0;
  }
}

module.exports = { PushToTalk };
