/**
 * The task lifecycle, in one place.
 *
 * REWRITTEN 2026-09-21, replacing config/taskWorkflow.js and the twelve-status
 * machine it described. The module that file served could route one task
 * through parallel approval steps, conditional branches, dependency graphs and
 * an evidence contract; almost none of it was used, and the cost of it was that
 * handing somebody a job took a five-section form and reading one back took a
 * page with six tabs. The brief was a task app a business owner can work
 * without being taught: THREE states, one form, one update box.
 *
 *   PENDING ──start──> IN_PROGRESS ──complete──> COMPLETED
 *      └────────────────complete───────────────────┘
 *      └──cancel──> CANCELLED  (the assigner calls it off)
 *
 * Everything else a list needs to say is DERIVED, never stored as a status,
 * because a stored one goes stale the moment a clock ticks past it:
 *
 *   OVERDUE   open and past its due date          (see isOverdue)
 *   IN TIME   completed on or before the due date (see completedLate === false)
 *   DELAYED   completed after it                  (see completedLate === true)
 *
 * That is the whole vocabulary. A task is pending, being worked on, or done —
 * and if it is done, it was either on time or it was not.
 *
 * TWO KINDS OF ROW, ONE COLLECTION. A task travels DOWNWARD (to your reports)
 * or SIDEWAYS (to your peers). Nobody hands work upward — asking your manager
 * for the figures you need is not a task you have set them, and recording it as
 * one would put your manager's name in your completion rate. So an upward ask
 * is a REQUEST: same row, same feed, same voice notes, same three states, but
 * it earns no points, it is never counted in anybody's score, and it is worded
 * as a question rather than an instruction (see LABELS below and
 * services/taskAccess.directionOf). User decision, 2026-09-21.
 */

// ===== Kinds =====

/** Work handed down or across. Scored, earns points. */
const KIND_TASK = 'TASK';
/** An ask sent up the line. Not scored, earns nothing. */
const KIND_REQUEST = 'REQUEST';
const TASK_KINDS = [KIND_TASK, KIND_REQUEST];

// ===== States =====

const STATUS = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

const TASK_STATUS = Object.values(STATUS);

/** Nothing further happens on its own from here. */
const TERMINAL_STATUS = [STATUS.COMPLETED, STATUS.CANCELLED];

/** Still somebody's to do. What "pending" means on every counter. */
const OPEN_STATUS = TASK_STATUS.filter((s) => !TERMINAL_STATUS.includes(s));

/**
 * What each state is called in a sentence, per kind.
 *
 * The ONLY place the wording lives, so a chip, a push notification and an
 * export cannot disagree. A request is answered, not completed — it was a
 * question.
 */
const LABELS = {
  [KIND_TASK]: {
    PENDING: 'Pending',
    IN_PROGRESS: 'In progress',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
  },
  [KIND_REQUEST]: {
    PENDING: 'Open',
    IN_PROGRESS: 'Looking into it',
    COMPLETED: 'Answered',
    CANCELLED: 'Withdrawn',
  },
};

function statusLabel(status, kind = KIND_TASK) {
  return (LABELS[kind] || LABELS[KIND_TASK])[status] || status || '';
}

/**
 * The legal moves, keyed by the state being left.
 *
 * `by` names who may make the move:
 *   doer      — somebody the task is assigned to (on a request: the person asked)
 *   assigner  — whoever set it, or an admin
 * A move listed for both may be made by either. `note` marks a move that cannot
 * be made silently: the update box opens and will not submit empty, which is
 * the whole mechanism by which a completed task carries a record of what was
 * actually done.
 */
