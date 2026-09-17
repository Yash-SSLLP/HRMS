/**
 * End-to-end check of the task module against a real database (section 55).
 *
 *   TASK_TEST_MONGO_URI="mongodb://127.0.0.1:27017/hrms_task_test" node scripts/testTaskWorkflow.js
 *
 * WHY THE SEPARATE ENV VAR. This project's ordinary MONGO_URI points at the LIVE
 * Atlas cluster, and this script CREATES AND DELETES DATA. It therefore refuses
 * to run unless you name a throwaway database explicitly in
 * TASK_TEST_MONGO_URI, and refuses again if that value happens to match
 * MONGO_URI. Point it at a local mongod or a scratch Atlas database.
 *
 * What it proves, which the pure self-check (testTaskEngine.js) cannot:
 *   - the lifecycle actually runs: assigned → accepted → in progress →
 *     submitted → approved → completed, with the stamps the server made;
 *   - AN ILLEGAL MOVE IS REFUSED by the engine, not merely by the table;
 *   - TWO APPROVERS CANNOT BOTH WIN — the second is told the task has moved,
 *     rather than overwriting the first decision (section 52);
 *   - a rejection preserves the earlier submission and a resubmission is a NEW
 *     row with a higher attempt number (section 53);
 *   - a SEQUENTIAL workflow advances one step at a time;
 *   - a PARALLEL group waits for its join rule and then hands on;
 *   - a CONDITIONAL step takes the branch its field says;
 *   - a task blocked by another cannot be started until that one is done;
 *   - the geofence refuses a start from outside it and allows one inside;
 *   - one person cannot have two timers running;
 *   - an incentive is evaluated on the outcome and is PENDING until sanctioned;
 *   - the reminder worker cannot fire the same reminder twice.
 *
 * Everything it creates is namespaced and removed again in a final cleanup.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const TEST_URI = process.env.TASK_TEST_MONGO_URI;
if (!TEST_URI) {
  console.error('\nRefusing to run: set TASK_TEST_MONGO_URI to a THROWAWAY database.\n'
    + 'This script writes and deletes data and must never touch the live cluster.\n'
    + 'e.g. TASK_TEST_MONGO_URI="mongodb://127.0.0.1:27017/hrms_task_test" node scripts/testTaskWorkflow.js\n');
  process.exit(2);
}
if (process.env.MONGO_URI && TEST_URI.trim() === process.env.MONGO_URI.trim()) {
  console.error('\nRefusing to run: TASK_TEST_MONGO_URI is the same as MONGO_URI (the live database).\n');
  process.exit(2);
}

const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const WorkLocation = require('../models/WorkLocation');
const Task = require('../models/Task');
const TaskSubmission = require('../models/TaskSubmission');
const TaskTimeEntry = require('../models/TaskTimeEntry');
const TaskActivity = require('../models/TaskActivity');
const TaskIncentive = require('../models/TaskIncentive');
const Workflow = require('../models/Workflow');

const engine = require('../services/taskEngine');
const flow = require('../services/taskWorkflow');
const incentives = require('../services/taskIncentive');
const { claim, sweepDeadlines, sweepUnaccepted } = require('../services/taskReminderWorker');

// Everything this script creates carries this marker, so cleanup can find it.
const TAG = 'task-itest';

let passed = 0;
const failures = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1;
  else failures.push(`${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}
const ok = (label, got) => check(label, !!got, true);

/** Run something that should throw, and report the message it threw. */
async function refuses(label, fn, matcher) {
  try {
    await fn();
    failures.push(`${label}\n     expected a refusal, got none`);
    console.log(` FAIL  ${label} (was allowed)`);
  } catch (err) {
    const good = matcher ? matcher.test(err.message) : true;
    if (good) { passed += 1; console.log(`  ok   ${label}`); } else {
      failures.push(`${label}\n     refused, but with: ${err.message}`);
      console.log(` FAIL  ${label} (wrong message: ${err.message})`);
    }
  }
}

let ids = { users: [], tasks: [], workflows: [], locations: [], profiles: [] };

