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
  /**
   * HANDED BACK, AWAITING THE ASSIGNER'S WORD. Added 2026-09-22.
   *
   * The 2026-09-21 rework had three states and no review step: the doer pressed
   * Complete and the task was done. The brief that replaced it asks for the
   * opposite — "when user submit any task then manager should have the option
   * to approve that and on reject that submission the task will reopen again".
   * So finishing is a SUBMISSION and completing is the assigner's act.
   *
   * This is ONE extra state, not the twelve that were removed, and it is the
   * one the board's "In Review" column has to have. It earns its place because
   * it answers a question none of the other three can: the work is out of the
   * doer's hands and not yet accepted. Folding it into IN_PROGRESS would hide
   * a queue the manager is the only person who can clear.
   *
   * It is skipped entirely when `Task.requiresApproval` is false, or when the
   * person finishing is the person who set it (see effectiveTarget).
   */
  SUBMITTED: 'SUBMITTED',
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
    SUBMITTED: 'In review',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
  },
  [KIND_REQUEST]: {
    PENDING: 'Open',
    IN_PROGRESS: 'Looking into it',
    SUBMITTED: 'Answer sent',
    COMPLETED: 'Answered',
    CANCELLED: 'Withdrawn',
  },
};

function statusLabel(status, kind = KIND_TASK) {
  return (LABELS[kind] || LABELS[KIND_TASK])[status] || status || '';
}

/**
 * The board, left to right. ONE list, served to both clients from
 * `GET /api/tasks/meta`, so a column cannot be called "In Review" on the web
 * and "Submitted" on the phone.
 *
 * CANCELLED is deliberately not a column: a called-off task is not a stage of
 * the work, and a fifth column of them would be the widest and emptiest thing
 * on the screen. It is reachable from the list with the status filter.
 */
