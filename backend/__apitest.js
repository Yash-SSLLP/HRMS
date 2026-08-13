const BASE = 'http://127.0.0.1:5099/api';
const login = async (email, password='123') => {
  const r = await fetch(`${BASE}/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({email,password}) });
  const j = await r.json(); return j.token;
};
const call = async (tok, method, path, body) => {
  const r = await fetch(`${BASE}${path}`, { method, headers:{'Content-Type':'application/json', Authorization:`Bearer ${tok}`}, body: body?JSON.stringify(body):undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};
const line = (label, ok, detail='') => console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(58)} ${detail}`);

(async () => {
  const admin = await login('admin@ss.com');
  const hr = await login('hr@ss.com');
  const { body: emps } = await call(admin, 'GET', '/employees');
  const by = (n) => emps.profiles.find(p => `${p.user.firstName} ${p.user.lastName}` === n);
  const uid = (n) => String(by(n).user._id);
  const subhaan = by('Mohd Subhaan');

  console.log('\n--- leaveApprovers: happy path ---');
  let r = await call(admin, 'PUT', `/employees/${subhaan._id}`, { leaveApprovers: [uid('Arun Shetty'), uid('Piyush Kumar'), uid('Piyus Lunia')] });
  line('SuperAdmin saves a 3-step ladder', r.status === 200 && r.body.profile.leaveApprovers?.length === 3, `status ${r.status}, saved ${r.body.profile?.leaveApprovers?.length}`);

  r = await call(admin, 'PUT', `/employees/${subhaan._id}`, { leaveApprovers: [uid('Arun Shetty'), uid('Piyush Kumar'), uid('Piyus Lunia'), uid('Reena Angel')] });
  line('4 steps accepted (the documented maximum)', r.status === 200 && r.body.profile.leaveApprovers?.length === 4, `status ${r.status}`);

  console.log('\n--- leaveApprovers: validation ---');
  r = await call(admin, 'PUT', `/employees/${subhaan._id}`, { leaveApprovers: [uid('Arun Shetty'), uid('Piyush Kumar'), uid('Piyus Lunia'), uid('Reena Angel'), uid('Nisha Rao')] });
  line('5 steps rejected', r.status === 400, `${r.status} "${r.body?.message||''}"`);

  r = await call(admin, 'PUT', `/employees/${subhaan._id}`, { leaveApprovers: [uid('Mohd Subhaan')] });
  line('self-approval rejected', r.status === 400, `${r.status} "${r.body?.message||''}"`);

  r = await call(admin, 'PUT', `/employees/${subhaan._id}`, { leaveApprovers: [uid('Arun Shetty'), uid('Arun Shetty')] });
  line('duplicate approver rejected', r.status === 400, `${r.status} "${r.body?.message||''}"`);

  console.log('\n--- leaveFinalHrRecipients ---');
  r = await call(admin, 'PUT', `/employees/${subhaan._id}`, { leaveFinalHrRecipients: [uid('Reena Angel'), uid('Nisha Rao')] });
  line('two HRManagers accepted', r.status === 200 && r.body.profile.leaveFinalHrRecipients?.length === 2, `status ${r.status}`);

  r = await call(admin, 'PUT', `/employees/${subhaan._id}`, { leaveFinalHrRecipients: [uid('Arun Shetty')] });
  line('non-HR rejected', r.status === 400, `${r.status} "${r.body?.message||''}"`);

  console.log('\n--- SuperAdmin-only enforcement ---');
  const before = (await call(admin, 'GET', `/employees`)).body.profiles.find(p=>p._id===subhaan._id).leaveApprovers.length;
  r = await call(hr, 'PUT', `/employees/${subhaan._id}`, { leaveApprovers: [uid('Nisha Rao')] });
  const after = (await call(admin, 'GET', `/employees`)).body.profiles.find(p=>p._id===subhaan._id).leaveApprovers.length;
  line('HRManager cannot change the ladder (stripped)', before === after, `steps ${before} -> ${after} (req status ${r.status})`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
