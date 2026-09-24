/**
 * Salary changes wait for a CEO/MD — behaviour tests. No database.
 *
 *   npm run test:salary-approval
 *
 * WHY FAKES RATHER THAN A TEST DATABASE: `MONGO_URI` points at the live cluster
 * (see scripts/testSalaryStructureImport.js), so the three models this touches
 * are replaced in `require.cache` with small in-memory stand-ins BEFORE the
 * controllers load. The REAL controllers and services/salaryChanges.js then run
 * end to end against them; nothing reaches Mongo.
 *
 * WHAT IS BEING PINNED (user decision 2026-09-24):
 *   · HR may SET UP a salary nobody has saved yet — that applies at once;
 *   · once saved, an HR's change or CTC revision is only a request: 202, and
 *     the employee's record — which is all payroll reads — does not move;
 *   · a CEO/MD/Super Admin's own change applies directly;
 *   · approving writes exactly what the approver was shown, and records who
 *     approved it; a refusal needs a reason and changes nothing;
 *   · a request whose starting point moved since it was raised cannot be
 *     approved; one already decided cannot be decided twice;
 *   · only the requester withdraws, and one waiting change per salary;
 *   · new percentages on a structure people are paid on wait the same way.
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

const stub = (rel, exports) => {
  const filename = resolve(rel);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

// ------------------------------------------------------------ fake store ----
let seq = 0;
const newId = (prefix) => `${prefix}${(seq += 1)}`;
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const idStr = (v) => (v == null ? '' : String(v._id || v));

function matches(doc, filter = {}) {
  return Object.entries(filter).every(([k, v]) => {
    if (k === '$or') return v.some((f) => matches(doc, f));
    if (k === '$and') return v.every((f) => matches(doc, f));
    const val = getPath(doc, k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if ('$in' in v) return v.$in.map(idStr).includes(idStr(val));
      if ('$exists' in v) return (val !== undefined && val !== null) === v.$exists;
      if ('$ne' in v) return idStr(val) !== idStr(v.$ne);
    }
    return idStr(val) === idStr(v);
  });
}

const models = {};
const users = {
  hr1: { _id: 'hr1', firstName: 'Hema', lastName: 'HR', role: 'HRManager' },
  hr2: { _id: 'hr2', firstName: 'Harsh', lastName: 'HR', role: 'HRManager' },
  ceo1: { _id: 'ceo1', firstName: 'Chitra', lastName: 'CEO', role: 'CEO' },
  u1: { _id: 'u1', firstName: 'Asha', lastName: 'Patel', role: 'Employee' },
  u2: { _id: 'u2', firstName: 'Ravi', lastName: 'Kumar', role: 'Employee' },
};

/**
 * A model over an array: the handful of query shapes the salary code uses.
 * Documents are the live objects (so a save is simply "it is already there");
 * `.lean()` hands back a populated deep copy.
 */
