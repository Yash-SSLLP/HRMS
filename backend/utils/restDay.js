/**
 * Rest-day duty rules, in one place.
 *
 * Salary is spread over CALENDAR days, so a Sunday or a holiday is already paid
 * inside the monthly salary whether or not anyone works it. The company's rule
 * for working one anyway:
 *
 *   Working a **Sunday** or an **org-wide Comp Off day** pays DOUBLE for that
 *   day — but only once HR or the employee's reporting manager approves it.
 *   Not working it, or working it without approval, pays exactly as before.
 *
 * Ordinary Public/Restricted/Company holidays are deliberately NOT included: a
 * festival holiday worked pays normally unless HR files that day as a Comp Off.
 *
 * Because the base salary already pays the day once, payroll adds ONE more day's
 * pay per approved full day (half of one for a half day) — that is what makes
 * the day 2×. See `computeEmployeeRun` in controllers/payrollController.js.
 *
 * Attendance, manager and payroll all import from here so the definition of a
 * rest day cannot drift between the approval queue and the money.
 */
const { ymdIST } = require('./dateHelpers');
const { COMP_OFF } = require('../models/Holiday');

/**
 * IST day keys of the org-wide comp-off days in a set of Holiday docs.
 * @param {Array<{date: Date, type?: string}>} holidays
 * @returns {Set<string>} 'YYYY-MM-DD' keys
 */
function compOffKeysFor(holidays) {
  return new Set((holidays || []).filter((h) => h && h.type === COMP_OFF).map((h) => ymdIST(h.date)));
}

/**
 * Is this IST day key a Sunday? Anchored in UTC from the key's own parts, so it
 * is independent of the server timezone.
 * @param {string} key 'YYYY-MM-DD'
 * @returns {boolean}
 */
function isSundayKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return false;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

/**
 * Is this day one the company is off — a Sunday or an org-wide comp-off day?
 * @param {string} key 'YYYY-MM-DD'
 * @param {Set<string>} [compOffKeys] from compOffKeysFor()
 * @returns {boolean}
 */
function isRestDayKey(key, compOffKeys) {
  return isSundayKey(key) || !!(compOffKeys && compOffKeys.has(key));
}

/**
 * Same test for an attendance record.
 * @param {{date: Date}} record
 * @param {Set<string>} [compOffKeys]
 * @returns {boolean}
 */
function isRestDayRecord(record, compOffKeys) {
  if (!record || !record.date) return false;
  return isRestDayKey(ymdIST(record.date), compOffKeys);
}

/**
 * How much of an extra day's pay an approved rest day is worth: a full day for
 * a day worked in full, half for a half day, nothing otherwise.
 * @param {{status?: string, checkIn?: Date}} record
 * @returns {number} 1, 0.5 or 0
 */
function restDayCredit(record) {
  if (!record || !record.checkIn) return 0;
  if (record.status === 'Present') return 1;
  if (record.status === 'HalfDay') return 0.5;
  return 0;
}

/**
 * The double-pay state of one attendance record.
 *
 * A rest day with a punch is a claim: 'Pending' until someone decides it, then
 * whatever they decided. `null` means the day isn't a claim at all (an ordinary
 * working day, or a rest day nobody worked).
 * @param {{date: Date, status?: string, checkIn?: Date, doublePay?: {status?: string}}} record
 * @param {Set<string>} [compOffKeys]
 * @returns {'Pending'|'Approved'|'Rejected'|null}
 */
function doublePayState(record, compOffKeys) {
  if (!isRestDayRecord(record, compOffKeys)) return null;
  if (!restDayCredit(record)) return null;
  return record.doublePay?.status || 'Pending';
}

/**
 * Days of EXTRA pay owed for a month's records — the approved rest days only.
 * The rest-day test is re-applied here rather than trusted from approval time,
 * so removing a comp-off day from the calendar can never leave paid-out days
 * behind.
 * @param {Array<Object>} records attendance records for the month
 * @param {Set<string>} [compOffKeys]
 * @returns {number} e.g. 1.5
 */
function approvedDoublePayDays(records, compOffKeys) {
  const total = (records || []).reduce((sum, r) => (
    r?.doublePay?.status === 'Approved' && isRestDayRecord(r, compOffKeys)
      ? sum + restDayCredit(r)
      : sum
  ), 0);
  return +total.toFixed(1);
}

module.exports = {
  COMP_OFF,
  compOffKeysFor,
  isSundayKey,
  isRestDayKey,
  isRestDayRecord,
  restDayCredit,
  doublePayState,
  approvedDoublePayDays,
};
