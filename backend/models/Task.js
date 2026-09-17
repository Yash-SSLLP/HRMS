const mongoose = require('mongoose');
const {
  TASK_STATUS,
  TASK_PRIORITY,
  LEGACY_STATUS_MAP,
  ASSIGNEE_ROLES,
  REQUIREMENT_KEYS,
  EVIDENCE_KINDS,
  LOCATION_EVENTS,
  GEOFENCE_RULES,
  DEPENDENCY_KINDS,
  INCENTIVE_OUTCOMES,
  DEFAULT_INCENTIVE_SPLIT,
  normaliseStatus,
  isTerminal,
} = require('../config/taskWorkflow');
const { stampCode } = require('../services/sequence');

/**
 * A unit of work somebody is answerable for.
 *
 * This is the central document of the Task & Workflow module. It carries the
 * work itself, everyone involved in it, what it insists on before it may be
 * handed back, and — frozen onto the row — the workflow it is running. The
 * things that GROW without bound hang off it in their own collections:
 * submissions, time entries, comments, the activity trail, extensions and the
 * incentive. Everything bounded and always read with the task is embedded here,
 * because a task detail page should be one query and not eight.
 *
 * WHAT DID NOT CHANGE, and why it matters. This is the SAME collection the
 * module used before the 2026-09-17 rework, with the same `_id`s: 57 live tasks
 * were sitting on it, 51 of them an open "Documents Submission" handed to the
 * whole company. `title`, `description`, `project`, `assignedTo`, `priority`,
 * `dueDate` and `createdBy` all mean exactly what they used to. Everything new
 * is additive with a default, so an un-migrated row is a valid document, and the
 * four old statuses are still accepted (see `status` below). The Android app,
 * which speaks the old vocabulary until it is updated, keeps working against it.
 * See scripts/migrateTasksV2.js.
 *
 * MULTI-ASSIGNEE, AND THE FIELD THAT SURVIVED IT. A task may now have several
 * people on it, each with their own part, deadline, status and evidence
 * (`assignees` below, section 4 of the spec). `assignedTo` is kept as the
 * PRIMARY assignee and is maintained by the model itself — it is what every
 * existing query, the mobile app and the company wall
 * (utils/employeeScope.scopeUserField) read, and rewriting all of them to
 * understand an array was a bigger change than keeping one field honest.
 *
 * PROGRESS IS DERIVED, NEVER TYPED. `progress` is recomputed on every save from
 * whichever source the task is configured to use — its subtasks, its checklist,
 * or its assignees' own figures. A number somebody typed and then forgot is
 * worse than no number.
 */

// ===== Embedded shapes =====

/**
 * Where somebody was when they did something (section 15).
 *
 * Deliberately the same shape as Attendance's punch location, so the two read
 * identically on a map and `utils/geo.haversineMeters` measures both. `address`
 * is whatever the client could resolve and is never trusted for anything —
 * distance is always computed from the coordinates.
 */
const taskLocationSchema = new mongoose.Schema(
  {
    lat: Number,
    lng: Number,
    accuracy: Number,
    address: { type: String, trim: true },
    // Stamped by the SERVER, not the client (section 37). A device clock is not
    // evidence of when anything happened.
    at: { type: Date, default: Date.now },
    // Metres from the geofence centre this was measured against, and whether
    // that put the person inside it. Frozen at capture time: the site's pin or
    // radius may be edited later, and this has to keep saying what was true.
    distanceM: Number,
    insideFence: Boolean,
    workLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkLocation' },
  },
  { _id: false }
);

/**
 * One file hung on the task itself (as opposed to on a submission).
 *
 * The BYTES live in GridFS via services/storage.js — this is metadata only, the
 * same bargain Document and Expense make. `sha256` is what lets a duplicate
 * upload be recognised rather than stored twice.
 */
const taskAttachmentSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true },
    storagePath: { type: String, required: true },
    mimeType: { type: String, trim: true },
    sizeBytes: Number,
    sha256: { type: String, trim: true },
    kind: { type: String, enum: EVIDENCE_KINDS, default: 'document' },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedByName: { type: String, trim: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * One person on the task, and their own part of it (section 4).
 *
 * The spec's example is an Annual Employee Meet where HR does the venue,
 * Finance the budget and Admin the logistics — four people on one task who are
 * emphatically not four copies of the same job. So each of them carries their
 * own responsibility, deadline, status, progress and submission, and the task's
 * headline status is the roll-up (see `recomputeProgress`).
 */
const taskAssigneeSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    // Snapshot, for the same reason IncentiveEntry snapshots its members: a task
    // from six months ago has to keep reading correctly after somebody leaves,
    // and leavers are deliberately dropped from every people picker.
    name: { type: String, trim: true },
    employeeCode: { type: String, trim: true },
    // What they are here to do. 'Owner' is the primary — there is exactly one,
    // and it is the person `assignedTo` mirrors.
    role: { type: String, enum: ASSIGNEE_ROLES, default: 'Contributor' },
    // The part of the work that is theirs, in words. "Venue", "Budget".
    responsibility: { type: String, trim: true, maxlength: 300 },
    // Their own deadline, when it differs from the task's. Null = the task's.
    dueDate: Date,
    status: {
      type: String,
      enum: [...TASK_STATUS, ...Object.keys(LEGACY_STATUS_MAP)],
      default: 'ASSIGNED',
    },
    progress: { type: Number, min: 0, max: 100, default: 0 },
    acceptedAt: Date,
    declinedAt: Date,
    declineReason: { type: String, trim: true, maxlength: 500 },
    startedAt: Date,
    submittedAt: Date,
    completedAt: Date,
    // Minutes this person has logged against the task, rolled up from
    // TaskTimeEntry so the assignee list does not need a second query to show
    // it. Recomputed by the time-entry service, never typed.
    minutesLogged: { type: Number, default: 0 },
    // Their latest submission (TaskSubmission). Earlier ones are not lost — the
    // collection keeps every attempt — this is just the current one.
    latestSubmission: { type: mongoose.Schema.Types.ObjectId, ref: 'TaskSubmission' },
    submissionCount: { type: Number, default: 0 },
    // May this person earn the task's incentive? Off for an Observer by
    // default; a manager can withhold it from anyone.
    incentiveEligible: { type: Boolean, default: true },
  },
  { _id: true }
);

/** One line of a task's checklist (section 18). */
const checklistItemSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 300 },
    done: { type: Boolean, default: false },
    // Mandatory items block submission when the task requires its checklist.
    // Optional ones are a prompt, not a gate.
    mandatory: { type: Boolean, default: true },
    // A checklist item can belong to one person on a multi-assignee task, and
    // can carry its own deadline and evidence requirement.
    assignee: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    dueDate: Date,
    requiresEvidence: { type: Boolean, default: false },
    evidence: [taskAttachmentSchema],
    doneBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    doneByName: { type: String, trim: true },
    doneAt: Date,
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

/**
 * One step of the workflow this task is running — a FROZEN COPY, not a pointer.
 *
 * Section 7 requires that editing a workflow must not retroactively change tasks
 * already running on it, and section 53 that "the workflow version used by an
 * existing task must remain immutable". A reference to WorkflowVersion would
 * satisfy that only as long as nobody ever edited a published version; copying
 * the steps onto the task satisfies it by construction. The task also then
 * renders its own progress with no second query, which is what the detail page
 * spends most of its time doing.
 *
 * `workflowRef` and `workflowVersion` are still stored on the task, for
 * reporting ("how is this workflow performing?"), not for execution.
 */
