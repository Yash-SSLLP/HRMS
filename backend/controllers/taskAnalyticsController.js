/**
 * Task controller, part four — the numbers.
 *
 * Dashboards, workload and the spreadsheet exports (sections 28, 29, 45, 49).
 *
 * NO CALENDAR HERE. Tasks appear on the ONE calendar the portal already has
 * (pages/Calendar.jsx, fed by GET /celebrations/calendar, where a task deadline
 * is one entry type beside holidays, events, birthdays and reminders). A second
 * month grid inside the Tasks page would be a second place to look for the same
 * answer — user decision, 2026-09-17.
 *
 * EVERY FIGURE IS SHOWN, NOT SCORED. Section 49 asks for transparent underlying
 * metrics and explicitly warns against inventing a productivity score, so
 * nothing here combines unlike things into one number: "12 completed, 9 of them
 * on time, 3 overdue, average 2.4 days" is four honest facts, and a "76%
 * performance index" would be a made-up fifth that hides all of them.
 *
 * EVERY QUERY IS AN AGGREGATE. These screens ask about thousands of tasks at
 * once, and the answer is counts and averages — pulling the documents into Node
 * to count them there is what makes a dashboard take nine seconds.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const ExcelJS = require('exceljs');

const Task = require('../models/Task');
const TaskTimeEntry = require('../models/TaskTimeEntry');
const TaskIncentive = require('../models/TaskIncentive');
const EmployeeProfile = require('../models/EmployeeProfile');

const access = require('../services/taskAccess');
const { normaliseStatus, statusLabel, TERMINAL_STATUS } = require('../config/taskWorkflow');
const { istDateString } = require('../utils/istDate');

const OPEN_STATUSES = { $nin: [...TERMINAL_STATUS, 'Done'] };

/** The date range a report covers, defaulting to the last 90 days. */
function rangeOf(query) {
  const to = query.to ? new Date(`${query.to}T23:59:59.999`) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - 90 * 86400000);
  return { from, to };
}

/**
 * The base filter for a report: what this viewer may see, plus their filters.
 * @param {import('express').Request} req
 * @returns {Promise<object>}
 */
async function reportFilter(req) {
  const filter = { ...(await access.visibilityFilter(req)), archived: { $ne: true } };
  const and = [];
  const { from, to } = rangeOf(req.query);
  and.push({ createdAt: { $gte: from, $lte: to } });
  if (req.query.department) and.push({ department: req.query.department });
  if (req.query.taskType) and.push({ taskType: req.query.taskType });
  if (req.query.priority) and.push({ priority: req.query.priority });
  if (req.query.workflow && mongoose.isValidObjectId(req.query.workflow)) {
    and.push({ workflowRef: new mongoose.Types.ObjectId(req.query.workflow) });
  }
  if (req.query.assignedTo && mongoose.isValidObjectId(req.query.assignedTo)) {
    and.push({ $or: [
      { assignedTo: new mongoose.Types.ObjectId(req.query.assignedTo) },
      { 'assignees.user': new mongoose.Types.ObjectId(req.query.assignedTo) },
    ] });
  }
  if (and.length) filter.$and = [...(filter.$and || []), ...and];
  return filter;
}

/**
 * Organisation-wide task metrics (sections 29 and 49).
 * @route GET /api/tasks/analytics
 */
