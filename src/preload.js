const { contextBridge, ipcRenderer } = require('electron');

const INCOMING = [
  'summon',
  'warp',
  'workspace',
  'ears',
  'ptt',
  'music',
  'beat',
  'said',
  'rewrite',
  'reminder',
  'message',
  'wander',
  'reset',
  'notice',
  'league',
  'activity',
  'agent:ready',
  'agent:info',
  'agent:text',
  'agent:tool',
  'agent:tool-done',
  'agent:permission',
  'agent:permission-closed',
  'agent:done',
  'agent:busy',
  'agent:error',
  'agent:warn',
  'agent:mode',
  'agent:route',
];

contextBridge.exposeInMainWorld('bridge', {
  setMouseThrough: (through) => ipcRenderer.send('capri:mouse', through),
  chat: (text, context) => ipcRenderer.send('capri:chat', text, context),
  answer: (id, choice, note) => ipcRenderer.send('capri:answer', { id, choice, note }),
  interrupt: () => ipcRenderer.invoke('capri:interrupt'),
  follow: () => ipcRenderer.invoke('capri:follow'),
  release: () => ipcRenderer.send('capri:release'),
  look: () => ipcRenderer.invoke('capri:look'),
  activeWindow: () => ipcRenderer.invoke('capri:active-window'),
  audio: (source, samples) => ipcRenderer.send('capri:audio', source, samples),
  speaking: (ms) => ipcRenderer.send('capri:speaking', ms),
  synth: (text, kind) => ipcRenderer.invoke('capri:synth', text, kind),
  command: (name, arg) => ipcRenderer.invoke('capri:command', { name, arg }),
  reset: () => ipcRenderer.send('capri:reset'),
  menu: () => ipcRenderer.send('capri:menu'),
  status: () => ipcRenderer.invoke('capri:status'),
  on(channel, fn) {
    if (!INCOMING.includes(channel)) throw new Error(`unknown channel: ${channel}`);
    const handler = (_event, payload) => fn(payload);
    ipcRenderer.on(`capri:${channel}`, handler);
    return () => ipcRenderer.removeListener(`capri:${channel}`, handler);
  },
});
