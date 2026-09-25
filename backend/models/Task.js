const mongoose = require('mongoose');
const {
  KIND_TASK,
  TASK_KINDS,
  STATUS,
  TASK_STATUS,
  ACCEPTANCE,
  ACCEPTANCE_STATES,
  TASK_PRIORITY,
  DEFAULT_PRIORITY,
  LEGACY_PRIORITY_MAP,
  normalisePriority,
  EXTENSION_STATUS,
  EXTENSION_STATES,
  DEFAULT_TASK_POINTS,
  MAX_TASK_POINTS,
  FREQUENCY,
  FREQUENCIES,
  REMINDER_CHANNELS,
  REMINDER_UNITS,
  REMINDER_WHENS,
  EVIDENCE_KINDS,
  LEGACY_STATUS_MAP,
  normaliseStatus,
  isTerminal,
} = require('../config/tasks');
const { stampCode } = require('../services/sequence');

/**
 * A job somebody has been handed, or a question somebody has asked upward.
 *
 * REWRITTEN 2026-09-21 — same collection, same `_id`s, a third of the fields.
 * The version this replaces carried an embedded copy of a workflow definition,
 * a dependency graph, a checklist, custom fields, an evidence contract, a
 * geofence and a per-outcome incentive split. What a task actually needs to do
 * is say who is doing what by when, let them say how it is going, and be
 * counted afterwards. Everything here earns its place against that.
 *
 * WHAT DID NOT CHANGE. `title`, `description`, `assignedTo`, `priority`,
 * `dueDate`, `createdBy`, `company`, `code` and `archived` mean exactly what
 * they did, and `assignees` keeps the same shape for the fields that survived.
 * Removed fields are simply no longer read: nothing drops a column, so an
 * un-migrated row is still a valid document and scripts/migrateTasksV3.js can
 * be run (and re-run) at leisure. The four legacy statuses and the twelve from
 * the last rework are still ACCEPTED on write and normalised on save, so an
 * Android build speaking the old vocabulary keeps working.
 *
 * TWO KINDS, ONE COLLECTION. `kind` is TASK (handed down or across) or REQUEST
 * (asked upward). They share every field, every screen and every query; a
 * request simply earns no points and is excluded from scoring. Splitting them
 * into two collections would have meant two list endpoints, two detail pages
 * and two notification paths to say almost the same thing. See config/tasks.js.
 *
 * THE HEADLINE STATUS IS A ROLL-UP, NEVER TYPED. A task may be on three people.
 * `status` is recomputed from `assignees[].status` on every save: all done →
 * COMPLETED, anybody started → IN_PROGRESS, otherwise PENDING. A cancellation
 * is the one status set directly, because it is the assigner overruling
 * everybody at once.
 */

// ===== Embedded shapes =====

/**
 * One file on the task — hung there by the assigner, or handed back with an
 * update. The BYTES live in GridFS via services/storage.js; this is metadata.
 *
 * `update` points at the TaskUpdate row it arrived with, so the feed can render
 * the file under the remark it came with rather than in a separate pile. Null
 * on the assigner's own attachments, which belong to the task itself.
 */
const attachmentSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    storagePath: { type: String, required: true },
    mimeType: { type: String, trim: true },
    sizeBytes: Number,
    kind: { type: String, enum: EVIDENCE_KINDS, default: 'document' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedByName: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
    update: { type: mongoose.Schema.Types.ObjectId, ref: 'TaskUpdate' },
  },
  { _id: true }
);

/**
 * A recorded explanation.
 *
 * The one feature the brief would not do without: an assigner who can SAY what
 * they mean in ten seconds does not get asked half an hour of questions, and a
 * doer can answer in whatever language they think in. Stored exactly like an
 * attachment (GridFS + metadata) but as its own field rather than one of the
 * files, because a voice note has a player and a duration and is always shown
 * first, and hunting for it inside an attachment array by MIME type is the kind
 * of thing that works until somebody uploads an .mp3 of something else.
 */
const voiceNoteSchema = new mongoose.Schema(
  {
    storagePath: { type: String, required: true },
    mimeType: { type: String, trim: true, default: 'audio/webm' },
    sizeBytes: Number,
    durationMs: Number,
    recordedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    recordedByName: { type: String, trim: true },
    recordedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

/** A link the work needs — a sheet, a drive folder, a ticket. */
const linkSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
  },
  { _id: true }
);

/**
 * One person on the task, and where they have got to.
 *
 * Each carries their OWN status, because a task on three people is three jobs
 * and one of them being finished is worth seeing. Names and codes are
 * snapshots, as everywhere else in this portal: the row has to keep reading
 * correctly after somebody leaves, and leavers are dropped from every picker.
 */
const assigneeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    status: {
      type: String,
      enum: [...TASK_STATUS, ...Object.keys(LEGACY_STATUS_MAP)],
      default: STATUS.PENDING,
    },
    startedAt: Date,
    completedAt: Date,
    /**
     * Did their part land after the deadline? Frozen at the moment they
     * finished, NOT re-derived on read: extending a task afterwards must not
     * retroactively turn a late delivery into a punctual one, and this figure
     * is what the dashboard's In Time / Delayed split counts.
     */
    completedLate: { type: Boolean, default: false },

    /**
     * Have they taken it on? A SEPARATE AXIS from `status` — see
     * config/tasks.ACCEPTANCE for why this is not a fourth status.
     *
     * Starting work implies acceptance (the engine sets it), so nobody is ever
     * chased for an acknowledgement of a job they have already done.
     */
    acceptance: { type: String, enum: ACCEPTANCE_STATES, default: ACCEPTANCE.AWAITING },
    acceptedAt: Date,
    declinedAt: Date,

    /**
     * How far along THIS person says they are, 0-100. Added 2026-09-22.
     *
     * Declared, never inferred — see config/tasks.PROGRESS_MAX. It lives on the
     * assignee row rather than the task because a task on three people has
     * three answers, and averaging them into one stored figure on the task
     * would make it impossible to say whose half was done.
     */
    progress: { type: Number, min: 0, max: 100, default: 0 },
    progressAt: Date,

    /**
     * When they handed it in. The moment `completedLate` is decided — NOT the
     * moment it is approved, which is somebody else's diary. A doer who
     * submitted on the Friday must not become "Delayed" because their manager
     * got to the review on the Monday.
     */
    submittedAt: Date,
    /** Why they said no. Required by the engine — a refusal with no reason
     *  cannot be acted on by the person who has to reassign it. */
    declineReason: { type: String, trim: true, maxlength: 500 },

    /**
     * Who handed it to them, when it arrived by delegation rather than from the
     * assigner. The full trail is `Task.delegations`; this is the one hop, kept
     * on the row so a list can say "via Megha" without a join.
     */
    delegatedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    delegatedFromName: { type: String, trim: true },

    /** The IncentiveCredit their points became, if points were credited. */
    creditRef: { type: mongoose.Schema.Types.ObjectId, ref: 'IncentiveCredit' },
    pointsAwarded: { type: Number, default: 0 },
    pointsAwardedAt: Date,
  },
  { _id: true }
);

/**
 * "I will do it, but not by then."
 *
 * Added 2026-09-22, at the user's request — the third answer a doer needs,
 * after accept and decline. Append-only: the whole list stays on the task, so
 * "this has been put off three times" is answerable from the row rather than
 * from a feed somebody has to read.
 *
 * It is NOT a status. The work carries on while the answer is awaited, which is
 * the entire difference between asking for more time and downing tools.
 *
 * `fromDate` is the deadline AT THE MOMENT OF ASKING, snapshot so the record
 * still reads correctly after the date has moved — without it, a row three
 * extensions deep cannot say what was actually being extended.
 */
const extensionSchema = new mongoose.Schema(
  {
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    requestedByName: { type: String, trim: true },
    requestedAt: { type: Date, default: Date.now },
    fromDate: Date,
    toDate: { type: Date, required: true },
    /** Why. Required by the engine — "more time please" is not a case. */
    reason: { type: String, trim: true, maxlength: 1000 },
    status: { type: String, enum: EXTENSION_STATES, default: EXTENSION_STATUS.PENDING },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedByName: { type: String, trim: true },
    decidedAt: Date,
    decisionNote: { type: String, trim: true, maxlength: 1000 },
  },
  { _id: true }
);

/**
 * One hop of a task changing hands.
 *
 * Append only. The trail matters because the person who was FIRST given the
 * task keeps being notified of everything that happens to it afterwards
 * (`originalAssignees` below) — and when somebody asks why, this is the answer.
 */
const delegationSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    fromName: { type: String, trim: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toName: { type: String, trim: true },
    note: { type: String, trim: true, maxlength: 1000 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * One hop of a task being handed to the person it should have gone to.
 *
 * Append only, like `delegations`, and kept separate from it because the two
 * mean opposite things about who is still answerable — see the `transfers`
 * field below.
 */
const transferSchema = new mongoose.Schema(
  {
    from: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    fromName: { type: String, trim: true },
    to: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toName: { type: String, trim: true },
    /** Who pressed Transfer — not always the person it was taken off. */
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true },
    reason: { type: String, trim: true, maxlength: 1000 },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

/** One reminder rule. The wording and the maths live in config/tasks.js. */
const reminderSchema = new mongoose.Schema(
  {
    channel: { type: String, enum: REMINDER_CHANNELS, default: 'APP' },
    amount: { type: Number, min: 0, default: 1 },
    unit: { type: String, enum: REMINDER_UNITS, default: 'DAYS' },
    when: { type: String, enum: REMINDER_WHENS, default: 'BEFORE' },
  },
  { _id: false }
);

/**
 * How often this repeats.
 *
 * A recurring task's `dueDate` is the deadline of the CURRENT occurrence; the
 * schedule that mints the next one is models/RecurringTask. This block is what
 * the assigner typed, kept on the task so the row can say "Weekly · every Fri"
 * without a join.
 */
const repeatSchema = new mongoose.Schema(
  {
    frequency: { type: String, enum: FREQUENCIES, default: FREQUENCY.ONCE },
    /** For WEEKLY: which days, as `Date.getDay()` indexes (0 = Sunday). */
    weekdays: { type: [Number], default: undefined },
    /** For MONTHLY: which day of the month. 31 lands on the last day of short months. */
    monthDay: Number,
    /** For YEARLY: 1-12 with monthDay. */
    month: Number,
    /** "HH:mm", 24h, in the portal's timezone. The time of day it falls due. */
    time: { type: String, trim: true },
    /** Stop minting occurrences after this. Null = forever. */
    until: Date,
  },
  { _id: false }
);

// ===== The task =====

const taskSchema = new mongoose.Schema(
  {
    // The quotable reference — TSK-2026-00042 — minted once from the atomic
    // counter (services/sequence) so two created in the same second cannot
    // collide. Never rewritten: a code quoted in an email keeps pointing here.
    code: { type: String, trim: true, unique: true, sparse: true },

    kind: { type: String, enum: TASK_KINDS, default: KIND_TASK, index: true },

    title: { type: String, required: true, trim: true, maxlength: 300 },
    description: { type: String, trim: true, maxlength: 5000 },

    // The department or project this belongs under. Free text against
    // models/TaskCategory, which anybody can add to from the assign form —
    // "create as many categories according to your business".
    category: { type: String, trim: true, index: true },

    // The company wall's field, snapshot from the assigner on save so a list
    // query never has to join through EmployeeProfile. See utils/employeeScope.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },

    // ===== People =====
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    createdByName: { type: String, trim: true },

    /**
     * WHO SIGNS THE WORK OFF. Defaults to whoever set it.
     *
     * Added 2026-09-22 (fourth pass), and it exists for one sentence of the
     * brief: *"for delegate who is doing delegate he should be the approvar for
     * that chain"*.
     *
     * When a CEO hands a task to a manager and the manager delegates it on, the
     * CEO should not be the one reading the junior's submission — they asked
     * the manager for a report, not for a queue. So delegating MOVES the
     * approval to the delegator, and each hop moves it again: whoever handed
     * the work to you is the person you answer to.
     *
     * It is a field of its own rather than a rewrite of `createdBy`, because
     * `createdBy` is also "who set this", which the delegator did not do and
     * which the feed, the Delegated tab and the audit trail all still need to
     * be true. Both count as an assigner for permissions
     * (services/taskAccess.actorRoleOn); only this one is notified when
     * something lands in the tray.
     */
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    approverName: { type: String, trim: true },
    // The primary assignee — assignees[0]. Maintained by this model, and the
    // field every legacy query, the calendar and the company wall still read.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    assignees: { type: [assigneeSchema], default: [] },
    // "Keep in loop" — a junior's manager, who sees the task and hears about
    // every move on it without being answerable for any of it.
    loopUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],

    /**
     * WHO FIRST GOT THIS, whatever has happened to it since.
     *
     * Stamped once, on creation, and never rewritten. When somebody delegates a
     * task onward they drop out of `assignees` — but the user's rule is that
     * "the user who got the task in the beginning will receive notification for
     * every update", so this is the list every notification adds on top of its
     * own audience (services/taskNotify.recipients).
     *
     * It is NOT the same as `loopUsers`: the loop is a choice the assigner made
     * and can undo, this is a fact about the task's history and cannot be.
     * Keeping them apart is what stops "take Megha off the loop" also silencing
     * the person who originally owned the job.
     */
    originalAssignees: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    /**
     * SET ON SOMEBODY ELSE'S BEHALF (2026-09-25). `createdBy` is the person
     * the task is FROM — they approve it and it is theirs to edit — and this is
     * who actually typed it in, and when. Only somebody holding
     * User.taskProxyAccess can write it (taskController.createTask). They can
     * see the task, it sits in their "Assigned by me", and they hear every
     * update (taskNotify.followers) — but it is not theirs to approve or edit.
     * Absent on every task set the ordinary way.
     */
    onBehalf: {
      by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
      byName: { type: String, trim: true },
      at: Date,
    },

    // ===== Splitting it up =====
    /**
     * THE TASK THIS IS A PIECE OF. Null on a task in its own right.
     *
     * REWORKED 2026-09-22. A piece used to be an embedded row on the parent
     * (`subtasks[]`): a title, an optional owner and a tick. The brief this
     * replaces asks a piece to do everything a task does —
     *
     *   *"manager can divide that task into multiple subtask and assign that to
     *    their team member per subtask … they can do the point distribution to
     *    those task … by default it will be divided equally"*
     *
     * — so a piece now carries its own points, deadline, priority, progress,
     * acceptance, submission and feed, appears in its owner's own task list,
     * and can itself be split. Every one of those is a field a Task already
     * has; keeping pieces embedded would have meant growing the embedded row
     * into a second, worse Task and duplicating the engine to drive it.
     *
     * The property that was traded away is "a task page is ONE query". It now
     * costs two — the task, and its pieces. That is the whole cost, and it buys
     * a piece being a real job somebody can be handed.
     *
     * The old array is GONE rather than deprecated: there were zero embedded
     * subtasks in the live data when this landed, so there was nothing to keep
     * it for. `GET /:id` still SERIALISES a `subtasks` array derived from the
     * children, and the three old endpoints still work as adapters, so an
     * Android build that has not been updated keeps running (see
     * controllers/taskController).
     */
    parentTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true },
    /** Snapshots, so a piece can say "part of TSK-2026-00058" without a join. */
    parentCode: { type: String, trim: true },
    parentTitle: { type: String, trim: true },
    /** 0 for a task, 1 for its pieces, 2 for theirs. Capped at MAX_SPLIT_DEPTH. */
    depth: { type: Number, default: 0, min: 0 },

    /**
     * WHO MAY PICK THIS UP, on a piece nobody has been named for.
     *
     * The brief's *"or all subtask to some team member they can pick the
     * task"*. A piece with no assignee is offered rather than given: everybody
     * in this list sees it in their own list under "Open to pick up" and any
     * one of them can claim it, which makes them its sole assignee.
     *
     * It is an explicit list rather than "anybody on the parent" — the parent
     * is usually on one person (the manager doing the splitting), so "anybody
     * on the parent" would offer the piece to nobody at all. It defaults to the
     * splitter's own direct reports.
     */
    openTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],

    /**
     * The pieces, as counters. Maintained by services/taskEngine.recomputeParent
     * on every change to a child, so a LIST row can say "3 of 5 done" without
     * a second query per row — which at fifty rows a page is fifty queries.
     */
    childCount: { type: Number, default: 0 },
    childDoneCount: { type: Number, default: 0 },
    /**
     * Σ of the live pieces' points. `points − distributedPoints` is what each
     * person on THIS task earns — see the `points` field below.
     */
    distributedPoints: { type: Number, default: 0, min: 0 },

    /** The append-only trail of the task changing hands. */
    delegations: { type: [delegationSchema], default: [] },

    /**
     * THE TRAIL OF A TASK THAT WENT TO THE WRONG PERSON.
     *
     * Added 2026-09-22 (fourth pass): *"for Transfer if the task is assigned to
     * wrong user then they can transfer to anyone and it will be fully
     * transferred to the new user"*.
     *
     * A transfer is NOT a delegation and the difference is the whole reason
     * both exist:
     *
     *   delegate   I still own the outcome. I stay in the loop, I become the
     *              approver, and the trail says the work passed through me.
     *   transfer   it was never mine. I drop out completely — out of
     *              `assignees`, out of `originalAssignees`, out of the loop —
     *              and the new person holds it as if it had been theirs from
     *              the start.
     *
     * That second one is the ONE place `originalAssignees` is rewritten, and
     * this array is why that is safe: the history is not lost, it simply stops
     * generating notifications for somebody who never had the job. Leaving a
     * mis-assigned person on every future update of a task that was never
     * theirs is how people learn to ignore the bell.
     */
    transfers: { type: [transferSchema], default: [] },

    // ===== State =====
    status: {
      type: String,
      enum: [...TASK_STATUS, ...Object.keys(LEGACY_STATUS_MAP)],
      default: STATUS.PENDING,
      index: true,
    },
    priority: {
      type: String,
      // The legacy words are ACCEPTED on write and normalised by the hook, the
      // same bargain `status` makes: a row an old client wrote is still a valid
      // document, and 50 of the 59 live rows carried `Urgent` before the picker
      // offered it.
      enum: [...TASK_PRIORITY, ...Object.keys(LEGACY_PRIORITY_MAP)],
      default: DEFAULT_PRIORITY,
      index: true,
    },

    /**
     * How far along, 0-100 — the roll-up of `assignees[].progress`, or of the
     * PIECES when this task has any. Never typed directly on the task itself;
     * see services/taskEngine.recomputeParent and the hook below.
     */
    progress: { type: Number, min: 0, max: 100, default: 0 },

    /**
     * MUST THE ASSIGNER SEE IT BEFORE IT COUNTS AS DONE? Default yes.
     *
     * The brief: *"when user submit any task then manager should have the
     * option to approve that and on reject that submission the task will reopen
     * again"*. On by default because that is what was asked for; a checkbox
     * rather than a hard rule because plenty of work does not need a second
     * pair of eyes, and forcing every "call the printer" through a review queue
     * is how a review queue starts getting rubber-stamped.
     *
     * When it is on, a doer's Complete lands on SUBMITTED instead
     * (config/tasks.effectiveTarget). It never applies to the person who SET
     * the task, and never to a REQUEST.
     */
    requiresApproval: { type: Boolean, default: true },
    /** When the last person handed it in. Cleared when it is sent back. */
    submittedAt: Date,
    /** How many times a submission has been sent back. Shown on the row. */
    rejectionCount: { type: Number, default: 0 },

    /**
     * What this is worth, in points, to EACH person on it.
     *
     * One figure, no hidden arithmetic: "this task is worth 100 points" reads
     * the same whether it is on one person or four, and an assigner who wants
     * a four-way split types 25. Points are the portal's single company-wide
     * currency (models/IncentiveCredit, valued by Setting.incentive
     * .rupeePerPoint), so the figure means the same here as it does in the
     * rolling and billing incentives.
     *
     * A REQUEST always carries 0 — asking your manager for a file is not work
     * you have done (see the pre-validate hook).
     *
     * ── ONCE IT IS SPLIT, THIS FIGURE IS A POOL (2026-09-22) ─────────────────
     *
     * The brief: *"if manager is delegating any task as subtask to team member
     * they can do the point distribution to those task, by default it will be
     * divided equally"*. So splitting a task does not mint new points, it hands
     * out the ones it already had:
     *
     *     each person on THIS task earns   points − distributedPoints
     *     each person on a PIECE earns     that piece's own points
     *
     * A manager who splits 100 points three ways keeps nothing, which is the
     * default and is honest — they did not do the work. A manager who hands out
     * 60 keeps 40 for holding it together, and the form says so while they
     * type. The server refuses a distribution larger than the pool, because
     * points settle in rupees (services/taskPoints) and "subtasks" would
     * otherwise be a way to mint money.
     */
    points: { type: Number, min: 0, max: MAX_TASK_POINTS, default: DEFAULT_TASK_POINTS },

    // ===== Dates =====
    startDate: Date,
    dueDate: { type: Date, index: true },
    // What the deadline was when the task was set, kept when somebody moves it
    // so "this was extended twice" is answerable from the row.
    originalDueDate: Date,
    extensionCount: { type: Number, default: 0 },
    /** Every time more time was asked for, and what was said. Append only. */
    extensions: { type: [extensionSchema], default: [] },
    assignedAt: { type: Date, default: Date.now },
    startedAt: Date,
    completedAt: Date,
    /** The roll-up of assignees[].completedLate — see that field's note. */
    completedLate: { type: Boolean, default: false },

    // ===== Content =====
    voiceNote: { type: voiceNoteSchema, default: undefined },
    attachments: { type: [attachmentSchema], default: [] },
    links: { type: [linkSchema], default: [] },

    // ===== Chasing =====
    reminders: { type: [reminderSchema], default: [] },
    /**
     * Which reminder rules have already fired, as `config/tasks.reminderKey`
     * strings. The worker's idempotence lives here — a restart must not replay
     * a day of notifications at somebody, which is exactly the trap the
     * attendance push worker hit and had to be fixed for.
     */
    firedReminders: { type: [String], default: [] },

    // ===== Recurrence =====
    repeat: { type: repeatSchema, default: () => ({ frequency: FREQUENCY.ONCE }) },
    recurringTask: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringTask', index: true },
    // The occurrence this instance is for, as an IST day key. The generator's
    // idempotence key: a worker restart cannot mint the same day twice.
    occurrenceKey: { type: String, trim: true },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'TaskTemplate' },

    // ===== Requests =====
    // The task this request is about, when it was raised from one ("I need the
    // April figures to finish T-9109"). Null on a standalone ask.
    linkedTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true },

    // ===== Bookkeeping =====
    updateCount: { type: Number, default: 0 },
    // Why it was cancelled or reopened. On the row, so a list can say it
    // without opening the feed.
    stateNote: { type: String, trim: true, maxlength: 1000 },
    archived: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// ===== Indexes =====