async function makeUser(first, role = 'Employee', permissions) {
  const u = await User.create({
    email: `${TAG}.${first.toLowerCase()}.${Date.now()}@example.test`,
    password: 'test123',
    firstName: first,
    lastName: TAG,
    role,
    permissions,
  });
  ids.users.push(u._id);
  const p = await EmployeeProfile.create({
    user: u._id,
    employeeCode: `${TAG}-${first}-${Date.now() % 100000}`,
    department: 'Testing',
  });
  ids.profiles.push(p._id);
  // req.user-shaped, which is what every service here expects.
  return { _id: u._id, firstName: first, lastName: TAG, role, permissions };
}

async function makeTask(fields, creator, assignee) {
  const t = await Task.create({
    title: `${TAG} ${fields.title || 'task'}`,
    createdBy: creator._id,
    assignees: assignee ? [{ user: assignee._id, name: assignee.firstName, role: 'Owner' }] : [],
    ...fields,
  });
  ids.tasks.push(t._id);
  return t;
}

async function main() {
  await mongoose.connect(TEST_URI);
  console.log(`Connected to ${TEST_URI}\n`);

  const boss = await makeUser('Boss', 'HRManager');
  const worker = await makeUser('Worker');
  const other = await makeUser('Other');

  // ===================================================================
  console.log('--- the lifecycle actually runs ---');
  let t = await makeTask({ title: 'lifecycle', dueDate: new Date(Date.now() + 86400000) }, boss, worker);
  check('a new task is assigned', t.status, 'ASSIGNED');
  ok('it was given a quotable code', /^TSK-\d{4}-\d{5}$/.test(t.code));
  check('assignedTo mirrors the owner', String(t.assignedTo), String(worker._id));
  check('the original due date was stamped', !!t.originalDueDate, true);

  t = await engine.transition(t, 'ACCEPTED', worker);
  check('accepted', t.status, 'ACCEPTED');
  ok('the server stamped when', !!t.acceptedAt);

  t = await engine.transition(t, 'IN_PROGRESS', worker);
  check('in progress', t.status, 'IN_PROGRESS');

  t = await engine.transition(t, 'SUBMITTED', worker);
  check('submitted', t.status, 'SUBMITTED');

  t = await engine.transition(t, 'APPROVED', boss);
  check('approved by somebody else', t.status, 'APPROVED');

  t = await engine.transition(t, 'COMPLETED', null, { system: true });
  check('completed', t.status, 'COMPLETED');
  ok('closedAt was stamped', !!t.closedAt);

  const trail = await TaskActivity.find({ task: t._id }).sort({ at: 1 }).lean();
  check('every move left a line in the trail', trail.length >= 5, true);
  ok('the trail names who did it', trail.some((a) => a.byName && /Worker/.test(a.byName)));

  // ===================================================================
  console.log('\n--- illegal moves and the wrong people ---');
  let t2 = await makeTask({ title: 'refusals' }, boss, worker);
  await refuses('a brand new task cannot jump to completed',
    () => engine.transition(t2, 'COMPLETED', boss), /cannot be marked completed/i);
  await refuses('somebody not on the task cannot accept it',
    () => engine.transition(t2, 'ACCEPTED', other), /Only somebody the task is assigned to/i);
  await refuses('declining with no reason is refused',
    () => engine.transition(t2, 'DECLINED', worker), /Say why/i);
  ok('declining WITH a reason works',
    await engine.transition(t2, 'DECLINED', worker, { note: 'On leave that week' }));

  let t3 = await makeTask({ title: 'self-review' }, boss, worker);
  t3 = await engine.transition(t3, 'ACCEPTED', worker);
  t3 = await engine.transition(t3, 'IN_PROGRESS', worker);
  t3 = await engine.transition(t3, 'SUBMITTED', worker);
  await refuses('NOBODY REVIEWS THEIR OWN WORK',
    () => engine.transition(t3, 'APPROVED', worker), /cannot review your own/i);

  // ===================================================================
  console.log('\n--- two approvers cannot both win (section 52) ---');
  // Both read the task in the same state, exactly as two browsers would.
  const copyA = await Task.findById(t3._id);
  const copyB = await Task.findById(t3._id);
  const first = await engine.transition(copyA, 'APPROVED', boss);
  check('the first approval lands', first.status, 'APPROVED');
  await refuses('the second is told it has already moved',
    () => engine.transition(copyB, 'APPROVED', boss), /already moved this task/i);

  // ===================================================================
  console.log('\n--- rejection keeps the history, resubmission is a new row ---');
  let t4 = await makeTask({ title: 'resubmit' }, boss, worker);
  t4 = await engine.transition(t4, 'IN_PROGRESS', worker);
  const sub1 = await TaskSubmission.create({
    task: t4._id, submittedBy: worker._id, submittedByName: 'Worker', attempt: 1, remarks: 'First go',
  });
  t4 = await engine.transition(t4, 'SUBMITTED', worker);
  t4 = await engine.transition(t4, 'REJECTED', boss, { note: 'Missing the photos' });
  check('the task was sent back', t4.status, 'REJECTED');
  check('the rejection was counted', t4.rejectionCount, 1);
  check('the reason is on the row', t4.stateNote, 'Missing the photos');

  const sub2 = await TaskSubmission.create({
    task: t4._id, submittedBy: worker._id, submittedByName: 'Worker', attempt: 2, remarks: 'Photos added',
  });
  ids.tasks.push();
  const bothSubs = await TaskSubmission.find({ task: t4._id }).sort({ attempt: 1 }).lean();
  check('THE EARLIER SUBMISSION IS STILL THERE', bothSubs.length, 2);
  check('...unchanged', bothSubs[0].remarks, 'First go');
  check('...and the new one is attempt 2', bothSubs[1].attempt, 2);
  t4 = await engine.transition(t4, 'SUBMITTED', worker);
  check('a resubmitted task is submitted again', t4.status, 'SUBMITTED');

  // ===================================================================
  console.log('\n--- a sequential workflow ---');
  const seq = await Workflow.create({
    name: `${TAG} sequential`,
    draft: [
      { key: 'sup', name: 'Supervisor', type: 'approval', order: 0, assigneeRule: { kind: 'supervisor' } },
      { key: 'mgr', name: 'Manager', type: 'approval', order: 1, assigneeRule: { kind: 'manager' } },
    ],
    createdBy: boss._id,
  });
  ids.workflows.push(seq._id);
  seq.versions.push({ version: 1, steps: JSON.parse(JSON.stringify(seq.draft)) });
  seq.activeVersion = 1;
  await seq.save();

  let wt = await makeTask({ title: 'sequential', supervisor: boss._id, manager: other._id }, boss, worker);
  await flow.start(wt, seq._id);
  await wt.save();
  check('the steps were COPIED onto the task', wt.workflowSteps.length, 2);
  check('...frozen at version 1', wt.workflowVersion, 1);

  await flow.begin(wt);
  await wt.save();
  check('the first step opened', wt.currentStepKey, 'sup');
  check('it is waiting on the supervisor', wt.pendingApprovers.map(String), [String(boss._id)]);

  let r = await flow.decide(wt, 'sup', boss, 'approved', 'Looks right');
  await wt.save();
  check('the first step settled', r.settled, true);
  check('the workflow is not finished', r.done, false);
  check('the second step is now open', wt.currentStepKey, 'mgr');
  check('and it waits on the manager', wt.pendingApprovers.map(String), [String(other._id)]);

  await refuses('somebody not asked cannot decide it',
    () => flow.decide(wt, 'mgr', boss, 'approved'), /not waiting on you/i);

  r = await flow.decide(wt, 'mgr', other, 'approved');
  await wt.save();
  check('THE WORKFLOW IS FINISHED', r.done, true);
  check('nothing is pending', wt.pendingApprovers.length, 0);

  // Editing the workflow now must not reach into the running task.
  seq.draft.push({ key: 'extra', name: 'Extra step', type: 'approval', order: 2, assigneeRule: { kind: 'creator' } });
  await seq.save();
  const refetched = await Task.findById(wt._id).lean();
  check('EDITING THE WORKFLOW DID NOT TOUCH THE RUNNING TASK', refetched.workflowSteps.length, 2);

  // ===================================================================
  console.log('\n--- a parallel group ---');
  const par = await Workflow.create({
    name: `${TAG} parallel`,
    draft: [
      { key: 'a', name: 'Finance', type: 'approval', order: 0, parallelGroup: 'g1', join: 'all', assigneeRule: { kind: 'supervisor' } },
      { key: 'b', name: 'Admin', type: 'approval', order: 1, parallelGroup: 'g1', join: 'all', assigneeRule: { kind: 'manager' } },
      { key: 'c', name: 'Director', type: 'approval', order: 2, assigneeRule: { kind: 'creator' } },
    ],
    createdBy: boss._id,
  });
  ids.workflows.push(par._id);
  par.versions.push({ version: 1, steps: JSON.parse(JSON.stringify(par.draft)) });
  par.activeVersion = 1;
  await par.save();

  let pt = await makeTask({ title: 'parallel', supervisor: boss._id, manager: other._id }, boss, worker);
  await flow.start(pt, par._id);
  await flow.begin(pt);
  await pt.save();
  const openNow = pt.workflowSteps.filter((s) => s.status === 'Pending').map((s) => s.key);
  check('BOTH PARALLEL STEPS OPENED AT ONCE', openNow.sort(), ['a', 'b']);
  check('and both people are waiting', pt.pendingApprovers.length, 2);

  r = await flow.decide(pt, 'a', boss, 'approved');
  await pt.save();
  check('one of two is not enough for an "all" join', r.settled, false);
  check('the third step has not opened', pt.workflowSteps.find((s) => s.key === 'c').status, 'Waiting');

  r = await flow.decide(pt, 'b', other, 'approved');
  await pt.save();
  check('the group settled once both answered', r.settled, true);
  check('THE STEP AFTER THE GROUP OPENED', pt.currentStepKey, 'c');

  // ===================================================================
  console.log('\n--- a conditional branch ---');
  const cond = await Workflow.create({
    name: `${TAG} conditional`,
    draft: [
      { key: 'gate', name: 'Over 50k?', type: 'condition', order: 0,
        condition: { field: 'customFields.amount', operator: 'gt', value: 50000, onTrue: 'director', onFalse: 'mgr' } },
      { key: 'director', name: 'Director', type: 'approval', order: 1, assigneeRule: { kind: 'creator' } },
      { key: 'mgr', name: 'Manager', type: 'approval', order: 2, assigneeRule: { kind: 'manager' } },
    ],
    createdBy: boss._id,
  });
  ids.workflows.push(cond._id);
  cond.versions.push({ version: 1, steps: JSON.parse(JSON.stringify(cond.draft)) });
  cond.activeVersion = 1;
  await cond.save();

  let big = await makeTask({
    title: 'big spend', manager: other._id,
    customFields: [{ key: 'amount', label: 'Amount', type: 'number', value: 60000 }],
  }, boss, worker);
  await flow.start(big, cond._id);
  await flow.begin(big);
  await big.save();
  check('₹60,000 goes to the Director', big.currentStepKey, 'director');

  let small = await makeTask({
    title: 'small spend', manager: other._id,
    customFields: [{ key: 'amount', label: 'Amount', type: 'number', value: 4000 }],
  }, boss, worker);
  await flow.start(small, cond._id);
  await flow.begin(small);
  await small.save();
  check('₹4,000 goes to the Manager', small.currentStepKey, 'mgr');

  // ===================================================================
  console.log('\n--- dependencies ---');
  const blocker = await makeTask({ title: 'collect documents' }, boss, worker);
  const dependent = await makeTask({
    title: 'verify documents',
    dependencies: [{ task: blocker._id, kind: 'blockedBy', satisfiedBy: 'COMPLETED' }],
  }, boss, worker);
  await refuses('a blocked task cannot be started',
    () => engine.assertDependenciesMet(dependent), /waiting on/i);
  await Task.updateOne({ _id: blocker._id }, { $set: { status: 'COMPLETED' } });
  let threw = false;
  try { await engine.assertDependenciesMet(dependent); } catch { threw = true; }
  check('once the blocker is done it can start', threw, false);

  // ===================================================================
  console.log('\n--- geofencing ---');
  const site = await WorkLocation.create({ name: `${TAG} Warehouse`, lat: 12.9716, lng: 77.5946, radiusM: 200 });
  ids.locations.push(site._id);
  const fenced = await makeTask({
    title: 'warehouse check',
    location: { captureOn: ['start'], enforceOn: ['start'], workLocation: site._id },
  }, boss, worker);

  await refuses('a start from 5 km away is refused',
    () => engine.checkGeofence(fenced, 'start', { lat: 13.0200, lng: 77.5946 }, worker._id),
    /You need to be at/i);
  const inside = await engine.checkGeofence(fenced, 'start', { lat: 12.9718, lng: 77.5948 }, worker._id);
  check('a start from inside is allowed', inside.insideFence, true);
  ok('and the distance is recorded', inside.distanceM != null);

  const unfenced = await makeTask({ title: 'anywhere' }, boss, worker);
  check('a task with no fence captures nothing',
    await engine.checkGeofence(unfenced, 'start', { lat: 0, lng: 0 }, worker._id), null);

  // ===================================================================
  console.log('\n--- one timer at a time ---');
  const timed1 = await makeTask({ title: 'timed one' }, boss, worker);
  const timed2 = await makeTask({ title: 'timed two' }, boss, worker);
  await TaskTimeEntry.syncIndexes();
  const running = await TaskTimeEntry.create({
    task: timed1._id, user: worker._id, startedAt: new Date(), status: 'running', dayKey: '2026-03-12',
  });
  ok('the first timer started', running);
  await refuses('THE DATABASE REFUSES A SECOND', async () => {
    await TaskTimeEntry.create({
      task: timed2._id, user: worker._id, startedAt: new Date(), status: 'running', dayKey: '2026-03-12',
    });
  }, /duplicate key|E11000/i);
  running.endedAt = new Date();
  running.status = 'stopped';
  await running.save();
  const second = await TaskTimeEntry.create({
    task: timed2._id, user: worker._id, startedAt: new Date(), status: 'running', dayKey: '2026-03-12',
  });
  ok('once the first is stopped, a second may start', second);
  await TaskTimeEntry.deleteMany({ user: worker._id });

  // ===================================================================
  console.log('\n--- the incentive is proposed, not awarded ---');
  let inc = await makeTask({
    title: 'worth points',
    dueDate: new Date(Date.now() + 3600000),
    startDate: new Date(Date.now() - 86400000),
    incentive: { enabled: true, points: 20, distribution: 'share' },
  }, boss, worker);
  inc.assignees.push({ user: other._id, name: 'Other', role: 'Contributor' });
  inc.completedAt = new Date();
  await inc.save();

  const awards = await incentives.evaluate(inc);
  check('one award per eligible person', awards.length, 2);
  check('IT IS PENDING, NOT CREDITED', awards[0].status, 'Pending');
  check('20 points shared between two, on time, is 8 each', awards[0].points, 8);
  ok('the arithmetic is shown', /20 points × 80%/.test(awards[0].basis));

  await refuses('an employee cannot sanction their own',
    () => incentives.approveAward(awards[0], worker), /cannot approve your own/i);

  // Evaluating twice must not mint a second award for the same person.
  const again = await incentives.evaluate(inc);
  const total = await TaskIncentive.countDocuments({ task: inc._id });
  check('re-evaluating does not duplicate the award', total, 2);

  // ===================================================================
  console.log('\n--- the reminder worker cannot replay ---');
  const chased = await makeTask({ title: 'reminders', dueDate: new Date(Date.now() - 3600000) }, boss, worker);
  check('the first claim wins', await claim(chased._id, 'over:1:assignee'), true);
  check('THE SECOND CLAIM IS REFUSED', await claim(chased._id, 'over:1:assignee'), false);
  check('a different rung is still available', await claim(chased._id, 'over:2:supervisor'), true);

  // ===================================================================
  console.log('\n--- THE BACKLOG RULE: an old overdue task is adopted, not shouted about ---');
  // A task that went overdue while nothing was watching must not fire a wave
  // of notifications the moment the worker first runs — which is exactly what
  // 51 carried-over tasks would have done on the day this module shipped.
  const stale = await makeTask({
    title: 'long overdue',
    dueDate: new Date(Date.now() - 10 * 86400000),
    assignedAt: new Date(Date.now() - 12 * 86400000),
  }, boss, worker);
  const fresh = await makeTask({
    title: 'just went late',
    dueDate: new Date(Date.now() - 30 * 60000),
    assignedAt: new Date(Date.now() - 60 * 60000),
  }, boss, worker);

  await sweepDeadlines();
  const staleAfter = await Task.findById(stale._id).select('firedReminders').lean();
  const freshAfter = await Task.findById(fresh._id).select('firedReminders').lean();
  ok('the ten-day-old one had its rungs claimed', (staleAfter.firedReminders || []).some((k) => k.startsWith('over:')));
  check('...and nothing was sent for it (every passed rung claimed at once)',
    (staleAfter.firedReminders || []).filter((k) => k.startsWith('over:')).length >= 4, true);
  check('the one that just went late IS chased',
    (freshAfter.firedReminders || []).filter((k) => k.startsWith('over:')).length, 1);

  await sweepUnaccepted();
  const staleAcc = await Task.findById(stale._id).select('firedReminders').lean();
  ok('an old unaccepted task is adopted too',
    (staleAcc.firedReminders || []).includes('accept:assignee') && (staleAcc.firedReminders || []).includes('accept:supervisor'));

  // ===================================================================
  console.log('\n--- an authorised reopen ---');
  let done = await makeTask({ title: 'reopen me', status: 'COMPLETED' }, boss, worker);
  await refuses('a reopen needs a reason',
    () => engine.transition(done, 'IN_PROGRESS', boss), /Say why/i);
  await refuses('and an ordinary assignee cannot',
    () => engine.transition(done, 'IN_PROGRESS', worker, { note: 'I want another go' }),
    /Only somebody who manages tasks/i);
  done = await engine.transition(done, 'IN_PROGRESS', boss, { note: 'Client asked for a correction' });
  check('an administrator may, with a reason', done.status, 'IN_PROGRESS');
}

