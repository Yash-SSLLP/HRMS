const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Payroll = require('../models/Payroll');
const EmployeeProfile = require('../models/EmployeeProfile');
const { renderPayslip } = require('../services/payslipPdf');
// (exportPayroll below builds the month CSV by hand — no spreadsheet lib needed)

async function getMyProfileOrFail(userId, res) {
  const profile = await EmployeeProfile.findOne({ user: userId });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  return profile;
}

// GET /api/payroll/me  (employee)
const listMyPayslips = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const payslips = await Payroll.find({
    employee: profile._id,
    status: { $in: ['Approved', 'Paid'] },
  }).sort({ payPeriodYear: -1, payPeriodMonth: -1 });
  res.json({ count: payslips.length, payslips });
});

// GET /api/payroll/me/:year/:month  (employee)
const getMyPayslip = asyncHandler(async (req, res) => {
  const profile = await getMyProfileOrFail(req.user._id, res);
  const payslip = await Payroll.findOne({
    employee: profile._id,
    payPeriodYear: Number(req.params.year),
    payPeriodMonth: Number(req.params.month),
    status: { $in: ['Approved', 'Paid'] },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  res.json({ payslip });
});

// --- HR/Admin endpoints ---

// GET /api/payroll  (HR/Admin) — filters: employee, year, month, status
const listPayslips = asyncHandler(async (req, res) => {
  const { employee, year, month, status } = req.query;
  const filter = {};
  if (employee) filter.employee = employee;
  if (year) filter.payPeriodYear = Number(year);
  if (month) filter.payPeriodMonth = Number(month);
  if (status) filter.status = status;

  const payslips = await Payroll.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode user designation',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ payPeriodYear: -1, payPeriodMonth: -1, createdAt: -1 });
  res.json({ count: payslips.length, payslips });
});

// GET /api/payroll/export?year=&month=&status=  (HR/Admin)
// Excel-compatible CSV of the whole month's payroll — one row per employee
// with every earning/deduction component. Opens directly in Excel.
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const exportPayroll = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const filter = { payPeriodYear: year, payPeriodMonth: month };
  if (req.query.status) filter.status = req.query.status;

  const payslips = await Payroll.find(filter)
    .populate({
      path: 'employee',
      select: 'employeeCode designation department user',
      populate: { path: 'user', select: 'firstName lastName email' },
    })
    .sort({ 'employee.employeeCode': 1, createdAt: 1 });

  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    'Employee Code', 'Name', 'Email', 'Designation', 'Department',
    'Month', 'Year', 'Working Days', 'Paid Days', 'LOP Days',
    'Basic', 'HRA', 'Special Allowance', 'Conveyance', 'Medical', 'LTA', 'Bonus', 'Overtime', 'Other Earnings',
    'Gross Salary',
    'EPF', 'ESIC', 'Professional Tax', 'TDS', 'Loan Recovery', 'Other Deductions',
    'Total Deductions', 'Net Pay',
    'Employer EPF', 'Employer EPS', 'Employer ESIC', 'Gratuity',
    'Status', 'Payment Date', 'Payment Reference',
  ];
  const rows = payslips.map((p) => {
    const u = p.employee?.user || {};
    const e = p.earnings || {};
    const d = p.deductions || {};
    const c = p.employerContributions || {};
    return [
      p.employee?.employeeCode, `${u.firstName || ''} ${u.lastName || ''}`.trim(), u.email,
      p.employee?.designation, p.employee?.department,
      MONTH_NAMES[p.payPeriodMonth], p.payPeriodYear, p.workingDays, p.paidDays, p.lopDays,
      e.basic, e.hra, e.specialAllowance, e.conveyanceAllowance, e.medicalAllowance, e.lta, e.bonus, e.overtime, e.otherEarnings,
      p.grossSalary,
      d.epf, d.esic, d.professionalTax, d.tds, d.loanRecovery, d.otherDeductions,
      p.totalDeductions, p.netPay,
      c.epf, c.eps, c.esic, c.gratuity,
      p.status,
      p.paymentDate ? new Date(p.paymentDate).toLocaleDateString('en-IN') : '',
      p.paymentReference,
    ].map(esc).join(',');
  });
  const csv = [header.map(esc).join(','), ...rows].join('\r\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="payroll-${year}-${String(month).padStart(2, '0')}.csv"`
  );
  // BOM so Excel detects UTF-8 (₹, names with accents, etc.).
  res.send('﻿' + csv);
});

// ===== Monthly payroll run =====
// "Initiate salaries" for a whole month: every active employee gets a Draft
// payslip for the period, seeded from their most recent payslip (new joiners
// get a blank draft for HR to fill in). Preview with GET, execute with POST.

