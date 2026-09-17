/**
 * Task incentives (section 25) — in POINTS, into the pool that already exists.
 *
 * The manager who assigns a task says what it is worth in points. When the task
 * is approved, this works out how many of those points were actually earned —
 * early, on time, late, or sent back first — and writes a TaskIncentive row that
 * is PENDING until somebody entitled to credit the pool sanctions it. Sanctioning
 * writes an IncentiveCredit, which is how points arrive from anywhere outside a
 * team-day, and from that moment the points are indistinguishable from any other
 * points: the same roll-ups add them, the same rate values them, and the same
 * Points Dashboard pays them.
 *
 * WHY NOT RUPEES, WHICH IS WHAT THE SPEC'S FIGURES LOOK LIKE. Because this
 * portal has exactly one answer to "what is this person owed", and it is points
 * × Setting.incentive.rupeePerPoint. A rupee figure on a task would be a second
 * answer sitting beside the first, reconciled by nobody, and invisible to every
 * screen that already totals what the company owes. The spec's
 * ₹500 / ₹400 / ₹200 / ₹0 ladder is expressible exactly as 1 / 0.8 / 0.4 / 0 of
 * whatever the manager set — which is what DEFAULT_INCENTIVE_SPLIT is.
 *
 * NOTHING HERE TOUCHES PAYROLL. Section 25: "never directly modify payroll data
 * without following the existing payroll architecture." The furthest this module
 * reaches is IncentiveCredit, which is the module's own front door.
 *
 * AN EMPLOYEE CANNOT INFLUENCE THEIR OWN (section 53). The figure is proposed by
 * the task's creator, evaluated by the server from server timestamps, and
 * sanctioned by somebody else; every route that writes it is gated, and the
 * controller refuses a sanction by the earner.
 */
const Task = require('../models/Task');
const TaskIncentive = require('../models/TaskIncentive');
const IncentiveCredit = require('../models/IncentiveCredit');
const EmployeeProfile = require('../models/EmployeeProfile');
const { DEFAULT_INCENTIVE_SPLIT, INCENTIVE_OUTCOME_LABELS } = require('../config/taskWorkflow');
const { logActivity, httpError, fullName } = require('./taskEngine');
const taskNotify = require('./taskNotify');

/** Hours early (negative) or late (positive) a task finished against its deadline. */
function hoursAgainstDeadline(task, finishedAt) {
  if (!task.dueDate) return 0;
  return (new Date(finishedAt).getTime() - new Date(task.dueDate).getTime()) / 3600000;
}

/**
 * Which outcome the work met.
 *
 * ORDER MATTERS. Being sent back is judged FIRST, because a task that was
 * rejected and then fixed by the deadline is not the same as one that was right
 * the first time — the spec's own quality ladder makes that distinction — and
 * judging punctuality first would erase it.
 *
 * "Early" means finished with more than a tenth of the task's own window to
 * spare, not merely a minute before the bell. A fixed threshold (say 24 hours)
 * would make every short task impossible to finish early and every long one
 * trivially so.
 *
 * @param {object} task
 * @param {Date} finishedAt
 * @param {number} attempts - submissions made; >1 means it was sent back
 * @returns {string} an INCENTIVE_OUTCOMES member
 */
function outcomeFor(task, finishedAt, attempts = 1) {
  if (attempts > 1) return 'rejectedFirst';
  if (!task.dueDate) return 'onTime';

  const hours = hoursAgainstDeadline(task, finishedAt);
  if (hours > 24) return 'veryLate';
  if (hours > 0) return 'late';

  const start = task.startDate || task.assignedAt || task.createdAt;
  const windowHours = start
    ? (new Date(task.dueDate).getTime() - new Date(start).getTime()) / 3600000
    : 0;
  const earlyBy = -hours;
  // More than 10% of the window to spare, and at least an hour — so a two-hour
  // task finished 15 minutes early is on time, not early.
  if (windowHours > 0 && earlyBy >= Math.max(1, windowHours * 0.1)) return 'early';
  return 'onTime';
}

/**
 * Who on this task may earn the incentive, and how the points divide.
 *
 * Observers never earn; anyone a manager has ticked off does not either. With
 * `distribution: 'share'` (the default) the task's points divide between them —
 * a four-person task worth 20 points is 20 points of work, not 80. With
 * 'each' everyone earns the full figure, which is what a manager wants when the
 * task was genuinely done four times over.
 *
 * @param {object} task
 * @returns {{earners: Array, shares: number}}
 */
