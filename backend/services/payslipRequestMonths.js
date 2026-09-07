/**
 * Which months an employee may ask for a payslip for — the single source of
 * truth, so the two clients never have to work it out and cannot disagree.
 *
 * The window is [joining month .. last COMPLETED month], clamped at the top by
 * the employee's exit month when they have one. Both bounds are real rules, not
 * tidiness:
 *
 *   LOWER — the joining month. `dateOfJoining` is required on every profile, and
 *   the payroll engine already refuses to count days before it (see
 *   utils/monthlyQuota daysOnPayroll). Ask for a month before somebody joined
 *   and the engine produces a slip with full earnings and a full-month loss-of-pay
 *   clawback — arithmetically consistent, and meaningless as a document.
 *
 *   UPPER — the last month that has ENDED. Payroll charges no-punch loss of pay
 *   only for days already past (computeEmployeeRun skips today and later), so a
 *   slip cut mid-month understates the deduction and WILL change before the month
 *   is out. Correcting it means re-running, and a re-run resets `status` to
 *   Draft — which would pull a payslip back that had already been released. So
 *   the running month is not offered, and the refusal says when it will be.
 *
 * There is deliberately NO cap on how far back the window reaches. A payslip for
 * a month that predates attendance capture computes badly (every unmatched day
 * falls through to no-punch LOP), but that is HR's judgement to make when they
 * generate and approve the figures — it is not a reason to refuse the ASK. An
 * employee chasing a two-year-old slip for a loan or a visa is the case this
 * feature exists for.
 *
 * Month arithmetic goes through `monthOrdinal` so comparisons are one integer
 * rather than a pair, and everything is anchored to the IST calendar (the
 * deployed host runs UTC, where `new Date().getMonth()` names the wrong month
 * for five and a half hours every night).
 */
const { ymdIST } = require('../utils/dateHelpers');

/**
 * How many requests one employee may have open with HR at once (release status
 * Requested or Approved). Not a policy about payslips — a bound on the queue, so
 * one person catching up on two years of slips cannot bury everybody else's ask.
 * They simply work through them and come back.
 */
const MAX_OPEN_PAYSLIP_REQUESTS = 6;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A year+month as ONE comparable integer.
 *
 * Deliberately `y * 12 + (m - 1)` — the same formula resolveCtcForMonth uses,
 * and NOT the `y * 12 + m` used by the payroll run's loan filter. The two differ
 * by one, so mixing them silently shifts every comparison by a month. Everything
 * in this module and every caller must use this one.
 * @param {number} year
 * @param {number} month - 1-12
 * @returns {number}
 */
const monthOrdinal = (year, month) => year * 12 + (month - 1);

/** The inverse of monthOrdinal. @param {number} ord @returns {{year:number, month:number}} */
const fromOrdinal = (ord) => ({ year: Math.floor(ord / 12), month: (ord % 12) + 1 });

/** "March 2025", for messages and pickers. @param {number} year @param {number} month */
const monthLabel = (year, month) => `${MONTH_NAMES[month - 1] || month} ${year}`;

/**
 * The IST calendar month we are in right now, as {year, month, ord}.
 * @returns {{year:number, month:number, ord:number}}
 */
function currentMonthIST() {
  const [y, m] = ymdIST().split('-').map(Number);
  return { year: y, month: m, ord: monthOrdinal(y, m) };
}

/**
 * The most recent month that has fully ENDED, in IST.
 * @returns {{year:number, month:number, ord:number}}
 */
function lastCompletedMonthIST() {
  const ord = currentMonthIST().ord - 1;
  return { ...fromOrdinal(ord), ord };
}

/**
 * Turn a date into its IST month ordinal, or null when there is no date.
 * Parsed from the IST day string rather than from getMonth(), for the UTC-host
 * reason in the header.
 * @param {Date|string|null|undefined} date
 * @returns {number|null}
 */
function ordinalOf(date) {
  if (!date) return null;
  const [y, m] = ymdIST(date).split('-').map(Number);
  if (!y || !m) return null;
  return monthOrdinal(y, m);
}

/**
 * The window of months this employee may request, as ordinals.
 * @param {object} profile - EmployeeProfile (needs dateOfJoining, optionally dateOfExit)
 * @returns {{from:number, to:number, joinOrd:number|null, exitOrd:number|null}}
 *   `from > to` means there is nothing to offer yet (a joiner in the running month).
 */