const workflowStepSchema = new mongoose.Schema(
  {
    // Stable within the workflow version — how transitions name their targets.
    key: { type: String, required: true, trim: true },
    name: { type: String, trim: true },
    type: { type: String, trim: true, default: 'approval' },
    order: { type: Number, default: 0 },
    // The parallel group this step belongs to, when it is inside one. Steps
    // sharing a group run at the same time.
    parallelGroup: { type: String, trim: true, default: null },
    // 'all' | 'any' | 'majority' — how the group decides it is done.
    join: { type: String, trim: true, default: 'all' },
    // Who acts at this step. Resolved when the step OPENS rather than when the
    // task is created, so a reporting line that changes mid-task is honoured —
    // except for the resolved ids below, which are frozen once it opens.
    assigneeRule: {
      // 'user' | 'role' | 'permission' | 'supervisor' | 'manager' | 'reportingManager' | 'hrPartner' | 'creator'
      kind: { type: String, trim: true, default: 'user' },
      users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      roles: [String],
      permission: { type: String, trim: true },
      department: { type: String, trim: true },
    },
    // Frozen at open time — who this step is actually waiting on.
    actors: [{
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      name: { type: String, trim: true },
      decision: { type: String, trim: true, default: null }, // 'approved' | 'rejected' | 'done'
      note: { type: String, trim: true, maxlength: 1000 },
      decidedAt: Date,
    }],
    // Waiting → not its turn; Pending → open, awaiting its actors;
    // Approved/Rejected/Done → decided; Skipped → a branch bypassed it.
    status: { type: String, trim: true, default: 'Waiting' },
    optional: { type: Boolean, default: false },
    // Hours from the step opening before it is overdue and the escalation
    // ladder starts. Null = no clock on this step.
    slaHours: Number,
    openedAt: Date,
    dueAt: Date,
    completedAt: Date,
    // A 'condition' step: where to go when the test passes and when it fails.
    condition: {
      field: { type: String, trim: true },
      operator: { type: String, trim: true },
      value: mongoose.Schema.Types.Mixed,
      onTrue: { type: String, trim: true },
      onFalse: { type: String, trim: true },
    },
    // A 'wait' step holds for this long before advancing itself.
    waitMinutes: Number,
    // Where to go next when this step is done and it is not a condition. Null =
    // the next step by `order`.
    next: { type: String, trim: true, default: null },
    // What a rejection at this step means: 'sendBack' returns the task to its
    // assignees, 'previousStep' reopens the step before, 'fail' ends the task.
    onReject: { type: String, trim: true, default: 'sendBack' },
  },
  { _id: true }
);

/** A link to another task (section 9). */
const dependencySchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', required: true },
    kind: { type: String, enum: DEPENDENCY_KINDS, default: 'blockedBy' },
    // A blocking dependency is satisfied when the other task reaches this
    // status. Defaults to COMPLETED; a chain that only needs approval can say so.
    satisfiedBy: { type: String, default: 'COMPLETED' },
  },
  { _id: false }
);

/** A field the admin invented for a task type (section 32). */
const customFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, trim: true },
    // 'text' | 'number' | 'date' | 'select' | 'boolean' | 'employee' | 'asset'
    type: { type: String, trim: true, default: 'text' },
    value: mongoose.Schema.Types.Mixed,
    required: { type: Boolean, default: false },
    options: [String],
  },
  { _id: false }
);

// ===== The task =====