const taskAnalytics = asyncHandler(async (req, res) => {
  const filter = await reportFilter(req);
  const now = new Date();

  const [
    byStatus, byPriority, byDepartment, byType,
    completion, overdueNow, extensionStats, rejectionStats, acceptanceStats, incentiveStats, trend,
  ] = await Promise.all([
    Task.aggregate([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Task.aggregate([{ $match: filter }, { $group: { _id: '$priority', n: { $sum: 1 } } }]),
    Task.aggregate([
      { $match: filter },
      { $group: {
        _id: '$department',
        total: { $sum: 1 },
        completed: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'Done']] }, 1, 0] } },
        overdue: { $sum: { $cond: [{ $and: [
          { $not: { $in: ['$status', ['COMPLETED', 'Done', 'CANCELLED', 'DECLINED']] } },
          { $lt: ['$dueDate', now] },
        ] }, 1, 0] } },
      } },
      { $sort: { total: -1 } },
      { $limit: 40 },
    ]),
    Task.aggregate([{ $match: filter }, { $group: { _id: '$taskType', n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 20 }]),

    // Completed tasks: how long they took, how many were on time, and how long
    // an approval sat waiting. Only tasks that HAVE a deadline count towards
    // on-time — a task with no due date can be neither early nor late, and
    // counting it as "on time" would flatter every figure.
    Task.aggregate([
      { $match: { ...filter, status: { $in: ['COMPLETED', 'Done'] }, completedAt: { $ne: null } } },
      { $project: {
        turnaroundMs: { $subtract: ['$completedAt', { $ifNull: ['$assignedAt', '$createdAt'] }] },
        approvalMs: { $cond: [
          { $and: [{ $ne: ['$submittedAt', null] }, { $ne: ['$approvedAt', null] }] },
          { $subtract: ['$approvedAt', '$submittedAt'] },
          null,
        ] },
        hasDue: { $cond: [{ $ne: ['$dueDate', null] }, 1, 0] },
        onTime: { $cond: [
          { $and: [{ $ne: ['$dueDate', null] }, { $lte: ['$completedAt', '$dueDate'] }] }, 1, 0,
        ] },
        lateMs: { $cond: [
          { $and: [{ $ne: ['$dueDate', null] }, { $gt: ['$completedAt', '$dueDate'] }] },
          { $subtract: ['$completedAt', '$dueDate'] }, null,
        ] },
      } },
      { $group: {
        _id: null,
        completed: { $sum: 1 },
        withDue: { $sum: '$hasDue' },
        onTime: { $sum: '$onTime' },
        avgTurnaroundMs: { $avg: '$turnaroundMs' },
        avgApprovalMs: { $avg: '$approvalMs' },
        avgLateMs: { $avg: '$lateMs' },
      } },
    ]),

    Task.countDocuments({ ...filter, status: OPEN_STATUSES, dueDate: { $lt: now } }),
    Task.aggregate([
      { $match: filter },
      { $group: { _id: null, withExtension: { $sum: { $cond: [{ $gt: ['$extensionCount', 0] }, 1, 0] } }, total: { $sum: 1 } } },
    ]),
    Task.aggregate([
      { $match: filter },
      { $group: { _id: null, rejected: { $sum: { $cond: [{ $gt: ['$rejectionCount', 0] }, 1, 0] } }, total: { $sum: 1 } } },
    ]),
    Task.aggregate([
      { $match: filter },
      { $group: {
        _id: null,
        accepted: { $sum: { $cond: [{ $ne: ['$acceptedAt', null] }, 1, 0] } },
        declined: { $sum: { $cond: [{ $in: ['$status', ['DECLINED']] }, 1, 0] } },
        total: { $sum: 1 },
      } },
    ]),
    TaskIncentive.aggregate([
      { $group: { _id: '$status', points: { $sum: '$points' }, n: { $sum: 1 } } },
    ]),

    // Completions per day, for the trend line.
    Task.aggregate([
      { $match: { ...filter, completedAt: { $ne: null } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: 'Asia/Kolkata' } },
        n: { $sum: 1 },
      } },
      { $sort: { _id: 1 } },
      { $limit: 180 },
    ]),
  ]);

  const c = completion[0] || {};
  const ext = extensionStats[0] || {};
  const rej = rejectionStats[0] || {};
  const acc = acceptanceStats[0] || {};

  const statusCounts = {};
  for (const row of byStatus) {
    const key = normaliseStatus(row._id) || row._id;
    statusCounts[key] = (statusCounts[key] || 0) + row.n;
  }
  const total = Object.values(statusCounts).reduce((t, n) => t + n, 0);
  const hours = (ms) => (ms ? Math.round((ms / 3600000) * 10) / 10 : 0);
  const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

  res.json({
    range: rangeOf(req.query),
    totals: {
      total,
      completed: statusCounts.COMPLETED || 0,
      open: total - (statusCounts.COMPLETED || 0) - (statusCounts.CANCELLED || 0) - (statusCounts.DECLINED || 0),
      overdueNow,
      cancelled: statusCounts.CANCELLED || 0,
      declined: statusCounts.DECLINED || 0,
    },
    byStatus: Object.entries(statusCounts)
      .map(([key, n]) => ({ key, label: statusLabel(key), n }))
      .sort((a, b) => b.n - a.n),
    byPriority: byPriority.map((r) => ({ key: r._id || 'Medium', n: r.n })),
    byDepartment: byDepartment.map((r) => ({
      department: r._id || 'Unassigned',
      total: r.total,
      completed: r.completed,
      overdue: r.overdue,
      completionPct: pct(r.completed, r.total),
    })),
    byType: byType.map((r) => ({ type: r._id || 'General', n: r.n })),
    // Each of these is one fact with its denominator stated, so nobody has to
    // guess what a percentage is a percentage OF.
    rates: {
      completionPct: pct(c.completed || 0, total),
      onTimePct: pct(c.onTime || 0, c.withDue || 0),
      onTimeOf: c.withDue || 0,
      acceptancePct: pct(acc.accepted || 0, acc.total || 0),
      declinePct: pct(acc.declined || 0, acc.total || 0),
      rejectionPct: pct(rej.rejected || 0, rej.total || 0),
      extensionPct: pct(ext.withExtension || 0, ext.total || 0),
    },
    durations: {
      avgTurnaroundHours: hours(c.avgTurnaroundMs),
      avgApprovalHours: hours(c.avgApprovalMs),
      avgDelayHours: hours(c.avgLateMs),
    },
    incentive: Object.fromEntries(
      incentiveStats.map((r) => [r._id, { points: Math.round(r.points * 100) / 100, count: r.n }])
    ),
    trend: trend.map((r) => ({ day: r._id, completed: r.n })),
  });
});

