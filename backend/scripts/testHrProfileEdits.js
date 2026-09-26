/**
 * HR's edits to an employee apply directly; the CEO/MD are told — behaviour
 * tests. No database.
 *
 *   npm run test:hr-edits
 *
 * WHY FAKES RATHER THAN A TEST DATABASE: `MONGO_URI` points at the live cluster.
 * The REAL User and EmployeeProfile schemas are loaded (so their setters trim,
 * upper-case a PAN and validate exactly as in production), but the statics the
 * code under test calls are pointed at in-memory arrays, `save()` validates and
 * stops there, the audit log is captured, and services/notify.js is replaced
 * before anything loads it. Nothing reaches Mongo, and no push is sent.
 *
 * WHAT IS BEING PINNED (user decision 2026-09-26): "if HR is doing any changes to
 * any profile it should not require any approval from CEO/MD, they will just be
 * notified about that".
 *   · an HR edit of an employee's details saves at once — no ChangeRequest;
 *   · every changed detail is audited, as a Backend edit always was;
 *   · the CEO/MD covering the employee's company get ONE notice per save naming
 *     each change, and a CEO/MD limited to another company gets nothing;
 *   · a statutory ID or bank account number is masked in that notice;
 *   · a value that only differs in formatting is neither audited nor reported;
 *   · the Backend's and an edit-mode exec's own edits are audited, not announced;
 *   · name / phone / login email (PUT /admin/users/:id) follow the same rule.
 */
const path = require('path');
const mongoose = require('mongoose');

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

/** Install a fake module so the code under test picks it up instead of the real one. */
const stub = (rel, exports) => {
  const filename = resolve(rel);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// Nothing may be buffered for a connection that will never come: a stray write
// fails at once instead of hanging the run for ten seconds.
mongoose.set('bufferCommands', false);

// ---------------------------------------------------------- notifications ----
const notices = [];
stub('services/notify.js', {
  notify: async (n) => { notices.push({ to: [String(n.recipient)], ...n }); return {}; },
  notifyMany: async (to, n) => {
    const ids = [...new Set((to || []).map(String))];
    if (ids.length) notices.push({ to: ids, ...n });
    return { created: ids.length };
  },
  notifyBackend: async () => ({ created: 0 }),
});

// ------------------------------------------------------------ fake store ----
const User = require(path.join(BACKEND, 'models/User.js'));
const EmployeeProfile = require(path.join(BACKEND, 'models/EmployeeProfile.js'));
const AuditLog = require(path.join(BACKEND, 'models/AuditLog.js'));
const ChangeRequest = require(path.join(BACKEND, 'models/ChangeRequest.js'));

const store = { User: [], EmployeeProfile: [] };
const idStr = (v) => (v == null ? '' : String(v._id || v));
const plain = (d) => (d && typeof d.toObject === 'function' ? d.toObject() : d);
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);

function matches(doc, filter = {}) {
  const o = plain(doc);
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return v.some((f) => matches(doc, f));
    const val = getPath(o, k);
    if (v && typeof v === 'object' && !Array.isArray(v) && !mongoose.isValidObjectId(v)) {
      if ('$in' in v) return v.$in.map(idStr).includes(idStr(val));
      if ('$ne' in v) return idStr(val) !== idStr(v.$ne);
    }
    if (typeof v === 'boolean') return (val === undefined ? true : val) === v; // isActive defaults on
    return idStr(val) === idStr(v);
  });
}

/** A thenable that answers the chain shapes Mongoose queries are used with. */
function query(resolver) {
  let lean = false;
  const q = {
    select: () => q, sort: () => q, populate: () => q, limit: () => q,
    lean: () => { lean = true; return q; },
    then: (res, rej) => Promise.resolve().then(() => {
      const out = resolver();
      if (!lean) return out;
      return Array.isArray(out) ? out.map(plain) : plain(out);
    }).then(res, rej),
    catch: (rej) => q.then(undefined, rej),
  };
  return q;
}

for (const [name, Model] of [['User', User], ['EmployeeProfile', EmployeeProfile]]) {
  Model.findById = (id) => query(() => store[name].find((d) => idStr(d._id) === idStr(id)) || null);
  Model.findOne = (f) => query(() => store[name].find((d) => matches(d, f)) || null);
  Model.find = (f) => query(() => store[name].filter((d) => matches(d, f)));
}
const audits = [];
AuditLog.create = async (doc) => { audits.push(doc); return doc; };
const changeRequestsCreated = [];
ChangeRequest.create = async (doc) => { changeRequestsCreated.push(doc); return doc; };

