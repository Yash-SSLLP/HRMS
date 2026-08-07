/**
 * Year-to-date totals for a payslip.
 *
 * "Year" here is the Indian financial year — 1 April to 31 March — because that
 * is the window every figure an employee needs YTD for (tax, salary certificates,
 * loan applications) is measured over. A July 2026 slip therefore accumulates
 * April 2026 through July 2026.
 *
 * Only finalised slips (Approved/Paid) count toward the running total, plus the
 * slip being rendered itself — an admin previewing a Draft should still see the
 * month they are looking at included, rather than a total that silently excludes it.
 */
const Payroll = require('../models/Payroll');
const { EARNING_COMPONENTS, DEDUCTION_COMPONENTS, EMPLOYER_COMPONENTS } = require('./payslipLines');

const FY_START_MONTH = 4; // April

const EARNING_KEYS = EARNING_COMPONENTS.map((c) => c.key);
const DEDUCTION_KEYS = DEDUCTION_COMPONENTS.map((c) => c.key);
const EMPLOYER_KEYS = EMPLOYER_COMPONENTS.map((c) => c.key);

// A comparable number for a pay period, so ranges don't need date arithmetic.
const periodKey = (year, month) => (Number(year) || 0) * 12 + (Number(month) || 0);

// The April in which this pay month's financial year began.
const fyStartYear = (year, month) => (month >= FY_START_MONTH ? year : year - 1);

/** e.g. 2026 -> "FY 2026–27" */
const fyLabel = (startYear) => `FY ${startYear}–${String(startYear + 1).slice(-2)}`;

const idOf = (v) => String(v?._id || v || '');
const plainObject = (v) => v?.toObject?.() || v || {};

function sumInto(target, source, keys) {
  for (const k of keys) target[k] = (target[k] || 0) + (Number(source[k]) || 0);
}

/**
 * Accumulate year-to-date totals for `payslip` from a set of the same employee's
 * slips. Pure — the caller supplies the candidates, so a list endpoint that has
 * already loaded them does not query again.
 * @param {Object[]} slips - Candidate payslips (any periods; filtered here).
 * @param {Object} payslip - The slip being rendered.
 * @returns {{label: string, months: number, earnings: Object, deductions: Object,
 *   grossSalary: number, totalDeductions: number, netPay: number}}
 */
function computeYtdFrom(slips, payslip) {
  const year = payslip.payPeriodYear;
  const month = payslip.payPeriodMonth;
  const startYear = fyStartYear(year, month);
  const from = periodKey(startYear, FY_START_MONTH);
  const to = periodKey(year, month);

  // One entry per pay period, so the same month can never be counted twice.
  const byPeriod = new Map();
  for (const s of slips || []) {
    const k = periodKey(s.payPeriodYear, s.payPeriodMonth);
    if (k < from || k > to) continue;
    if (!['Approved', 'Paid'].includes(s.status)) continue;
    byPeriod.set(k, s);
  }
  // The slip in hand always counts, whatever its status.
  byPeriod.set(to, payslip);

  const earnings = {};
  const deductions = {};
  const employerContributions = {};
  let grossSalary = 0;
  let totalDeductions = 0;
  for (const s of byPeriod.values()) {
    sumInto(earnings, plainObject(s.earnings), EARNING_KEYS);
    sumInto(deductions, plainObject(s.deductions), DEDUCTION_KEYS);
    sumInto(employerContributions, plainObject(s.employerContributions), EMPLOYER_KEYS);
    grossSalary += Number(s.grossSalary) || 0;
    totalDeductions += Number(s.totalDeductions) || 0;
  }

  return {
    label: fyLabel(startYear),
    months: byPeriod.size,
    earnings,
    deductions,
    employerContributions,
    grossSalary: Math.round(grossSalary),
    totalDeductions: Math.round(totalDeductions),
    netPay: Math.round(grossSalary - totalDeductions),
    // Not added into gross or net — the company's own cost, kept separate.
    employerTotal: Math.round(EMPLOYER_KEYS.reduce((a, k) => a + (employerContributions[k] || 0), 0)),
  };
}

/**
 * Year-to-date totals for one payslip, fetching the employee's other slips.
 * A financial year spans two calendar years, so both are queried.
 * @param {Object} payslip
 * @returns {Promise<Object>} same shape as computeYtdFrom
 */
async function buildYtd(payslip) {
  const startYear = fyStartYear(payslip.payPeriodYear, payslip.payPeriodMonth);
  const slips = await Payroll.find({
    employee: idOf(payslip.employee),
    payPeriodYear: { $in: [startYear, startYear + 1] },
    status: { $in: ['Approved', 'Paid'] },
  }).lean();
  return computeYtdFrom(slips, payslip);
}

module.exports = { buildYtd, computeYtdFrom, fyStartYear, fyLabel, periodKey, FY_START_MONTH };
