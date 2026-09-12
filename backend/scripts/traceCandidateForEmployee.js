/**
 * READ-ONLY: the candidate record behind an employee — what the company already
 * committed to in writing, and whether a letter was generated back then.
 *
 *   node scripts/traceCandidateForEmployee.js "SSL 160"
 */
require('dotenv').config();
const connectDB = require('../config/db');
const mongoose = require('mongoose');

const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const Candidate = require('../models/Candidate');
const Document = require('../models/Document');
const storage = require('../services/storage');

const loose = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();

(async () => {
  await connectDB();
  const code = process.argv[2] || 'SSL 160';
  const all = await EmployeeProfile.find({}, 'employeeCode').lean();
  const hit = all.find((p) => loose(p.employeeCode) === loose(code));
  const p = await EmployeeProfile.findById(hit._id).lean();
  const u = await User.findById(p.user).lean();

  const c = await Candidate.findOne({ email: u.email }).lean();
  if (!c) { console.log('No candidate record.'); await mongoose.connection.close(); return; }

  console.log(`\nCandidate: ${c.name}  (stage ${c.stage})`);
  console.log('\noffer.data:', JSON.stringify(c.offer?.data, null, 2));
  console.log('\nappointment.data:', JSON.stringify(c.appointment?.data, null, 2));
  console.log('\nappointment file:', {
    letterPath: c.appointment?.letterPath || null,
    letterName: c.appointment?.letterName || null,
    generatedAt: c.appointment?.generatedAt || null,
    emailedAt: c.appointment?.emailedAt || null,
  });
  if (c.appointment?.letterPath) {
    const exists = await storage.exists(c.appointment.letterPath).catch(() => false);
    console.log('  bytes still present:', exists);
  }
  console.log('\noffer file:', {
    letterPath: c.offer?.letterPath || null,
    generatedAt: c.offer?.generatedAt || null,
  });

  const docs = await Document.find({ employee: p._id }).select('category fileName note status').lean();
  console.log(`\nDocuments filed against the employee (${docs.length}):`);
  docs.forEach((d) => console.log(`  · ${d.category.padEnd(18)} ${d.fileName}  [${d.status}]${d.note ? ` — ${d.note}` : ''}`));

  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
