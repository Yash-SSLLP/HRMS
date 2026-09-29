/**
 * Tasks — the whole API.
 *
 * REWRITTEN 2026-09-21, replacing taskController (1375 lines), taskWorkController
 * (1158) and taskWorkflowController (485). Three controllers existed because the
 * module had three vocabularies: the task, the work done on it, and the workflow
 * it ran through. There is now one of each, so there is one file.
 *
 * The shape of every list endpoint is the same and is worth stating once:
 *
 *   scope    which pile     — mine | delegated | loop | all | requests
 *   range    which window   — today | yesterday | week | month | nextWeek | all | custom
 *                             (on today/week/month, open work always shows)
 *   filters  category, assignedTo, assignedBy, frequency, priority, status, q
 *
 * …and every one of them runs ON THE SERVER. The brief's app shows a live
 * counter row above the list (Overdue / Pending / In Progress / Completed, and
 * Completed split In Time / Delayed) which must agree with the rows below it, so
 * counts and rows come from ONE filter built once — `buildQuery` — and the
 * counters are an aggregation over that same filter rather than a tally of the
 * page that happens to be loaded.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Task = require('../models/Task');
const TaskUpdate = require('../models/TaskUpdate');
const TaskCategory = require('../models/TaskCategory');
const TaskTemplate = require('../models/TaskTemplate');
const RecurringTask = require('../models/RecurringTask');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');

const engine = require('../services/taskEngine');
const access = require('../services/taskAccess');
const notify = require('../services/taskNotify');
const points = require('../services/taskPoints');
const storage = require('../services/storage');

const { pickableUserFilter } = require('../utils/peoplePicker');
const { departedUserIdSet } = require('../utils/departed');
const { viewerCompanyScope } = require('../utils/employeeScope');
// What people typed, in the reader's app language (2026-09-29) — see there.
const { localise } = require('../services/translate');
const {
  KIND_TASK, KIND_REQUEST, TASK_KINDS, STATUS, TASK_STATUS, OPEN_STATUS, TASK_PRIORITY,
  DEFAULT_PRIORITY, FREQUENCY, FREQUENCIES, FREQUENCY_LABELS, WEEKDAYS,
  REMINDER_CHANNELS, REMINDER_UNITS, REMINDER_WHENS, REMINDER_CHANNEL_LABELS,
  DEFAULT_TASK_POINTS, MAX_TASK_POINTS, evidenceKindFor, statusLabel, isOverdue, isTerminal,
  isDeclined, isAwaitingAcceptance, ACCEPTANCE_LABELS, ACCEPTANCE,
  // 2026-09-22: the review state, the pieces, the colours and the sort.
  normalisePriority, LEGACY_PRIORITY_MAP, PRIORITY_COLORS, DONE_COLOR, CANCELLED_COLOR,
  accentFor, PRIORITY_RANK, BOARD_COLUMNS, SORTS, SORT_KEYS, DEFAULT_SORT,
  PROGRESS_STEPS, MAX_SUBTASKS, EXTENSION_STATUS, clampProgress,
  normaliseStatus, spellingsOf, kindFilter, normaliseStatusStage,
  // 2026-09-27: the edit trail, the bell, and the recurring shapes.
  EDIT_FIELD_LABELS, reminderLabel, NUDGE_COOLDOWN_MIN, nudgeReadyAt,
  REMINDER_WHEN, REPEAT_REMINDER, MONTHLY_MODE, MONTHLY_MODES, NTH_WEEKS, NTH_WEEK_LABELS,
  MAX_DAY_INTERVAL, DEFAULT_LEAD_DAYS, MAX_LEAD_DAYS, WEEKDAY_NAMES, isRoutineFrequency,
  patternLabel,
  // …and the shapes a repeating reminder can take.
  REMINDER_PATTERN, REMINDER_PATTERNS, REMINDER_PATTERN_LABELS, DEFAULT_REMIND_AT,
  DEFAULT_REMIND_WINDOW, MAX_REMIND_EVERY_HOURS, reminderPattern, hhmmOf,
} = require('../config/tasks');

// ===== Small shared helpers =====

const oid = (v) => (mongoose.Types.ObjectId.isValid(v) ? new mongoose.Types.ObjectId(v) : null);
const personName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ').trim();

function bad(res, message, status = 400) {
  res.status(status);
  throw new Error(message);
}

/** A comma-separated query parameter as a clean array. */
function listParam(v) {
  if (!v) return [];
  return String(v).split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * The date window the chip bar asks for.
 *
 * Computed in the SERVER's timezone, which is the portal's — a browser in
 * another zone asking for "today" means the company's today, not its own.
 * Returns null for "all time", which is not a filter at all.
 */
function rangeWindow(range, fromRaw, toRaw) {
  const now = new Date();
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const today = startOfDay(now);

  switch (range) {
    case 'today': return { $gte: today, $lt: addDays(today, 1) };
    case 'yesterday': return { $gte: addDays(today, -1), $lt: today };
    case 'week': {
      // Monday-first, matching how the rest of the portal reads a week.
      const dow = (today.getDay() + 6) % 7;
      const monday = addDays(today, -dow);
      return { $gte: monday, $lt: addDays(monday, 7) };
    }
    case 'nextWeek': {
      const dow = (today.getDay() + 6) % 7;
      const monday = addDays(today, -dow + 7);
      return { $gte: monday, $lt: addDays(monday, 7) };
    }
    case 'month': {
      const first = new Date(now.getFullYear(), now.getMonth(), 1);
      return { $gte: first, $lt: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
    }
    case 'custom': {
      const from = fromRaw ? new Date(fromRaw) : null;
      const to = toRaw ? new Date(toRaw) : null;
      if (!from && !to) return null;
      const w = {};
      if (from && !Number.isNaN(from.getTime())) w.$gte = startOfDay(from);
      if (to && !Number.isNaN(to.getTime())) w.$lt = addDays(startOfDay(to), 1);
      return Object.keys(w).length ? w : null;
    }
    default: return null; // 'all'
  }
}

/** The chips that contain today — where open work always shows (see buildQuery). */
const CURRENT_RANGES = ['today', 'week', 'month'];

/**
 * ONE filter, used by the list AND by the counters above it.
 *
 * If these two were built separately they would drift, and a counter that
 * disagrees with the rows underneath it is worse than no counter — it makes
 * people stop trusting the page.
 *
 * `strictRange` is the dashboard's: a date chip there always means "due in
 * that period". It is a third argument rather than an override so no client
 * can send it.
 */
async function buildQuery(req, overrides = {}, { strictRange = false } = {}) {
  const {
    scope = 'all', range = 'all', from, to,
    category, assignedTo, assignedBy, frequency, priority, status, q, kind, overdue, late, moreTime,
    includeSubtasks, parentTask, department,
    // `overrides` lets a caller pin one parameter without faking a request
    // object. Spreading an Express `req` copies own properties only and quietly
    // loses `user`, which is how the dashboard first lost its company wall.
  } = { ...req.query, ...overrides };

  const filter = await access.visibleFilter(req, scope === 'requests' ? 'all' : scope);
  const and = [filter];

  /**
   * WHICH KIND OF ROW.
   *
   * Until 2026-09-25 a request was its own pile and never appeared among the
   * tasks. Requests are retired now (anybody may set anybody a task), so with
   * no `kind` asked for, EVERY row is listed — the handful of requests raised
   * before the change among them, rather than stranded behind a tab the
   * current clients no longer draw. The Tasks badge never filtered on kind,
   * so this is also what keeps a live request from badging somebody over an
   * empty list. `scope=requests` still answers for an older Android build,
   * and the dashboard still asks for TASK explicitly (a score is over work
   * that was set, and a request carries no points).
   */
  if (scope === 'requests') and.push({ kind: kindFilter(KIND_REQUEST) });
  else if (kind && TASK_KINDS.includes(kind)) and.push({ kind: kindFilter(kind) });

  /**
   * The window applies to the DEADLINE — "this week" is the work due this week,
   * not the work created this week — but on Today / This week / This month it
   * narrows FINISHED work only. Every open task shows, whatever its deadline,
   * including none. (User decision, 2026-09-24.)
   *
   * The page opens on This month, and the Tasks badge counts every open task on
   * the person. Filtered strictly, a task due last month and still undone, one
   * due next month, or one with no deadline put a red number on the pill over a
   * page saying "Nothing on your plate". Open work is never filtered out of the
   * present; finished work stays filed under the period it was due in.
   *
   * Yesterday, Next week and Custom look up one period and stay strict, and so
   * does the dashboard (`strictRange`): a score for "this month" has to be over
   * what was DUE this month, or a job due in December drags September down.
   */
  const window = rangeWindow(range, from, to);
  if (window) {
    const carryOpen = !strictRange && CURRENT_RANGES.includes(range);
    and.push(carryOpen
      ? { $or: [{ dueDate: window }, { status: { $in: spellingsOf(...OPEN_STATUS) } }] }
      : { dueDate: window });
  }

  const cats = listParam(category);
  if (cats.length) and.push({ category: { $in: cats } });

  const doers = listParam(assignedTo).map(oid).filter(Boolean);
  if (doers.length) and.push({ 'assignees.user': { $in: doers } });

  const setters = listParam(assignedBy).map(oid).filter(Boolean);
  if (setters.length) and.push({ createdBy: { $in: setters } });

  /**
   * DEPARTMENT (2026-09-25) — the department of the OTHER side of the task.
   *
   * On "Assigned to me" every row is mine, so filtering on my own department
   * would change nothing; the useful question there is which department the
   * work came FROM. On "Assigned by me" it is which department it went TO.
   * Anywhere else (the admin's company-wide view) either side will do.
   *
   * Departments are free text on the employee profile, so this is two steps:
   * the people in those departments, then the tasks they are on. Matched
   * case-insensitively and exactly — "Sales" must not also pull in "Sales &
   * Marketing". A department nobody is in returns nothing, honestly, rather
   * than being dropped as if it had not been asked for.
   */
  const depts = listParam(department);
  if (depts.length) {
    const exact = depts.map((d) => new RegExp(`^${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
    const inDept = await EmployeeProfile.find({ department: { $in: exact } })
      .select('user').lean();
    const people = inDept.map((p) => p.user).filter(Boolean);
    const from = { createdBy: { $in: people } };
    const onIt = { 'assignees.user': { $in: people } };
    if (scope === 'mine') and.push(from);
    else if (scope === 'delegated') and.push(onIt);
    else and.push({ $or: [from, onIt] });
  }

  const freqs = listParam(frequency).filter((f) => FREQUENCIES.includes(f));
  if (freqs.length) and.push({ 'repeat.frequency': { $in: freqs } });

  // Normalised, so a filter chip saying "Urgent" still matches the fifty rows
  // that say `High` and have not been through the migration yet.
  const prios = [...new Set(listParam(priority).map(normalisePriority).filter(Boolean))];
  if (prios.length) {
    const wanted = new Set(prios);
    const legacy = Object.entries(LEGACY_PRIORITY_MAP)
      .filter(([, v]) => wanted.has(v)).map(([k]) => k);
    and.push({ priority: { $in: [...prios, ...legacy] } });
  }

  // Expanded to every spelling, the same way the priority filter above is: a
  // filter chip saying "Pending" must match the rows that say ASSIGNED.
  const states = listParam(status).filter((s) => TASK_STATUS.includes(s));
  if (states.length) and.push({ status: { $in: spellingsOf(...states) } });

  /**
   * THE PIECES, in or out.
   *
   * A piece is a Task like any other (models/Task.parentTask), so without this
   * every list would show the parent AND its five pieces, and a manager who
   * split one job into five would see six rows for one job.
   *
   * The default differs by tab on purpose. On MY TASKS a piece IS the work I
   * have been given and hiding it would hide my whole day; everywhere else a
   * piece is detail that belongs under the task it came from, which is where
   * the detail page shows it. The client can flip it either way with
   * `includeSubtasks`.
   */
  const pieces = includeSubtasks === undefined || includeSubtasks === null || includeSubtasks === ''
    ? (scope === 'mine' || scope === 'requests')
    : !(includeSubtasks === '0' || includeSubtasks === 'false' || includeSubtasks === false);
  if (parentTask && oid(parentTask)) and.push({ parentTask: oid(parentTask) });
  else if (!pieces) and.push({ parentTask: null });

  // Overdue is derived, so it is a query rather than a status: open, and past
  // its deadline. Asking for it alongside `status=COMPLETED` correctly returns
  // nothing, which is the honest answer.
  if (overdue === 'true' || overdue === '1') {
    and.push({
      status: { $in: spellingsOf(STATUS.PENDING, STATUS.IN_PROGRESS) },
      dueDate: { $lt: new Date() },
    });
  } else if (overdue === 'false' || overdue === '0') {
    /**
     * …AND ITS OPPOSITE, so the Pending tile can be clicked honestly.
     *
     * The tiles never overlap — a late pending task is counted as Overdue, not
     * Pending — but there was no way to ASK for "pending and not late", so
     * clicking Pending listed the late ones too and the rows disagreed with the
     * figure above them. Anything that is not open-and-past-its-deadline.
     */
    and.push({
      $nor: [{
        status: { $in: spellingsOf(STATUS.PENDING, STATUS.IN_PROGRESS) },
        dueDate: { $lt: new Date() },
      }],
    });
  }

  // The In Time / Delayed split, for when somebody clicks one of those two
  // figures. Reads the FROZEN flag rather than comparing dates, so it returns
  // exactly the rows the counter counted — a task whose deadline was moved
  // after it was finished must not appear under one figure and be counted
  // under the other. `$ne: true` rather than `false`, because rows written
  // before the field existed have no value at all and were on time.
  if (late === 'true' || late === '1') and.push({ completedLate: true });
  else if (late === 'false' || late === '0') and.push({ completedLate: { $ne: true } });

  // MORE TIME ASKED — the "More Time Asked" figure: an UNFINISHED task whose
  // request for more time is still WAITING for an answer (user, 2026-09-29:
  // "only show those which are incomplete and asked for pending overtime
  // request"). A granted or refused ask, or a finished task, drops out.
  if (moreTime === 'true' || moreTime === '1') {
    and.push({
      status: { $in: spellingsOf(...OPEN_STATUS) },
      extensions: { $elemMatch: { status: EXTENSION_STATUS.PENDING } },
    });
  }

  /**
   * THE SEARCH BOX — the task, and the people on either side of it.
   *
   * The brief (2026-09-25): *"search by name of assignee or assigner"*. Both
   * names are snapshotted onto the row (assignees[].name, createdByName), so
   * this needs no join — and a snapshot is also what keeps a task findable by
   * the name it was given to after that person has left.
   */
  const search = String(q || '').trim();
  if (search) {
    const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    and.push({
      $or: [
        { title: rx }, { description: rx }, { code: rx }, { category: rx },
        { 'assignees.name': rx }, { 'assignees.employeeCode': rx },
        { createdByName: rx }, { approverName: rx },
      ],
    });
  }

  return and.length === 1 ? and[0] : { $and: and };
}

/**
 * The counter row: the figures above every list.
 *
 * One aggregation over the SAME filter the rows use, and the boxes DO NOT
 * OVERLAP — every task is counted in exactly one of them, so they sum to the
 * total and the row can be trusted. Overdue wins over Pending and In Progress:
 * a task that is late is late, and listing it under both makes the red figure
 * meaningless and the arithmetic wrong.
 *
 *   overdue      open (pending or in progress) and past its deadline
 *   pending      not started, not late
 *   inProgress   started, not late
 *   completed    done — split into inTime / delayed
 *   cancelled    called off
 *
 * The In Time / Delayed split reads the FROZEN `completedLate` flag rather than
 * comparing dates now: the deadline may have been moved after the fact, and a
 * late delivery must not become punctual because somebody granted an extension
 * afterwards (see models/Task).
 */
async function countersFor(filter) {
  const now = new Date();
  // "Open and past its deadline" — spelled once, used three times below.
  // SUBMITTED is deliberately absent: handed in is not late, however long the
  // tray takes. See config/tasks.isOverdue, which has to agree with this.
  const late = {
    $and: [
      { $in: ['$status', [STATUS.PENDING, STATUS.IN_PROGRESS]] },
      { $ne: ['$dueDate', null] },
      { $lt: ['$dueDate', now] },
    ],
  };
  const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });

  const rows = await Task.aggregate([
    { $match: filter },
    // Rewrite the legacy words BEFORE anything compares them, or a row saying
    // ASSIGNED lands in `total` and in none of the five buckets — and the
    // boxes stop summing to the total, which is the one property this row
    // documents and depends on.
    normaliseStatusStage(),
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        overdue: countIf(late),
        pending: countIf({ $and: [{ $eq: ['$status', STATUS.PENDING] }, { $not: late }] }),
        inProgress: countIf({ $and: [{ $eq: ['$status', STATUS.IN_PROGRESS] }, { $not: late }] }),
        // The review tray. Its own box because it is the one queue a manager can
        // clear by reading it, and folding it into In progress hides that.
        inReview: countIf({ $eq: ['$status', STATUS.SUBMITTED] }),
        completed: countIf({ $eq: ['$status', STATUS.COMPLETED] }),
        cancelled: countIf({ $eq: ['$status', STATUS.CANCELLED] }),
        inTime: countIf({
          $and: [{ $eq: ['$status', STATUS.COMPLETED] }, { $ne: ['$completedLate', true] }],
        }),
        delayed: countIf({
          $and: [{ $eq: ['$status', STATUS.COMPLETED] }, { $eq: ['$completedLate', true] }],
        }),
        // Not one of the disjoint slices — an unfinished task with a request
        // for more time still waiting for an answer ("More Time Asked"). The
        // same rule as buildQuery's `moreTime`, so the figure matches its rows.
        moreTime: countIf({
          $and: [
            { $in: ['$status', OPEN_STATUS] },
            {
              $gt: [{
                $size: {
                  $filter: {
                    input: { $ifNull: ['$extensions', []] },
                    as: 'x',
                    cond: { $eq: ['$$x.status', EXTENSION_STATUS.PENDING] },
                  },
                },
              }, 0],
            },
          ],
        }),
      },
    },
  ]);
  const c = rows[0] || {};
  return {
    total: c.total || 0,
    overdue: c.overdue || 0,
    pending: c.pending || 0,
    inProgress: c.inProgress || 0,
    inReview: c.inReview || 0,
    completed: c.completed || 0,
    inTime: c.inTime || 0,
    delayed: c.delayed || 0,
    cancelled: c.cancelled || 0,
    moreTime: c.moreTime || 0,
  };
}

/**
 * The fields `taskAccess.canSee` reads — every one of them.
 *
 * A `.select()` that omits one does not make the check stricter, it makes it
 * WRONG: the field comes back undefined and the person it would have matched is
 * refused. Three queries were missing `approver`, `openTo` and
 * `originalAssignees`, so a delegator — who becomes exactly those — got a 403
 * on the voice note of a task they had handed on. (2026-09-22.)
 */
const VISIBILITY_FIELDS = 'createdBy approver assignees assignedTo loopUsers openTo '
  + 'originalAssignees onBehalf company parentTask';

/** What a list row needs, and nothing more. Keeps a 200-row page small. */
const LIST_FIELDS = 'code kind title category priority status points dueDate startDate '
  + 'completedAt completedLate createdBy createdByName assignedTo assignees loopUsers onBehalf '
  + 'repeat voiceNote attachments links reminders updateCount stateNote createdAt linkedTask '
  // A row has to show "not yet accepted" and "3 of 5 pieces done" without a
  // second query, so the counters and the delegation trail come with the list.
  + 'delegations originalAssignees assignedAt '
  // 2026-09-22: the pieces, the progress bar, the review flag and the tint.
  + 'parentTask parentCode parentTitle depth openTo childCount childDoneCount '
  + 'distributedPoints progress requiresApproval submittedAt rejectionCount extensions '
  // WHO SIGNS IT OFF, on the row. A board card in the Review column says
  // "Review by <name>", and after a delegation that is the DELEGATOR, not the
  // person who set it — so falling back to `createdByName` would confidently
  // name the wrong person on exactly the tasks where it matters. And the
  // transfer trail, so a row can say it changed hands.
  + 'approver approverName transfers '
  // 2026-09-27: routine dailies, "Edited ×2", and the bell's 30-minute gate.
  + 'routine recurringTask occurrenceKey editCount lastEditedAt lastEditedByName '
  + 'lastNudgeAt nudgeAt nudgeCount';

/**
 * Decorate a lean row with the derived bits every client would compute anyway.
 *
 * Everything here is DERIVED, never stored — `overdue`, `declined`, the accent
 * colour and the pieces' progress all change without anybody writing to the
 * row, and a stored copy would go stale the moment a clock ticked or somebody
 * was added.
 */
function decorate(row) {
  /**
   * A LEAN ROW NEVER PASSED THROUGH THE MODEL, so the post('init') hook that
   * normalises a hydrated document did not run on it. 51 of 61 live rows still
   * say ASSIGNED / Done / REJECTED, and without this every list row would carry
   * a status no chip, filter or capability check recognises — the status chip
   * would literally read "ASSIGNED". Priority was already normalised here for
   * exactly the same reason; the status was the half that was missed.
   */
  const status = normaliseStatus(row.status) || row.status;
  // …and the schema DEFAULTS, for the same reason: hydration fills them in,
  // `.lean()` does not. A row set before the 2026-09-21 rework has no `kind`,
  // no `points` and no `acceptance`, so a lean copy read as neither a task nor
  // a request, worth 0 points and "not awaiting" — while the detail page,
  // reading the same row hydrated, said TASK, 100 points and "Not yet
  // accepted", and offered Accept.
  const assignees = (row.assignees || []).map((a) => {
    const an = normaliseStatus(a.status);
    const fixed = an && an !== a.status ? { ...a, status: an } : a;
    return fixed.acceptance ? fixed : { ...fixed, acceptance: ACCEPTANCE.AWAITING };
  });
  const kind = row.kind || KIND_TASK;
  row = {
    ...row,
    kind,
    points: row.points ?? (kind === KIND_TASK ? DEFAULT_TASK_POINTS : 0),
    status,
    assignees,
  };

  const pending = (row.extensions || []).find((e) => e.status === EXTENSION_STATUS.PENDING) || null;
  const pool = Number(row.points) || 0;
  const given = Number(row.distributedPoints) || 0;
  return {
    ...row,
    statusLabel: statusLabel(row.status, row.kind),
    overdue: isOverdue(row),
    frequencyLabel: FREQUENCY_LABELS[row.repeat?.frequency || FREQUENCY.ONCE],
    hasVoiceNote: Boolean(row.voiceNote?.storagePath),
    attachmentCount: (row.attachments || []).length,
    // Everybody still on it has said no — the task is owed and nobody is doing
    // it, which is a different thing from any of the four statuses.
    declined: isDeclined(row),
    // Somebody has not answered the handover yet.
    awaitingAcceptance: isAwaitingAcceptance(row),
    delegationCount: (row.delegations || []).length,

    /**
     * THE ONE COLOUR RULE, answered on the server (config/tasks.accentFor).
     *
     * The brief: *"if any task is pending then the whole task should be in the
     * priority color, and if the task is completed then show that in Green"*.
     * Sending the four hexes with the row rather than the key alone means the
     * web list, the board card, the detail header and the app's card cannot
     * drift into four slightly different reds.
     */
    accent: accentFor(row),
    priority: normalisePriority(row.priority) || DEFAULT_PRIORITY,

    // ===== The pieces =====
    isPiece: Boolean(row.parentTask),
    isOpenPiece: Boolean(row.parentTask) && !(row.assignees || []).length,
    // Kept under their old names as well, because an Android build from before
    // 2026-09-22 draws its progress line from exactly these two.
    subtaskCount: Number(row.childCount) || 0,
    subtasksDone: Number(row.childDoneCount) || 0,

    // What EACH person on this row earns — the pool less what was handed down.
    effectivePoints: Math.max(0, pool - given),

    pendingExtension: pending ? {
      _id: pending._id,
      toDate: pending.toDate,
      fromDate: pending.fromDate,
      reason: pending.reason,
      requestedBy: pending.requestedBy,
      requestedByName: pending.requestedByName,
      requestedAt: pending.requestedAt,
    } : null,
    // The whole list is rarely wanted on a row; the count is, so "extended
    // twice, asking again" reads without opening anything.
    extensionRequests: (row.extensions || []).length,
    // The LATEST ask for more time and where it stands (2026-09-29, user: "show
    // if any more time is asked and what is the status for that") — the app's
    // card prints it beside the code: Pending, Approved or Declined.
    lastExtension: (() => {
      const list = row.extensions || [];
      const x = list[list.length - 1];
      return x ? {
        status: x.status || EXTENSION_STATUS.PENDING,
        toDate: x.toDate || null,
        requestedByName: x.requestedByName || '',
        requestedAt: x.requestedAt || null,
        decidedByName: x.decidedByName || '',
        decidedAt: x.decidedAt || null,
      } : null;
    })(),

    // ===== 2026-09-27 =====
    // A daily occurrence — only ever marked done.
    routine: Boolean(row.routine),
    // "Edited ×2" on the row, so the person about to accept it reads it again.
    editCount: Number(row.editCount) || 0,
    // When a bell was last pressed on it, either direction. The gate THIS
    // reader faces is `can.nudgeReadyAt`, which knows which direction is theirs.
    lastNudgeAt: row.lastNudgeAt || null,
    // The schedule's shape in words, for "Daily · 6:00 PM" on a recurring row.
    repeatLabel: row.repeat?.frequency && row.repeat.frequency !== FREQUENCY.ONCE
      ? patternLabel(row.repeat) : '',
  };
}

/**
 * One lean row as a client gets it: decorated, with its serial, and with `can`
 * worked out from the DECORATED row.
 *
 * Handing capabilitiesFor the raw row was the bug. It looks the moves up by
 * status, and a raw pre-rework row still says `ASSIGNED` — TRANSITIONS has no
 * such key — with no `acceptance` and no `kind`. So a legacy row came back with
 * no moves, no Accept and no Split: a task the detail page could act on and
 * the list could not.
 */
function listRow(user, row, serial) {
  const decorated = decorate(row);
  return { ...decorated, serial, can: access.capabilitiesFor(user, decorated) };
}

// ===== Sorting =====

/**
 * Which order the list comes back in.
 *
 * Added 2026-09-22 — the brief asks for *"sorting these according to day
 * assigned, pending days, points, priority"*. Before this the sort was hard
 * coded to the deadline, which is the right default and the wrong only option:
 * a task with no deadline sorted to the top of every list, and "what has been
 * sitting the longest" could not be asked at all.
 *
 * `_id` always breaks the tie, so paging cannot repeat or skip a row when
 * fifty tasks share a due date — which, on a portal where people set everything
 * to 6pm, they do.
 */
function resolveSort(query = {}) {
  const key = SORT_KEYS.includes(query.sort) ? query.sort : DEFAULT_SORT;
  const spec = SORTS[key];
  const dir = query.dir === 'asc' ? 'asc' : (query.dir === 'desc' ? 'desc' : null);
  const sign = dir ? (dir === 'asc' ? 1 : -1) : spec.dir;
  return {
    key,
    dir: sign === 1 ? 'asc' : 'desc',
    sort: { [spec.field]: sign, _id: -1 },
  };
}

/**
 * One page of rows in the asked-for order.
 *
 * TWO PATHS, and the reason for the second is worth stating. Most sorts are a
 * plain `find().sort()`. Two are not:
 *
 *   priority   'Low' < 'Medium' < 'Urgent' alphabetically, which is exactly
 *              backwards, so the rank has to be computed before the sort. That
 *              means an aggregation.
 *   pending    "how long has this been sitting there" must put the OPEN work
 *              first regardless of age — a task finished last year is not
 *              pending for 400 days, it is not pending at all.
 *
 * Both fall back to the same projection and populate as the simple path, so a
 * row is the same shape whichever way it arrived.
 */
async function sortedRows(filter, sort, key, skip, limit) {
  if (key !== 'priority' && key !== 'pending') {
    return Task.find(filter)
      .select(LIST_FIELDS)
      .populate('assignees.user', 'firstName lastName photo')
      .populate('createdBy', 'firstName lastName photo')
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean();
  }

  const addFields = key === 'priority'
    ? {
      priorityRank: {
        $switch: {
          branches: [
            // `High` is the pre-2026-09-22 spelling of Urgent and is still on
            // most of the live rows — ranking it anywhere but first would sort
            // the company's actual urgent work into the middle of the list.
            { case: { $in: ['$priority', ['Urgent', 'High', 'Critical', 'Highest']] }, then: PRIORITY_RANK.Urgent },
            { case: { $in: ['$priority', ['Low', 'Lowest']] }, then: PRIORITY_RANK.Low },
          ],
          default: PRIORITY_RANK.Medium,
        },
      },
    }
    : {
      // Open work first (0), then everything settled (1); inside each, oldest
      // first. `assignedAt` predates this rework on every row, so no backfill.
      openFirst: { $cond: [{ $in: ['$status', [STATUS.COMPLETED, STATUS.CANCELLED]] }, 1, 0] },
    };

  const sortStage = key === 'priority'
    ? { priorityRank: sort.priorityRank ?? 1, dueDate: 1, _id: -1 }
    : { openFirst: 1, assignedAt: sort.assignedAt ?? 1, _id: -1 };

  const ids = await Task.aggregate([
    { $match: filter },
    { $addFields: addFields },
    { $sort: sortStage },
    { $skip: skip },
    { $limit: limit },
    { $project: { _id: 1 } },
  ]);

  const order = new Map(ids.map((r, i) => [String(r._id), i]));
  const rows = await Task.find({ _id: { $in: ids.map((r) => r._id) } })
    .select(LIST_FIELDS)
    .populate('assignees.user', 'firstName lastName photo')
    .populate('createdBy', 'firstName lastName photo')
    .lean();
  // `$in` does not preserve the order the ids came in, so it is restored here
  // rather than being left to whatever the index happened to return.
  return rows.sort((a, b) => order.get(String(a._id)) - order.get(String(b._id)));
}

// ===== Reading =====

/**
 * GET /api/tasks — one page of rows, plus the counters that must agree with it.
 */
const listTasks = asyncHandler(async (req, res) => {
  const filter = await buildQuery(req);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const { sort, key: sortKey, dir: sortDir } = resolveSort(req.query);

  /**
   * THE FIGURES ON THE PILE CARDS (2026-09-25), when asked for.
   *
   * The page opens on two big cards — "Assigned to me" and "Assigned by me"
   * (plus "All tasks" for whoever holds tasks.manage) — and each wears its own
   * numbers, not just the one on screen. Answered here, in the same request,
   * rather than by two more calls from the client: on a phone that is two more
   * slots of Android's five per host on every filter change.
   *
   * The same filters as the list (window, department, priority…) but NOT the
   * tile the reader clicked, and NOT the search box — see FIGURES_IGNORE below.
   */
  const withScopes = req.query.withScopes === '1' || req.query.withScopes === 'true';
  // 'loop' (2026-09-25): the tasks this person is only kept informed on — a
  // fourth card, "In the loop", beside the two piles of work.
  const scopeKeys = withScopes
    ? ['mine', 'delegated', 'loop', ...(access.seesEverything(req.user) ? ['all'] : [])]
    : [];

  /**
   * THE BAR'S FIGURES IGNORE THE FIGURE THAT WAS CLICKED — the same rule as the
   * pile cards above. Reported 2026-09-25: picking "Overdue" on a bar reading
   * Total 66 · Overdue 52 · Pending 2 turned it into Total 52 · Overdue 52 ·
   * Pending 0, because the bar was counted over the rows the click had just
   * narrowed. The segments are choices; a choice must not rewrite its
   * neighbours.
   *
   * NOR DO THEY FOLLOW THE SEARCH BOX (reported the same day: typing a name
   * made Total and Overdue count down letter by letter). A search is a way of
   * FINDING rows, not a question about the pile, so the figures hold still
   * while the rows under them narrow.
   *
   * Every other filter (pile, window, department, priority) still applies, so
   * the bar describes what the rows are picked from — and `total` below still
   * counts the rows themselves, for the pages.
   */
  const FIGURES_IGNORE = { status: '', overdue: '', late: '', moreTime: '', q: '' };
  const narrowed = Object.keys(FIGURES_IGNORE)
    .some((k) => req.query[k] !== undefined && String(req.query[k]).trim() !== '');
  const barFilter = narrowed ? await buildQuery(req, FIGURES_IGNORE) : filter;

  const [rows, total, counters, ...scopeCounters] = await Promise.all([
    sortedRows(filter, sort, sortKey, (page - 1) * limit, limit),
    Task.countDocuments(filter),
    countersFor(barFilter),
    ...scopeKeys.map(async (key) => countersFor(
      await buildQuery(req, { scope: key, ...FIGURES_IGNORE })
    )),
  ]);

  const listRows = rows.map((row, i) => listRow(req.user, row, (page - 1) * limit + i + 1));
  // Titles and names in the reader's app language, when they chose one.
  await localise(req, listRows);

  res.json({
    ...(withScopes ? { scopes: Object.fromEntries(scopeKeys.map((k, i) => [k, scopeCounters[i]])) } : {}),
    // `can` per row, not just on the detail response.
    //
    // The list draws Accept / Decline / In progress / Complete straight on the
    // row, and it opens the same update box the detail page does — so it needs
    // the same answer to "what may this person do to this task". It is pure
    // in-memory work over at most 200 rows and no extra query, and the
    // alternative is the client re-deriving the rules, which is exactly the
    // split-brain this module was rebuilt to end.
    //
    // The serial number the brief asks for CONTINUES ACROSS PAGES — row 51 is
    // "51", not "1" again — because a number that restarts is not a serial, it
    // is a row index, and quoting "number 3" then becomes ambiguous the moment
    // anybody turns a page.
    tasks: listRows,
    page,
    limit,
    total,
    pages: Math.ceil(total / limit) || 1,
    sort: sortKey,
    dir: sortDir,
    counters,
  });
});

// ===== The report (2026-09-28) =====

/** What each pile, window and figure is called on the page, for the report's own words. */
const EXPORT_PILES = {
  mine: 'Assigned to me', delegated: 'Assigned by me', loop: 'In the loop', all: 'All tasks',
};
const EXPORT_RANGES = {
  today: 'Today', yesterday: 'Yesterday', week: 'This week', month: 'This month',
  nextWeek: 'Next week', all: 'All time',
};
const EXPORT_FIGURES = {
  total: 'Total (open work)', pending: 'Not Accepted Yet', overdue: 'Overdue',
  inProgress: 'In Progress', inReview: 'Under Review', completed: 'Completed',
};
/** More than a report anybody reads; the sheet says when it stopped. */
const EXPORT_MAX_ROWS = 5000;
const IST_OFFSET_MS = 330 * 60 * 1000;

/**
 * An instant as the portal's wall clock, for a spreadsheet cell.
 *
 * Excel has no time zones: exceljs writes a Date as its UTC fields, so a task
 * due 6 PM IST would read 12:30 PM in the sheet. Shifting by IST's offset makes
 * the UTC fields BE the Indian wall clock, and the cell stays a real date that
 * sorts and filters, rather than a string that only looks like one.
 */
const istCell = (d) => {
  if (!d) return null;
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? null : new Date(t + IST_OFFSET_MS);
};

/** "28 Sept 2026, 6:05 PM" — the IST stamp the summary sheet prints. */
const istStamp = (d = new Date()) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  hour: 'numeric', minute: '2-digit', hour12: true,
});

/** Where a row stands, in the words the list's status button uses. */
function exportStatus(row) {
  if (row.declined) return 'Declined';
  if (row.routine && row.status === STATUS.IN_PROGRESS) return 'To do';
  if (row.status === STATUS.PENDING && row.awaitingAcceptance) return 'Not accepted yet';
  return statusLabel(row.status, row.kind);
}

/**
 * GET /api/tasks/export — the list as an Excel report (user request 2026-09-28:
 * "give option to export for task as a report").
 *
 * EXACTLY WHAT IS ON SCREEN: the same query as GET /tasks — pile, due window,
 * department, people, priority, search, the figure clicked, the order — built by
 * the same `buildQuery`, so the report cannot hold a row the page would not, or
 * leave one out. Every page of it, not the fifty on screen. The second sheet
 * restates the filters and the pile's figures, so a file forwarded on its own
 * still says what it is.
 *
 * No capability: it is the caller's own list, walled exactly as the list is.
 */
const exportTasks = asyncHandler(async (req, res) => {
  const ExcelJS = require('exceljs');
  const filter = await buildQuery(req);
  const { sort, key: sortKey, dir: sortDir } = resolveSort(req.query);

  const FIGURES_IGNORE = { status: '', overdue: '', late: '', moreTime: '', q: '' };
  const [rows, total, counters] = await Promise.all([
    sortedRows(filter, sort, sortKey, 0, EXPORT_MAX_ROWS),
    Task.countDocuments(filter),
    countersFor(await buildQuery(req, FIGURES_IGNORE)),
  ]);

  // Two things a list row does not carry: the task's details, and the names
  // of the people kept in the loop (stored as ids).
  const extra = new Map((await Task.find({ _id: { $in: rows.map((r) => r._id) } })
    .select('description').lean()).map((t) => [String(t._id), t]));
  const loopIds = [...new Set(rows.flatMap((r) => (r.loopUsers || []).map(String)))];
  const loopNames = await namesOf(loopIds);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence - HRMS';
  wb.created = new Date();

  // ── Sheet 1: the tasks ────────────────────────────────────────────────
  const ws = wb.addWorksheet('Tasks');
  ws.columns = [
    { header: '#', key: 'serial', width: 6 },
    { header: 'Code', key: 'code', width: 16 },
    { header: 'Task', key: 'title', width: 42 },
    { header: 'Status', key: 'status', width: 18 },
    { header: 'Overdue', key: 'overdue', width: 10 },
    { header: 'Priority', key: 'priority', width: 11 },
    { header: 'Category', key: 'category', width: 18 },
    { header: 'Assigned by', key: 'by', width: 24 },
    { header: 'Assigned to', key: 'to', width: 32 },
    { header: 'Assigned on', key: 'assignedOn', width: 14, style: { numFmt: 'dd-mmm-yyyy' } },
    { header: 'Due', key: 'due', width: 20, style: { numFmt: 'dd-mmm-yyyy hh:mm AM/PM' } },
    { header: 'Completed on', key: 'completedOn', width: 20, style: { numFmt: 'dd-mmm-yyyy hh:mm AM/PM' } },
    { header: 'On time?', key: 'onTime', width: 11 },
    { header: 'Progress %', key: 'progress', width: 11 },
    { header: 'Points', key: 'points', width: 9 },
    { header: 'Pieces done', key: 'pieces', width: 12 },
    { header: 'Repeats', key: 'repeats', width: 18 },
    { header: 'Kept in the loop', key: 'loop', width: 26 },
    { header: 'Details', key: 'details', width: 60 },
  ];

  rows.forEach((raw, i) => {
    const row = decorate(raw);
    const byName = row.createdByName || personName(row.createdBy) || '';
    const sentBy = row.onBehalf?.byName ? ` (sent by ${row.onBehalf.byName})` : '';
    const done = row.status === STATUS.COMPLETED;
    ws.addRow({
      serial: i + 1,
      code: row.code || '',
      title: row.title || '',
      status: exportStatus(row),
      overdue: row.overdue ? 'Yes' : '',
      priority: row.priority || '',
      category: row.category || '',
      by: `${byName}${sentBy}`,
      to: row.isOpenPiece ? 'Nobody yet (open piece)'
        : (row.assignees || []).map((a) => a.name || personName(a.user)).filter(Boolean).join(', '),
      assignedOn: istCell(row.assignedAt || row.createdAt),
      due: istCell(row.dueDate),
      completedOn: done ? istCell(row.completedAt) : null,
      onTime: done ? (row.completedLate ? 'Delayed' : 'In time') : '',
      progress: Math.max(0, Math.min(100, Number(row.progress) || 0)),
      points: Number(row.effectivePoints) || 0,
      pieces: row.subtaskCount ? `${row.subtasksDone}/${row.subtaskCount}` : '',
      repeats: row.repeatLabel || '',
      loop: (row.loopUsers || []).map((u) => loopNames.get(String(u))).filter(Boolean).join(', '),
      details: extra.get(String(row._id))?.description || '',
    });
  });

  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 22;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });
  ws.getColumn('details').alignment = { wrapText: true, vertical: 'top' };
  ws.getColumn('title').alignment = { wrapText: true, vertical: 'top' };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columns.length } };

  // ── Sheet 2: what this report is ─────────────────────────────────────
  const q = req.query;
  const scope = EXPORT_PILES[q.scope] ? q.scope : 'all';
  const range = q.range === 'custom'
    ? `${q.from || '…'} – ${q.to || '…'}`
    : (EXPORT_RANGES[q.range] || 'All time');
  const people = await namesOf([...listParam(q.assignedTo), ...listParam(q.assignedBy)]);
  const say = (ids) => listParam(ids).map((id) => people.get(id)).filter(Boolean).join(', ');

  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ key: 'k', width: 26 }, { key: 'v', width: 48 }];
  const line = (k, v, bold = false) => {
    const r = sum.addRow({ k, v: v === undefined || v === null ? '' : v });
    if (bold) r.font = { bold: true };
    return r;
  };
  const title = sum.addRow({ k: 'Tasks report' });
  title.font = { bold: true, size: 14 };
  line('Generated on', `${istStamp()} (IST)`);
  line('Generated by', personName(req.user));
  sum.addRow({});
  line('Filters', '', true);
  line('Pile', EXPORT_PILES[scope]);
  line('Figure', EXPORT_FIGURES[q.figure] || (q.status || q.overdue ? 'Filtered by status' : 'Every status'));
  line('Due', range);
  if (q.department) line('Department', listParam(q.department).join(', '));
  if (q.priority) line('Priority', listParam(q.priority).join(', '));
  if (say(q.assignedTo)) line('Assigned to', say(q.assignedTo));
  if (say(q.assignedBy)) line('Assigned by', say(q.assignedBy));
  if (q.q) line('Search', q.q);
  line('Order', `${SORTS[sortKey]?.label || sortKey}, ${sortDir === 'asc' ? 'ascending' : 'descending'}`);
  line('Rows in this report', total > rows.length
    ? `${rows.length} (the first ${EXPORT_MAX_ROWS} of ${total} — narrow the filters for the rest)`
    : rows.length);
  sum.addRow({});
  line(`${EXPORT_PILES[scope]} — the figures`, '', true);
  const open = Math.max(0, counters.total - counters.completed - counters.cancelled);
  [
    ['Total (open work)', open],
    ['Not Accepted Yet', counters.pending],
    ['Overdue', counters.overdue],
    ['In Progress', counters.inProgress],
    ['Under Review', counters.inReview],
    ['Completed', counters.completed],
    ['  of which in time', counters.inTime],
    ['  of which delayed', counters.delayed],
    ['Cancelled', counters.cancelled],
  ].forEach(([k, v]) => line(k, v));
  sum.getColumn('v').alignment = { horizontal: 'left' };

  const stamp = new Date(Date.now() + IST_OFFSET_MS).toISOString();
  const file = `Tasks_${EXPORT_PILES[scope].replace(/\s+/g, '-')}_${stamp.slice(0, 10)}_${stamp.slice(11, 16).replace(':', '')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"`);
  await wb.xlsx.write(res);
  res.end();
});

/** GET /api/tasks/counters — the figures alone, for a badge. */
const taskCounters = asyncHandler(async (req, res) => {
  res.json(await countersFor(await buildQuery(req)));
});

/**
 * GET /api/tasks/:id — the task, its feed, and what this caller may do to it.
 *
 * `can` is computed on the SERVER (services/taskAccess.capabilitiesFor) and the
 * clients draw what they are told. Both used to derive the buttons themselves,
 * in two places, with two sets of bugs.
 */
const getTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);

  const task = await Task.findById(req.params.id)
    .populate('assignees.user', 'firstName lastName photo email')
    .populate('createdBy', 'firstName lastName photo')
    .populate('loopUsers', 'firstName lastName photo')
    .populate('openTo', 'firstName lastName photo')
    .populate('parentTask', 'code title status points distributedPoints progress')
    .populate('linkedTask', 'code title status');
  if (!task) bad(res, 'That task no longer exists.', 404);

  /**
   * A PIECE is visible to whoever can see the task it came from.
   *
   * A manager splits the CEO's task five ways; the CEO is on none of the five
   * and is in nobody's `openTo`, but *"how is my task going"* has to be
   * answerable. The parent's own visibility is the gate — see
   * services/taskAccess.canSeeThroughParent — and it costs one extra read on
   * exactly the requests that need it.
   */
  if (!access.canSee(req.user, task) && !(await access.canSeeThroughParent(req.user, task))) {
    bad(res, 'That task is not yours to see.', 403);
  }

  const [updates, children] = await Promise.all([
    TaskUpdate.find({ task: task._id })
      .populate('by', 'firstName lastName photo')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean(),
    Task.find({ parentTask: task._id, archived: { $ne: true } })
      .select(LIST_FIELDS)
      .populate('assignees.user', 'firstName lastName photo')
      .populate('createdBy', 'firstName lastName photo')
      .sort({ createdAt: 1 })
      .lean(),
  ]);

  const pieces = children.map((c, i) => listRow(req.user, c, i + 1));
  const taskOut = decorate(task.toObject());
  // Title, description, remarks and names in the reader's app language.
  await localise(req, taskOut, pieces, updates);

  res.json({
    task: {
      ...taskOut,
      /**
       * THE OLD SHAPE, DERIVED (2026-09-22).
       *
       * An Android build from before the pieces became real tasks reads
       * `task.subtasks` and renders `{ _id, title, assignee, assigneeName,
       * done }`. Serving it from the children costs nothing and means an APK in
       * somebody's pocket keeps working — which matters here, because this
       * portal's app updates when its owner gets round to it, not when the
       * server deploys. New clients read `children`.
       */
      subtasks: pieces.map((c) => ({
        _id: c._id,
        title: c.title,
        assignee: c.assignees?.[0]?.user?._id || c.assignees?.[0]?.user || null,
        assigneeName: c.assignees?.[0]?.name || '',
        done: c.status === STATUS.COMPLETED,
        doneAt: c.completedAt,
        points: c.points,
      })),
    },
    children: pieces,
    updates,
    can: access.capabilitiesFor(req.user, task),
  });
});

/** GET /api/tasks/:id/children — the pieces on their own, for a refresh. */
const getChildren = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const parent = await Task.findById(req.params.id)
    .select(VISIBILITY_FIELDS);
  if (!parent) bad(res, 'That task no longer exists.', 404);
  access.assertCanSee(req.user, parent);

  const children = await Task.find({ parentTask: parent._id, archived: { $ne: true } })
    .select(LIST_FIELDS)
    .populate('assignees.user', 'firstName lastName photo')
    .populate('createdBy', 'firstName lastName photo')
    .sort({ createdAt: 1 })
    .lean();

  const pieceRows = children.map((c, i) => listRow(req.user, c, i + 1));
  await localise(req, pieceRows);
  res.json({ children: pieceRows });
});

