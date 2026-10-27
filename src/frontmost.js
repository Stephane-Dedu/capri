// The frame of the window you're working in, so she can sit on its top edge.
// macOS: the front-most normal window in CoreGraphics' window list (frames
// need no permission, only titles do). Windows: the foreground window, with
// DWM's visible frame. Both through koffi; without it she just doesn't sit on
// windows. Frames are in screen coordinates (points / DIPs).

const { screen } = require('electron');

function frontmost() {
  try {
    if (process.platform === 'darwin') return mac();
    if (process.platform === 'win32') return windows();
  } catch (err) {
    console.warn(`[capri] can't see the active window: ${err.message}`);
  }
  return () => null;
}

function mac() {
  const koffi = require('koffi');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  koffi.struct('CapriCGRect', { x: 'double', y: 'double', width: 'double', height: 'double' });
  const CGWindowListCopyWindowInfo = cg.func('void *CGWindowListCopyWindowInfo(uint32 option, uint32 relativeTo)');
  const CGRectMakeWithDictionaryRepresentation = cg.func('bool CGRectMakeWithDictionaryRepresentation(void *dict, _Out_ CapriCGRect *rect)');
  const CFArrayGetCount = cf.func('long CFArrayGetCount(void *array)');
  const CFArrayGetValueAtIndex = cf.func('void *CFArrayGetValueAtIndex(void *array, long index)');
  const CFDictionaryGetValue = cf.func('void *CFDictionaryGetValue(void *dict, void *key)');
  const CFNumberGetValue = cf.func('bool CFNumberGetValue(void *number, long type, _Out_ int32 *value)');
  const CFStringCreateWithCString = cf.func('void *CFStringCreateWithCString(void *alloc, const char *text, uint32 encoding)');
  const CFRelease = cf.func('void CFRelease(void *ref)');

  // The kCGWindow* keys are CFStrings spelled like their names.
  const key = (name) => CFStringCreateWithCString(null, name, 0x08000100); // UTF-8
  const LAYER = key('kCGWindowLayer');
  const OWNER = key('kCGWindowOwnerPID');
  const NUMBER = key('kCGWindowNumber');
  const BOUNDS = key('kCGWindowBounds');
  const int = (dict, k) => {
    const out = [0];
    const ref = CFDictionaryGetValue(dict, k);
    return ref && CFNumberGetValue(ref, 3, out) ? out[0] : null; // kCFNumberSInt32Type
  };

  return () => {
    const list = CGWindowListCopyWindowInfo(1 | 16, 0); // on screen only, no desktop elements
    if (!list) return null;
    try {
      // Front to back: the first normal window that isn't hers.
      for (let i = 0, n = CFArrayGetCount(list); i < n; i++) {
        const dict = CFArrayGetValueAtIndex(list, i);
        if (int(dict, LAYER) !== 0 || int(dict, OWNER) === process.pid) continue;
        const rect = {};
        const bounds = CFDictionaryGetValue(dict, BOUNDS);
        if (!bounds || !CGRectMakeWithDictionaryRepresentation(bounds, rect)) continue;
        if (rect.width < 120 || rect.height < 80) continue;
        return { id: int(dict, NUMBER), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
      return null;
    } finally {
      CFRelease(list);
    }
  };
}

function windows() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  koffi.struct('CapriRECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32 *pid)');
  const IsIconic = user32.func('int32 __stdcall IsIconic(intptr_t hwnd)');
  const GetWindowRect = user32.func('int32 __stdcall GetWindowRect(intptr_t hwnd, _Out_ CapriRECT *rect)');
  // DWMWA_EXTENDED_FRAME_BOUNDS: the visible frame, without the invisible resize borders.
  const DwmGetWindowAttribute = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32 attribute, _Out_ CapriRECT *rect, uint32 size)');

  return () => {
    const hwnd = Number(GetForegroundWindow());
    if (!hwnd || IsIconic(hwnd)) return null;
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    if (pid[0] === process.pid) return null;
    const r = {};
    if (DwmGetWindowAttribute(hwnd, 9, r, 16) < 0 && !GetWindowRect(hwnd, r)) return null;
    const dip = screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
    if (dip.width < 120 || dip.height < 80) return null;
    return { id: hwnd, ...dip };
  };
}

module.exports = { frontmost };
