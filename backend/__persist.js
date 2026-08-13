const BASE='http://127.0.0.1:5099/api';
(async()=>{
  const tok=(await(await fetch(`${BASE}/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'admin@ss.com',password:'123'})})).json()).token;
  const emps=(await(await fetch(`${BASE}/employees`,{headers:{Authorization:`Bearer ${tok}`}})).json()).profiles;
  const users=(await(await fetch(`${BASE}/admin/users`,{headers:{Authorization:`Bearer ${tok}`}})).json()).users;
  const name=id=>{const u=users.find(u=>String(u._id)===String(id));return u?`${u.firstName} ${u.lastName}`:id;};
  console.log('persisted state (read back from the API):');
  for (const p of emps.sort((a,b)=>a.employeeCode.localeCompare(b.employeeCode))) {
    const ladder=(p.leaveApprovers||[]).map(a=>name(a?._id||a));
    const hr=(p.leaveFinalHrRecipients||[]).map(a=>name(a?._id||a));
    if (ladder.length || hr.length)
      console.log(`  ${p.employeeCode} ${`${p.user.firstName} ${p.user.lastName}`.padEnd(15)} ladder=[${ladder.join(' -> ')}]  hrNotified=[${hr.join(', ')}]`);
  }
  process.exit(0);
})();
