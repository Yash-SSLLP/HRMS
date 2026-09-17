/**
 * The task lifecycle, in one place.
 *
 * Every status string, every legal move between them, and every configurable
 * requirement the module can put on a task lives here rather than being spelled
 * out in the controller, the model and three React pages. Section 2 of the spec
 * asks for statuses that are "configurable where appropriate rather than
 * hard-coded throughout the application", and this is what that means in
 * practice: one catalogue the server validates against, mirrored once on the
 * client (frontend/src/utils/taskLifecycle.js) for drawing chips and buttons.
 *
 * WHY A TRANSITION TABLE RATHER THAN `if` STATEMENTS. A task is acted on by four
 * different people (assignee, supervisor, approver, admin) from three clients
 * (web admin, web employee, Android), and two of them can act at the same
 * moment. With the legal moves written down, "may this happen?" is one lookup
 * that every path — including one written next year — has to go through, and
 * the concurrency guard in services/taskEngine.js can be a single conditional
 * update rather than a re-read in every handler.
 *
 * THE OLD FOUR STATUSES ARE STILL HERE. Todo/InProgress/Review/Done were what
 * the module had before this rework, and 57 live tasks are sitting on them.
 * They are kept as aliases (LEGACY_STATUS_MAP) so a row that has not been
 * migrated still reads, and so the Android app — which sends the old words
 * until it is updated — keeps working. See scripts/migrateTasksV2.js.
 */

// ===== Lifecycle =====
// ASSIGNED    handed over, not yet acknowledged
// ACCEPTED    the assignee has taken it on
// IN_PROGRESS being worked
// SUBMITTED   handed back with whatever evidence was required
// UNDER_REVIEW a reviewer has it
// APPROVED    the review said yes; any remaining workflow steps run
// COMPLETED   the workflow finished — the terminal success state
// REJECTED    sent back; the assignee works on it again and RESUBMITS
// DECLINED    the assignee refused the assignment (with a reason)
// BLOCKED     cannot proceed — a dependency, or something outside the task
// ON_HOLD     deliberately paused by a supervisor
// CANCELLED   called off
const TASK_STATUS = [
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'COMPLETED',
  'REJECTED',
  'DECLINED',
  'BLOCKED',
  'ON_HOLD',
  'CANCELLED',
];

/** Statuses from which nothing further happens on its own. */
const TERMINAL_STATUS = ['COMPLETED', 'DECLINED', 'CANCELLED'];

/** Statuses that mean the task is still somebody's to do. */
const OPEN_STATUS = TASK_STATUS.filter((s) => !TERMINAL_STATUS.includes(s));

/**
 * Statuses in which the clock is allowed to run. A timer must not tick on a
 * task that is on hold, blocked, submitted or finished — the whole point of
 * time tracking is that the figure means something.
 */
const TIMEABLE_STATUS = ['ACCEPTED', 'IN_PROGRESS', 'REJECTED'];

// What each status is called in a sentence. The keys are what the database
// stores; these are what a person reads, and they are the ONLY place the
// wording lives so a notification, a chip and an export cannot disagree.
const STATUS_LABELS = {
  ASSIGNED: 'Assigned',
  ACCEPTED: 'Accepted',
  IN_PROGRESS: 'In progress',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  APPROVED: 'Approved',
  COMPLETED: 'Completed',
  REJECTED: 'Sent back',
  DECLINED: 'Declined',
  BLOCKED: 'Blocked',
  ON_HOLD: 'On hold',
  CANCELLED: 'Cancelled',
};

/**
 * The legal moves, keyed by the status being left.
 *
 * `actors` names WHO may make each move, in the module's own vocabulary:
 *   assignee   — somebody named on the task
 *   reviewer   — the supervisor, manager, or the approver of the current step
 *   admin      — a `tasks.manage` holder, or the task's creator
 * A move with several actors may be made by any of them. The engine checks this
 * list and then the identity; neither on its own is enough.
 *
 * `reason` marks a move that cannot be made silently — the engine refuses it
 * without a remark, because the record of WHY is the only thing that makes a
 * decline, a rejection or a cancellation auditable afterwards.
 */
