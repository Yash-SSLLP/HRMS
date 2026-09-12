/**
 * Rendering editable email / letter templates.
 *
 * `resolve()` merges the code default (services/templateRegistry.js) with the
 * org's override row (models/Template.js), and the render helpers substitute
 * {{variables}}. Every send site should go through here so that editing a
 * template in the admin UI actually changes what goes out.
 *
 * Failure policy: a template that cannot be loaded (DB down, key not in the
 * registry) must never stop an email or a letter. Callers pass the wording they
 * would have used anyway as a fallback, and the resolver returns that instead.
 */
const Template = require('../models/Template');
const { getRegistry, listRegistry } = require('./templateRegistry');

/** Cache overrides briefly — these are read on every send and edited rarely. */
const CACHE_MS = 30_000;
let cache = { at: 0, byKey: new Map() };

/** Drop the cache so an edit shows up on the very next send. */
function invalidate() {
  cache = { at: 0, byKey: new Map() };
}

async function overrides() {
  if (Date.now() - cache.at < CACHE_MS) return cache.byKey;
  const rows = await Template.find({}).lean();
  cache = { at: Date.now(), byKey: new Map(rows.map((r) => [r.key, r])) };
  return cache.byKey;
}

/**
 * The effective template: the override if one exists, else the code default.
 * @param {string} key - Registry key.
 * @returns {Promise<{key, name, format, subject, body, variables, isOverridden}|null>}
 */
async function resolve(key) {
  const base = getRegistry(key);
  if (!base) return null;
  let row;
  try {
    row = (await overrides()).get(key);
  } catch (err) {
    console.error(`Template override lookup failed for ${key}:`, err.message);
  }
  // An override that exists but has an empty body is treated as "not set" —
  // clearing the box in the editor should restore the default, not send blank.
  const body = row && String(row.body || '').trim() ? row.body : base.body;
  const subject = row && String(row.subject || '').trim() ? row.subject : base.subject;
  return { ...base, subject, body, isOverridden: !!row };
}

/**
 * Substitute {{name}} placeholders.
 *
 * An unknown or missing variable is deliberately LEFT AS THE PLACEHOLDER rather
 * than blanked: a candidate receiving "{{salaryMonthly}}" is an obvious bug that
 * gets reported, whereas an empty gap or the word "undefined" reads as intended
 * text and can go unnoticed for months.
 *
 * AN EXPLICIT EMPTY STRING IS NOT "MISSING", THOUGH, and used to be treated as
 * if it were. Several templates carry an optional CLAUSE — `{{linkClause}}`,
 * `{{departmentClause}}`, `{{employeeCodeClause}}` — whose whole job is to
 * disappear when there is nothing to say: a letter with no public token has no
 * link, a candidate with no department has no department sentence. Passing ''
 * for those printed the literal "{{linkClause}}" into a leaver's inbox and
 * "{{departmentClause}}" into an offer letter. So the test is now whether the
 * caller SUPPLIED the name at all, not whether the value is falsy — a caller
 * that deliberately says "nothing here" is honoured, and a genuinely absent
 * variable still shows up as the obvious bug it is.
 * @param {string} text
 * @param {Object} vars
 * @returns {string}
 */
function fill(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) return match;
    const v = vars[name];
    if (v === undefined || v === null) return match;
    return String(v);
  });
}

/**
 * Closing lines, so a repaired link lands above the signature rather than
 * orphaned underneath it. Deliberately a small, literal list: this only decides
 * WHERE a rescued link goes, and a clever regex that mis-fires on body text
 * would move the link somewhere worse than the end.
 */
const SIGN_OFF = /^[ \t]*(warm regards|best regards|kind regards|regards|sincerely|yours sincerely|yours faithfully|thanks|thank you|cheers)\b/i;

/**
 * Put `link` into `body` when the rendered wording doesn't already carry it.
 *
 * Every template is editable in Admin -> Templates, and someone rewriting a
 * covering note has no reason to preserve a `{{link}}` / `{{linkClause}}`
 * placeholder they don't recognise. That is not hypothetical: the appointment
 * letter email was rewritten exactly that way and the letter link disappeared
 * from every appointment mail sent afterwards.
 *
 * The attachment is not a substitute — mail clients strip, block or silently
 * drop PDFs, and the link is the recipient's only other route to the document
 * — so the link is guaranteed by the SEND, not by the wording. Wording that
 * kept the placeholder already contains the URL and is left untouched, so this
 * is a repair, never a duplicate.
 *
 * @param {string} body - Rendered body text.
 * @param {string} link - Absolute URL, or '' when there is nothing to link to.
 * @returns {string}
 */