// The compounds behind the five lists this module has, and nothing else: an
// index nobody queries is a write nobody needed.
taskSchema.index({ assignedTo: 1, status: 1, dueDate: 1 });   // "my open tasks, soonest first"
taskSchema.index({ 'assignees.user': 1, status: 1, dueDate: 1 }); // the same for a co-assignee
taskSchema.index({ createdBy: 1, status: 1, dueDate: 1 });    // "what I delegated"
taskSchema.index({ company: 1, kind: 1, status: 1, dueDate: 1 }); // every walled admin list
taskSchema.index({ status: 1, dueDate: 1 });                  // the overdue sweep
taskSchema.index({ loopUsers: 1, status: 1 });                // "tasks I am kept in loop on"
// "the pieces of this task" — read on every parent's detail page, and by
// recomputeParent after every single change to a child.
taskSchema.index({ parentTask: 1, status: 1 });
// A piece nobody has been named for, in the list of everybody it is offered to.
taskSchema.index({ openTo: 1, status: 1 });
// …and so does "what was originally mine", which is how a delegator keeps
// finding the work they handed on.
taskSchema.index({ originalAssignees: 1, status: 1 });
taskSchema.index({ recurringTask: 1, occurrenceKey: 1 }, { unique: true, sparse: true });
taskSchema.index({ title: 'text', description: 'text', code: 'text' });