const TRANSITIONS = {
  PENDING: [
    { to: STATUS.IN_PROGRESS, by: ['doer', 'assigner'], note: true },
    { to: STATUS.COMPLETED, by: ['doer', 'assigner'], note: true },
    { to: STATUS.CANCELLED, by: ['assigner'], note: true },
  ],
  IN_PROGRESS: [
    { to: STATUS.COMPLETED, by: ['doer', 'assigner'], note: true },
    { to: STATUS.PENDING, by: ['assigner'], note: true },
    { to: STATUS.CANCELLED, by: ['assigner'], note: true },
  ],
  // Reopening a finished task is the assigner's call and always needs a reason.
  // It is the one move that takes points back (services/taskPoints.reverse).
  COMPLETED: [
    { to: STATUS.IN_PROGRESS, by: ['assigner'], note: true },
  ],
  CANCELLED: [
    { to: STATUS.PENDING, by: ['assigner'], note: true },
  ],
};

/** May `from → to` be made at all, and by whom? Null when it may not. */
function transitionFor(from, to) {
  return (TRANSITIONS[from] || []).find((t) => t.to === to) || null;
}

function isTerminal(status) {
  return TERMINAL_STATUS.includes(status);
}

/**
 * Is this row late?
 *
 * Open and past its due date. A completed one is never overdue however late it
 * was — that is what `completedLate` says, and conflating the two makes the
 * Overdue counter creep up forever with work that has long since been done.
 */
function isOverdue(task, now = new Date()) {
  if (!task || !task.dueDate) return false;
  if (isTerminal(task.status)) return false;
  return new Date(task.dueDate).getTime() < now.getTime();
}

// ===== Acceptance — a SECOND axis, deliberately not a fourth status =====

/**
 * Has the person taken the job on?
 *
 * Added 2026-09-21 (second pass). It would have been easy to make this a fourth
 * status — ASSIGNED → ACCEPTED → IN_PROGRESS — and that is exactly what the
 * module this replaced did, on the way to twelve. It is a separate axis because
 * it answers a different question:
 *
 *   status      how far along the WORK is
 *   acceptance  whether the PERSON has agreed to do it
 *
 * They move independently: somebody can accept and not start, or start without
 * ever pressing Accept (which is the common case and must stay legal — chasing
 * an acknowledgement for work that is already done is exactly the ceremony this
 * module exists to remove). Folding them into one enum would have made
 * "accepted but not started" and "started but never acknowledged" two more
 * statuses each, which is how twelve happened the first time.
 */
const ACCEPTANCE = {
  AWAITING: 'AWAITING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
};
const ACCEPTANCE_STATES = Object.values(ACCEPTANCE);

const ACCEPTANCE_LABELS = {
  AWAITING: 'Not yet accepted',
  ACCEPTED: 'Accepted',
  REJECTED: 'Declined',
};

/**
 * Is this row effectively refused?
 *
 * True when EVERY person still on it has rejected it. Derived, never stored —
 * like `isOverdue`, and for the same reason: the answer changes the moment the
 * assigner puts somebody else on it, and a stored flag would not.
 */
function isDeclined(task) {
  const live = (task?.assignees || []).filter((a) => a.status !== STATUS.CANCELLED);
  if (!live.length) return false;
  return live.every((a) => a.acceptance === ACCEPTANCE.REJECTED);
}

/** Is anybody still sitting on an un-answered handover? */
function isAwaitingAcceptance(task) {
  return (task?.assignees || []).some(
    (a) => a.acceptance === ACCEPTANCE.AWAITING && a.status === STATUS.PENDING
  );
}

// ===== The rest of a task's vocabulary =====

const TASK_PRIORITY = ['High', 'Medium', 'Low'];
const DEFAULT_PRIORITY = 'Medium';

/**
 * What one task is worth, in points, before the assigner says otherwise.
 *
 * Points are the portal's one company-wide currency — the same pool the rolling
 * and billing incentives pay into (models/IncentiveCredit). A task carries a
 * figure so the dashboard can score effort rather than merely count rows: ten
 * trivial tasks and one hard one are not the same week's work.
 *
 * 100 is deliberately a round number to divide: half a job is 50, a quarter 25.
 * User decision, 2026-09-21.
 */
