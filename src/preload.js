const { contextBridge, ipcRenderer } = require('electron');

const INCOMING = [
  'summon',
  'warp',
  'wander',
  'reset',
  'notice',
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
  chat: (text) => ipcRenderer.send('capri:chat', text),
  answer: (id, choice, note) => ipcRenderer.send('capri:answer', { id, choice, note }),
  interrupt: () => ipcRenderer.invoke('capri:interrupt'),
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