/** A real document whose save() runs the schema's validators and nothing else. */
function keep(name, doc) {
  doc.save = async function save() { await this.validate(); return this; };
  store[name].push(doc);
  return doc;
}

// -------------------------------------------------------------- fixtures ----
const oid = () => new mongoose.Types.ObjectId();
const coA = oid();
const coB = oid();
const person = (role, firstName, lastName, extra = {}) => keep('User', new User({
  _id: oid(), role, firstName, lastName, email: `${firstName.toLowerCase()}@example.com`,
  password: 'not-used-here-1', isActive: true, ...extra,
}));
const backend = person('SuperAdmin', 'Sequence', 'Admin');
const ceo = person('CEO', 'Chitra', 'Ceo', { companies: [coA] });
const md = person('MD', 'Mohan', 'Md', { companies: [coB] }); // another company only
const hr = person('HRManager', 'Ambika', 'S N');
const ashish = person('Employee', 'Ashish', 'Suryawanshi', { phone: '9800000001' });
const ravi = person('Employee', 'Ravi', 'Kumar');

const ashishProfile = keep('EmployeeProfile', new EmployeeProfile({
  _id: oid(), user: ashish._id, employeeCode: 'SSL 101', company: coA, dateOfJoining: new Date('2025-04-01'),
  department: 'Sales & Marketing', designation: 'Executive', pan: 'ABCDE1234F',
  bankDetails: { accountNumber: '001122334455', ifsc: 'HDFC0001234' },
}));
keep('EmployeeProfile', new EmployeeProfile({
  _id: oid(), user: ravi._id, employeeCode: 'SSL 102', company: coA, dateOfJoining: new Date('2025-04-01'), department: 'Accounts',
}));
keep('EmployeeProfile', new EmployeeProfile({ _id: oid(), user: hr._id, employeeCode: 'SSL 900', company: coA, dateOfJoining: new Date('2025-04-01') }));

const employees = require(path.join(BACKEND, 'controllers/employeeController.js'));
const admin = require(path.join(BACKEND, 'controllers/adminController.js'));

/** Run a handler the way Express would, catching what it throws. */
async function call(handler, { user, params = {}, body = {} }) {
  const req = { user, params, body, query: {} };
  const out = { status: 200, body: null };
  const res = {
    status(code) { out.status = code; return this; },
    json(d) { out.body = d; return this; },
    setHeader() {},
  };
  await new Promise((done) => {
    const next = (err) => {
      if (err) { out.status = err.status || (out.status === 200 ? 500 : out.status); out.error = err.message; }
      done();
    };
    Promise.resolve(handler(req, res, next)).then(() => done(), next);
  });
  return out;
}

const asHr = () => ({ ...hr.toObject(), fullName: 'Ambika S N' });
const reset = () => { notices.length = 0; audits.length = 0; changeRequestsCreated.length = 0; };

