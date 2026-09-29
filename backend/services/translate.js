/**
 * TRANSLATING WHAT PEOPLE TYPED (2026-09-29).
 *
 * The app's language switch (Settings → Language: Hindi, Kannada, Tamil,
 * Telugu, Malayalam) translates the app's OWN words from a phrase table. The
 * user: "translate other details also like names, tasks — those too should
 * change to their selected language, like the task title which a user is
 * sending". Those are typed by people, so they are translated here, by Claude
 * (Haiku 4.5 — the user's choice), when a reader in that language asks for
 * them:
 *
 *   text  task titles, descriptions, remarks, reasons, notification text —
 *         translated (codes, numbers, amounts and dates kept as they are)
 *   name  people's names — written in the language's script, never translated
 *
 * HOW A READ WORKS. The app sends `X-App-Lang` (hi/kn/ta/te/ml; nothing for
 * English). `localise(req, value)` walks the response, collects the strings
 * under the keys below, and swaps in the translations: memory first, then the
 * TextTranslation collection, then ONE batched Claude call for what is new.
 * A new string costs one call ever per language; after that it is a lookup.
 *
 * NEVER IN THE WAY. No ANTHROPIC_API_KEY, no SDK installed, the API down, slow
 * or refusing — the reader gets the English they would have got anyway. A read
 * waits at most WAIT_MS for new translations; past that it answers in English
 * and the translation carries on in the background, so the next read has it.
 *
 * THE RIGHT SCRIPT OR NOTHING (found on the first live run, 2026-09-29: Haiku
 * put Hindi and Bengali letters inside Tamil). Every answer is checked — only
 * the target script's letters (plus Latin for codes and ordinary digits); a bad
 * one is asked for again once, and if it is still bad the English is kept (and
 * remembered, so it is not paid for again on every read).
 *
 * A SUPER ADMIN SWITCH (Setting.typedTextTranslation, Permissions →
 * Organisation, 2026-09-29: "so that we can restrict the use of API key"). Off
 * = everybody reads what was typed, in English, and no call is made. What it
 * cost is counted per month (TranslationUsage) and shown beside the switch.
 */
const crypto = require('crypto');
const TextTranslation = require('../models/TextTranslation');
const TranslationUsage = require('../models/TranslationUsage');

// The model the user chose (2026-09-29): translation and transliteration of
// short strings, many of them, cheaply. TRANSLATE_MODEL in .env swaps it
// without a code change (e.g. claude-sonnet-5, the stronger translator).
const MODEL = String(process.env.TRANSLATE_MODEL || 'claude-haiku-4-5').trim();

// List prices per million tokens [input, output], for the monthly cost shown
// beside the switch. An unknown model is costed as Sonnet (the dearer guess).
const PRICES = { 'claude-haiku-4-5': [1, 5], 'claude-sonnet-5': [2, 10] };
const priceOf = (model) => PRICES[model] || PRICES['claude-sonnet-5'];

/** The app's languages other than English: the name the prompt uses, and the script. */
const LANGS = {
  hi: { name: 'Hindi', script: 'Devanagari' },
  kn: { name: 'Kannada', script: 'Kannada' },
  ta: { name: 'Tamil', script: 'Tamil' },
  te: { name: 'Telugu', script: 'Telugu' },
  ml: { name: 'Malayalam', script: 'Malayalam' },
};

/** Keys whose string values are translated, and keys that hold a person's name. */
const TEXT_KEYS = new Set([
  'title', 'description', 'note', 'reason', 'stateNote', 'decisionNote', 'parentTitle', 'body',
]);
const NAME_KEYS = new Set([
  'name', 'byName', 'createdByName', 'approverName', 'requestedByName', 'decidedByName',
  'fromName', 'toName', 'assigneeName', 'lastEditedByName',
]);
/**
 * Never walked into: file names, links, the populated user objects (their
 * name is carried in the snapshot fields above), machine data, and the edit
 * trail (its before/after are compared, not read as prose).
 */
