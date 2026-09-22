/**
 * What finishing a task is worth.
 *
 * NEW 2026-09-21, replacing services/taskIncentive.js — 322 lines that graded
 * every completion against a four-way outcome split (on time / late / after a
 * rejection / partial), proposed an award, queued it for a creditor to sanction
 * and then wrote it. Nobody sanctioned anything; the queue sat full.
 *
 * The rule here is one sentence: **a task carries a points figure, and the
 * people who complete it earn it.** Default 100, changed by whoever sets the
 * task (user decision, 2026-09-21). No grading, no outcome multipliers, no
 * queue. Whether it was late is recorded and reported — it is the In Time /
 * Delayed split on every dashboard — but it does not quietly alter the figure,
 * because an assigner who wants a late job to pay less can say so on the task.
 *
 * ── THE ONE THING THAT IS NOT AUTOMATIC ─────────────────────────────────────
 *
 * Points in this portal are MONEY. They are one company-wide pool settled at
 * Setting.incentive.rupeePerPoint, shared with the rolling and billing
 * incentives. So completing a task always RECORDS its points — on the assignee
 * row, in every report and on the leaderboard — but it only writes an
 * IncentiveCredit, and so only becomes payable, when a SuperAdmin has turned on
 * `Setting.tasks.pointsToPool`. Default off.
 *
 * That split is deliberate. Scoring is what the dashboard needs and it should
 * work out of the box; paying is a decision about payroll and should be made on
 * purpose, once, by somebody who can make it. Turning it on affects tasks
 * completed from that moment; it does not backfill, because retroactively
 * minting credits for six months of finished work is not something a toggle
 * should be able to do.
 *
 * ── REVERSING ───────────────────────────────────────────────────────────────
 *
 * Reopening a completed task takes its points back: the credit row is deleted,
 * the way a credit is reversed everywhere else in this portal (a negative row
 * would net silently into a month's total and leave nothing on screen saying it
 * had happened). If the person has ALREADY BEEN PAID for that month, the credit
 * is left alone and the reopen is recorded without it — that money is gone, and
 * silently clawing it back is how a payslip stops reconciling.
 */
const Setting = require('../models/Setting');
const EmployeeProfile = require('../models/EmployeeProfile');
const IncentiveCredit = require('../models/IncentiveCredit');
const { KIND_TASK } = require('../config/tasks');

/** The company-wide task settings, with the defaults filled in. */
async function taskSettings() {
  try {
    const s = await Setting.getSettings();
    return {
      defaultPoints: Number.isFinite(s?.tasks?.defaultPoints) ? s.tasks.defaultPoints : 100,
      pointsToPool: Boolean(s?.tasks?.pointsToPool),
      defaultReminders: s?.tasks?.defaultReminders?.length
        ? s.tasks.defaultReminders.map((r) => ({
          channel: r.channel || 'APP',
          amount: Number(r.amount) || 1,
          unit: r.unit || 'DAYS',
          when: r.when || 'BEFORE',
        }))
        : [],
      dailyDigestAt: s?.tasks?.dailyDigestAt || '',
    };
  } catch (err) {
    console.error('taskSettings failed, using defaults:', err.message);
    return { defaultPoints: 100, pointsToPool: false, defaultReminders: [], dailyDigestAt: '' };
  }
}

/**
 * Credit one person for finishing their part of a task.
 *
 * Called from the engine the moment an assignee row turns COMPLETED. Mutates
 * the assignee subdocument (`pointsAwarded`, `pointsAwardedAt`, `creditRef`);
 * the CALLER saves the task, so one completion is still one write.
 *
 * Idempotent: an assignee who already has `pointsAwardedAt` is skipped, so a
 * double-tap on Complete, or a retry after a network blip, cannot pay twice.
 *
 * @param {Object} task - the Task document (not saved by this function)
 * @param {Object} assignee - the assignees[] subdocument that just completed
 * @param {Object} actor - who marked it complete, for the credit's audit fields
 */