async function cleanup() {
  console.log('\nCleaning up…');
  const taskIds = (await Task.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((t) => t._id);
  const all = [...new Set([...ids.tasks.map(String), ...taskIds.map(String)])];
  await Promise.all([
    Task.deleteMany({ _id: { $in: all } }),
    TaskSubmission.deleteMany({ task: { $in: all } }),
    TaskTimeEntry.deleteMany({ task: { $in: all } }),
    TaskActivity.deleteMany({ task: { $in: all } }),
    TaskIncentive.deleteMany({ task: { $in: all } }),
    Workflow.deleteMany({ name: new RegExp(`^${TAG}`) }),
    WorkLocation.deleteMany({ name: new RegExp(`^${TAG}`) }),
    EmployeeProfile.deleteMany({ _id: { $in: ids.profiles } }),
    User.deleteMany({ _id: { $in: ids.users } }),
  ]);
  console.log('Done.');
}

main()
  .then(cleanup)
  .then(async () => {
    await mongoose.disconnect();
    console.log('');
    if (failures.length) {
      console.log(`FAILED — ${passed} passed, ${failures.length} failed\n`);
      for (const f of failures) console.log(` * ${f}`);
      process.exit(1);
    }
    console.log(`All ${passed} checks passed.\n`);
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nHarness crashed:', err.message);
    console.error(err.stack);
    await cleanup().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
