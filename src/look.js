// A quick look at your screen when you summon her. One screenshot of the
// display you're on, downscaled, goes to the fast model in a single call with
// no tools. She says something about it, and its plain description (never
// the image) goes along with your next message, so the main conversation
// gets the context for a few hundred tokens. Nothing else triggers a look.

const os = require('node:os');
const { desktopCapturer, screen, systemPreferences } = require('electron');
const { loadSdk, claudeEnv, TIERS } = require('./agent');
const { LOOK_PROMPT, MOODS } = require('./persona');

const MODEL = process.env.CAPRI_LOOK_MODEL || TIERS.fast.model;
const LONG_EDGE = 1568; // the largest image Claude takes without shrinking it
const TIMEOUT = 20000;

// 'granted', 'not-determined' (macOS asks on the first capture), 'denied'…
function access() {
  return process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
}

// A JPEG of the display under `point`, or null. On Linux, Wayland would pop a
// screen picker every time, so she doesn't look there.
async function capture(point) {
  if (process.platform === 'linux' || !['granted', 'not-determined'].includes(access())) return null;
  const display = screen.getDisplayNearestPoint(point);
  const { width, height } = display.size;
  const scale = Math.min(1, LONG_EDGE / Math.max(width, height));
  const thumbnailSize = { width: Math.round(width * scale), height: Math.round(height * scale) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize });
  // Without the permission macOS hands back the wallpaper and nothing else.
  if (access() !== 'granted') return null;
  const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
  return source && !source.thumbnail.isEmpty() ? source.thumbnail.toJPEG(80) : null;
}

// { mood, comment, summary } from the fast model, or null.
async function describe(jpeg) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT);
  try {
    const { query } = await loadSdk();
    const q = query({
      prompt: once({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } },
            { type: 'text', text: 'The user just summoned you. This is their screen.' },
          ],
        },
        parent_tool_use_id: null,
      }),
      options: {
        model: MODEL,
        effort: 'low',
        systemPrompt: LOOK_PROMPT,
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        cwd: os.tmpdir(),
        abortController,
        env: claudeEnv(),
      },
    });
    for await (const m of q) {
      if (m.type === 'result') return m.subtype === 'success' && !m.is_error ? parse(m.result) : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function* once(message) {
  yield message;
}

// "[[mood]] remark\n---\ndescription"
function parse(text) {
  const [head, ...rest] = String(text ?? '').split(/^\s*-{3,}\s*$/m);
  const match = head.match(/^\s*\[\[(\w+)\]\]\s*/);
  const mood = match && MOODS.includes(match[1]) ? match[1] : 'curious';
  const comment = head.replace(/\[\[\w+\]\]/g, '').trim().split('\n')[0].slice(0, 200);
  const summary = rest.join('\n').trim().slice(0, 1500);
  return comment || summary ? { mood, comment, summary } : null;
}

// Your message, after what she saw when you called her.
function prompt(look, text) {
  const said = look.comment ? ` You glanced at my screen and said: "${look.comment}".` : '';
  return `[When I summoned you just now.${said} What was on my screen then, from a quick look at a screenshot:\n${look.summary}]\n\n${text}`;
}

module.exports = { access, capture, describe, prompt };