const taskSchema = new mongoose.Schema(
  {
    // The quotable reference — TSK-2026-00042. Minted once on first save from
    // the same atomic counter the voucher and expense codes use
    // (services/sequence.js), so two tasks created in the same second can never
    // share one. Never rewritten: a code quoted in an email must keep pointing
    // at the same row. Sparse-unique, because the 57 rows that predate this
    // rework have none until the migration backfills them.
    code: { type: String, trim: true, unique: true, sparse: true },

    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    // ===== Classification =====
    // Free text against the managed list (OrgMaster), not an enum: section 32
    // requires admins to define their own task types without a schema change.
    taskType: { type: String, trim: true, default: 'General' },
    category: { type: String, trim: true },
    department: { type: String, trim: true, index: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', index: true },
    // The company wall's own field. Snapshot from the primary assignee's profile
    // on save, so a task can be scoped without joining through EmployeeProfile
    // on every list query. See utils/employeeScope.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
    tags: [{ type: String, trim: true }],
    customFields: [customFieldSchema],

    // ===== People =====
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // The primary assignee. Maintained by this model from `assignees` — see the
    // docblock. Still the field every legacy query and the mobile app read.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    assignees: [taskAssigneeSchema],
    // Watches the work and reviews it. The first rung of the escalation ladder.
    supervisor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // Above the supervisor. The second rung.
    manager: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    // People who see the task and are notified, without being answerable for it.
    watchers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // ===== State =====
    // The four legacy words are still valid values so an un-migrated row is a
    // valid document and an older mobile build can still write one. Every write
    // path normalises through config/taskWorkflow.normaliseStatus (and the
    // pre-validate hook below), so nothing NEW is ever stored in the old
    // vocabulary — the migration converts what is already there.
    status: {
      type: String,
      enum: [...TASK_STATUS, ...Object.keys(LEGACY_STATUS_MAP)],
      default: 'ASSIGNED',
      index: true,
    },
    priority: { type: String, enum: TASK_PRIORITY, default: 'Medium', index: true },
    // 0–100, always derived (see recomputeProgress).
    progress: { type: Number, min: 0, max: 100, default: 0 },
    // Where `progress` comes from: 'auto' picks subtasks → checklist →
    // assignees, whichever the task actually has.
    progressSource: { type: String, trim: true, default: 'auto' },

    // ===== Dates =====
    startDate: Date,
    dueDate: { type: Date, index: true },
    // The due date this task was ORIGINALLY given. Section 53: "the original due
    // date cannot be deleted". Stamped once, on first save, and never written
    // again — every extension moves `dueDate` and leaves this alone.
    originalDueDate: Date,
    estimatedMinutes: { type: Number, min: 0 },
    // Rolled up from TaskTimeEntry across every assignee.
    minutesLogged: { type: Number, default: 0 },
    // Lifecycle stamps. All SERVER-generated (section 37) — a client may not
    // tell us when it finished something.
    assignedAt: { type: Date, default: Date.now },
    acceptedAt: Date,
    startedAt: Date,
    submittedAt: Date,
    approvedAt: Date,
    completedAt: Date,
    closedAt: Date,
    // Set the first time the task is past its due date with work outstanding.
    // Stored rather than computed so "was this late?" survives a later extension
    // — an extension that moves the deadline must not quietly un-late a task.
    firstOverdueAt: Date,

    // ===== What submission demands (section 12) =====
    requirements: {
      remarks: { type: Boolean, default: false },
      checklist: { type: Boolean, default: false },
      attachment: { type: Boolean, default: false },
      photo: { type: Boolean, default: false },
      location: { type: Boolean, default: false },
      signature: { type: Boolean, default: false },
      // How many of the evidence kind are needed — the spec's "3 photos
      // required". 0/absent means "at least one" when the flag is on.
      minPhotos: { type: Number, default: 0, min: 0 },
      minAttachments: { type: Number, default: 0, min: 0 },
      // Free text shown on the submission form: what good evidence looks like.
      note: { type: String, trim: true, maxlength: 500 },
    },

    // ===== Location & geofence (sections 15–16) =====
    location: {
      // Which moments record a position. Empty = none; this module never
      // captures location as a side effect of something else.
      captureOn: [{ type: String, enum: LOCATION_EVENTS }],
      // Which moments must be INSIDE the fence. Independently configurable, per
      // the spec — "inside to start" and "inside to submit" are separate asks.
      enforceOn: [{ type: String, enum: GEOFENCE_RULES }],
      // The site the fence is measured against. Null with `enforceOn` set means
      // the assignee's own assigned work location is used.
      workLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkLocation' },
      // Overrides the site's own radius for this task only.
      radiusM: { type: Number, min: 0 },
      // Positions actually recorded, newest last. One per captured moment per
      // person; never continuous tracking.
      captured: [{
        event: { type: String, enum: LOCATION_EVENTS },
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        userName: { type: String, trim: true },
        ...taskLocationSchema.obj,
      }],
    },

    // ===== Approval (section 13) =====
    // Does finishing this task need somebody's yes? A task with a workflow gets
    // its approvals from the workflow; this is the simple case — one reviewer,
    // no workflow.
    requiresApproval: { type: Boolean, default: false },
    // Must a rejection say why? On by default: a "no" with no reason is not a
    // decision the assignee can act on.
    rejectionNeedsReason: { type: Boolean, default: true },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvalNote: { type: String, trim: true, maxlength: 1000 },
    rejectionCount: { type: Number, default: 0 },

    // ===== Workflow (sections 6–7) =====
    workflowRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow', index: true },
    // The version number that was published when this task started. Reporting
    // only — execution reads the frozen `workflowSteps` below.
    workflowVersion: Number,
    workflowName: { type: String, trim: true },
    workflowSteps: [workflowStepSchema],
    // The key of the step (or, inside a parallel group, any of the steps)
    // currently open. Null when the workflow has not started or has finished.
    currentStepKey: { type: String, trim: true, default: null, index: true },
    // Everyone whose decision the task is waiting on right now, flattened out of
    // the open steps. Indexed, because "what is in my approval inbox?" is the
    // single most frequent query this module makes.
    pendingApprovers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }],

    // ===== Structure =====
    parentTask: { type: mongoose.Schema.Types.ObjectId, ref: 'Task', index: true },
    // Maintained by the model on the parent, so a parent can render its children
    // count without a second query. The children themselves are found by
    // `parentTask`.
    subtaskCount: { type: Number, default: 0 },
    subtaskDoneCount: { type: Number, default: 0 },
    dependencies: [dependencySchema],

    attachments: [taskAttachmentSchema],
    checklist: [checklistItemSchema],

    // ===== Reminders & escalation (sections 19–20) =====
    reminders: {
      // Hours BEFORE the due date to nudge the assignee. The spec's 24/4/1/0.25.
      beforeDueHours: { type: [Number], default: undefined },
      // Hours AFTER the due date, and who hears about each. `to` is one of
      // 'assignee' | 'supervisor' | 'manager' | 'admin'.
      afterDue: {
        type: [new mongoose.Schema({
          hours: { type: Number, required: true },
          to: { type: String, default: 'assignee' },
          severity: { type: String, default: 'WARNING' },
        }, { _id: false })],
        default: undefined,
      },
      // Hours after ASSIGNMENT before an unaccepted task is chased (section 10).
      // Null = the priority's default (config/taskWorkflow.ACCEPT_WINDOW_HOURS).
      acceptWithinHours: Number,
    },
    // Every reminder and escalation this task has already fired, as
    // 'kind:offset' keys. The worker's idempotence lives here: a restart must
    // not replay a day of notifications at somebody, which is exactly the trap
    // the push-reminder worker hit.
    firedReminders: { type: [String], default: [] },
    escalationLevel: { type: Number, default: 0 },
    lastEscalatedAt: Date,

    // ===== Recurrence (section 23) =====
    // The RecurringTask that generated this instance, when it was generated.
    recurringTask: { type: mongoose.Schema.Types.ObjectId, ref: 'RecurringTask', index: true },
    // The occurrence this instance is for, as an IST day key — the generator's
    // idempotence key, so a worker restart cannot mint the same day twice.
    occurrenceKey: { type: String, trim: true },
    // The template this task was built from, when it was.
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'TaskTemplate' },

    // ===== Incentive (section 25) =====
    // POINTS, set by the manager who assigns the task. Nothing here is money:
    // this portal pays every incentive in one company-wide points pool valued by
    // a single rate, and the award joins that pool through IncentiveCredit once
    // it is sanctioned (see services/taskIncentive.js).
    incentive: {
      enabled: { type: Boolean, default: false },
      // What the whole task is worth, in points, if done well and on time.
      points: { type: Number, min: 0, default: 0 },
      // The share each outcome earns. Defaults from config/taskWorkflow.
      split: {
        type: new mongoose.Schema(
          Object.fromEntries(INCENTIVE_OUTCOMES.map((k) => [k, { type: Number, min: 0, max: 1 }])),
          { _id: false }
        ),
        default: () => ({ ...DEFAULT_INCENTIVE_SPLIT }),
      },
      // Split the points between the eligible assignees, or give each of them
      // the full figure. 'share' is the default — a four-person task worth 20
      // points is 20 points of work, not 80.
      distribution: { type: String, trim: true, default: 'share' },
      // Who set it, so the sanctioning screen can say whose proposal it is.
      setBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      setByName: { type: String, trim: true },
    },

    // ===== Bookkeeping =====
    // An extension moves `dueDate` and increments this. The extensions
    // themselves are TaskExtension rows — the full before/after, with the reason.
    extensionCount: { type: Number, default: 0 },
    handoverCount: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0 },
    // Why the task is blocked / on hold / cancelled. Kept separately from the
    // activity trail so the reason is on the row the list renders.
    stateNote: { type: String, trim: true, maxlength: 1000 },
    // An archived task is out of the default lists but not deleted.
    archived: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// ===== Indexes =====
