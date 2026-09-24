/**
 * Assets issued employee-wise — behaviour tests. No database.
 *
 *   npm run test:asset-bundle
 *
 * The Assets page issues two ways (user request 2026-09-24): one asset to many
 * people (POST /assets/:id/assignments) and several assets to one person (POST
 * /assets/employees/:userId/assignments). Both must write the SAME holding rows,
 * so the asset-wise and employee-wise views can never disagree. The three models
 * involved are in-memory stand-ins (MONGO_URI is the live cluster — see
 * scripts/testSalaryStructureImport.js); the real controller runs against them.
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
const stub = (rel, exports) => {
  const filename = resolve(rel);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
};

const idStr = (v) => (v == null ? '' : String(v._id || v));
const clone = (v) => JSON.parse(JSON.stringify(v ?? null));
const inList = (f, v) => (f && typeof f === 'object' && f.$in ? f.$in.map(idStr).includes(idStr(v)) : idStr(f) === idStr(v));

const people = { u1: { _id: 'u1', firstName: 'Priya', lastName: 'S', role: 'Employee' }, u2: { _id: 'u2', firstName: 'Arjun', lastName: 'K', role: 'Employee' } };
const kinds = [
  { _id: 'a-laptop', name: 'Laptop', assetTag: 'LAPTOP', category: 'Laptop', status: 'Available' },
  { _id: 'a-phone', name: 'Phone', assetTag: 'PHONE', category: 'Phone', status: 'Available' },
  { _id: 'a-sim', name: 'SIM', assetTag: 'SIM', category: 'SIM', status: 'Available' },
  { _id: 'a-old', name: 'Old desktop', assetTag: 'OLD', category: 'Desktop', status: 'Retired' },
];
const holdings = [];
let n = 0;

// A query that can be populated, sorted and leaned, and awaited at any point.
const chain = (resolver, pop) => {
  const pops = [];
  const q = {
    select: () => q, sort: () => q, limit: () => q, lean: () => q,
    populate: (p) => { pops.push(p); return q; },
    then: (res, rej) => Promise.resolve().then(() => {
      const rows = clone(resolver());
      if (pop) for (const r of [].concat(rows)) if (r) pop(r, pops);
      return rows;
    }).then(res, rej),
  };
  return q;
};
const popHolding = (h, pops) => {
  if (pops.includes('asset')) h.asset = clone(kinds.find((k) => k._id === idStr(h.asset))) || h.asset;
  if (pops.includes('employee')) h.employee = clone(people[idStr(h.employee)]) || h.employee;
};

stub('models/Asset.js', Object.assign({
  find: (f = {}) => chain(() => kinds.filter((k) => !f._id || inList(f._id, k._id))),
  findById: (id) => chain(() => kinds.find((k) => k._id === idStr(id)) || null),
}, { ASSET_CATEGORIES: [], ASSET_STATUS: ['Available', 'Assigned', 'InRepair', 'Retired'] }));
stub('models/AssetAssignment.js', {
  insertMany: async (docs) => docs.map((d) => {
    const row = { ...clone(d), _id: `h${(n += 1)}`, createdAt: new Date().toISOString() };
    holdings.push(row);
    return row;
  }),
  find: (f = {}) => chain(() => holdings.filter((h) => (!f._id || inList(f._id, h._id))
    && (!f.asset || inList(f.asset, h.asset))
    && (!('returnedAt' in f) || !h.returnedAt)), popHolding),
});
stub('models/User.js', { exists: async (f) => (people[idStr(f._id)] ? { _id: f._id } : null) });
stub('utils/employeeScope.js', {
  // "outsider" stands in for somebody behind another company's wall.
  cannotSeeUser: async (req, id) => id === 'outsider',
  scopeUserField: async (req, f) => f,
  scopeUserFilter: async (req, f) => f,
});
stub('services/notify.js', { notify: async () => {}, notifyMany: async () => {} });
stub('services/audience.js', { usersHoldingAny: async () => [], scopeRecipientsToCompany: async (ids) => ids });

const ctrl = require(path.join(BACKEND, 'controllers/assetController.js'));

async function call(handler, { params = {}, body = {}, query = {} } = {}) {
  const req = { user: { _id: 'hr1', role: 'HRManager' }, params, body, query };
  const out = { status: 200, body: null };
  const res = { status(c) { out.status = c; return this; }, json(d) { out.body = d; return this; } };
  await new Promise((done) => {
    const next = (err) => { if (err) { out.status = err.status || (out.status === 200 ? 500 : out.status); out.error = err.message; } done(); };
    Promise.resolve(handler(req, res, next)).then(() => done(), next);
  });
  return out;
}

(async () => {
  console.log('\n--- several assets to one employee, in one go ---');
  let r = await call(ctrl.issueToEmployee, {
    params: { userId: 'u1' },
    body: {
      date: '2026-09-24',
      note: 'joining kit',
      assignments: [
        { assetId: 'a-laptop', details: 'MacBook i5', serialNumber: 'C02X1' },
        { assetId: 'a-phone', details: 'Samsung A15' },
        { assetId: 'a-sim', details: 'Jio 98xxxx', unitTag: 'sim-7' },
      ],
    },
  });
  check('created (201)', r.status, 201);
  check('three items, all for Priya', r.body.assignments.map((a) => [a.asset.name, a.employee.firstName]),
    [['Laptop', 'Priya'], ['Phone', 'Priya'], ['SIM', 'Priya']]);
  check('each with its own details', r.body.assignments.map((a) => a.details), ['MacBook i5', 'Samsung A15', 'Jio 98xxxx']);
  check('the shared note and date on every row', r.body.assignments.map((a) => [a.note, a.assignedAt.slice(0, 10)]),
    [['joining kit', '2026-09-24'], ['joining kit', '2026-09-24'], ['joining kit', '2026-09-24']]);
  check('the sticker and serial ride along', [holdings[0].serialNumber, holdings[2].unitTag], ['C02X1', 'sim-7']);

  console.log('\n--- the asset-wise view sees them: one register, two readings ---');
  r = await call(ctrl.listAssets, { query: {} });
  const laptop = r.body.assets.find((a) => a.name === 'Laptop');
  check('Priya is on the Laptop card', laptop.holdings.map((h) => [h.employee.firstName, h.details]), [['Priya', 'MacBook i5']]);
  r = await call(ctrl.issueAsset, { params: { id: 'a-laptop' }, body: { assignments: [{ userId: 'u2', details: 'Asus i7' }] } });
  check('issuing from the asset side still works', r.status, 201);
  r = await call(ctrl.listAssets, { query: {} });
  check('and both holders are on the card', r.body.assets.find((a) => a.name === 'Laptop').holderCount, 2);
  const priyaItems = holdings.filter((h) => h.employee === 'u1').map((h) => h.asset);
  check('Priya holds exactly what was issued to her', priyaItems, ['a-laptop', 'a-phone', 'a-sim']);

  console.log('\n--- what is refused ---');
  r = await call(ctrl.issueToEmployee, { params: { userId: 'u1' }, body: { assignments: [] } });
  check('no rows', [r.status, r.error], [400, 'Add at least one asset.']);
  r = await call(ctrl.issueToEmployee, { params: { userId: 'u1' }, body: { assignments: [{ assetId: 'a-sim' }, { assetId: 'a-old' }] } });
  check('a Retired asset names its row', r.status, 400);
  check('…and says why', /^Row 2: "Old desktop" is marked Retired/.test(r.error), true);
  r = await call(ctrl.issueToEmployee, { params: { userId: 'u1' }, body: { assignments: [{ assetId: 'a-gone' }] } });
  check('an asset that no longer exists', [r.status, r.error], [404, 'Row 1: that asset no longer exists.']);
  r = await call(ctrl.issueToEmployee, { params: { userId: 'u1' }, body: { assignments: [{ details: 'x' }] } });
  check('a row with no asset', [r.status, r.error], [400, 'Row 1: pick an asset.']);
  r = await call(ctrl.issueToEmployee, { params: { userId: 'outsider' }, body: { assignments: [{ assetId: 'a-sim' }] } });
  check('somebody behind the company wall reads as not found', r.status, 404);
  r = await call(ctrl.issueToEmployee, { params: { userId: 'nobody' }, body: { assignments: [{ assetId: 'a-sim' }] } });
  check('an unknown person too', r.status, 404);
  const before = holdings.length;
  r = await call(ctrl.issueToEmployee, { params: { userId: 'u1' }, body: { assignments: [{ assetId: 'a-sim' }, { assetId: 'a-sim', date: 'not-a-date' }] } });
  check('one bad row writes nothing at all', [r.status, holdings.length], [400, before]);
  r = await call(ctrl.issueToEmployee, { params: { userId: 'u1' }, body: { assignments: [{ assetId: 'a-sim' }, { assetId: 'a-sim' }] } });
  check('the same asset twice is allowed (two SIMs)', [r.status, r.body.assignments.length], [201, 2]);

  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
