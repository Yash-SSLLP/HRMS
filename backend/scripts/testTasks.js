/**
 * The task module's rules, checked without a database.
 *
 *   npm run test:tasks
 *
 * Everything here is pure: the lifecycle table, the status vocabulary (old and
 * new), the reminder arithmetic, the recurrence calendar and the model's
 * roll-up hooks. No connection, no fixtures, so it runs in a second and can be
 * run before every commit.
 *
 * WHY THE MODEL TESTS USE `validate()` AND NOT `validateSync()`. Mongoose runs
 * NO middleware on validateSync — the pre-validate hooks that normalise a
 * status and roll the assignees up into the headline status simply do not fire,
 * and a test written against it passes a document the application would never
 * produce. This cost half an hour once; it is written down so it does not cost
 * it again.
 */
const mongoose = require('mongoose');

const c = require('../config/tasks');
const r = require('../services/taskRecurrenceWorker');
const engine = require('../services/taskEngine');
const access = require('../services/taskAccess');
const Task = require('../models/Task');
const { decorate, buildQuery } = require('../controllers/taskController');

let passed = 0;
let failed = 0;

function ok(label, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}\n          got ${a}\n          want ${b}`);
  }
}

const uid = () => new mongoose.Types.ObjectId();
const [A, B, C] = [uid(), uid(), uid()];
const day = (s) => new Date(`${s}T12:00:00`);

// ===== 1. The vocabulary =====

function testVocabulary() {
  console.log('\nStatus vocabulary');
  // Twelve states collapsed to three, then a fourth came back for the review
  // desk (2026-09-22). Both older vocabularies still read.
  ok('SUBMITTED stays SUBMITTED', c.normaliseStatus('SUBMITTED'), 'SUBMITTED');
  ok('UNDER_REVIEW → SUBMITTED', c.normaliseStatus('UNDER_REVIEW'), 'SUBMITTED');
  ok('Review → SUBMITTED (pre-2026-09-17)', c.normaliseStatus('Review'), 'SUBMITTED');
  ok('BLOCKED → IN_PROGRESS', c.normaliseStatus('BLOCKED'), 'IN_PROGRESS');
  ok('APPROVED → COMPLETED', c.normaliseStatus('APPROVED'), 'COMPLETED');
  ok('DECLINED → CANCELLED', c.normaliseStatus('DECLINED'), 'CANCELLED');
  ok('Todo → PENDING (pre-2026-09-17)', c.normaliseStatus('Todo'), 'PENDING');
  ok('Done → COMPLETED (pre-2026-09-17)', c.normaliseStatus('Done'), 'COMPLETED');
  ok('"in progress" → IN_PROGRESS', c.normaliseStatus('in progress'), 'IN_PROGRESS');
  ok('nonsense → null', c.normaliseStatus('banana'), null);
  ok('empty → null', c.normaliseStatus(''), null);

  console.log('\nWording');
  ok('a task is Completed', c.statusLabel('COMPLETED', c.KIND_TASK), 'Completed');
  ok('a request is Answered', c.statusLabel('COMPLETED', c.KIND_REQUEST), 'Answered');
  ok('a request is Withdrawn', c.statusLabel('CANCELLED', c.KIND_REQUEST), 'Withdrawn');
  ok('a task in review', c.statusLabel('SUBMITTED', c.KIND_TASK), 'In review');
  ok('a request whose answer is sent', c.statusLabel('SUBMITTED', c.KIND_REQUEST), 'Answer sent');

  console.log('\nPriority');
  ok('the three levels', c.TASK_PRIORITY, ['Urgent', 'Medium', 'Low']);
  ok('High → Urgent', c.normalisePriority('High'), 'Urgent');
  ok('Critical → Urgent', c.normalisePriority('Critical'), 'Urgent');
  ok('urgent (any case) → Urgent', c.normalisePriority('urgent'), 'Urgent');
  ok('Normal → Medium', c.normalisePriority('Normal'), 'Medium');
  ok('nonsense → null', c.normalisePriority('banana'), null);

  console.log('\nThe colour of a row');
  // The brief's rule: pending wears its priority, finished wears green.
  ok('an urgent pending task is red', c.accentFor({ status: 'PENDING', priority: 'Urgent' }).key, 'Urgent');
  ok('a legacy High is red too', c.accentFor({ status: 'PENDING', priority: 'High' }).key, 'Urgent');
  ok('a finished LOW task is GREEN, not grey',
    c.accentFor({ status: 'COMPLETED', priority: 'Low' }).key, 'DONE');
  ok('…and a finished urgent one is green as well',
    c.accentFor({ status: 'COMPLETED', priority: 'Urgent' }).key, 'DONE');
  ok('in review still wears its priority',
    c.accentFor({ status: 'SUBMITTED', priority: 'Medium' }).key, 'Medium');
  ok('a cancelled one is grey', c.accentFor({ status: 'CANCELLED', priority: 'Urgent' }).key, 'CANCELLED');
  ok('every level has four hexes',
    c.TASK_PRIORITY.every((p) => ['ink', 'bg', 'border', 'solid']
      .every((k) => /^#[0-9A-F]{6}$/i.test(c.PRIORITY_COLORS[p][k]))), true);
}

// ===== 2. The lifecycle =====

function testLifecycle() {
  console.log('\nLegal moves');
  ok('PENDING → IN_PROGRESS', Boolean(c.transitionFor('PENDING', 'IN_PROGRESS')), true);
  ok('PENDING → COMPLETED (skipping the start)', Boolean(c.transitionFor('PENDING', 'COMPLETED')), true);
  ok('COMPLETED → PENDING is not a move', c.transitionFor('COMPLETED', 'PENDING'), null);
  ok('CANCELLED → COMPLETED is not a move', c.transitionFor('CANCELLED', 'COMPLETED'), null);
  ok('reopening is the assigner’s alone', c.transitionFor('COMPLETED', 'IN_PROGRESS').by, ['assigner']);
  ok('cancelling is the assigner’s alone', c.transitionFor('PENDING', 'CANCELLED').by, ['assigner']);
  ok('completing needs a note', c.transitionFor('IN_PROGRESS', 'COMPLETED').note, true);

  console.log('\nOverdue is derived, never stored');
  const past = new Date(Date.now() - 86400000);
  const future = new Date(Date.now() + 86400000);
  ok('open and past its date', c.isOverdue({ status: 'PENDING', dueDate: past }), true);
  ok('open and not yet due', c.isOverdue({ status: 'PENDING', dueDate: future }), false);
  ok('completed late is NOT overdue', c.isOverdue({ status: 'COMPLETED', dueDate: past }), false);
  ok('cancelled is NOT overdue', c.isOverdue({ status: 'CANCELLED', dueDate: past }), false);
  ok('no deadline is never overdue', c.isOverdue({ status: 'PENDING' }), false);
}

// ===== 3. Reminders =====

function testReminders() {
  console.log('\nReminder arithmetic');
  ok('1 day before = −1440 min', c.reminderOffsetMinutes({ amount: 1, unit: 'DAYS', when: 'BEFORE' }), -1440);
  ok('4 hours after = +240 min', c.reminderOffsetMinutes({ amount: 4, unit: 'HOURS', when: 'AFTER' }), 240);
  ok('30 minutes before = −30', c.reminderOffsetMinutes({ amount: 30, unit: 'MINUTES', when: 'BEFORE' }), -30);
  // A negative amount is a typo, not an instruction to invert the direction.
  ok('a negative amount is read as positive', c.reminderOffsetMinutes({ amount: -2, unit: 'DAYS', when: 'BEFORE' }), -2880);

  ok('wording: 1 day before', c.reminderLabel({ amount: 1, unit: 'DAYS', when: 'BEFORE' }), '1 day before');
  ok('wording: 4 hours after', c.reminderLabel({ amount: 4, unit: 'HOURS', when: 'AFTER' }), '4 hours after');

  // The key is the worker's idempotence: it must be stable and it must
  // distinguish two rules that differ in any field.
  const k = (o) => c.reminderKey({ channel: 'APP', amount: 1, unit: 'DAYS', when: 'BEFORE', ...o });
  ok('key is stable', k({}), 'APP:BEFORE:1:DAYS');
  ok('a different channel is a different key', k({ channel: 'EMAIL' }) !== k({}), true);
  ok('a different direction is a different key', k({ when: 'AFTER' }) !== k({}), true);
}

// ===== 4. The recurrence calendar =====

function testRecurrence() {
  console.log('\nRecurrence');
  const weekly = { frequency: 'WEEKLY', weekdays: [5], startDate: day('2026-09-21'), time: '12:00' };
  ok('Monday is not Friday', r.fallsOn(weekly, day('2026-09-21')), false);
  ok('Friday is', r.fallsOn(weekly, day('2026-09-25')), true);
  ok('first occurrence is that Friday', r.firstDueDate(weekly).toDateString(), 'Fri Sep 25 2026');

  // 29–31 clamp to the last day of a short month, or a "31st" schedule would
  // silently skip every month that has 30 days — and February always.
  const monthly = { frequency: 'MONTHLY', monthDay: 31, startDate: day('2026-11-01'), time: '18:00' };
  ok('30 Nov is the clamped 31st', r.fallsOn(monthly, day('2026-11-30')), true);
  ok('29 Nov is not', r.fallsOn(monthly, day('2026-11-29')), false);
  const feb = { frequency: 'MONTHLY', monthDay: 31, startDate: day('2027-02-01'), time: '18:00' };
  ok('28 Feb 2027 is the clamped 31st', r.fallsOn(feb, day('2027-02-28')), true);

  ok('daily is every day', r.fallsOn({ frequency: 'DAILY' }, day('2026-09-22')), true);

  const yearly = { frequency: 'YEARLY', month: 4, monthDay: 15, startDate: day('2026-01-01') };
  ok('15 April', r.fallsOn(yearly, day('2027-04-15')), true);
  ok('15 May is not', r.fallsOn(yearly, day('2027-05-15')), false);

  // The occurrence key is an IST day — the unique index that stops a restart
  // minting Monday twice.
  ok('key is the IST day', r.occurrenceKeyFor(new Date('2026-09-21T20:00:00Z')), '2026-09-22');
  const at = r.atTime(day('2026-09-21'), '09:30');
  ok('atTime honours HH:mm', `${at.getHours()}:${at.getMinutes()}`, '9:30');
}

// ===== 5. The model's hooks =====

async function rollUp(states, extra = {}) {
  const t = new Task({
    title: 'x',
    assignees: states.map((s, i) => ({
      user: [A, B, C][i],
      status: s,
      completedAt: ['COMPLETED', 'Done'].includes(s) ? new Date() : undefined,
    })),
    ...extra,
  });
  // Enum complaints about a legacy word are expected and harmless — the hooks
  // have already run by the time validation reports them.
  await t.validate().catch(() => {});
  return t;
}

async function testModel() {
  console.log('\nThe headline status is rolled up from the people on it');
  ok('nobody started', (await rollUp(['PENDING', 'PENDING', 'PENDING'])).status, 'PENDING');
  ok('one started', (await rollUp(['PENDING', 'IN_PROGRESS', 'PENDING'])).status, 'IN_PROGRESS');
  ok('one finished, two have not', (await rollUp(['COMPLETED', 'PENDING', 'PENDING'])).status, 'IN_PROGRESS');
  ok('everybody finished', (await rollUp(['COMPLETED', 'COMPLETED', 'COMPLETED'])).status, 'COMPLETED');
  // `SUBMITTED` is a CURRENT word again (2026-09-22), so the legacy check uses
  // one that is genuinely retired. `BLOCKED` meant "not done yet" to everybody
  // but the person holding it, which is IN_PROGRESS.
  ok('legacy words normalise first', (await rollUp(['BLOCKED', 'BLOCKED', 'BLOCKED'])).status, 'IN_PROGRESS');
  ok('everybody has handed in', (await rollUp(['SUBMITTED', 'SUBMITTED', 'SUBMITTED'])).status, 'SUBMITTED');
  ok('somebody taken off is ignored', (await rollUp(['CANCELLED', 'COMPLETED', 'COMPLETED'])).status, 'COMPLETED');

  const cancelled = await rollUp(['PENDING', 'PENDING']);
  cancelled.status = 'CANCELLED';
  await cancelled.validate().catch(() => {});
  ok('a cancellation is never rolled away', cancelled.status, 'CANCELLED');

  console.log('\nLate is decided per person and rolls up pessimistically');
  const due = new Date(Date.now() - 86400000);
  const mixed = new Task({
    title: 'x',
    dueDate: due,
    assignees: [
      { user: A, status: 'COMPLETED', completedAt: new Date(due.getTime() - 3600000), completedLate: false },
      { user: B, status: 'COMPLETED', completedAt: new Date(), completedLate: true },
    ],
  });
  await mixed.validate().catch(() => {});
  ok('one person late makes the task delayed', mixed.completedLate, true);

  console.log('\nPoints');
  const task = new Task({ title: 'x', assignees: [{ user: A }] });
  await task.validate().catch(() => {});
  ok('a task defaults to 100', task.points, c.DEFAULT_TASK_POINTS);
  const request = new Task({ title: 'x', kind: 'REQUEST', points: 500, assignees: [{ user: A }] });
  await request.validate().catch(() => {});
  ok('a request can never carry points', request.points, 0);

  console.log('\nLegacy rows are valid documents');
  const old = new Task({ title: 'x', assignedTo: A, status: 'Todo' });
  await old.validate().catch(() => {});
  ok('assignedTo grows into assignees[]', old.assignees.length, 1);
  ok('and its status is mapped', old.status, 'PENDING');
  ok('assignedTo mirrors the first assignee', String((await rollUp(['PENDING', 'PENDING'])).assignedTo), String(A));

  console.log('\nWho hears about it');
  const t = new Task({ title: 'x', createdBy: C, assignees: [{ user: A }], loopUsers: [B] });
  ok('assigner + doer + loop', t.audience().length, 3);
  ok('isDoer knows the doer', t.isDoer(A), true);
  ok('isDoer says no to the assigner', t.isDoer(C), false);
  ok('isAssigner knows the assigner', t.isAssigner(C), true);
}

// ===== 6. Acceptance, delegation and subtasks (2026-09-21, second pass) =====

async function testAcceptance() {
  console.log('\nAcceptance is a SEPARATE AXIS from status');
  const awaiting = await rollUp(['PENDING', 'PENDING']);
  ok('a fresh task is awaiting acceptance', c.isAwaitingAcceptance(awaiting), true);
  ok('…and is not declined', c.isDeclined(awaiting), false);

  // One person says no, the other has not answered.
  const one = await rollUp(['PENDING', 'PENDING']);
  one.assignees[0].acceptance = c.ACCEPTANCE.REJECTED;
  await one.validate().catch(() => {});
  ok('one refusal is not a declined task', c.isDeclined(one), false);
  ok('…and somebody is still to answer', c.isAwaitingAcceptance(one), true);

  // Everybody says no.
  const all = await rollUp(['PENDING', 'PENDING']);
  all.assignees.forEach((a) => { a.acceptance = c.ACCEPTANCE.REJECTED; });
  await all.validate().catch(() => {});
  ok('everybody refusing IS a declined task', c.isDeclined(all), true);
  ok('…and nobody is left to answer', c.isAwaitingAcceptance(all), false);

  console.log('\nA refusal must not hold the roll-up open');
  // The one that matters: four finish, one declined — that is a FINISHED task,
  // not one stuck In progress for ever.
  const mixed = await rollUp(['COMPLETED', 'PENDING']);
  mixed.assignees[1].acceptance = c.ACCEPTANCE.REJECTED;
  await mixed.validate().catch(() => {});
  ok('the decliner is ignored, so the task completes', mixed.status, 'COMPLETED');

  // …but a task EVERYBODY declined is still owed, so it stays PENDING.
  const none = await rollUp(['PENDING', 'PENDING']);
  none.assignees.forEach((a) => { a.acceptance = c.ACCEPTANCE.REJECTED; });
  await none.validate().catch(() => {});
  ok('a fully-declined task is still PENDING', none.status, 'PENDING');
}

async function testSubtasksAndFollowers() {
  console.log('\nPieces are tasks of their own, and points are a pool');
  const parent = new Task({
    title: 'x', createdBy: C, assignees: [{ user: A }], points: 100,
  });
  await parent.validate().catch(() => {});
  ok('nothing handed out yet, so the whole pool is earned', parent.effectivePoints(), 100);

  parent.distributedPoints = 60;
  await parent.validate().catch(() => {});
  ok('60 handed down leaves 40 on the parent', parent.effectivePoints(), 40);

  // THE RULE THAT IS MONEY: the pieces can never be worth more than the task.
  parent.distributedPoints = 500;
  await parent.validate().catch(() => {});
  ok('a distribution larger than the pool is clamped, not stored',
    parent.distributedPoints, 100);
  ok('…and the parent then earns nothing, never a negative', parent.effectivePoints(), 0);

  console.log('\nSharing the points out');
  const share = (items, budget) => engine.shareOut(items, budget);
  ok('100 over three comes out WHOLE, not 33/33/33',
    share([{}, {}, {}], 100), [34, 33, 33]);
  ok('100 over four is even', share([{}, {}, {}, {}], 100), [25, 25, 25, 25]);
  ok('an explicit figure is honoured and the rest shared',
    share([{ points: 50 }, {}, {}], 100), [50, 25, 25]);
  ok('nothing left over is 0 each, not a negative',
    share([{ points: 100 }, {}], 100), [100, 0]);
  ok('a split bigger than the pool is refused', (() => {
    try { share([{ points: 80 }, { points: 80 }], 100); return 'allowed'; } catch { return 'refused'; }
  })(), 'refused');

  console.log('\nHanding it in, and the two answers');
  ok('a doer\'s Complete becomes a submission',
    c.effectiveTarget({ kind: 'TASK', requiresApproval: true, createdBy: C }, 'doer', 'COMPLETED', A),
    'SUBMITTED');
  ok('…unless the task needs no review',
    c.effectiveTarget({ kind: 'TASK', requiresApproval: false, createdBy: C }, 'doer', 'COMPLETED', A),
    'COMPLETED');
  ok('…and never for the person who SET it',
    c.effectiveTarget({ kind: 'TASK', requiresApproval: true, createdBy: A }, 'doer', 'COMPLETED', A),
    'COMPLETED');
  ok('a request is answered, not reviewed',
    c.effectiveTarget({ kind: 'REQUEST', requiresApproval: true, createdBy: C }, 'doer', 'COMPLETED', A),
    'COMPLETED');
  ok('an assigner completing is not redirected',
    c.effectiveTarget({ kind: 'TASK', requiresApproval: true, createdBy: C }, 'assigner', 'COMPLETED', C),
    'COMPLETED');
  ok('SUBMITTED → COMPLETED is the assigner\'s',
    c.transitionFor('SUBMITTED', 'COMPLETED').by, ['assigner']);
  ok('SUBMITTED → IN_PROGRESS (sent back) is the assigner\'s',
    c.transitionFor('SUBMITTED', 'IN_PROGRESS').by, ['assigner']);
  ok('a doer cannot approve their own submission',
    c.transitionFor('SUBMITTED', 'COMPLETED').by.includes('doer'), false);

  console.log('\nIn review is not overdue');
  const past = new Date(Date.now() - 86400000);
  ok('an unstarted task past its deadline IS overdue',
    c.isOverdue({ status: 'PENDING', dueDate: past }), true);
  // Handed in on Friday, read on Monday: that is the tray's delay, not the
  // doer's, and painting it red would blame the wrong person.
  ok('one that has been handed in is NOT',
    c.isOverdue({ status: 'SUBMITTED', dueDate: past }), false);

  console.log('\nThe roll-up knows the review desk');
  const two = new Task({
    title: 'x', createdBy: C,
    assignees: [
      { user: A, status: 'SUBMITTED', submittedAt: new Date() },
      { user: B, status: 'IN_PROGRESS' },
    ],
  });
  await two.validate().catch(() => {});
  ok('one handed in, one still working → still in progress', two.status, 'IN_PROGRESS');

  two.assignees[1].status = 'SUBMITTED';
  two.assignees[1].submittedAt = new Date();
  await two.validate().catch(() => {});
  ok('both handed in → in review', two.status, 'SUBMITTED');

  two.assignees[0].status = 'COMPLETED';
  two.assignees[0].completedAt = new Date();
  await two.validate().catch(() => {});
  ok('one approved, one still in the tray → still in review', two.status, 'SUBMITTED');

  console.log('\nProgress');
  const prog = new Task({
    title: 'x', createdBy: C,
    assignees: [{ user: A, progress: 40 }, { user: B, progress: 80 }],
  });
  await prog.validate().catch(() => {});
  ok('the task shows the mean of its people', prog.progress, 60);

  prog.assignees[0].status = 'SUBMITTED';
  prog.assignees[0].submittedAt = new Date();
  await prog.validate().catch(() => {});
  ok('a handed-in row counts as 100 however it was left', prog.progress, 90);

  // A parent's bar is the engine's job (recomputeParent), from its pieces —
  // overwriting it from the assignee rows would reset a 70%-done delegated task
  // to zero on every save.
  const split = new Task({
    title: 'x', createdBy: C, assignees: [{ user: A, progress: 0 }],
    childCount: 2, progress: 70,
  });
  await split.validate().catch(() => {});
  ok('a task WITH pieces keeps the figure its pieces gave it', split.progress, 70);

  console.log('\nA row read back from Mongo is normalised');
  /**
   * `Task.hydrate` is the one way to exercise post('init') without a database:
   * it builds a document from a plain object exactly as a query would, hooks
   * and all. `new Task({...})` does NOT fire it, which is why this reads the
   * way it does.
   */
  const stored = Task.hydrate({
    _id: uid(), title: 'x', createdBy: C, status: 'ASSIGNED', priority: 'High',
    assignees: [{ user: A, status: 'ASSIGNED' }],
  });
  ok('a stored ASSIGNED reads as PENDING', stored.status, 'PENDING');
  ok('...on the assignee row too', stored.assignees[0].status, 'PENDING');
  ok('a stored High reads as Urgent', stored.priority, 'Urgent');
  // The engine's optimistic claim matches the STORED word, so it has to survive.
  ok('the raw word is kept for the claim', stored.$locals.rawStatus, 'ASSIGNED');
  ok('...so the claim still matches what is in Mongo',
    c.spellingsOf(stored.status).includes('ASSIGNED'), true);
  // The whole point: TRANSITIONS is keyed on the current words only.
  ok('a legacy row now has legal moves',
    (c.TRANSITIONS[stored.status] || []).length > 0, true);
  ok('...which it did NOT have before', (c.TRANSITIONS.ASSIGNED || []).length, 0);

  const doneRow = Task.hydrate({ _id: uid(), title: 'x', createdBy: C, status: 'Done' });
  ok('the pre-2026-09-17 Done reads as COMPLETED', doneRow.status, 'COMPLETED');

  console.log('\nAn aggregation cannot call normaliseStatus');
  const stage = c.normaliseStatusStage();
  const branches = stage.$addFields.status.$switch.branches;
  ok('every legacy word has a branch',
    branches.length, Object.keys(c.LEGACY_STATUS_MAP).length);
  ok('ASSIGNED is rewritten to PENDING',
    branches.find((b) => b.case.$eq[1] === 'ASSIGNED').then, 'PENDING');

  console.log('\nWhoever first had it keeps hearing about it');
  const handed = new Task({ title: 'x', createdBy: C, assignees: [{ user: A }] });
  await handed.validate().catch(() => {});
  ok('originalAssignees is stamped on creation', handed.originalAssignees.map(String), [String(A)]);

  // A delegates to B: A leaves `assignees` but stays in the audience.
  handed.assignees = [{ user: B, delegatedFrom: A }];
  await handed.validate().catch(() => {});
  ok('the delegator is no longer a doer', handed.isDoer(A), false);
  ok('…but still hears about it', handed.audience().includes(String(A)), true);
  ok('…and the new owner hears too', handed.audience().includes(String(B)), true);

  // The stamp must NOT be rewritten on a later save, or the history it exists
  // to keep is silently replaced by whoever holds the task now.
  ok('the stamp is never rewritten', handed.originalAssignees.map(String), [String(A)]);
}

// ===== A row from before `kind` existed (2026-09-24) =====

function testLegacyRows() {
  console.log('\nA row from before `kind` existed');
  // A schema default is applied on hydration, never inside a query, so a
  // filter naming a kind has to let a missing one through as a TASK — or the
  // pre-rework rows vanish from every list while the Tasks badge counts them.
  ok('a TASK filter also matches a missing kind', c.kindFilter(c.KIND_TASK), { $in: ['TASK', null] });
  ok('a REQUEST filter is exact', c.kindFilter(c.KIND_REQUEST), 'REQUEST');

  // What the list reads: a LEAN row, straight from Mongo, in the old words —
  // the shape of the 57 "Documents Submission" rows.
  const lean = {
    _id: uid(), title: 'Documents Submission', status: 'ASSIGNED', createdBy: C,
    requiresApproval: false, assignees: [{ user: A, status: 'ASSIGNED' }],
  };
  const row = decorate(lean);
  ok('…reads as a task', row.kind, 'TASK');
  ok('…in the current word', row.status, 'PENDING');
  ok('…worth the default points', row.effectivePoints, c.DEFAULT_TASK_POINTS);
  ok('…and not yet accepted', row.awaitingAcceptance, true);

  // The detail page reads the same row HYDRATED (defaults + post('init')); the
  // list reads it lean and decorated. They must offer the same buttons.
  const doer = { _id: A, role: 'Employee', permissions: [] };
  const fromList = access.capabilitiesFor(doer, row);
  ok('the list offers what the detail page offers',
    fromList, access.capabilitiesFor(doer, Task.hydrate(lean)));
  ok('…which includes Accept', fromList.canAccept, true);
  ok('…and a way to start it', fromList.transitions.some((t) => t.to === 'IN_PROGRESS'), true);
}

// ===== The date chips (2026-09-24) =====

async function testDateChips() {
  console.log('\nThe date chips: open work always shows on the ones that contain today');
  // The Tasks badge counts every open task; the page opens on This month. A
  // strict window let a task due last month, next month or never badge over
  // an empty page. buildQuery touches no database, so it is testable here.
  const req = { user: { _id: A, role: 'Employee', permissions: [] }, query: {} };
  const open = c.spellingsOf(...c.OPEN_STATUS);
  const clauses = (f) => f.$and || [];
  const carried = (f) => clauses(f).some((x) => Array.isArray(x.$or)
    && x.$or.some((b) => b.dueDate)
    && x.$or.some((b) => JSON.stringify(b.status?.$in) === JSON.stringify(open)));
  const strict = (f) => clauses(f).some((x) => x.dueDate && !x.$or);

  for (const range of ['today', 'week', 'month']) {
    ok(`${range}: open work carries in`, carried(await buildQuery(req, { scope: 'mine', range })), true);
  }
  for (const range of ['yesterday', 'nextWeek']) {
    const f = await buildQuery(req, { scope: 'mine', range });
    ok(`${range}: strict`, [carried(f), strict(f)], [false, true]);
  }
  const custom = await buildQuery(req, { scope: 'mine', range: 'custom', from: '2026-09-01', to: '2026-09-30' });
  ok('custom: strict', [carried(custom), strict(custom)], [false, true]);

  const report = await buildQuery(req, { scope: 'mine', range: 'month' }, { strictRange: true });
  ok('the dashboard stays strict', [carried(report), strict(report)], [false, true]);
  ok('…and a client cannot ask for that',
    carried(await buildQuery({ ...req, query: { strictRange: '1' } }, { scope: 'mine', range: 'month' })), true);

  // "Open" is everything not finished: a task in review is still owed a word.
  ok('open includes in review and the legacy words',
    ['PENDING', 'IN_PROGRESS', 'SUBMITTED', 'ASSIGNED', 'UNDER_REVIEW'].every((s) => open.includes(s)), true);
  ok('…but not done or called off',
    ['COMPLETED', 'CANCELLED', 'Done', 'APPROVED', 'DECLINED'].some((s) => open.includes(s)), false);
}

// ===== 2026-09-25: anybody assigns anybody, yourself included =====

async function testAnyoneAssigns() {
  console.log('\nAnybody may be given a task (2026-09-25)');
  const junior = { _id: A, role: 'Employee', permissions: [] };

  ok('an assignment is always a task',
    (await access.resolveAssignmentKind(junior, [String(B)])).kind, 'TASK');
  ok('…even when an old app asks for a request',
    (await access.resolveAssignmentKind(junior, [String(B)], 'REQUEST')).kind, 'TASK');
  let refused = null;
  try { await access.resolveAssignmentKind(junior, []); } catch (e) { refused = e.status; }
  ok('…but somebody still has to be named', refused, 400);

  // Nobody scores a task they set themselves — checked before any settings or
  // database read, so this is pure.
  const points = require('../services/taskPoints');
  const own = new Task({ title: 'x', createdBy: A, points: 100, assignees: [{ user: A }] });
  ok('the setter earns nothing on their own task', await points.award(own, own.assignees[0], junior), null);
  ok('…and the row is left unstamped', own.assignees[0].pointsAwardedAt, undefined);

  const req = (query = {}) => ({ user: junior, query });
  const clauses = (f) => f.$and || [];

  // Requests are listed with the tasks now; only the old Requests tab and an
  // explicit ask filter on kind.
  ok('no kind asked for: every row, requests included',
    clauses(await buildQuery(req(), { scope: 'mine' })).some((x) => 'kind' in x), false);
  ok('an old app\'s Requests tab still gets its pile',
    clauses(await buildQuery(req(), { scope: 'requests' })).some((x) => x.kind === 'REQUEST'), true);
  ok('the dashboard\'s explicit TASK still narrows',
    clauses(await buildQuery(req(), { scope: 'mine', kind: 'TASK' })).some((x) => 'kind' in x), true);

  const searched = clauses(await buildQuery(req(), { scope: 'mine', q: 'ravi' }))
    .find((x) => Array.isArray(x.$or) && x.$or.some((b) => b.title));
  ok('search reaches the assignee and the assigner',
    ['assignees.name', 'createdByName', 'assignees.employeeCode']
      .every((k) => searched?.$or.some((b) => k in b)), true);

  ok('Pending can be asked for without the late ones',
    clauses(await buildQuery(req(), { scope: 'mine', overdue: 'false' })).some((x) => Array.isArray(x.$nor)), true);

  // The department filter reads profiles — stubbed, so still no database.
  const EmployeeProfile = require('../models/EmployeeProfile');
  const realFind = EmployeeProfile.find;
  let asked = null;
  EmployeeProfile.find = (q) => {
    asked = q;
    return { select: () => ({ lean: async () => [{ user: B }, { user: C }] }) };
  };
  try {
    const dept = async (scope) => clauses(await buildQuery(req(), { scope, department: 'Sales' }));
    ok('department on "to me" = where the work came from',
      (await dept('mine')).some((x) => x.createdBy?.$in?.length === 2), true);
    ok('department on "by me" = where it went',
      (await dept('delegated')).some((x) => x['assignees.user']?.$in?.length === 2), true);
    ok('department elsewhere = either side',
      (await dept('all')).some((x) => Array.isArray(x.$or) && x.$or.some((b) => b.createdBy) && x.$or.some((b) => b['assignees.user'])), true);
    const rx = asked?.department?.$in?.[0];
    ok('…matched exactly, so Sales is not Sales & Marketing',
      [rx?.test('Sales'), rx?.test('sales'), rx?.test('Sales & Marketing')], [true, true, false]);
  } finally {
    EmployeeProfile.find = realFind;
  }
}

// ===== 2026-09-25: setting a task on somebody else's behalf =====

async function testOnBehalf() {
  console.log("\nOn somebody else's behalf (2026-09-25)");
  const assistant = { _id: A, role: 'Employee', permissions: [], taskProxyAccess: true };
  const director = { _id: C, role: 'Employee', permissions: [] };
  ok('the grant opens it', access.canAssignOnBehalf(assistant), true);
  ok('without it, no', access.canAssignOnBehalf({ _id: B, role: 'Employee', permissions: [] }), false);
  ok('a Super Admin holds it by role', access.canAssignOnBehalf({ _id: B, role: 'SuperAdmin' }), true);

  // Set BY the director (createdBy), SENT by the assistant, for B.
  const task = { createdBy: C, onBehalf: { by: A, byName: 'Asha' }, assignees: [{ user: B }] };
  // The sender KEEPS NOTHING (user decision the same day — the first cut
  // listed it under their "Assigned by me" and had them follow it).
  ok('the sender can no longer open it', access.canSee(assistant, task), false);
  ok('…may not approve it', access.capabilitiesFor(assistant, { ...task, status: 'SUBMITTED' }).canApprove, false);
  ok('…nor edit it', access.capabilitiesFor(assistant, { ...task, status: 'PENDING' }).canEdit, false);
  ok('…nor comment on it', access.capabilitiesFor(assistant, { ...task, status: 'PENDING' }).canComment, false);
  ok('the person it was set for approves it',
    access.capabilitiesFor(director, { ...task, status: 'SUBMITTED' }).canApprove, true);
  ok('a sender who is also ON it sees it as a doer',
    access.canSee(assistant, { ...task, assignees: [{ user: B }, { user: A }] }), true);

  const mine = await access.visibleFilter({ user: assistant, query: {} }, 'delegated');
  ok('it is not in the sender\'s "Assigned by me"', JSON.stringify(mine).includes('onBehalf'), false);
  const all = await access.visibleFilter({ user: assistant, query: {} }, 'all');
  ok('…nor anywhere else they look', JSON.stringify(all).includes('onBehalf'), false);

  const doc = new Task({ title: 'x', createdBy: C, onBehalf: { by: A, byName: 'Asha' }, assignees: [{ user: B }] });
  ok('the sender hears nothing more (audience)', doc.audience().includes(String(A)), false);
  ok('the person it was set for does', doc.audience().includes(String(C)), true);
}

// ===== 2026-09-27: edit lock + trail, the bell, routine dailies, recurring shapes =====

function testEditLock() {
  console.log('\nEditing — only until it is taken on (2026-09-27)');
  const setter = { _id: C, role: 'Employee', permissions: [] };
  const base = { createdBy: C, status: 'PENDING', assignees: [{ user: B, status: 'PENDING', acceptance: 'AWAITING', name: 'Bina' }] };
  ok('unanswered: the terms are open', c.termsOpen(base), true);
  ok('…and the setter may edit', access.capabilitiesFor(setter, base).canEdit, true);
  ok('…with no lock reason', access.capabilitiesFor(setter, base).editLocked, null);

  const accepted = { ...base, status: 'IN_PROGRESS', assignees: [{ user: B, status: 'IN_PROGRESS', acceptance: 'ACCEPTED', name: 'Bina' }] };
  ok('accepted: locked', c.termsOpen(accepted), false);
  ok('…so no Edit', access.capabilitiesFor(setter, accepted).canEdit, false);
  ok('…and the reason names who took it', /Bina has accepted/.test(access.capabilitiesFor(setter, accepted).editLocked), true);

  // Accepted but not started is impossible now (accepting starts it), but an
  // old row can say so — still locked.
  const acceptedPending = { ...base, assignees: [{ user: B, status: 'PENDING', acceptance: 'ACCEPTED' }] };
  ok('accepted-but-pending (legacy): locked', c.termsOpen(acceptedPending), false);

  const refused = { ...base, assignees: [{ user: B, status: 'PENDING', acceptance: 'REJECTED' }] };
  ok('refused: open — the setter has to fix it', c.termsOpen(refused), true);

  const mixed = { ...base, assignees: [
    { user: B, status: 'PENDING', acceptance: 'AWAITING' },
    { user: A, status: 'IN_PROGRESS', acceptance: 'ACCEPTED' },
  ] };
  ok('one of two took it: locked for both', c.termsOpen({ ...mixed, status: 'IN_PROGRESS' }), false);
  ok('a legacy ASSIGNED row is still open', c.termsOpen({ ...base, status: 'ASSIGNED', assignees: [{ user: B, status: 'ASSIGNED' }] }), true);
  ok('a doer never edits', access.capabilitiesFor({ _id: B, role: 'Employee', permissions: [] }, base).canEdit, false);

  let threw = null;
  try { access.assertCanEdit(setter, accepted); } catch (e) { threw = e.status; }
  ok('the server refuses a locked edit with 409', threw, 409);
  threw = null;
  try { access.assertCanEdit({ _id: A, role: 'Employee', permissions: [] }, base); } catch (e) { threw = e.status; }
  ok('…and a stranger with 403', threw, 403);
}

function testNudge() {
  console.log('\nThe reminder bell (2026-09-27)');
  const setter = { _id: C, role: 'Employee', permissions: [] };
  const doer = { _id: B, role: 'Employee', permissions: [] };
  const pending = { createdBy: C, status: 'PENDING', assignees: [{ user: B, status: 'PENDING', acceptance: 'AWAITING' }] };
  ok('not accepted: the setter can ring the doer', access.nudgeTargets(setter, pending), { kind: 'DOER', to: [String(B)] });
  ok('…the doer cannot ring anyone', access.nudgeTargets(doer, pending), null);
  const going = { ...pending, status: 'IN_PROGRESS', assignees: [{ user: B, status: 'IN_PROGRESS', acceptance: 'ACCEPTED' }] };
  ok('in progress: the setter can ring', access.capabilitiesFor(setter, going).nudgeTo, 'doers');
  const late = { ...going, dueDate: new Date(Date.now() - 3600e3) };
  ok('overdue: still can', access.capabilitiesFor(setter, late).canNudge, true);
  const review = { createdBy: C, status: 'SUBMITTED', assignees: [{ user: B, status: 'SUBMITTED', acceptance: 'ACCEPTED' }] };
  ok('in review: the doer rings the approver', access.nudgeTargets(doer, review), { kind: 'REVIEW', to: [String(C)] });
  ok('…the setter has nobody to ring', access.nudgeTargets(setter, review), null);
  const delegated = { ...review, approver: A };
  ok('after a delegation it rings the delegator', access.nudgeTargets(doer, delegated).to, [String(A)]);
  ok('done: no bell', access.nudgeTargets(setter, { ...going, status: 'COMPLETED' }), null);
  const refused = { ...pending, assignees: [{ user: B, status: 'PENDING', acceptance: 'REJECTED' }] };
  ok('nobody rings a person who refused', access.nudgeTargets(setter, refused), null);
  ok('own task: no bell', access.nudgeTargets(setter, { createdBy: C, status: 'PENDING', assignees: [{ user: C, status: 'PENDING' }] }), null);

  const now = new Date('2026-09-27T10:00:00Z');
  ok('never rung: ready now', c.nudgeReadyAt({}, now), null);
  ok('rung 10 min ago: ready in 20',
    c.nudgeReadyAt({ lastNudgeAt: new Date(now - 10 * 60e3) }, now).toISOString(), '2026-09-27T10:20:00.000Z');
  ok('rung 31 min ago: ready now', c.nudgeReadyAt({ lastNudgeAt: new Date(now - 31 * 60e3) }, now), null);
  // Per direction: the setter's reminder does not block the doer's review ping.
  const rang = { lastNudgeAt: new Date(now - 5 * 60e3), nudgeAt: { DOER: new Date(now - 5 * 60e3) } };
  ok('the doer-chase gate is shut…', Boolean(c.nudgeReadyAt(rang, now, 'DOER')), true);
  ok('…the review-chase gate is open', c.nudgeReadyAt(rang, now, 'REVIEW'), null);
}

function testRoutine() {
  console.log('\nA daily occurrence is routine — only Done (2026-09-27)');
  const doer = { _id: B, role: 'Employee', permissions: [] };
  const setter = { _id: C, role: 'Employee', permissions: [] };
  const task = {
    routine: true, createdBy: C, status: 'IN_PROGRESS', requiresApproval: false, dueDate: new Date(Date.now() + 3600e3),
    assignees: [{ user: B, status: 'IN_PROGRESS', acceptance: 'ACCEPTED' }], kind: 'TASK',
  };
  const can = access.capabilitiesFor(doer, task);
  ok('the doer may mark it done', can.canDone, true);
  ok('…and that is the only move', can.transitions.map((t) => t.to), ['COMPLETED']);
  ok('no accept / decline / delegate / split / review / more time',
    [can.canAccept, can.canDecline, can.canDelegate, can.canSplit, can.canSubmit, can.canRequestExtension, can.canTransfer],
    [false, false, false, false, false, false, false]);
  const boss = access.capabilitiesFor(setter, task);
  ok('the setter may still call it off', boss.transitions.map((t) => t.to).includes('CANCELLED'), true);
  ok('…and ring the doer', boss.canNudge, true);
  ok('daily is routine; weekly is not', [c.isRoutineFrequency('DAILY'), c.isRoutineFrequency('WEEKLY')], [true, false]);
}

function testRecurrenceShapes() {
  console.log('\nRecurring shapes, in IST (2026-09-27)');
  const s = (o) => ({ time: '18:00', startDate: new Date('2026-09-01T00:00:00+05:30'), ...o });
  ok('due time is IST 6 pm, whatever the server zone', r.atIST('2026-09-27', '18:00').toISOString(), '2026-09-27T12:30:00.000Z');
  ok('the key of 11:59 pm IST is still that day', r.occurrenceKeyFor(new Date('2026-09-27T18:29:00Z')), '2026-09-27');
  ok('…and 12:01 am IST is the next', r.occurrenceKeyFor(new Date('2026-09-27T18:31:00Z')), '2026-09-28');

  const alt = s({ frequency: 'DAILY', interval: 2 });
  ok('alternate days: the start', r.fallsOn(alt, '2026-09-01'), true);
  ok('…not the day after', r.fallsOn(alt, '2026-09-02'), false);
  ok('…the day after that', r.fallsOn(alt, '2026-09-03'), true);
  ok('every 3 days: 1st, 4th, 7th', ['2026-09-04', '2026-09-05', '2026-09-07'].map((k) => r.fallsOn(s({ frequency: 'DAILY', interval: 3 }), k)), [true, false, true]);
  ok('nothing before the start', r.fallsOn(alt, '2026-08-30'), false);

  const firstMon = s({ frequency: 'MONTHLY', monthlyMode: 'WEEKDAY', nthWeek: 1, weekday: 1 });
  ok('first Monday of Oct 2026 is the 5th', r.fallsOn(firstMon, '2026-10-05'), true);
  ok('…the 12th is not', r.fallsOn(firstMon, '2026-10-12'), false);
  const lastFri = s({ frequency: 'MONTHLY', monthlyMode: 'WEEKDAY', nthWeek: -1, weekday: 5 });
  ok('last Friday of Oct 2026 is the 30th', r.fallsOn(lastFri, '2026-10-30'), true);
  ok('…the 23rd is not', r.fallsOn(lastFri, '2026-10-23'), false);
  const thirdWed = s({ frequency: 'MONTHLY', monthlyMode: 'WEEKDAY', nthWeek: 3, weekday: 3 });
  ok('third Wednesday of Sep 2026 is the 16th', r.fallsOn(thirdWed, '2026-09-16'), true);

  const monthly15 = s({ frequency: 'MONTHLY', monthDay: 15 });
  ok('a monthly task appears 2 days early, at 9 am',
    r.appearAt({ ...monthly15, leadDays: 2 }, '2026-10-15').toISOString(), '2026-10-13T03:30:00.000Z');
  ok('…a daily one at 9 am on its day', r.appearAt(s({ frequency: 'DAILY' }), '2026-10-15').toISOString(), '2026-10-15T03:30:00.000Z');
  ok('…a daily one due 9:30 am an hour before',
    r.appearAt(s({ frequency: 'DAILY', time: '09:30' }), '2026-10-15').toISOString(), '2026-10-15T03:00:00.000Z');
  ok('default lead: monthly 2, daily 0', [r.leadDaysOf({ frequency: 'MONTHLY' }), r.leadDaysOf({ frequency: 'DAILY' })], [2, 0]);

  const created7pm = new Date('2026-09-27T13:30:00Z'); // 7 pm IST
  const daily6 = s({ frequency: 'DAILY', mintFrom: created7pm });
  ok('set up at 7 pm for 6 pm: starts tomorrow, not overdue',
    r.nextOccurrence(daily6, created7pm).key, '2026-09-28');
  ok('the next first Monday after 5 Oct is 2 Nov', r.nextOccurrence(firstMon, new Date('2026-10-06T00:00:00+05:30')).key, '2026-11-02');

  ok('labels: alternate days', c.patternLabel(alt), 'Alternate days · 6:00 PM');
  ok('labels: first Monday', c.patternLabel(firstMon), 'Monthly on the first Monday · 6:00 PM');
  ok('labels: last Friday', c.patternLabel(lastFri), 'Monthly on the last Friday · 6:00 PM');
  ok('labels: weekly', c.patternLabel(s({ frequency: 'WEEKLY', weekdays: [3, 1] })), 'Weekly on Mon, Wed · 6:00 PM');
  ok('labels: the 15th', c.patternLabel(monthly15), 'Monthly on the 15th · 6:00 PM');
}

function testRepeatReminder() {
  console.log('\n"Every 2 hours until done" (2026-09-27)');
  const rule = { channel: 'APP', amount: 2, unit: 'HOURS', when: 'EVERY' };
  const anchor = new Date('2026-09-27T03:30:00Z').getTime(); // 9 am IST
  ok('nothing before the first beat', c.repeatSlot(rule, anchor, anchor + 60 * 60e3), null);
  ok('beat 1 at 11 am', c.repeatSlot(rule, anchor, anchor + 2 * 3600e3 + 5 * 60e3).index, 1);
  ok('beat 3 at 3 pm', new Date(c.repeatSlot(rule, anchor, anchor + 6.2 * 3600e3).at).toISOString(), '2026-09-27T09:30:00.000Z');
  ok('never faster than 30 min', c.repeatEveryMinutes({ amount: 5, unit: 'MINUTES', when: 'EVERY' }), 30);
  ok('its label', c.reminderLabel(rule), 'Every 2 hours until done');
  const worker = require('../services/taskReminderWorker');
  ok('3 pm IST speaks', worker.inActiveHours(new Date('2026-09-27T09:30:00Z').getTime()), true);
  ok('11 pm IST is quiet', worker.inActiveHours(new Date('2026-09-27T17:30:00Z').getTime()), false);
  const { cleanReminders } = require('../controllers/taskController');
  const cleaned = cleanReminders([rule, { ...rule, amount: 3 }, { channel: 'APP', amount: 1, unit: 'DAYS', when: 'BEFORE' }]);
  ok('only one repeating rule is kept', cleaned.filter((x) => x.when === 'EVERY').length, 1);
  ok('…alongside the others', cleaned.length, 2);

  // ===== The SHAPES (2026-09-27: "these options should be for sending
  // notifications too" — hourly on the clock, daily, weekly, monthly) =====
  const IST = (s) => new Date(`${s}+05:30`).getTime();
  const iso = (b) => (b ? new Date(b.at).toISOString() : null);
  const t9 = IST('2026-09-27T09:00:00'); // a Sunday, when the task appeared
  ok('hourly: nothing within 30 min of it appearing', iso(worker.latestBeat(rule, t9, IST('2026-09-27T09:40:00'))), null);
  ok('hourly: on the clock — 11 am', iso(worker.latestBeat(rule, t9, IST('2026-09-27T11:05:00'))), '2026-09-27T05:30:00.000Z');
  const win = { ...rule, pattern: 'HOURLY', amount: 3, from: '10:00', to: '18:00' };
  ok('hourly in a 10–6 window, every 3 hours: 4 pm', iso(worker.latestBeat(win, t9, IST('2026-09-27T17:00:00'))), '2026-09-27T10:30:00.000Z');
  ok('…its label', c.reminderLabel(win), 'Every 3 hours, 10:00 AM – 6:00 PM, until done');
  ok('hourly stops at the end of the due day', new Date(worker.beatsStopAt(rule, IST('2026-09-27T18:00:00'))).toISOString(), '2026-09-27T15:30:00.000Z');

  const alt = { channel: 'APP', when: 'EVERY', pattern: 'DAILY', amount: 2, unit: 'DAYS', at: '10:00' };
  ok('alternate days: the day it appeared', iso(worker.latestBeat(alt, t9, IST('2026-09-27T10:05:00'))), '2026-09-27T04:30:00.000Z');
  ok('…not the day between', worker.latestBeat(alt, t9, IST('2026-09-28T10:05:00')).at < IST('2026-09-28T00:00:00'), true);
  ok('…the day after that', iso(worker.latestBeat(alt, t9, IST('2026-09-29T10:05:00'))), '2026-09-29T04:30:00.000Z');
  ok('…its label', c.reminderLabel(alt), 'Alternate days at 10:00 AM until done');
  ok('a day-shaped one goes on a week past the deadline',
    new Date(worker.beatsStopAt(alt, IST('2026-09-27T18:00:00'))).toISOString(), '2026-10-04T12:30:00.000Z');

  const monThu = { channel: 'APP', when: 'EVERY', pattern: 'WEEKLY', weekdays: [4, 1], at: '09:30' };
  ok('weekly Mon + Thu: Monday 9:30', iso(worker.latestBeat(monThu, t9, IST('2026-09-28T09:40:00'))), '2026-09-28T04:00:00.000Z');
  ok('…nothing new on Tuesday', worker.latestBeat(monThu, t9, IST('2026-09-29T09:40:00')).at < IST('2026-09-29T00:00:00'), true);
  ok('…its label', c.reminderLabel(monThu), 'Every Mon, Thu at 9:30 AM until done');

  const firstMon = { channel: 'APP', when: 'EVERY', pattern: 'MONTHLY', monthlyMode: 'WEEKDAY', nthWeek: 1, weekday: 1, at: '11:00' };
  ok('monthly, the first Monday: 5 Oct', iso(worker.latestBeat(firstMon, t9, IST('2026-10-05T11:10:00'))), '2026-10-05T05:30:00.000Z');
  ok('…not the second Monday', worker.latestBeat(firstMon, t9, IST('2026-10-12T11:10:00')), null);
  ok('…its label', c.reminderLabel(firstMon), 'Monthly on the first Monday at 11:00 AM until done');

  const shaped = cleanReminders([
    { channel: 'APP', when: 'EVERY', pattern: 'WEEKLY', weekdays: [5, 1, 1, 9], at: '9:05' },
  ])[0];
  ok('weekly cleaned: days deduped, sorted, in range; time padded',
    JSON.stringify([shaped.weekdays, shaped.at]), JSON.stringify([[1, 5], '09:05']));
  ok('a weekly one with no day ticked is dropped',
    cleanReminders([{ channel: 'APP', when: 'EVERY', pattern: 'WEEKLY', weekdays: [] }]).length, 0);
  ok('hourly: never slower than every 12 hours',
    cleanReminders([{ channel: 'APP', when: 'EVERY', pattern: 'HOURLY', amount: 30, unit: 'HOURS' }])[0].amount, 12);
  ok('an older "every 1 day" reads as daily at 10 am',
    c.reminderLabel(cleanReminders([{ channel: 'APP', when: 'EVERY', amount: 1, unit: 'DAYS' }])[0]),
    'Every day at 10:00 AM until done');
}

// ===== 2026-09-28: two Super Admin grants, and editing a task you are also on =====

function testSeptember28() {
  console.log('\nRecurring + reminders are grants; edit any task before it is accepted (2026-09-28)');
  const emp = (extra = {}) => ({ _id: A, role: 'Employee', permissions: [], ...extra });
  ok('recurring: a Super Admin by role', access.canManageRecurring({ _id: A, role: 'SuperAdmin' }), true);
  ok('recurring: an employee with the switch', access.canManageRecurring(emp({ taskRecurringAccess: true })), true);
  ok('recurring: not without it', access.canManageRecurring(emp()), false);
  // An HR Manager with no list holds every catalogued capability — and still
  // not this: it is an explicit list, not a capability.
  ok('recurring: not implied by holding every capability', access.canManageRecurring({ _id: A, role: 'HRManager' }), false);
  ok('recurring: nor by being CEO', access.canManageRecurring({ _id: A, role: 'CEO' }), false);
  ok('reminders: a Super Admin by role', access.canSetReminders({ _id: A, role: 'SuperAdmin' }), true);
  ok('reminders: an employee with the switch', access.canSetReminders(emp({ taskReminderAccess: true })), true);
  ok('reminders: the recurring switch is not this one', access.canSetReminders(emp({ taskRecurringAccess: true })), false);
  ok('reminders: not implied by holding every capability', access.canSetReminders({ _id: A, role: 'HRManager' }), false);

  // "In any task give option to edit that before accept" — the setter's own
  // task used to be uneditable, because being a doer won.
  const me = emp();
  const selfOnly = { createdBy: A, status: 'PENDING', assignees: [{ user: A, status: 'PENDING', acceptance: 'AWAITING', name: 'Asha' }] };
  ok('my own task, not yet accepted: I may edit it', access.capabilitiesFor(me, selfOnly).canEdit, true);
  const selfTaken = { ...selfOnly, status: 'IN_PROGRESS', assignees: [{ user: A, status: 'IN_PROGRESS', acceptance: 'ACCEPTED', name: 'Asha' }] };
  ok('…once I take it on, locked', access.capabilitiesFor(me, selfTaken).canEdit, false);
  ok('…and the reason speaks to me', access.capabilitiesFor(me, selfTaken).editLocked,
    'You have accepted this task, so it can no longer be edited.');
  const withOthers = { createdBy: A, status: 'PENDING', assignees: [
    { user: A, status: 'PENDING', acceptance: 'AWAITING' }, { user: B, status: 'PENDING', acceptance: 'AWAITING' },
  ] };
  ok('set for me and a colleague: I may edit it', access.capabilitiesFor(me, withOthers).canEdit, true);
  ok('…my colleague may not', access.capabilitiesFor({ _id: B, role: 'Employee', permissions: [] }, withOthers).canEdit, false);
  ok('…I still get the doer\'s Accept', access.capabilitiesFor(me, withOthers).canAccept, true);
  // Holding the wide view does not let a DOER rewrite what they were given.
  const hr = { _id: B, role: 'HRManager' };
  const givenToHr = { createdBy: C, status: 'PENDING', assignees: [{ user: B, status: 'PENDING', acceptance: 'AWAITING' }] };
  ok('tasks.manage + doing it: no edit', access.capabilitiesFor(hr, givenToHr).canEdit, false);
  ok('tasks.manage + not on it: edit, as before', access.capabilitiesFor(hr, { ...givenToHr, assignees: [{ user: A, status: 'PENDING', acceptance: 'AWAITING' }] }).canEdit, true);
  const delegatedBack = { createdBy: C, approver: A, status: 'PENDING', assignees: [{ user: A, status: 'PENDING', acceptance: 'AWAITING' }] };
  ok('the approver who is also on it may edit', access.capabilitiesFor(me, delegatedBack).canEdit, true);
}

async function run() {
  console.log('Task module — rules');
  testSeptember28();
  testEditLock();
  testNudge();
  testRoutine();
  testRecurrenceShapes();
  testRepeatReminder();
  testVocabulary();
  testLifecycle();
  testReminders();
  testRecurrence();
  await testModel();
  await testAcceptance();
  await testSubtasksAndFollowers();
  testLegacyRows();
  await testDateChips();
  await testAnyoneAssigns();
  await testOnBehalf();

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}

run();