const BOARD_COLUMNS = [
  { key: STATUS.PENDING, label: 'To do' },
  { key: STATUS.IN_PROGRESS, label: 'In progress' },
  { key: STATUS.SUBMITTED, label: 'Review' },
  { key: STATUS.COMPLETED, label: 'Done' },
];

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
    { to: STATUS.SUBMITTED, by: ['doer'], note: true },
    { to: STATUS.COMPLETED, by: ['doer', 'assigner'], note: true },
    { to: STATUS.CANCELLED, by: ['assigner'], note: true },
  ],
  IN_PROGRESS: [
    { to: STATUS.SUBMITTED, by: ['doer'], note: true },
    { to: STATUS.COMPLETED, by: ['doer', 'assigner'], note: true },
    { to: STATUS.PENDING, by: ['assigner'], note: true },
    { to: STATUS.CANCELLED, by: ['assigner'], note: true },
  ],
  // The review desk. Approving is the assigner's; sending it back is too, and
  // it is the move the brief calls "reject that submission … the task will
  // reopen again" — it lands on IN_PROGRESS with the same person still on it,
  // because reassigning from scratch would throw away everything already done.
  SUBMITTED: [
    { to: STATUS.COMPLETED, by: ['assigner'], note: true },
    { to: STATUS.IN_PROGRESS, by: ['assigner'], note: true },
    // A doer may withdraw their own submission — they spotted the mistake
    // before the manager did, and making them wait for a rejection to fix it is
    // the sort of small indignity that stops people submitting at all.
    { to: STATUS.PENDING, by: ['doer', 'assigner'], note: true },
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

/**
 * Where a move ACTUALLY lands, once the review rule is applied.
 *
 * A doer pressing Complete on a task that has to be approved is not finishing
 * it — they are handing it in. Rather than refusing the move (which would break
 * every Android build that predates this change, and read as a bug to anyone
 * who did the work), the server quietly redirects it to SUBMITTED and tells the
 * manager there is something to look at.
 *
 * Two exemptions, both obvious once stated:
 *   - `requiresApproval === false` — the assigner chose not to review it.
 *   - the mover IS the assigner — approving your own submission is a round trip
 *     to nowhere, and a manager working a task they set themselves should not
 *     have to press two buttons.
 */
function effectiveTarget(task, role, to, userId) {
  if (to !== STATUS.COMPLETED) return to;
  if (role !== 'doer') return to;
  if (task?.kind && task.kind !== KIND_TASK) return to;   // a request is answered, not reviewed
  if (task?.requiresApproval === false) return to;
  // Somebody reviewing their own submission is a round trip to nowhere.
  const setter = String(task?.createdBy?._id || task?.createdBy || '');
  if (setter && setter === String(userId || '')) return to;
  return STATUS.SUBMITTED;
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
  // A SUBMITTED task is NOT overdue. The doer handed it in; whether it has been
  // looked at since is the assigner's business, and painting it red in the
  // doer's list would blame them for somebody else's inbox. The "In review"
  // counter is where that queue shows up instead. (2026-09-22.)
  if (task.status === STATUS.SUBMITTED) return false;
  return new Date(task.dueDate).getTime() < now.getTime();
}

/** Handed in and waiting on somebody to look at it. */
function isInReview(task) {
  return task?.status === STATUS.SUBMITTED;
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

/**
 * How urgent it is — THREE levels, and they colour the whole row.
 *
 * Changed 2026-09-22 from `['High','Medium','Low']`. The brief names the top
 * level "urgent" and gives each level a colour, and the live data had already
 * drifted there on its own: of 59 tasks, 50 carried a priority of `Urgent` that
 * no picker offered and no filter matched, left behind by a rework that renamed
 * the level without migrating the rows. So `High` becomes `Urgent` rather than
 * the other way round — it is the word the company is already using.
 */
const TASK_PRIORITY = ['Urgent', 'Medium', 'Low'];
const DEFAULT_PRIORITY = 'Medium';

/** Words that have meant one of the three, in this collection or another. */
const LEGACY_PRIORITY_MAP = {
  High: 'Urgent', HIGH: 'Urgent', Critical: 'Urgent', Highest: 'Urgent', Immediate: 'Urgent',
  Normal: 'Medium', MEDIUM: 'Medium', Moderate: 'Medium',
  Lowest: 'Low', LOW: 'Low', Minor: 'Low',
};

/** Whatever came in — old word, new word, any case — as a current priority. */
function normalisePriority(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (TASK_PRIORITY.includes(raw)) return raw;
  if (LEGACY_PRIORITY_MAP[raw]) return LEGACY_PRIORITY_MAP[raw];
  const title = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  if (TASK_PRIORITY.includes(title)) return title;
  return LEGACY_PRIORITY_MAP[title] || null;
}

/**
 * THE COLOUR OF A TASK — and the reason it is defined on the server.
 *
 * The brief: *"if any task is pending then the whole task should be in the
 * priority color, and if the task is completed then show that in Green"*. So
 * this is not a chip's palette, it is the accent behind an entire row, card and
 * detail header, in two clients that must not drift. Hard-coding four hexes in
 * the web bundle and four more in the app is how a red in one place becomes a
 * slightly different red in the other, and nobody notices until somebody puts
 * the two screens side by side.
 *
 * Shipped as data on `GET /api/tasks/meta` for exactly that reason.
 *
 * `bg` is the tint behind the row; `solid` is the 4px rail down its left edge
 * and the dot in a dropdown; `border` is the hairline; `ink` is text that has
 * to sit ON the tint and clears 4.5:1 against it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It does not colour the STATUS — amber /
 * blue / violet / green / grey stay the status chip's, per
 * utils/taskLifecycle — and it does not make an overdue task red. Overdue is
 * shown as a SOLID red chip and a red deadline, so that a late Low-priority
 * task still reads as low priority rather than being promoted by being late.
 */
const PRIORITY_COLORS = {
  Urgent: { ink: '#B42318', bg: '#FEF3F2', border: '#FDA29B', solid: '#D92D20' },
  Medium: { ink: '#B54708', bg: '#FFFAEB', border: '#FEC84B', solid: '#F79009' },
  Low: { ink: '#475467', bg: '#F2F4F7', border: '#D0D5DD', solid: '#98A2B3' },
};

/** Finished. Green beats the priority colour — the brief's second sentence. */
const DONE_COLOR = { ink: '#027A48', bg: '#ECFDF3', border: '#6CE9A6', solid: '#12B76A' };

/** Called off. Grey, and the row is drawn faded. */
const CANCELLED_COLOR = { ink: '#667085', bg: '#F9FAFB', border: '#EAECF0', solid: '#98A2B3' };

/**
 * The accent for one row — the ONE rule every list, card and header obeys.
 * Returns `{ key, ink, bg, border, solid }`; `key` is what a client keys off.
 */
function accentFor(task) {
  if (task?.status === STATUS.COMPLETED) return { key: 'DONE', ...DONE_COLOR };
  if (task?.status === STATUS.CANCELLED) return { key: 'CANCELLED', ...CANCELLED_COLOR };
  const p = normalisePriority(task?.priority) || DEFAULT_PRIORITY;
  return { key: p, ...(PRIORITY_COLORS[p] || PRIORITY_COLORS[DEFAULT_PRIORITY]) };
}

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
 * How many pieces one task may be split into.
 *
 * REWORKED 2026-09-22. A piece used to be an embedded row on the parent
 * (`Task.subtasks`) with a title, an owner and a tick — and the cap existed to
 * stop a document growing without bound. A piece is now a TASK OF ITS OWN
 * (`Task.parentTask`), because the brief asks it to do everything a task does:
 * carry its own share of the points, its own deadline, its own progress, its
 * own accept/decline, its own submission, and to appear in its owner's list.
 *
 * The cap survives for a different reason: fifty pieces on one task is not a
 * plan, it is a project, and the honest answer at that point is more than one
 * task. It is also what stops a loop in a client turning one POST into a
 * thousand rows.
 */
const MAX_SUBTASKS = 50;
/** One task's pieces, and its pieces' pieces. Depth 3 is a plan; 4 is a maze. */
const MAX_SPLIT_DEPTH = 3;

// ===== Progress =====

/**
 * How far along, as a percentage the doer types in themselves.
 *
 * Asked for in the brief — *"they can put how much progression they did till
 * now"*. It is DECLARED, not inferred: nothing in this module can tell how much
 * of a job is left, and a bar computed from elapsed time against the deadline
 * is a lie that looks like data. A parent's figure is the only derived one, and
 * it is the points-weighted mean of its pieces (services/taskEngine).
 */
const PROGRESS_MIN = 0;
const PROGRESS_MAX = 100;
/** The quick buttons a client offers beside the slider. */
const PROGRESS_STEPS = [0, 25, 50, 75, 100];

function clampProgress(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, n));
}