// Section 38 asks for indexes on assignee, supervisor, department, status, due
// date, workflow, created date, overdue tasks and approval status. The single-
// field ones are declared on the paths above; these are the compounds the real
// queries make.
taskSchema.index({ assignedTo: 1, status: 1, dueDate: 1 });     // "my open tasks, soonest first"
taskSchema.index({ 'assignees.user': 1, status: 1 });            // the same for a non-primary assignee
taskSchema.index({ supervisor: 1, status: 1 });                  // a supervisor's team board
taskSchema.index({ manager: 1, status: 1 });
taskSchema.index({ pendingApprovers: 1, status: 1 });            // the approval inbox
taskSchema.index({ company: 1, status: 1, dueDate: 1 });         // every walled admin list
taskSchema.index({ department: 1, status: 1 });
taskSchema.index({ status: 1, dueDate: 1 });                     // the overdue sweep
taskSchema.index({ createdAt: -1 });
// One instance per occurrence of a recurring task. Sparse-unique so the
// generator cannot mint the same day twice, however often the worker restarts.
taskSchema.index({ recurringTask: 1, occurrenceKey: 1 }, { unique: true, sparse: true });

// ===== Hooks =====

// The reference code, from the same atomic counter as VCH/EXP. `createdAt` is
// not set yet on a new document, so nextCode falls back to the current year,
// which is the same answer.
taskSchema.pre('save', stampCode('TSK', 'createdAt'));

