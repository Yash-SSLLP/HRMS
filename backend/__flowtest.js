const BASE = 'http://127.0.0.1:5099/api';
const login = async (email) => (await (await fetch(`${BASE}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password:'123'})})).json()).token;
const call = async (tok, method, path, body) => {
  const r = await fetch(`${BASE}${path}`,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${tok}`},body:body?JSON.stringify(body):undefined});
  let j=null; try{j=await r.json()}catch{} return {status:r.status, body:j};
};
const line=(l,ok,d='')=>console.log(`  ${ok?'PASS':'FAIL'}  ${l.padEnd(56)} ${d}`);
const notifTitles = async (tok) => ((await call(tok,'GET','/notifications')).body?.notifications||[]).map(n=>n.title);

(async () => {
  const admin=await login('admin@ss.com');
  const emps=(await call(admin,'GET','/employees')).body.profiles;
  const by=n=>emps.find(p=>`${p.user.firstName} ${p.user.lastName}`===n);
  const uid=n=>String(by(n).user._id);
  const subhaan=by('Mohd Subhaan'), kavya=by('Kavya Iyer');

  // Configure a ladder that is deliberately NOT the org chart: Reena (HR) then CEO.
  // Subhaan's manager walk would be Arun -> Piyush -> Piyus.
  await call(admin,'PUT',`/employees/${subhaan._id}`,{ leaveApprovers:[uid('Reena Angel'), uid('Piyus Lunia')], leaveFinalHrRecipients:[uid('Nisha Rao')] });
  await call(admin,'PUT',`/employees/${kavya._id}`,{ leaveApprovers:[] });   // unconfigured -> must fall back

  const emp=await login('emp@ss.com');
  const apply = async (tok, d1, d2) => call(tok,'POST','/leave/me/requests',{ leaveType:'Paid Leave', startDate:d1, endDate:d2, totalDays:1, reason:'test' });

  console.log('\n--- CONFIGURED ladder overrides the manager walk ---');
  let r = await apply(emp,'2026-09-14','2026-09-14');
  if (r.status !== 201) { console.log('  apply failed:', r.status, JSON.stringify(r.body).slice(0,300)); process.exit(1); }
  let chain = r.body.request.approvalChain.map(s=>s.approverName);
  line('chain is the configured list, not reportingManager', JSON.stringify(chain)===JSON.stringify(['Reena Angel','Piyus Lunia']), JSON.stringify(chain));
  line('first rung Pending, rest Waiting', r.body.request.approvalChain[0].status==='Pending' && r.body.request.approvalChain[1].status==='Waiting');
  const reqId = r.body.request._id;

  let t = await notifTitles(emp);
  line('employee notified at SUBMIT (step 1 of 2)', t.some(x=>/submitted.*step 1 of 2/i.test(x)), t[0]||'');

  console.log('\n--- climbing the ladder ---');
  const reena=await login('hr@ss.com'), ceo=await login('ceo@ss.com');
  let a = await call(reena,'PATCH',`/approvals/leave/${reqId}/approve`,{});
  line('step 1 approver can approve', a.status===200, `status ${a.status}`);
  t = await notifTitles(emp);
  line('employee notified after step 1', t.some(x=>/approved at step 1 of 2/i.test(x)), t[0]||'');

  const wrong = await call(reena,'PATCH',`/approvals/leave/${reqId}/approve`,{});
  line('same approver cannot approve twice', wrong.status!==200, `status ${wrong.status}`);

  a = await call(ceo,'PATCH',`/approvals/leave/${reqId}/approve`,{});
  line('final approver approves', a.status===200, `status ${a.status}`);

  const fin=(await call(admin,'GET',`/leave/requests?status=Approved`)).body;
  const done=(fin.requests||[]).find(x=>String(x._id)===String(reqId));
  line('request is Approved with no currentApprover', done?.status==='Approved' && !done?.currentApprover, `status ${done?.status}`);

  console.log('\n--- final-approval notice goes to the CONFIGURED HR only ---');
  const nisha=await login('hr2@ss.com');
  const nishaT=await notifTitles(nisha), reenaT=await notifTitles(reena);
  line('configured HR (Nisha) got "Leave fully approved"', nishaT.some(x=>/fully approved/i.test(x)), JSON.stringify(nishaT.slice(0,2)));
  const nishaBody=((await call(nisha,'GET','/notifications')).body.notifications||[]).find(n=>/fully approved/i.test(n.title));
  line('notice carries the detail (name/type/days)', !!nishaBody && /Subhaan/.test(nishaBody.body) && /Paid Leave/.test(nishaBody.body), (nishaBody?.body||'').slice(0,110));

  console.log('\n--- UNCONFIGURED employee still uses the manager walk ---');
  const kav=await login('other@ss.com');
  r = await apply(kav,'2026-09-15','2026-09-15');
  chain = (r.body.request?.approvalChain||[]).map(s=>s.approverName);
  line('falls back to reportingManager chain', r.status===201 && chain.length>0 && chain[0]==='Piyush Kumar', JSON.stringify(chain));
  process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
