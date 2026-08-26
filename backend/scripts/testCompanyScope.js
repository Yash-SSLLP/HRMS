/**
 * Direct assertions on utils/employeeScope's company wall — no DB, no server.
 * Models are monkey-patched where a lookup is involved. Run:
 *   node scripts/testCompanyScope.js
 */
const assert = require('assert');
const scope = require('../utils/employeeScope');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');

const A = '64a000000000000000000001'; // company A
const B = '64a000000000000000000002'; // company B
const me = '64b000000000000000000001';

const req = (user) => ({ user });
// companyScopeFilter emits real ObjectIds (aggregate $match does not cast);
// compare by string form.
const inList = (filter) => (filter.company ? filter.company.$in.map((x) => (x === null ? null : String(x))) : null);

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

// ---- viewerCompanyScope / companyScopeFilter (sync) ----
ok('SuperAdmin unrestricted', () => {
  assert.strictEqual(scope.viewerCompanyScope(req({ role: 'SuperAdmin' })), null);
  assert.deepStrictEqual(scope.companyScopeFilter(req({ role: 'SuperAdmin' })), {});
});

ok('exec with no companies unrestricted', () => {
  assert.strictEqual(scope.viewerCompanyScope(req({ role: 'CEO', companies: [] })), null);
  assert.strictEqual(scope.viewerCompanyScope(req({ role: 'MD' })), null);
});

ok('narrowed exec limited to list, no unassigned', () => {
  const s = scope.viewerCompanyScope(req({ role: 'CEO', companies: [A] }));
  assert.deepStrictEqual(s, { ids: [A], includeUnassigned: false });
  assert.deepStrictEqual(inList(scope.companyScopeFilter(req({ role: 'CEO', companies: [A] }))), [A]);
});

ok('HR with own company walled in (plus unassigned)', () => {
  const s = scope.viewerCompanyScope(req({ role: 'HRManager', _id: me, scopeCompanyId: A }));
  assert.deepStrictEqual(s, { ids: [A], includeUnassigned: true });
  const f = scope.employeeProfileScope(req({ role: 'HRManager', _id: me, scopeCompanyId: A }));
  assert.strictEqual(String(f.hrPartner), me);
  assert.deepStrictEqual(inList(f), [A, null]);
});

ok('HR with no own company keeps hrPartner-only scope', () => {
  const f = scope.employeeProfileScope(req({ role: 'HRManager', _id: me }));
  assert.deepStrictEqual(Object.keys(f), ['hrPartner']);
});

ok('Employee / Manager / LDManager / AccountsManager walled to own company', () => {
  for (const role of ['Employee', 'Manager', 'LDManager', 'AccountsManager']) {
    const f = scope.employeeProfileScope(req({ role, _id: me, scopeCompanyId: A }));
    assert.deepStrictEqual(inList(f), [A, null], role);
    assert.deepStrictEqual(scope.employeeProfileScope(req({ role, _id: me })), {}, `${role} unassigned`);
  }
});

// ---- companyOutOfScope / cannotManageProfile ----
ok('cannotManageProfile: HR blocked outside own company even when hrPartner matches', () => {
  const u = { role: 'HRManager', _id: me, scopeCompanyId: A };
  assert.strictEqual(scope.cannotManageProfile(req(u), { hrPartner: me, company: A }), false);
  assert.strictEqual(scope.cannotManageProfile(req(u), { hrPartner: me, company: null }), false);
  assert.strictEqual(scope.cannotManageProfile(req(u), { hrPartner: me, company: B }), true);
  assert.strictEqual(scope.cannotManageProfile(req(u), { hrPartner: 'someoneelse', company: A }), true);
});

ok('cannotManageProfile: narrowed exec blocked outside list and on unassigned', () => {
  const u = { role: 'MD', companies: [A] };
  assert.strictEqual(scope.cannotManageProfile(req(u), { company: A }), false);
  assert.strictEqual(scope.cannotManageProfile(req(u), { company: B }), true);
  assert.strictEqual(scope.cannotManageProfile(req(u), { company: null }), true);
});