/**
 * GET /api/tasks/board — the four columns, in one call.
 *
 * Takes every filter the list takes. It is FOUR capped queries rather than one
 * big one and a client-side group, because a board must show the top of each
 * column: a single 200-row page sorted by deadline can easily be 200 pending
 * tasks and leave "In review" — the column somebody opened the board to clear —
 * looking empty.
 */
const boardTasks = asyncHandler(async (req, res) => {
  const base = await buildQuery(req);
  const perColumn = Math.min(100, Math.max(5, parseInt(req.query.limitPerColumn, 10) || 50));
  const { sort, key } = resolveSort(req.query);

  const columns = await Promise.all(BOARD_COLUMNS.map(async (col) => {
    const filter = { $and: [base, { status: { $in: spellingsOf(col.key) } }] };
    const [rows, count] = await Promise.all([
      sortedRows(filter, sort, key, 0, perColumn),
      Task.countDocuments(filter),
    ]);
    return {
      key: col.key,
      label: statusLabel(col.key, req.query.kind === KIND_REQUEST ? KIND_REQUEST : KIND_TASK) || col.label,
      boardLabel: col.label,
      count,
      more: Math.max(0, count - rows.length),
      tasks: rows.map((row, i) => listRow(req.user, row, i + 1)),
    };
  }));

  res.json({ columns, limitPerColumn: perColumn, counters: await countersFor(base) });
});

