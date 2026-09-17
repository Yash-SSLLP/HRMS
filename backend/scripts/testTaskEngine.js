/**
 * Self-check for the task module's decision rules (section 55).
 *
 *   node scripts/testTaskEngine.js
 *
 * Needs no database and touches nothing. Everything exercised here is a pure
 * rule: which status may follow which, who may make the move, what a submission
 * must carry, how a condition branches, when a recurring schedule next comes
 * round, and what an incentive pays out. Those are the rules that decide whether
 * somebody's work counts and whether they are paid for it, so being able to
 * re-verify them in one second after any change is worth the file.
 *
 * The database-backed half — the concurrency guard, the workflow actually
 * advancing, the geofence — is scripts/testTaskWorkflow.js, which needs a
 * throwaway database and says so.
 *
 * Exits non-zero on failure, so it can be wired into CI as-is.
 */
const cfg = require('../config/taskWorkflow');
const { validateSteps } = require('../models/Workflow');
const { nextOccurrence } = require('../models/RecurringTask');
const flow = require('../services/taskWorkflow');
const incentive = require('../services/taskIncentive');

let passed = 0;
const failures = [];

/**
 * Assert deep equality and record the outcome.
 * @param {string} label - what is being checked
 * @param {*} got
 * @param {*} want
 */
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) passed += 1;
  else failures.push(`${label}\n     expected ${JSON.stringify(want)}\n     got      ${JSON.stringify(got)}`);
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}`);
}

/** Assert a value is truthy. */
function ok(label, got) {
  check(label, !!got, true);
}

console.log('\n--- status vocabulary ---');
check('legacy Todo maps forward', cfg.normaliseStatus('Todo'), 'ASSIGNED');
check('legacy InProgress maps forward', cfg.normaliseStatus('InProgress'), 'IN_PROGRESS');
check('legacy Review maps forward', cfg.normaliseStatus('Review'), 'UNDER_REVIEW');
check('legacy Done maps forward', cfg.normaliseStatus('Done'), 'COMPLETED');
check('a new key passes through', cfg.normaliseStatus('SUBMITTED'), 'SUBMITTED');
check('lower case is understood', cfg.normaliseStatus('in_progress'), 'IN_PROGRESS');
check('spaces are understood', cfg.normaliseStatus('on hold'), 'ON_HOLD');
check('nonsense is refused', cfg.normaliseStatus('banana'), null);
check('nothing is refused', cfg.normaliseStatus(''), null);

console.log('\n--- the transition table ---');
ok('assigned -> accepted is legal', cfg.transitionRule('ASSIGNED', 'ACCEPTED'));
check('...and only the assignee may', cfg.transitionRule('ASSIGNED', 'ACCEPTED').actors, ['assignee']);
check('assigned -> completed is NOT legal', cfg.transitionRule('ASSIGNED', 'COMPLETED'), null);
check('submitted -> in progress is NOT legal', cfg.transitionRule('SUBMITTED', 'IN_PROGRESS'), null);
ok('rejected -> in progress is legal (resubmission)', cfg.transitionRule('REJECTED', 'IN_PROGRESS'));
ok('completed -> in progress is legal (an authorised reopen)', cfg.transitionRule('COMPLETED', 'IN_PROGRESS'));
check('...by an admin only', cfg.transitionRule('COMPLETED', 'IN_PROGRESS').actors, ['admin']);
check('...and it needs a reason', cfg.transitionNeedsReason('COMPLETED', 'IN_PROGRESS'), true);
check('declining needs a reason', cfg.transitionNeedsReason('ASSIGNED', 'DECLINED'), true);
check('rejecting needs a reason', cfg.transitionNeedsReason('UNDER_REVIEW', 'REJECTED'), true);
check('accepting does not', cfg.transitionNeedsReason('ASSIGNED', 'ACCEPTED'), false);
check('an assignee may not approve', cfg.transitionRule('UNDER_REVIEW', 'APPROVED').actors.includes('assignee'), false);
check('only the system or an admin completes', cfg.transitionRule('APPROVED', 'COMPLETED').actors, ['system', 'admin']);
check('every status can be left', cfg.TASK_STATUS.filter((s) => !cfg.transitionsFrom(s).length), ['DECLINED'].filter(() => false));

console.log('\n--- terminal and timeable ---');
check('completed is terminal', cfg.isTerminal('COMPLETED'), true);
check('on hold is not terminal', cfg.isTerminal('ON_HOLD'), false);
check('the clock runs while in progress', cfg.canTimeTrack('IN_PROGRESS'), true);
check('the clock does NOT run on hold', cfg.canTimeTrack('ON_HOLD'), false);
check('the clock does NOT run once submitted', cfg.canTimeTrack('SUBMITTED'), false);
check('the clock runs on a task sent back', cfg.canTimeTrack('REJECTED'), true);

console.log('\n--- board columns ---');
check('every status has a column', cfg.TASK_STATUS.every((s) => !!cfg.columnOf(s)), true);
check('blocked shows under In progress', cfg.columnOf('BLOCKED'), 'progress');
check('sent back shows under In progress', cfg.columnOf('REJECTED'), 'progress');
check('declined shows under Completed', cfg.columnOf('DECLINED'), 'done');

console.log('\n--- submission requirements ---');
const engine = require('../services/taskEngine');
const bareTask = {
  requirements: {}, checklist: [], customFields: [],
};
check('a task that demands nothing accepts nothing', engine.missingRequirements(bareTask, {}), []);

const strictTask = {
  requirements: { remarks: true, photo: true, minPhotos: 3, checklist: true, location: true },
  checklist: [
    { text: 'Gate checked', done: true, mandatory: true },
    { text: 'Stock counted', done: false, mandatory: true },
    { text: 'Optional note', done: false, mandatory: false },
  ],
  customFields: [{ key: 'serial', label: 'Serial number', required: true }],
};
const strictMissing = engine.missingRequirements(strictTask, { evidence: [{ kind: 'photo' }] });
check('it names every missing thing at once', strictMissing.length, 5);
ok('remarks are named', strictMissing.some((m) => /Remarks/i.test(m)));
ok('the untidied checklist item is named by its text', strictMissing.some((m) => /Stock counted/.test(m)));
ok('the photo shortfall says how many', strictMissing.some((m) => /3 photos are required — 1 attached/.test(m)));
ok('location is named', strictMissing.some((m) => /location/i.test(m)));
ok('the required custom field is named by its label', strictMissing.some((m) => /Serial number/.test(m)));
check('an optional checklist item never blocks', strictMissing.some((m) => /Optional note/.test(m)), false);

const complete = engine.missingRequirements(strictTask, {
  remarks: 'All done',
  evidence: [{ kind: 'photo' }, { kind: 'photo' }, { kind: 'photo' }],
  location: { lat: 12.9, lng: 77.6 },
  fieldValues: { serial: 'SN-4410' },
});
check('a complete submission is accepted once the checklist is done',
  complete.filter((m) => !/checklist/i.test(m)), []);

console.log('\n--- workflow conditions ---');
const money = { priority: 'High', customFields: [{ key: 'amount', value: '60000' }] };
check('a numeric custom field compares as a number',
  flow.evaluateCondition(money, { field: 'customFields.amount', operator: 'gt', value: 50000 }), true);
check('...and the other way',
  flow.evaluateCondition(money, { field: 'customFields.amount', operator: 'lte', value: 50000 }), false);
check('a rupee-formatted value still compares',
  flow.evaluateCondition({ customFields: [{ key: 'amount', value: '₹1,20,000' }] },
    { field: 'customFields.amount', operator: 'gt', value: 50000 }), true);
check('a plain path is read', flow.evaluateCondition(money, { field: 'priority', operator: 'eq', value: 'High' }), true);
check('"in" accepts a comma list',
  flow.evaluateCondition(money, { field: 'priority', operator: 'in', value: 'High,Urgent' }), true);
check('"empty" on a missing field', flow.evaluateCondition(money, { field: 'department', operator: 'empty' }), true);
check('"notEmpty" on a set field', flow.evaluateCondition(money, { field: 'priority', operator: 'notEmpty' }), true);
check('a condition with no field is false', flow.evaluateCondition(money, { operator: 'eq', value: 'x' }), false);
check('reading a custom field that is not there', flow.readField(money, 'customFields.nope'), undefined);

console.log('\n--- parallel joins ---');
const grp = (statuses, join) => statuses.map((s) => ({ status: s, join }));
check('all: still waiting on one', flow.groupSettled(grp(['Approved', 'Pending'], 'all')), { finished: false, rejected: false });
check('all: everyone said yes', flow.groupSettled(grp(['Approved', 'Approved'], 'all')), { finished: true, rejected: false });
check('all: one no fails the group', flow.groupSettled(grp(['Approved', 'Rejected'], 'all')), { finished: true, rejected: true });
check('any: one yes is enough', flow.groupSettled(grp(['Approved', 'Pending'], 'any')), { finished: true, rejected: false });
check('any: one no is not', flow.groupSettled(grp(['Rejected', 'Pending'], 'any')), { finished: false, rejected: false });
check('any: everybody said no', flow.groupSettled(grp(['Rejected', 'Rejected'], 'any')), { finished: true, rejected: true });
check('majority: 2 of 3 yes', flow.groupSettled(grp(['Approved', 'Approved', 'Pending'], 'majority')), { finished: true, rejected: false });
check('majority: 2 of 3 no', flow.groupSettled(grp(['Rejected', 'Rejected', 'Pending'], 'majority')), { finished: true, rejected: true });
check('majority: 1 of 3 decides nothing', flow.groupSettled(grp(['Approved', 'Pending', 'Pending'], 'majority')), { finished: false, rejected: false });
check('a skipped step does not count', flow.groupSettled(grp(['Approved', 'Skipped'], 'all')), { finished: true, rejected: false });

console.log('\n--- publishing a workflow refuses what would strand a task ---');
check('an empty workflow', validateSteps([]), ['A workflow needs at least one step.']);
ok('a duplicate key is caught', validateSteps([
  { key: 'a', name: 'A', type: 'approval', assigneeRule: { kind: 'supervisor' } },
  { key: 'a', name: 'A2', type: 'approval', assigneeRule: { kind: 'manager' } },
]).some((p) => /share the key/.test(p)));
ok('a branch to nowhere is caught', validateSteps([
  { key: 'c', name: 'Check', type: 'condition', condition: { field: 'priority', onTrue: 'ghost' } },
]).some((p) => /"ghost", which does not exist/.test(p)));
ok('an approval nobody can be resolved to is caught', validateSteps([
  { key: 'a', name: 'Approve', type: 'approval', assigneeRule: {} },
]).some((p) => /does not say who acts on it/.test(p)));
ok('a wait with no duration is caught', validateSteps([
  { key: 'w', name: 'Hold', type: 'wait' },
]).some((p) => /no duration/.test(p)));
ok('a parallel group that disagrees is caught', validateSteps([
  { key: 'a', name: 'A', type: 'approval', parallelGroup: 'g', join: 'all', assigneeRule: { kind: 'supervisor' } },
  { key: 'b', name: 'B', type: 'approval', parallelGroup: 'g', join: 'any', assigneeRule: { kind: 'manager' } },
]).some((p) => /different join rules/.test(p)));
check('a sound workflow has no problems', validateSteps([
  { key: 'hr', name: 'HR', type: 'approval', order: 0, assigneeRule: { kind: 'permission', permission: 'employees.manage' } },
  { key: 'mgr', name: 'Manager', type: 'approval', order: 1, assigneeRule: { kind: 'reportingManager' } },
]), []);

console.log('\n--- recurrence arithmetic ---');
const at = (y, m, d, hh = 9) => new Date(y, m, d, hh, 0, 0, 0);
check('monthly on the 1st',
  nextOccurrence({ frequency: 'monthly', interval: 1, dayOfMonth: 1, atTime: '09:00', startsOn: at(2026, 0, 1) }, at(2026, 2, 15)),
  at(2026, 3, 1));
check('THE SHORT-MONTH RULE: the 31st in February is the 28th',
  nextOccurrence({ frequency: 'monthly', interval: 1, dayOfMonth: 31, atTime: '09:00', startsOn: at(2026, 0, 31) }, at(2026, 1, 1)),
  at(2026, 1, 28));
check('every 2 months',
  nextOccurrence({ frequency: 'monthly', interval: 2, dayOfMonth: 5, atTime: '09:00', startsOn: at(2026, 0, 5) }, at(2026, 0, 6)),
  at(2026, 2, 5));
check('quarterly',
  nextOccurrence({ frequency: 'quarterly', interval: 1, dayOfMonth: 1, atTime: '09:00', startsOn: at(2026, 0, 1) }, at(2026, 0, 2)),
  at(2026, 3, 1));
check('yearly on a named month',
  nextOccurrence({ frequency: 'yearly', interval: 1, dayOfMonth: 15, monthOfYear: 3, atTime: '09:00', startsOn: at(2026, 3, 15) }, at(2026, 5, 1)),
  at(2027, 3, 15));
check('daily every 3 days from the 1st lands on the 4th',
  nextOccurrence({ frequency: 'daily', interval: 3, atTime: '09:00', startsOn: at(2026, 0, 1) }, at(2026, 0, 2)),
  at(2026, 0, 4));
check('weekly on Mondays',
  nextOccurrence({ frequency: 'weekly', interval: 1, daysOfWeek: [1], atTime: '09:00', startsOn: at(2026, 0, 1) }, at(2026, 0, 1)).getDay(),
  1);
check('a schedule past its end date is over',
  nextOccurrence({ frequency: 'monthly', interval: 1, dayOfMonth: 1, atTime: '09:00', startsOn: at(2026, 0, 1), endsOn: at(2026, 1, 1) }, at(2026, 5, 1)),
  null);
check('a custom day list',
  nextOccurrence({ frequency: 'custom', customDays: ['2026-03-10', '2026-06-20'], atTime: '09:00', startsOn: at(2026, 0, 1) }, at(2026, 3, 1)),
  at(2026, 5, 20));
check('never before the start date',
  nextOccurrence({ frequency: 'monthly', interval: 1, dayOfMonth: 1, atTime: '09:00', startsOn: at(2026, 5, 1) }, at(2026, 0, 1)),
  at(2026, 5, 1));

console.log('\n--- incentive outcomes ---');
const task = (due, start) => ({ dueDate: due, startDate: start, assignedAt: start });
const day = 86400000;
const dueOn = new Date('2026-03-20T17:00:00');
const startedOn = new Date('2026-03-10T09:00:00');
check('finished after the deadline is late',
  incentive.outcomeFor(task(dueOn, startedOn), new Date(dueOn.getTime() + 3 * 3600000)), 'late');
check('more than a day late is very late',
  incentive.outcomeFor(task(dueOn, startedOn), new Date(dueOn.getTime() + 2 * day)), 'veryLate');
check('a whisker before the bell is on time, not early',
  incentive.outcomeFor(task(dueOn, startedOn), new Date(dueOn.getTime() - 10 * 60000)), 'onTime');
check('well clear of the deadline is early',
  incentive.outcomeFor(task(dueOn, startedOn), new Date(dueOn.getTime() - 5 * day)), 'early');
check('BEING SENT BACK OUTRANKS PUNCTUALITY',
  incentive.outcomeFor(task(dueOn, startedOn), new Date(dueOn.getTime() - 5 * day), 2), 'rejectedFirst');
check('a task with no deadline is simply on time',
  incentive.outcomeFor({ }, new Date()), 'onTime');

console.log('\n--- incentive arithmetic ---');
const shared = incentive.preview({ points: 20, distribution: 'share' }, 2);
check('on time, shared between two, is 20 x 80% / 2',
  shared.find((r) => r.outcome === 'onTime').points, 8);
check('early, shared between two, is the full rate halved',
  shared.find((r) => r.outcome === 'early').points, 10);
check('very late pays nothing', shared.find((r) => r.outcome === 'veryLate').points, 0);
const each = incentive.preview({ points: 20, distribution: 'each' }, 4);
check('"each" gives everybody the full figure',
  each.find((r) => r.outcome === 'early').points, 20);
check('the spec ladder maps onto the split exactly (500/400/200/0)',
  incentive.preview({ points: 500 }, 1)
    .filter((r) => ['early', 'onTime', 'late', 'veryLate'].includes(r.outcome))
    .map((r) => r.points),
  [500, 400, 200, 0]);
check('the earner list drops observers and the withheld', incentive.earnersOf({
  assignees: [
    { user: 'a', role: 'Owner', incentiveEligible: true },
    { user: 'b', role: 'Observer', incentiveEligible: true },
    { user: 'c', role: 'Contributor', incentiveEligible: false },
    { user: 'd', role: 'Contributor', incentiveEligible: true },
  ],
}).shares, 2);

console.log('\n--- a task\'s own derived figures ---');
const Task = require('../models/Task');
const mk = (fields) => new Task({ title: 'x', ...fields });
check('progress follows the checklist', mk({
  checklist: [{ text: 'a', done: true }, { text: 'b', done: false }, { text: 'c', done: true }, { text: 'd', done: false }],
}).computeProgress(), 50);
check('SUBTASKS BEAT THE CHECKLIST', mk({
  subtaskCount: 4, subtaskDoneCount: 1,
  checklist: [{ text: 'a', done: true }, { text: 'b', done: true }],
}).computeProgress(), 25);
check('with neither, the assignees average', mk({
  assignees: [{ user: '507f1f77bcf86cd799439011', progress: 40 }, { user: '507f1f77bcf86cd799439012', progress: 80 }],
}).computeProgress(), 60);
check('with nothing at all, the status implies it', mk({ status: 'SUBMITTED' }).computeProgress(), 80);
check('a completed task is 100', mk({ status: 'COMPLETED' }).computeProgress(), 100);

console.log('\n--- time arithmetic ---');
const TaskTimeEntry = require('../models/TaskTimeEntry');
const t0 = new Date('2026-03-12T10:00:00');
check('a plain 90-minute stretch', TaskTimeEntry.measure({
  startedAt: t0, endedAt: new Date(t0.getTime() + 90 * 60000), pauses: [],
}).activeMinutes, 90);
check('A PAUSE COMES OFF THE MIDDLE, not out of a second entry', TaskTimeEntry.measure({
  startedAt: t0,
  endedAt: new Date(t0.getTime() + 90 * 60000),
  pauses: [{ at: new Date(t0.getTime() + 30 * 60000), until: new Date(t0.getTime() + 45 * 60000) }],
}), { activeMinutes: 75, breakMinutes: 15, elapsedMinutes: 90 });
check('two pauses both come off', TaskTimeEntry.measure({
  startedAt: t0,
  endedAt: new Date(t0.getTime() + 120 * 60000),
  pauses: [
    { at: new Date(t0.getTime() + 20 * 60000), until: new Date(t0.getTime() + 30 * 60000) },
    { at: new Date(t0.getTime() + 60 * 60000), until: new Date(t0.getTime() + 75 * 60000) },
  ],
}).activeMinutes, 95);
check('an entry with no start measures nothing', TaskTimeEntry.measure({}).activeMinutes, 0);
check('a running entry measures to the moment asked about', TaskTimeEntry.measure(
  { startedAt: t0, pauses: [] }, new Date(t0.getTime() + 25 * 60000)
).activeMinutes, 25);

console.log('\n--- notification wording ---');
const notify = require('../services/taskNotify');
check('a coded task is named by its code',
  notify.taskName({ code: 'TSK-2026-00042', title: 'Onboarding' }), 'TSK-2026-00042 — Onboarding');
check('one without a code falls back to the title',
  notify.taskName({ title: 'Onboarding' }), '"Onboarding"');
check('an ordinary task adds no tail', notify.taskMeta({ priority: 'Medium' }), '');
ok('an urgent task says so', /Urgent/.test(notify.taskMeta({ priority: 'Urgent' })));

// ===== result =====
console.log('');
if (failures.length) {
  console.log(`FAILED — ${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(` * ${f}`);
  process.exit(1);
}
console.log(`All ${passed} checks passed.\n`);
process.exit(0);