async function buildRunRows(year, month) {
  const profiles = await EmployeeProfile.find()
    .select('employeeCode designation department user')
    .populate('user', 'firstName lastName email isActive')
    .sort('employeeCode');
  const active = profiles.filter((p) => p.user && p.user.isActive !== false);

  const existing = await Payroll.find({ payPeriodYear: year, payPeriodMonth: month });
  const existingByEmp = new Map(existing.map((p) => [String(p.employee), p]));

  // Most recent payslip per employee from any earlier period (small-org scale).
  const priorSlips = await Payroll.find({
    $or: [
      { payPeriodYear: { $lt: year } },
      { payPeriodYear: year, payPeriodMonth: { $lt: month } },
    ],
  }).sort({ payPeriodYear: -1, payPeriodMonth: -1 });
  const lastByEmp = new Map();
  priorSlips.forEach((p) => {
    const k = String(p.employee);
    if (!lastByEmp.has(k)) lastByEmp.set(k, p);
  });

  return active.map((p) => {
    const k = String(p._id);
    const cur = existingByEmp.get(k);
    const last = lastByEmp.get(k);
    return {
      profile: p,
      existing: cur || null,
      last: last || null,
      row: {
        employeeId: p._id,
        employeeCode: p.employeeCode,
        name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim(),
        designation: p.designation || '',
        department: p.department || '',
        existingStatus: cur ? cur.status : null,
        source: last ? `${MONTH_NAMES[last.payPeriodMonth]} ${last.payPeriodYear}` : null,
        lastNetPay: last ? last.netPay : null,
      },
    };
  });
}

// GET /api/payroll/run?year=&month=  — preview who gets what
const previewPayrollRun = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const month = Number(req.query.month) || now.getMonth() + 1;
  const rows = await buildRunRows(year, month);
  res.json({
    year,
    month,
    count: rows.length,
    alreadyGenerated: rows.filter((r) => r.existing).length,
    toGenerate: rows.filter((r) => !r.existing).length,
    rows: rows.map((r) => r.row),
  });
});

// POST /api/payroll/run  { year, month }  — create the Draft payslips
const runPayroll = asyncHandler(async (req, res) => {
  const year = Number(req.body.year);
  const month = Number(req.body.month);
  if (!year || !month || month < 1 || month > 12) {
    res.status(400);
    throw new Error('A valid year and month are required');
  }

  const rows = await buildRunRows(year, month);
  const daysInMonth = new Date(year, month, 0).getDate();
  const created = [];
  const blank = [];
  for (const r of rows) {
    if (r.existing) continue; // never overwrite an existing payslip
    const seed = r.last;
    const payslip = await Payroll.create({
      employee: r.profile._id,
      payPeriodYear: year,
      payPeriodMonth: month,
      workingDays: daysInMonth,
      paidDays: daysInMonth,
      lopDays: 0,
      earnings: seed ? seed.earnings?.toObject?.() || seed.earnings : {},
      deductions: seed ? seed.deductions?.toObject?.() || seed.deductions : {},
      employerContributions: seed ? seed.employerContributions?.toObject?.() || seed.employerContributions : {},
      status: 'Draft',
      remarks: seed
        ? `Payroll run: copied from ${MONTH_NAMES[seed.payPeriodMonth]} ${seed.payPeriodYear}`
        : 'Payroll run: no earlier payslip — set the salary components',
    });
    created.push({ name: r.row.name, netPay: payslip.netPay, id: payslip._id });
    if (!seed) blank.push(r.row.name);
  }

  res.status(201).json({
    year,
    month,
    created: created.length,
    skippedExisting: rows.filter((r) => r.existing).length,
    needsSetup: blank,
    payslips: created,
  });
});

// GET /api/payroll/:id  (HR/Admin)
const getPayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  res.json({ payslip });
});

// POST /api/payroll  (HR/Admin)
const createPayslip = asyncHandler(async (req, res) => {
  const { employee, payPeriodYear, payPeriodMonth } = req.body;
  if (!employee || !payPeriodYear || !payPeriodMonth) {
    res.status(400);
    throw new Error('employee, payPeriodYear, payPeriodMonth are required');
  }
  const profile = await EmployeeProfile.findById(employee);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  const payslip = await Payroll.create(req.body);
  res.status(201).json({ payslip });
});

// PUT /api/payroll/:id  (HR/Admin)
const updatePayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  if (payslip.status === 'Paid') {
    res.status(400);
    throw new Error('Paid payslips cannot be edited');
  }
  // Don't allow changing identity fields
  delete req.body.employee;
  delete req.body.payPeriodYear;
  delete req.body.payPeriodMonth;

  Object.assign(payslip, req.body);
  await payslip.save();
  res.json({ payslip });
});

// PATCH /api/payroll/:id/approve  (HR/Admin)
const approvePayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  if (payslip.status !== 'Draft' && payslip.status !== 'OnHold') {
    res.status(400);
    throw new Error(`Cannot approve from status ${payslip.status}`);
  }
  payslip.status = 'Approved';
  await payslip.save();
  res.json({ payslip });
});

// PATCH /api/payroll/:id/pay  (HR/Admin)
const markPayslipPaid = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  if (payslip.status !== 'Approved') {
    res.status(400);
    throw new Error('Payslip must be Approved before it can be marked Paid');
  }
  payslip.status = 'Paid';
  payslip.paymentDate = req.body.paymentDate || new Date();
  if (req.body.paymentReference) payslip.paymentReference = req.body.paymentReference;
  await payslip.save();
  res.json({ payslip });
});

