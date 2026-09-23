/**
 * Extra Cc recipients typed into a compose box — "a@x.com, b@y.com; c@z.com".
 *
 * Every mail HR can edit before sending (offer and appointment letters, the
 * exit feedback email, the relieving letter, payslips, document requests) takes
 * the same field, so the rule lives once here.
 *
 * STRICT on purpose (2026-09-23): a mistyped address used to be DROPPED
 * silently, so the person HR meant to copy never received the mail and nobody
 * found out. Now the send is refused and the bad entry is named, so it is fixed
 * before anything leaves. The sender is not added here — services/email.js
 * (withActorCc) copies whoever is signed in on every mail anyway.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A copy list, not a mailing list: past this it is almost certainly a paste
// accident, and every address is one more inbox this mail can leak into.
const MAX_CC = 20;

/**
 * Split and check a typed Cc string.
 * @param {*} raw - comma / semicolon / whitespace separated addresses
 * @param {Array<string>|string} [exclude] - addresses already on the mail (To)
 * @returns {{list: string[], invalid: string[]}} de-duplicated, lower-cased
 */
function parseCc(raw, exclude = []) {
  const skip = new Set([].concat(exclude || []).filter(Boolean).map((e) => String(e).trim().toLowerCase()));
  const tokens = String(raw || '').split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const invalid = tokens.filter((e) => !EMAIL_RE.test(e));
  const list = [...new Set(tokens.filter((e) => EMAIL_RE.test(e)).map((e) => e.toLowerCase()))]
    .filter((e) => !skip.has(e));
  return { list, invalid };
}

/**
 * The Cc list a send should use, or a 400 naming what is wrong with it.
 * @param {*} raw - the request's `cc` field
 * @param {Array<string>|string} exclude - addresses already on To
 * @param {import('express').Response} res - for the status on refusal
 * @returns {string[]} addresses to Cc (possibly empty)
 * @throws {Error} with res.status(400) when an entry is not an email address or
 *   there are more than MAX_CC of them
 */
function readCc(raw, exclude, res) {
  const { list, invalid } = parseCc(raw, exclude);
  if (invalid.length) {
    res.status(400);
    throw new Error(`Not an email address in Cc: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}`);
  }
  if (list.length > MAX_CC) {
    res.status(400);
    throw new Error(`Cc can hold at most ${MAX_CC} addresses.`);
  }
  return list;
}

module.exports = { parseCc, readCc, MAX_CC };
