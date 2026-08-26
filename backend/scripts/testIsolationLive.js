/**
 * Live end-to-end check of the company wall against the running local API.
 *
 * Fully reversible by design: it creates two throwaway companies, briefly
 * moves two existing employees into them (remembering each one's current
 * company), reads a handful of GET endpoints as each side of the wall, then
 * moves both back into exactly the company they came from (or unset) and
 * deletes the throwaway companies. Everything goes through the HTTP API; the
 * walled sessions are short-lived tokens minted with the local JWT secret and
 * used for READS plus two deliberately-refused writes.
 *
 * Run while the backend dev server is up:  node scripts/testIsolationLive.js
 */
require('dotenv').config();
const jwt = require('jsonwebtoken');

const API = process.env.TEST_API || 'http://localhost:5000/api';
const ADMIN = { email: process.env.SEED_ADMIN_EMAIL || 'admin@ss.com', password: process.env.SEED_ADMIN_PASSWORD || '123' };

let pass = 0; let fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass += 1; console.log(`  ok - ${name}`); }
  else { fail += 1; console.log(`  FAIL - ${name} ${extra}`); }
};

async function req(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, data };
}

// Most accounts have never had a password change, so tokenVersion 0 is the
// norm; a minted token is validated against /auth/me and the employee skipped
// if it does not stick.
const mint = (userId) => jwt.sign({ id: String(userId), role: 'Employee', tokenVersion: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' });

(async () => {
  const login = await req('POST', '/auth/login', null, ADMIN);
  if (login.status !== 200) { console.error('Cannot log in as the seed SuperAdmin — aborting, nothing was changed.', login.status, login.data); process.exit(1); }
  const admin = login.data.token;

  // Pick two active plain employees via the API, remembering their company.
  const emp = await req('GET', '/employees', admin);
  const rows = (emp.data?.profiles || emp.data?.employees || []).filter((p) => p.user
    && p.user.isActive !== false && p.user.role === 'Employee');
  const withTok = [];
  for (const p of rows) {
    if (withTok.length >= 2) break;
    const t = mint(p.user._id);
    const me = await req('GET', '/auth/me', t);
    if (me.status === 200) withTok.push({ p, t });
  }
  if (withTok.length < 2) { console.error('Could not establish two walled sessions; aborting, nothing was changed.'); process.exit(1); }
  const [{ p: pa, t: tokA }, { p: pb, t: tokB }] = withTok;
  const orig = (p) => (p.company ? String(p.company._id || p.company) : null);
  const name = (p) => `${p.user.firstName} ${p.user.lastName || ''}`.trim();
  console.log(`Using ${name(pa)} (A, from ${orig(pa) || 'no company'}) and ${name(pb)} (B, from ${orig(pb) || 'no company'})`);

  let coA; let coB;
  try {
    coA = (await req('POST', '/companies', admin, { name: 'ZZ Wall Test A' })).data?.company;
    coB = (await req('POST', '/companies', admin, { name: 'ZZ Wall Test B' })).data?.company;
    if (!coA?._id || !coB?._id) throw new Error('company create failed');
    ok((await req('PATCH', `/companies/${coA._id}/employees`, admin, { add: [pa._id] })).status === 200, 'tag employee A into company A');
    ok((await req('PATCH', `/companies/${coB._id}/employees`, admin, { add: [pb._id] })).status === 200, 'tag employee B into company B');

    // --- Employee A's view of the world ---
    const chart = await req('GET', '/org/chart', tokA);
    const flat = JSON.stringify(chart.data);
    ok(chart.status === 200, 'org chart loads for A', String(chart.status));
    ok(!flat.includes(name(pb)), 'org chart hides company B person from A');
    ok(flat.includes(name(pa)), 'org chart still shows A themself');
    const chartCos = (chart.data?.companies || []).map((c) => c.name);
    ok(chartCos.includes('ZZ Wall Test A') && !chartCos.includes('ZZ Wall Test B'), 'org chart company dropdown walled', JSON.stringify(chartCos));

    const dir = await req('GET', '/chat/directory', tokA);
    const dirNames = (dir.data?.people || []).map((x) => x.fullName);
    ok(dir.status === 200 && !dirNames.includes(name(pb)), 'chat directory hides B from A');

    const up = await req('GET', '/celebrations/upcoming?months=6', tokA);
    ok(up.status === 200 && !JSON.stringify(up.data).includes(name(pb)), 'celebrations hide B from A');

    const cos = await req('GET', '/companies', tokA);
    const cosNames = (cos.data?.companies || []).map((c) => c.name);
    ok(cos.status === 200 && cosNames.includes('ZZ Wall Test A') && !cosNames.includes('ZZ Wall Test B'), 'company list walled for A', JSON.stringify(cosNames));

    ok((await req('GET', `/companies/${coB._id}/employees`, tokA)).status === 403, 'company roster is Backend-only (403 for employee)');

    const wish = await req('POST', '/celebrations/wish', tokA, { employeeId: pb._id, type: 'birthday' });
    ok(wish.status === 404, 'cannot wish across the wall (404)', String(wish.status));

    const connect = await req('POST', '/chat/requests', tokA, { recipientId: pb.user._id });
    // When the org has chat switched off, the module gate 403s before the wall
    // can answer — that still proves the request cannot cross, so accept both.
    const chatOff = connect.status === 403 && /switched off/i.test(connect.data?.message || '');
    ok(connect.status === 404 || chatOff,
      chatOff ? 'chat module is switched off (wall untestable here, request still refused)' : 'cannot start a chat across the wall (404)',
      `${connect.status} ${connect.data?.message || ''}`);

    // --- B's mirror view ---
    const chartB = await req('GET', '/org/chart', tokB);
    ok(chartB.status === 200 && !JSON.stringify(chartB.data).includes(name(pa)), 'org chart hides A from B');

    // --- The Backend still sees everything ---
    const chartAdmin = await req('GET', '/org/chart', admin);
    const adminFlat = JSON.stringify(chartAdmin.data);
    ok(adminFlat.includes(name(pa)) && adminFlat.includes(name(pb)), 'SuperAdmin org chart spans both companies');
    const cosAdmin = await req('GET', '/companies', admin);
    ok((cosAdmin.data?.companies || []).some((c) => c.name === 'ZZ Wall Test A')
      && (cosAdmin.data?.companies || []).some((c) => c.name === 'ZZ Wall Test B'), 'SuperAdmin sees all companies');
  } finally {
    // Put each person back exactly where they came from: add to their original
    // company (add = set), or remove ($unset) if they had none.
    const restore = async (p, testCo) => {
      const from = orig(p);
      if (from) return req('PATCH', `/companies/${from}/employees`, admin, { add: [p._id] });
      if (testCo?._id) return req('PATCH', `/companies/${testCo._id}/employees`, admin, { remove: [p._id] });
      return { status: 0 };
    };
    const rA = await restore(pa, coA);
    const rB = await restore(pb, coB);
    const dA = coA?._id ? await req('DELETE', `/companies/${coA._id}`, admin) : { status: 0 };
    const dB = coB?._id ? await req('DELETE', `/companies/${coB._id}`, admin) : { status: 0 };
    console.log(`cleanup: restored (${rA.status}/${rB.status}), deleted test companies (${dA.status}/${dB.status})`);
    const after = await req('GET', '/employees', admin);
    const rowsAfter = (after.data?.profiles || after.data?.employees || []);
    const ra = rowsAfter.find((x) => String(x._id) === String(pa._id));
    const rb = rowsAfter.find((x) => String(x._id) === String(pb._id));
    const back = (x, p) => String(x?.company?._id || x?.company || '') === String(orig(p) || '');
    ok(back(ra, pa) && back(rb, pb), 'both employees back in their original company',
      JSON.stringify({ a: ra?.company?._id || ra?.company, b: rb?.company?._id || rb?.company }));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