const DEFAULT_TASK_POINTS = 100;
const MAX_TASK_POINTS = 100000;

/**
 * How many subtasks one task may carry.
 *
 * Capped because they are EMBEDDED (models/Task.subtasks) — a document that
 * grows without bound is the thing this module put submissions, updates and
 * time entries in their own collections to avoid. Fifty is far past the point
 * where the right answer is two tasks rather than one.
 */
const MAX_SUBTASKS = 50;

// ===== Recurrence =====

const FREQUENCY = {
  ONCE: 'ONCE',
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
  MONTHLY: 'MONTHLY',
  YEARLY: 'YEARLY',
};
const FREQUENCIES = Object.values(FREQUENCY);

const FREQUENCY_LABELS = {
  ONCE: 'One time',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  YEARLY: 'Yearly',
};

/** Sunday-first, matching JS `Date.getDay()` so an index IS the weekday. */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ===== Reminders =====

/**
 * Where a reminder lands.
 *
 * WhatsApp is what the brief asked for and is NOT wired: this portal has no
 * WhatsApp Business sender, and pretending otherwise would mean a channel that
 * silently drops every message. APP is the push notification the Android app
 * already receives plus the in-portal bell; EMAIL goes through the existing
 * queue. If a WhatsApp sender is ever connected, it slots in here and the
 * worker needs one more case — nothing else changes.
 */
const REMINDER_CHANNEL = { APP: 'APP', EMAIL: 'EMAIL' };
const REMINDER_CHANNELS = Object.values(REMINDER_CHANNEL);
const REMINDER_CHANNEL_LABELS = { APP: 'App notification', EMAIL: 'Email' };

const REMINDER_UNIT = { MINUTES: 'MINUTES', HOURS: 'HOURS', DAYS: 'DAYS' };
const REMINDER_UNITS = Object.values(REMINDER_UNIT);
const UNIT_MINUTES = { MINUTES: 1, HOURS: 60, DAYS: 24 * 60 };

/** Before the deadline, or chasing after it. */
const REMINDER_WHEN = { BEFORE: 'BEFORE', AFTER: 'AFTER' };
const REMINDER_WHENS = Object.values(REMINDER_WHEN);

/** A reminder rule as a signed offset in minutes from the due date. */
function reminderOffsetMinutes(rule) {
  const n = Math.abs(Number(rule?.amount) || 0);
  const mins = n * (UNIT_MINUTES[rule?.unit] || 1);
  return rule?.when === REMINDER_WHEN.AFTER ? mins : -mins;
}

/** The idempotence key a fired reminder is recorded under. See the worker. */
function reminderKey(rule) {
  return `${rule.channel}:${rule.when}:${rule.amount}:${rule.unit}`;
}

/** "1 day before", "4 hours after" — one wording, used by every client. */
function reminderLabel(rule) {
  const n = Math.abs(Number(rule?.amount) || 0);
  const unit = String(rule?.unit || 'MINUTES').toLowerCase().replace(/s$/, '');
  const when = rule?.when === REMINDER_WHEN.AFTER ? 'after' : 'before';
  return `${n} ${unit}${n === 1 ? '' : 's'} ${when}`;
}

// ===== Attachments =====

/** How a file hung on a task is rendered. A voice note is its own thing. */
const EVIDENCE_KINDS = ['document', 'image', 'video', 'audio', 'other'];

function evidenceKindFor(mimeType = '', name = '') {
  const m = String(mimeType).toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf' || /officedocument|ms-excel|msword/.test(m)) return 'document';
  if (/\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name)) return 'image';
  if (/\.(mp4|mov|webm|mkv)$/i.test(name)) return 'video';
  if (/\.(mp3|m4a|wav|amr|ogg|webm)$/i.test(name)) return 'audio';
  if (/\.(pdf|docx?|xlsx?|pptx?|csv|txt)$/i.test(name)) return 'document';
  return 'other';
}

// ===== The feed =====