const SKIP_KEYS = new Set([
  'attachments', 'files', 'voiceNote', 'evidence', 'links', 'can', 'accent', 'repeat', 'reminders',
  'edits', 'changes', 'workflow', 'requirements', 'user', 'createdBy', 'photo', 'data', 'link',
  'loopUsers', 'openTo',
]);

const WAIT_MS = 4000;          // the longest a read waits for NEW translations
const CHUNK_ITEMS = 40;        // strings per Claude call
const CHUNK_CHARS = 3000;      // …and characters
const MEMORY_CAP = 5000;       // entries kept in this process

const memory = new Map();      // key → translated text (insertion order = age)
const inFlight = new Map();    // key → Promise<string|null>, so two readers share one call

let client = null;
let clientTried = false;
let lastErrorLogAt = 0;

/** The Claude client, or null when there is no key or no SDK (then nothing is translated). */
function getClient() {
  if (clientTried) return client;
  clientTried = true;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try {
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.default || sdk;
    // Short and few retries: a reader is waiting, and a miss only means English.
    client = new Anthropic({ timeout: 30000, maxRetries: 1 });
  } catch (err) {
    console.warn('[translate] @anthropic-ai/sdk is not installed — typed text stays in English.');
    client = null;
  }
  return client;
}

/** Log a failure at most once a minute — a dead key must not flood the log. */
function logFailure(err) {
  const now = Date.now();
  if (now - lastErrorLogAt < 60000) return;
  lastErrorLogAt = now;
  console.warn(`[translate] ${err?.status || ''} ${err?.message || err}`.trim());
}

/** The reader's language from the app's header, or null for English / unknown. */
function langOf(req) {
  const raw = String(req?.get?.('x-app-lang') || req?.headers?.['x-app-lang'] || '').trim().toLowerCase();
  return LANGS[raw] ? raw : null;
}

const keyOf = (kind, lang, source) => crypto.createHash('sha1').update(`${kind}|${lang}|${source}`).digest('hex');

function remember(key, text) {
  if (memory.has(key)) memory.delete(key);
  memory.set(key, text);
  if (memory.size > MEMORY_CAP) memory.delete(memory.keys().next().value);
}

/** Worth sending at all: has English letters in it (not a code-only, number-only or already-Indic string). */
const worthTranslating = (s) => /[A-Za-z]{2,}/.test(s) && !/^[A-Z]{2,5}-\d{4}-\d+$/.test(s);

const SYSTEM = {
  text: (L) => `You translate short texts that staff typed into an Indian company's HR and task app into ${L.name}.
Keep the meaning, the tone and the brevity - these are task titles, remarks and notifications, not essays.
Write EVERY person's name in ${L.script} script as it is pronounced (never leave a name in English letters, never translate what it means). Initials are spelled by their sound.
Text in quotes is usually a task's title - translate it too.
Keep reference codes (like TSK-2026-00012 or KHT-2026-00079), amounts, dates, times, email addresses and URLs exactly as they are, and write numbers with the digits 0-9.
Use only ${L.script} letters for ${L.name} words - never letters of another Indian script.
If a text is a mixture such as Hinglish, translate its meaning into ${L.name}. If it is already in ${L.name}, return it unchanged.
Return only the translations - no quotes around them, no notes or explanations.`,
  name: (L) => `You write people's names in ${L.script} script for readers of ${L.name}.
Transliterate each name the way it is pronounced - never translate what a name means.
Spell an initial by its sound (for example "K." is written as the ${L.script} spelling of "Kay").
Use only ${L.script} letters - never letters of another Indian script.
Return only the names, one per input, in the same order.`,
};

/** Said on the second try, to the items whose first answer broke the script rule. */
const RETRY_NOTE = (L) => `\nIMPORTANT: an earlier answer mixed in letters of another script. Every ${L.name} word must use ${L.script} letters only, with digits 0-9.`;

/**
 * Each language's Unicode block, for the script check. Any other Indian
 * script's letter in the answer — or that script's own digits — fails it.
 */