function earnersOf(task) {
  const earners = (task.assignees || [])
    .filter((a) => a.user && a.role !== 'Observer' && a.incentiveEligible !== false);
  const shares = task.incentive && task.incentive.distribution === 'each'
    ? 1
    : Math.max(1, earners.length);
  return { earners, shares };
}

/**
 * Work out what everyone on a completed task earned, and record it as pending.
 *
 * Called once, when the task is approved or completed. Idempotent by the unique
 * (task, user) index on TaskIncentive — a task reopened and completed again does
 * not mint a second award for the same person, it updates the one that is still
 * pending and leaves an already-credited one alone.
 *
 * @param {object} task - a Task document
 * @param {object} [opts]
 * @param {Date} [opts.at] - when it finished; defaults to now
 * @returns {Promise<Array>} the TaskIncentive rows, possibly empty
 */
async function evaluate(task, opts = {}) {
  const cfg = task.incentive || {};
  if (!cfg.enabled || !(cfg.points > 0)) return [];

  const finishedAt = opts.at || task.completedAt || task.approvedAt || new Date();
  const { earners, shares } = earnersOf(task);
  if (!earners.length) return [];

  const split = { ...DEFAULT_INCENTIVE_SPLIT, ...(cfg.split ? (cfg.split.toObject ? cfg.split.toObject() : cfg.split) : {}) };

  // Profiles, so the credit can be keyed the way the whole incentive module keys
  // things — by EmployeeProfile, not by User.
  const profiles = await EmployeeProfile.find({ user: { $in: earners.map((a) => a.user) } })
    .select('user employeeCode department company')
    .lean();
  const byUser = new Map(profiles.map((p) => [String(p.user), p]));

  const rows = [];
  for (const a of earners) {
    const attempts = a.submissionCount || 1;
    const outcome = outcomeFor(task, finishedAt, attempts);
    const multiplier = split[outcome] != null ? split[outcome] : 0;
    const points = Math.round((cfg.points * multiplier / shares) * 100) / 100;

    const prof = byUser.get(String(a.user));
    const basis = `${cfg.points} point${cfg.points === 1 ? '' : 's'}`
      + ` × ${Math.round(multiplier * 100)}% (${(INCENTIVE_OUTCOME_LABELS[outcome] || outcome).toLowerCase()})`
      + (shares > 1 ? ` ÷ ${shares} people` : '');

    // Never re-price an award that has already been credited — the points are in
    // the pool and may already have been paid.
    const existing = await TaskIncentive.findOne({ task: task._id, user: a.user });
    if (existing && existing.status === 'Credited') { rows.push(existing); continue; }

    const doc = existing || new TaskIncentive({ task: task._id, user: a.user });
    Object.assign(doc, {
      taskCode: task.code,
      taskTitle: task.title,
      employee: prof ? prof._id : undefined,
      name: a.name || fullName({ firstName: a.name }),
      employeeCode: a.employeeCode || (prof && prof.employeeCode),
      department: (prof && prof.department) || task.department,
      company: (prof && prof.company) || task.company,
      taskPoints: cfg.points,
      outcome,
      multiplier,
      shares,
      points,
      basis,
      dueDate: task.dueDate,
      completedAt: finishedAt,
      hoursEarlyOrLate: Math.round(hoursAgainstDeadline(task, finishedAt) * 10) / 10,
      submissionAttempts: attempts,
      status: 'Pending',
    });
    await doc.save();
    rows.push(doc);
  }

  const total = rows.reduce((t, r) => t + (r.points || 0), 0);
  if (total > 0) {
    await logActivity({
      task: task._id,
      kind: 'incentiveProposed',
      system: true,
      message: `Incentive evaluated: ${total} point${total === 1 ? '' : 's'} across ${rows.length} ${rows.length === 1 ? 'person' : 'people'}, awaiting approval`,
    });
  }

  return rows;
}

