/**
 * Org chart — how one branch is laid out, and arranging it. No database.
 *
 *   npm run test:org-order
 *
 * Stubs the models into `require.cache` and runs the REAL handlers, the same way
 * testOrgChart.js does (and for the same reason: `MONGO_URI` here points at the
 * live cluster).
 *
 * WHAT IS BEING PINNED. Rules that are easy to break from opposite ends. The
 * DEFAULT layout — CEO at the left end of the top row, MD at the right, then the
 * people with no department, then by name — is what a chart nobody has touched
 * must look like. An ARRANGED branch must beat that default outright, including
 * for the executives, or a SuperAdmin's arrangement silently reverts the next
 * time the page is opened. Two cases bite quietly: somebody who joins an
 * already-arranged branch has no position and must land BEHIND the arranged
 * cards rather than in front of them, and somebody given a NEW MANAGER must
 * arrive with no position at all — a place earned in one team means nothing in
 * another, and carrying the number across would drop them at an arbitrary spot
 * in a branch they have never been in.
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

// Four people all reporting to the CEO, plus a second top-level card (the MD).
let PROFILES = [];
let EXECS = [];
let WROTE = null;

stub('models/EmployeeProfile.js', {
  find: () => {
    const chain = { select: () => chain, populate: () => chain, lean: async () => PROFILES };
    return chain;
  },
});
stub('models/User.js', {
  find: () => ({ select: () => ({ lean: async () => EXECS }), distinct: async () => [] }),
  bulkWrite: async (ops) => { WROTE = ops.map((o) => [String(o.updateOne.filter._id), o.updateOne.update['$set'].orgChartOrder]); },
});
stub('models/Company.js', {
  find: () => ({ select: () => ({ sort: () => ({ lean: async () => [] }) }) }),
});
stub('utils/visibility.js', { hiddenUserIds: async () => [], EXECUTIVE_ROLES: ['CEO', 'MD'] });

const { orgChart, setChartOrder } = require(path.join(BACKEND, 'controllers/orgController.js'));

const user = (id, first, role = 'Employee', orgChartOrder = null) => ({
  _id: id, firstName: first, lastName: 'X', photo: null, role, orgChartOrder,
});
/** A position, stamped with the branch it was given for. */
const at = (branch, index) => ({ branch, index });

async function run() {
  let payload = null;
  const res = { status() { return this; }, json(d) { payload = d; } };
  await orgChart({ user: { _id: 'sa', role: 'SuperAdmin' }, query: {} }, res, (e) => { throw e; });
  return payload;
}

/** [top row names] and, for the CEO, [its reports' names]. */
const shape = (p) => ({
  top: p.roots.map((n) => n.name.split(' ')[0]),
  under: (p.roots.find((n) => n.role === 'CEO')?.reports || []).map((n) => n.name.split(' ')[0]),
});

(async () => {
  // Zed / Ann / Bob report to the CEO. Zed has no department.
  const team = [
    ['p1', 'u1', 'Zed', ''],
    ['p2', 'u2', 'Ann', 'Sales'],
    ['p3', 'u3', 'Bob', 'Sales'],
  ];
  PROFILES = team.map(([pid, uid, name, dept]) => ({
    _id: pid, designation: '', department: dept, company: null,
    reportingManager: 'ceo', user: user(uid, name),
  }));
  EXECS = [user('ceo', 'Cee', 'CEO'), user('md', 'Emm', 'MD')];

  console.log('\n--- the default layout ---');
  let p = await run();
  check('CEO at the left end, MD at the right', shape(p).top, ['Cee', 'Emm']);
  check('no department first, then by name', shape(p).under, ['Zed', 'Ann', 'Bob']);

  console.log('\n--- an arranged branch keeps its arrangement ---');
  // Bob 0, Ann 1, Zed 2 under the CEO — the exact reverse of the default.
  PROFILES[0].user.orgChartOrder = at('ceo', 2);
  PROFILES[1].user.orgChartOrder = at('ceo', 1);
  PROFILES[2].user.orgChartOrder = at('ceo', 0);
  p = await run();
  check('drawn in the arranged order', shape(p).under, ['Bob', 'Ann', 'Zed']);

  console.log('\n--- MD moved to the left end of the top row ---');
  // The top row's branch is null — nobody manages it.
  EXECS = [user('ceo', 'Cee', 'CEO', at(null, 1)), user('md', 'Emm', 'MD', at(null, 0))];
  p = await run();
  check('the arrangement beats the CEO/MD default', shape(p).top, ['Emm', 'Cee']);

  console.log('\n--- a newcomer to an arranged branch lands last ---');
  PROFILES.push({
    _id: 'p4', designation: '', department: 'Sales', company: null,
    reportingManager: 'ceo', user: user('u4', 'New'),
  });
  p = await run();
  check('behind everyone already placed', shape(p).under, ['Bob', 'Ann', 'Zed', 'New']);

  console.log('\n--- a position does not follow somebody to a new manager ---');
  // THE BUG THIS GUARDS: Ann's place was 1 among the CEO's reports. Moved under
  // Bob, that number must mean nothing — otherwise she arrives in a team she has
  // never been in already holding a place in it.
  PROFILES[1].reportingManager = 'u3';
  p = await run();
  const find = (nodes, first) => {
    for (const n of nodes) {
      if (n.name.startsWith(first)) return n;
      const hit = find(n.reports || [], first);
      if (hit) return hit;
    }
    return null;
  };
  const bob = find(p.roots, 'Bob');
  check('she is under her new manager', (bob.reports || []).map((n) => n.name.split(' ')[0]), ['Ann']);
  check('and her old place is dropped', bob.reports[0].order, null);
  PROFILES[1].reportingManager = 'ceo';

  console.log('\n--- PUT /chart/order ---');
  const ids = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012'];
  const boss = '507f1f77bcf86cd7994390ff';
  let body = null;
  const res2 = { status() { return this; }, json(d) { body = d; } };
  await setChartOrder({ body: { branch: boss, order: ids } }, res2, (e) => { throw e; });
  check('every card gets a position, stamped with its branch',
    WROTE, [[ids[0], { branch: boss, index: 0 }], [ids[1], { branch: boss, index: 1 }]]);
  check('and the saved branch comes back', body, { branch: boss, order: ids });

  await setChartOrder({ body: { order: ids } }, { status() { return this; }, json() {} }, (e) => { throw e; });
  check('no branch means the top row', WROTE[0][1], { branch: null, index: 0 });

  const bad = async (payload, why) => {
    const r = { status() { return this; }, json() {} };
    try {
      await setChartOrder({ body: payload }, r, (e) => { throw e; });
      check(why, 'accepted', 'rejected');
    } catch (e) {
      check(why, 'rejected', 'rejected');
    }
  };
  await bad({ order: [] }, 'an empty branch is refused');
  await bad({ order: ['nope'] }, 'a junk id is refused');
  await bad({ order: [ids[0], ids[0]] }, 'the same person twice is refused');
  await bad({ branch: 'nope', order: ids }, 'a junk branch is refused, not read as the top row');

  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error('\nThrew:\n', err); process.exit(1); });
