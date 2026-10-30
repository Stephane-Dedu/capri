// Her ears and voice, wired together: the always-on transcript, the "Capri"
// wake word, push-to-talk, and talking back. Speech-to-text runs locally
// (whisper.cpp), so listening costs no tokens; the transcript only reaches a
// model when she reads it to answer you.

const path = require('node:path');
const { app, ipcMain, shell, session, desktopCapturer, systemPreferences } = require('electron');
const config = require('./config');
const { Whisper } = require('./whisper');
const { Transcript } = require('./transcript');
const { Ears } = require('./ears');
const { PushToTalk } = require('./ptt');
const voice = require('./voice');

// "Capri", "hey Capri, …", and the ways Whisper tends to spell it. Only at
// the start of what you say, so talking *about* Capri doesn't wake her.
const WAKE = /^\W*(?:(?:hey|hé|eh|ok|okay|dis|yo)\W+)?(?:capri|kapri|caprie|capris|caprit|capry)\b\W*(.*)$/i;
// After a bare "Capri", the next thing you say is for her.
const FOLLOW_UP_MS = 8000;
const ASIDE_GAP = 20000;

function setupHearing({ getWin, send, summon, changed }) {
  const data = app.getPath('userData');
  const whisper = new Whisper(path.join(data, 'models'));
  const transcript = new Transcript(path.join(data, 'transcripts'));
  const ears = new Ears({ whisper, transcript, binDir: path.join(data, 'bin') });
  const ptt = new PushToTalk();
  let wake = false;
  let expectUntil = 0;
  let lastAside = 0;

  const warn = (text) => send('notice', { kind: 'attention', text, mood: 'annoyed' });
  whisper.on('status', (text) => send('notice', { kind: 'quip', text: `ears: ${text}`, quiet: true }));
  ears.on('warn', warn);
  ears.on('mic', () => syncMic());
  ears.on('music', (on) => send('music', on));
  ears.on('beat', (level) => send('beat', level));

  // Everything you say goes past the wake word first.
  ears.onSpeech = (text) => {
    const match = text.match(WAKE);
    if (match) {
      const rest = match[1].trim();
      expectUntil = rest ? 0 : Date.now() + FOLLOW_UP_MS;
      summon({ heard: rest || null, woke: true });
      return true;
    }
    if (Date.now() < expectUntil) {
      expectUntil = 0;
      summon({ heard: text });
      return true;
    }
    return false;
  };

  async function syncMic() {
    const mic = ears.micWanted || wake;
    if (mic && process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      if (!(await systemPreferences.askForMediaAccess('microphone'))) {
        warn("i can't hear you: give the microphone to Electron (or your terminal) in System Settings › Privacy & Security.");
        return;
      }
    }
    send('ears', { mic, loopback: process.platform === 'win32' && ears.systemWanted });
    changed();
  }

  // Windows: the computer's audio comes through Chromium's loopback capture.
  if (process.platform === 'win32') {
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => callback({ video: sources[0], audio: 'loopback' }))
        .catch(() => callback(null));
    });
  }

  function setListening(on) {
    config.set({ listen: on });
    ears.setListening(on);
    changed();
  }

  function setWake(on) {
    config.set({ wake: on });
    wake = on;
    ears.wake = on;
    if (on) whisper.start().catch((err) => warn(err.message));
    syncMic();
  }

  function setPtt(on) {
    config.set({ ptt: on });
    if (on) {
      const problem = ptt.start();
      if (problem) warn(problem);
    } else {
      ptt.stop();
    }
    changed();
  }

  function setDance(on) {
    config.set({ dance: on });
    ears.setDance(on);
    changed();
  }

  function setTalk(on) {
    config.set({ talk: on });
    changed();
  }

  ptt.on('start', () => {
    ears.startQuestion();
    whisper.start().catch((err) => warn(err.message));
    send('ptt', 'listening');
  });
  ptt.on('cancel', () => {
    ears.cancelQuestion();
    send('ptt', 'idle');
  });
  ptt.on('stop', async () => {
    send('ptt', 'thinking');
    const text = await ears.endQuestion().catch((err) => {
      warn(err.message);
      return '';
    });
    send('ptt', text ? 'idle' : 'missed');
    if (text) summon({ heard: text });
  });

  ipcMain.on('capri:audio', (_event, source, samples) => {
    const f32 = samples instanceof Float32Array ? samples : new Float32Array(samples.buffer ?? samples, samples.byteOffset ?? 0, (samples.byteLength ?? samples.length * 4) / 4);
    ears.feed(source === 'call' ? 'call' : 'me', f32);
  });

  // She's about to talk for `ms`: keep her voice out of the log.
  ipcMain.on('capri:speaking', (_event, ms) => ears.mute(Math.min(60000, Number(ms) || 0) + 500));

  // A WAV of her saying `text`, or null. Asides (her one-liners, "done!")
  // stay quiet during calls and come at most every 20 seconds.
  ipcMain.handle('capri:synth', async (_event, text, kind) => {
    if (!config.get().talk) return null;
    if (kind === 'aside') {
      if (ears.inCall || Date.now() - lastAside < ASIDE_GAP) return null;
      lastAside = Date.now();
    }
    try {
      return await voice.synth(String(text).slice(0, 4000));
    } catch {
      return null;
    }
  });

  function info() {
    const cfg = config.get();
    return { listening: cfg.listen, wake: cfg.wake, ptt: cfg.ptt, pttKey: PushToTalk.label, talk: cfg.talk };
  }

  function menu() {
    const cfg = config.get();
    return [
      { label: 'Always listening (transcript)', type: 'checkbox', checked: cfg.listen, click: (item) => setListening(item.checked) },
      { label: 'Wake word: "Capri"', type: 'checkbox', checked: cfg.wake, click: (item) => setWake(item.checked) },
      { label: `Push-to-talk: hold ${PushToTalk.label}`, type: 'checkbox', checked: cfg.ptt, click: (item) => setPtt(item.checked) },
      { label: 'Talk out loud', type: 'checkbox', checked: cfg.talk, click: (item) => setTalk(item.checked) },
      { label: 'Open transcripts', click: () => shell.openPath(transcript.dir) },
    ];
  }

  // The menu-bar title says when the mic is open.
  function trayTitle() {
    const cfg = config.get();
    return cfg.listen ? ' ● REC' : cfg.wake ? ' ●' : '';
  }

  // Start the way you left it. The page asks for the mic once it's loaded.
  const cfg = config.get();
  wake = cfg.wake;
  ears.wake = wake;
  if (cfg.listen) ears.setListening(true);
  if (cfg.dance) ears.setDance(true);
  if (cfg.wake) whisper.start().catch((err) => warn(err.message));
  if (cfg.ptt) setTimeout(() => setPtt(true), 1500);
  getWin()?.webContents.once('did-finish-load', () => syncMic());

  return {
    transcriptDir: transcript.dir,
    // The tray toggles, for her /listen, /wake, /talk and /ptt commands.
    set: { listen: setListening, wake: setWake, talk: setTalk, ptt: setPtt, dance: setDance },
    labels: { listen: 'always listening (transcript)', wake: 'wake word "capri"', talk: 'talking out loud', ptt: `push-to-talk (hold ${PushToTalk.label})` },
    info,
    menu,
    trayTitle,
    stop() {
      ptt.stop();
      ears.stop();
      whisper.stop();
    },
  };
}

module.exports = { setupHearing };
