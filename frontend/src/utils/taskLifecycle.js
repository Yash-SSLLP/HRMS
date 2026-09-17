/**
 * Client mirror of the task lifecycle.
 *
 * Mirrors backend/config/taskWorkflow.js. The SERVER is the enforcement
 * boundary — it decides what may follow what and who may do it, and refuses
 * anything else — so nothing here is a rule. What lives here is what the
 * browser needs in order to DRAW the module: the word for a status, the colour
 * of a chip, which board column a task belongs in, and how a due date reads.
 *
 * WHY MIRROR IT AT ALL rather than asking. The alternative is a round trip
 * before a chip can be coloured, on every row of a list of two hundred. The
 * mirror is small, it is only ever presentational, and when it is wrong the
 * worst that happens is a button appears that the server then refuses with a
 * sentence — which is exactly what `GET /tasks/:id` returns `transitions` for.
 * Keep it in step when the server's table changes.
 */

export const TASK_STATUS = [
  'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'SUBMITTED', 'UNDER_REVIEW',
  'APPROVED', 'COMPLETED', 'REJECTED', 'DECLINED', 'BLOCKED', 'ON_HOLD', 'CANCELLED',
];

export const STATUS_LABELS = {
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
 * Chip colours.
 *
 * Deliberately NOT a rainbow. Grey is "nothing is happening yet", blue is "work
 * is under way", amber is "somebody is waiting on somebody", green is done and
 * red is a problem — so a board can be read at arm's length without anybody
 * learning twelve colours.
 */
export const STATUS_STYLES = {
  ASSIGNED: 'bg-gray-100 text-gray-700',
  ACCEPTED: 'bg-sky-100 text-sky-800',
  IN_PROGRESS: 'bg-blue-100 text-blue-800',
  SUBMITTED: 'bg-amber-100 text-amber-800',
  UNDER_REVIEW: 'bg-amber-100 text-amber-800',
  APPROVED: 'bg-emerald-100 text-emerald-800',
  COMPLETED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  DECLINED: 'bg-red-100 text-red-800',
  BLOCKED: 'bg-orange-100 text-orange-800',
  ON_HOLD: 'bg-violet-100 text-violet-800',
  CANCELLED: 'bg-gray-200 text-gray-600',
};

export const TASK_PRIORITY = ['Low', 'Medium', 'High', 'Urgent'];

export const PRIORITY_STYLES = {
  Low: 'text-gray-500',
  Medium: 'text-blue-600',
  High: 'text-amber-600',
  Urgent: 'text-red-600',
};

export const PRIORITY_CHIPS = {
  Low: 'bg-gray-100 text-gray-600',
  Medium: 'bg-blue-50 text-blue-700',
  High: 'bg-amber-50 text-amber-700',
  Urgent: 'bg-red-50 text-red-700',
};

export const BOARD_COLUMNS = [
  { key: 'new', label: 'New', statuses: ['ASSIGNED'] },
  { key: 'accepted', label: 'Accepted', statuses: ['ACCEPTED'] },
  { key: 'progress', label: 'In progress', statuses: ['IN_PROGRESS', 'BLOCKED', 'ON_HOLD', 'REJECTED'] },
  { key: 'submitted', label: 'Submitted', statuses: ['SUBMITTED'] },
  { key: 'review', label: 'Review', statuses: ['UNDER_REVIEW', 'APPROVED'] },
  { key: 'done', label: 'Completed', statuses: ['COMPLETED', 'DECLINED', 'CANCELLED'] },
];

export const TERMINAL_STATUS = ['COMPLETED', 'DECLINED', 'CANCELLED'];

const LEGACY = { Todo: 'ASSIGNED', InProgress: 'IN_PROGRESS', Review: 'UNDER_REVIEW', Done: 'COMPLETED' };

/**
 * Whatever a row is carrying, as a lifecycle status.
 *
 * A task that predates the rework and has not been migrated still says 'Todo',
 * and a cached response could hold either — so this is applied wherever a status
 * is read rather than trusting the field.
 * @param {string} value
 * @returns {string}
 */
export const normaliseStatus = (value) => LEGACY[value] || value || 'ASSIGNED';

export const statusLabel = (s) => STATUS_LABELS[normaliseStatus(s)] || s || '';
export const statusStyle = (s) => STATUS_STYLES[normaliseStatus(s)] || 'bg-gray-100 text-gray-700';
export const isTerminal = (s) => TERMINAL_STATUS.includes(normaliseStatus(s));
export const isOpen = (s) => !isTerminal(s);

/** Which board column a status belongs in. */
export function columnOf(status) {
  const s = normaliseStatus(status);
  const col = BOARD_COLUMNS.find((c) => c.statuses.includes(s));
  return col ? col.key : 'progress';
}

/** Past its deadline with work still outstanding. */
export function isOverdue(task) {
  if (!task || !task.dueDate || isTerminal(task.status)) return false;
  return new Date(task.dueDate) < new Date();
}

/**
 * How a deadline reads to somebody glancing at a row.
 *
 * Relative up close ("in 3 hours", "2 days late") and absolute further out,
 * because "due 14 Apr" is more useful than "in 28 days" and "in 3 hours" is far
 * more useful than "due 17 Sep, 5:00 PM" when it is five past two.
 * @param {string|Date} dueDate
 * @param {string} [status]
 * @returns {{text: string, tone: 'overdue'|'soon'|'normal'|'none'}}
 */
export function dueLabel(dueDate, status) {
  if (!dueDate) return { text: '—', tone: 'none' };
  const due = new Date(dueDate);
  const ms = due.getTime() - Date.now();
  const hours = ms / 3600000;
  const days = Math.round(Math.abs(hours) / 24);

  if (isTerminal(status)) {
    return { text: due.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), tone: 'none' };
  }
  if (ms < 0) {
    const late = Math.abs(hours) < 24
      ? `${Math.max(1, Math.round(Math.abs(hours)))}h late`
      : `${days} day${days === 1 ? '' : 's'} late`;
    return { text: late, tone: 'overdue' };
  }
  if (hours < 1) return { text: `in ${Math.max(1, Math.round(hours * 60))} min`, tone: 'soon' };
  if (hours < 24) return { text: `in ${Math.round(hours)}h`, tone: 'soon' };
  if (hours < 24 * 7) return { text: `in ${days} day${days === 1 ? '' : 's'}`, tone: 'normal' };
  return {
    text: due.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: due.getFullYear() === new Date().getFullYear() ? undefined : '2-digit' }),
    tone: 'normal',
  };
}

