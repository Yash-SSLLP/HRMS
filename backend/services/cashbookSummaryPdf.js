/**
 * Cashbook reports — the CATEGORY-WISE arithmetic.
 *
 * This file used to draw the category-wise summary PDF as well: one row per
 * spending category and a Final Balance line, on a page of its own. Since
 * 2026-09-26 every report type ends with the full list of its entries, so the
 * category-wise report is drawn by `cashbookEntriesPdf.js` alongside the other
 * three, from the fold below — the figures did not change, only the page they
 * are printed on. What stays here is the pure arithmetic that decides what a
 * printed, signed-off document says, which `scripts/testKhataLedger.js` pins.
 *
 * SIGN CONVENTION, stated once. IN is money that reached the employee (an
 * advance, a reimbursement); OUT is money that left them (spending, a
 * settlement handed back). Balance = In - Out, so a category they only ever
 * spent against reads negative. This matches the wallet's own convention.
 */
// What counts as money — the one definition the wallet, the books and the cash
// accounts are all replayed by, so this document cannot count differently.
const { POSTED_STATUSES } = require('../models/CashbookEntry');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Which way one row moves the running total, under the scope's convention.
 * Kept for the controller, which uses it to compute the opening balance.
 * @param {{direction: string, amount: number}} entry
 * @param {'khata'|'wallet'} scope
 * @returns {number} signed movement
 */
const movement = (entry, scope) => {
  const signed = entry.direction === 'to_employee' ? entry.amount : -entry.amount;
  return scope === 'khata' ? -signed : signed;
};

/**
 * Fold the rows into one line per category, in first-seen order so a book's own
 * headings keep the order the person set them up in. Only POSTED rows count —
 * see the loop.
 * @param {Array<{category?: string, direction: string, amount: number, status?: string}>} entries
 * @returns {{rows: Array<{category: string, count: number, in: number, out: number, balance: number}>,
 *            totals: object, counted: number}}
 */
function summariseByCategory(entries = []) {
  const byCat = new Map();
  let counted = 0;
  for (const e of entries) {
    // ONLY MONEY THAT ACTUALLY MOVED — POSTED_STATUSES, Approved and Reversed:
    //   Rejected          — the request was declined, nothing was paid;
    //   AwaitingApproval  — still with the CEO/MD;
    //   Pending           — sanctioned, but the accounts team has not paid it.
    // Counting any of those printed a declined or unpaid advance as Cash In, so
    // the document's Final Balance disagreed with the balance the app showed.
    // A declined request is still VISIBLE to the employee in the app, with the
    // reason on it — it just is not money, so it is not on the statement.
    //
    // A REVERSED row IS counted, and so is the reversal that cancels it (it
    // carries the same category), so the pair nets to nothing under that
    // heading. This used to skip the Reversed row and keep the reversal, which
    // printed every cancelled expense as money coming back.
    if (!POSTED_STATUSES.includes(e.status)) continue;
    counted += 1;
    const key = (e.category || '').trim() || 'No Category';
    if (!byCat.has(key)) byCat.set(key, { category: key, count: 0, in: 0, out: 0 });
    const row = byCat.get(key);
    row.count += 1;
    if (e.direction === 'to_employee') row.in += Number(e.amount) || 0;
    else row.out += Number(e.amount) || 0;
  }
  const rows = [...byCat.values()].map((r) => ({
    ...r,
    in: round2(r.in),
    out: round2(r.out),
    balance: round2(r.in - r.out),
  }));
  const totals = rows.reduce((t, r) => ({
    in: round2(t.in + r.in), out: round2(t.out + r.out), balance: round2(t.balance + r.balance),
  }), { in: 0, out: 0, balance: 0 });
  return { rows, totals, counted };
}

module.exports = { movement, summariseByCategory };
