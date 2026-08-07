/**
 * Salary slip renderer — chooses the layout.
 *
 * Two designs are kept, both drawing their content from the same sources
 * (payslipLines.js for the money, payslipFields.js for everything else), so the
 * choice changes only how a slip looks, never what it says:
 *
 *   'statement' (in use) — payslipPdfStatement.js. Letterhead over a gold rule,
 *       net pay as the headline, the company's original detail block, the
 *       earnings/deductions columns with year-to-date, employer contributions,
 *       and the authorised signature.
 *   'classic'            — payslipPdfClassic.js. The same content in the
 *       original fully-ruled grid.
 *
 * To switch the whole system — PDF download, payslip email and the public link —
 * change PAYSLIP_LAYOUT below, or set PAYSLIP_LAYOUT=classic in the environment.
 */
const { renderStatementPayslip } = require('./payslipPdfStatement');
const { renderClassicPayslip } = require('./payslipPdfClassic');
const { buildPayslipLines, linesBalance } = require('./payslipLines');

const LAYOUTS = {
  statement: renderStatementPayslip,
  classic: renderClassicPayslip,
};

const PAYSLIP_LAYOUT = LAYOUTS[process.env.PAYSLIP_LAYOUT] ? process.env.PAYSLIP_LAYOUT : 'statement';

/**
 * Render the salary slip PDF in the configured layout.
 * @param {Object} payslip - Payroll doc with `employee` populated (and
 *   `employee.user`); needs `earnings`, `deductions`, the day counts, the
 *   monthlySalary/annualCtc snapshot and the computed totals.
 * @param {Object} [ytd] - Year-to-date totals from services/payslipYtd.js.
 * @param {string} [layout] - Override the configured layout ('statement'|'classic').
 * @returns {Promise<Buffer>} the rendered PDF bytes.
 */
function renderPayslip(payslip, ytd, layout) {
  const render = LAYOUTS[layout] || LAYOUTS[PAYSLIP_LAYOUT];
  return render(payslip, ytd);
}

module.exports = { renderPayslip, PAYSLIP_LAYOUT, LAYOUTS, buildPayslipLines, linesBalance };
