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
 * @param {string} text
 * @param {Object} vars
 * @returns {string}
 */
function fill(text, vars = {}) {
  return String(text || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name) => {
    const v = vars[name];
    if (v === undefined || v === null || v === '') return match;
    return String(v);
  });
}

/**
 * Render a mail template to { subject, text }.
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
  const text = fill(t ? t.body : fallback.body, vars);
  return { subject, text, body: text };
}

/**
 * Render a letter template into the block list letterPdf.js draws.
 *
 * Text conventions (documented for the editor in the admin UI):
 *   blank line          → new paragraph
 *   **wrapped in stars**→ bold paragraph
 *   - Heading: text     → numbered term with a bold heading
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
      const lines = chunk.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.every((l) => l.startsWith('- '))) {
        return lines.map((l) => {
          const rest = l.slice(2);
          const at = rest.indexOf(':');
          return at > 0
            ? { type: 'term', head: rest.slice(0, at).trim(), text: rest.slice(at + 1).trim() }
            : { type: 'para', text: rest };
        });
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

module.exports = { resolve, renderMail, renderLetterBlocks, parseLetterBody, fill, listAll, invalidate };