// ===== Hooks =====

/**
 * NORMALISE ON READ, not only on save.
 *
 * ADDED 2026-09-22, and it is the fix for a whole class of breakage rather than
 * one bug. The schema deliberately ACCEPTS the legacy words so an un-migrated
 * row is still a valid document and an old Android build can still write one —
 * but normalisation lived only in pre('validate'), which runs on SAVE. A
 * document READ BACK from Mongo therefore kept whatever word it was written
 * with, and 51 of the 61 live rows say `ASSIGNED`, `Done` or `REJECTED`.
 *
 * Everything that keys off the status then quietly failed on those rows:
 *
 *   services/taskEngine.move   TRANSITIONS['ASSIGNED'] is undefined, so EVERY
 *                              status move was refused with a 400 reading
 *                              "A assigned task cannot be marked in review."
 *   taskAccess.capabilitiesFor `can.transitions` came back empty, so the
 *                              clients — which draw exactly what the server
 *                              says — offered no buttons at all.
 *
 * `post('init')` fires once, as the document is hydrated, before any caller
 * sees it. It does NOT fire for `.lean()` queries (there is no document to
 * hook), so the list path normalises in `decorate()` and the aggregations use
 * `config/tasks.normaliseStatusStage` — the three together cover every read.
 *
 * The raw word is kept on `$locals` because ONE caller still needs it: the
 * engine's optimistic claim matches on the stored value, and comparing a
 * normalised status against an un-migrated row would match nothing and report
 * a phantom conflict.
 */
