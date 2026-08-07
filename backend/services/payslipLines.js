/**
 * The payslip's component list — the single source of truth for what appears on
 * a salary slip, in what order, and under what name.
 *
 * The PDF renders from this, and the payroll read endpoints attach the built
 * lines to their JSON so the web and mobile screens show exactly the same
 * breakdown without keeping label maps of their own. Before this existed there
 * were four separate maps that had already drifted apart.
 *
 * Every key in the Payroll earnings/deductions sub-schemas appears here exactly
 * once, so the lines always add up to the stored totals — `linesBalance()` below
 * checks that rather than trusting it. A new component must be added here too.
 */

// Day counts read better whole, but half days are genuine halves.
const days = (n) => {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? String(v) : String(+v.toFixed(1));
};

const dayLabel = (n) => `${days(n)} ${Math.abs(Number(n) || 0) === 1 ? 'day' : 'days'}`;

// `hint` is the short parenthetical that explains WHY a figure is what it is —
// the thing employees actually query. It is derived from the day counts stored
// on the payslip, and returns null when there is nothing useful to say.
const EARNING_COMPONENTS = [
  { key: 'basic', label: 'Basic' },
  { key: 'hra', label: 'House Rent Allowance' },
  { key: 'specialAllowance', label: 'Special Allowance' },
  { key: 'conveyanceAllowance', label: 'Conveyance' },
  { key: 'medicalAllowance', label: 'Medical' },
  { key: 'lta', label: 'Leave Travel' },
  { key: 'bonus', label: 'Bonus / Arrears' },
  { key: 'overtime', label: 'Overtime' },
  {
    key: 'leaveIncentive',
    label: 'Leave Incentive',
    hint: (p) => (p.additionalPaidDays ? `${dayLabel(p.additionalPaidDays)} unused` : null),
  },
  // Approved work on a holiday or weekly off. The day is already paid once inside
  // the monthly salary, so this line is the second payment that doubles it.
  { key: 'doubleDayPay', label: 'Rest-Day Pay (2×)' },
  { key: 'otherEarnings', label: 'Other Earnings' },
];

const DEDUCTION_COMPONENTS = [
  { key: 'epf', label: 'Provident Fund' },
  { key: 'esic', label: 'ESIC' },
  { key: 'professionalTax', label: 'Professional Tax' },
  { key: 'tds', label: 'Income Tax (TDS)' },
  {
    key: 'lopDeduction',
    label: 'Loss of Pay',
    hint: (p) => (p.lopDays ? dayLabel(p.lopDays) : null),
  },
  {
    key: 'latePenalty',
    label: 'Late Arrival Penalty',
    hint: (p) => (p.lateDays ? `${dayLabel(p.lateDays)} late` : null),
  },
  { key: 'emergencyPenalty', label: 'Emergency Leave (2×)' },
  { key: 'loanRecovery', label: 'Loan / EMI Recovery' },
  { key: 'salaryAdvance', label: 'Salary Advance Recovery' },
  { key: 'otherDeductions', label: 'Other Deductions' },
];

// Paid by the company on top of salary, never deducted from the employee. Shown
// so the full cost of employment is visible; the amounts do not enter gross, net
// or the deduction total, and must never be presented as if they did.
const EMPLOYER_COMPONENTS = [
  { key: 'epf', label: 'Provident Fund' },
  { key: 'eps', label: 'Pension (EPS)' },
  { key: 'esic', label: 'ESIC' },
  { key: 'gratuity', label: 'Gratuity provision' },
];

const plainObject = (v) => v?.toObject?.() || v || {};

function toLines(components, values, payslip, ytdValues) {
  return components.map((c) => ({
    key: c.key,
    label: c.label,
    amount: Math.round(Number(values[c.key]) || 0),
    hint: (c.hint && c.hint(payslip)) || null,
    // null rather than 0 when there are no year-to-date figures, so a renderer
    // can tell "no YTD available" apart from "nothing earned under this head".
    ytd: ytdValues ? Math.round(Number(ytdValues[c.key]) || 0) : null,
  }));
}

/**
 * Build the printable breakdown for one payslip.
 * @param {Object} payslip - Payroll doc or plain object.
 * @param {Object} [ytd] - Year-to-date totals from services/payslipYtd.js. When
 *   given, each line also carries its cumulative figure.
 * @returns {{earnings: Array, deductions: Array}} Every component, zeros included —
 *   the caller decides whether to hide empty lines.
 */
function buildPayslipLines(payslip, ytd) {
  const p = payslip || {};
  return {
    earnings: toLines(EARNING_COMPONENTS, plainObject(p.earnings), p, ytd?.earnings),
    deductions: toLines(DEDUCTION_COMPONENTS, plainObject(p.deductions), p, ytd?.deductions),
    employer: toLines(EMPLOYER_COMPONENTS, plainObject(p.employerContributions), p, ytd?.employerContributions),
  };
}

/**
 * Total employer contribution for a month — the figure that, added to gross,
 * gives the real cost of employing someone.
 * @param {Object} payslip
 * @returns {number}
 */
function employerTotal(payslip) {
  const v = plainObject(payslip?.employerContributions);
  return EMPLOYER_COMPONENTS.reduce((a, c) => a + (Math.round(Number(v[c.key])) || 0), 0);
}

/**
 * Do the built lines sum to the totals stored on the payslip? Exported so the
 * component list can be checked against the schema rather than assumed complete.
 * @param {Object} payslip
 * @returns {{earnings: boolean, deductions: boolean}}
 */
function linesBalance(payslip) {
  const { earnings, deductions } = buildPayslipLines(payslip);
  const sum = (lines) => lines.reduce((a, l) => a + l.amount, 0);
  return {
    earnings: sum(earnings) === Math.round(payslip.grossSalary || 0),
    deductions: sum(deductions) === Math.round(payslip.totalDeductions || 0),
  };
}

module.exports = {
  EARNING_COMPONENTS,
  DEDUCTION_COMPONENTS,
  EMPLOYER_COMPONENTS,
  buildPayslipLines,
  employerTotal,
  linesBalance,
  days,
};
