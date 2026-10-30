// Rewriting your selection in place: "make this nicer", "in English",
// "corrige les fautes". One call to the fast model with no tools; the result
// replaces the selection in whatever app you're in (mac.js), and that app's
// own undo (⌘Z) takes it back.

const os = require('node:os');
const { loadSdk, claudeEnv, TIERS } = require('./agent');
const costs = require('./costs');

const MODEL = TIERS.fast.model;

// Instructions that mean "change this text", in English and French.
const ASK = /^\W*(?:please\s+|s'il te pla[iî]t\s+|stp\s+)?(?:make|rewrite|rephrase|reword|translate|fix|correct|shorten|simplify|polish|improve|clean up|tidy|turn|reformat|rends|réécris|reecris|reformule|traduis|corrige|raccourcis|simplifie|améliore|ameliore|mets|transforme|fais[- ]en|(?:in|en|into)\s+(?:english|anglais|french|français|francais|spanish|espagnol))\b/i;

const PROMPT = `You rewrite text as instructed. Reply with the rewritten text only: no preamble, no quotes, no comments. Keep the original language unless the instruction asks to translate. Keep line breaks, lists, code and formatting unless told otherwise. If the instruction makes no sense for this text, return the text unchanged.`;

function wants(instruction) {
  return ASK.test(instruction);
}

async function rewrite(text, instruction) {
  if (costs.over) return null;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 30000);
  try {
    const { query } = await loadSdk();
    const q = query({
      prompt: `Instruction: ${instruction}\n\nText:\n${text}`,
      options: { model: MODEL, effort: 'low', systemPrompt: PROMPT, tools: [], maxTurns: 1, settingSources: [], persistSession: false, cwd: os.tmpdir(), abortController, env: claudeEnv() },
    });
    for await (const m of q) {
      if (m.type !== 'result') continue;
      costs.add(MODEL, m.total_cost_usd);
      return m.subtype === 'success' && !m.is_error ? String(m.result ?? '').replace(/^\s*\[\[\w+\]\]\s*/, '').trim() || null : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { wants, rewrite };
