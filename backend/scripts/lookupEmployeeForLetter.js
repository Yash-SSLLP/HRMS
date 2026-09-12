/**
 * READ-ONLY: show what an appointment letter could be built from for one
 * employee code. Writes nothing. Run:
 *
 *   node scripts/lookupEmployeeForLetter.js "SSL 160"
 */
require('dotenv').config();
const connectDB = require('../config/db');
const mongoose = require('mongoose');

const EmployeeProfile = require('../models/EmployeeProfile');
const SalaryStructure = require('../models/SalaryStructure');
require('../models/User');
require('../models/Company');

// "SSL 160", "ssl160", "SSL-160" all mean the same code to a person typing it.
const loose = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();

(async () => {
  await connectDB();
  const wanted = loose(process.argv[2] || '');
  if (!wanted) throw new Error('Pass an employee code.');

  const all = await EmployeeProfile.find({}, 'employeeCode').lean();
  const hit = all.find((p) => loose(p.employeeCode) === wanted);
  if (!hit) {
    console.log(`No employee with code "${process.argv[2]}". ${all.length} codes on file.`);
    await mongoose.connection.close();
    return;
  }

  const p = await EmployeeProfile.findById(hit._id)
    .populate('user', 'fullName email role isActive')
    .populate('reportingManager', 'fullName')
    .populate('company', 'name')
    .lean();

  const s = p.salaryStructure ? await SalaryStructure.findById(p.salaryStructure).lean() : null;

  // What payroll has actually PAID them, if anything — the only other place a
  // real figure for this person could come from.
  let payslips = [];
  try {
    const Payroll = require('../models/Payroll');
    payslips = await Payroll.find({ employee: p._id })
      .sort({ year: -1, month: -1 })
      .limit(3)
      .lean();
  } catch (e) { /* model shape may differ; the letter does not depend on it */ }

  const addr = p.address || {};

  console.log(JSON.stringify({
    employeeCode: p.employeeCode,
    name: p.user?.fullName || null,
    email: p.user?.email || null,
    active: p.user?.isActive,
    company: p.company?.name || null,
    designation: p.designation || null,
    department: p.department || null,
    workLocation: p.workLocation || null,
    dateOfJoining: p.dateOfJoining,
    reportingManager: p.reportingManager?.fullName || null,
    employmentType: p.employmentType || null,
    probationMonths: p.probationMonths ?? null,
    confirmedOn: p.confirmedOn || null,
    // ---- the compensation the Annexure would be built from ----
    annualCtc: p.annualCtc ?? null,
    salaryStructure: s ? { name: s.name, components: s.components } : null,
    ctcHistoryEntries: Array.isArray(p.ctcHistory) ? p.ctcHistory.length : 0,
    ctcHistory: (p.ctcHistory || []).map((h) => ({
      newCtc: h.newCtc, effective: `${h.effectiveYear}-${h.effectiveMonth}`, reason: h.reason,
    })),
    payslipsOnFile: payslips.length,
    lastPayslip: payslips[0]
      ? { month: `${payslips[0].year}-${payslips[0].month}`, gross: payslips[0].grossEarnings, net: payslips[0].netPay }
      : null,
    address: [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ') || null,
  }, null, 2));

  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