const TRANSITIONS = {
  ASSIGNED: [
    { to: 'ACCEPTED', actors: ['assignee'] },
    { to: 'DECLINED', actors: ['assignee'], reason: true },
    // An admin may start a task on somebody's behalf — the common case being a
    // task created for work already under way.
    { to: 'IN_PROGRESS', actors: ['assignee', 'admin'] },
    { to: 'ON_HOLD', actors: ['reviewer', 'admin'], reason: true },
    { to: 'CANCELLED', actors: ['reviewer', 'admin'], reason: true },
  ],
  ACCEPTED: [
    { to: 'IN_PROGRESS', actors: ['assignee'] },
    { to: 'BLOCKED', actors: ['assignee', 'reviewer', 'admin'], reason: true },
    { to: 'ON_HOLD', actors: ['reviewer', 'admin'], reason: true },
    { to: 'CANCELLED', actors: ['reviewer', 'admin'], reason: true },
  ],
  IN_PROGRESS: [
    { to: 'SUBMITTED', actors: ['assignee'] },
    { to: 'BLOCKED', actors: ['assignee', 'reviewer', 'admin'], reason: true },
    { to: 'ON_HOLD', actors: ['reviewer', 'admin'], reason: true },
    { to: 'CANCELLED', actors: ['reviewer', 'admin'], reason: true },
  ],
  SUBMITTED: [
    { to: 'UNDER_REVIEW', actors: ['reviewer', 'admin'] },
    { to: 'APPROVED', actors: ['reviewer', 'admin'] },
    { to: 'REJECTED', actors: ['reviewer', 'admin'], reason: true },
    { to: 'CANCELLED', actors: ['admin'], reason: true },
  ],
  UNDER_REVIEW: [
    { to: 'APPROVED', actors: ['reviewer', 'admin'] },
    { to: 'REJECTED', actors: ['reviewer', 'admin'], reason: true },
    { to: 'CANCELLED', actors: ['admin'], reason: true },
  ],
  APPROVED: [
    // Not a person's move: the engine makes it when the last workflow step is
    // done. Listed so the table is the whole truth about how a task reaches
    // COMPLETED, and `actors: ['system']` is what stops a client asking for it.
    { to: 'COMPLETED', actors: ['system', 'admin'] },
    // A task with more workflow ahead of it goes back to being worked — the
    // next step's assignee picks it up.
    { to: 'IN_PROGRESS', actors: ['system'] },
  ],
  REJECTED: [
    // The resubmission path. It is IN_PROGRESS again, not a status of its own:
    // "RESUBMITTED" would be indistinguishable from SUBMITTED for every query
    // that matters, and the submission record already counts the attempts.
    { to: 'IN_PROGRESS', actors: ['assignee'] },
    { to: 'SUBMITTED', actors: ['assignee'] },
    { to: 'ON_HOLD', actors: ['reviewer', 'admin'], reason: true },
    { to: 'CANCELLED', actors: ['reviewer', 'admin'], reason: true },
  ],
  BLOCKED: [
    { to: 'IN_PROGRESS', actors: ['assignee', 'reviewer', 'admin'] },
    { to: 'CANCELLED', actors: ['reviewer', 'admin'], reason: true },
  ],
  ON_HOLD: [
    { to: 'IN_PROGRESS', actors: ['reviewer', 'admin'] },
    { to: 'ASSIGNED', actors: ['reviewer', 'admin'] },
    { to: 'CANCELLED', actors: ['reviewer', 'admin'], reason: true },
  ],
  // COMPLETED is terminal, but not irreversible by decree: section 53 asks that
  // it "cannot become IN_PROGRESS without an authorized reopen action". That is
  // exactly this row — an admin only, with a reason, recorded like any other
  // move rather than by editing the field.
  COMPLETED: [
    { to: 'IN_PROGRESS', actors: ['admin'], reason: true },
  ],
  DECLINED: [
    // Reassigning a declined task is what happens in practice; putting it back
    // to ASSIGNED is how the reassignment lands.
    { to: 'ASSIGNED', actors: ['admin'] },
    { to: 'CANCELLED', actors: ['admin'], reason: true },
  ],
  CANCELLED: [
    { to: 'ASSIGNED', actors: ['admin'], reason: true },
  ],
};

/**
 * The four statuses this module used before the rework, and what each becomes.
 * Read by the migration script, and by the engine when an un-migrated row or an
 * older mobile build sends one of them.
 */
const LEGACY_STATUS_MAP = {
  Todo: 'ASSIGNED',
  InProgress: 'IN_PROGRESS',
  Review: 'UNDER_REVIEW',
  Done: 'COMPLETED',
};

