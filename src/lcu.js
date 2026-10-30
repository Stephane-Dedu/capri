// The League client's local API (the "LCU"): a REST server the client runs
// on 127.0.0.1, with a new port and password each time it starts, written to
// its lockfile and passed on its command line. It's unofficial but stable,
// and it's what every champ-select tool talks to. Nothing here ever leaves
// the machine.

const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const { execFile } = require('node:child_process');

const LOCKFILES = {
  darwin: ['/Applications/League of Legends.app/Contents/LoL/lockfile'],
  win32: ['C:\\Riot Games\\League of Legends\\lockfile', 'D:\\Riot Games\\League of Legends\\lockfile'],
  linux: [],
};
const TIMEOUT = 5000;

// The client's certificate is signed by Riot's own local root, so it can't be
// checked against the system's. This agent is only ever used for 127.0.0.1.
const local = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

class LCU {
  constructor() {
    this.creds = null; // { port, password, protocol }
  }

  // Port and password from the lockfile (CAPRI_LEAGUE_DIR first), or from the
  // running client's command line.
  async connect() {
    if (this.creds) return this.creds;
    const dirs = process.env.CAPRI_LEAGUE_DIR ? [`${process.env.CAPRI_LEAGUE_DIR.replace(/[\\/]$/, '')}/lockfile`] : [];
    for (const file of [...dirs, ...(LOCKFILES[process.platform] ?? [])]) {
      try {
        const [, , port, password, protocol] = fs.readFileSync(file, 'utf8').trim().split(':');
        if (port && password) return (this.creds = { port: Number(port), password, protocol: protocol || 'https' });
      } catch {
        // Not installed there, or not running.
      }
    }
    const args = await commandLine().catch(() => '');
    const port = args.match(/--app-port=(\d+)/)?.[1];
    const password = args.match(/--remoting-auth-token=([\w-]+)/)?.[1];
    return (this.creds = port && password ? { port: Number(port), password, protocol: 'https' } : null);
  }

  // JSON from the client, null for "not found" (no champ select, no ready
  // check). Throws when the client isn't running.
  async request(method, path, body) {
    const creds = await this.connect();
    if (!creds) throw new Error('the League client is not running');
    try {
      return await send(creds, method, path, body);
    } catch (err) {
      // The client restarted (new port) or quit: look again next time.
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.status === 401) this.creds = null;
      throw err;
    }
  }

  get(path) {
    return this.request('GET', path);
  }

  patch(path, body) {
    return this.request('PATCH', path, body);
  }

  post(path, body) {
    return this.request('POST', path, body);
  }

  // Bytes rather than JSON (champion icons).
  async bytes(path) {
    const creds = await this.connect();
    if (!creds) throw new Error('the League client is not running');
    return send(creds, 'GET', path, undefined, true);
  }
}

function send({ port, password, protocol }, method, path, body, raw = false) {
  const data = body === undefined ? null : JSON.stringify(body);
  const lib = protocol === 'http' ? http : https;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: protocol === 'http' ? undefined : local,
        timeout: TIMEOUT,
        headers: {
          Authorization: `Basic ${Buffer.from(`riot:${password}`).toString('base64')}`,
          Accept: 'application/json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (res.statusCode === 404) return resolve(null);
          if (raw && res.statusCode < 400) return resolve(Buffer.concat(chunks));
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          if (res.statusCode >= 400) {
            const err = new Error(json?.message || `HTTP ${res.statusCode} on ${method} ${path}`);
            err.status = res.statusCode;
            return reject(err);
          }
          resolve(json);
        });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('the League client did not answer'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// The running LeagueClientUx's arguments, which carry the port and password.
function commandLine() {
  return new Promise((resolve, reject) => {
    const done = (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout)));
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine"], { timeout: 8000, windowsHide: true }, done);
    } else {
      execFile('ps', ['-A', '-o', 'args='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) =>
        done(err, String(stdout ?? '').split('\n').find((line) => line.includes('LeagueClientUx') && line.includes('--app-port=')) ?? ''),
      );
    }
  });
}

module.exports = { LCU };
