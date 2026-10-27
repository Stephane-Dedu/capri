// Keeps Capri on the desktop you're using: Spaces on macOS, virtual desktops
// on Windows. Her window lives on one of them. When you switch away,
// `onSwitch` fires, and `follow()` pulls the window over to where you are.

const { app, systemPreferences } = require('electron');

function watch(win, onSwitch) {
  if (process.platform === 'darwin') return mac(win, onSwitch);
  if (process.platform === 'win32') {
    try {
      return windows(win, onSwitch);
    } catch (err) {
      console.warn(`[capri] can't follow you across desktops: ${err.message}`);
    }
  }
  return { here: () => true, follow: async () => false, setFollow() {}, stop() {} };
}

// macOS has an event for a Space switch, but no public API to put a window
// on a given Space. While she follows you, her window is on every Space at
// once: moving it over after each switch raced the switch, and when it came
// forward while still on the old Space, macOS took you back there. The
// renderer still tears her out and back in, so it reads as a teleport.
// FullScreenAuxiliary lets her into full-screen Spaces too (a full-screen
// terminal, say), which macOS only allows for apps without a Dock icon; she
// has the tray instead.
function mac(win, onSwitch) {
  app.dock?.hide();
  const join = (all) => win.setVisibleOnAllWorkspaces(all, { visibleOnFullScreen: true, skipTransformProcessType: true });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  join(false);
  let everywhere = false;
  let away = false;
  const id = systemPreferences.subscribeWorkspaceNotification('NSWorkspaceActiveSpaceDidChangeNotification', () => {
    if (!everywhere) away = true;
    onSwitch();
  });
  return {
    here: () => everywhere || !away,
    setFollow(on) {
      everywhere = Boolean(on);
      join(everywhere);
      if (everywhere) away = false;
    },
    // Summoned while she stays put: joining all Spaces for a moment and
    // leaving again drops the window on the one you're looking at. Each step
    // waits for the window server, so she never comes forward on the old one.
    async follow() {
      if (win.isDestroyed() || !win.isVisible()) return false;
      if (everywhere) return true;
      join(true);
      await settle();
      if (win.isDestroyed()) return false;
      win.showInactive();
      await settle();
      if (win.isDestroyed()) return false;
      join(false);
      away = false;
      return true;
    },
    stop: () => systemPreferences.unsubscribeWorkspaceNotification(id),
  };
}

// Windows: IVirtualDesktopManager, the documented COM interface, through
// koffi. It tells whether a window is on the desktop you're looking at and
// which desktop any window is on, and it moves our own windows. There's no
// event for a desktop switch, so she checks twice a second.
function windows(win, onSwitch) {
  const koffi = require('koffi');
  const ole32 = koffi.load('ole32.dll');
  const user32 = koffi.load('user32.dll');
  koffi.struct('GUID', { a: 'uint32', b: 'uint16', c: 'uint16', d: koffi.array('uint8', 8, 'Array') });
  const CoInitializeEx = ole32.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 flags)');
  const CoCreateInstance = ole32.func('int32 __stdcall CoCreateInstance(const GUID *clsid, void *outer, uint32 context, const GUID *iid, _Out_ void **out)');
  const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');

  CoInitializeEx(null, 0x2); // apartment-threaded; Electron's main thread usually already is
  const out = [null];
  const hr = CoCreateInstance(guid('aa509086-5ca9-4c25-8f95-589d3c07b48a'), null, 0x17, guid('a5cd92ff-29be-454c-8d04-d82879fb3f1b'), out);
  if (hr < 0 || !out[0]) throw new Error(`no virtual desktop manager (hresult 0x${(hr >>> 0).toString(16)})`);
  const self = out[0];

  // Its methods come after IUnknown's three in the vtable.
  const vtable = koffi.decode(self, 'void *');
  const method = (i, signature) => koffi.decode(koffi.decode(vtable, i * koffi.sizeof('void *'), 'void *'), koffi.proto(signature));
  const isOnCurrent = method(3, 'int32 __stdcall IsWindowOnCurrentVirtualDesktop(void *self, intptr_t hwnd, _Out_ int32 *onCurrent)');
  const desktopOf = method(4, 'int32 __stdcall GetWindowDesktopId(void *self, intptr_t hwnd, _Out_ GUID *id)');
  const moveTo = method(5, 'int32 __stdcall MoveWindowToDesktop(void *self, intptr_t hwnd, const GUID *id)');

  const handle = win.getNativeWindowHandle();
  const hwnd = handle.length === 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0);

  const here = () => {
    const on = [1];
    return isOnCurrent(self, hwnd, on) < 0 || on[0] !== 0;
  };
  // The desktop you're on is the one your foreground window is on. On an
  // empty desktop there's no such window, so she waits until you open one.
  const current = () => {
    const fg = Number(GetForegroundWindow());
    if (!fg || fg === hwnd) return null;
    const id = {};
    if (desktopOf(self, fg, id) < 0) return null;
    return id.a || id.b || id.c || id.d.some(Boolean) ? id : null;
  };

  const timer = setInterval(() => {
    if (!win.isDestroyed() && win.isVisible() && !here() && current()) onSwitch();
  }, 500);

  return {
    here,
    async follow() {
      if (win.isDestroyed()) return false;
      const id = current();
      return Boolean(id) && moveTo(self, hwnd, id) >= 0;
    },
    // Windows doesn't send you back to her desktop, so moving her after each
    // switch is enough.
    setFollow() {},
    stop: () => clearInterval(timer),
  };
}

function guid(text) {
  const hex = text.replace(/-/g, '');
  return {
    a: parseInt(hex.slice(0, 8), 16),
    b: parseInt(hex.slice(8, 12), 16),
    c: parseInt(hex.slice(12, 16), 16),
    d: [...Buffer.from(hex.slice(16), 'hex')],
  };
}

module.exports = { watch };