/**
 * Sanction an award and put the points into the pool.
 *
 * The credit row is what makes them real: every roll-up in the incentive module
 * already adds IncentiveCredit in, so nothing else has to learn about tasks. The
 * TaskIncentive keeps the link, and its presence is what stops a second credit.
 *
 * @param {object} award - a TaskIncentive document
 * @param {object} user - who is sanctioning
 * @param {object} [opts]
 * @param {number} [opts.points] - a corrected figure
 * @param {string} [opts.note]
 * @returns {Promise<object>} the award
 * @throws {Error} when it has already been credited
 */
async function approveAward(award, user, opts = {}) {
  if (award.status === 'Credited') {
    throw httpError(409, 'Those points have already been credited.');
  }
  if (String(award.user) === String(user._id)) {
    throw httpError(403, 'You cannot approve your own incentive.');
  }

  const points = opts.points != null ? Math.max(0, Number(opts.points)) : award.points;
  if (!(points > 0)) {
    // Approving nothing is a rejection said politely; make it say so.
    return rejectAward(award, user, opts.note || 'No points awarded.');
  }

  if (!award.employee) {
    throw httpError(400, `${award.name || 'That person'} has no employee record, so points cannot be credited to them.`);
  }

  const task = await Task.findById(award.task).select('title code').lean();

  const credit = await IncentiveCredit.create({
    employee: award.employee,
    name: award.name,
    employeeCode: award.employeeCode,
    department: award.department,
    company: award.company,
    date: award.completedAt || new Date(),
    points,
    // IncentiveCredit requires a reason, and this is the right one — it names
    // the task, so the credit reads correctly on the Points Dashboard next to
    // credits given by hand.
    reason: `Task ${award.taskCode || ''} ${task ? `— ${task.title}` : ''}`.trim().slice(0, 300),
    createdBy: user._id,
    createdByName: fullName(user),
  });

  award.status = 'Credited';
  award.approvedPoints = points;
  award.decidedBy = user._id;
  award.decidedByName = fullName(user);
  award.decidedAt = new Date();
  award.decisionNote = opts.note;
  award.credit = credit._id;
  award.creditedAt = new Date();
  await award.save();

  await logActivity({
    task: award.task,
    kind: 'incentiveCredited',
    by: user,
    message: `${fullName(user)} credited ${points} point${points === 1 ? '' : 's'} to ${award.name}`,
    note: opts.note,
    refModel: 'IncentiveCredit',
    refId: credit._id,
  });

  taskNotify.incentiveCredited({ _id: award.task, code: award.taskCode, title: award.taskTitle }, award.user, points)
    .catch(() => {});

  return award;
}

/**
 * Refuse an award. The row stays — a rejected incentive is a decision somebody
 * made, and deleting it would leave the task looking as though none was ever
 * proposed.
 * @param {object} award
 * @param {object} user
 * @param {string} note
 * @returns {Promise<object>}
 */
async function rejectAward(award, user, note) {
  if (award.status === 'Credited') {
    throw httpError(409, 'Those points have already been credited and cannot be withdrawn here. Delete the credit on the Points Dashboard.');
  }
  award.status = 'Rejected';
  award.decidedBy = user._id;
  award.decidedByName = fullName(user);
  award.decidedAt = new Date();
  award.decisionNote = note;
  await award.save();

  await logActivity({
    task: award.task,
    kind: 'incentiveRejected',
    by: user,
    message: `${fullName(user)} declined the incentive for ${award.name}`,
    note,
  });
  return award;
}

/**
 * What an incentive WOULD pay, without writing anything.
 *
 * For the task form, so a manager setting 20 points can see what each outcome
 * is worth before they save. Same arithmetic as `evaluate`, deliberately — a
 * preview that used its own sums would eventually disagree with the award.
 * @param {object} cfg - a task's `incentive` block
 * @param {number} [people=1]
 * @returns {Array<{outcome:string, label:string, points:number}>}
 */
function preview(cfg = {}, people = 1) {
  const split = { ...DEFAULT_INCENTIVE_SPLIT, ...(cfg.split || {}) };
  const shares = cfg.distribution === 'each' ? 1 : Math.max(1, people);
  return Object.keys(split).map((outcome) => ({
    outcome,
    label: INCENTIVE_OUTCOME_LABELS[outcome] || outcome,
    points: Math.round(((cfg.points || 0) * split[outcome] / shares) * 100) / 100,
  }));
}

module.exports = {
  evaluate,
  approveAward,
  rejectAward,
  preview,
  outcomeFor,
  earnersOf,
  hoursAgainstDeadline,
};
