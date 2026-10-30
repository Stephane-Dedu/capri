const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, screen, ipcMain, Tray, Menu, globalShortcut, nativeImage, dialog, shell } = require('electron');

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  // No .env file: fall back to the real environment.
}

const { Agent, MODES, TIERS } = require('./agent');
const { Companion } = require('./companion');
const hooks = require('./hooks');
const config = require('./config');
const nvim = require('./nvim');
const look = require('./look');
const { frontmost } = require('./frontmost');
const { setupHearing } = require('./hearing');
const { CI } = require('./ci');
const costs = require('./costs');
const memory = require('./memory');
const routines = require('./routines');
const mac = require('./mac');
const rewrite = require('./rewrite');
const { notes, when } = require('./notes');
const { Meetings } = require('./meetings');
const workspaces = require('./workspaces');
const { NAME } = require('./persona');

const SUMMON_KEY = 'CommandOrControl+Shift+Space';
const SUMMON_LABEL = SUMMON_KEY.replace('CommandOrControl', process.platform === 'darwin' ? 'Cmd' : 'Ctrl');
const MODE_LABELS = { default: 'ask before edits', acceptEdits: 'accept edits', plan: 'plan only', auto: 'auto' };
const AGENT_EVENTS = ['ready', 'text', 'tool', 'tool-done', 'permission', 'permission-closed', 'done', 'busy', 'error', 'warn', 'mode', 'route'];

let win = null;
let tray = null;
let agent = null;
let companion = null;
let spaces = null;
let shot = null; // the screenshot from the last summon, until she looks at it
let hearing = null;
let ci = null;
let meetings = null;
let autoListening = false; // the autopilot turned the transcript on for a meeting
const activeWindow = frontmost();
let commands = [];
let visible = !process.env.CAPRI_START_HIDDEN;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', summon);
  app.whenReady().then(start);
}

function start() {
  if (process.platform === 'win32') app.setAppUserModelId('capri');
  const cfg = config.get();
  agent = new Agent({ cwd: cfg.cwd, model: cfg.model });
  for (const event of AGENT_EVENTS) agent.on(event, (payload) => send(`agent:${event}`, payload));
  agent.on('ready', ({ sessionId, commands: list }) => {
    commands = list;
    config.set({ sessions: { ...config.get().sessions, [agent.cwd]: sessionId } });
  });
  agent.on('mode', () => {
    send('agent:info', info());
    refreshMenu();
  });
  agent.on('route', () => send('agent:info', info()));
  // The cost meter: her chat, plus the one-liners and looks (costs.js).
  agent.on('spend', ({ model, usd }) => costs.add(model, usd));
  costs.on('change', () => send('agent:info', info()));

  companion = new Companion({
    isSelf: (id) => Boolean(id) && id === agent.sessionId,
    isBusy: () => agent.busy || Date.now() - agent.idleSince < 5000,
    reactions: cfg.reactions,
  });
  companion.on('notice', (notice) => send('notice', notice));
  // CI on your own repos' PRs (ci.js), off until you turn it on.
  ci = new CI({ diagnose: (note) => companion.quip(note) });
  ci.on('notice', (notice) => send('notice', notice));
  ci.on('warn', (message) => console.warn(`[capri] ci: ${message}`));
  if (cfg.ci) ci.start();
  // Reminders you set by voice or /remind (notes.js).
  notes.on('due', (reminder) => send('reminder', reminder));
  notes.start();
  // Messages (Slack…) from notification banners: shown and said here, never sent to a model.
  mac.on('notification', onNotification);
  mac.on('warn', (text) => send('notice', { kind: 'attention', text, mood: 'annoyed' }));
  if (cfg.notify) mac.notifications(true);
  // The meeting autopilot (meetings.js), off until you turn it on.
  meetings = new Meetings({ mac });
  meetings.on('soon', ({ title }) => send('notice', { kind: 'meeting', text: `${title} starts in a minute.`, mood: 'curious' }));
  meetings.on('start', onMeetingStart);
  meetings.on('end', onMeetingEnd);
  meetings.on('warn', (text) => send('notice', { kind: 'attention', text, mood: 'annoyed' }));
  if (cfg.autopilot) meetings.start();
  // You're busy at the keyboard, so she stays awake.
  let lastPing = 0;
  companion.on('activity', () => {
    if (Date.now() - lastPing < 5000) return;
    lastPing = Date.now();
    send('activity');
  });
  companion.start();
  companion.watch(cfg.cwd);

  createWindow();
  // You see her; screen shares, recordings and screenshots don't.
  win.setContentProtection(cfg.hide);
  // You switched desktops: she follows you over, if she's out and allowed to.
  spaces = workspaces.watch(win, () => {
    if (visible && config.get().follow) send('workspace', { here: spaces.here() });
  });
  spaces.setFollow(cfg.follow);
  // Her ears and voice: the transcript, the wake word, push-to-talk.
  hearing = setupHearing({ getWin: () => win, send, summon: summonWith, changed: hearingChanged });
  agent.transcripts = hearing.transcriptDir;
  createTray();
  hearingChanged();
  if (!globalShortcut.register(SUMMON_KEY, summon)) {
    console.warn(`[capri] could not register ${SUMMON_KEY}; use the tray icon instead`);
  }
  for (const event of ['display-metrics-changed', 'display-added', 'display-removed']) {
    screen.on(event, fitToScreen);
  }
}