taskSchema.post('init', function normaliseOnRead() {
  this.$locals.rawStatus = this.status;
  const norm = normaliseStatus(this.status);
  if (norm && norm !== this.status) this.status = norm;
  for (const a of this.assignees || []) {
    const an = normaliseStatus(a.status);
    if (an && an !== a.status) a.status = an;
  }
  const np = normalisePriority(this.priority);
  if (np && np !== this.priority) this.priority = np;
});

taskSchema.pre('validate', function normalise(next) {
  // Accept whatever vocabulary came in — see config/tasks.normaliseStatus.
  const norm = normaliseStatus(this.status);
  if (norm) this.status = norm;
  for (const a of this.assignees || []) {
    const an = normaliseStatus(a.status);
    if (an) a.status = an;
  }

  // The same bargain for priority: `High` written by any client, or sitting in
  // a row nobody has migrated, comes out as `Urgent` (config/tasks, 2026-09-22).
  const np = normalisePriority(this.priority);
  this.priority = np || DEFAULT_PRIORITY;

  // A request is an ask, not work: it never carries points and never scores —
  // and nothing can be distributed out of nothing.
  if (this.kind !== KIND_TASK) {
    this.points = 0;
    this.distributedPoints = 0;
    // Nobody reviews an answer to a question. A request is answered, full stop.
    this.requiresApproval = false;
  }

  // Never hand out more than there is. The engine checks this too and returns a
  // sentence a person can act on; this is the backstop that means no code path
  // anywhere can leave the pool overdrawn.
  const pool = Number(this.points) || 0;
  if ((this.distributedPoints || 0) > pool) this.distributedPoints = pool;

  // The primary assignee IS the first one on the list. Kept in step here
  // rather than at each call site, because every path that touches the array
  // would otherwise have to remember.
  if (this.assignees?.length) {
    this.assignedTo = this.assignees[0].user;
  } else if (this.assignedTo) {
    // A task written by an older client that only knows `assignedTo`.
    this.assignees = [{ user: this.assignedTo, status: this.status || STATUS.PENDING }];
  }

  if (this.dueDate && !this.originalDueDate) this.originalDueDate = this.dueDate;

  // Whoever set it signs it off, until somebody delegates it and takes that on.
  if (!this.approver && this.createdBy) {
    this.approver = this.createdBy;
    this.approverName = this.createdByName;
  }

  // Stamped ONCE, on the first save, and never rewritten — see the field's own
  // note. `isNew` rather than "is it empty", because a task whose original
  // assignees have all since delegated away would otherwise be re-stamped with
  // whoever holds it now, silently rewriting exactly the history it exists to
  // keep.
  if (this.isNew && !this.originalAssignees?.length) {
    this.originalAssignees = (this.assignees || []).map((a) => a.user).filter(Boolean);
  }

  next();
});