/** GET /api/tasks/:id/updates — the feed on its own, for paging it. */
const taskFeed = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const task = await Task.findById(req.params.id).select(VISIBILITY_FIELDS);
  if (!task) bad(res, 'That task no longer exists.', 404);
  access.assertCanSee(req.user, task);

  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const before = req.query.before ? new Date(req.query.before) : null;
  const filter = { task: task._id };
  if (before && !Number.isNaN(before.getTime())) filter.createdAt = { $lt: before };

  const updates = await TaskUpdate.find(filter)
    .populate('by', 'firstName lastName photo')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  res.json({ updates });
});

// ===== Writing =====

/** Normalise a reminder rule off the wire; drop anything nonsensical. */
function cleanReminders(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => {
      const base = {
        channel: REMINDER_CHANNELS.includes(r?.channel) ? r.channel : 'APP',
        amount: Math.max(0, Math.min(365, Number(r?.amount) || 0)),
        unit: REMINDER_UNITS.includes(r?.unit) ? r.unit : 'DAYS',
        when: REMINDER_WHENS.includes(r?.when) ? r.when : 'BEFORE',
      };
      return base.when === REMINDER_WHEN.EVERY ? cleanRepeatingReminder(r, base) : base;
    })
    .filter((r) => r && r.amount > 0)
    // There is at most one repeating rule: two beats on one task would be one
    // beat, badly. The first one sent wins.
    .filter((r, i, all) => r.when !== REMINDER_WHEN.EVERY
      || all.findIndex((o) => o.when === REMINDER_WHEN.EVERY) === i)
    // Two identical rules would fire once (they share an idempotence key) and
    // look like a bug. De-duplicate at the door.
    .filter((r, i, all) => all.findIndex((o) => o.channel === r.channel && o.amount === r.amount
      && o.unit === r.unit && o.when === r.when) === i)
    .slice(0, 10);
}