/**
 * What one row of a task's history is.
 *
 * ONE collection holds all of it (models/TaskUpdate) — the status moves, the
 * remarks, the files. The module this replaced kept three (TaskActivity,
 * TaskComment, TaskSubmission) and a task page opened by querying all three and
 * merging them in the browser, which meant three ways for the same event to be
 * worded and a sort that could not be paged.
 */
const UPDATE_KINDS = [
  'CREATED', 'STATUS', 'COMMENT', 'EDITED', 'ASSIGNED', 'REMINDER',
  // Added 2026-09-21 (second pass). Each is a distinct THING THAT HAPPENED, so
  // the feed can word it and colour it for itself rather than every one of them
  // arriving as a generic remark.
  'ACCEPTED', 'REJECTED', 'DELEGATED', 'SUBTASK',
];

// ===== Legacy =====

/**
 * The words the OLD module stored, and what each becomes.
 *
 * Read by scripts/migrateTasksV3.js and by the model's own pre-validate hook,
 * so a row nobody has migrated yet is still a valid document and an Android
 * build that has not been updated can still write one. Twelve states collapse
 * to three: everything that was "being worked on, blocked, on hold, submitted
 * or under review" is IN_PROGRESS, because to everyone but the person holding
 * it those are the same thing — it is not done yet.
 */
const LEGACY_STATUS_MAP = {
  // the four the module had before the 2026-09-17 rework
  Todo: STATUS.PENDING,
  InProgress: STATUS.IN_PROGRESS,
  Review: STATUS.IN_PROGRESS,
  Done: STATUS.COMPLETED,
  // the twelve that rework introduced
  ASSIGNED: STATUS.PENDING,
  ACCEPTED: STATUS.IN_PROGRESS,
  SUBMITTED: STATUS.IN_PROGRESS,
  UNDER_REVIEW: STATUS.IN_PROGRESS,
  APPROVED: STATUS.COMPLETED,
  REJECTED: STATUS.IN_PROGRESS,
  DECLINED: STATUS.CANCELLED,
  BLOCKED: STATUS.IN_PROGRESS,
  ON_HOLD: STATUS.IN_PROGRESS,
};

/** Whatever came in — old word, new word, lower case — as a current status. */
function normaliseStatus(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (TASK_STATUS.includes(raw)) return raw;
  if (LEGACY_STATUS_MAP[raw]) return LEGACY_STATUS_MAP[raw];
  const upper = raw.toUpperCase().replace(/[\s-]+/g, '_');
  if (TASK_STATUS.includes(upper)) return upper;
  return LEGACY_STATUS_MAP[upper] || null;
}

module.exports = {
  KIND_TASK,
  KIND_REQUEST,
  TASK_KINDS,
  STATUS,
  TASK_STATUS,
  TERMINAL_STATUS,
  OPEN_STATUS,
  LABELS,
  statusLabel,
  TRANSITIONS,
  transitionFor,
  isTerminal,
  isOverdue,
  ACCEPTANCE,
  ACCEPTANCE_STATES,
  ACCEPTANCE_LABELS,
  isDeclined,
  isAwaitingAcceptance,
  TASK_PRIORITY,
  DEFAULT_PRIORITY,
  DEFAULT_TASK_POINTS,
  MAX_TASK_POINTS,
  MAX_SUBTASKS,
  FREQUENCY,
  FREQUENCIES,
  FREQUENCY_LABELS,
  WEEKDAYS,
  REMINDER_CHANNEL,
  REMINDER_CHANNELS,
  REMINDER_CHANNEL_LABELS,
  REMINDER_UNIT,
  REMINDER_UNITS,
  UNIT_MINUTES,
  REMINDER_WHEN,
  REMINDER_WHENS,
  reminderOffsetMinutes,
  reminderKey,
  reminderLabel,
  EVIDENCE_KINDS,
  evidenceKindFor,
  UPDATE_KINDS,
  LEGACY_STATUS_MAP,
  normaliseStatus,
};