taskSchema.pre('validate', function rollUpStatus(next) {
  // CANCELLED is the assigner overruling everybody — never derived away.
  if (this.status === STATUS.CANCELLED) return next();

  const people = this.assignees || [];
  if (!people.length) return next();

  // Somebody who has been taken off it, or who DECLINED it, must not hold the
  // roll-up open: a five-person task where one person said no and the other
  // four finished is a finished task, and leaving it IN_PROGRESS for ever is
  // how a list fills with work nobody is doing. A fully-declined task falls
  // back to the whole list and lands on PENDING, which is right — it is still
  // owed, and `config/tasks.isDeclined` is what says so on screen.
  const live = people.filter(
    (a) => a.status !== STATUS.CANCELLED && a.acceptance !== ACCEPTANCE.REJECTED
  );
  const pool = live.length ? live : people;

  const started = (a) => a.status === STATUS.IN_PROGRESS
    || a.status === STATUS.SUBMITTED
    || a.status === STATUS.COMPLETED;

  if (pool.every((a) => a.status === STATUS.COMPLETED)) {
    this.status = STATUS.COMPLETED;
    // The task finished when its LAST person did.
    const times = pool.map((a) => a.completedAt).filter(Boolean).map((d) => new Date(d).getTime());
    this.completedAt = times.length ? new Date(Math.max(...times)) : (this.completedAt || new Date());
    // Late if ANYBODY was late. One person delivering on time does not make a
    // task that was waiting a week on somebody else punctual.
    this.completedLate = pool.some((a) => a.completedLate);
  } else if (pool.every((a) => a.status === STATUS.SUBMITTED || a.status === STATUS.COMPLETED)) {
    // EVERYBODY has handed in what they owe and at least one of them is waiting
    // on a word. The task is on the reviewer's desk, not anybody's to-do list —
    // which is precisely the distinction the fourth state was added to make.
    // It takes EVERY row, not any: one person still typing means the task is
    // still being worked on, however much of it is already in the tray.
    this.status = STATUS.SUBMITTED;
    this.completedAt = undefined;
    this.completedLate = false;
    const subs = pool.map((a) => a.submittedAt).filter(Boolean).map((d) => new Date(d).getTime());
    if (subs.length) this.submittedAt = new Date(Math.max(...subs));
  } else if (pool.some(started)) {
    this.status = STATUS.IN_PROGRESS;
    this.completedAt = undefined;
    this.completedLate = false;
    if (!this.startedAt) {
      const starts = pool.map((a) => a.startedAt).filter(Boolean).map((d) => new Date(d).getTime());
      if (starts.length) this.startedAt = new Date(Math.min(...starts));
    }
  } else {
    this.status = STATUS.PENDING;
    this.completedAt = undefined;
    this.completedLate = false;
  }

  /**
   * …and the progress bar, from the same pool.
   *
   * A task WITH PIECES is left alone here: its figure is the points-weighted
   * mean of its children and only `services/taskEngine.recomputeParent` can see
   * them. Overwriting it from the assignee rows — which on a fully-delegated
   * task are one person sitting at 0 — would reset a 70%-done job to zero every
   * time anything else on it was saved.
   */
  if (!this.childCount) {
    const pct = (a) => (a.status === STATUS.COMPLETED || a.status === STATUS.SUBMITTED
      ? 100
      : Math.min(100, Math.max(0, Number(a.progress) || 0)));
    this.progress = Math.round(pool.reduce((s, a) => s + pct(a), 0) / pool.length);
  }
  next();
});