/**
 * Per-employee workload for a manager's dashboard (section 28).
 *
 * The spec's own shape: "Rahul — 8 active — 2 overdue — 31h". Nothing is ranked
 * and nothing is scored — it is a list of people and what is on their plate, so
 * a manager can see who is drowning and move something.
 *
 * @route GET /api/tasks/workload
 */
const workload = asyncHandler(async (req, res) => {
  const base = { ...(await access.visibilityFilter(req)), archived: { $ne: true } };
  const and = [];
  if (req.query.department) and.push({ department: req.query.department });
  if (req.query.priority) and.push({ priority: req.query.priority });
  if (and.length) base.$and = [...(base.$and || []), ...and];

  const now = new Date();
  const { istDayRange } = require('../utils/istDate');
  const today = istDayRange(istDateString(now));

  const rows = await Task.aggregate([
    { $match: base },
    // One row per person per task, so a four-person task counts on all four
    // plates. That is what a workload IS — the alternative, counting it only on
    // the primary assignee, makes everyone else look idle.
    { $unwind: { path: '$assignees', preserveNullAndEmptyArrays: false } },
    { $group: {
      _id: '$assignees.user',
      total: { $sum: 1 },
      active: { $sum: { $cond: [
        { $not: { $in: ['$status', ['COMPLETED', 'Done', 'CANCELLED', 'DECLINED']] } }, 1, 0,
      ] } },
      overdue: { $sum: { $cond: [{ $and: [
        { $not: { $in: ['$status', ['COMPLETED', 'Done', 'CANCELLED', 'DECLINED']] } },
        { $lt: ['$dueDate', now] },
      ] }, 1, 0] } },
      dueToday: { $sum: { $cond: [{ $and: [
        { $not: { $in: ['$status', ['COMPLETED', 'Done', 'CANCELLED', 'DECLINED']] } },
        { $gte: ['$dueDate', today.start] },
        { $lte: ['$dueDate', today.end] },
      ] }, 1, 0] } },
      completed: { $sum: { $cond: [{ $in: ['$status', ['COMPLETED', 'Done']] }, 1, 0] } },
      estimatedMinutes: { $sum: { $ifNull: ['$estimatedMinutes', 0] } },
      loggedMinutes: { $sum: { $ifNull: ['$assignees.minutesLogged', 0] } },
    } },
    { $sort: { active: -1 } },
    { $limit: 200 },
  ]);

  const ids = rows.map((r) => r._id).filter(Boolean);
  const [users, profiles] = await Promise.all([
    mongoose.model('User').find({ _id: { $in: ids } }).select('firstName lastName photo role').lean(),
    EmployeeProfile.find({ user: { $in: ids } }).select('user employeeCode department designation').lean(),
  ]);
  const byUser = new Map(users.map((u) => [String(u._id), u]));
  const profOf = new Map(profiles.map((p) => [String(p.user), p]));

  res.json({
    count: rows.length,
    people: rows.map((r) => {
      const u = byUser.get(String(r._id));
      const p = profOf.get(String(r._id));
      return {
        user: r._id,
        name: u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : 'Unknown',
        photo: u ? u.photo : null,
        employeeCode: p ? p.employeeCode : undefined,
        department: p ? p.department : undefined,
        designation: p ? p.designation : undefined,
        total: r.total,
        active: r.active,
        overdue: r.overdue,
        dueToday: r.dueToday,
        completed: r.completed,
        estimatedHours: Math.round((r.estimatedMinutes / 60) * 10) / 10,
        loggedHours: Math.round((r.loggedMinutes / 60) * 10) / 10,
      };
    }),
  });
});