/**
 * Normalise the status before validation.
 *
 * Belt and braces for the migration window: an un-migrated row loaded and saved
 * through ANY path — an edit, a subtask roll-up, a reminder stamp — comes out
 * the other side speaking the new vocabulary, and an older mobile build that
 * PATCHes 'InProgress' is understood rather than rejected. Once the migration
 * has run this is a no-op on every document.
 */
taskSchema.pre('validate', function normaliseTaskStatus(next) {
  const fixed = normaliseStatus(this.status);
  if (fixed && fixed !== this.status) this.status = fixed;
  for (const a of this.assignees || []) {
    const af = normaliseStatus(a.status);
    if (af && af !== a.status) a.status = af;
  }
  next();
});

/**
 * Keep the derived fields honest on every save.
 *
 * Three things are maintained here rather than by the callers, because there are
 * a dozen callers and they would each have to remember:
 *   - `assignedTo` mirrors the Owner (or the first) assignee, so every legacy
 *     query and the Android app keep working;
 *   - `originalDueDate` is stamped once and never again (section 53);
 *   - `progress` is recomputed from whichever source the task actually has.
 */
taskSchema.pre('save', function syncDerived(next) {
  // --- primary assignee ---
  const list = this.assignees || [];
  if (list.length) {
    const owner = list.find((a) => a.role === 'Owner') || list[0];
    if (owner && owner.user) this.assignedTo = owner.user;
  } else if (this.assignedTo) {
    // A task created the old way — one `assignedTo` and no array. Give it an
    // assignee row so every new code path sees the same shape.
    list.push({ user: this.assignedTo, role: 'Owner', status: this.status });
    this.assignees = list;
  }

  // --- the due date it was first given ---
  if (this.dueDate && !this.originalDueDate) this.originalDueDate = this.dueDate;

  // --- progress ---
  this.progress = this.computeProgress();

  // --- closing stamps ---
  if (isTerminal(this.status) && !this.closedAt) this.closedAt = new Date();
  if (!isTerminal(this.status) && this.closedAt) this.closedAt = undefined;

  next();
});

