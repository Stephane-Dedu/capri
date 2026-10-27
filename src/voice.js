// Her voice: the OS speech synthesizer to a WAV file (macOS `say`, Windows
// SAPI through PowerShell), in French or English depending on the text. The
// page plays it through a bitcrusher, so it sounds like her.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const VOICES = {
  darwin: { en: process.env.CAPRI_VOICE_EN || 'Samantha', fr: process.env.CAPRI_VOICE_FR || 'Amélie' },
  win32: { en: 'en-US', fr: 'fr-FR' },
};
const RATE = Number(process.env.CAPRI_VOICE_RATE) || 205; // words per minute (macOS)
const MAX_CHARS = 600;

// What's worth saying out loud from a chat reply: no code, links, markdown
// or stage directions, and only the first few sentences of a long one.
function speakable(text) {
  let t = String(text ?? '')
    .replace(/\[\[\w+\]\]/g, '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*[^*\n]{1,40}\*/g, '')
    .replace(/[*_#>|~]/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length > MAX_CHARS) {
    let out = '';
    for (const sentence of t.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [t]) {
      if (out && (out + sentence).length > MAX_CHARS) break;
      out += sentence;
    }
    t = out.slice(0, MAX_CHARS).trim();
  }
  return t;
}

const FRENCH = /\b(je|tu|il|elle|on|nous|vous|le|la|les|des|une|est|sont|pas|que|qui|pour|avec|dans|sur|ça|c'est|j'ai|mais|donc|aussi|très|fait|faire)\b/gi;
const ENGLISH = /\b(i|you|he|she|it|we|they|the|a|an|is|are|not|that|which|for|with|in|on|this|but|so|also|very|did|do)\b/gi;

function language(text) {
  const fr = (text.match(FRENCH) ?? []).length + (text.match(/[éèêàùçôîœ]/gi) ?? []).length * 0.5;
  const en = (text.match(ENGLISH) ?? []).length;
  return fr > en ? 'fr' : 'en';
}

// A WAV buffer of her saying `text`, or null when there's nothing to say or
// no synthesizer.
async function synth(text) {
  const words = speakable(text);
  if (!words) return null;
  const voices = VOICES[process.platform];
  if (!voices) return null;
  const lang = language(words);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capri-say-'));
  const input = path.join(dir, 'in.txt');
  const output = path.join(dir, 'out.wav');
  try {
    fs.writeFileSync(input, words);
    if (process.platform === 'darwin') {
      await run('say', ['-v', voices[lang], '-r', String(RATE), '-f', input, '-o', output, '--file-format=WAVE', '--data-format=LEI16@22050']);
    } else {
      const ps = [
        'Add-Type -AssemblyName System.Speech',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        `try { $s.SelectVoiceByHints('Female', 'Adult', 0, [Globalization.CultureInfo]'${voices[lang]}') } catch {}`,
        `$s.SetOutputToWaveFile('${output}')`,
        `$s.Speak([IO.File]::ReadAllText('${input}'))`,
        '$s.Dispose()',
      ].join('; ');
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    }
    return fs.readFileSync(output);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
  });
}

module.exports = { synth, speakable, language };