/** The reverse, for answering an old client in words it understands. */
const STATUS_TO_LEGACY = {
  ASSIGNED: 'Todo',
  ACCEPTED: 'InProgress',
  IN_PROGRESS: 'InProgress',
  BLOCKED: 'InProgress',
  ON_HOLD: 'Todo',
  REJECTED: 'InProgress',
  SUBMITTED: 'Review',
  UNDER_REVIEW: 'Review',
  APPROVED: 'Review',
  COMPLETED: 'Done',
  DECLINED: 'Todo',
  CANCELLED: 'Done',
};

// ===== Board columns =====
// The Kanban view (section 27) groups twelve statuses into six columns. Defined
// here rather than in the page so the admin board, the employee board and the
// mobile list cannot drift into three different pictures of the same work.
const BOARD_COLUMNS = [
  { key: 'new', label: 'New', statuses: ['ASSIGNED'] },
  { key: 'accepted', label: 'Accepted', statuses: ['ACCEPTED'] },
  { key: 'progress', label: 'In progress', statuses: ['IN_PROGRESS', 'BLOCKED', 'ON_HOLD', 'REJECTED'] },
  { key: 'submitted', label: 'Submitted', statuses: ['SUBMITTED'] },
  { key: 'review', label: 'Review', statuses: ['UNDER_REVIEW', 'APPROVED'] },
  { key: 'done', label: 'Completed', statuses: ['COMPLETED', 'DECLINED', 'CANCELLED'] },
];

// ===== Priority =====
const TASK_PRIORITY = ['Low', 'Medium', 'High', 'Urgent'];

// How long after assignment a task of each priority is expected to be accepted,
// in hours, before the reminder engine starts nudging (section 10). A default,
// not a rule: a task, a template or a workflow step can carry its own.
const ACCEPT_WINDOW_HOURS = { Urgent: 2, High: 8, Medium: 24, Low: 48 };

// ===== Notification severity (section 50) =====
const SEVERITY = ['INFO', 'WARNING', 'HIGH', 'CRITICAL'];

// ===== Submission requirements (section 12) =====
// What a task can insist on before it may be handed back. Each is independently
// switchable, because "photo required" and "location required" are different
// questions and a warehouse inspection needs both while a report needs neither.
const REQUIREMENT_KEYS = [
  'remarks',
  'checklist',
  'attachment',
  'photo',
  'location',
  'signature',
];

const REQUIREMENT_LABELS = {
  remarks: 'Remarks',
  checklist: 'Checklist completed',
  attachment: 'Attachment',
  photo: 'Photo',
  location: 'Location',
  signature: 'Signature',
};

// ===== Evidence kinds (section 17) =====
const EVIDENCE_KINDS = ['photo', 'video', 'document', 'signature', 'voice', 'url'];

// ===== Location capture points (section 15) =====
// The moments at which a task may be told to record where the person is. Listed
// rather than inferred so nothing captures location as a side effect: a task
// records a position at exactly the moments somebody ticked.
const LOCATION_EVENTS = ['accept', 'start', 'submit', 'approve', 'complete'];

// ===== Geofence rules (section 16) =====
// Independently configurable, per the spec — "must be inside to start" and
// "must be inside to submit" are separate decisions.
const GEOFENCE_RULES = ['start', 'submit', 'complete'];

// ===== Workflow node types (section 6) =====
const NODE_TYPES = [
  'assignment',  // somebody does the work
  'approval',    // somebody says yes or no
  'review',      // somebody looks and comments, without a verdict
  'notify',      // tell somebody; advances immediately
  'wait',        // hold for a period before advancing
  'condition',   // branch on a field of the task
  'parallel',    // a group whose children all run at once
];

/** How a parallel group decides it is finished. */
const PARALLEL_JOINS = ['all', 'any', 'majority'];

/** Operators a conditional step may use. */
const CONDITION_OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains', 'empty', 'notEmpty'];

// ===== Assignee roles on a task (section 4) =====
// A task with four people on it does not have four identical people on it. This
// is what each of them is there to do.
const ASSIGNEE_ROLES = ['Owner', 'Contributor', 'Reviewer', 'Observer'];

// ===== Recurrence (section 23) =====
const RECURRENCE_FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly', 'custom'];

// ===== Dependency kinds (section 9) =====
const DEPENDENCY_KINDS = ['blocks', 'blockedBy', 'relatedTo'];

