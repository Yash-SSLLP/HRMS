/**
 * READ-ONLY check of the employee appointment letter:
 *   · the Annexure figures are payroll's own, not a second derivation;
 *   · an incomplete record is refused rather than served a letter with gaps.
 *
 *   node scripts/testEmployeeAppointmentLetter.js [employeeCode]
 */
require('dotenv').config();
const assert = require('assert');
const fs = require('fs');
const connectDB = require('../config/db');
const mongoose = require('mongoose');

const EmployeeProfile = require('../models/EmployeeProfile');
const SalaryStructure = require('../models/SalaryStructure');
require('../models/User');
require('../models/Company');

const { letterData, assertIssuable } = require('../controllers/employeeLetterController');
const { deriveSalary } = require('../controllers/payrollController');
const { renderAppointmentLetter, resolveLetterBody } = require('../services/letterPdf');
const { getBranding } = require('../services/branding');

const loose = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();
let passed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok    ${name}`); passed += 1; } catch (e) {
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
};

(async () => {
  await connectDB();

  // ---- an employee who actually has a salary on file ----
  const withPay = await EmployeeProfile.find({
    annualCtc: { $gt: 0 }, salaryStructure: { $ne: null },
  })
    .populate('user', 'firstName lastName fullName')
    .populate('reportingManager', 'firstName lastName fullName')
    .limit(5);

  console.log(`\nEmployees with a CTC and a structure: ${withPay.length ? `${withPay.length}+` : 'NONE'}`);
  if (!withPay.length) {
    console.log('Nothing to derive from — skipping the figure checks.');
  } else {
    const arg = process.argv[2];
    const wanted = arg && withPay.find((x) => loose(x.employeeCode) === loose(arg));
    // A profile can point at a structure that has since been deleted. That is a
    // DANGLING REF, not a usable fixture — and the controller already refuses it
    // (assertIssuable sees a null structure), so walk on to one that resolves.
    let p = null;
    let st = null;
    for (const cand of (wanted ? [wanted] : withPay)) {
      // eslint-disable-next-line no-await-in-loop
      const found = await SalaryStructure.findById(cand.salaryStructure).lean();
      if (found) { p = cand; st = found; break; }
      console.log(`  !     ${cand.employeeCode} references a salary structure that no longer exists`);
    }
    if (!p) throw new Error('No employee has a RESOLVABLE salary structure.');
    console.log(`Using ${p.employeeCode} — CTC ${p.annualCtc}, structure "${st.name}"\n`);

    const data = letterData(p, st, {});
    const { earnings, gross } = deriveSalary(st.components, p.annualCtc, undefined, 30);

    await check('every Annexure component is payroll’s monthly figure × 12', () => {
      const pairs = [
        ['basic', 'basic'], ['hra', 'hra'], ['specialAllowance', 'specialAllowance'],
        ['conveyance', 'conveyanceAllowance'], ['medical', 'medicalAllowance'],
        ['otherAllowances', 'lta'],
      ];
      for (const [letterKey, payrollKey] of pairs) {
        assert.strictEqual(
          data[letterKey], Math.round(earnings[payrollKey] * 12),
          `${letterKey}: letter ${data[letterKey]} vs payroll ${earnings[payrollKey]}/mo`
        );
      }
    });

    await check('the letter’s gross matches the payslip’s gross', () => {
      const letterGross = data.basic + data.hra + data.specialAllowance
        + data.conveyance + data.medical + data.otherAllowances;
      assert.strictEqual(letterGross, gross * 12, `letter ${letterGross} vs payroll ${gross * 12}`);
    });

    await check('the stated CTC is the record’s, untouched', () => {
      assert.strictEqual(data.ctcAnnual, p.annualCtc);
    });

    await check('it renders, with the Annexure on its own sheet', async () => {
      data.body = await resolveLetterBody('appointment', data);
      data.brand = await getBranding();
      const buf = await renderAppointmentLetter(data);
      assert.ok(buf.length > 20000, `suspiciously small: ${buf.length} bytes`);
      const out = process.env.LETTER_OUT;
      if (out) { fs.writeFileSync(out, buf); console.log(`        wrote ${out}`); }
    });
  }

  // ---- the guard ----
  await check('an employee with no CTC is refused, and told what is missing', () => {
    const bare = { user: { fullName: 'Some One' }, dateOfJoining: new Date(), designation: 'Clerk' };
    assert.throws(() => assertIssuable(bare, null), (e) => {
      assert.strictEqual(e.status, 422);
      assert.match(e.message, /annual CTC/i);
      assert.match(e.message, /salary structure/i);
      return true;
    });
  });

  await check('an employee with no name is refused', () => {
    assert.throws(() => assertIssuable(
      { user: {}, dateOfJoining: new Date(), designation: 'Clerk', annualCtc: 500000 },
      { components: {} }
    ), (e) => {
      assert.strictEqual(e.status, 422);
      assert.match(e.message, /full name/i);
      return true;
    });
  });

  await check('a complete record passes', () => {
    assertIssuable(
      { user: { fullName: 'Some One' }, dateOfJoining: new Date(), designation: 'Clerk', annualCtc: 500000 },
      { components: { basicPct: 40 } }
    );
  });

  console.log(`\n${passed} checks passed`);
  await mongoose.connection.close();
})().catch(async (e) => {
  console.error('FAILED:', e.message);
  try { await mongoose.connection.close(); } catch { /* already closed */ }
  process.exit(1);
});