// ===== Asking for more time =====

/**
 * The doer's third answer, after accept and decline: *"I will do it, but not by
 * then"*. Added 2026-09-22 at the user's request.
 *
 * It is NOT a status — the work carries on while the answer is awaited, which
 * is the whole point of asking rather than stopping. Approving it moves the
 * deadline; declining it leaves everything exactly as it was and says so.
 */
const EXTENSION_STATUS = { PENDING: 'PENDING', APPROVED: 'APPROVED', DECLINED: 'DECLINED' };
const EXTENSION_STATES = Object.values(EXTENSION_STATUS);

// ===== Sorting a list =====

/**
 * The orders the list offers, and the mongo sort each one means.
 *
 * `pending` is the one worth explaining: it is "how long has this been sitting
 * there", which is the oldest `assignedAt` first — a task set three weeks ago
 * and never touched is the one a manager wants at the top, and sorting by
 * deadline alone never surfaces it because it may not have one.
 *
 * `priority` cannot sort on the stored string (Low < Medium < Urgent
 * alphabetically is exactly wrong), so the controller sorts on a computed rank.
 *
 * `dir` is each order's NATURAL way round — what a request without `?dir=`
 * gets, and what GET /tasks/meta tells the clients so their arrows show it.
 * `due` runs latest deadline first since 2026-09-25 (the owner's call: the list
 * opens on "Due date ↓"); a task with no deadline sorts after every dated one.
 */
const SORTS = {
  due: { label: 'Due date', field: 'dueDate', dir: -1 },
  assigned: { label: 'Day assigned', field: 'assignedAt', dir: -1 },
  pending: { label: 'Pending days', field: 'assignedAt', dir: 1, openFirst: true },
  points: { label: 'Points', field: 'points', dir: -1 },
  priority: { label: 'Priority', field: 'priorityRank', dir: 1, computed: true },
  title: { label: 'Title', field: 'title', dir: 1 },
  created: { label: 'Newest first', field: 'createdAt', dir: -1 },
};
const SORT_KEYS = Object.keys(SORTS);
const DEFAULT_SORT = 'due';

/** Urgent first. The number a `$addFields` stage puts on each row to sort by. */
const PRIORITY_RANK = { Urgent: 0, Medium: 1, Low: 2 };

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
  // Added 2026-09-22 (third pass), same reasoning. A submission that came back
  // and a deadline that moved are the two things people argue about afterwards,
  // and a feed that records both as "status changed" cannot settle it.
  'SUBMITTED', 'APPROVED', 'SENT_BACK', 'PROGRESS', 'SPLIT', 'CLAIMED',
  'EXTENSION_ASKED', 'EXTENSION_DECIDED',
  // A task that went to the wrong person and was handed to the right one. Its
  // own word because it is the opposite of DELEGATED in who stays answerable.
  'TRANSFERRED',
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
  Review: STATUS.SUBMITTED,
  Done: STATUS.COMPLETED,
  // the twelve that rework introduced
  ASSIGNED: STATUS.PENDING,
  ACCEPTED: STATUS.IN_PROGRESS,
  // SUBMITTED is a CURRENT status again as of 2026-09-22 and so is no longer
  // mapped away — `normaliseStatus` checks TASK_STATUS first, and a row written
  // by the twelve-status module meant exactly what the word means now.
  UNDER_REVIEW: STATUS.SUBMITTED,
  APPROVED: STATUS.COMPLETED,
  REJECTED: STATUS.IN_PROGRESS,
  DECLINED: STATUS.CANCELLED,
  BLOCKED: STATUS.IN_PROGRESS,
  ON_HOLD: STATUS.IN_PROGRESS,
};

