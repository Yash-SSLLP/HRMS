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

async function run() {
  console.log('Task module — rules');
  testVocabulary();
  testLifecycle();
  testReminders();
  testRecurrence();
  await testModel();
  await testAcceptance();
  await testSubtasksAndFollowers();
  testLegacyRows();
  await testDateChips();

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}

run();