const BLOCKS = {
  hi: [0x0900, 0x097F], kn: [0x0C80, 0x0CFF], ta: [0x0B80, 0x0BFF], te: [0x0C00, 0x0C7F], ml: [0x0D00, 0x0D7F],
};

// A code point Unicode has not assigned — no such letter exists.
const UNASSIGNED = new RegExp(String.raw`\p{Cn}`, 'u');

/** Is this answer written in the language's own script (and nothing else Indian)? */
function scriptOk(text, lang) {
  const [lo, hi] = BLOCKS[lang];
  let own = 0;
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if (c < 0x0900 || c > 0x0DFF) continue;          // Latin, digits, punctuation, ₹ …
    if (c === 0x0964 || c === 0x0965) continue;       // the danda
    if (c < lo || c > hi) return false;               // another script's letter
    if (UNASSIGNED.test(ch)) return false;          // no such letter (Haiku made one up in Tamil)
    if (c - lo >= 0x66 && c - lo <= 0x6F) return false; // its own digits — we asked for 0-9
    own += 1;
  }
  return own > 0;
}

const SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'string' } } },
  required: ['items'],
  additionalProperties: false,
};

/**
 * One Claude call for up to CHUNK_ITEMS strings.
 * @returns {Promise<string[]|null>} the translations in input order, or null when unusable
 */
async function callClaude(items, lang, kind, retry = false) {
  const c = getClient();
  if (!c) return null;
  const L = LANGS[lang];
  const chars = items.reduce((n, s) => n + s.length, 0);
  const response = await c.messages.create({
    model: MODEL,
    // Indic scripts take several tokens per character; room to spare.
    max_tokens: Math.min(16000, 1024 + chars * 8),
    system: SYSTEM[kind](L) + (retry ? RETRY_NOTE(L) : ''),
    messages: [{
      role: 'user',
      content: `Return {"items": [...]} with exactly ${items.length} strings - the i-th is the ${kind === 'name' ? `name written in ${L.script} script` : `${L.name} translation`} of the i-th input.\n\n${JSON.stringify({ items })}`,
    }],
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA },
      // Short translations need little thought. Haiku 4.5 takes no effort
      // setting (it would be a 400); a newer model does, and thinks less.
      ...(MODEL.startsWith('claude-haiku') ? {} : { effort: 'low' }),
    },
  });
  countUsage(items.length, response.usage);
  if (response.stop_reason !== 'end_turn') {
    // max_tokens (cut short) or refusal: nothing here can be trusted.
    logFailure(new Error(`stopped: ${response.stop_reason}`));
    return null;
  }
  const block = response.content.find((b) => b.type === 'text');
  if (!block) return null;
  let parsed;
  try { parsed = JSON.parse(block.text); } catch { return null; }
  const out = Array.isArray(parsed?.items) ? parsed.items : null;
  // A list of the wrong length cannot be matched back to its inputs.
  if (!out || out.length !== items.length) return null;
  // null = this one is not usable (empty, or the wrong script).
  return out.map((t) => (typeof t === 'string' && t.trim() && scriptOk(t.trim(), lang) ? t.trim() : null));
}

/**
 * One chunk: ask, then ask again once for whatever came back in the wrong
 * script. What is still wrong after that keeps its English.
 * @returns {Promise<Array<string>|null>} a translation (or the source) per item; null if the call failed
 */
async function translateChunk(items, lang, kind) {
  const first = await callClaude(items, lang, kind);
  if (!first) return null;
  const bad = first.map((t, i) => (t === null ? i : -1)).filter((i) => i >= 0);
  if (bad.length) {
    let second = null;
    try { second = await callClaude(bad.map((i) => items[i]), lang, kind, true); } catch (err) { logFailure(err); }
    bad.forEach((i, j) => { first[i] = second?.[j] ?? null; });
  }
  // Still wrong: remember the English, so it is not paid for on every read.
  return first.map((t, i) => t ?? items[i]);
}

