/**
 * Employee Excel import — behaviour tests. No database.
 *
 *   npm run test:import
 *
 * WHY STUBS RATHER THAN A TEST DATABASE: `MONGO_URI` here points at the live
 * cluster (see the other test scripts, which refuse to run without their own
 * throwaway URI). These tests install fake models into `require.cache` before
 * loading the controller, so the REAL importEmployeesXlsx runs end to end
 * against them and nothing reaches Mongo.
 *
 * WHAT IS BEING PINNED: an import must never refuse a row because the sheet
 * named something that does not exist yet. A designation, department, grade,
 * work location or company is CREATED; a role, salary structure or person that
 * cannot be invented is left at its safe default. Either way the row imports
 * and a flag is recorded for HR, the admins and the executives to review.
 */
const path = require('path');

const BACKEND = path.join(__dirname, '..');
const resolve = (p) => require.resolve(path.join(BACKEND, p));

let passed = 0;
let failed = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`
    + (ok ? '' : `\n         got  ${JSON.stringify(actual)}\n         want ${JSON.stringify(expected)}`));
  if (ok) passed += 1; else failed += 1;
};
const isTrue = (name, cond) => check(name, !!cond, true);

// ---- captured side effects ----
const insertedFlags = [];
const createdUsers = [];
const createdProfiles = [];
const createdCompanies = [];
const deletedUsers = [];
const ensured = { Designation: [], Department: [], Grade: [], Location: [] };
// Flipped mid-run to prove the account is rolled back when its employee record
// cannot be saved.
let failProfileCreate = false;

/** Install a fake module so the controller picks it up instead of the real one. */
const stub = (rel, exports) => {
  const filename = resolve(rel);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// Grabbed from the REAL module before the stub below replaces it in the cache:
// parsePersonName is pure, so it is tested directly rather than through an
// import run. (Order matters here — after the stub, this export is gone.)
const { parsePersonName } = require(path.join(BACKEND, 'services/employeeExcel.js'));

const ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager', 'Employee'];

stub('models/User.js', {
  ROLES,
  // Nothing exists in this run: no duplicate account, and neither the reporting
  // manager nor the HR partner the sheet names can be found.
  findOne: async () => null,
  findById: async () => null,
  find: () => ({ select: () => ({ lean: async () => [] }) }),
  create: async (doc) => {
    const _id = `u${createdUsers.length + 1}`;
    createdUsers.push({ ...doc, _id });
    return { _id, ...doc };
  },
  // Returns a thenable with .catch so the controller's `.catch(() => {})` works.
  deleteOne: async (q) => { deletedUsers.push(q._id); return {}; },
  updateOne: async () => ({}),
});
stub('models/EmployeeProfile.js', {
  findOne: async () => null,
  findById: async () => null,
  create: async (doc) => {
    if (failProfileCreate) throw new Error('simulated profile failure');
    createdProfiles.push(doc);
    return { _id: `p${createdProfiles.length}`, ...doc };
  },
  find: () => ({ populate: () => ({ sort: async () => [] }) }),
});
stub('models/SalaryStructure.js', { findOne: async () => null });
stub('models/Company.js', {
  findOne: async () => null,
  create: async (doc) => { createdCompanies.push(doc); return { _id: `c${createdCompanies.length}`, ...doc }; },
});
stub('models/ImportFlag.js', {
  insertMany: async (docs) => { insertedFlags.push(...docs); return docs; },
  deleteMany: async () => ({}),
});
stub('services/orgMasterSync.js', {
  // `true` = "this call created it", which is what decides a flag. Every value
  // in this fixture is new, which is the case under test.
  ensureDesignation: async (n) => { if (!n) return false; ensured.Designation.push(n); return true; },
  ensureDepartment: async (n) => { if (!n) return false; ensured.Department.push(n); return true; },
  ensureGrade: async (n) => { if (!n) return false; ensured.Grade.push(n); return true; },
  ensureLocation: async (n) => { if (!n) return false; ensured.Location.push(n); return true; },
});
stub('services/notify.js', { notify: async () => {}, notifyMany: async () => {} });

// One row naming a new value in every column that can carry one.
const ROWS = [{
  excelRow: 2,
  user: {
    firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com',
    role: 'Site Supervisor', // not a system role — a job title in the wrong column
  },
  profile: {
    employeeCode: 'SSL900',
    dateOfJoining: new Date('2026-01-05'),
    designation: 'Site Supervisor',
    department: 'Projects',
    grade: 'G7',
    workLocation: 'Pune Yard',
    companyName: 'Brand New Pvt Ltd',
    salaryStructureName: 'Nonexistent Structure',
    reportingManagerEmail: 'later@example.com', // further down the same file
    hrPartnerEmail: 'nohr@example.com',
  },
}];
stub('services/employeeExcel.js', { writeWorkbook: async () => {}, parseWorkbook: async () => ROWS });

const ctrl = require(path.join(BACKEND, 'controllers/employeeController.js'));

(async () => {
  const req = {
    file: { buffer: Buffer.from('x') },
    // An HR Manager, deliberately: they may not grant admin roles, which is one
    // of the two ways a role gets defaulted.
    user: { _id: 'admin1', role: 'HRManager' },
    body: {},
    query: {},
  };
  let payload = null;
  const res = { status() { return this; }, json(d) { payload = d; }, setHeader() {} };

  await ctrl.importEmployeesXlsx(req, res, (e) => { throw e; });

  console.log('\n--- the row imports even though every value is new ---');
  check('one row created', payload.createdCount, 1);
  check('no errors', payload.errorCount, 0);
  check('nothing skipped', payload.skippedCount, 0);

  console.log('\n--- values that are just names get created ---');
  check('designation registered', ensured.Designation, ['Site Supervisor']);
  check('department registered', ensured.Department, ['Projects']);
  check('grade registered', ensured.Grade, ['G7']);
  check('work location registered', ensured.Location, ['Pune Yard']);
  check('company created', createdCompanies.map((c) => c.name), ['Brand New Pvt Ltd']);

  console.log('\n--- a role is never invented ---');
  check('account created as Employee', createdUsers[0].role, 'Employee');

  console.log('\n--- references that cannot be invented are left blank, not fatal ---');
  check('no salary structure set', createdProfiles[0].salaryStructure, undefined);
  check('no reporting manager set', createdProfiles[0].reportingManager, undefined);
  check('no HR partner set', createdProfiles[0].hrPartner, undefined);

  console.log('\n--- and every one of them is flagged for review ---');
  const byField = Object.fromEntries(insertedFlags.map((f) => [f.field, f.action]));
  check('nine flags', payload.flagCount, 9);
  check('role — defaulted', byField.role, 'defaulted');
  check('designation — created', byField.designation, 'created');
  check('department — created', byField.department, 'created');
  check('grade — created', byField.grade, 'created');
  check('work location — created', byField.workLocation, 'created');
  check('company — created', byField.company, 'created');
  check('salary structure — unmatched', byField.salaryStructure, 'unmatched');
  check('reporting manager — unmatched', byField.reportingManager, 'unmatched');
  check('HR partner — unmatched', byField.hrPartner, 'unmatched');

  // The raw cell is the evidence a reviewer judges by, so it must survive intact.
  isTrue('a flag keeps the exact sheet value', insertedFlags.find((f) => f.field === 'role').rawValue === 'Site Supervisor');
  isTrue('one batch id across the upload', new Set(insertedFlags.map((f) => f.batch)).size === 1);
  isTrue('flags point at the created profile', insertedFlags.every((f) => f.employee === 'p1'));
  isTrue('every flag explains itself', insertedFlags.every((f) => f.note && f.note.length > 20));

  console.log('\n--- an import adds an EMPLOYEE, never a bare login ---');
  // The account and the employee record must arrive together. This is the bug
  // that put 17 profile-less logins in the live database: the User was created
  // before the reference lookups, so a lookup that threw left it behind.
  check('one account for one employee', [createdUsers.length, createdProfiles.length], [1, 1]);
  check('the profile points at that account', createdProfiles[0].user, 'u1');

  // Now force the employee record to fail and prove the account does not survive.
  const before = deletedUsers.length;
  failProfileCreate = true;
  createdUsers.length = 0;
  insertedFlags.length = 0;
  let second = null;
  await ctrl.importEmployeesXlsx(
    { ...req, file: { buffer: Buffer.from('x') } },
    { status() { return this; }, json(d) { second = d; }, setHeader() {} },
    (e) => { throw e; }
  );
  check('the row is reported as an error', second.errorCount, 1);
  check('nothing was created', second.createdCount, 0);
  check('the orphaned account was deleted', deletedUsers.length - before, 1);
  check('and it was the right one', deletedUsers[deletedUsers.length - 1], createdUsers[0]?._id || 'u1');

  console.log('\n--- names arrive tidy, whatever the spreadsheet shouted ---');
  const nm = (input, expected) => check(`"${input}" → "${expected}"`, parsePersonName(input), expected);
  // The two the business asked for.
  nm('YASH KUMAR', 'Yash Kumar');
  nm('yash kumar', 'Yash Kumar');
  nm('Yash Kumar', 'Yash Kumar');            // already right — untouched
  // Real names from the import that went wrong.
  nm('SIDDHANT RAJ', 'Siddhant Raj');
  nm('GAJENDRA SARSWAT', 'Gajendra Sarswat');
  nm('sandeepa T.U', 'Sandeepa T.U');        // initials keep their case
  nm('Kc lavanya Shetty', 'Kc Lavanya Shetty'); // per-word: only "lavanya" was wrong
  nm('KUSUMA V', 'Kusuma V');
  // Deliberate mixed case is somebody's actual name — never flatten it.
  nm('McDonald', 'McDonald');
  nm('DeSilva', 'DeSilva');
  nm("D'Souza", "D'Souza");
  // Uniform case still gets the internal capitals right.
  nm("o'brien", "O'Brien");
  nm('MARY-JANE', 'Mary-Jane');
  // Whitespace from a copy-paste.
  nm('  ANITA   RAO  ', 'Anita Rao');
  check('an empty cell stays empty', parsePersonName(''), undefined);
  check('a blank cell stays empty', parsePersonName('   '), undefined);

  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nThe import threw, which is itself the bug:\n', err);
  process.exit(1);
});