function fakeModel(name, refs = {}) {
  const rows = [];
  const decorate = (d) => {
    if (!d) return d;
    Object.defineProperty(d, 'save', { value: async function save() { d.saves = (d.saves || 0) + 1; return d; }, configurable: true });
    Object.defineProperty(d, 'isModified', { value: () => true, configurable: true });
    return d;
  };
  const populateOne = (obj, spec) => {
    const p = typeof spec === 'string' ? spec : spec.path;
    const ref = refs[p];
    if (!ref || obj[p] == null) return;
    const target = ref === 'User' ? users[idStr(obj[p])] : models[ref].rows.find((r) => r._id === idStr(obj[p]));
    if (!target) return;
    obj[p] = clone(target);
    if (spec.populate && ref === 'EmployeeProfile') {
      const inner = spec.populate.path;
      if (inner === 'user' && obj[p].user) obj[p].user = clone(users[idStr(obj[p].user)]);
    }
  };
  const query = (resolver) => {
    const pops = [];
    let lean = false;
    const q = {
      populate: (spec) => { pops.push(spec); return q; },
      select: () => q,
      sort: () => q,
      limit: () => q,
      lean: () => { lean = true; return q; },
      then: (res, rej) => Promise.resolve().then(() => {
        const out = resolver();
        if (!lean) return Array.isArray(out) ? out.map(decorate) : decorate(out);
        const copy = clone(out);
        const each = Array.isArray(copy) ? copy : [copy];
        for (const o of each) if (o) for (const s of pops) populateOne(o, s);
        return copy;
      }).then(res, rej),
    };
    return q;
  };
  const model = {
    rows,
    find: (f) => query(() => rows.filter((r) => matches(r, f))),
    findOne: (f) => query(() => rows.find((r) => matches(r, f)) || null),
    findById: (id) => query(() => rows.find((r) => r._id === idStr(id)) || null),
    exists: async (f) => (rows.find((r) => matches(r, f)) ? { _id: 'x' } : null),
    countDocuments: async (f) => rows.filter((r) => matches(r, f)).length,
    create: async (doc) => {
      if (name === 'SalaryChangeRequest' && (doc.status || 'Pending') === 'Pending') {
        const clash = rows.find((r) => r.status === 'Pending'
          && ((doc.employee && idStr(r.employee) === idStr(doc.employee))
            || (doc.structure && idStr(r.structure) === idStr(doc.structure))));
        if (clash) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }
      const row = { status: name === 'SalaryChangeRequest' ? 'Pending' : undefined, ...clone(doc), _id: newId(name[0]), createdAt: new Date().toISOString() };
      rows.push(row);
      return decorate(row);
    },
    findOneAndUpdate: async (f, u) => {
      const row = rows.find((r) => matches(r, f));
      if (!row) return null;
      Object.assign(row, clone(u.$set || {}));
      return decorate(row);
    },
    updateOne: async (f, u) => {
      const row = rows.find((r) => matches(r, f));
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, clone(u.$set || {}));
      for (const k of Object.keys(u.$unset || {})) delete row[k];
      return { modifiedCount: 1 };
    },
  };
  models[name] = model;
  return model;
}

const Requests = fakeModel('SalaryChangeRequest', {
  employee: 'EmployeeProfile', previousStructure: 'SalaryStructure', newStructure: 'SalaryStructure',
  structure: 'SalaryStructure', requestedBy: 'User', decidedBy: 'User',
});
Requests.SALARY_CHANGE_STATUSES = ['Pending', 'Approved', 'Rejected', 'Withdrawn'];
Requests.SALARY_CHANGE_KINDS = ['setup', 'revision', 'structure'];
const Structures = fakeModel('SalaryStructure');
const Profiles = fakeModel('EmployeeProfile', { user: 'User', salaryStructure: 'SalaryStructure' });

stub('models/SalaryChangeRequest.js', Requests);
stub('models/SalaryStructure.js', Structures);
stub('models/EmployeeProfile.js', Profiles);

const sent = [];
stub('services/notify.js', {
  notify: async (n) => { sent.push({ to: [idStr(n.recipient)], title: n.title }); },
  notifyMany: async (to, n) => { sent.push({ to: to.map(idStr), title: n.title }); },
  notifyBackend: async () => {},
});
stub('services/audience.js', {
  usersHoldingAny: async () => [],
  usersInRoles: async (...roles) => Object.values(users).filter((u) => roles.includes(u.role)).map((u) => u._id),
  scopeRecipientsToCompany: async (ids) => ids,
});

// The REAL company wall, bound to the fake profiles — only the two helpers
// that would query are swapped out, BEFORE the controllers destructure them.
const scope = require(path.join(BACKEND, 'utils/employeeScope.js'));
scope.allowedEmployeeIds = async (req) => req.allowed || null;
scope.assertCanEditProfileOf = async () => {};

const payroll = require(path.join(BACKEND, 'controllers/payrollController.js'));
const changes = require(path.join(BACKEND, 'controllers/salaryChangeController.js'));
const structuresCtrl = require(path.join(BACKEND, 'controllers/salaryStructureController.js'));