export const DUE_TONES = {
  overdue: 'text-red-600 font-medium',
  soon: 'text-amber-600',
  normal: 'text-gray-600',
  none: 'text-gray-400',
};

/** "1h 15m" — a duration in minutes, in words. */
export function formatMinutes(mins) {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  if (!m) return '—';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

/** The evidence a task demands, for the submission form's checklist. */
export const REQUIREMENT_LABELS = {
  remarks: 'Remarks',
  checklist: 'Checklist completed',
  attachment: 'Attachment',
  photo: 'Photo',
  location: 'Location',
  signature: 'Signature',
};

export const ASSIGNEE_ROLES = ['Owner', 'Contributor', 'Reviewer', 'Observer'];

/** The workflow step statuses, and how each reads. */
export const STEP_STYLES = {
  Waiting: 'bg-gray-100 text-gray-500',
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Done: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Skipped: 'bg-gray-100 text-gray-400',
};

export const INCENTIVE_OUTCOME_LABELS = {
  early: 'Completed early',
  onTime: 'Completed on time',
  late: 'Up to a day late',
  veryLate: 'More than a day late',
  rejectedFirst: 'Sent back before approval',
};

/** A person's display name from whatever shape the API sent. */
export const personName = (u) => {
  if (!u) return '';
  if (typeof u === 'string') return '';
  return `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.name || '';
};

/** Everyone on a task, as names, however the row was populated. */
export function assigneeNames(task) {
  const rows = task?.assignees || [];
  if (rows.length) {
    return rows.map((a) => personName(a.user) || a.name).filter(Boolean);
  }
  const one = personName(task?.assignedTo);
  return one ? [one] : [];
}