ok('cannotManageProfile: populated company doc handled', () => {
  const u = { role: 'Employee', scopeCompanyId: A };
  assert.strictEqual(scope.cannotManageProfile(req(u), { company: { _id: A, name: 'A' } }), false);
  assert.strictEqual(scope.cannotManageProfile(req(u), { company: { _id: B, name: 'B' } }), true);
});

// ---- allowedUserIds / scopeUserFilter (patched models) ----
const origProfFind = EmployeeProfile.find;
const origUserFind = User.find;
EmployeeProfile.find = (filter) => ({
  select: () => ({
    lean: async () => {
      // company-A profiles: u1; unassigned: u2; company-B: u3
      const rows = [
        { user: 'u1', company: A },
        { user: 'u2', company: null },
        { user: 'u3', company: B },
      ];
      const allowed = filter.company && filter.company.$in
        ? rows.filter((r) => filter.company.$in.some((c) => String(c) === String(r.company)) || (filter.company.$in.includes(null) && !r.company))
        : rows;
      return allowed.map((r) => ({ user: r.user }));
    },
  }),
});
const STUB_USERS = [
  { _id: 'sa1', role: 'SuperAdmin' },
  { _id: 'ceoAll', role: 'CEO', companies: [] },
  { _id: 'ceoB', role: 'CEO', companies: [B] },
  { _id: 'mdA', role: 'MD', companies: [A] },
  { _id: 'noProf', role: 'AccountsManager' }, // account with no EmployeeProfile
];
User.find = (filter = {}) => ({
  select: () => ({
    lean: async () => STUB_USERS.filter((u) => {
      const r = filter.role;
      if (!r) return true;
      if (r.$in) return r.$in.includes(u.role);
      if (r.$nin) return !r.$nin.includes(u.role);
      return u.role === r;
    }),
  }),
});

(async () => {
  const employeeReq = req({ role: 'Employee', _id: me, scopeCompanyId: A });

  const ids = await scope.allowedUserIds(employeeReq);
  assert(ids.includes('u1'), 'same-company user visible');
  assert(ids.includes('u2'), 'unassigned user visible');
  assert(!ids.includes('u3'), 'other-company user hidden');
  assert(ids.includes('ceoAll'), 'group-wide exec visible');
  assert(ids.includes('mdA'), 'company-A exec visible');
  assert(!ids.includes('ceoB'), 'company-B-only exec hidden');
  assert(ids.includes('sa1'), 'SuperAdmin passes wall (hidden separately)');
  assert(ids.includes('noProf'), 'profile-less non-exec account visible (belongs to no company)');
  passed += 1; console.log('  ok - allowedUserIds walls users by company');

  assert.strictEqual(await scope.allowedUserIds(req({ role: 'SuperAdmin' })), null);
  passed += 1; console.log('  ok - allowedUserIds unrestricted for Backend');

  // scopeUserFilter: string _id kept / dropped
  const f1 = await scope.scopeUserFilter(employeeReq, { _id: 'u1' });
  assert.strictEqual(f1._id, 'u1');
  const f2 = await scope.scopeUserFilter(employeeReq, { _id: 'u3' });
  assert.deepStrictEqual(f2._id, { $in: [] });
  // $in intersection
  const f3 = await scope.scopeUserFilter(employeeReq, { _id: { $in: ['u1', 'u3', 'ceoB'] } });
  assert.deepStrictEqual(f3._id.$in, ['u1']);
  // $ne style constraint gains $in
  const f4 = await scope.scopeUserFilter(employeeReq, { _id: { $ne: 'u9' } });
  assert(Array.isArray(f4._id.$in) && f4._id.$ne === 'u9');
  passed += 1; console.log('  ok - scopeUserFilter honours existing _id constraints');

  EmployeeProfile.find = origProfFind;
  User.find = origUserFind;
  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
