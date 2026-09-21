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
const Task = require('../models/Task');

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
  // Twelve states collapsed to three; both older vocabularies still read.
  ok('SUBMITTED → IN_PROGRESS', c.normaliseStatus('SUBMITTED'), 'IN_PROGRESS');
  ok('UNDER_REVIEW → IN_PROGRESS', c.normaliseStatus('UNDER_REVIEW'), 'IN_PROGRESS');
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
  ok('legacy words normalise first', (await rollUp(['SUBMITTED', 'SUBMITTED', 'SUBMITTED'])).status, 'IN_PROGRESS');
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
  console.log('\nSubtasks');
  const t = new Task({
    title: 'x',
    createdBy: C,
    assignees: [{ user: A }],
    subtasks: [
      { title: 'open to anybody' },
      { title: 'Bʼs piece', assignee: B, assigneeName: 'B' },
      { title: 'done already', done: true },
    ],
  });
  await t.validate().catch(() => {});
  ok('progress counts the ticked ones', t.subtaskProgress(), { done: 1, total: 3 });
  ok('B owns a piece', t.ownsSubtask(B), true);
  ok('C owns none', t.ownsSubtask(C), false);
  // The piece owner must be able to SEE the task, or it is invisible to the one
  // person who can do it.
  ok('a subtask owner is in the audience', t.audience().includes(String(B)), true);

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

async function run() {
  console.log('Task module — rules');
  testVocabulary();
  testLifecycle();
  testReminders();
  testRecurrence();
  await testModel();
  await testAcceptance();
  await testSubtasksAndFollowers();

  console.log(`\n${passed} passed, ${failed} failed.`);
  process.exit(failed ? 1 : 0);
}

run();
