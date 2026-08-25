/**
 * Org chart — company filtering and executive scoping. No database.
 *
 *   npm run test:org
 *
 * Stubs the models into `require.cache` and runs the REAL orgChart handler, the
 * same way testEmployeeImport.js does (and for the same reason: `MONGO_URI`
 * here points at the live cluster).
 *
 * WHAT IS BEING PINNED. The chart is readable by every authenticated user, so
 * it cannot simply apply the employee scope — that would leave an HR Manager
 * with a tree of only their own assigned people. But a CEO/MD narrowed to
 * certain companies must never see another company's staff, which is exactly
 * what this endpoint used to allow: it filtered on `hiddenUserIds` alone while
 * the employee directory correctly refused them. The tests below hold both
 * halves of that at once.
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

// Two companies, and one person in each. Ids are 24-hex so isValid() passes.
const C1 = '000000000000000000000c01';
const C2 = '000000000000000000000c02';
const PROFILES = [
  {
    _id: 'p1', employeeCode: 'SSL 1', designation: 'BSM', department: 'Sales',
    company: { _id: C1, name: 'Company One' }, reportingManager: 'exec1',
    user: { _id: 'u1', firstName: 'Ann', lastName: 'One', photo: null, role: 'Employee' },
  },
  {
    _id: 'p2', employeeCode: 'SSL 2', designation: 'BDM', department: 'Sales',
    company: { _id: C2, name: 'Company Two' }, reportingManager: 'exec1',
    user: { _id: 'u2', firstName: 'Bob', lastName: 'Two', photo: null, role: 'Employee' },
  },
];
// One unrestricted exec (covers both) and one narrowed to Company Two.
const EXECS = [
  { _id: 'exec1', firstName: 'Eve', lastName: 'Exec', photo: null, role: 'CEO', companies: [] },
  { _id: 'exec2', firstName: 'Cal', lastName: 'Two', photo: null, role: 'MD', companies: [C2] },
];

let lastFilter = null;

const matches = (p, filter) => {
  if (filter.company === undefined) return true; // no company filter at all
  const cid = String(p.company?._id || '');
  const wanted = (filter.company.$in || []).map(String);
  return wanted.includes(cid); // an empty $in matches nobody, as in Mongo
};

stub('models/EmployeeProfile.js', {
  find: (filter) => {
    lastFilter = filter;
    const chain = {
      select: () => chain,
      populate: () => chain,
      lean: async () => PROFILES.filter((p) => matches(p, filter)),
    };
    return chain;
  },
});
stub('models/User.js', {
  ROLES: ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager', 'Employee'],
  find: () => ({ select: () => ({ lean: async () => EXECS }), distinct: async () => [] }),
});
stub('models/Company.js', {
  find: (q) => {
    const ids = q && q._id && q._id.$in ? q._id.$in.map(String) : null;
    const all = [{ _id: C1, name: 'Company One', code: 'C1' }, { _id: C2, name: 'Company Two', code: 'C2' }];
    const rows = ids ? all.filter((c) => ids.includes(String(c._id))) : all;
    return { select: () => ({ sort: () => ({ lean: async () => rows }) }) };
  },
});
stub('utils/visibility.js', { hiddenUserIds: async () => [], EXECUTIVE_ROLES: ['CEO', 'MD'] });

const { orgChart } = require(path.join(BACKEND, 'controllers/orgController.js'));

/** Run the handler and return its JSON plus a flat list of the names on it. */
async function run(user, query = {}) {
  let payload = null;
  const res = { status() { return this; }, json(d) { payload = d; } };
  await orgChart({ user, query }, res, (e) => { throw e; });
  const names = [];
  const walk = (ns) => ns.forEach((n) => { names.push(n.name); walk(n.reports || []); });
  walk(payload.roots);
  return { payload, names: names.sort() };
}

(async () => {
  console.log('\n--- everybody, every company, by default ---');
  let r = await run({ _id: 'sa', role: 'SuperAdmin' });
  check('the whole org', r.names, ['Ann One', 'Bob Two', 'Cal Two', 'Eve Exec']);
  check('no company filter applied', lastFilter.company, undefined);
  check('both companies offered in the dropdown',
    r.payload.companies.map((c) => c.name), ['Company One', 'Company Two']);
  check('nodes carry their company',
    r.payload.roots.flatMap((n) => (n.reports || []).map((c) => c.companyName)).sort(),
    ['Company One', 'Company Two']);

  console.log('\n--- ?company= narrows it ---');
  r = await run({ _id: 'sa', role: 'SuperAdmin' }, { company: C2 });
  check('only that company, plus execs covering it', r.names, ['Bob Two', 'Cal Two', 'Eve Exec']);
  check('an exec of the OTHER company is left out', r.names.includes('Cal Two') && !r.names.includes('Ann One'), true);
  check('the filter reached the query', lastFilter.company, { $in: [C2] });

  console.log('\n--- a narrowed executive cannot see past their own companies ---');
  // Cal is limited to Company Two.
  r = await run({ _id: 'exec2', role: 'MD', companies: [C2] });
  check('their default view is already narrowed', r.names.includes('Ann One'), false);
  check('and shows their own company', r.names.includes('Bob Two'), true);
  check('the dropdown offers only their company',
    r.payload.companies.map((c) => c.name), ['Company Two']);

  console.log('\n--- ...and cannot widen it by asking for another ---');
  r = await run({ _id: 'exec2', role: 'MD', companies: [C2] }, { company: C1 });
  check('asking for a company they do not hold returns nobody else', r.names.includes('Ann One'), false);

  console.log('\n--- an HR Manager still gets the whole tree ---');
  // The bug this guards: applying the employee scope here would leave HR with
  // only their own assigned people and a shattered hierarchy.
  r = await run({ _id: 'hr', role: 'HRManager' });
  check('unchanged for HR', r.names, ['Ann One', 'Bob Two', 'Cal Two', 'Eve Exec']);

  console.log('\n--- a junk ?company= is ignored, not obeyed ---');
  r = await run({ _id: 'sa', role: 'SuperAdmin' }, { company: 'not-an-id' });
  check('falls back to everybody', r.names, ['Ann One', 'Bob Two', 'Cal Two', 'Eve Exec']);

  console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('\nThe handler threw:\n', err);
  process.exit(1);
});