/** Add one call to this month's count (IST month). Never throws. */
function countUsage(strings, usage) {
  const month = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' })
    .format(new Date()).slice(0, 7);
  TranslationUsage.updateOne(
    { month },
    {
      $inc: {
        calls: 1,
        strings,
        inputTokens: Number(usage?.input_tokens) || 0,
        outputTokens: Number(usage?.output_tokens) || 0,
      },
    },
    { upsert: true }
  ).catch(logFailure);
}

// ===== The Super Admin switch =====

let enabledCache = { value: true, at: 0 };
const ENABLED_TTL = 30000;

/** Is typed-text translation switched on? (Setting.typedTextTranslation, cached 30 s.) */
async function isEnabled() {
  if (Date.now() - enabledCache.at < ENABLED_TTL) return enabledCache.value;
  try {
    const Setting = require('../models/Setting');
    const s = await Setting.getSettings();
    enabledCache = { value: s.typedTextTranslation !== false, at: Date.now() };
  } catch (err) {
    logFailure(err);
    enabledCache = { value: enabledCache.value, at: Date.now() };
  }
  return enabledCache.value;
}

/** After the switch is saved, so this process obeys it at once. */
function setEnabled(value) { enabledCache = { value: Boolean(value), at: Date.now() }; }

/** This month's and last month's spend, for the switch's screen. */
async function usageSummary() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' });
  const now = new Date();
  const thisMonth = fmt.format(now).slice(0, 7);
  const prev = new Date(now.getTime()); prev.setUTCDate(1); prev.setUTCMonth(prev.getUTCMonth() - 1);
  const lastMonth = fmt.format(prev).slice(0, 7);
  const rows = await TranslationUsage.find({ month: { $in: [thisMonth, lastMonth] } }).lean();
  // At the configured model's list price (an estimate — the Anthropic
  // console's billing is the real figure).
  const [inPrice, outPrice] = priceOf(MODEL);
  const shape = (r, month) => ({
    month,
    calls: r?.calls || 0,
    strings: r?.strings || 0,
    inputTokens: r?.inputTokens || 0,
    outputTokens: r?.outputTokens || 0,
    // Four places: a month of light use is a fraction of a cent.
    costUsd: Math.round((((r?.inputTokens || 0) * inPrice + (r?.outputTokens || 0) * outPrice) / 1e6) * 10000) / 10000,
  });
  return {
    keySet: Boolean(process.env.ANTHROPIC_API_KEY),
    model: MODEL,
    thisMonth: shape(rows.find((r) => r.month === thisMonth), thisMonth),
    lastMonth: shape(rows.find((r) => r.month === lastMonth), lastMonth),
    cachedTexts: await TextTranslation.estimatedDocumentCount(),
  };
}

/** Translate the uncached strings of one kind, in chunks; store what comes back. */
async function fetchMissing(sources, lang, kind) {
  const chunks = [];
  let cur = [];
  let size = 0;
  for (const s of sources) {
    if (cur.length && (cur.length >= CHUNK_ITEMS || size + s.length > CHUNK_CHARS)) {
      chunks.push(cur); cur = []; size = 0;
    }
    cur.push(s); size += s.length;
  }
  if (cur.length) chunks.push(cur);

  await Promise.all(chunks.map(async (chunk) => {
    let out = null;
    try {
      out = await translateChunk(chunk, lang, kind);
    } catch (err) {
      logFailure(err);
    }
    if (!out) return;
    const ops = chunk.map((source, i) => {
      const key = keyOf(kind, lang, source);
      remember(key, out[i]);
      return {
        updateOne: {
          filter: { key },
          update: { $set: { key, lang, kind, source, text: out[i] } },
          upsert: true,
        },
      };
    });
    try { await TextTranslation.bulkWrite(ops, { ordered: false }); } catch (err) { logFailure(err); }
  }));
}

/**
 * Translate a set of strings of one kind into `lang`.
 * @param {string[]} strings
 * @param {string} lang - one of LANGS
 * @param {'text'|'name'} [kind]
 * @param {{waitMs?: number}} [opts] - how long to wait for NEW translations
 * @returns {Promise<Map<string,string>>} source → translation, for what is known in time
 */
