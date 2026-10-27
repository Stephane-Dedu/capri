// What you've selected in Neovim. Every nvim listens on an RPC socket by
// default (v:servername), so there's nothing to set up: when you summon her,
// Capri asks each running nvim whether it's in visual mode and, if one is,
// for the selected text.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const TIMEOUT = 300;
const INLINE_MAX = 20000;
const SOCKET_NAME = /^nvim\.\d+\.\d+$/;

// Runs inside nvim. Returns '' unless it's in visual mode (v, V or ctrl-v).
const LUA = `
local mode = vim.api.nvim_get_mode().mode
if not mode:match('^[vV\\22]') then return '' end
local a, b = vim.fn.getpos('v'), vim.fn.getpos('.')
local from, to = math.min(a[2], b[2]), math.max(a[2], b[2])
local ok, lines = pcall(vim.fn.getregion, a, b, { type = mode })
if not ok then lines = vim.api.nvim_buf_get_lines(0, from - 1, to, false) end
return vim.json.encode({
  file = vim.api.nvim_buf_get_name(0),
  filetype = vim.bo.filetype,
  from = from,
  to = to,
  text = table.concat(lines, '\\n'),
})
`;

// Where nvim puts its sockets: $XDG_RUNTIME_DIR, $TMPDIR/nvim.$USER/<random>/
// (macOS), or named pipes on Windows.
function sockets() {
  if (process.platform === 'win32') {
    return list('\\\\.\\pipe\\').filter((name) => SOCKET_NAME.test(name)).map((name) => `\\\\.\\pipe\\${name}`);
  }
  const found = [];
  const add = (dir) => {
    for (const name of list(dir)) if (SOCKET_NAME.test(name)) found.push(path.join(dir, name));
  };
  if (process.env.XDG_RUNTIME_DIR) add(process.env.XDG_RUNTIME_DIR);
  const tmp = os.tmpdir();
  for (const top of list(tmp).filter((name) => name.startsWith('nvim.'))) {
    for (const sub of list(path.join(tmp, top))) add(path.join(tmp, top, sub));
  }
  return found;
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// The visual selection in whichever nvim has one, or null.
async function selection() {
  const answers = await Promise.all(sockets().map((socket) => ask(socket).catch(() => '')));
  for (const json of answers) {
    if (!json) continue;
    try {
      const sel = JSON.parse(json);
      const lines = sel.from === sel.to ? sel.from : `${sel.from}-${sel.to}`;
      return { ...sel, label: `${sel.file ? path.basename(sel.file) : '[No Name]'}:${lines}` };
    } catch {
      // Not JSON: not an nvim we understand.
    }
  }
  return null;
}

// Your message with the selection in front, the way Claude Code's IDE
// integration passes one along. A huge one goes by reference instead.
function prompt(sel, text) {
  const lines = sel.from === sel.to ? `line ${sel.from}` : `lines ${sel.from}-${sel.to}`;
  const where = `${lines} of ${sel.file || 'an unsaved buffer'} in Neovim`;
  const code = String(sel.text ?? '');
  if (!code || code.length > INLINE_MAX) return `(I've selected ${where}.)\n\n${text}`;
  const longest = Math.max(0, ...Array.from(code.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `I've selected ${where}:\n${fence}${sel.filetype || ''}\n${code}\n${fence}\n\n${text}`;
}

// One msgpack-rpc request: nvim_exec_lua(LUA, []).
function ask(socket) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    let buf = Buffer.alloc(0);
    const done = (err, value) => {
      clearTimeout(timer);
      conn.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => done(new Error('timeout')), TIMEOUT);
    conn.on('error', done);
    conn.on('connect', () => conn.write(encode([0, 1, 'nvim_exec_lua', [LUA, []]])));
    conn.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let at = 0;
      try {
        while (at < buf.length) {
          const [msg, next] = decode(buf, at);
          at = next;
          // [1, id, error, result]; anything else is a notification.
          if (Array.isArray(msg) && msg[0] === 1 && msg[1] === 1) {
            return done(msg[2] ? new Error(String(msg[2][1] ?? msg[2])) : null, msg[3]);
          }
        }
        buf = buf.subarray(at);
      } catch (err) {
        if (!(err instanceof RangeError)) done(err);
        // A partial message: wait for the rest.
      }
    });
  });
}