/**
 * A REPEATING rule in the shape it says it is (config/tasks REMINDER_PATTERN,
 * 2026-09-27) — or null when it could never fire (weekly, with no day ticked).
 *
 *   HOURLY   every 1–12 hours (or ≥ 30 minutes, from an older form) inside an
 *            optional window; "every 5 minutes until done" is not a reminder,
 *            it is an alarm
 *   DAILY    every 1–31 days at a time
 *   WEEKLY   on the weekdays ticked, at a time
 *   MONTHLY  on a date, or on the Nth weekday, at a time
 */
function cleanRepeatingReminder(r, base) {
  const pattern = reminderPattern(r);
  const head = { channel: base.channel, when: REMINDER_WHEN.EVERY, pattern };

  if (pattern === REMINDER_PATTERN.HOURLY) {
    const minutes = base.unit === 'MINUTES';
    const out = {
      ...head,
      unit: minutes ? 'MINUTES' : 'HOURS',
      amount: minutes
        ? Math.min(MAX_REMIND_EVERY_HOURS * 60, Math.max(REPEAT_REMINDER.minMinutes, Math.round(base.amount)))
        : Math.min(MAX_REMIND_EVERY_HOURS, Math.max(1, Math.round(base.amount) || 1)),
    };
    const from = hhmmOf(r?.from);
    const to = hhmmOf(r?.to);
    // Kept only when it is a real window that is not the default one.
    if (from && to && from < to && (from !== DEFAULT_REMIND_WINDOW.from || to !== DEFAULT_REMIND_WINDOW.to)) {
      out.from = from;
      out.to = to;
    }
    return out;
  }

  const out = { ...head, unit: 'DAYS', amount: 1, at: hhmmOf(r?.at) || DEFAULT_REMIND_AT };
  if (pattern === REMINDER_PATTERN.DAILY) {
    out.amount = Math.min(MAX_DAY_INTERVAL, Math.max(1, Math.round(Number(r?.amount) || 1)));
    return out;
  }
  if (pattern === REMINDER_PATTERN.WEEKLY) {
    const days = [...new Set((Array.isArray(r?.weekdays) ? r.weekdays : []).map(Number))]
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      .sort((a, b) => a - b);
    if (!days.length) return null;
    out.weekdays = days;
    return out;
  }
  // MONTHLY
  if (r?.monthlyMode === MONTHLY_MODE.WEEKDAY) {
    const wd = Number(r.weekday);
    const nth = Number(r.nthWeek);
    out.monthlyMode = MONTHLY_MODE.WEEKDAY;
    out.weekday = Number.isInteger(wd) && wd >= 0 && wd <= 6 ? wd : 1;
    out.nthWeek = NTH_WEEKS.includes(nth) ? nth : 1;
  } else {
    const d = Math.round(Number(r?.monthDay));
    out.monthlyMode = MONTHLY_MODE.DATE;
    out.monthDay = Number.isFinite(d) ? Math.min(31, Math.max(1, d)) : 1;
  }
  return out;
}

function cleanRepeat(raw) {
  const frequency = FREQUENCIES.includes(raw?.frequency) ? raw.frequency : FREQUENCY.ONCE;
  const out = { frequency };
  // Every N days — 2 is "alternate days" (2026-09-27).
  if (frequency === FREQUENCY.DAILY) {
    const n = Math.round(Number(raw?.interval) || 1);
    out.interval = Math.min(MAX_DAY_INTERVAL, Math.max(1, n));
  }
  if (frequency === FREQUENCY.WEEKLY) {
    const days = (Array.isArray(raw?.weekdays) ? raw.weekdays : [])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    out.weekdays = [...new Set(days)].sort();
  }
  if (frequency === FREQUENCY.MONTHLY || frequency === FREQUENCY.YEARLY) {
    const d = Number(raw?.monthDay);
    if (Number.isInteger(d) && d >= 1 && d <= 31) out.monthDay = d;
  }
  // "The first Monday of the month" — any weekday, first to fourth or last.
  if (frequency === FREQUENCY.MONTHLY) {
    out.monthlyMode = MONTHLY_MODES.includes(raw?.monthlyMode) ? raw.monthlyMode : MONTHLY_MODE.DATE;
    if (out.monthlyMode === MONTHLY_MODE.WEEKDAY) {
      const nth = Number(raw?.nthWeek);
      const wd = Number(raw?.weekday);
      out.nthWeek = NTH_WEEKS.includes(nth) ? nth : 1;
      out.weekday = Number.isInteger(wd) && wd >= 0 && wd <= 6 ? wd : 1;
    }
  }
  if (frequency === FREQUENCY.YEARLY) {
    const m = Number(raw?.month);
    if (Number.isInteger(m) && m >= 1 && m <= 12) out.month = m;
  }
  if (/^\d{1,2}:\d{2}$/.test(String(raw?.time || ''))) out.time = raw.time;
  if (raw?.until) {
    const u = new Date(raw.until);
    if (!Number.isNaN(u.getTime())) out.until = u;
  }
  return out;
}

function cleanLinks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => ({ url: String(l?.url || '').trim(), label: String(l?.label || '').trim() }))
    .filter((l) => /^https?:\/\//i.test(l.url))
    .slice(0, 20);
}

/** Store uploaded files in GridFS and return the metadata rows. */
async function storeFiles(files, taskId, user) {
  const out = [];
  for (const file of files || []) {
    const { storagePath, sizeBytes } = await storage.saveBuffer({
      buffer: file.buffer,
      ownerType: 'task',
      ownerId: String(taskId),
      originalName: file.originalname,
    });
    out.push({
      name: file.originalname,
      storagePath,
      mimeType: file.mimetype,
      sizeBytes,
      kind: evidenceKindFor(file.mimetype, file.originalname),
      uploadedBy: user?._id,
      uploadedByName: personName(user),
    });
  }
  return out;
}

/**
 * Pull the voice note out of an upload.
 *
 * It arrives as a field named `voice` on the same multipart request as the
 * attachments, because a browser cannot send two requests atomically and a task
 * that saved without the recording somebody just made is a bad surprise.
 */
async function storeVoiceNote(files, taskId, user, durationMs) {
  const file = (files || []).find((f) => f.fieldname === 'voice');
  if (!file) return null;
  const { storagePath, sizeBytes } = await storage.saveBuffer({
    buffer: file.buffer,
    ownerType: 'task',
    ownerId: String(taskId),
    originalName: file.originalname || 'voice-note.webm',
  });
  return {
    storagePath,
    mimeType: file.mimetype || 'audio/webm',
    sizeBytes,
    durationMs: Number(durationMs) || undefined,
    recordedBy: user?._id,
    recordedByName: personName(user),
  };
}

/**
 * The body of an assign form, however it arrived.
 *
 * A multipart POST (one with a voice note or files) sends every field as a
 * string, so arrays and objects come through JSON-encoded. Parsing here rather
 * than at four call sites is the difference between one place that knows and
 * four that nearly do.
 */
function parseBody(req) {
  const b = { ...req.body };
  for (const key of ['assignees', 'loopUsers', 'reminders', 'repeat', 'links', 'mentions']) {
    if (typeof b[key] === 'string') {
      try { b[key] = JSON.parse(b[key]); } catch { /* leave it; validation will speak */ }
    }
  }
  return b;
}

/** Snapshot the people onto the task — names survive a departure. */
async function buildAssignees(userIds) {
  const ids = [...new Set((userIds || []).map(String))].filter(mongoose.Types.ObjectId.isValid);
  if (!ids.length) return [];
  const users = await User.find({ _id: { $in: ids } }).select('firstName lastName').lean();
  const profiles = await EmployeeProfile.find({ user: { $in: ids } })
    .select('user employeeCode').lean();
  const codeOf = new Map(profiles.map((p) => [String(p.user), p.employeeCode || '']));
  const byId = new Map(users.map((u) => [String(u._id), u]));
  // Preserve the order they were picked in: the first is the primary assignee.
  return ids
    .filter((id) => byId.has(id))
    .map((id) => ({
      user: id,
      name: personName(byId.get(id)),
      employeeCode: codeOf.get(id) || '',
      status: STATUS.PENDING,
    }));
}

/**
 * POST /api/tasks — hand work over.
 *
 * Since 2026-09-25 it is always a TASK, whoever it is for — the upward
 * "request" and the "Ask" button that raised one are gone (see
 * services/taskAccess.resolveAssignmentKind).
 *
 * NOBODY CHOSEN MEANS "MINE". The user's words: *"if nobody is selected in the
 * dropdown then it will assign to that user by default"*. So an empty
 * `assignees` is no longer a 400; the task lands on whoever set it — a
 * personal to-do, with the same deadline, reminders and feed as any other.
 */
