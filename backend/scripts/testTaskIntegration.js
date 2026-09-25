/**
 * End-to-end check of the task engine against a real database.
 *
 *   TASK_TEST_MONGO_URI="mongodb://127.0.0.1:27017/hrms_task_test" node scripts/testTaskIntegration.js
 *
 * WHY THE SEPARATE ENV VAR. This project's ordinary MONGO_URI points at the
 * live Atlas cluster, and this script CREATES AND DELETES DATA. It therefore
 * refuses to run unless you name a throwaway database explicitly in
 * TASK_TEST_MONGO_URI, and refuses again if that value happens to match
 * MONGO_URI. Point it at a local mongod or a scratch Atlas database.
 *
 * What it proves, which the pure self-check (testTasks.js) cannot — every one of
 * these crosses a document boundary, and that is exactly where the 2026-09-22
 * rework put its new rules:
 *
 *   - a CEO's task split by a manager becomes real child tasks that carry the
 *     parent's points, and the parent's remainder shrinks to match;
 *   - the pool can never be overdrawn, on any path;
 *   - a piece nobody was named for is claimable by exactly the people it was
 *     offered to, once, even if two of them try at the same moment;
 *   - a doer's "Complete" lands in review, and only the assigner can sign it off;
 *   - a rejected submission reopens the task WITHOUT losing the work, and the
 *     rejection is counted;
 *   - punctuality is frozen at SUBMISSION, so a manager who approves a week
 *     late does not make the doer late;
 *   - progress rolls up to the parent WEIGHTED BY POINTS, including the share
 *     the splitter kept;
 *   - granting more time moves the deadline and re-arms the reminders, and does
 *     not retroactively make a late delivery punctual;
 *   - points are credited from the REMAINDER, not the whole pool, so a split
 *     task cannot pay out twice.
 *
 * Everything it creates is namespaced and removed again in a final cleanup.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const TEST_URI = process.env.TASK_TEST_MONGO_URI;
if (!TEST_URI) {
  console.error('\nRefusing to run: set TASK_TEST_MONGO_URI to a THROWAWAY database.\n'
    + 'This script writes and deletes data and must never touch the live cluster.\n');
  process.exit(2);
}
if (process.env.MONGO_URI && TEST_URI.trim() === process.env.MONGO_URI.trim()) {
  console.error('\nRefusing to run: TASK_TEST_MONGO_URI is the same as MONGO_URI (the live database).\n');
  process.exit(2);
}

const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const engine = require('../services/taskEngine');
const access = require('../services/taskAccess');
const { STATUS, ACCEPTANCE, EXTENSION_STATUS } = require('../config/tasks');

/** Everything this script creates carries this marker, so cleanup can find it. */
const TAG = 'task-itest';

let passed = 0;
const failures = [];