// ===== Exports (section 45) =====

/** Give a worksheet the same header treatment every export in this app uses. */
function styleHeader(ws, title) {
  if (title) {
    ws.spliceRows(1, 0, [title]);
    ws.mergeCells(1, 1, 1, ws.columnCount);
    const cell = ws.getCell(1, 1);
    cell.font = { bold: true, size: 13 };
    cell.alignment = { vertical: 'middle' };
    ws.getRow(1).height = 22;
  }
  const headerRow = ws.getRow(title ? 2 : 1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: 'middle', wrapText: true };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
  });
  ws.views = [{ state: 'frozen', ySplit: title ? 2 : 1 }];
}

const fmt = (d) => (d
  ? new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    hour12: true, timeZone: 'Asia/Kolkata',
  })
  : '');

/**
 * Tasks as a spreadsheet.
 *
 * .xlsx, never CSV — every export in this portal is a workbook (see
 * services/*Excel.js), and a CSV of dates and multi-line remarks opens wrong in
 * Excel half the time.
 *
 * @route GET /api/tasks/export
 */
const exportTasks = asyncHandler(async (req, res) => {
  const filter = { ...(await access.visibilityFilter(req)) };
  const and = [];
  if (req.query.status) {
    const wanted = String(req.query.status).split(',').map((s) => normaliseStatus(s.trim())).filter(Boolean);
    if (wanted.length) and.push({ status: { $in: wanted } });
  }
  if (req.query.department) and.push({ department: req.query.department });
  const { from, to } = rangeOf(req.query);
  and.push({ createdAt: { $gte: from, $lte: to } });
  if (req.query.archived !== 'true') and.push({ archived: { $ne: true } });
  if (and.length) filter.$and = [...(filter.$and || []), ...and];

  const tasks = await Task.find(filter)
    .populate('assignedTo', 'firstName lastName')
    .populate('assignees.user', 'firstName lastName')
    .populate('supervisor', 'firstName lastName')
    .populate('createdBy', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(20000)
    .lean();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence Surface';
  wb.created = new Date();

  const ws = wb.addWorksheet('Tasks');
  ws.columns = [
    { header: 'Task ID', key: 'code', width: 18 },
    { header: 'Title', key: 'title', width: 40 },
    { header: 'Type', key: 'type', width: 16 },
    { header: 'Department', key: 'department', width: 18 },
    { header: 'Priority', key: 'priority', width: 10 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Progress %', key: 'progress', width: 11 },
    { header: 'Assignees', key: 'assignees', width: 36 },
    { header: 'Supervisor', key: 'supervisor', width: 22 },
    { header: 'Created by', key: 'createdBy', width: 22 },
    { header: 'Start', key: 'start', width: 20 },
    { header: 'Original due', key: 'originalDue', width: 20 },
    { header: 'Due', key: 'due', width: 20 },
    { header: 'Submitted', key: 'submitted', width: 20 },
    { header: 'Completed', key: 'completed', width: 20 },
    { header: 'Overdue', key: 'overdue', width: 9 },
    { header: 'Extensions', key: 'extensions', width: 11 },
    { header: 'Sent back', key: 'rejections', width: 10 },
    { header: 'Estimated (h)', key: 'estimated', width: 13 },
    { header: 'Logged (h)', key: 'logged', width: 11 },
    { header: 'Workflow', key: 'workflow', width: 24 },
    { header: 'Incentive points', key: 'points', width: 15 },
  ];
  const label = `Tasks — ${istDateString(from)} to ${istDateString(to)}`;
  styleHeader(ws, label);

  const name = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '');
  const now = new Date();
  for (const t of tasks) {
    const status = normaliseStatus(t.status) || t.status;
    ws.addRow({
      code: t.code || String(t._id).slice(-6),
      title: t.title,
      type: t.taskType,
      department: t.department,
      priority: t.priority,
      status: statusLabel(status),
      progress: t.progress || 0,
      assignees: (t.assignees || []).map((a) => name(a.user) || a.name).filter(Boolean).join(', ')
        || name(t.assignedTo),
      supervisor: name(t.supervisor),
      createdBy: name(t.createdBy),
      start: fmt(t.startDate),
      originalDue: fmt(t.originalDueDate),
      due: fmt(t.dueDate),
      submitted: fmt(t.submittedAt),
      completed: fmt(t.completedAt),
      overdue: (!['COMPLETED', 'CANCELLED', 'DECLINED'].includes(status) && t.dueDate && t.dueDate < now) ? 'Yes' : '',
      extensions: t.extensionCount || 0,
      rejections: t.rejectionCount || 0,
      estimated: t.estimatedMinutes ? Math.round((t.estimatedMinutes / 60) * 10) / 10 : '',
      logged: t.minutesLogged ? Math.round((t.minutesLogged / 60) * 10) / 10 : '',
      workflow: t.workflowName || '',
      points: t.incentive && t.incentive.enabled ? t.incentive.points : '',
    });
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="tasks_${istDateString(new Date())}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

/**
 * Time entries as a spreadsheet.
 * @route GET /api/tasks/export/timesheet
 */
const exportTimesheet = asyncHandler(async (req, res) => {
  const { from, to } = rangeOf(req.query);
  const filter = { startedAt: { $gte: from, $lte: to } };
  if (req.query.user && mongoose.isValidObjectId(req.query.user)) filter.user = req.query.user;

  // The wall: only the tasks this viewer may see.
  const visible = await Task.find({ ...(await access.visibilityFilter(req)) }).select('_id').lean();
  filter.task = { $in: visible.map((t) => t._id) };

  const entries = await TaskTimeEntry.find(filter)
    .populate('user', 'firstName lastName')
    .populate('task', 'code title department')
    .sort({ startedAt: -1 })
    .limit(30000)
    .lean();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence Surface';
  const ws = wb.addWorksheet('Timesheet');
  ws.columns = [
    { header: 'Date', key: 'day', width: 13 },
    { header: 'Employee', key: 'user', width: 24 },
    { header: 'Task ID', key: 'code', width: 18 },
    { header: 'Task', key: 'task', width: 40 },
    { header: 'Department', key: 'department', width: 18 },
    { header: 'Started', key: 'started', width: 20 },
    { header: 'Ended', key: 'ended', width: 20 },
    { header: 'Break (min)', key: 'breakMinutes', width: 12 },
    { header: 'Worked (min)', key: 'minutes', width: 13 },
    { header: 'Worked (h)', key: 'hours', width: 11 },
    { header: 'Source', key: 'source', width: 10 },
    { header: 'Approval', key: 'approval', width: 12 },
    { header: 'Note', key: 'note', width: 34 },
  ];
  styleHeader(ws, `Task timesheet — ${istDateString(from)} to ${istDateString(to)}`);

  let total = 0;
  for (const e of entries) {
    const mins = e.status === 'stopped' ? e.activeMinutes : TaskTimeEntry.measure(e).activeMinutes;
    if (e.approvalStatus !== 'Rejected') total += mins;
    ws.addRow({
      day: e.dayKey,
      user: e.user ? `${e.user.firstName || ''} ${e.user.lastName || ''}`.trim() : e.userName,
      code: e.task ? e.task.code : '',
      task: e.task ? e.task.title : '',
      department: e.task ? e.task.department : '',
      started: fmt(e.startedAt),
      ended: fmt(e.endedAt),
      breakMinutes: e.breakMinutes || 0,
      minutes: mins,
      hours: Math.round((mins / 60) * 100) / 100,
      source: e.source,
      approval: e.approvalStatus || '',
      note: e.note || '',
    });
  }
  ws.addRow({});
  const totalRow = ws.addRow({ task: 'TOTAL', minutes: total, hours: Math.round((total / 60) * 100) / 100 });
  totalRow.font = { bold: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="task-timesheet_${istDateString(new Date())}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

module.exports = {
  taskAnalytics,
  workload,
  exportTasks,
  exportTimesheet,
};