async function award(task, assignee, actor) {
  if (!task || !assignee) return null;
  if (task.kind !== KIND_TASK) return null;            // a request is not work
  if (assignee.pointsAwardedAt) return null;           // already paid for

  /**
   * WHAT IS LEFT ON THIS TASK, not what it started with.
   *
   * Changed 2026-09-22, when a task became splittable. `points` is the pool;
   * whatever has been handed down to the pieces belongs to the people doing
   * them. A manager who split 100 points three ways earns nothing for the
   * parent — correctly, because they did not do it — and one who handed out 60
   * earns the 40 they kept.
   *
   * Reading `task.points` here instead would pay the pool out TWICE: once to
   * the pieces and once again to the parent, which on a three-way split is 200
   * points of real money for 100 points of work.
   */
  const points = typeof task.effectivePoints === 'function'
    ? task.effectivePoints()
    : Math.max(0, (Number(task.points) || 0) - (Number(task.distributedPoints) || 0));
  if (points <= 0) return null;

  // Always record the figure, whether or not it becomes money.
  assignee.pointsAwarded = points;
  assignee.pointsAwardedAt = new Date();

  const { pointsToPool } = await taskSettings();
  if (!pointsToPool) return { points, credited: false };

  const profile = await EmployeeProfile.findOne({ user: assignee.user })
    .select('_id firstName lastName employeeCode department company')
    .lean();
  // No profile means no employee record to credit — an admin login, say. The
  // points still score; they simply have nowhere to be paid to.
  if (!profile) return { points, credited: false };

  try {
    const credit = await IncentiveCredit.create({
      employee: profile._id,
      name: [profile.firstName, profile.lastName].filter(Boolean).join(' ').trim()
        || assignee.name || '',
      employeeCode: profile.employeeCode || assignee.employeeCode || '',
      department: profile.department || '',
      company: profile.company || task.company || null,
      // Credited FOR the day the work finished, so it falls in the month it was
      // done rather than the month somebody got round to noticing.
      date: assignee.completedAt || new Date(),
      points,
      // The reason is what makes a credit auditable, and the code is what makes
      // it traceable back to the row.
      reason: `${task.code || 'Task'} — ${task.title}`.slice(0, 300),
      createdBy: actor?._id,
      createdByName: [actor?.firstName, actor?.lastName].filter(Boolean).join(' ').trim(),
    });
    assignee.creditRef = credit._id;
    return { points, credited: true, credit };
  } catch (err) {
    // A credit that fails to write must not fail the completion — the person
    // did the work either way. Logged loudly; the figure is still on the task.
    console.error('Task points credit failed:', err.message);
    return { points, credited: false, error: err.message };
  }
}

/**
 * Take back what a reopened task paid.
 *
 * Refuses when the month has already been settled — see the docblock. Mutates
 * the assignee subdocument; the caller saves.
 */
async function reverse(task, assignee) {
  if (!assignee?.pointsAwardedAt) return null;

  const creditId = assignee.creditRef;
  if (!creditId) {
    assignee.pointsAwarded = 0;
    assignee.pointsAwardedAt = undefined;
    return { reversed: true, credited: false };
  }

  try {
    const credit = await IncentiveCredit.findById(creditId).lean();

    /**
     * ASK BEFORE CLEARING, not after.
     *
     * The three fields used to be wiped at the top, before the paid-for check
     * below had run. When the month WAS already settled the credit was
     * deliberately left in place — but `creditRef` had already gone, so the row
     * was orphaned: nothing pointed at it any more, and because
     * `pointsAwardedAt` was empty too, `award()`'s idempotence guard no longer
     * fired. Re-completing the task then wrote a SECOND credit for the same
     * work, and points settle in rupees. (2026-09-22.)
     *
     * So the link is cut only on the path that actually removes the money.
     */
    if (credit && await alreadyPaidFor(credit)) {
      // The money is gone and stays gone. The task reopens regardless, and the
      // row keeps pointing at what it was paid, so nothing can pay it twice.
      return { reversed: false, credited: true, keptCredit: true };
    }

    assignee.pointsAwarded = 0;
    assignee.pointsAwardedAt = undefined;
    assignee.creditRef = undefined;
    if (!credit) return { reversed: true, credited: false };

    await IncentiveCredit.deleteOne({ _id: creditId });
    return { reversed: true, credited: true, keptCredit: false };
  } catch (err) {
    // Left EXACTLY as it was: a half-reversed row that has lost its creditRef
    // is the state that pays twice, and it is better to leave the points
    // recorded and say so loudly than to guess.
    console.error('Task points reversal failed:', err.message);
    return { reversed: false, error: err.message };
  }
}

/**
 * Has the month this credit falls in already been paid out?
 *
 * The same test the incentive controller makes before letting a credit be
 * deleted: what somebody is owed is always `earned − paid`, so removing an
 * earning below what has been paid would leave a negative balance nothing on
 * screen explains.
 */
async function alreadyPaidFor(credit) {
  try {
    const IncentivePayment = require('../models/IncentivePayment');
    const d = new Date(credit.date);
    const from = new Date(d.getFullYear(), d.getMonth(), 1);
    const to = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    // `period` (not `date`) is the month a payment settles — see that model.
    const paid = await IncentivePayment.exists({
      employee: credit.employee,
      period: { $gte: from, $lt: to },
    });
    return Boolean(paid);
  } catch {
    // No payment model, or a query that failed: assume NOT paid and allow the
    // reversal. The alternative — stranding points nobody can remove — is worse.
    return false;
  }
}

/** What a fresh task should be worth, before the assigner touches it. */
async function defaultPoints() {
  return (await taskSettings()).defaultPoints;
}

module.exports = { taskSettings, award, reverse, defaultPoints };