(async () => {
  console.log('\n--- HR changes a department: saved at once, CEO/MD told ---');
  let r = await call(employees.updateEmployee, {
    user: asHr(), params: { id: String(ashishProfile._id) },
    body: { department: 'Sales', designation: 'Executive' },
  });
  check('saved (200)', r.status, 200);
  if (r.error) console.log('        error:', r.error);
  check('the new department is on the record', ashishProfile.department, 'Sales');
  check('no change request was raised', changeRequestsCreated.length, 0);
  check('the change is audited', audits.map((a) => [a.field, a.fromStatus, a.toStatus]), [['Department', 'Sales & Marketing', 'Sales']]);
  check('audited as HR', audits[0]?.byRole, 'HRManager');
  check('one notice', notices.length, 1);
  check('to the CEO covering the company only (not the other company\'s MD, not HR)', notices[0]?.to, [String(ceo._id)]);
  check('the response says one exec was told', r.body?.execsNotified, 1);
  check('no approval queue in the response', r.body && 'queuedForApproval' in r.body, false);
  check('title names who and whose', notices[0]?.title, "Ambika S N (HR) updated Ashish Suryawanshi's details");
  isTrue('body shows before → after', notices[0]?.body.startsWith('Department: Sales & Marketing → Sales.'));
  isTrue('body says nothing needs approving', /nothing needs approving/.test(notices[0]?.body || ''));
  check('an admin-portal notice', notices[0]?.audience, 'admin');
  check('typed so the app does not open the tapper\'s own change requests', notices[0]?.type, 'profile_update');
  check('links to the employee\'s record', notices[0]?.link, `/admin/employees/${ashishProfile._id}`);

  console.log('\n--- several details in one save: one notice, sensitive values masked ---');
  reset();
  r = await call(employees.updateEmployee, {
    user: asHr(), params: { id: String(ashishProfile._id) },
    body: { designation: 'Senior Executive', pan: 'zyxwv9876k', bankDetails: { accountNumber: '998877665544', ifsc: 'HDFC0001234' } },
  });
  check('saved (200)', r.status, 200);
  check('designation applied', ashishProfile.designation, 'Senior Executive');
  check('PAN applied (upper-cased by the schema)', ashishProfile.pan, 'ZYXWV9876K');
  check('account number applied', ashishProfile.bankDetails.accountNumber, '998877665544');
  check('three changes audited (IFSC unchanged)', audits.map((a) => a.field).sort(), ['Bank - Account Number', 'Designation', 'PAN']);
  check('still one notice', notices.length, 1);
  const body = notices[0]?.body || '';
  isTrue('the PAN is masked to its last four', body.includes('PAN: ••234F → ••876K'));
  isTrue('the account number is masked to its last four', body.includes('Bank - Account Number: ••4455 → ••5544'));
  isTrue('no full PAN anywhere in the notice', !body.includes('ZYXWV9876K') && !notices[0].title.includes('ZYXWV9876K'));
  isTrue('no full account number anywhere in the notice', !body.includes('998877665544'));

  console.log('\n--- a value that only differs in formatting is not a change ---');
  reset();
  r = await call(employees.updateEmployee, {
    user: asHr(), params: { id: String(ashishProfile._id) },
    body: { department: '  Sales  ', pan: 'zyxwv9876k' },
  });
  check('saved (200)', r.status, 200);
  check('nothing audited', audits.length, 0);
  check('nobody notified', notices.length, 0);
  check('execsNotified is 0', r.body?.execsNotified, 0);

  console.log('\n--- an invalid value is refused outright, not queued ---');
  reset();
  r = await call(employees.updateEmployee, {
    user: asHr(), params: { id: String(ashishProfile._id) },
    body: { pan: 'NOT-A-PAN' },
  });
  isTrue('refused', r.status >= 400);
  check('nobody notified of a change that did not happen', notices.length, 0);
  check('no change request either', changeRequestsCreated.length, 0);
  // The failed save left the bad value on the in-memory document; put it back.
  ashishProfile.pan = 'ZYXWV9876K';

  console.log('\n--- the Backend and an edit-mode exec: audited, not announced ---');
  reset();
  r = await call(employees.updateEmployee, {
    user: backend.toObject(), params: { id: String(ashishProfile._id) },
    body: { grade: 'G5' },
  });
  check('Backend edit saved', [r.status, ashishProfile.grade], [200, 'G5']);
  check('audited', audits.map((a) => a.field), ['Grade']);
  check('nobody notified', notices.length, 0);
  reset();
  r = await call(employees.updateEmployee, {
    user: { ...ceo.toObject(), execEditAccess: true }, params: { id: String(ashishProfile._id) },
    body: { grade: 'G6' },
  });
  check('edit-mode CEO edit saved', [r.status, ashishProfile.grade], [200, 'G6']);
  check('nobody notified', notices.length, 0);

  console.log('\n--- name / phone via the account: same rule ---');
  reset();
  r = await call(admin.updateUser, {
    user: asHr(), params: { id: String(ashish._id) },
    body: { phone: '9800000002', lastName: 'Suryavanshi' },
  });
  check('saved (200)', r.status, 200);
  if (r.error) console.log('        error:', r.error);
  check('phone applied', ashish.phone, '9800000002');
  check('last name applied', ashish.lastName, 'Suryavanshi');
  check('no change request was raised', changeRequestsCreated.length, 0);
  check('both audited', audits.map((a) => a.field).sort(), ['Last Name', 'Phone']);
  check('one notice to the covering CEO', notices.map((n) => n.to), [[String(ceo._id)]]);
  check('the response says so', r.body?.execsNotified, 1);
  isTrue('the notice carries both changes', /Phone: 9800000001 → 9800000002/.test(notices[0]?.body || '')
    && /Last Name: Suryawanshi → Suryavanshi/.test(notices[0]?.body || ''));
  check('links to the employee\'s record', notices[0]?.link, `/admin/employees/${ashishProfile._id}`);

  reset();
  r = await call(admin.updateUser, {
    user: backend.toObject(), params: { id: String(ashish._id) },
    body: { phone: '9800000003' },
  });
  check('Backend phone edit saved, not announced', [r.status, ashish.phone, notices.length], [200, '9800000003', 0]);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
