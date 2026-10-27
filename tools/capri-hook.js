#!/usr/bin/env node
// Claude Code hook: tells Capri what a Claude Code session is doing. Claude
// Code pipes the hook event in as JSON on stdin; this trims it to what she
// needs and posts it to her local port. It always exits 0 within a few
// seconds, whether or not she's running, so it never gets in the way.
//
// Install it with `npm run hooks install` (or her tray menu) rather than by
// hand; that adds it to ~/.claude/settings.json as an async hook.

const http = require('node:http');

const PORT = Number(process.env.CAPRI_PORT) || 47913;

// Events from Capri's own session are already on her screen.
if (process.env.CAPRI_SELF) process.exit(0);
setTimeout(() => process.exit(0), 3000).unref();

const cut = (value, n) => {
  const s = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

function trim(e) {
  const out = { event: e.hook_event_name, session: e.session_id, cwd: e.cwd };
  switch (e.hook_event_name) {
    case 'Stop':
      out.message = cut(e.last_assistant_message, 1500);
      break;
    case 'StopFailure':
      out.error = e.error;
      out.message = cut(e.error_details ?? e.last_assistant_message, 600);
      break;
    case 'Notification':
      out.kind = e.notification_type;
      out.message = cut(e.message, 300);
      break;
    case 'UserPromptSubmit':
      out.prompt = cut(e.prompt, 1500);
      break;
    case 'PostToolUse': {
      const input = e.tool_input ?? {};
      const response = e.tool_response ?? {};
      out.tool = e.tool_name;
      out.input = { file_path: input.file_path, command: input.command && cut(input.command, 400) };
      if (input.new_string != null) out.input.change = cut(`- ${input.old_string ?? ''}\n+ ${input.new_string}`, 800);
      else if (input.content != null) out.input.change = cut(input.content, 800);
      if (out.tool === 'Bash' || out.tool === 'PowerShell') {
        const text = [response.stdout, response.stderr].filter(Boolean).join('\n') || cut(response, 600);
        out.output = cut(text.slice(-600), 600);
        out.failed = Boolean(response.interrupted || response.is_error || (response.exitCode ?? response.exit_code ?? 0) !== 0);
      }
      break;
    }
  }
  return out;
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const body = JSON.stringify(trim(event));
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/hook', method: 'POST', timeout: 1500, headers: { 'content-type': 'application/json', 'x-capri': '1' } },
    (res) => {
      res.resume();
      res.on('end', () => process.exit(0));
    },
  );
  req.on('error', () => process.exit(0));
  req.on('timeout', () => req.destroy());
  req.end(body);
});