// ===== Incentive (section 25) =====
// Points, not rupees. This portal pays every incentive in one company-wide
// points pool valued by a single rate (see models/IncentiveEntry and
// Setting.incentive.rupeePerPoint), and a second currency for tasks alone would
// be a second answer to "what is this person owed". The manager assigning the
// task sets the points; the outcome below decides how many of them are earned.
const INCENTIVE_OUTCOMES = ['early', 'onTime', 'late', 'veryLate', 'rejectedFirst'];

const INCENTIVE_OUTCOME_LABELS = {
  early: 'Completed early',
  onTime: 'Completed on time',
  late: 'Up to a day late',
  veryLate: 'More than a day late',
  rejectedFirst: 'Sent back before approval',
};

// The share of the task's points each outcome earns, as a fraction. Defaults
// only — every task and template may override them, which is what makes the
// figures in the spec (₹500 / ₹400 / ₹200 / ₹0) expressible as 1 / 0.8 / 0.4 / 0
// of whatever the manager set.
const DEFAULT_INCENTIVE_SPLIT = {
  early: 1,
  onTime: 0.8,
  late: 0.4,
  veryLate: 0,
  rejectedFirst: 0.5,
};

// A task incentive is proposed by the assigning manager and does not become
// points until somebody who may credit the pool says so (see
// services/taskIncentive.js).
const INCENTIVE_STATUS = ['Pending', 'Approved', 'Rejected', 'Credited'];

// ===== Helpers =====

/**
 * Normalise whatever a client sent into a lifecycle status.
 * Accepts the new keys, the four legacy words, and lower/mixed case — an
 * Android build that predates this rework still speaks the old vocabulary, and
 * refusing it would break the app in the field rather than in a test.
 * @param {string} value
 * @returns {string|null} a TASK_STATUS member, or null when unreadable
 */
function normaliseStatus(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (TASK_STATUS.includes(raw)) return raw;
  if (LEGACY_STATUS_MAP[raw]) return LEGACY_STATUS_MAP[raw];
  const upper = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (TASK_STATUS.includes(upper)) return upper;
  // 'inprogress' → 'IN_PROGRESS'
  const found = TASK_STATUS.find((s) => s.replace(/_/g, '').toUpperCase() === upper.replace(/_/g, ''));
  return found || null;
}

/**
 * The moves available from a status.
 * @param {string} from
 * @returns {Array<{to:string, actors:string[], reason?:boolean}>}
 */
const transitionsFrom = (from) => TRANSITIONS[from] || [];

/**
 * Find the rule for one move, or null when there is no such move.
 * @param {string} from
 * @param {string} to
 * @returns {{to:string, actors:string[], reason?:boolean}|null}
 */
function transitionRule(from, to) {
  return transitionsFrom(from).find((t) => t.to === to) || null;
}

/** Does this move require a remark to be recorded with it? */
const transitionNeedsReason = (from, to) => !!(transitionRule(from, to) || {}).reason;

/** Which board column a status belongs in. */
function columnOf(status) {
  const col = BOARD_COLUMNS.find((c) => c.statuses.includes(status));
  return col ? col.key : 'progress';
}

const isTerminal = (status) => TERMINAL_STATUS.includes(status);
const isOpen = (status) => OPEN_STATUS.includes(status);
const canTimeTrack = (status) => TIMEABLE_STATUS.includes(status);
const statusLabel = (status) => STATUS_LABELS[status] || status;

module.exports = {
  TASK_STATUS,
  TERMINAL_STATUS,
  OPEN_STATUS,
  TIMEABLE_STATUS,
  STATUS_LABELS,
  TRANSITIONS,
  LEGACY_STATUS_MAP,
  STATUS_TO_LEGACY,
  BOARD_COLUMNS,
  TASK_PRIORITY,
  ACCEPT_WINDOW_HOURS,
  SEVERITY,
  REQUIREMENT_KEYS,
  REQUIREMENT_LABELS,
  EVIDENCE_KINDS,
  LOCATION_EVENTS,
  GEOFENCE_RULES,
  NODE_TYPES,
  PARALLEL_JOINS,
  CONDITION_OPERATORS,
  ASSIGNEE_ROLES,
  RECURRENCE_FREQUENCIES,
  DEPENDENCY_KINDS,
  INCENTIVE_OUTCOMES,
  INCENTIVE_OUTCOME_LABELS,
  DEFAULT_INCENTIVE_SPLIT,
  INCENTIVE_STATUS,
  normaliseStatus,
  transitionsFrom,
  transitionRule,
  transitionNeedsReason,
  columnOf,
  isTerminal,
  isOpen,
  canTimeTrack,
  statusLabel,
};