// ---- just enough msgpack --------------------------------------------------

function encode(value) {
  if (value === null || value === undefined) return Buffer.from([0xc0]);
  if (typeof value === 'boolean') return Buffer.from([value ? 0xc3 : 0xc2]);
  if (Number.isInteger(value) && value >= 0) {
    if (value < 0x80) return Buffer.from([value]);
    const b = Buffer.alloc(5);
    b[0] = 0xce;
    b.writeUInt32BE(value, 1);
    return b;
  }
  if (typeof value === 'string') {
    const s = Buffer.from(value, 'utf8');
    let head;
    if (s.length < 32) head = Buffer.from([0xa0 | s.length]);
    else if (s.length < 0x100) head = Buffer.from([0xd9, s.length]);
    else if (s.length < 0x10000) head = Buffer.from([0xda, s.length >> 8, s.length & 0xff]);
    else {
      head = Buffer.alloc(5);
      head[0] = 0xdb;
      head.writeUInt32BE(s.length, 1);
    }
    return Buffer.concat([head, s]);
  }
  if (Array.isArray(value)) {
    const head = value.length < 16 ? Buffer.from([0x90 | value.length]) : Buffer.from([0xdc, value.length >> 8, value.length & 0xff]);
    return Buffer.concat([head, ...value.map(encode)]);
  }
  throw new TypeError(`can't encode ${typeof value}`);
}

// Returns [value, nextOffset]; throws RangeError if the buffer ends early.
function decode(buf, at) {
  const take = (n) => {
    if (at + n > buf.length) throw new RangeError('msgpack: partial message');
    at += n;
    return buf.subarray(at - n, at);
  };
  const uint = (n) => (n === 8 ? Number(take(8).readBigUInt64BE(0)) : take(n).readUIntBE(0, n));
  const int = (n) => (n === 8 ? Number(take(8).readBigInt64BE(0)) : take(n).readIntBE(0, n));
  const array = (n) => {
    const out = [];
    for (let i = 0; i < n; i++) [out[i], at] = decode(buf, at);
    return out;
  };
  const map = (n) => {
    const out = {};
    for (let i = 0; i < n; i++) {
      let key;
      [key, at] = decode(buf, at);
      [out[key], at] = decode(buf, at);
    }
    return out;
  };

  const t = take(1)[0];
  if (t < 0x80) return [t, at];
  if (t >= 0xe0) return [t - 0x100, at];
  let value;
  if (t >= 0xa0 && t < 0xc0) value = take(t & 0x1f).toString();
  else if (t >= 0x90 && t < 0xa0) value = array(t & 0x0f);
  else if (t >= 0x80 && t < 0x90) value = map(t & 0x0f);
  else if (t === 0xc0) value = null;
  else if (t === 0xc2 || t === 0xc3) value = t === 0xc3;
  else if (t >= 0xc4 && t <= 0xc6) value = take(uint(2 ** (t - 0xc4))); // bin
  else if (t >= 0xc7 && t <= 0xc9) value = take(uint(2 ** (t - 0xc7)) + 1).subarray(1); // ext: type byte, data
  else if (t === 0xca) value = take(4).readFloatBE(0);
  else if (t === 0xcb) value = take(8).readDoubleBE(0);
  else if (t >= 0xcc && t <= 0xcf) value = uint(2 ** (t - 0xcc));
  else if (t >= 0xd0 && t <= 0xd3) value = int(2 ** (t - 0xd0));
  else if (t >= 0xd4 && t <= 0xd8) value = take(2 ** (t - 0xd4) + 1).subarray(1); // fixext: type byte, data
  else if (t >= 0xd9 && t <= 0xdb) value = take(uint(2 ** (t - 0xd9))).toString();
  else if (t === 0xdc || t === 0xdd) value = array(uint(t === 0xdc ? 2 : 4));
  else if (t === 0xde || t === 0xdf) value = map(uint(t === 0xde ? 2 : 4));
  else throw new Error(`msgpack: unknown type 0x${t.toString(16)}`);
  return [value, at];
}

module.exports = { selection, prompt, sockets, encode, decode };
