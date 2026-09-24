/**
 * The dashboard — "how is the team doing?"
 *
 * REWRITTEN 2026-09-21, replacing taskAnalyticsController (513 lines of
 * workload heatmaps, burndown series and cycle-time percentiles). The brief's
 * answer to what a business owner actually looks at is one table: a row per
 * person, what they were given, what is not done, what is done, and whether it
 * was on time. "Just like you drive a car where you see a dashboard."
 *
 *   EMPLOYEE WISE   a row per person
 *   CATEGORY WISE   a row per department or project
 *   MY REPORT       the same row, for yourself — the one tab an employee gets
 *   DELEGATED       what you handed out, scored the same way
 *   TREND           a row per day or month, for the shape over time
 *
 * EVERY TAB IS THE SAME AGGREGATION with a different `$group` key. Writing it
 * once means the figures cannot disagree between tabs, which is the failure
 * mode that makes somebody stop believing a dashboard.
 *
 * WHAT ONE ROW COUNTS depends on the question, and the two answers are
 * deliberately different:
 *
 *   PER PERSON  (employee, mine, delegated) — `$unwind` over `assignees`, so a
 *               task on three people is three rows. "How is Megha doing" is
 *               answered by Megha's half being finished, whatever Sonu has done
 *               with his.
 *   PER TASK    (category, trend) — no unwind. A task filed under Sales is ONE
 *               Sales task however many people are on it, and a day's row says
 *               how much work was due that day, not how many person-jobs.
 *
 * So the employee tab's total and the category tab's total do not have to
 * match, and on a multi-assignee task they will not. Each is right for its own
 * question; `statsStage` below is parameterised on which one is being asked.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Task = require('../models/Task');
const {
  STATUS, KIND_TASK, normaliseStatus, normaliseStatusStage, spellingsOf,
} = require('../config/tasks');
const access = require('../services/taskAccess');
const { buildQuery } = require('./taskController');

const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

/**
 * The legacy status words, rewritten BEFORE statsStage compares anything.
 *
 * statsStage names the five current statuses, but a row set before the
 * 2026-09-21 rework still says ASSIGNED / Done / REJECTED — on the task and on
 * each assignee. Left alone, such a row lands in `total` and in no bucket, so
 * the halves stop adding up and every score it touches reads low. Those rows
 * only reached the dashboard on 2026-09-24, when buildQuery stopped dropping
 * them for having no `kind` (config/tasks.kindFilter); the list's counters
 * already normalise the same way.
 */
const TASK_STATUS_NOW = normaliseStatusStage();
/** The same, per person — only valid after `$unwind: '$assignees'`. */
const PERSON_STATUS_NOW = normaliseStatusStage('assignees.status');

/**
 * The facts every tab counts, as aggregation expressions.
 *
 * Parameterised on WHERE the status lives, because the two kinds of row count
 * different things:
 *
 *   per person   after `$unwind: '$assignees'` — `assignees.status` and
 *                `assignees.completedLate`, so a task Megha finished counts as
 *                done for Megha whatever Sonu has done with his half
 *   per task     no unwind — the rolled-up `status` and `completedLate`, so a
 *                task filed under Sales is ONE Sales task however many people
 *                are on it
 *
 * Passing the field paths in is the difference between one aggregation and two
 * that have to be kept in step by hand.
 *
 * `completedLate` is frozen when somebody finishes, so "delayed" survives a
 * later change to the deadline — the same rule the list counters follow, for
 * the same reason (see models/Task).
 */
function statsStage(now, {
  statusField = '$status',
  lateField = '$completedLate',
  // What ONE row contributes to the earned-points total. Per person that is
  // their own `pointsAwarded`; per task it is the sum across the assignees.
  // An expression rather than a field path, because `$addFields` on a dotted
  // path INTO an array sets the field on every element instead of replacing
  // the array — a quiet way to get nonsense out of an aggregation.
  pointsExpr = { $ifNull: ['$assignees.pointsAwarded', 0] },
} = {}) {
  const late = {
    $and: [
      { $in: [statusField, [STATUS.PENDING, STATUS.IN_PROGRESS]] },
      { $ne: ['$dueDate', null] },
      { $lt: ['$dueDate', now] },
    ],
  };
  const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  return {
    total: { $sum: 1 },
    overdue: countIf(late),
    pending: countIf({ $and: [{ $eq: [statusField, STATUS.PENDING] }, { $not: late }] }),
    inProgress: countIf({ $and: [{ $eq: [statusField, STATUS.IN_PROGRESS] }, { $not: late }] }),
    // Handed in, waiting on a word. Its own bucket for the same reason it is its
    // own counter on the list: it is the one queue a manager can clear by
    // reading it (2026-09-22).
    inReview: countIf({ $eq: [statusField, STATUS.SUBMITTED] }),
    completed: countIf({ $eq: [statusField, STATUS.COMPLETED] }),
    inTime: countIf({
      $and: [{ $eq: [statusField, STATUS.COMPLETED] }, { $ne: [lateField, true] }],
    }),
    delayed: countIf({
      $and: [{ $eq: [statusField, STATUS.COMPLETED] }, { $eq: [lateField, true] }],
    }),
    cancelled: countIf({ $eq: [statusField, STATUS.CANCELLED] }),
    // What has been earned on finished work. Recorded whether or not points are
    // paid into the incentive pool (services/taskPoints).
    points: { $sum: pointsExpr },
    // What is still on the table, so a row can say "80 of 300 earned".
    pointsPossible: { $sum: { $ifNull: ['$points', 0] } },
  };
}