function ensureLink(body, link) {
  const url = String(link || '').trim();
  const text = String(body || '');
  if (!url || text.includes(url)) return text;

  const clause = `You can also open it here:\n${url}`;
  const lines = text.trimEnd().split('\n');
  // Scan upwards for the sign-off, so a "Regards" inside the message body
  // cannot capture it — only the closing one can.
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!SIGN_OFF.test(lines[i])) continue;
    if (i === 0) break;                       // nothing above it to attach to
    const before = lines.slice(0, i).join('\n').trimEnd();
    return `${before}\n\n${clause}\n\n${lines.slice(i).join('\n')}`;
  }
  return `${lines.join('\n')}\n\n${clause}`;
}

/**
 * Render a mail template to { subject, text }.
 *
 * Passing a `link` variable makes the link a GUARANTEE rather than a wording
 * choice — see ensureLink.
 * @param {string} key - Registry key.
 * @param {Object} vars - Variable values.
 * @param {{subject?: string, body?: string}} [fallback] - Used if the template can't be resolved.
 * @returns {Promise<{subject: string, text: string, body: string}>}
 */
async function renderMail(key, vars = {}, fallback = {}) {
  let t = null;
  try {
    t = await resolve(key);
  } catch (err) {
    console.error(`Template resolve failed for ${key}:`, err.message);
  }
  const subject = fill(t ? t.subject : fallback.subject, vars);
  const text = ensureLink(fill(t ? t.body : fallback.body, vars), vars.link);
  return { subject, text, body: text };
}

/**
 * Render a letter template into the block list letterPdf.js draws.
 *
 * Text conventions (documented for the editor in the admin UI):
 *   blank line          → new paragraph
 *   **wrapped in stars**→ bold paragraph
 *   - Heading: text     → numbered term with a bold heading
 *   a plain line under it→ a further paragraph of that same term
 * @param {string} key - Registry key.
 * @param {Object} vars - Variable values.
 * @param {Array} fallbackBlocks - Blocks to use if the template can't be resolved.
 * @returns {Promise<Array<{type: string, text: string, bold?: boolean, head?: string}>>}
 */
async function renderLetterBlocks(key, vars = {}, fallbackBlocks = []) {
  let t = null;
  try {
    t = await resolve(key);
  } catch (err) {
    console.error(`Template resolve failed for ${key}:`, err.message);
  }
  if (!t || !String(t.body || '').trim()) return fallbackBlocks;
  const blocks = parseLetterBody(fill(t.body, vars));
  return blocks.length ? blocks : fallbackBlocks;
}

/**
 * Parse the letter body text into draw blocks.
 * @param {string} text
 * @returns {Array<{type: string, text: string, bold?: boolean, head?: string}>}
 */
function parseLetterBody(text) {
  return String(text || '')
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .flatMap((chunk) => {
      // A run of "- Heading: text" lines becomes one numbered term each, so a
      // list of clauses can be written as consecutive lines in one block.
      //
      // A line that does NOT open a new "- " clause is a further PARAGRAPH of
      // the one above it, joined into that term's text with a newline. The
      // appointment letter's longer clauses run to four or five paragraphs
      // each, and while the test was `every` rather than "the first line" they
      // could only be written as one unbroken block of type.
      const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length && lines[0].startsWith('- ')) {
        const terms = [];
        lines.forEach((l) => {
          if (!l.startsWith('- ')) {
            // A continuation with no term above it can only be stray text.
            if (terms.length) terms[terms.length - 1].text += `\n${l}`;
            else terms.push({ type: 'para', text: l });
            return;
          }
          const rest = l.slice(2);
          const at = rest.indexOf(':');
          terms.push(at > 0
            ? { type: 'term', head: rest.slice(0, at).trim(), text: rest.slice(at + 1).trim() }
            : { type: 'para', text: rest });
        });
        return terms;
      }
      const joined = lines.join(' ');
      const bold = /^\*\*[\s\S]*\*\*$/.test(joined);
      return [{ type: 'para', bold, text: bold ? joined.replace(/^\*\*|\*\*$/g, '').trim() : joined }];
    });
}

/**
 * The catalogue with each entry's current (possibly overridden) content — what
 * the admin editor lists.
 * @returns {Promise<Array>}
 */
async function listAll() {
  const rows = await overrides().catch(() => new Map());
  return listRegistry().map((base) => {
    const row = rows.get(base.key);
    return {
      ...base,
      subject: row && String(row.subject || '').trim() ? row.subject : base.subject,
      body: row && String(row.body || '').trim() ? row.body : base.body,
      defaultSubject: base.subject,
      defaultBody: base.body,
      isOverridden: !!row,
      updatedAt: row?.updatedAt,
    };
  });
}

module.exports = { resolve, renderMail, renderLetterBlocks, parseLetterBody, fill, ensureLink, listAll, invalidate };