// GET /api/payroll/:id/pdf  (HR/Admin)
const downloadPayslipPdf = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await streamPayslipPdf(payslip, res);
});

// GET /api/payroll/me/:id/pdf  (employee — own payslips only, Approved or Paid)
const downloadMyPayslipPdf = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.user._id });
  if (!profile) {
    res.status(404);
    throw new Error('No employee profile linked to this account');
  }
  const payslip = await Payroll.findOne({
    _id: req.params.id,
    employee: profile._id,
    status: { $in: ['Approved', 'Paid'] },
  }).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  await streamPayslipPdf(payslip, res);
});

// Indian financial year start: April-to-March
function fyStartKey(year, month) {
  return month >= 4 ? year * 100 + 4 : (year - 1) * 100 + 4;
}

// Sum each earnings/deductions component across this employee's payslips
// within the same financial year, up to and including the current period.
async function computeYtd(payslip) {
  const periodKey = (p) => p.payPeriodYear * 100 + p.payPeriodMonth;
  const startKey = fyStartKey(payslip.payPeriodYear, payslip.payPeriodMonth);
  const currentKey = periodKey(payslip);

  const others = await Payroll.find({
    employee: payslip.employee,
    status: { $in: ['Approved', 'Paid'] },
  });

  // Always include the current payslip even if it's Draft so its YTD reflects itself
  const seen = new Set([String(payslip._id)]);
  const list = [payslip];
  for (const p of others) {
    if (seen.has(String(p._id))) continue;
    if (periodKey(p) < startKey || periodKey(p) > currentKey) continue;
    seen.add(String(p._id));
    list.push(p);
  }

  const earnings = {};
  const deductions = {};
  for (const p of list) {
    const e = p.earnings?.toObject?.() || p.earnings || {};
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'number') earnings[k] = (earnings[k] || 0) + v;
    }
    const d = p.deductions?.toObject?.() || p.deductions || {};
    for (const [k, v] of Object.entries(d)) {
      if (typeof v === 'number') deductions[k] = (deductions[k] || 0) + v;
    }
  }
  return { earnings, deductions };
}

async function streamPayslipPdf(payslip, res) {
  const ytd = await computeYtd(payslip);
  const buffer = await renderPayslip(payslip, ytd);
  const monthLabel = `${payslip.payPeriodYear}-${String(payslip.payPeriodMonth).padStart(2, '0')}`;
  const empCode = payslip.employee?.employeeCode || 'employee';
  const fileName = `payslip-${empCode}-${monthLabel}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
}

// POST /api/payroll/:id/share  (HR/Admin)
// Ensure the payslip has a public token and return it, so HR can paste a
// no-login download link into an email. Only Approved/Paid payslips can be
// shared (Drafts/OnHold must not leak).
const sharePayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  if (!['Approved', 'Paid'].includes(payslip.status)) {
    res.status(400);
    throw new Error('Only Approved or Paid payslips can be shared');
  }
  if (!payslip.publicToken) {
    payslip.publicToken = crypto.randomBytes(24).toString('hex');
    await payslip.save();
  }
  res.json({ token: payslip.publicToken });
});

// POST /api/payroll/:id/mark-sent  (HR/Admin) — stamp emailedAt for the
// "already sent" remark (delivery happens from HR's own mailbox via compose).
const markPayslipSent = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  payslip.emailedAt = new Date();
  await payslip.save();
  res.json({ payslip });
});

// GET /api/payroll/public/:token  — public; opens a payslip PDF from the
// shareable link with no login required.
const downloadPublicPayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findOne({
    publicToken: req.params.token,
    status: { $in: ['Approved', 'Paid'] },
  }).populate({
    path: 'employee',
    populate: { path: 'user', select: 'firstName lastName email' },
  });
  if (!payslip) {
    res.status(404);
    throw new Error('This payslip link is invalid or has expired.');
  }
  const ytd = await computeYtd(payslip);
  const buffer = await renderPayslip(payslip, ytd);
  const monthLabel = `${payslip.payPeriodYear}-${String(payslip.payPeriodMonth).padStart(2, '0')}`;
  const empCode = payslip.employee?.employeeCode || 'employee';
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="payslip-${empCode}-${monthLabel}.pdf"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
});

// DELETE /api/payroll/:id  (HR/Admin) — Draft only
const deletePayslip = asyncHandler(async (req, res) => {
  const payslip = await Payroll.findById(req.params.id);
  if (!payslip) {
    res.status(404);
    throw new Error('Payslip not found');
  }
  if (payslip.status !== 'Draft') {
    res.status(400);
    throw new Error('Only Draft payslips can be deleted');
  }
  await payslip.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = {
  listMyPayslips,
  getMyPayslip,
  listPayslips,
  exportPayroll,
  previewPayrollRun,
  runPayroll,
  getPayslip,
  createPayslip,
  updatePayslip,
  approvePayslip,
  markPayslipPaid,
  deletePayslip,
  downloadPayslipPdf,
  downloadMyPayslipPdf,
  sharePayslip,
  markPayslipSent,
  downloadPublicPayslip,
};
