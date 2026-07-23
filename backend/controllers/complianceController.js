/**
 * Statutory-compliance controller — builds monthly/annual statutory reports from
 * processed Payroll payslips: PF/EPF, ESI, professional tax (PT), TDS, and an
 * annual Form-16 summary. Read-only; every report returns rows plus column totals.
 */
const asyncHandler = require('express-async-handler');
const Payroll = require('../models/Payroll');

// --- helpers -------------------------------------------------------------

// Standard populate so every report row can resolve the employee's statutory
// identifiers and display name in a single query.
const EMPLOYEE_POPULATE = {
  path: 'employee',
  select: 'employeeCode pan uan pfNumber esicNumber user',
  populate: { path: 'user', select: 'firstName lastName' },
};

// Parse req.query.month (1-12) and req.query.year (defaults to current year).
// Returns { month, year } where month may be null if not provided/invalid.
function parsePeriod(req) {
  const now = new Date();
  let month = parseInt(req.query.month, 10);
  let year = parseInt(req.query.year, 10);

  if (Number.isNaN(month) || month < 1 || month > 12) month = null;
  if (Number.isNaN(year)) year = now.getFullYear();

  return { month, year };
}

function fullName(emp) {
  const u = emp && emp.user;
  if (!u) return '';
  return `${u.firstName || ''} ${u.lastName || ''}`.trim();
}

const num = (v) => (typeof v === 'number' && !Number.isNaN(v) ? v : 0);

// Add the numeric fields of `row` (only the given keys) into the `totals` acc.
function accumulate(totals, row, keys) {
  for (const k of keys) totals[k] = num(totals[k]) + num(row[k]);
}

function initTotals(keys) {
  const t = {};
  for (const k of keys) t[k] = 0;
  return t;
}

// Fetch processed payslips for a given month/year, populated, valid rows only.
async function fetchPayslips({ month, year }) {
  const filter = { payPeriodYear: year };
  if (month) filter.payPeriodMonth = month;

  const payslips = await Payroll.find(filter)
    .populate(EMPLOYEE_POPULATE)
    .lean();

  // Skip rows where employee/profile is missing.
  return payslips.filter((p) => p.employee && p.employee.user);
}

// --- PF report -----------------------------------------------------------
/**
 * Provident-fund report: EPF wages and employee/employer EPF + EPS per employee.
 * @route GET /api/compliance/pf?month&year
 * @param {number} [req.query.month] 1-12
 * @param {number} [req.query.year] defaults to current year
 * @returns {{month, year, count, rows: Object[], totals: Object}}
 */
const pfReport = asyncHandler(async (req, res) => {
  const { month, year } = parsePeriod(req);
  const payslips = await fetchPayslips({ month, year });

  const cols = ['epfWages', 'employeeEpf', 'employerEpf', 'eps'];
  const totals = initTotals(cols);
  const rows = payslips.map((p) => {
    const emp = p.employee;
    const row = {
      employeeCode: emp.employeeCode,
      name: fullName(emp),
      uan: emp.uan || '',
      pfNumber: emp.pfNumber || '',
      epfWages: num(p.earnings && p.earnings.basic),
      employeeEpf: num(p.deductions && p.deductions.epf),
      employerEpf: num(p.employerContributions && p.employerContributions.epf),
      eps: num(p.employerContributions && p.employerContributions.eps),
    };
    accumulate(totals, row, cols);
    return row;
  });

  res.json({ month, year, count: rows.length, rows, totals });
});

// --- ESI report ----------------------------------------------------------
/**
 * ESI report: gross and employee/employer ESI contributions per employee.
 * @route GET /api/compliance/esi?month&year
 * @param {number} [req.query.month] 1-12
 * @param {number} [req.query.year] defaults to current year
 * @returns {{month, year, count, rows: Object[], totals: Object}}
 */