function requestableWindow(profile) {
  const joinOrd = ordinalOf(profile?.dateOfJoining);
  const exitOrd = ordinalOf(profile?.dateOfExit);
  const lastDone = lastCompletedMonthIST().ord;
  // No joining date on record should not lock somebody out of their own
  // payslips — fall back to the open end and let the payslips they actually
  // have define the useful range.
  const from = joinOrd === null ? lastDone - 11 : joinOrd;
  const to = exitOrd === null ? lastDone : Math.min(lastDone, exitOrd);
  return { from, to, joinOrd, exitOrd };
}

/**
 * May this employee ask for this month, and if not, why not — in words they can
 * act on. One function so the API refusal and the client's disabled picker row
 * always give the same answer.
 * @param {object} profile - EmployeeProfile (needs dateOfJoining/dateOfExit)
 * @param {number} year
 * @param {number} month - 1-12
 * @returns {{ok:boolean, reason:string|null}}
 */
function checkRequestableMonth(profile, year, month) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { ok: false, reason: 'That is not a valid month.' };
  }
  const ord = monthOrdinal(year, month);
  const { from, to, joinOrd, exitOrd } = requestableWindow(profile);

  if (joinOrd !== null && ord < joinOrd) {
    const j = fromOrdinal(joinOrd);
    return { ok: false, reason: `You joined in ${monthLabel(j.year, j.month)} — there is no payslip before that.` };
  }
  if (exitOrd !== null && ord > exitOrd) {
    const e = fromOrdinal(exitOrd);
    return { ok: false, reason: `Your last month with the company was ${monthLabel(e.year, e.month)} — there is no payslip after that.` };
  }
  const lastDone = lastCompletedMonthIST();
  if (ord > lastDone.ord) {
    const nextOrd = ord + 1;
    const n = fromOrdinal(nextOrd);
    return {
      ok: false,
      reason: ord === lastDone.ord + 1
        ? `The ${monthLabel(year, month)} payslip is only ready once the month ends. You can ask for it from 1 ${MONTH_NAMES[n.month - 1]}.`
        : `${monthLabel(year, month)} has not happened yet.`,
    };
  }
  if (ord < from) return { ok: false, reason: `There is no ${monthLabel(year, month)} payslip on record for you.` };
  if (ord > to) return { ok: false, reason: `There is no ${monthLabel(year, month)} payslip on record for you.` };
  return { ok: true, reason: null };
}

/**
 * Every month in the window, newest first, each already told whether it can be
 * requested and why not.
 *
 * The client renders this list verbatim — it never computes a bound of its own,
 * which is what keeps the web picker and the mobile picker from drifting apart
 * (and what lets an old app build keep working: it simply shows fewer keys).
 * @param {object} profile - EmployeeProfile
 * @param {Map<number, object>} [stateByOrd] - existing payslip/request state per
 *   month ordinal, as `{state, payslipId, requestedAt}`; months absent from the
 *   map have never been run.
 * @returns {Array<object>}
 */
function requestableMonths(profile, stateByOrd = new Map()) {
  const { from, to } = requestableWindow(profile);
  const out = [];
  for (let ord = to; ord >= from; ord -= 1) {
    const { year, month } = fromOrdinal(ord);
    const known = stateByOrd.get(ord) || null;
    const check = checkRequestableMonth(profile, year, month);
    // A month already asked for, already released, or cancelled is listed but
    // not offered — seeing it with the reason beats it silently missing.
    const state = known?.state || 'NotRun';
    const alreadyBusy = ['Requested', 'Approved', 'Finalised', 'ChangeRequested'].includes(state);
    out.push({
      year,
      month,
      label: monthLabel(year, month),
      state,
      payslipId: known?.payslipId || null,
      requestedAt: known?.requestedAt || null,
      canRequest: check.ok && !alreadyBusy && state !== 'Void',
      reason: !check.ok ? check.reason
        : state === 'Finalised' ? 'Already released — you can download it.'
          : alreadyBusy ? 'Already asked for. HR is looking at it.'
            : state === 'Void' ? 'That month’s payslip was cancelled — ask HR about it.'
              : null,
    });
  }
  return out;
}

module.exports = {
  MAX_OPEN_PAYSLIP_REQUESTS,
  MONTH_NAMES,
  monthOrdinal,
  fromOrdinal,
  monthLabel,
  currentMonthIST,
  lastCompletedMonthIST,
  ordinalOf,
  requestableWindow,
  checkRequestableMonth,
  requestableMonths,
};