// ------------------------------------------------------------- fixtures ----
const standard = { _id: 'st-std', name: 'Standard', components: { basicPct: 60, hraPct: 30, specialAllowancePct: 10, conveyancePct: 0, medicalPct: 0, ltaPct: 0 } };
const bandB = { _id: 'st-b', name: 'Band B', components: { basicPct: 50, hraPct: 25, specialAllowancePct: 25, conveyancePct: 0, medicalPct: 0, ltaPct: 0 } };
Structures.rows.push(standard, bandB);
const asha = { _id: 'p1', user: 'u1', employeeCode: 'SSL 1', company: 'coA', salaryStructure: 'st-std', annualCtc: 276000, ctcHistory: [] };
const ravi = { _id: 'p2', user: 'u2', employeeCode: 'SSL 2', company: 'coA', salaryStructure: null, annualCtc: 0, ctcHistory: [] };
Profiles.rows.push(asha, ravi);

const as = (userId, extra = {}) => ({ ...users[userId], ...extra });

/** Run a handler the way Express would, catching what it throws. */
async function call(handler, { user, params = {}, body = {}, query = {}, allowed } = {}) {
  const req = { user, params, body, query, allowed };
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

const pendingFor = (employee) => Requests.rows.find((r) => r.status === 'Pending' && idStr(r.employee) === employee);

(async () => {
  console.log('\n--- HR sets up a salary nobody has saved yet ---');
  let r = await call(payroll.saveSalarySetup, { user: as('hr1', { scopeProfileId: 'pHR' }), params: { id: 'p2' }, body: { salaryStructure: 'st-std', annualCtc: 300000 } });
  check('applied at once (200)', r.status, 200);
  check('the structure is on the record', idStr(ravi.salaryStructure), 'st-std');
  check('and the CTC', ravi.annualCtc, 300000);
  check('a first CTC writes no revision (no earlier figure to keep)', ravi.ctcHistory.length, 0);
  check('nothing was sent for approval', Requests.rows.length, 0);

  console.log('\n--- once saved, HR changing it is only a request ---');
  r = await call(payroll.saveSalarySetup, { user: as('hr1', { scopeProfileId: 'pHR' }), params: { id: 'p1' }, body: { salaryStructure: 'st-b', annualCtc: 300000, reason: 'Offer letter said 3L' } });
  check('answered 202', r.status, 202);
  isTrue('flagged as waiting', r.body?.pendingApproval);
  check('the structure did NOT move', idStr(asha.salaryStructure), 'st-std');
  check('nor the CTC payroll reads', asha.annualCtc, 276000);
  const setupReq = pendingFor('p1');
  check('the request holds both halves', [setupReq?.kind, idStr(setupReq?.newStructure), setupReq?.previousCtc, setupReq?.newCtc], ['setup', 'st-b', 276000, 300000]);
  check('with Band B\'s percentages as the approver will see them', setupReq?.newStructureComponents?.basicPct, 50);
  isTrue('the CEO was told', sent.some((n) => n.to.includes('ceo1') && /approval/i.test(n.title)));
  check('HR sees they cannot decide their own ask', [r.body.request.canDecide, r.body.request.canWithdraw], [false, true]);

  console.log('\n--- one waiting change per salary ---');
  r = await call(payroll.giveHike, { user: as('hr2'), params: { id: 'p1' }, body: { mode: 'percent', value: 10, effectiveYear: 2026, effectiveMonth: 9 } });
  check('a second ask is refused (409)', r.status, 409);
  isTrue('saying one is already waiting', /already/.test(r.error || ''));

  console.log('\n--- deciding ---');
  r = await call(changes.rejectSalaryChange, { user: as('ceo1'), params: { id: setupReq._id }, body: {} });
  check('turning down needs a reason', r.status, 400);
  r = await call(changes.approveSalaryChange, { user: as('hr2'), params: { id: setupReq._id } });
  check('another HR cannot approve it', r.status, 403);
  r = await call(changes.approveSalaryChange, { user: as('ceo1', { _id: 'hr1' }), params: { id: setupReq._id } });
  check('nobody decides their own ask', r.status, 403);
  r = await call(changes.approveSalaryChange, { user: as('ceo1', { companies: ['coB'] }), params: { id: setupReq._id } });
  check('a CEO limited to another company cannot decide it', r.status, 403);
  r = await call(changes.approveSalaryChange, { user: as('ceo1'), params: { id: setupReq._id }, body: { note: 'ok' } });
  check('the CEO approves it', r.status, 200);
  check('now the structure moves', idStr(asha.salaryStructure), 'st-b');
  check('and the CTC', asha.annualCtc, 300000);
  check('as a revision payroll will read (it replaced a CTC in force)', asha.ctcHistory.length, 1);
  check('recording who asked and who agreed', [asha.ctcHistory[0].byName, asha.ctcHistory[0].approvedByName], ['Hema HR', 'Chitra CEO']);
  check('from the month it was asked for', [asha.ctcHistory[0].previousCtc, asha.ctcHistory[0].newCtc], [276000, 300000]);
  check('the request is Approved', Requests.rows.find((x) => x._id === setupReq._id).status, 'Approved');
  isTrue('and HR was told', sent.some((n) => n.to.includes('hr1') && /approved/i.test(n.title)));
  r = await call(changes.approveSalaryChange, { user: as('ceo1'), params: { id: setupReq._id } });
  check('it cannot be decided twice', r.status, 409);

  console.log('\n--- an HR revision waits too, and applies exactly as shown ---');
  r = await call(payroll.giveHike, { user: as('hr1', { scopeProfileId: 'pHR' }), params: { id: 'p1' }, body: { mode: 'percent', value: 10, effectiveYear: 2026, effectiveMonth: 9, reason: 'Appraisal' } });
  check('202', r.status, 202);
  check('with the entry an old app build still reads', [r.body.applied, r.body.entry?.newCtc], [false, 330000]);
  check('nothing moved yet', [asha.annualCtc, asha.ctcHistory.length], [300000, 1]);
  const hikeReq = pendingFor('p1');
  r = await call(changes.approveSalaryChange, { user: as('ceo1'), params: { id: hikeReq._id } });
  check('approved', r.status, 200);
  check('the new CTC is the one the CEO was shown', asha.annualCtc, 330000);
  check('one more revision, marked approved', [asha.ctcHistory.length, asha.ctcHistory[1].approvedByName, asha.ctcHistory[1].mode], [2, 'Chitra CEO', 'percent']);

  console.log('\n--- a request whose starting point moved cannot be approved ---');
  r = await call(payroll.giveHike, { user: as('hr1', { scopeProfileId: 'pHR' }), params: { id: 'p2' }, body: { mode: 'amount', value: 20000, effectiveYear: 2026, effectiveMonth: 9 } });
  check('HR asks for +20,000 on 3,00,000', r.status, 202);
  const staleReq = pendingFor('p2');
  // Meanwhile the Backend sets Ravi's salary directly.
  r = await call(payroll.saveSalarySetup, { user: as('ceo1', { execEditAccess: true }), params: { id: 'p2' }, body: { annualCtc: 350000 } });
  check('an approver\'s own change applies directly', [r.status, ravi.annualCtc], [200, 350000]);
  r = await call(changes.approveSalaryChange, { user: as('ceo1'), params: { id: staleReq._id } });
  check('the stale request is refused (409)', r.status, 409);
  check('and left waiting, untouched', Requests.rows.find((x) => x._id === staleReq._id).status, 'Pending');
  check('Ravi keeps the CEO\'s figure', ravi.annualCtc, 350000);
  r = await call(changes.rejectSalaryChange, { user: as('ceo1'), params: { id: staleReq._id }, body: { note: 'Already set to 3.5L' } });
  check('it can still be turned down', [r.status, Requests.rows.find((x) => x._id === staleReq._id).status], [200, 'Rejected']);

  console.log('\n--- withdrawing ---');
  r = await call(payroll.saveSalarySetup, { user: as('hr1', { scopeProfileId: 'pHR' }), params: { id: 'p2' }, body: { annualCtc: 360000 } });
  const mine = pendingFor('p2');
  r = await call(changes.withdrawSalaryChange, { user: as('hr2'), params: { id: mine._id } });
  check('only the requester may withdraw', r.status, 403);
  r = await call(changes.withdrawSalaryChange, { user: as('hr1'), params: { id: mine._id } });
  check('the requester does', [r.status, Requests.rows.find((x) => x._id === mine._id).status], [200, 'Withdrawn']);
  check('and nothing changed', ravi.annualCtc, 350000);

  console.log('\n--- the queue ---');
  r = await call(payroll.saveSalarySetup, { user: as('hr1', { scopeProfileId: 'pHR' }), params: { id: 'p2' }, body: { annualCtc: 370000 } });
  r = await call(changes.listSalaryChanges, { user: as('ceo1'), query: {} });
  check('the CEO sees what is waiting', r.body.requests.map((x) => x.newCtc), [370000]);
  check('and may decide it', r.body.requests[0].canDecide, true);
  isTrue('with a one-line summary', /₹3,50,000 → ₹3,70,000/.test(r.body.requests[0].summary));
  r = await call(changes.listSalaryChanges, { user: as('ceo1', { companies: ['coB'] }), query: {}, allowed: ['p9'] });
  check('a CEO limited to another company does not', r.body.requests.length, 0);

  console.log('\n--- a structure people are paid on is a salary too ---');
  r = await call(structuresCtrl.updateStructure, {
    user: as('hr1'), params: { id: 'st-b' },
    body: { name: 'Band B (2026)', components: { basicPct: 40, hraPct: 30, specialAllowancePct: 30, conveyancePct: 0, medicalPct: 0, ltaPct: 0 } },
  });
  check('new percentages from HR wait (202)', r.status, 202);
  check('the percentages did NOT move', bandB.components.basicPct, 50);
  check('the name, which pays nobody anything, saved', bandB.name, 'Band B (2026)');
  const stReq = Requests.rows.find((x) => x.kind === 'structure' && x.status === 'Pending');
  check('the request knows who is paid on it', stReq?.holderCount, 1);
  r = await call(structuresCtrl.deleteStructure, { user: as('hr1'), params: { id: 'st-b' } });
  check('HR cannot delete a structure people are paid on', r.status, 409);
  r = await call(changes.approveSalaryChange, { user: as('ceo1'), params: { id: stReq._id } });
  check('approved', r.status, 200);
  check('now the percentages move', [bandB.components.basicPct, bandB.components.specialAllowancePct], [40, 30]);
  r = await call(structuresCtrl.updateStructure, {
    user: as('hr1'), params: { id: 'st-std' },
    body: { components: { basicPct: 70, hraPct: 20, specialAllowancePct: 10, conveyancePct: 0, medicalPct: 0, ltaPct: 0 } },
  });
  // Ravi is on Standard, so it is in use.
  check('any structure in use waits', r.status, 202);
  Structures.rows.push({ _id: 'st-draft', name: 'Draft', components: { basicPct: 60, hraPct: 30, specialAllowancePct: 10, conveyancePct: 0, medicalPct: 0, ltaPct: 0 } });
  r = await call(structuresCtrl.updateStructure, {
    user: as('hr1'), params: { id: 'st-draft' },
    body: { components: { basicPct: 55, hraPct: 35, specialAllowancePct: 10, conveyancePct: 0, medicalPct: 0, ltaPct: 0 } },
  });
  check('a structure nobody is on is HR\'s to shape (200)', r.status, 200);
  check('and applies at once', Structures.rows.find((s) => s._id === 'st-draft').components.basicPct, 55);

  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
