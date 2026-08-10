/**
 * Human-quotable reference codes for money records.
 *
 * Finance needs to be able to point at a single line — in a report, an email, or
 * over the phone — and have everyone land on the same record. A Mongo ObjectId
 * is unusable for that (24 hex characters, unreadable aloud), so every voucher
 * and every reimbursement gets a short code of its own:
 *
 *   VCH-2026-00042   a cashbook entry / petty-cash voucher
 *   EXP-2026-00017   an employee expense claim
 *
 * The number comes from an atomic counter (models/Counter.js), keyed per prefix
 * and per year, so codes are unique, sequential within a year, and safe to mint
 * from concurrent requests. They are assigned once and never rewritten — a code
 * that has been quoted on a printed voucher must keep pointing at the same row.
 */
const Counter = require('../models/Counter');

/** Digits in the running number. 5 covers 99,999 records in a year. */
const WIDTH = 5;

/**
 * Reserve the next number in a series and format it as a reference code.
 * @param {string} prefix - Series prefix, e.g. 'VCH' or 'EXP'.
 * @param {Date} [when] - Record date; picks the year segment. Defaults to now.
 * @returns {Promise<string>} e.g. 'VCH-2026-00042'.
 */
async function nextCode(prefix, when = new Date()) {
  const year = (when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date()).getFullYear();
  const counter = await Counter.findByIdAndUpdate(
    `${prefix.toLowerCase()}:${year}`,
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return `${prefix}-${year}-${String(counter.seq).padStart(WIDTH, '0')}`;
}

/**
 * Mongoose pre-save hook factory: stamp `code` on first save, never after.
 *
 * Applied on the model rather than in the controllers so EVERY creation path is
 * covered — the admin form, an employee voucher, a bulk import, and the ledger
 * row the expense module auto-posts on reimbursement.
 * @param {string} prefix - Series prefix for this model.
 * @param {string} [dateField='date'] - Document field holding the record date.
 * @returns {Function} A pre('save') hook.
 */
function stampCode(prefix, dateField = 'date') {
  return async function assignCode(next) {
    try {
      if (!this.code) this.code = await nextCode(prefix, this.get(dateField));
      next();
    } catch (err) {
      // A counter hiccup must not block the money record itself; it just goes
      // out without a code and can be backfilled.
      console.error(`Could not mint a ${prefix} code:`, err.message);
      next();
    }
  };
}

module.exports = { nextCode, stampCode };
