/**
 * READ-ONLY: hunt for an employee's missing name / salary anywhere else in the
 * system before anybody types one in by hand. Writes nothing.
 *
 *   node scripts/traceEmployeeData.js "SSL 160"
 */
require('dotenv').config();
const connectDB = require('../config/db');
const mongoose = require('mongoose');

const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const SalaryStructure = require('../models/SalaryStructure');
require('../models/Company');

const loose = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();
const tryModel = (name) => { try { return require(`../models/${name}`); } catch { return null; } };

(async () => {
  await connectDB();
  const code = process.argv[2] || 'SSL 160';

  const all = await EmployeeProfile.find({}, 'employeeCode').lean();
  const hit = all.find((p) => loose(p.employeeCode) === loose(code));
  if (!hit) throw new Error(`No employee with code "${code}".`);
  const p = await EmployeeProfile.findById(hit._id).lean();

  console.log(`\n=== ${p.employeeCode} ===`);

  // ---- the login, in full ----
  const u = await User.findById(p.user).lean();
  console.log('\nUser record:');
  console.log('  fullName :', JSON.stringify(u?.fullName));
  console.log('  firstName:', JSON.stringify(u?.firstName));
  console.log('  lastName :', JSON.stringify(u?.lastName));
  console.log('  name     :', JSON.stringify(u?.name));
  console.log('  email    :', u?.email);
  console.log('  role     :', u?.role, '| active:', u?.isActive);

  // ---- profile identity fields ----
  console.log('\nProfile identity fields that are set:');
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined || v === '') continue;
    if (['_id', '__v', 'user', 'createdAt', 'updatedAt'].includes(k)) continue;
    if (typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      const inner = Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== '');
      if (inner.length) console.log(`  ${k}:`, JSON.stringify(Object.fromEntries(inner)));
      continue;
    }
    if (Array.isArray(v) && !v.length) continue;
    console.log(`  ${k}:`, JSON.stringify(v));
  }

  // ---- anywhere else the person or their pay might be recorded ----
  const probes = [
    ['Candidate', (M) => M.find({ email: u?.email }).select('name email stage offer.data.salaryAnnual appointment.data.ctcAnnual').lean()],
    ['Payroll', (M) => M.find({ employee: p._id }).select('month year grossEarnings netPay').lean()],
    ['ImportFlag', (M) => M.find({ employee: p._id }).lean()],
    ['Attendance', (M) => M.countDocuments({ employee: p._id })],
    ['Document', (M) => M.find({ employee: p._id }).select('category fileName').lean()],
  ];
  console.log('\nElsewhere in the system:');
  for (const [name, run] of probes) {
    const M = tryModel(name);
    if (!M) { console.log(`  ${name}: (no such model)`); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await run(M);
      const n = typeof out === 'number' ? out : out.length;
      console.log(`  ${name}: ${n}`, n && typeof out !== 'number' ? JSON.stringify(out).slice(0, 300) : '');
    } catch (e) {
      console.log(`  ${name}: query failed — ${e.message}`);
    }
  }

  // ---- what structures HR could choose from ----
  const structures = await SalaryStructure.find({ isActive: true }).select('name components').lean();
  console.log(`\nActive salary structures (${structures.length}):`);
  structures.slice(0, 25).forEach((s) => {
    const c = s.components || {};
    const total = ['basicPct', 'hraPct', 'specialAllowancePct', 'conveyancePct', 'medicalPct', 'ltaPct']
      .reduce((a, k) => a + (Number(c[k]) || 0), 0);
    console.log(`  · ${s.name}  — basic ${c.basicPct || 0}% / hra ${c.hraPct || 0}% / special ${c.specialAllowancePct || 0}%`
      + ` / conv ${c.conveyancePct || 0}% / med ${c.medicalPct || 0}% / lta ${c.ltaPct || 0}%  (sums to ${total}%)`);
  });

  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