// TSK-YYYY-NNNNN, from the same counter the voucher and expense codes use.
taskSchema.pre('save', stampCode('TSK', 'createdAt'));

// ===== Helpers =====
// Instance methods rather than free functions because every caller has the
// document in hand, and `task.isDoer(user)` is the sentence the guard wants.

/** Is this user one of the people the task is on? */
taskSchema.methods.isDoer = function isDoer(userId) {
  const id = String(userId || '');
  return (this.assignees || []).some((a) => String(a.user?._id || a.user) === id);
};

/** Did this user set it? (An admin is treated as an assigner by taskAccess.) */
taskSchema.methods.isAssigner = function isAssigner(userId) {
  return String(this.createdBy?._id || this.createdBy || '') === String(userId || '');
};

/** This user's own row on the task, or null. */
taskSchema.methods.assigneeFor = function assigneeFor(userId) {
  const id = String(userId || '');
  return (this.assignees || []).find((a) => String(a.user?._id || a.user) === id) || null;
};

/** Everyone who should hear about a move on this task. */
/**
 * Everyone who should hear about a move on this task.
 *
 * FIVE groups, and the last two are the ones that are easy to forget:
 *   the assigner · the people on it · the loop ·
 *   whoever FIRST had it (they keep hearing about it after delegating — the
 *   user's rule) · anybody who owns a subtask but is not otherwise on the task.
 */
taskSchema.methods.audience = function audience() {
  const ids = new Set();
  if (this.createdBy) ids.add(String(this.createdBy._id || this.createdBy));
  if (this.approver) ids.add(String(this.approver._id || this.approver));
  for (const a of this.assignees || []) ids.add(String(a.user?._id || a.user));
  for (const u of this.loopUsers || []) ids.add(String(u._id || u));
  for (const u of this.originalAssignees || []) ids.add(String(u._id || u));
  // Not `onBehalf.by`: whoever set it in somebody else's name keeps nothing of
  // it (services/taskAccess.visibleFilter, user decision 2026-09-25).
  return [...ids].filter(Boolean);
};

/**
 * WHAT EACH PERSON ON THIS ROW ACTUALLY EARNS.
 *
 * The pool less whatever has been handed down to the pieces. Read by
 * services/taskPoints at the moment of completion, by every dashboard, and by
 * the split form so it can say how much is left to give away.
 */
taskSchema.methods.effectivePoints = function effectivePoints() {
  return Math.max(0, (Number(this.points) || 0) - (Number(this.distributedPoints) || 0));
};

/** The request for more time that is still waiting on an answer, or null. */
taskSchema.methods.pendingExtension = function pendingExtension() {
  return (this.extensions || []).find((e) => e.status === EXTENSION_STATUS.PENDING) || null;
};

/** This person's own un-answered request for more time, or null. */
taskSchema.methods.pendingExtensionBy = function pendingExtensionBy(userId) {
  const id = String(userId || '');
  return (this.extensions || []).find(
    (e) => e.status === EXTENSION_STATUS.PENDING && String(e.requestedBy?._id || e.requestedBy) === id
  ) || null;
};

/** Is this a piece of something bigger? */
taskSchema.methods.isPiece = function isPiece() {
  return Boolean(this.parentTask);
};

/** A piece nobody has been named for — anybody in `openTo` may claim it. */
taskSchema.methods.isOpenPiece = function isOpenPiece() {
  return Boolean(this.parentTask) && !(this.assignees || []).length;
};

taskSchema.methods.isTerminal = function terminal() {
  return isTerminal(this.status);
};

module.exports = mongoose.model('Task', taskSchema);