const createTask = asyncHandler(async (req, res) => {
  const body = parseBody(req);

  const title = String(body.title || '').trim();
  if (!title) bad(res, 'Give the task a title.');

  /**
   * ON SOMEBODY ELSE'S BEHALF (user request 2026-09-25). With `onBehalfOf`,
   * the task is SET BY that person — its createdBy, so they approve it and it
   * sits in their "Assigned by me" — and the caller is kept on it as
   * `onBehalf`, the one who actually sent it. Only somebody a Super Admin gave
   * User.taskProxyAccess may (a Super Admin by role), and only for somebody the
   * task pickers would offer them: the same company wall, the same exclusions.
   * Naming yourself is simply an ordinary task.
   */
  let setter = req.user;
  let proxy = null;
  const behalfId = String(body.onBehalfOf || '').trim();
  if (behalfId && behalfId !== String(req.user._id)) {
    if (!access.canAssignOnBehalf(req.user)) {
      bad(res, 'Setting a task on somebody else’s behalf needs a permission only a Super Admin can give.', 403);
    }
    if (!mongoose.Types.ObjectId.isValid(behalfId)) bad(res, 'Choose who the task is being set for.');
    const principal = await User.findOne({ $and: [await pickableUserFilter(req), { _id: behalfId }] })
      .select('firstName lastName role company');
    if (!principal) bad(res, 'You cannot set a task for that person — they are not in your company, or no longer active.');
    setter = principal;
    proxy = { by: req.user._id, byName: personName(req.user), at: new Date() };
  }

  let wanted = (body.assignees || []).map(String).filter(Boolean);
  // Nobody chosen means the SETTER's own task — so on somebody's behalf, theirs.
  if (!wanted.length) wanted = [String(setter._id)];

  const { kind } = await access.resolveAssignmentKind(setter, wanted);

  /**
   * A task set ONLY on yourself scores nothing — see taskPoints.award, which
   * refuses to credit anybody for a task they set themselves. Storing 0 here as
   * well means the row does not advertise a hundred points it can never pay.
   */
  const selfOnly = wanted.every((id) => id === String(setter._id));

  const assignees = await buildAssignees(wanted);
  if (!assignees.length) bad(res, 'None of the people chosen are available any more.');

  const dueDate = body.dueDate ? new Date(body.dueDate) : null;
  if (dueDate && Number.isNaN(dueDate.getTime())) bad(res, 'That due date is not a date.');

  const repeat = cleanRepeat(body.repeat);
  const recurring = repeat.frequency !== FREQUENCY.ONCE;
  // Only an app from before the Recurring tab still sends a Repeat here, and a
  // repeating task is the recurring grant's since 2026-09-28. Refused rather
  // than quietly made a one-off: the person asked for "every day" and must not
  // get "once" without being told.
  if (recurring && !access.canManageRecurring(req.user)) {
    bad(res, 'Repeating tasks need a permission only a Super Admin can give. Set it as a one-off task instead.', 403);
  }
  // On a repeating task the date the assigner picked is the START, and the
  // first occurrence's deadline is computed from the schedule — the brief's
  // "this due date gets converted to a start date".
  const startDate = recurring ? (dueDate || new Date()) : undefined;

  const settings = await points.taskSettings();
  let pts = body.points === undefined || body.points === null || body.points === ''
    ? settings.defaultPoints
    : Number(body.points);
  if (!Number.isFinite(pts) || pts < 0) bad(res, 'Points must be a number, 0 or more.');
  pts = Math.min(MAX_TASK_POINTS, Math.round(pts));

  // An older app's Repeat box sends no reminders. The company default ("1 day
  // before") can never go on a DAILY task — each one only appears at 9 AM on its
  // day — so a daily one gets what the Recurring tab gives it (2026-09-27): every
  // two hours until done.
  //
  // SETTING reminders is a grant since 2026-09-28 (User.taskReminderAccess).
  // Without it whatever the form sent is ignored, not refused — an older app
  // always sends the defaults it was given — and the task gets the company's.
  const reminders = body.reminders !== undefined && access.canSetReminders(req.user)
    ? cleanReminders(body.reminders)
    : (recurring && isRoutineFrequency(repeat.frequency)
      ? [{ channel: 'APP', amount: 2, unit: 'HOURS', when: REMINDER_WHEN.EVERY, pattern: REMINDER_PATTERN.HOURLY }]
      : settings.defaultReminders);

  const companyScope = await viewerCompanyScope(req);

  const task = new Task({
    kind,
    title,
    description: String(body.description || '').trim(),
    category: String(body.category || '').trim(),
    company: setter.company || req.user.company || companyScope?.[0] || null,
    createdBy: setter._id,
    createdByName: personName(setter),
    ...(proxy ? { onBehalf: proxy } : {}),
    assignees,
    loopUsers: [...new Set((body.loopUsers || []).map(String))]
      .filter(mongoose.Types.ObjectId.isValid),
    priority: normalisePriority(body.priority) || DEFAULT_PRIORITY,
    points: kind === KIND_TASK && !selfOnly ? pts : 0,
    /**
     * Does the assigner want to see it before it counts as done?
     *
     * ON unless they say otherwise (2026-09-22) — that is what the brief asks
     * for, and it is the safer default: a task that goes through a review
     * nobody needed costs one click, a task that quietly closed itself when it
     * should have been checked costs a re-run of the work. A REQUEST is never
     * reviewed and the model enforces that.
     */
    requiresApproval: !(body.requiresApproval === false
      || body.requiresApproval === 'false' || body.requiresApproval === '0'),
    dueDate: recurring ? undefined : dueDate,
    startDate,
    repeat,
    reminders,
    links: cleanLinks(body.links),
    linkedTask: engine.validId(body.linkedTask) ? body.linkedTask : undefined,
  });

  // The id has to exist before files can be filed under it.
  await task.save();

  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  if (uploaded.length) task.attachments = await storeFiles(uploaded, task._id, req.user);
  const voice = await storeVoiceNote(req.files, task._id, req.user, body.voiceDurationMs);
  if (voice) task.voiceNote = voice;
  if (uploaded.length || voice) await task.save();

  await TaskUpdate.create({
    task: task._id,
    kind: 'CREATED',
    by: req.user._id,
    byName: personName(req.user),
    to: task.status,
    // Who actually did it is the caller; in whose name, the note says.
    note: proxy
      ? `Set this task on behalf of ${personName(setter)}.`
      : (selfOnly ? 'Set this task for themselves.' : 'Set this task.'),
  });

  // A repeating task becomes a schedule, and the worker mints the occurrences.
  //
  // This is the OLD way in — the Repeat box on the assign form, which an app
  // build from before the Recurring tab (2026-09-27) still sends. The new way
  // is POST /tasks/recurring (taskTemplateController.createRecurring), which
  // makes only the schedule and lets the worker raise each occurrence when it
  // is due to appear. Kept working, on the same (IST-correct) date maths.
  if (recurring) {
    const recur = require('../services/taskRecurrenceWorker');
    const now = new Date();
    const schedule = await RecurringTask.create({
      title: task.title,
      description: task.description,
      category: task.category,
      priority: task.priority,
      points: task.points,
      assignees: assignees.map((a) => a.user),
      loopUsers: task.loopUsers,
      voiceNote: task.voiceNote,
      links: task.links,
      reminders: task.reminders,
      frequency: repeat.frequency,
      interval: repeat.interval,
      weekdays: repeat.weekdays,
      monthlyMode: repeat.monthlyMode,
      nthWeek: repeat.nthWeek,
      weekday: repeat.weekday,
      monthDay: repeat.monthDay,
      month: repeat.month,
      time: repeat.time || '18:00',
      startDate: startDate,
      until: repeat.until,
      requiresApproval: task.requiresApproval,
      mintFrom: now,
      company: task.company,
      createdBy: setter._id,
      createdByName: personName(setter),
      ...(proxy ? { onBehalf: proxy } : {}),
    });
    task.recurringTask = schedule._id;
    // The row just created IS the first occurrence — mint its deadline now
    // rather than leaving a dateless task sitting until the worker next runs.
    // The NEXT one that is not already past, so it is never born overdue.
    const next = recur.nextOccurrence(schedule.toObject(), now);
    task.dueDate = next ? next.dueAt : recur.firstDueDate(schedule);
    task.occurrenceKey = next ? next.key : recur.occurrenceKeyFor(task.dueDate);
    task.remindFrom = now;
    task.repeat = { ...repeat, time: schedule.time };
    // A daily one is ROUTINE — taken on already, only ever marked done.
    if (isRoutineFrequency(repeat.frequency)) {
      task.routine = true;
      task.requiresApproval = false;
      for (const a of task.assignees) {
        a.status = STATUS.IN_PROGRESS;
        a.acceptance = ACCEPTANCE.ACCEPTED;
        a.acceptedAt = now;
        a.startedAt = now;
      }
    }
    await task.save();
  }

  // The people on it hear it from the SETTER; the setter hears that it was
  // sent in their name.
  notify.assigned(task, setter).catch((e) => console.error('task notify failed:', e.message));
  if (proxy) {
    notify.setOnYourBehalf(task, req.user).catch((e) => console.error('task notify failed:', e.message));
  }

  res.status(201).json({ task: decorate(task.toObject()) });
});

/**
 * PATCH /api/tasks/:id — change the task itself.
 *
 * Only the assigner (or an admin). A doer changes STATUS, never the terms of
 * the job — see services/taskAccess.canEdit.
 */
const updateTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const task = await Task.findById(req.params.id);
  if (!task) bad(res, 'That task no longer exists.', 404);
  // Only the assigner, and (2026-09-27) only until somebody has taken it on —
  // a 409 carrying the reason once it has been (services/taskAccess).
  access.assertCanEdit(req.user, task);

  const body = parseBody(req);
  const changed = [];
  /**
   * THE TRAIL (2026-09-27) — the user's *"with a trail of what edits were
   * done"*. Every field that actually moves is written down as before → after,
   * already worded for reading (models/TaskUpdate.changes), so the person about
   * to accept it can see exactly what was changed under them, and when.
   */
  const changes = [];
  const note = (field, before, after) => changes.push({
    field,
    label: EDIT_FIELD_LABELS[field] || field,
    before: shortText(before),
    after: shortText(after),
  });

  if (body.title !== undefined) {
    const t = String(body.title).trim();
    if (!t) bad(res, 'A task needs a title.');
    if (t !== task.title) { note('title', task.title, t); task.title = t; changed.push('title'); }
  }
  if (body.description !== undefined) {
    const d = String(body.description).trim();
    if (d !== (task.description || '')) {
      note('description', task.description, d);
      task.description = d;
      changed.push('details');
    }
  }
  if (body.category !== undefined) {
    const c = String(body.category).trim();
    if (c !== (task.category || '')) {
      note('category', task.category, c);
      task.category = c;
      changed.push('category');
    }
  }
  if (body.priority !== undefined) {
    const p = normalisePriority(body.priority);
    if (p && p !== task.priority) { note('priority', task.priority, p); task.priority = p; changed.push('priority'); }
  }

  if (body.requiresApproval !== undefined) {
    const want = !(body.requiresApproval === false
      || body.requiresApproval === 'false' || body.requiresApproval === '0');
    if (want !== task.requiresApproval) {
      note('requiresApproval', task.requiresApproval ? 'Needed' : 'Not needed', want ? 'Needed' : 'Not needed');
      task.requiresApproval = want;
      changed.push(want ? 'review needed' : 'no review needed');
    }
  }

  if (body.points !== undefined && task.kind === KIND_TASK) {
    const p = Number(body.points);
    if (!Number.isFinite(p) || p < 0) bad(res, 'Points must be a number, 0 or more.');
    const rounded = Math.min(MAX_TASK_POINTS, Math.round(p));
    if (rounded !== task.points) {
      // Changing the figure after somebody has already been credited would put
      // the task and the credit out of step, and the credit is the one that is
      // money. Refuse rather than quietly disagree.
      if ((task.assignees || []).some((a) => a.pointsAwardedAt)) {
        bad(res, 'Points cannot be changed once somebody has completed this task and been credited.');
      }
      // …and it can never be dropped below what has already been handed down to
      // the pieces, or the people doing them would be owed points the task no
      // longer carries. The remedy is to take a piece's points back first.
      if (rounded < (task.distributedPoints || 0)) {
        bad(res, `${task.distributedPoints} points are already shared out across this task's pieces. `
          + 'Lower those first, or keep this at or above that figure.');
      }

      /**
       * …AND THE OTHER DIRECTION, on a PIECE.
       *
       * The guard above is the parent's: do not drop the pool below what has
       * been handed out. The mirror case was missing entirely — raising a
       * CHILD's points past what its parent still has. Two 50-point pieces of a
       * 100-point task, each edited to 100, made `distributedPoints` 200; the
       * model's clamp then silently pinned it back to 100, so the parent's
       * people earned nothing while 200 points of real money were credited out
       * of a 100-point task. Points settle in rupees (services/taskPoints), so
       * this is the same class as the split guard and belongs beside it.
       *
       * The budget is the parent's pool less what its OTHER pieces already
       * hold — this piece's current figure is being replaced, not added to.
       */
      if (task.parentTask) {
        const parent = await Task.findById(task.parentTask)
          .select('points distributedPoints code').lean();
        if (parent) {
          const others = Math.max(0, (parent.distributedPoints || 0) - (task.points || 0));
          const budget = Math.max(0, (parent.points || 0) - others);
          if (rounded > budget) {
            bad(res, `${parent.code || 'The task this is part of'} has only ${budget} points left `
              + `to give out${others ? ` (${others} are on its other pieces)` : ''}. `
              + 'Raise the task\'s own points first, or lower another piece.');
          }
        }
      }

      note('points', task.points, rounded);
      task.points = rounded;
      changed.push('points');
    }
  }

  if (body.dueDate !== undefined) {
    const d = body.dueDate ? new Date(body.dueDate) : null;
    if (d && Number.isNaN(d.getTime())) bad(res, 'That due date is not a date.');
    const was = task.dueDate ? new Date(task.dueDate).getTime() : null;
    // To the MINUTE: the web form's date box holds no seconds, so a deadline
    // picked on the phone (7:15:23) came back from an untouched web form as
    // 7:15:00 and read as moved — "7:15 am → 7:15 am" in the edit trail, an
    // extension counted and the reminders re-armed, for a change nobody made.
    const minute = (t) => (t === null ? null : Math.floor(t / 60000));
    if (minute(d ? d.getTime() : null) !== minute(was)) {
      note('dueDate', task.dueDate ? whenText(task.dueDate) : 'No deadline', d ? whenText(d) : 'No deadline');
      if (was && d) task.extensionCount = (task.extensionCount || 0) + 1;
      task.dueDate = d || undefined;
      // A moved deadline is a fresh chase: the rules that already fired against
      // the old date must be allowed to fire again against the new one — and
      // so must the "it is overdue now" announcement.
      task.firedReminders = [];
      task.overdueNotifiedAt = undefined;
      changed.push('deadline');
    }
  }

  // Reminders are the reminder grant's (2026-09-28) — from anybody else they are
  // left exactly as they were, the same "ignore, don't refuse" as on create.
  if (body.reminders !== undefined && access.canSetReminders(req.user)) {
    const next = cleanReminders(body.reminders);
    const words = (list) => (list || []).map(reminderLabel).join(', ') || 'None';
    if (words(task.reminders) !== words(next)) {
      note('reminders', words(task.reminders), words(next));
      changed.push('reminders');
    }
    task.reminders = next;
    task.firedReminders = [];
  }
  if (body.links !== undefined) {
    const next = cleanLinks(body.links);
    const words = (list) => (list || []).map((l) => l.label || l.url).join(', ') || 'None';
    if (words(task.links) !== words(next)) {
      note('links', words(task.links), words(next));
      changed.push('links');
    }
    task.links = next;
  }

  if (body.loopUsers !== undefined) {
    const next = [...new Set((body.loopUsers || []).map(String))]
      .filter(mongoose.Types.ObjectId.isValid);
    const before = (task.loopUsers || []).map(String);
    if (before.slice().sort().join() !== next.slice().sort().join()) {
      const names = await namesOf([...before, ...next]);
      const say = (list) => list.map((id) => names.get(id)).filter(Boolean).join(', ') || 'Nobody';
      note('loopUsers', say(before), say(next));
      changed.push('who is kept in the loop');
    }
    task.loopUsers = next;
  }

  // Changing WHO is on it goes through the direction rule again — an edit must
  // not be a way around a check the create path makes.
  if (body.assignees !== undefined) {
    const wanted = (body.assignees || []).map(String).filter(Boolean);
    if (!wanted.length) bad(res, 'A task needs at least one person on it.');
    await access.resolveAssignmentKind(req.user, wanted, task.kind);
    const fresh = await buildAssignees(wanted);
    const before = (task.assignees || []).map((a) => String(a.user));
    // Keep the progress of anybody who is staying: re-assigning a five-person
    // task must not reset the two people who have already finished.
    const existing = new Map((task.assignees || []).map((a) => [String(a.user), a]));
    const beforeNames = (task.assignees || []).map((a) => a.name).filter(Boolean).join(', ') || '—';
    task.assignees = fresh.map((f) => existing.get(String(f.user)) || f);
    if (before.slice().sort().join() !== fresh.map((f) => String(f.user)).sort().join()) {
      note('assignees', beforeNames, fresh.map((f) => f.name).filter(Boolean).join(', ') || '—');
      changed.push('who is on it');
    }
  }

  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  if (uploaded.length) {
    const had = (task.attachments || []).length;
    task.attachments.push(...await storeFiles(uploaded, task._id, req.user));
    note('attachments', `${had} file${had === 1 ? '' : 's'}`,
      `${had + uploaded.length} files — added ${uploaded.map((f) => f.originalname).filter(Boolean).join(', ')}`);
    changed.push('files');
  }
  const voice = await storeVoiceNote(req.files, task._id, req.user, body.voiceDurationMs);
  if (voice) {
    note('voiceNote', task.voiceNote?.storagePath ? 'Earlier recording' : 'None', 'New recording');
    task.voiceNote = voice;
    changed.push('voice note');
  }

  if (changes.length) {
    task.editCount = (task.editCount || 0) + 1;
    task.lastEditedAt = new Date();
    task.lastEditedByName = personName(req.user);
  }

  await task.save();

  /**
   * EDITING A PIECE CHANGES ITS PARENT'S FIGURES.
   *
   * `recomputeParent` is the only thing that writes childCount, childDoneCount,
   * distributedPoints and the parent's progress bar, and every OTHER path that
   * touches a child already calls it — the engine's move, split, claim and
   * progress all do. This one did not, so editing a piece's points or deadline
   * left the parent's "3 of 5", its bar and `can.pointsBudget` stale until some
   * unrelated event on a sibling happened to trigger a recompute.
   */
  if (task.parentTask) {
    await engine.recomputeParent(task.parentTask)
      .catch((e) => console.error('parent recompute failed:', e.message));
  }

  if (changed.length) {
    await TaskUpdate.create({
      task: task._id,
      kind: 'EDITED',
      by: req.user._id,
      byName: personName(req.user),
      note: `Changed ${changed.join(', ')}.`,
      changes: changes.length ? changes : undefined,
    });
    // The first two changes in full, so the notification alone says what moved.
    const said = changes.slice(0, 2).map((c) => `${c.label}: ${c.before || '—'} → ${c.after || '—'}`).join(' · ')
      + (changes.length > 2 ? ` · +${changes.length - 2} more` : '');
    notify.edited(task, req.user, said || `Changed ${changed.join(', ')}`)
      .catch((e) => console.error('task notify failed:', e.message));
  }

  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    changes,
  });
});