// One transparent, click-through window covering the primary work area.
// The renderer turns click-through off only while the cursor is over Capri
// or her chat panel.
//
// On macOS it's a non-activating panel: it takes the keyboard without
// activating the app. Activating an app from another app's full-screen Space
// makes macOS leave that Space, so a plain window couldn't be summoned over a
// full-screen terminal.
function createWindow() {
  win = new BrowserWindow({
    ...screen.getPrimaryDisplay().workArea,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.once('ready-to-show', () => {
    if (visible) win.showInactive();
  });
  win.on('closed', () => {
    win = null;
  });
  // Panels hide when their app deactivates, which happens after one of her
  // dialogs (project folder, hooks). Bring her back.
  app.on('did-resign-active', () => {
    if (win && visible && !win.isVisible()) win.showInactive();
  });
  win.webContents.on('console-message', (event) => console.log(`[renderer] ${event.message}`));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.env.CAPRI_DEBUG) win.webContents.openDevTools({ mode: 'detach' });
}

function fitToScreen() {
  if (win) win.setBounds(screen.getPrimaryDisplay().workArea);
}

function send(channel, payload) {
  if (win && !win.webContents.isDestroyed()) win.webContents.send(`capri:${channel}`, payload);
}

function info() {
  const cfg = config.get();
  return {
    name: NAME,
    model: agent.modelName,
    routing: !agent.fixed,
    cwd: agent.cwd,
    project: path.basename(agent.cwd) || agent.cwd,
    mode: agent.mode,
    modeLabel: MODE_LABELS[agent.mode],
    wandering: cfg.wander,
    reactions: cfg.reactions,
    hooks: hooks.status(),
    ...hearing?.info(),
    spend: { total: costs.total, models: costs.models, cap: costs.cap },
  };
}

// Listening, push-to-talk or her voice changed: the page, the menu and the
// menu-bar "● REC" catch up.
function hearingChanged() {
  send('agent:info', info());
  refreshMenu();
  if (tray && process.platform === 'darwin') tray.setTitle(hearing.trayTitle());
}

// Warp Capri next to the cursor and open her chat, on the desktop you're on,
// bringing along whatever you've selected in Neovim. The screenshot is taken
// now, before she lands in front of what you're looking at; it only goes to a
// model if the summon opens her chat.
function summon() {
  return summonWith({});
}

// `heard`: what you said to her (push-to-talk, or after the wake word), sent
// as your message once she's there. `woke`: you just said her name.
async function summonWith({ heard = null, woke = false }) {
  if (!win) return;
  // Notes and reminders said out loud are handled right here, with no model.
  if (heard && handleSpoken(heard)) return;
  const cfg = config.get();
  const watching = cfg.look;
  // Read before she takes the keyboard: the clipboard first (reading a
  // selection may copy, then put the clipboard back), then what's selected,
  // in Neovim or else in the front app.
  const mine = win.isFocused();
  const [clip, image, nvimSelection] = await Promise.all([
    cfg.clipboard && !mine ? mac.clipboard() : null,
    watching ? look.capture(screen.getCursorScreenPoint()).catch(() => null) : null,
    nvim.selection().catch(() => null),
  ]);
  const appSelection = !nvimSelection && cfg.anySelection && !mine ? await mac.selection() : null;
  // "Make this nicer", "in English": the selection is rewritten where it is.
  if (heard && appSelection && rewrite.wants(heard)) {
    rewriteInPlace(appSelection, heard);
    return;
  }
  const selection = nvimSelection ?? (appSelection ? appChip(appSelection) : null);
  const copied = clip && !clip.concealed && clip.age < 120 && clip.text.trim() && clip.text !== appSelection?.text ? clipChip(clip.text) : null;
  if (!win) return;
  shot = image ? { image, at: Date.now() } : null;
  if (!visible) setVisible(true);
  if (!spaces.here()) await spaces.follow();
  win.focus();
  const cursor = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const sight = image ? 'ready' : watching && process.platform === 'darwin' && look.access() !== 'granted' ? 'blocked' : null;
  send('summon', { x: cursor.x - bounds.x, y: cursor.y - bounds.y, selection, clip: copied, look: sight, heard, woke });
}

// A selection from another app, shaped like a Neovim one for the chip.
function appChip({ app: name, text }) {
  const lines = text.split('\n').length;
  return { app: name, text, file: '', from: 1, to: lines, label: name || 'selection' };
}

function clipChip(text) {
  return { text: text.slice(0, 20000), label: text.trim().split('\n')[0].slice(0, 40) };
}

// "Note: …", "remind me in 20 minutes to …": done on the spot, she confirms.
function handleSpoken(text) {
  const said = notes.parse(text);
  if (!said) return false;
  if (said.kind === 'note') {
    notes.addNote(said.text);
    send('said', { kind: 'note', text: said.text });
  } else {
    notes.addReminder(said.at, said.text);
    send('said', { kind: 'remind', text: said.text, when: when(said.at) });
  }
  return true;
}

async function rewriteInPlace(selection, instruction) {
  if (costs.over) {
    send('agent:error', { kind: 'cap', message: `$${costs.cap}` });
    return;
  }
  send('rewrite', { phase: 'start', app: selection.app });
  const text = await rewrite.rewrite(selection.text, instruction);
  const done = text ? await mac.replace(text) : null;
  send('rewrite', { phase: done?.ok ? 'done' : 'failed', app: selection.app });
}

// Hiding keeps her (and her conversation) alive but off screen, e.g. while gaming.
function setVisible(show) {
  visible = show;
  if (win) {
    if (show) win.showInactive();
    else win.hide();
  }
  refreshMenu();
}

// ---- project folder, mode, hooks ------------------------------------------

function setProject(dir) {
  agent.setCwd(dir);
  companion.watch(dir);
  config.set({ cwd: dir });
  send('reset', { project: path.basename(dir) || dir });
  send('agent:info', info());
  refreshMenu();
}

async function pickProject() {
  const result = await dialog.showOpenDialog({ title: 'Where should Capri work?', defaultPath: agent.cwd, properties: ['openDirectory'] });
  if (!result.canceled && result.filePaths[0]) setProject(result.filePaths[0]);
}

async function setMode(mode) {
  await agent.setMode(mode);
}

// '' routes by task; anything else pins that model.
async function setModel(model) {
  await agent.setModel(model);
  config.set({ model: agent.fixed ?? '' });
  send('agent:info', info());
  refreshMenu();
}

function setReactions(on) {
  companion.reactions = on;
  config.set({ reactions: on });
  send('agent:info', info());
  refreshMenu();
}

function setWander(on) {
  config.set({ wander: on });
  send('wander', on);
  refreshMenu();
}

function setLook(on) {
  config.set({ look: on });
  if (!on) shot = null;
  refreshMenu();
}

// Out of screen shares and recordings: macOS leaves her window out of every
// capture (sharing type "none"), Windows 10 2004+ too (exclude-from-capture).
// What's behind her shows through, so viewers see nothing missing.
function setHide(on) {
  config.set({ hide: on });
  win?.setContentProtection(on);
  refreshMenu();
}

// Apps whose notifications she tells you about.
const NOTIFY_APPS = (process.env.CAPRI_NOTIFY_APPS || 'Slack,Messages,WhatsApp,Discord,Signal,Telegram')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// A banner from an app on the list: she pops up with it and says who it's
// from. The text stays on your screen; nothing goes to a model.
function onNotification({ app: name, title, subtitle, body }) {
  if (!NOTIFY_APPS.includes(String(name).toLowerCase())) return;
  send('message', { app: name, title, subtitle, body: String(body ?? '').slice(0, 300) });
}

// The autopilot keeps the transcript on for meetings, and marks them in it
// so /recap knows where each one starts and ends.
function onMeetingStart({ title }) {
  if (!config.get().listen) {
    autoListening = true;
    hearing.set.listen(true);
  }
  hearing.mark(`meeting start: ${title}`);
  send('notice', { kind: 'meeting', text: `"${title}" started. i'm taking notes.`, mood: 'curious', quiet: true });
}

function onMeetingEnd({ title, last }) {
  hearing.mark(`meeting end: ${title}`);
  if (last && autoListening) {
    autoListening = false;
    hearing.set.listen(false);
  }
  send('notice', { kind: 'meeting', text: `"${title}" is over. /recap when you want the recap.`, mood: 'soft' });
}

function setToggle(key, on) {
  config.set({ [key]: on });
  if (key === 'notify') mac.notifications(on);
  if (key === 'autopilot') {
    if (on) meetings.start();
    else meetings.stop();
  }
  refreshMenu();
}

function setCI(on) {
  config.set({ ci: on });
  if (on) ci.start();
  else ci.stop();
  refreshMenu();
}

function setFollow(on) {
  config.set({ follow: on });
  const away = !spaces.here();
  spaces.setFollow(on);
  if (on && visible && away) send('workspace');
  refreshMenu();
}

// Asks first: this edits the user's global Claude Code settings.
async function toggleHooks() {
  const installed = hooks.status() !== 'missing';
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: NAME,
    message: installed ? 'Unhook Capri from Claude Code?' : 'Hook Capri into Claude Code?',
    detail: installed
      ? `This removes Capri's hooks from ${hooks.SETTINGS}. Nothing else in the file changes.`
      : `This adds background hooks to ${hooks.SETTINGS}, so your Claude Code sessions tell Capri when they finish, need you, or do something. They never block Claude Code, they only talk to 127.0.0.1, and nothing else in the file changes. The original file is backed up next to it first.`,
    buttons: [installed ? 'Unhook' : 'Hook in', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return null;
  try {
    if (installed) hooks.uninstall();
    else hooks.install();
  } catch (err) {
    dialog.showErrorBox(NAME, `Couldn't update ${hooks.SETTINGS}: ${err.message}`);
    return null;
  }
  send('agent:info', info());
  refreshMenu();
  return hooks.status();
}

function resetConversation() {
  agent.reset();
  send('reset', {});
}

// ---- tray -----------------------------------------------------------------

function buildMenu() {
  const cfg = config.get();
  const hookState = hooks.status();
  return Menu.buildFromTemplate([
    { label: 'Summon', accelerator: SUMMON_KEY, click: summon },
    { label: 'Visible', type: 'checkbox', checked: visible, click: (item) => setVisible(item.checked) },
    { type: 'separator' },
    { label: `Project: ${path.basename(agent.cwd) || agent.cwd}…`, click: pickProject },
    {
      label: 'Permissions',
      submenu: MODES.map((mode) => ({ label: MODE_LABELS[mode], type: 'radio', checked: agent.mode === mode, click: () => setMode(mode) })),
    },
    {
      label: 'Model',
      submenu: [
        ['', `Auto: ${TIERS.fast.model} for quick stuff, ${TIERS.deep.model} for real jobs`],
        [TIERS.fast.model, `Always ${TIERS.fast.model}`],
        [TIERS.deep.model, `Always ${TIERS.deep.model}`],
      ].map(([model, label]) => ({ label, type: 'radio', checked: (agent.fixed ?? '') === model, click: () => setModel(model) })),
    },
    { label: 'New conversation', click: resetConversation },
    { type: 'separator' },
    { label: 'Hooked into Claude Code', type: 'checkbox', checked: hookState === 'installed', click: () => toggleHooks().finally(refreshMenu) },
    { label: 'Comment on what I do', type: 'checkbox', checked: cfg.reactions, click: (item) => setReactions(item.checked) },
    { label: 'Wander around', type: 'checkbox', checked: cfg.wander, click: (item) => setWander(item.checked) },
    { label: 'Follow me across desktops', type: 'checkbox', checked: cfg.follow, click: (item) => setFollow(item.checked) },
    { label: 'Hide me from screen shares', type: 'checkbox', checked: cfg.hide, click: (item) => setHide(item.checked) },
    { label: 'Look at my screen when summoned', type: 'checkbox', checked: cfg.look, click: (item) => setLook(item.checked) },
    { type: 'separator' },
    ...(hearing?.menu() ?? []),
    { label: 'Dance to music', type: 'checkbox', checked: cfg.dance, click: (item) => hearing.set.dance(item.checked) },
    { type: 'separator' },
    { label: 'Watch CI on my own repos', type: 'checkbox', checked: cfg.ci, click: (item) => setCI(item.checked) },
    { label: 'Open her notes about me', click: () => shell.openPath(memory.file()) },
    ...(mac.supported
      ? [
          { type: 'separator' },
          { label: 'Bring my selection from any app', type: 'checkbox', checked: cfg.anySelection, click: (item) => setToggle('anySelection', item.checked) },
          { label: 'Offer what I just copied', type: 'checkbox', checked: cfg.clipboard, click: (item) => setToggle('clipboard', item.checked) },
          { label: 'Tell me about messages (Slack…)', type: 'checkbox', checked: cfg.notify, click: (item) => setToggle('notify', item.checked) },
          { label: 'Meeting autopilot (calendar)', type: 'checkbox', checked: cfg.autopilot, click: (item) => setToggle('autopilot', item.checked) },
        ]
      : []),
    { label: 'Open my voice notes', click: () => shell.openPath(notes.notesFile) },
    { label: 'Warp somewhere', click: () => send('warp') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function refreshMenu() {
  if (tray) tray.setContextMenu(buildMenu());
}

function createTray() {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip(`${NAME} (${SUMMON_LABEL})`);
  refreshMenu();
  tray.on('click', summon);
}

// A tiny procedural Capri for the tray: pink spiky mane, green visor, blue eyes.
function makeTrayIcon() {
  const S = 32;
  const pixels = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x + 0.5 - S / 2;
      const dy = y + 0.5 - S / 2;
      const r = Math.hypot(dx, dy);
      const mane = 9 + 6.5 * Math.abs(Math.cos(Math.atan2(dy, dx) * 4.5)) ** 3;
      const eyeL = Math.hypot(dx + 3.5, dy + 1);
      const eyeR = Math.hypot(dx - 3.5, dy + 1.5);
      let rgb = null;
      if (r < mane) rgb = [248, 3, 77];
      if (r < 8.5) rgb = Math.abs(dx) + Math.abs(dy - 0.5) < 7.5 ? [11, 232, 113] : [8, 6, 26];
      if (eyeL < 2.6 || eyeR < 2.3) rgb = [5, 103, 219];
      if (eyeL < 1.3 || eyeR < 1.1) rgb = [244, 247, 255];
      if (!rgb) continue;
      const i = (y * S + x) * 4; // BGRA
      pixels[i] = rgb[2];
      pixels[i + 1] = rgb[1];
      pixels[i + 2] = rgb[0];
      pixels[i + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: S, height: S, scaleFactor: 2 });
}

// ---- renderer requests ------------------------------------------------------

ipcMain.on('capri:mouse', (_event, through) => {
  if (win) win.setIgnoreMouseEvents(Boolean(through), { forward: true });
});

ipcMain.on('capri:menu', () => {
  if (win) buildMenu().popup({ window: win });
});

ipcMain.on('capri:reset', resetConversation);

ipcMain.handle('capri:status', () => info());

// Context from the summon rides in front of the message: what she saw on the
// screen first, then the Neovim selection right above your words.
// A selection from another app, or what you just copied, in front of your words.
const quoted = (intro, text, message) => `${intro}:\n"""\n${String(text).slice(0, 20000)}\n"""\n\n${message}`;

ipcMain.on('capri:chat', (_event, text, { selection, clip, screen: seen, voice } = {}) => {
  let message = String(text).slice(0, 50000);
  // Said out loud: her answer is read back (see "Talking out loud" in persona.js).
  if (voice) message = `(spoken) ${message}`;
  if (clip?.text) message = quoted("I've just copied this", clip.text, message);
  if (selection?.app) message = quoted(`I've selected this in ${selection.app}`, selection.text, message);
  else if (selection) message = nvim.prompt(selection, message);
  if (seen?.summary) message = look.prompt(seen, message);
  // The daily cap: nothing new gets sent once it's reached.
  if (costs.over) {
    send('agent:error', { kind: 'cap', message: `$${costs.cap}` });
    return;
  }
  agent.send(message).catch((err) => send('agent:error', { kind: 'engine', message: String(err.message ?? err) }));
});

// The chat opened on a summon: she looks at the screenshot it took. Stale or
// already-used shots are dropped, so each summon costs at most one look.
ipcMain.handle('capri:look', async () => {
  const taken = shot;
  shot = null;
  if (!taken || Date.now() - taken.at > 15000) return null;
  return look.describe(taken.image);
});

// She's been left on another desktop: move her window to yours.
ipcMain.handle('capri:follow', () => spaces?.follow() ?? false);

// Her chat closed: give the keyboard back. On macOS her window is a
// non-activating panel, so the app you summoned her from never stopped being
// the active one, and dropping her focus returns typing to it.
ipcMain.on('capri:release', () => {
  if (win && process.platform === 'darwin' && win.isFocused()) win.blur();
});

// The window you're in, in her overlay's coordinates, so she can sit on it.
ipcMain.handle('capri:active-window', () => {
  const frame = win && activeWindow();
  if (!frame) return null;
  const bounds = win.getBounds();
  return { ...frame, x: frame.x - bounds.x, y: frame.y - bounds.y };
});

ipcMain.on('capri:answer', (_event, { id, choice, note } = {}) => {
  if (['allow', 'always', 'deny'].includes(choice)) agent.answer(Number(id), choice, note ? String(note).slice(0, 2000) : undefined);
});

ipcMain.handle('capri:interrupt', () => agent.interrupt());

// Slash commands that change her setup. Each returns a line for the chat.
ipcMain.handle('capri:command', async (_event, { name, arg = '' } = {}) => {
  arg = String(arg).trim();
  switch (name) {
    case 'cd': {
      if (!arg) return { text: agent.cwd };
      const dir = path.resolve(agent.cwd, arg.replace(/^~(?=$|[\\/])/, os.homedir()));
      if (!config.isDir(dir)) return { error: `no such folder: ${dir}` };
      setProject(dir);
      return { text: `jacked into ${dir}` };
    }
    case 'pwd':
      return { text: agent.cwd };
    case 'mode':
      if (!arg) return { text: `mode: ${agent.mode} (${MODES.join(' · ')})` };
      return (await agent.setMode(arg)) ? { text: `mode: ${MODE_LABELS[arg]}` } : { error: `modes: ${MODES.join(' · ')}` };
    case 'model':
      if (arg) await setModel(arg === 'default' || arg === 'auto' ? '' : arg);
      return {
        text: agent.fixed
          ? `model: ${agent.fixed}, pinned. /model auto to switch by task again.`
          : `model: auto. ${TIERS.fast.model} (${TIERS.fast.effort} effort) for quick stuff, ${TIERS.deep.model} for real jobs. now on ${agent.modelName}.`,
      };
    case 'resume': {
      const id = config.get().sessions[agent.cwd];
      if (!id) return { error: 'no earlier session of mine in this folder.' };
      agent.resume(id);
      return { text: 'next message picks up where we left off.' };
    }
    case 'hooks': {
      if (arg === 'on' || arg === 'off') {
        const want = arg === 'on';
        if ((hooks.status() !== 'missing') !== want) await toggleHooks();
      }
      return { text: `claude code hooks: ${hooks.status()}` };
    }
    case 'quiet':
      setReactions(!config.get().reactions);
      return { text: config.get().reactions ? 'commentary: ON' : 'commentary: off. i\'ll only speak when claude finishes or needs you.' };
    case 'commands':
      return { text: commands.length ? commands.map((c) => `/${c}`).join(' ') : 'send me a message first, then ask again.' };
    case 'listen':
    case 'wake':
    case 'talk':
    case 'ptt': {
      if (arg === 'on' || arg === 'off') hearing.set[name](arg === 'on');
      else if (arg) return { error: `/${name} on|off` };
      return { text: `${hearing.labels[name]}: ${config.get()[name] ? 'ON' : 'off'}` };
    }
    case 'hide': {
      if (arg === 'on' || arg === 'off') setHide(arg === 'on');
      else if (arg) return { error: '/hide on|off' };
      return { text: config.get().hide ? "hidden from screen shares, recordings and screenshots. you still see me." : 'visible in screen shares and screenshots.' };
    }
    case 'dance': {
      if (arg === 'on' || arg === 'off') hearing.set.dance(arg === 'on');
      else if (arg) return { error: '/dance on|off' };
      return { text: `dancing to music: ${config.get().dance ? 'ON' : 'off'}` };
    }
    case 'ci': {
      if (arg === 'on' || arg === 'off') setCI(arg === 'on');
      else if (arg) return { error: '/ci on|off' };
      return { text: `watching CI on your own repos' PRs: ${config.get().ci ? 'ON' : 'off'}` };
    }
    case 'cost': {
      const rows = Object.entries(costs.models).map(([model, usd]) => `${model.replace(/^claude-/, '')} $${usd.toFixed(3)}`);
      return { text: `today: $${costs.total.toFixed(2)}${rows.length ? ` (${rows.join(' · ')})` : ''}${costs.cap ? ` · cap $${costs.cap}` : ' · no cap'}. estimates from the SDK, not a bill.` };
    }
    case 'cap': {
      if (arg === 'off') config.set({ dailyCap: 0 });
      else if (arg) {
        const dollars = Number(arg.replace(/^\$/, ''));
        if (!(dollars > 0)) return { error: '/cap <dollars> or /cap off' };
        config.set({ dailyCap: dollars });
      }
      send('agent:info', info());
      return { text: costs.cap ? `daily cap: $${costs.cap} (today so far $${costs.total.toFixed(2)})` : 'no daily cap.' };
    }
    case 'memory': {
      const lines = memory.notes();
      return { text: lines.length ? `what i remember about you:\n${lines.join('\n')}` : "i don't have notes about you yet." };
    }
    // Routines: a prompt built here, sent like a message.
    case 'notify':
    case 'autopilot': {
      if (!mac.supported) return { error: 'that one is macOS only.' };
      if (arg === 'on' || arg === 'off') setToggle(name, arg === 'on');
      else if (arg) return { error: `/${name} on|off` };
      return { text: name === 'notify' ? `telling you about messages (${NOTIFY_APPS.join(', ')}): ${config.get().notify ? 'ON' : 'off'}` : `meeting autopilot: ${config.get().autopilot ? 'ON' : 'off'}` };
    }
    case 'note': {
      if (!arg) return { text: `your notes are in ${notes.notesFile}` };
      notes.addNote(arg);
      return { text: 'noted.' };
    }
    case 'remind': {
      const said = notes.parse(`remind me ${arg}`);
      if (said?.kind !== 'remind') return { error: '/remind in 20 min to …  or  /remind at 15:30 to …' };
      notes.addReminder(said.at, said.text);
      return { text: `ok, ${when(said.at)}: ${said.text}` };
    }
    case 'reminders': {
      const list = notes.list();
      if (arg.startsWith('clear')) {
        list.forEach((r) => notes.cancel(r.id));
        return { text: 'reminders cleared.' };
      }
      return { text: list.length ? list.map((r) => `${when(r.at)}: ${r.text}`).join('\n') : 'no reminders. (/reminders clear wipes them)' };
    }
    case 'undo': {
      const result = await agent.undo();
      if (result.error) return { error: result.error };
      const names = result.files.map((f) => path.basename(f));
      return { text: names.length ? `put back ${names.length} file${names.length === 1 ? '' : 's'}: ${names.join(', ')}` : 'nothing had changed since then.' };
    }
    case 'recap':
      return { send: routines.recap(hearing.transcriptDir, arg) };
    case 'standup':
      return { send: routines.standup(hearing.transcriptDir, arg) };
    default:
      return { error: `unknown command /${name}` };
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  spaces?.stop();
  hearing?.stop();
  ci?.stop();
  meetings?.stop();
  notes.stop();
  mac.stop();
  companion?.stop();
  agent?.reset();
});
app.on('window-all-closed', () => app.quit());