/** The per-person variant — only valid after `$unwind: '$assignees'`. */
const perPerson = (now) => statsStage(now, {
  statusField: '$assignees.status',
  lateField: '$assignees.completedLate',
});

/** The per-task variant — the rolled-up status, and everybody's points summed. */
const perTask = (now) => statsStage(now, {
  pointsExpr: {
    $sum: {
      $map: { input: { $ifNull: ['$assignees', []] }, as: 'a', in: { $ifNull: ['$$a.pointsAwarded', 0] } },
    },
  },
});

/** Turn a raw group row into the shape the table draws. */
function scoreRow(r, label, extra = {}) {
  // `inReview` is counted by statsStage and used to be thrown away here, so
  // every row silently lost its whole review queue and the halves stopped
  // adding up: a task handed in and awaiting a word was in `total` and in
  // neither `notDone` nor `completed`. It is not-done — the work is not
  // finished until somebody approves it. (2026-09-22.)
  const notDone = r.overdue + r.pending + r.inProgress + (r.inReview || 0);
  return {
    ...extra,
    label,
    total: r.total,
    overdue: r.overdue,
    pending: r.pending,
    inProgress: r.inProgress,
    inReview: r.inReview || 0,
    completed: r.completed,
    inTime: r.inTime,
    delayed: r.delayed,
    cancelled: r.cancelled,
    points: Math.round(r.points || 0),
    pointsPossible: Math.round(r.pointsPossible || 0),
    // Shares WITHIN each half of the table, which is how the brief's app reads
    // them: "4 (19%)" is 19% of what is not done, not 19% of everything.
    notDone,
    overduePct: pct(r.overdue, notDone),
    pendingPct: pct(r.pending, notDone),
    inProgressPct: pct(r.inProgress, notDone),
    inReviewPct: pct(r.inReview || 0, notDone),
    inTimePct: pct(r.inTime, r.completed),
    delayedPct: pct(r.delayed, r.completed),
    // THE score: how much of what they were given is finished. The badge on the
    // left of every row.
    score: pct(r.completed, r.total - r.cancelled),
    // …and how much of that was punctual. Two numbers, because somebody who
    // finishes everything a week late is not the same as somebody who does not
    // finish at all, and one figure cannot say both.
    onTimeScore: pct(r.inTime, r.completed),
  };
}

/**
 * The filter every tab shares.
 *
 * Reuses the LIST's query builder so the dashboard and the list cannot drift:
 * the same chips, the same range, the same company wall. Cancelled rows are
 * kept in (they are subtracted from the denominator by `scoreRow`) and requests
 * are excluded, because an upward ask is not work anybody was set.
 */
async function dashboardFilter(req) {
  // STRICT dates, unlike the list: this month's score is over what was due this
  // month, not every open task anybody has (see taskController.buildQuery).
  return buildQuery(req, { kind: KIND_TASK }, { strictRange: true });
}