/** One line of an edit trail, short enough for a phone. */
function shortText(v) {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s.length > 280 ? `${s.slice(0, 277)}…` : s;
}

/** A deadline as a person reads it — portal time, twelve-hour. */
function whenText(d) {
  return new Date(d).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    hour12: true, timeZone: 'Asia/Kolkata',
  });
}

/** id → "First Last" for the people an edit moved, in one query. */
async function namesOf(ids) {
  const list = [...new Set((ids || []).map(String))].filter(mongoose.Types.ObjectId.isValid);
  if (!list.length) return new Map();
  const users = await User.find({ _id: { $in: list } }).select('firstName lastName').lean();
  return new Map(users.map((u) => [String(u._id), personName(u)]));
}

/**
 * POST /api/tasks/:id/nudge — THE REMINDER BELL (2026-09-27).
 *
 * Body `{ note? }`. Whoever set the task chases the people still doing it while
 * it is not accepted, in progress or overdue; somebody who handed it in chases
 * the approver while it sits in review (services/taskAccess.nudgeTargets).
 *
 * THE 30-MINUTE GATE is one conditional update on `lastNudgeAt` — the claim IS
 * the check, so two presses in the same second (or two managers) cannot both
 * get through. A refused press is a 429 carrying `nextAt`, so the client can
 * say when rather than just "no". The scheduled reminders never read this
 * field: the user's rule is that an auto reminder goes on time regardless.
 */
const nudgeTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const task = await Task.findById(req.params.id);
  if (!task || task.archived) bad(res, 'That task no longer exists.', 404);
  access.assertCanSee(req.user, task);

  const target = access.nudgeTargets(req.user, task);
  if (!target) {
    bad(res, task.status === STATUS.SUBMITTED
      ? 'Only somebody who handed this in can remind the reviewer.'
      : 'There is nobody on this task for you to remind right now.', 403);
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - NUDGE_COOLDOWN_MIN * 60 * 1000);
  const note = String(parseBody(req).note || '').trim().slice(0, 300);
  const names = await namesOf(target.to);
  const toNames = target.to.map((id) => names.get(id)).filter(Boolean).join(', ');

  // The gate is per DIRECTION (Task.nudgeAt): the setter chasing the work and
  // a doer chasing the review are different people being asked.
  const gate = `nudgeAt.${target.kind}`;
  const won = await Task.updateOne(
    { _id: task._id, $or: [{ [gate]: null }, { [gate]: { $lte: cutoff } }] },
    {
      $set: { lastNudgeAt: now, [gate]: now },
      $inc: { nudgeCount: 1 },
      $push: {
        nudges: {
          $each: [{
            by: req.user._id, byName: personName(req.user), kind: target.kind, to: target.to, toNames, note, at: now,
          }],
          $slice: -50,
        },
      },
    }
  );
  if (!won.modifiedCount) {
    const fresh = await Task.findById(task._id).select('nudgeAt lastNudgeAt').lean();
    const last = fresh?.nudgeAt?.[target.kind] || fresh?.lastNudgeAt || now;
    const nextAt = nudgeReadyAt(fresh, now, target.kind) || new Date(now.getTime() + NUDGE_COOLDOWN_MIN * 60 * 1000);
    res.status(429);
    return res.json({
      message: `A reminder went out ${Math.max(1, Math.round((now - new Date(last)) / 60000))} min ago. `
        + `You can send another after ${whenText(nextAt).split(', ').pop()}.`,
      nextAt,
    });
  }

  await TaskUpdate.create({
    task: task._id,
    kind: 'NUDGED',
    by: req.user._id,
    byName: personName(req.user),
    note: note || (target.kind === 'REVIEW'
      ? `Reminded ${toNames || 'the reviewer'} to review it.`
      : `Sent ${toNames || 'them'} a reminder.`),
  });
  notify.nudged(task, req.user, { to: target.to, kind: target.kind, note })
    .catch((e) => console.error('task nudge notify failed:', e.message));

  const nextAt = new Date(now.getTime() + NUDGE_COOLDOWN_MIN * 60 * 1000);
  res.json({
    ok: true,
    sentTo: toNames,
    kind: target.kind,
    nextAt,
    message: `Reminder sent to ${toNames || (target.kind === 'REVIEW' ? 'the reviewer' : 'them')}.`,
  });
});

/**
 * POST /api/tasks/:id/status — the one endpoint that moves anything.
 *
 * Body: { to, note, voiceDurationMs?, mentions? } plus optional files. Every
 * client uses this; there is no /start, /complete or /accept, because four
 * endpoints doing one thing is four places for the rule to be slightly
 * different.
 */
const changeStatus = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);

  const to = String(body.to || body.status || '').trim().toUpperCase();
  if (!TASK_STATUS.includes(to)) bad(res, 'That is not a status a task can be in.');

  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  const files = uploaded.length ? await storeFiles(uploaded, req.params.id, req.user) : [];
  const voice = await storeVoiceNote(req.files, req.params.id, req.user, body.voiceDurationMs);

  const result = await engine.move({
    taskId: req.params.id,
    user: req.user,
    to,
    note: body.note,
    voiceNote: voice,
    files,
    mentions: (body.mentions || []).filter(mongoose.Types.ObjectId.isValid),
  });

  const task = await Task.findById(req.params.id)
    .populate('assignees.user', 'firstName lastName photo')
    .populate('createdBy', 'firstName lastName photo');

  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    unchanged: Boolean(result.unchanged),
    awarded: (result.awarded || []).map((a) => ({ points: a.points, credited: a.credited })),
  });
});

/** POST /api/tasks/:id/updates — a remark, with or without a recording. */
const addUpdate = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);

  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  const files = uploaded.length ? await storeFiles(uploaded, req.params.id, req.user) : [];
  const voice = await storeVoiceNote(req.files, req.params.id, req.user, body.voiceDurationMs);

  const { update } = await engine.comment({
    taskId: req.params.id,
    user: req.user,
    note: body.note,
    voiceNote: voice,
    files,
    mentions: (body.mentions || []).filter(mongoose.Types.ObjectId.isValid),
  });

  const full = await TaskUpdate.findById(update._id).populate('by', 'firstName lastName photo').lean();
  res.status(201).json({ update: full });
});

/**
 * POST /api/tasks/:id/accept — take it on.
 * POST /api/tasks/:id/decline — refuse it, with a reason.
 * POST /api/tasks/:id/delegate — pass your own piece to somebody else.
 *
 * The doer's three answers to being handed work. All three are IDENTITY-gated
 * inside the engine: only somebody actually on the task may use them, so an
 * assigner cannot accept on a doer's behalf (which would make acceptance
 * meaningless) and a bystander cannot pass on work that was never theirs.
 */
const acceptTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const { task, unchanged } = await engine.accept({
    taskId: req.params.id,
    user: req.user,
    note: parseBody(req).note,
  });
  const changedTask = decorate(task.toObject());
  await localise(req, changedTask);
  res.json({ task: changedTask, can: access.capabilitiesFor(req.user, task), unchanged: Boolean(unchanged) });
});

const declineTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task } = await engine.decline({
    taskId: req.params.id,
    user: req.user,
    reason: body.reason || body.note,
  });
  const changedTask = decorate(task.toObject());
  await localise(req, changedTask);
  res.json({ task: changedTask, can: access.capabilitiesFor(req.user, task) });
});

const delegateTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task, delegatedTo } = await engine.delegate({
    taskId: req.params.id,
    user: req.user,
    to: body.to,
    note: body.note,
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    delegatedTo: { user: String(delegatedTo.user), name: delegatedTo.name },
  });
});

// ===== Submitting, approving, sending back =====

/**
 * POST /api/tasks/:id/submit — hand it in.
 *
 * Sugar over the engine's move, and it exists for the WORDING. "Submit" and
 * "Complete" are the same underlying move with the review rule applied, but a
 * client that had to send `{ to: 'COMPLETED' }` and then explain that it went
 * somewhere else would be re-deriving the server's rule to word its own
 * success message. This route says what it does.
 */
const submitTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  // THE SAME CALL SHAPE AS changeStatus, and it has to be: both helpers take
  // the multer array, the task id and the actor. Handed `req` they threw
  // "files.find is not a function" and every hand-in died as a 500 — with the
  // recording the person had just made still in the request.
  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  const files = uploaded.length ? await storeFiles(uploaded, req.params.id, req.user) : [];
  const voiceNote = await storeVoiceNote(req.files, req.params.id, req.user, body.voiceDurationMs);
  const { task, update, unchanged, coerced } = await engine.move({
    taskId: req.params.id,
    user: req.user,
    to: STATUS.SUBMITTED,
    note: body.note || '',
    voiceNote,
    files,
    mentions: listParam(body.mentions).map(oid).filter(Boolean),
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    update,
    unchanged: Boolean(unchanged),
    coerced: Boolean(coerced),
  });
});

/**
 * POST /api/tasks/:id/approve — the assigner signs it off.
 * POST /api/tasks/:id/reject  — …or sends it back, which reopens it.
 *
 * The brief: *"when user submit any task then manager should have the option to
 * approve that and on reject that submission the task will reopen again and
 * assign them again"*. Sending back lands on IN_PROGRESS with the same people
 * still on it, which is what "assign them again" means in practice — throwing
 * the assignees away and re-picking them would discard every remark, file and
 * hour already on the row.
 */