// NOTE: ESI typically applies only when an employee's gross <= 21000/month.
const esiReport = asyncHandler(async (req, res) => {
  const { month, year } = parsePeriod(req);
  const payslips = await fetchPayslips({ month, year });

  const cols = ['gross', 'employeeEsi', 'employerEsi'];
  const totals = initTotals(cols);
  const rows = payslips.map((p) => {
    const emp = p.employee;
    const row = {
      employeeCode: emp.employeeCode,
      name: fullName(emp),
      esicNumber: emp.esicNumber || '',
      gross: num(p.grossSalary),
      employeeEsi: num(p.deductions && p.deductions.esic),
      employerEsi: num(p.employerContributions && p.employerContributions.esic),
    };
    accumulate(totals, row, cols);
    return row;
  });

  res.json({ month, year, count: rows.length, rows, totals });
});

// --- PT report -----------------------------------------------------------
/**
 * Professional-tax report: gross and PT deducted per employee.
 * @route GET /api/compliance/pt?month&year
 * @param {number} [req.query.month] 1-12
 * @param {number} [req.query.year] defaults to current year
 * @returns {{month, year, count, rows: Object[], totals: Object}}
 */
const ptReport = asyncHandler(async (req, res) => {
  const { month, year } = parsePeriod(req);
  const payslips = await fetchPayslips({ month, year });

  const cols = ['gross', 'professionalTax'];
  const totals = initTotals(cols);
  const rows = payslips.map((p) => {
    const emp = p.employee;
    const row = {
      employeeCode: emp.employeeCode,
      name: fullName(emp),
      gross: num(p.grossSalary),
      professionalTax: num(p.deductions && p.deductions.professionalTax),
    };
    accumulate(totals, row, cols);
    return row;
  });

  res.json({ month, year, count: rows.length, rows, totals });
});

// --- TDS report ----------------------------------------------------------
/**
 * TDS report: PAN, gross and TDS deducted per employee.
 * @route GET /api/compliance/tds?month&year
 * @param {number} [req.query.month] 1-12
 * @param {number} [req.query.year] defaults to current year
 * @returns {{month, year, count, rows: Object[], totals: Object}}
 */
const tdsReport = asyncHandler(async (req, res) => {
  const { month, year } = parsePeriod(req);
  const payslips = await fetchPayslips({ month, year });

  const cols = ['gross', 'tds'];
  const totals = initTotals(cols);
  const rows = payslips.map((p) => {
    const emp = p.employee;
    const row = {
      employeeCode: emp.employeeCode,
      name: fullName(emp),
      pan: emp.pan || '',
      gross: num(p.grossSalary),
      tds: num(p.deductions && p.deductions.tds),
    };
    accumulate(totals, row, cols);
    return row;
  });

  res.json({ month, year, count: rows.length, rows, totals });
});

// --- Form-16 annual summary ---------------------------------------------
/**
 * Annual Form-16 summary: per-employee annual gross/EPF/PT/TDS/net, aggregated
 * across every payslip in the year (any month filter is ignored).
 * @route GET /api/compliance/form16?year
 * @param {number} [req.query.year] defaults to current year
 * @returns {{year, count, rows: Object[], totals: Object}}
 */
const form16Summary = asyncHandler(async (req, res) => {
  const { year } = parsePeriod(req);
  // Ignore any month filter for the annual summary.
  const payslips = await fetchPayslips({ month: null, year });

  const cols = ['annualGross', 'annualEpf', 'annualPt', 'annualTds', 'annualNet'];
  const totals = initTotals(cols);

  // Group by employee profile id.
  const byEmployee = new Map();
  for (const p of payslips) {
    const emp = p.employee;
    const key = String(emp._id);
    let agg = byEmployee.get(key);
    if (!agg) {
      agg = {
        employeeCode: emp.employeeCode,
        name: fullName(emp),
        pan: emp.pan || '',
        annualGross: 0,
        annualEpf: 0,
        annualPt: 0,
        annualTds: 0,
        annualNet: 0,
      };
      byEmployee.set(key, agg);
    }
    agg.annualGross += num(p.grossSalary);
    agg.annualEpf += num(p.deductions && p.deductions.epf);
    agg.annualPt += num(p.deductions && p.deductions.professionalTax);
    agg.annualTds += num(p.deductions && p.deductions.tds);
    agg.annualNet += num(p.netPay);
  }

  const rows = Array.from(byEmployee.values());
  for (const row of rows) accumulate(totals, row, cols);

  res.json({ year, count: rows.length, rows, totals });
});

module.exports = {
  pfReport,
  esiReport,
  ptReport,
  tdsReport,
  form16Summary,
};