async function translateStrings(strings, lang, kind = 'text', { waitMs = WAIT_MS } = {}) {
  const result = new Map();
  if (!LANGS[lang]) return result;
  if (!(await isEnabled())) return result;
  const sources = [...new Set((strings || []).map((s) => String(s || '').trim()).filter((s) => s && worthTranslating(s)))];
  if (!sources.length) return result;

  // 1. this process's memory
  const needDb = [];
  for (const s of sources) {
    const hit = memory.get(keyOf(kind, lang, s));
    if (hit !== undefined) result.set(s, hit); else needDb.push(s);
  }
  if (!needDb.length) return result;

  // 2. the collection
  const keys = new Map(needDb.map((s) => [keyOf(kind, lang, s), s]));
  try {
    const rows = await TextTranslation.find({ key: { $in: [...keys.keys()] } }).select('key text').lean();
    for (const r of rows) {
      remember(r.key, r.text);
      result.set(keys.get(r.key), r.text);
      keys.delete(r.key);
    }
  } catch (err) {
    logFailure(err);
  }
  if (!keys.size || !getClient()) return result;

  // 3. Claude, once per string however many readers ask at the same moment.
  const fresh = [];
  const waits = [];
  for (const [key, s] of keys) {
    if (inFlight.has(key)) { waits.push(inFlight.get(key)); continue; }
    fresh.push(s);
  }
  if (fresh.length) {
    const job = fetchMissing(fresh, lang, kind).catch(logFailure);
    fresh.forEach((s) => {
      const key = keyOf(kind, lang, s);
      inFlight.set(key, job.then(() => memory.get(key) ?? null).finally(() => inFlight.delete(key)));
    });
    waits.push(job);
  }
  // Wait a little; past that, answer with what we have and let the job finish.
  await Promise.race([Promise.allSettled(waits), new Promise((r) => { setTimeout(r, waitMs); })]);
  for (const [key, s] of keys) {
    const hit = memory.get(key);
    if (hit !== undefined) result.set(s, hit);
  }
  return result;
}

/** Visit every translatable string under `value`; `fn(kind, holder, key)`. */
function walk(value, fn, depth = 0) {
  if (depth > 8 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((v) => walk(v, fn, depth + 1)); return; }
  if (value instanceof Date || Buffer.isBuffer(value) || value._bsontype) return;
  for (const [k, v] of Object.entries(value)) {
    if (SKIP_KEYS.has(k)) continue;
    if (typeof v === 'string') {
      if (TEXT_KEYS.has(k)) fn('text', value, k);
      else if (NAME_KEYS.has(k)) fn('name', value, k);
    } else if (v && typeof v === 'object') {
      walk(v, fn, depth + 1);
    }
  }
}

/**
 * Translate a response IN PLACE for the reader's language (X-App-Lang). Plain
 * objects only (lean rows, decorated copies) — the caller's own values, never
 * a shared or cached object. English readers, and every failure, pass through.
 * @param {object} req
 * @param {...object} values - the parts of the response to translate
 */
async function localise(req, ...values) {
  const lang = langOf(req);
  if (!lang || !getClient()) return;
  if (!(await isEnabled())) return;
  const wanted = { text: new Set(), name: new Set() };
  values.forEach((v) => walk(v, (kind, holder, key) => wanted[kind].add(holder[key].trim())));
  if (!wanted.text.size && !wanted.name.size) return;
  const [texts, names] = await Promise.all([
    translateStrings([...wanted.text], lang, 'text'),
    translateStrings([...wanted.name], lang, 'name'),
  ]);
  if (!texts.size && !names.size) return;
  values.forEach((v) => walk(v, (kind, holder, key) => {
    const hit = (kind === 'name' ? names : texts).get(holder[key].trim());
    if (hit) holder[key] = hit;
  }));
}

module.exports = {
  MODEL, LANGS, langOf, localise, translateStrings, worthTranslating, scriptOk,
  isEnabled, setEnabled, usageSummary,
  // for tests
  _walk: walk, _setClient: (c) => { client = c; clientTried = true; }, _memory: memory,
};