const decideSubmission = (approve) => asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const note = String(body.note || '').trim();
  if (!approve && !note) {
    bad(res, 'Say what needs doing before sending this back — that is the whole point of sending it back.');
  }
  // See submitTask: the helpers take (files, taskId, user[, durationMs]).
  const uploaded = (req.files || []).filter((f) => f.fieldname !== 'voice');
  const files = uploaded.length ? await storeFiles(uploaded, req.params.id, req.user) : [];
  const voiceNote = await storeVoiceNote(req.files, req.params.id, req.user, body.voiceDurationMs);
  const { task, update, unchanged, awarded } = await engine.move({
    taskId: req.params.id,
    user: req.user,
    to: approve ? STATUS.COMPLETED : STATUS.IN_PROGRESS,
    note,
    voiceNote,
    files,
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    update,
    unchanged: Boolean(unchanged),
    // Both clients word the approval with the points ("Approved · 40 points
    // credited") and read them from here; without this the figure was always 0
    // and the line never appeared. Same shape as changeStatus's.
    awarded: (awarded || []).map((a) => ({ points: a.points, credited: a.credited })),
  });
});

const approveTask = decideSubmission(true);
const rejectTask = decideSubmission(false);

// ===== Progress =====

/** PATCH /api/tasks/:id/progress — "I am this far along." */
const setProgress = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  if (body.progress === undefined || body.progress === null || body.progress === '') {
    bad(res, 'Say how far along you are.');
  }
  const { task, update, unchanged, progress } = await engine.setProgress({
    taskId: req.params.id,
    user: req.user,
    progress: body.progress,
    note: body.note || '',
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    update,
    progress: progress ?? clampProgress(body.progress),
    unchanged: Boolean(unchanged),
  });
});

// ===== Asking for more time =====

/** POST /api/tasks/:id/extension — `{ toDate, reason }`. */
const askExtension = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task, extension } = await engine.requestExtension({
    taskId: req.params.id,
    user: req.user,
    toDate: body.toDate || body.dueDate,
    reason: body.reason || body.note || '',
  });
  res.status(201).json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    extension,
  });
});

/** POST /api/tasks/:id/extension/:reqId — `{ approve, note }`. */
const decideExtension = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task, extension, unchanged } = await engine.decideExtension({
    taskId: req.params.id,
    requestId: req.params.reqId,
    user: req.user,
    approve: body.approve === true || body.approve === 'true' || body.approve === '1',
    note: body.note || '',
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    extension,
    unchanged: Boolean(unchanged),
  });
});

// ===== Pieces =====

/**
 * POST /api/tasks/:id/split — break it into pieces, each its own task.
 *
 * Body: `{ items: [{ title, description?, assignee?, openTo?, points?, dueDate?, priority? }] }`.
 * Leave `points` off and the pool is shared equally — the brief's *"by default
 * it will be divided equally"*. Leave `assignee` off and the piece is OFFERED
 * to `openTo` (defaulting to the splitter's own direct reports) for somebody to
 * pick up.
 */
const splitTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const items = Array.isArray(body.items) ? body.items : [body];
  const { parent, children } = await engine.splitTask({
    taskId: req.params.id,
    user: req.user,
    items,
  });
  res.status(201).json({
    task: decorate(parent.toObject()),
    can: access.capabilitiesFor(req.user, parent),
    children: children.map((c, i) => ({
      ...decorate(c.toObject()),
      serial: i + 1,
      can: access.capabilitiesFor(req.user, c),
    })),
  });
});

/**
 * POST /api/tasks/:id/transfer — it went to the wrong person.
 *
 * Body `{ to, reason }`, both required. NOT the same as delegate: the person it
 * comes off drops out of the task completely, including out of its
 * notifications — see services/taskEngine.transferTask for why that is the one
 * place `originalAssignees` is rewritten.
 */
const transferTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task, transferredTo } = await engine.transferTask({
    taskId: req.params.id,
    user: req.user,
    to: body.to || body.assignee,
    reason: body.reason || body.note || '',
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    transferredTo,
  });
});

/** POST /api/tasks/:id/claim — take an open piece. */
const claimTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const { task } = await engine.claimTask({ taskId: req.params.id, user: req.user });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
  });
});

// ===== The old subtask endpoints, kept working =====
//
// They drive child tasks now (services/taskEngine's adapters). An Android build
// from before 2026-09-22 still calls all three, and an APK in somebody's pocket
// does not update because the server deployed.

/**
 * POST /api/tasks/:id/subtasks — split it up. LEGACY; prefer `/split`.
 *
 * Body: `{ items: [{ title, assignee? }] }`, or `{ title, assignee? }` for one.
 */
const addSubtasks = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const items = Array.isArray(body.items) ? body.items : [body];
  const { task, added } = await engine.addSubtasks({
    taskId: req.params.id,
    user: req.user,
    items,
  });
  res.status(201).json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    added,
  });
});

/** PATCH /api/tasks/:id/subtasks/:subId — tick it off, or un-tick it. */
const setSubtask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const body = parseBody(req);
  const { task, unchanged, progress } = await engine.setSubtaskDone({
    taskId: req.params.id,
    subtaskId: req.params.subId,
    user: req.user,
    done: body.done !== false && body.done !== 'false',
  });
  res.json({
    task: decorate(task.toObject()),
    can: access.capabilitiesFor(req.user, task),
    unchanged: Boolean(unchanged),
    progress,
  });
});

/** DELETE /api/tasks/:id/subtasks/:subId */
const removeSubtask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const { task } = await engine.removeSubtask({
    taskId: req.params.id,
    subtaskId: req.params.subId,
    user: req.user,
  });
  const changedTask = decorate(task.toObject());
  await localise(req, changedTask);
  res.json({ task: changedTask, can: access.capabilitiesFor(req.user, task) });
});

/**
 * DELETE /api/tasks/:id — remove it.
 *
 * TWO KINDS OF REMOVAL, and the difference matters:
 *
 *   ARCHIVE (the default)  the row keeps its feed, its files and any points it
 *                          credited, and simply stops appearing anywhere. Open
 *                          to whoever set the task, to `tasks.manage`, and — at
 *                          the user's request, 2026-09-21 — to a SuperAdmin on
 *                          ANY task, whoever set it.
 *   PURGE (`?purge=1`)     really gone. SuperAdmin alone, and REFUSED once
 *                          points have been credited against it: the
 *                          IncentiveCredit would outlive the only record of
 *                          what it was for, and somebody would eventually ask.
 */
const deleteTask = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That task no longer exists.', 404);
  const task = await Task.findById(req.params.id);
  if (!task) bad(res, 'That task no longer exists.', 404);
  if (!access.canDelete(req.user, task)) {
    bad(res, 'Only the person who set this task, or a Super Admin, can remove it.', 403);
  }

  const purge = req.query.purge === '1' || req.query.purge === 'true';
  if (purge) {
    if (!access.canPurge(req.user)) bad(res, 'Only a Super Admin can delete a task for good.', 403);

    const credited = (task.assignees || []).filter((a) => a.pointsAwardedAt);
    if (credited.length) {
      bad(res,
        `${credited.length} person${credited.length === 1 ? ' has' : 's have'} already been credited `
        + 'points for this task. Reopen it first to take those back, then delete it.');
    }

    await TaskUpdate.deleteMany({ task: task._id });
    await Task.deleteOne({ _id: task._id });
    return res.json({ ok: true, purged: true, message: 'Deleted for good.' });
  }

  task.archived = true;
  await task.save();
  await TaskUpdate.create({
    task: task._id,
    kind: 'EDITED',
    by: req.user._id,
    byName: personName(req.user),
    note: 'Removed this task.',
  });
  res.json({ ok: true, purged: false, message: 'Removed.' });
});

// ===== Files =====

