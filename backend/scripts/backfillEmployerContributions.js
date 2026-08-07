/**
 * One-off backfill: stamp employer contributions onto payslips generated before
 * the payroll run started computing them.
 *
 * The `employerContributions` sub-schema (employer PF, pension, ESI, gratuity)
 * existed on the Payroll model but was never written, so every slip issued up to
 * now carries zeros and shows no employer block. This derives the figures from
 * each slip's OWN stored earnings — not from the employee's current salary
 * structure — so a slip whose figures were typed in by hand backfills correctly,
 * and reprinting an old slip can never pick up a later hike.
 *
 * Deliberately narrow: it writes the `employerContributions` field and nothing
 * else, via updateOne so the model's pre-save hook never runs. Gross, deductions,
 * net, status and every other field are left exactly as they are. In particular
 * this does NOT re-total anything — see the note the dry run prints about slips
 * whose stored totals disagree with their components.
 *
 * Run (from backend/):
 *   node scripts/backfillEmployerContributions.js                  # dry run, writes nothing
 *   node scripts/backfillEmployerContributions.js --apply          # actually write
 *   node scripts/backfillEmployerContributions.js --apply --year 2026 --month 7
 *
 * Safe to run more than once: a slip already holding the right figures is
 * skipped, so re-running writes nothing.
 */
require('dotenv').config();
const mongoose = require('mongoose');
// connectDB, not mongoose.connect: it pins public DNS resolvers, without which
// the mongodb+srv lookup fails on restrictive networks (ECONNREFUSED querySrv).
const connectDB = require('../config/db');
const Payroll = require('../models/Payroll');
const EmployeeProfile = require('../models/EmployeeProfile');
require('../models/User');
const { employerContributionsFor } = require('../controllers/payrollController');
const { EMPLOYER_COMPONENTS, linesBalance } = require('../services/payslipLines');

const APPLY = process.argv.includes('--apply');
const argOf = (flag) => {
  const i = process.argv.indexOf(flag);
  return i > -1 ? Number(process.argv[i + 1]) : null;
};
const ONLY_YEAR = argOf('--year');
const ONLY_MONTH = argOf('--month');

// The six salary-structure components ESIC is assessed on, matching the payroll
// controller. Incentives, bonus and overtime are not part of the structure gross.
const STRUCTURE_KEYS = [
  'basic', 'hra', 'specialAllowance', 'conveyanceAllowance', 'medicalAllowance', 'lta',
];

const KEYS = EMPLOYER_COMPONENTS.map((c) => c.key);
const inr = (n) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n || 0));
const sum = (o) => KEYS.reduce((a, k) => a + (Number(o?.[k]) || 0), 0);
const same = (a, b) => KEYS.every((k) => (Number(a?.[k]) || 0) === (Number(b?.[k]) || 0));

(async () => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is not set — run this from the backend folder.');
  await connectDB();

  const filter = {};
  if (ONLY_YEAR) filter.payPeriodYear = ONLY_YEAR;
  if (ONLY_MONTH) filter.payPeriodMonth = ONLY_MONTH;

  const slips = await Payroll.find(filter)
    .populate({ path: 'employee', select: 'employeeCode user', populate: { path: 'user', select: 'firstName lastName' } })
    .sort({ payPeriodYear: 1, payPeriodMonth: 1 });

  console.log(`\n${APPLY ? 'BACKFILL' : 'DRY RUN (nothing will be written — pass --apply to write)'}`);
  console.log(`${slips.length} payslip${slips.length === 1 ? '' : 's'}`
    + `${ONLY_YEAR || ONLY_MONTH ? ` (filtered to ${ONLY_MONTH || '*'}/${ONLY_YEAR || '*'})` : ''}\n`);

  const totals = { written: 0, unchanged: 0, nothingToStamp: 0, unbalanced: 0 };
  const unbalanced = [];

  for (const slip of slips) {
    const who = `${slip.employee?.user?.firstName || '?'} ${slip.employee?.user?.lastName || ''}`.trim();
    const period = `${String(slip.payPeriodMonth).padStart(2, '0')}/${slip.payPeriodYear}`;
    const label = `${period}  ${who.padEnd(20)}`;

    const earnings = slip.earnings?.toObject?.() || slip.earnings || {};
    const gross = STRUCTURE_KEYS.reduce((a, k) => a + (Number(earnings[k]) || 0), 0);
    const next = employerContributionsFor(earnings.basic, gross);
    const current = slip.employerContributions?.toObject?.() || slip.employerContributions || {};

    // Flag, but never touch, slips whose stored totals disagree with their
    // components — that is the separate doubleDayPay bug, and silently
    // re-totalling here would change what an already-issued slip says.
    const bal = linesBalance(slip);
    if (!bal.earnings || !bal.deductions) {
      totals.unbalanced += 1;
      unbalanced.push(`${label} stored gross ${inr(slip.grossSalary)} vs components`);
    }

    if (sum(next) === 0) {
      totals.nothingToStamp += 1;
      console.log(`  ${label} — nothing to stamp (no Basic on this slip)`);
      continue;
    }
    if (same(current, next)) {
      totals.unchanged += 1;
      console.log(`  ${label} — already correct (${inr(sum(next))})`);
      continue;
    }

    const detail = KEYS.filter((k) => next[k]).map((k) => `${k} ${inr(next[k])}`).join(', ');
    console.log(`  ${label} — ${APPLY ? 'writing' : 'would write'} ${inr(sum(next))}  [${detail}]`);

    if (APPLY) {
      // updateOne, not save(): this must not run the pre-save hook, which would
      // re-derive gross/net and could change an already-issued slip.
      await Payroll.updateOne({ _id: slip._id }, { $set: { employerContributions: next } });
    }
    totals.written += 1;
  }

  console.log(`\n${'-'.repeat(58)}`);
  console.log(`${APPLY ? 'written' : 'to write'}              ${totals.written}`);
  console.log(`already correct       ${totals.unchanged}`);
  console.log(`nothing to stamp      ${totals.nothingToStamp}  (no Basic recorded)`);

  if (unbalanced.length) {
    console.log(`\n${unbalanced.length} slip(s) have stored totals that disagree with their own components.`);
    console.log('This backfill deliberately leaves them alone — re-totalling would change an');
    console.log('already-issued slip. Listed so you can decide separately:');
    for (const line of unbalanced) console.log(`  ${line}`);
  }

  // Why some slips have no Basic at all: the profile behind them has no CTC or
  // no salary structure, so the payroll run had nothing to compute from.
  const bare = await EmployeeProfile.find({ $or: [{ annualCtc: { $in: [null, 0] } }, { salaryStructure: null }] })
    .populate('user', 'firstName lastName').lean();
  if (bare.length) {
    console.log(`\n${bare.length} employee profile(s) have no CTC and/or no salary structure, which is why`);
    console.log('their payslips come out empty. Set those up and re-run payroll for the month:');
    for (const p of bare) {
      console.log(`  ${`${p.user?.firstName || '?'} ${p.user?.lastName || ''}`.trim().padEnd(22)}`
        + `ctc=${p.annualCtc || 0}  structure=${p.salaryStructure ? 'set' : 'MISSING'}`);
    }
  }

  if (!APPLY && totals.written) console.log('\nRe-run with --apply to write these.');
  console.log('');
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