// ===== Methods =====

/**
 * The task's completion percentage, from whichever source it actually has.
 *
 * Order matters and is deliberate: subtasks beat a checklist, and a checklist
 * beats the assignees' own figures. A task broken into subtasks is DEFINED by
 * them, so a parent claiming 90% while three of its four children are untouched
 * would be the parent lying about its children.
 * @returns {number} 0–100
 */
taskSchema.methods.computeProgress = function computeProgress() {
  if (this.progressSource === 'manual') return this.progress || 0;
  if (isTerminal(this.status)) return this.status === 'COMPLETED' ? 100 : (this.progress || 0);

  if (this.subtaskCount > 0) {
    return Math.round((this.subtaskDoneCount / this.subtaskCount) * 100);
  }
  const items = this.checklist || [];
  if (items.length) {
    const done = items.filter((i) => i.done).length;
    return Math.round((done / items.length) * 100);
  }
  const people = this.assignees || [];
  if (people.length) {
    const sum = people.reduce((t, a) => t + (a.progress || 0), 0);
    return Math.round(sum / people.length);
  }
  // Nothing to measure: fall back to what the status implies.
  const byStatus = {
    ASSIGNED: 0, ACCEPTED: 10, IN_PROGRESS: 40, BLOCKED: 40, ON_HOLD: 40,
    REJECTED: 60, SUBMITTED: 80, UNDER_REVIEW: 85, APPROVED: 95, COMPLETED: 100,
  };
  return byStatus[this.status] ?? 0;
};

/**
 * Is this person named on the task as somebody who does the work?
 * @param {*} userId
 * @returns {boolean}
 */
taskSchema.methods.isAssignee = function isAssignee(userId) {
  const id = String(userId || '');
  if (!id) return false;
  if (String(this.assignedTo || '') === id) return true;
  return (this.assignees || []).some((a) => String(a.user?._id || a.user || '') === id);
};

/**
 * Is this person a reviewer of the task — its supervisor, its manager, or an
 * actor on the step that is open right now?
 * @param {*} userId
 * @returns {boolean}
 */
taskSchema.methods.isReviewer = function isReviewer(userId) {
  const id = String(userId || '');
  if (!id) return false;
  if (String(this.supervisor || '') === id) return true;
  if (String(this.manager || '') === id) return true;
  return (this.pendingApprovers || []).some((u) => String(u?._id || u || '') === id);
};

/** The assignee row for this person, or undefined. */
taskSchema.methods.assigneeRow = function assigneeRow(userId) {
  const id = String(userId || '');
  return (this.assignees || []).find((a) => String(a.user?._id || a.user || '') === id);
};

/** Past its due date with work still outstanding. */
taskSchema.methods.isOverdue = function isOverdueNow(at = new Date()) {
  if (!this.dueDate || isTerminal(this.status)) return false;
  return new Date(this.dueDate).getTime() < at.getTime();
};

// Audit-status plugin: logs `status` transitions to AuditLog, attributed to the
// acting user. The module also keeps its own far richer per-task trail
// (models/TaskActivity) — this one puts task movements into the PORTAL-WIDE
// audit screen alongside every other status change, which is where a SuperAdmin
// looks when the question is about the organisation rather than about one task.
taskSchema.plugin(require('./plugins/auditStatus'), { label: (d) => d.title });

module.exports = mongoose.model('Task', taskSchema);
module.exports.TASK_STATUS = TASK_STATUS;
module.exports.TASK_PRIORITY = TASK_PRIORITY;
module.exports.taskAttachmentSchema = taskAttachmentSchema;
module.exports.taskLocationSchema = taskLocationSchema;