/** GET /api/tasks/:id/files/:fileId — stream one attachment or the voice note. */
const downloadFile = asyncHandler(async (req, res) => {
  if (!engine.validId(req.params.id)) bad(res, 'That file is not there.', 404);
  const task = await Task.findById(req.params.id)
    .select(`${VISIBILITY_FIELDS} attachments voiceNote`);
  if (!task) bad(res, 'That file is not there.', 404);
  access.assertCanSee(req.user, task);

  let file = null;
  if (req.params.fileId === 'voice') {
    file = task.voiceNote
      ? { storagePath: task.voiceNote.storagePath, mimeType: task.voiceNote.mimeType, name: 'voice-note' }
      : null;
  } else {
    file = (task.attachments || []).find((a) => String(a._id) === String(req.params.fileId));
    if (!file) {
      // It may belong to an update rather than the task itself.
      const upd = await TaskUpdate.findOne({ task: task._id, 'files._id': req.params.fileId })
        .select('files voiceNote').lean();
      file = (upd?.files || []).find((f) => String(f._id) === String(req.params.fileId)) || null;
    }
  }
  if (!file) bad(res, 'That file is not there.', 404);

  res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(file.name || 'file').replace(/"/g, '')}"`);
  const ok = await storage.streamTo(file.storagePath, res);
  if (!ok && !res.headersSent) bad(res, 'That file is not there.', 404);
});

/** GET /api/tasks/:id/updates/:updateId/voice — a remark's recording. */
const downloadUpdateVoice = asyncHandler(async (req, res) => {
  const upd = await TaskUpdate.findById(req.params.updateId).select('task voiceNote').lean();
  if (!upd?.voiceNote?.storagePath) bad(res, 'That recording is not there.', 404);
  const task = await Task.findById(upd.task).select(VISIBILITY_FIELDS);
  if (!task) bad(res, 'That recording is not there.', 404);
  access.assertCanSee(req.user, task);

  res.setHeader('Content-Type', upd.voiceNote.mimeType || 'audio/webm');
  const ok = await storage.streamTo(upd.voiceNote.storagePath, res);
  if (!ok && !res.headersSent) bad(res, 'That recording is not there.', 404);
});

// ===== Reference data =====

/**
 * GET /api/tasks/meta — everything the assign form needs, in one call.
 *
 * The form used to open with five requests in flight (people, categories,
 * templates, settings, my own permissions) and drew itself progressively as
 * they landed. On a phone against Android's five-connections-per-host that was
 * the difference between instant and a second and a half — the same trap the
 * app's launch sequence already had to be fixed for.
 */
const taskMeta = asyncHandler(async (req, res) => {
  const [people, categories, settings] = await Promise.all([
    User.find(await pickableUserFilter(req))
      .select('firstName lastName role photo')
      .sort({ firstName: 1 })
      .lean(),

    TaskCategory.find({ isActive: true, ...(req.user.company ? { $or: [{ company: req.user.company }, { company: null }] } : {}) })
      .select('name color')
      .sort({ name: 1 })
      .lean(),
    points.taskSettings(),
  ]);

  /**
   * WHAT EACH PERSON CAN BE FOUND BY (2026-09-25).
   *
   * The brief: *"we can find other by searching the name or employee code or
   * designation or department"*. Code, designation and department live on the
   * employee profile, not the login, so they are joined here once — the picker
   * then searches all four on the device, with no round trip per keystroke.
   * Somebody with no profile (a CEO/MD) simply has none of the three.
   */
  const profiles = await EmployeeProfile.find({ user: { $in: people.map((p) => p._id) } })
    .select('user employeeCode designation department')
    .lean();
  const profileOf = new Map(profiles.map((p) => [String(p.user), p]));

  /**
   * The departments the filter offers: the ones people are actually in, each
   * spelled once. Free text on the profile, so "sales" and "Sales" are folded
   * together under whichever spelling is met first.
   */
  const deptSeen = new Map();
  for (const p of profiles) {
    const d = String(p.department || '').trim();
    if (d && !deptSeen.has(d.toLowerCase())) deptSeen.set(d.toLowerCase(), d);
  }
  const departments = [...deptSeen.values()].sort((a, b) => a.localeCompare(b));

  /**
   * …AND WHERE EACH OF THEM STANDS (2026-09-22).
   *
   * The brief: *"for all dropdown like this only show the team member for
   * manager and for CEO and MD show Manager who are under them but they can
   * search other people to find that"*. So every picker opens on MY TEAM and
   * widens to the whole company the moment somebody types.
   *
   * It is one annotation on a list the form already downloads, rather than a
   * search endpoint the picker calls on every keystroke: this company is fifty
   * people, the payload is already in flight, and a round trip per letter on a
   * phone against Android's five-connections-per-host is the trap this module's
   * own meta call was created to avoid.
   *
   * If the directory ever outgrows one payload, this becomes `GET
   * /api/tasks/people?q=` with the same three fields and nothing else changes.
   */
  const { people: annotated, team: fullTeam } = await access.annotatePeople(req, people);
  const departed = await departedUserIdSet(people.map((p) => p._id));
  // "My team", which every picker opens on, is the people still here. A leaver
  // stays in `people` below (flagged) only so a task they are already on keeps
  // their name — never as somebody on the team.
  const stillHere = (ids) => ids.filter((id) => !departed.has(String(id)));
  const team = { direct: stillHere(fullTeam.direct), indirect: stillHere(fullTeam.indirect) };
  const hasTeam = team.direct.length > 0 || team.indirect.length > 0;

  res.json({
    people: annotated.map((p) => ({
      _id: p._id,
      name: personName(p),
      role: p.role,
      photo: p.photo || null,
      employeeCode: profileOf.get(String(p._id))?.employeeCode || '',
      designation: profileOf.get(String(p._id))?.designation || '',
      department: profileOf.get(String(p._id))?.department || '',
      // Anybody may be given a task since 2026-09-25. Still sent, and always
      // true, because an older app greys anyone it reads `false` on as "ask
      // only" and turns its form into a request.
      canAssign: true,
      canRequest: false,
      // Where they stand: 'self' | 'direct' | 'indirect' | 'manager' | 'chain' | 'peer'.
      relation: p.relation,
      // Somebody working out their notice keeps their login but takes no new
      // work — the portal-wide rule. Marked rather than dropped, so a task they
      // are ALREADY on still renders their name (utils/peopleOptions).
      departed: departed.has(String(p._id)),
    })),
    // Who is asking — so a picker can offer "Myself" and a form can say that
    // leaving the box empty assigns the task to you.
    me: String(req.user._id),
    // Draws "On behalf of" on the assign form (User.taskProxyAccess, or a
    // Super Admin). The server refuses the field without it regardless.
    canAssignOnBehalf: access.canAssignOnBehalf(req.user),
    // The two Super Admin grants of 2026-09-28. `canRecur` opens the Recurring
    // Tasks page (and its menu row); `canSetReminders` draws the Reminders
    // section on every assign form. Both are enforced on the server whatever a
    // client draws — recurring routes refuse, reminders are ignored.
    canRecur: access.canManageRecurring(req.user),
    canSetReminders: access.canSetReminders(req.user),
    team,
    hasTeam,
    departments,
    categories,
    priorities: TASK_PRIORITY,
    // ONE palette, served rather than hard-coded in two clients — see
    // config/tasks.PRIORITY_COLORS for why.
    priorityColors: PRIORITY_COLORS,
    doneColor: DONE_COLOR,
    cancelledColor: CANCELLED_COLOR,
    statuses: TASK_STATUS.map((s) => ({ key: s, label: statusLabel(s, KIND_TASK) })),
    boardColumns: BOARD_COLUMNS.map((c) => ({ ...c, label: c.label })),
    // `dir` = the order's natural way round, so a client draws the right arrow
    // before the reader has touched it.
    sorts: SORT_KEYS.map((k) => ({ key: k, label: SORTS[k].label, dir: SORTS[k].dir === 1 ? 'asc' : 'desc' })),
    progressSteps: PROGRESS_STEPS,
    maxPieces: MAX_SUBTASKS,
    frequencies: FREQUENCIES.map((f) => ({ key: f, label: FREQUENCY_LABELS[f] })),
    weekdays: WEEKDAYS,
    // ===== The Recurring tab's vocabulary (2026-09-27) =====
    weekdayNames: WEEKDAY_NAMES,
    monthlyModes: MONTHLY_MODES,
    nthWeeks: NTH_WEEKS.map((n) => ({ key: n, label: NTH_WEEK_LABELS[String(n)] })),
    maxDayInterval: MAX_DAY_INTERVAL,
    defaultLeadDays: DEFAULT_LEAD_DAYS,
    maxLeadDays: MAX_LEAD_DAYS,
    repeatReminder: REPEAT_REMINDER,
    reminderChannels: REMINDER_CHANNELS.map((c) => ({ key: c, label: REMINDER_CHANNEL_LABELS[c] })),
    reminderUnits: REMINDER_UNITS,
    // The shapes a repeating reminder can take (2026-09-27) and their defaults.
    reminderPatterns: REMINDER_PATTERNS.map((k) => ({ key: k, label: REMINDER_PATTERN_LABELS[k] })),
    defaultRemindAt: DEFAULT_REMIND_AT,
    defaultRemindWindow: DEFAULT_REMIND_WINDOW,
    // ===== Swiping and the bell (2026-09-27) =====
    // While true a swipe will not go without a remark — the user's "mandatory
    // now, we will decide later" (Setting.tasks.swipeRemarkRequired).
    swipeRemarkRequired: settings.swipeRemarkRequired !== false,
    nudgeCooldownMin: NUDGE_COOLDOWN_MIN,
    defaultPoints: settings.defaultPoints,
    defaultReminders: settings.defaultReminders,
    pointsArePaid: settings.pointsToPool,
    isAdmin: access.seesEverything(req.user),
    // Renaming or removing a category is a SuperAdmin's alone — adding one is
    // everybody's. Sent so the form can offer the manage button rather than the
    // client guessing from a role string (see routes/taskRoutes).
    canManageCategories: req.user.role === 'SuperAdmin',
  });
});

/** POST /api/tasks/categories — the + beside the category picker. */
const createCategory = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) bad(res, 'Give the category a name.');
  if (name.length > 80) bad(res, 'That category name is too long.');

  const company = req.user.company || null;
  // Case-insensitive, so a second "sales" cannot appear beside "Sales" — the
  // exact problem models/TaskCategory exists to end.
  const existing = await TaskCategory.findOne({ company, name })
    .collation({ locale: 'en', strength: 2 });
  if (existing) return res.status(200).json({ category: existing, existed: true });

  const category = await TaskCategory.create({
    name,
    company,
    createdBy: req.user._id,
    createdByName: personName(req.user),
  });
  res.status(201).json({ category });
});

/**
 * GET /api/tasks/categories
 *
 * `?withCounts=1` adds how many tasks are filed under each — what the manage
 * list needs so a SuperAdmin about to remove one can see they are hiding the
 * label on 212 rows rather than on nothing.
 */
const listCategories = asyncHandler(async (req, res) => {
  const filter = { isActive: true };
  if (req.user.company) filter.$or = [{ company: req.user.company }, { company: null }];
  const categories = await TaskCategory.find(filter).sort({ name: 1 }).lean();

  if (req.query.withCounts !== '1' && req.query.withCounts !== 'true') {
    return res.json({ categories });
  }

  // One aggregation over the whole collection rather than a count per row: a
  // list of forty categories would otherwise be forty round trips.
  const used = await Task.aggregate([
    { $match: { archived: { $ne: true }, category: { $nin: [null, ''] } } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
  ]);
  // Matched case-insensitively, the way the unique index treats them, so a
  // stray "sales" is counted against "Sales" rather than reading as unused.
  const counts = new Map(used.map((u) => [String(u._id).trim().toLowerCase(), u.count]));

  res.json({
    categories: categories.map((c) => ({
      ...c,
      taskCount: counts.get(String(c.name).trim().toLowerCase()) || 0,
    })),
  });
});

/**
 * PATCH /api/tasks/categories/:id — rename one, SuperAdmin only.
 *
 * The tasks store the NAME, not the id, so a rename has to carry the tasks with
 * it or two hundred rows are left filed under a label that no longer appears in
 * any picker. Done in one `updateMany` AFTER the category itself is saved: if
 * the save fails there is nothing to undo, and if the sweep fails the category
 * is right and the tasks can be swept again.
 */
const renameCategory = asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) bad(res, 'Give the category a name.');
  if (name.length > 80) bad(res, 'That category name is too long.');

  const cat = await TaskCategory.findById(req.params.id);
  if (!cat) bad(res, 'That category is gone.', 404);

  const was = cat.name;
  if (was === name) return res.json({ category: cat, movedTasks: 0 });

  const clash = await TaskCategory.findOne({ company: cat.company, name, _id: { $ne: cat._id } })
    .collation({ locale: 'en', strength: 2 });
  if (clash) bad(res, `There is already a category called "${clash.name}".`);

  cat.name = name;
  await cat.save();

  const swept = await Task.updateMany(
    { category: was },
    { $set: { category: name } }
  );
  res.json({ category: cat, movedTasks: swept.modifiedCount || 0 });
});

/**
 * How many tasks are ON this person right now — the sidebar badge.
 *
 * Their own open rows, overdue ones included. Called by approvalController's
 * one-shot counts fan-out, so it must be a single cheap query and must never
 * throw: a badge that fails takes the whole counts response down with it.
 *
 * Counted from `assignees.status` rather than the task's rolled-up status, so a
 * five-person task that two people have finished still badges for the three who
 * have not.
 */
async function countMyOpenTasks(req) {
  /**
   * WHAT IS WAITING ON ME — which since 2026-09-22 is two different things.
   *
   * Work I have to do (mine, not yet handed in) AND work I have to look at
   * (somebody handed in a task I set). A submission I have not read is exactly
   * as blocking as a task I have not started, and it is the one queue nobody
   * else can clear for me — so a badge that ignored it would tell a manager
   * they were up to date while five people waited on their word.
   *
   * A row I have SUBMITTED is deliberately not counted for me: it is out of my
   * hands, and counting it would leave a number I cannot make go down.
   */
  /**
   * EVERY SPELLING, not the two current words.
   *
   * This is a QUERY, and a query cannot call normaliseStatus — the read-path
   * normalisation that makes the rest of the module work on un-migrated rows
   * (models/Task's post('init')) happens after Mongo has already decided what
   * to return. 51 of the 61 live tasks still hold the pre-rework word, so
   * naming PENDING and IN_PROGRESS alone counted almost nothing: the badge
   * this feeds would have sat at 0 for people with a dozen tasks on them,
   * which is worse than no badge at all — it is a badge that lies.
   *
   * `assignees[].status` carries the identical legacy vocabulary (assigneeSchema
   * enumerates it), so the $elemMatch needs it as much as a top-level match
   * would. And SUBMITTED has legacy spellings of its own — `Review` from before
   * the 2026-09-17 rework and `UNDER_REVIEW` from it — so the review half was
   * undercounting too, on exactly the rows a manager most needs to see.
   */
  const open = spellingsOf(STATUS.PENDING, STATUS.IN_PROGRESS);
  const handedIn = spellingsOf(STATUS.SUBMITTED);
  const me = req.user._id;

  /**
   * ONE COUNT, NOT TWO SUMMED.
   *
   * It used to be `doing + reviewing` from two countDocuments, and a single
   * task could satisfy both — a task you set, assigned to yourself and
   * somebody else, declined, and which they then handed in, was counted
   * twice. A badge of 2 over a list holding one row is a badge nobody can
   * clear. `$or` inside one query counts each document once by construction.
   */
  return Task.countDocuments({
    archived: { $ne: true },
    $or: [
      /**
       * WORK I HAVE TO DO — and have not refused.
       *
       * `acceptance` matters because declining does NOT move the row: it sets
       * acceptance to REJECTED and leaves the status at PENDING (taskEngine's
       * decline). Every other reader of an assignee row already skips a
       * refuser — rollUpStatus drops them from the pool, a whole-task move
       * excludes them — so counting them here meant a task you had turned
       * down badged you for ever, and once a co-assignee finished it there was
       * no move left that could clear it. `$ne` also matches a row with no
       * acceptance field at all, so rows written before acceptance existed
       * still count for the person holding them.
       */
      {
        assignees: {
          $elemMatch: {
            user: me,
            status: { $in: open },
            acceptance: { $ne: ACCEPTANCE.REJECTED },
          },
        },
      },

      /**
       * WORK I HAVE TO LOOK AT — which is the APPROVER's, not the setter's.
       *
       * This is the one that was actually wrong rather than merely imprecise.
       * A delegation hands the sign-off on (taskEngine: `task.approver =
       * user._id`, "THE DELEGATOR NOW SIGNS IT OFF") and deliberately leaves
       * `createdBy` alone, and taskAccess.actorRoleOn reads the approver as
       * the assigner for exactly that reason. So on any delegated task the old
       * `createdBy` match badged the original setter — who has no button and
       * was deliberately taken off it — and gave the manager actually holding
       * the submission nothing at all. Precisely the failure the badge exists
       * to prevent.
       *
       * `{ approver: null }` matches a missing field as well as an explicit
       * null, so a task saved before `approver` existed still counts for whoever
       * set it. That is approverOf()'s rule — the approver if one is set,
       * otherwise its setter — written as a query.
       *
       * AND NOT IF I AM ON IT. actorRoleOn answers 'doer' before it answers
       * 'assigner', so somebody who is both an assignee and the approver gets
       * no Approve button; counting it would be a number with nothing behind
       * it.
       */
      {
        status: { $in: handedIn },
        assignees: { $not: { $elemMatch: { user: me } } },
        $and: [{ $or: [{ approver: me }, { approver: null, createdBy: me }] }],
      },
    ],
  });
  /*
   * DELIBERATELY NARROWER THAN canApprove, for two accounts.
   *
   * taskAccess.actorRoleOn also answers assigner to anybody holding
   * tasks.manage (seesEverything), so a SuperAdmin or an HR Manager can in
   * fact approve ANY submission in the company. Measured against the live
   * data, that is the only place this count and the Approve button disagree:
   * 57 of 59 accounts match exactly, and the two that do not are the two
   * tasks.manage holders.
   *
   * That difference is the right way round. A badge says what is waiting on
   * YOU; being able to step into anybody's review is an oversight power, not
   * an inbox. Widening this would put a red number on an HR Manager's top bar
   * for work between two other people that nobody has asked them to touch —
   * the same reason countMyApprovals keeps the personal rung separate from the
   * HR-wide tally. The wide view is the All Tasks tab, which is where somebody
   * looking for other people's work goes.
   */
}

/**
 * DELETE /api/tasks/categories/:id — SuperAdmin only.
 *
 * TWO DIFFERENT DELETES, and which one happens depends on whether anything is
 * filed under it:
 *
 *   NOTHING USES IT   the row is really removed. A category somebody created by
 *                     mistake — "temp", a typo — should disappear, not sit
 *                     deactivated forever occupying its own name in the unique
 *                     index so the right spelling cannot be created.
 *   SOMETHING USES IT  it is DEACTIVATED, and the tasks keep the label they
 *                     were filed under. Wiping `category` off two hundred rows
 *                     to tidy a dropdown is destroying records to fix a list.
 *
 * `?moveTo=<name>` refiles them first, which is the honest way to merge two
 * categories that should always have been one. `?force=1` removes the row even
 * though it is in use, leaving the tasks' label as free text — offered because
 * a SuperAdmin tidying a list knows better than this handler does, but never
 * the default.
 */
const deleteCategory = asyncHandler(async (req, res) => {
  const cat = await TaskCategory.findById(req.params.id);
  if (!cat) bad(res, 'That category is already gone.', 404);

  const moveTo = String(req.query.moveTo || '').trim();
  let moved = 0;

  if (moveTo) {
    if (moveTo === cat.name) bad(res, 'That is the same category.');
    const target = await TaskCategory.findOne({ company: cat.company, name: moveTo })
      .collation({ locale: 'en', strength: 2 });
    if (!target) bad(res, `There is no category called "${moveTo}" to move these into.`);
    const swept = await Task.updateMany({ category: cat.name }, { $set: { category: target.name } });
    moved = swept.modifiedCount || 0;
  }

  const stillUsed = await Task.countDocuments({ category: cat.name, archived: { $ne: true } });
  const force = req.query.force === '1' || req.query.force === 'true';

  if (stillUsed > 0 && !force) {
    // Hidden from every picker and filter, but the tasks keep reading right.
    cat.isActive = false;
    await cat.save();
    return res.json({
      ok: true,
      removed: false,
      hidden: true,
      movedTasks: moved,
      stillUsed,
      message: `Hidden. ${stillUsed} task${stillUsed === 1 ? '' : 's'} stay filed under "${cat.name}".`,
    });
  }

  await TaskCategory.deleteOne({ _id: cat._id });
  res.json({
    ok: true,
    removed: true,
    hidden: false,
    movedTasks: moved,
    stillUsed,
    message: moved
      ? `Removed. ${moved} task${moved === 1 ? '' : 's'} moved to "${moveTo}".`
      : 'Removed.',
  });
});

module.exports = {
  listTasks,
  exportTasks,
  boardTasks,
  taskCounters,
  getTask,
  getChildren,
  taskFeed,
  createTask,
  updateTask,
  changeStatus,
  addUpdate,
  acceptTask,
  declineTask,
  delegateTask,
  // 2026-09-27
  nudgeTask,
  // 2026-09-22
  submitTask,
  approveTask,
  rejectTask,
  setProgress,
  splitTask,
  claimTask,
  transferTask,
  askExtension,
  decideExtension,
  // legacy adapters onto child tasks
  addSubtasks,
  setSubtask,
  removeSubtask,
  deleteTask,
  downloadFile,
  downloadUpdateVoice,
  taskMeta,
  listCategories,
  createCategory,
  renameCategory,
  deleteCategory,
  countMyOpenTasks,
  // shared with the dashboard controller
  buildQuery,
  countersFor,
  decorate,
  parseBody,
  storeFiles,
  storeVoiceNote,
  cleanReminders,
  cleanRepeat,
  cleanLinks,
  buildAssignees,
  personName,
  namesOf,
};