function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1;
  else failures.push(`${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}

/** Did that throw? The message, or null. Used for every "must be refused". */
async function refused(fn) {
  try { await fn(); return null; } catch (e) { return e.message; }
}

const day = (n) => new Date(Date.now() + n * 86400000);

async function person(first, role = 'Employee') {
  return User.create({
    firstName: first,
    lastName: TAG,
    email: `${TAG}-${first.toLowerCase()}@example.test`,
    password: 'x'.repeat(12),
    role,
    isActive: true,
  });
}

async function run() {
  await mongoose.connect(TEST_URI);
  console.log(`connected to ${TEST_URI}\n`);

  // ---- the cast ------------------------------------------------------------
  // A reporting line three deep, because the direction rule and "my team" both
  // walk it: ceo -> manager -> {dev, designer}.
  const ceo = await person('Ceo', 'CEO');
  const manager = await person('Manager', 'Manager');
  const dev = await person('Dev');
  const designer = await person('Designer');
  const outsider = await person('Outsider');

  await EmployeeProfile.create([
    { user: manager._id, firstName: 'Manager', lastName: TAG, employeeCode: `${TAG}-M`, reportingManager: ceo._id },
    { user: dev._id, firstName: 'Dev', lastName: TAG, employeeCode: `${TAG}-D`, reportingManager: manager._id },
    { user: designer._id, firstName: 'Designer', lastName: TAG, employeeCode: `${TAG}-S`, reportingManager: manager._id },
    { user: outsider._id, firstName: 'Outsider', lastName: TAG, employeeCode: `${TAG}-O` },
  ]);
  access.invalidateTree();

  console.log('The reporting tree, both ways');
  const team = await access.teamOf(manager._id);
  check('the manager\'s direct reports', team.direct.length, 2);
  const ceoTeam = await access.teamOf(ceo._id);
  check('the CEO sees the manager directly', ceoTeam.direct.map(String), [String(manager._id)]);
  check('…and the manager\'s people indirectly', ceoTeam.indirect.length, 2);
  check('a piece of work travels DOWN to a report',
    await access.directionOf(manager._id, dev._id), 'DOWN');
  check('…and UP to the boss', await access.directionOf(dev._id, ceo._id), 'UP');
  check('relation: dev is the manager\'s direct', await access.relationTo(manager._id, dev._id), 'direct');
  check('relation: dev is the CEO\'s indirect', await access.relationTo(ceo._id, dev._id), 'indirect');

  // ---- 1. the CEO sets a task on the manager ------------------------------
  console.log('\nThe CEO hands the manager a hundred points of work');
  let parent = await Task.create({
    title: `${TAG} quarterly report`,
    createdBy: ceo._id,
    createdByName: 'Ceo',
    assignees: [{ user: manager._id, name: 'Manager' }],
    points: 100,
    dueDate: day(7),
    requiresApproval: true,
  });
  check('it starts pending', parent.status, STATUS.PENDING);
  check('the whole pool is the manager\'s for now', parent.effectivePoints(), 100);

  // ---- 2. the manager splits it -------------------------------------------
  console.log('\nThe manager splits it three ways, one of them open');
  const split = await engine.splitTask({
    taskId: parent._id,
    user: manager,
    items: [
      { title: 'Numbers', assignee: dev._id },
      { title: 'Charts', assignee: designer._id },
      { title: 'Proof-read', openTo: [dev._id, designer._id] },
    ],
  });
  check('three pieces were made', split.children.length, 3);
  check('…each a real task with its own code',
    split.children.every((c) => /^TSK-/.test(c.code || '')), true);
  check('the pool came out WHOLE, biggest share first',
    split.children.map((c) => c.points), [34, 33, 33]);

  parent = await Task.findById(parent._id);
  check('the parent records what it handed down', parent.distributedPoints, 100);
  check('…and so the manager now earns nothing for it', parent.effectivePoints(), 0);
  check('…and counts its pieces', [parent.childCount, parent.childDoneCount], [3, 0]);

  const [numbers, charts, proof] = split.children;
  check('a named piece has its person on it', String(numbers.assignees[0].user), String(dev._id));
  check('an open piece has nobody', proof.assignees.length, 0);
  check('…and is offered to two people', proof.openTo.length, 2);
  check('a piece knows what it is part of', String(numbers.parentTask), String(parent._id));
  check('…and says so without a join', numbers.parentTitle, parent.title);

  console.log('\nThe pool is not a mint');
  check('a split larger than what is left is refused',
    Boolean(await refused(() => engine.splitTask({
      taskId: parent._id, user: manager, items: [{ title: 'More', points: 50 }],
    }))), true);
  // "Work cannot be pushed UPWARD as a piece" was checked here until
  // 2026-09-25, when anybody became assignable (services/taskAccess
  // .resolveAssignmentKind). Removed rather than inverted: the call was refused
  // and changed nothing, so every figure checked below is unaffected.

  // ---- 3. claiming the open piece -----------------------------------------
  console.log('\nSomebody picks the open piece up');
  check('a person it was NOT offered to cannot take it',
    Boolean(await refused(() => engine.claimTask({ taskId: proof._id, user: outsider }))), true);

  const claimed = await engine.claimTask({ taskId: proof._id, user: designer });
  check('the claimer is now its only person', claimed.task.assignees.length, 1);
  check('…and picking it up counts as accepting it',
    claimed.task.assignees[0].acceptance, ACCEPTANCE.ACCEPTED);
  check('it is no longer offered to anybody', claimed.task.openTo.length, 0);
  check('a second person is told they were too slow',
    Boolean(await refused(() => engine.claimTask({ taskId: proof._id, user: dev }))), true);

  // ---- 3b. accepting starts the work --------------------------------------
  console.log('\nAccepting takes it on AND starts it');
  const handed = await Task.create({
    title: `${TAG} to be accepted`,
    createdBy: manager._id,
    assignees: [{ user: dev._id }],
    points: 10,
    dueDate: day(4),
  });
  check('it sits in To Do', handed.status, STATUS.PENDING);
  const taken = await engine.accept({ taskId: handed._id, user: dev });
  check('accepting moves it to In Progress', taken.task.status, STATUS.IN_PROGRESS);
  check('…and records the acknowledgement', taken.task.assignees[0].acceptance, ACCEPTANCE.ACCEPTED);
  check('…and stamps when work began', Boolean(taken.task.assignees[0].startedAt), true);
  check('accepting twice is a no-op',
    (await engine.accept({ taskId: handed._id, user: dev })).unchanged, true);

  // ---- 3c. delegate moves the approval; transfer moves everything ---------
  console.log('\nDelegating makes the delegator the approver');
  const chain = await Task.create({
    title: `${TAG} the CEO's report`,
    createdBy: ceo._id,
    assignees: [{ user: manager._id, name: 'Manager' }],
    points: 20,
    dueDate: day(5),
    requiresApproval: true,
  });
  check('the CEO signs it off to begin with', String(chain.approver), String(ceo._id));

  const passed = await engine.delegate({
    taskId: chain._id, user: manager, to: dev._id, note: 'Over to you.',
  });
  check('the doer is now the junior', String(passed.task.assignees[0].user), String(dev._id));
  check('THE MANAGER is now the approver, not the CEO',
    String(passed.task.approver), String(manager._id));
  check('…but the CEO is still recorded as having set it',
    String(passed.task.createdBy), String(ceo._id));
  check('the delegator keeps hearing about it',
    passed.task.originalAssignees.map(String).includes(String(manager._id)), true);

  await engine.move({ taskId: chain._id, user: dev, to: STATUS.COMPLETED, note: 'Drafted.' });
  const inTray = await Task.findById(chain._id);
  check('the junior\'s work lands in review', inTray.status, STATUS.SUBMITTED);
  check('the CEO cannot be made to read it — the manager can approve',
    Boolean(access.capabilitiesFor(manager, inTray.toObject()).canApprove), true);
  await engine.move({ taskId: chain._id, user: manager, to: STATUS.COMPLETED, note: 'Fine.' });
  check('and the manager signs it off',
    (await Task.findById(chain._id)).status, STATUS.COMPLETED);

  console.log('\nTransferring is NOT delegating');
  const misSent = await Task.create({
    title: `${TAG} wrong person`,
    createdBy: manager._id,
    assignees: [{ user: dev._id, name: 'Dev' }],
    points: 15,
    dueDate: day(4),
  });
  await engine.setProgress({ taskId: misSent._id, user: dev, progress: 30 });
  check('a reason is required', Boolean(await refused(() => engine.transferTask({
    taskId: misSent._id, user: manager, to: designer._id, reason: '',
  }))), true);
  check('a stranger cannot transfer it', Boolean(await refused(() => engine.transferTask({
    taskId: misSent._id, user: outsider, to: designer._id, reason: 'mine now',
  }))), true);

  const moved2 = await engine.transferTask({
    taskId: misSent._id, user: manager, to: designer._id, reason: 'Wrong desk.',
  });
  check('the new person is the only one on it', moved2.task.assignees.length, 1);
  check('…and it is them', String(moved2.task.assignees[0].user), String(designer._id));
  check('they start from scratch — PENDING, unanswered',
    [moved2.task.status, moved2.task.assignees[0].acceptance],
    [STATUS.PENDING, ACCEPTANCE.AWAITING]);
  check('the half-finished progress does not follow them', moved2.task.progress, 0);
  // The whole point of a transfer: the wrong person stops being told about it.
  check('the wrong person is OUT of the audience',
    moved2.task.audience().includes(String(dev._id)), false);
  check('…and out of originalAssignees', moved2.task.originalAssignees.map(String), [String(designer._id)]);
  check('but the record that it happened survives', moved2.task.transfers.length, 1);
  check('…naming who it came off', String(moved2.task.transfers[0].from), String(dev._id));

  // ---- 4. progress ---------------------------------------------------------
  console.log('\nReporting progress');
  check('only the person doing it may say how far along it is',
    Boolean(await refused(() => engine.setProgress({ taskId: numbers._id, user: manager, progress: 50 }))), true);

  const moved = await engine.setProgress({ taskId: numbers._id, user: dev, progress: 50 });
  check('the figure lands on the row', moved.task.assignees[0].progress, 50);
  check('moving off zero STARTS it', moved.task.status, STATUS.IN_PROGRESS);
  check('…and implies acceptance', moved.task.assignees[0].acceptance, ACCEPTANCE.ACCEPTED);
  check('over 100 is clamped, not stored',
    (await engine.setProgress({ taskId: numbers._id, user: dev, progress: 500 })).task.assignees[0].progress, 100);
  await engine.setProgress({ taskId: numbers._id, user: dev, progress: 50 });

  parent = await Task.findById(parent._id);
  // 34 points at 50%, 33 at 0, 33 at 0, and nothing left with the manager.
  check('the parent\'s bar is weighted by points, not a headcount',
    parent.progress, Math.round((50 * 34) / 100));

  // ---- 5. handing in, and the two answers ---------------------------------
  console.log('\nHanding a piece in');
  const handedIn = await engine.move({
    taskId: numbers._id, user: dev, to: STATUS.COMPLETED, note: 'Figures are in.',
  });
  check('a doer\'s Complete becomes a submission', handedIn.task.status, STATUS.SUBMITTED);
  check('…and the server says it redirected', handedIn.coerced, true);
  check('the feed words it for itself', (await TaskUpdate.findById(handedIn.update._id)).kind, 'SUBMITTED');
  check('a submitted row is 100% by definition', handedIn.task.assignees[0].progress, 100);

  check('the doer cannot sign off their own work',
    Boolean(await refused(() => engine.move({
      taskId: numbers._id, user: dev, to: STATUS.COMPLETED, note: 'Done, honest.',
    }))), true);

  console.log('\n…sent back, and the work survives');
  const sentBack = await engine.move({
    taskId: numbers._id, user: manager, to: STATUS.IN_PROGRESS, note: 'Q3 is missing.',
  });
  check('it reopens', sentBack.task.status, STATUS.IN_PROGRESS);
  check('the rejection is counted', sentBack.task.rejectionCount, 1);
  check('the SAME person still has it', String(sentBack.task.assignees[0].user), String(dev._id));
  check('the feed calls it what it was',
    (await TaskUpdate.findById(sentBack.update._id)).kind, 'SENT_BACK');

  console.log('\n…handed in again, and approved');
  await engine.move({ taskId: numbers._id, user: dev, to: STATUS.COMPLETED, note: 'Q3 added.' });
  const approved = await engine.move({
    taskId: numbers._id, user: manager, to: STATUS.COMPLETED, note: 'Good.',
  });
  check('an assigner\'s Complete really completes', approved.task.status, STATUS.COMPLETED);
  check('the feed calls it an approval',
    (await TaskUpdate.findById(approved.update._id)).kind, 'APPROVED');
  check('it was in time', approved.task.completedLate, false);

  parent = await Task.findById(parent._id);
  check('the parent counts a finished piece', parent.childDoneCount, 1);

  // ---- 6. punctuality is frozen at SUBMISSION ------------------------------
  console.log('\nPunctuality belongs to whoever handed it in');
  const late = await Task.create({
    title: `${TAG} late one`,
    createdBy: manager._id,
    assignees: [{ user: dev._id }],
    points: 10,
    dueDate: day(-2),          // the deadline was two days ago
    requiresApproval: true,
  });
  await engine.move({ taskId: late._id, user: dev, to: STATUS.COMPLETED, note: 'Sorry, late.' });
  let lateRow = await Task.findById(late._id);
  check('handing in after the deadline is recorded as late at that moment',
    lateRow.assignees[0].completedLate, true);

  const onTime = await Task.create({
    title: `${TAG} punctual one`,
    createdBy: manager._id,
    assignees: [{ user: dev._id }],
    points: 10,
    dueDate: day(1),           // still a day to go
    requiresApproval: true,
  });
  await engine.move({ taskId: onTime._id, user: dev, to: STATUS.COMPLETED, note: 'Early.' });
  // The manager then moves the deadline into the past before approving — which
  // is the shape of "approved a week later" and must not make the doer late.
  await Task.updateOne({ _id: onTime._id }, { $set: { dueDate: day(-1) } });
  const settled = await engine.move({
    taskId: onTime._id, user: manager, to: STATUS.COMPLETED, note: 'Signed off.',
  });
  check('a punctual submission stays punctual however late it is approved',
    settled.task.assignees[0].completedLate, false);

  // ---- 7. more time --------------------------------------------------------
  console.log('\nAsking for more time');
  const chased = await Task.create({
    title: `${TAG} needs longer`,
    createdBy: manager._id,
    assignees: [{ user: dev._id }],
    points: 10,
    dueDate: day(2),
    firedReminders: ['APP:BEFORE:1:DAYS'],
  });
  check('a reason is required',
    Boolean(await refused(() => engine.requestExtension({
      taskId: chased._id, user: dev, toDate: day(5), reason: '',
    }))), true);
  check('an EARLIER date is not an extension',
    Boolean(await refused(() => engine.requestExtension({
      taskId: chased._id, user: dev, toDate: day(1), reason: 'because',
    }))), true);

  const asked = await engine.requestExtension({
    taskId: chased._id, user: dev, toDate: day(6), reason: 'Waiting on the auditors.',
  });
  check('it is recorded as pending', asked.extension.status, EXTENSION_STATUS.PENDING);
  check('…with the deadline it was asking to move',
    new Date(asked.extension.fromDate).toDateString(), new Date(day(2)).toDateString());
  check('one un-answered request at a time',
    Boolean(await refused(() => engine.requestExtension({
      taskId: chased._id, user: dev, toDate: day(9), reason: 'and again',
    }))), true);
  check('the doer cannot grant it themselves',
    Boolean(await refused(() => engine.decideExtension({
      taskId: chased._id, requestId: asked.extension._id, user: dev, approve: true,
    }))), true);

  const granted = await engine.decideExtension({
    taskId: chased._id, requestId: asked.extension._id, user: manager, approve: true, note: 'Fine.',
  });
  check('the deadline actually moves',
    new Date(granted.task.dueDate).toDateString(), new Date(day(6)).toDateString());
  check('…and it is counted', granted.task.extensionCount, 1);
  check('the chasing schedule is re-armed for the new date',
    granted.task.firedReminders.length, 0);
  check('deciding twice is a no-op, not a second extension',
    (await engine.decideExtension({
      taskId: chased._id, requestId: asked.extension._id, user: manager, approve: false,
    })).unchanged, true);

  // ---- 8. points come out of the remainder --------------------------------
  console.log('\nPoints are credited from what is LEFT, never the whole pool');
  const paid = await Task.create({
    title: `${TAG} half delegated`,
    createdBy: ceo._id,
    assignees: [{ user: manager._id, name: 'Manager' }],
    points: 100,
    dueDate: day(3),
    requiresApproval: false,
  });
  await engine.splitTask({
    taskId: paid._id, user: manager, items: [{ title: 'The hard half', assignee: dev._id, points: 60 }],
  });
  const done = await engine.move({
    taskId: paid._id, user: manager, to: STATUS.COMPLETED, note: 'All in.',
  });
  check('the manager is credited the 40 they kept, not the 100 they started with',
    done.task.assignees[0].pointsAwarded, 40);

  // ---- 9. the wall ---------------------------------------------------------
  console.log('\nWho can see a piece');
  const pieceRow = await Task.findById(numbers._id).lean();
  check('its owner can', access.canSee(dev, pieceRow), true);
  check('whoever split it can', access.canSee(manager, pieceRow), true);
  check('a stranger cannot', access.canSee(outsider, pieceRow), false);
  check('…but the CEO reaches it through the parent they set',
    await access.canSeeThroughParent(ceo, pieceRow), true);

  // ---- cleanup -------------------------------------------------------------
  console.log('\ncleaning up…');
  const people = [ceo, manager, dev, designer, outsider].map((u) => u._id);
  const tasks = await Task.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean();
  await TaskUpdate.deleteMany({ task: { $in: tasks.map((t) => t._id) } });
  await Task.deleteMany({ _id: { $in: tasks.map((t) => t._id) } });
  await EmployeeProfile.deleteMany({ user: { $in: people } });
  await User.deleteMany({ _id: { $in: people } });

  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${passed} checks passed, ${failures.length} failed.`);
  failures.forEach((f) => console.error(`\n  * ${f}`));
  await mongoose.disconnect();
  process.exit(failures.length ? 1 : 0);
}

run().catch(async (err) => {
  console.error('\nintegration run crashed:', err);
  try { await mongoose.disconnect(); } catch (_) { /* already down */ }
  process.exit(1);
});