/**
 * EVERY SPELLING that means one of `targets` — the current word and every
 * legacy one that normalises to it.
 *
 * Added 2026-09-22 after the morning digest broke. A QUERY cannot call
 * `normaliseStatus`: the model normalises on SAVE, so a row nobody has
 * re-saved since the rework still carries the word it was written with, and of
 * 59 live tasks 49 were still `ASSIGNED`. A worker asking for
 * `status: { $ne: 'Done' }` therefore matched everything — including the
 * completed and cancelled work it was meant to exclude — and would have nudged
 * people about tasks they finished last week.
 *
 * Use this wherever a status appears in a FILTER rather than on a document.
 *
 * @param {...string} targets - current statuses
 * @returns {string[]} every word a stored row might hold for them
 */
function spellingsOf(...targets) {
  const want = new Set(targets.filter((t) => TASK_STATUS.includes(t)));
  const out = [...want];
  for (const [legacy, current] of Object.entries(LEGACY_STATUS_MAP)) {
    if (want.has(current)) out.push(legacy);
  }
  return [...new Set(out)];
}

/**
 * The value for a `kind` condition in a FILTER — where TASK includes a row
 * that has no `kind` at all.
 *
 * Added 2026-09-24, the sibling of `spellingsOf` for the other field the
 * rework introduced. `kind` defaults to TASK in the schema, but a default is
 * applied when a document is HYDRATED, never inside a query — and every row
 * set before the 2026-09-21 rework has no `kind` (scripts/migrateTasksV3.js
 * stamps it, and has never been run). So `{ kind: 'TASK' }` matched none of
 * them: 57 of the 62 live tasks were missing from every list, board, tile and
 * dashboard, while the Tasks badge, which never filtered on kind, went on
 * counting them — a red number over an empty page.
 *
 * `null` inside `$in` matches a missing field as well as an explicit null.
 *
 * @param {string} kind - KIND_TASK or KIND_REQUEST
 * @returns {string|Object} what to put after `kind:`
 */
function kindFilter(kind) {
  return kind === KIND_REQUEST ? KIND_REQUEST : { $in: [KIND_TASK, null] };
}

/**
 * An aggregation stage that rewrites `$status` (and, optionally, a nested one)
 * into the CURRENT vocabulary before anything downstream compares it.
 *
 * The sibling of `spellingsOf` for the other half of the problem. A `$group`
 * cannot call `normaliseStatus` either, and expanding every `$eq` into an `$in`
 * makes a counter pipeline unreadable — so the words are fixed ONCE, at the
 * top, and every comparison below is written against the five current ones.
 *
 * @param {string} [field] - the path to rewrite, default 'status'
 * @returns {Object} an `$addFields` stage
 */
function normaliseStatusStage(field = 'status') {
  const branches = Object.entries(LEGACY_STATUS_MAP).map(([legacy, current]) => ({
    case: { $eq: [`$${field}`, legacy] },
    then: current,
  }));
  return { $addFields: { [field]: { $switch: { branches, default: `$${field}` } } } };
}

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
  BOARD_COLUMNS,
  TRANSITIONS,
  transitionFor,
  effectiveTarget,
  isTerminal,
  isOverdue,
  isInReview,
  ACCEPTANCE,
  ACCEPTANCE_STATES,
  ACCEPTANCE_LABELS,
  isDeclined,
  isAwaitingAcceptance,
  TASK_PRIORITY,
  DEFAULT_PRIORITY,
  LEGACY_PRIORITY_MAP,
  normalisePriority,
  PRIORITY_COLORS,
  DONE_COLOR,
  CANCELLED_COLOR,
  accentFor,
  PRIORITY_RANK,
  DEFAULT_TASK_POINTS,
  MAX_TASK_POINTS,
  MAX_SUBTASKS,
  MAX_SPLIT_DEPTH,
  PROGRESS_MIN,
  PROGRESS_MAX,
  PROGRESS_STEPS,
  clampProgress,
  EXTENSION_STATUS,
  EXTENSION_STATES,
  SORTS,
  SORT_KEYS,
  DEFAULT_SORT,
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
  spellingsOf,
  kindFilter,
  normaliseStatusStage,
  normaliseStatus,
};
