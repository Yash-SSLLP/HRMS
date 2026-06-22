const asyncHandler = require('express-async-handler');
const crypto = require('crypto');
const Payroll = require('../models/Payroll');
const EmployeeProfile = require('../models/EmployeeProfile');
const { renderPayslip } = require('../services/payslipPdf');

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