/** GET /api/tasks/dashboard?view=employee|category|trend|mine|delegated */
const dashboard = asyncHandler(async (req, res) => {
  const view = String(req.query.view || 'employee');
  const now = new Date();
  const filter = await dashboardFilter(req);

  if (view === 'trend') return res.json(await trend(filter, req.query.grain, now));

  // Category rows are per TASK, not per person: a task filed under Sales is one
  // Sales task however many people are on it.
  if (view === 'category') {
    const rows = await Task.aggregate([
      { $match: filter },
      TASK_STATUS_NOW,
      // No `$unwind`: this counts TASKS, and `perTask` sums everybody's points
      // per row itself.
      { $group: { _id: { $ifNull: ['$category', ''] }, ...perTask(now) } },
      { $sort: { total: -1 } },
      { $limit: 200 },
    ]);
    return res.json({
      view,
      rows: rows.map((r) => scoreRow(r, r._id || 'Uncategorised', { key: r._id || '' })),
    });
  }

  // Everything else is per person.
  const match = { ...filter };
  if (view === 'mine') {
    // One row: the signed-in person's own. The only tab an ordinary employee
    // is offered, and it needs no capability at all.
    const rows = await Task.aggregate([
      { $match: match },
      { $unwind: '$assignees' },
      { $match: { 'assignees.user': new mongoose.Types.ObjectId(req.user._id) } },
      PERSON_STATUS_NOW,
      { $group: { _id: '$assignees.user', ...perPerson(now) } },
    ]);
    const r = rows[0];
    return res.json({
      view,
      rows: r ? [scoreRow(r, 'You', { key: String(req.user._id) })] : [],
    });
  }

  if (view === 'delegated') {
    // What I handed out, grouped by who I handed it to.
    const rows = await Task.aggregate([
      { $match: { ...match, createdBy: new mongoose.Types.ObjectId(req.user._id) } },
      { $unwind: '$assignees' },
      PERSON_STATUS_NOW,
      {
        $group: {
          _id: '$assignees.user',
          name: { $first: '$assignees.name' },
          code: { $first: '$assignees.employeeCode' },
          ...perPerson(now),
        },
      },
      { $sort: { total: -1 } },
      { $limit: 200 },
    ]);
    return res.json({
      view,
      rows: rows.map((r) => scoreRow(r, r.name || '—', { key: String(r._id), code: r.code || '' })),
    });
  }

  // employee — the default, and the one that needs `tasks.manage`.
  if (!access.seesEverything(req.user)) {
    res.status(403);
    throw new Error('The team dashboard is for managers. Your own figures are on My Report.');
  }

  const rows = await Task.aggregate([
    { $match: match },
    { $unwind: '$assignees' },
    PERSON_STATUS_NOW,
    {
      $group: {
        _id: '$assignees.user',
        name: { $first: '$assignees.name' },
        code: { $first: '$assignees.employeeCode' },
        ...perPerson(now),
      },
    },
    { $sort: { total: -1 } },
    { $limit: 500 },
  ]);

  res.json({
    view,
    rows: rows.map((r) => scoreRow(r, r.name || '—', { key: String(r._id), code: r.code || '' })),
  });
});

/**
 * A row per day or month — the shape of the workload over time.
 *
 * Keyed on the DEADLINE, matching every other date filter in the module: "how
 * much was due that day, and how much of it landed".
 */
async function trend(filter, grainRaw, now) {
  const grain = grainRaw === 'month' ? 'month' : 'day';
  const fmt = grain === 'month' ? '%Y-%m' : '%Y-%m-%d';
  const rows = await Task.aggregate([
    // `$and` rather than spreading `filter.dueDate`: the filter may already
    // carry a window, and merging two `dueDate` objects by spread silently
    // drops whichever bound they share.
    { $match: { $and: [filter, { dueDate: { $ne: null } }] } },
    TASK_STATUS_NOW,
    {
      $group: {
        // Asia/Kolkata, so a task due at 11pm is counted on the day it was
        // actually due here rather than the UTC day it fell into.
        _id: { $dateToString: { format: fmt, date: '$dueDate', timezone: 'Asia/Kolkata' } },
        // Per TASK: a day's row answers "how much was due", not "how many
        // person-jobs were due".
        ...perTask(now),
      },
    },
    { $sort: { _id: 1 } },
    { $limit: 400 },
  ]);
  return { view: 'trend', grain, rows: rows.map((r) => scoreRow(r, r._id, { key: r._id })) };
}

/**
 * GET /api/tasks/dashboard/overdue — the overdue report.
 *
 * A list rather than a table of figures: when somebody clicks the red number
 * they want to know WHICH ones, and by how long.
 */
const overdueReport = asyncHandler(async (req, res) => {
  const now = new Date();
  const filter = await dashboardFilter(req);
  const rows = await Task.find({
    ...filter,
    // Every spelling — a row nobody has migrated still says ASSIGNED.
    status: { $in: spellingsOf(STATUS.PENDING, STATUS.IN_PROGRESS) },
    dueDate: { $lt: now },
  })
    .select('code title category priority status dueDate assignees createdByName points')
    .sort({ dueDate: 1 })
    .limit(500)
    .lean();

  res.json({
    rows: rows.map((t) => ({
      ...t,
      status: normaliseStatus(t.status) || t.status,
      // Whole days late, rounded down — "3 days" reads better than "3.4".
      daysLate: Math.floor((now - new Date(t.dueDate)) / 86400000),
      who: (t.assignees || []).map((a) => a.name).filter(Boolean).join(', '),
    })),
  });
});

module.exports = { dashboard, overdueReport };
