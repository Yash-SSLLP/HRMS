/**
 * The task vocabulary, mirrored for the browser.
 *
 * REWRITTEN 2026-09-21. This is PRESENTATION ONLY — the server's
 * config/tasks.js is the single source of truth for what a status is, which
 * moves are legal and who may make them, and it is the server that says which
 * buttons to draw (services/taskAccess.capabilitiesFor, returned as `can` on
 * the detail response). What lives here is colour, wording and date phrasing:
 * the things a server has no opinion about.
 *
 * The module this replaces had the client deriving its own buttons from the
 * status and the user's id, in two places, with two sets of bugs. If you find
 * yourself about to write a rule here, it belongs on the server.
 */

// ===== States =====

export const STATUS = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

export const TASK_STATUS = Object.values(STATUS);
export const TERMINAL = [STATUS.COMPLETED, STATUS.CANCELLED];

const LABELS = {
  TASK: {
    PENDING: 'Pending',
    IN_PROGRESS: 'In progress',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
  },
  REQUEST: {
    PENDING: 'Open',
    IN_PROGRESS: 'Looking into it',
    COMPLETED: 'Answered',
    CANCELLED: 'Withdrawn',
  },
};

export const statusLabel = (status, kind = 'TASK') =>
  (LABELS[kind] || LABELS.TASK)[status] || status || '';

/**
 * The colour of a state.
 *
 * Amber for not started, blue for in hand, green for done, grey for called
 * off — and RED is reserved for overdue, which is not a status. A row that is
 * late is drawn from `overdueStyle` instead, so the one loud colour on the page
 * always means the same thing.
 */
export const STATUS_STYLES = {
  PENDING: 'bg-amber-50 text-amber-700 border border-amber-200',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 border border-blue-200',
  COMPLETED: 'bg-green-50 text-green-700 border border-green-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border border-gray-200',
};
export const OVERDUE_STYLE = 'bg-red-50 text-red-700 border border-red-200';

export const statusStyle = (status, overdue = false) =>
  (overdue ? OVERDUE_STYLE : STATUS_STYLES[status]) || STATUS_STYLES.PENDING;

/** The word for a row in a sentence. */
export const kindNoun = (kind) => (kind === 'REQUEST' ? 'request' : 'task');

// ===== Priority =====

export const TASK_PRIORITY = ['High', 'Medium', 'Low'];

export const PRIORITY_CHIPS = {
  High: 'bg-red-50 text-red-700 border border-red-200',
  Medium: 'bg-gray-100 text-gray-600 border border-gray-200',
  Low: 'bg-slate-50 text-slate-500 border border-slate-200',
};

/** The colour of the selected priority pill in the assign form. */
export const PRIORITY_ACTIVE = {
  High: 'bg-red-600 text-white border-red-600',
  Medium: 'bg-amber-500 text-white border-amber-500',
  Low: 'bg-slate-500 text-white border-slate-500',
};

// ===== Recurrence =====

export const FREQUENCIES = ['ONCE', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

export const FREQUENCY_LABELS = {
  ONCE: 'One time',
  DAILY: 'Daily',
  WEEKLY: 'Weekly',
  MONTHLY: 'Monthly',
  YEARLY: 'Yearly',
};

export const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Weekly · every Fri", for a list row. */
export function repeatLabel(repeat) {
  if (!repeat || !repeat.frequency || repeat.frequency === 'ONCE') return '';
  const base = FREQUENCY_LABELS[repeat.frequency] || repeat.frequency;
  if (repeat.frequency === 'WEEKLY' && repeat.weekdays?.length) {
    const days = repeat.weekdays.map((d) => WEEKDAY_NAMES[d]?.slice(0, 3)).filter(Boolean);
    return `${base} · every ${days.join(', ')}`;
  }
  if (repeat.frequency === 'MONTHLY' && repeat.monthDay) {
    return `${base} · on the ${ordinal(repeat.monthDay)}`;
  }
  return base;
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// ===== Reminders =====

export const REMINDER_CHANNELS = [
  { key: 'APP', label: 'App & portal' },
  { key: 'EMAIL', label: 'Email' },
];

export const REMINDER_UNITS = ['MINUTES', 'HOURS', 'DAYS'];
export const UNIT_LABELS = { MINUTES: 'minutes', HOURS: 'hours', DAYS: 'days' };

/** "1 day before", "4 hours after" — the same wording the server uses. */
export function reminderLabel(rule) {
  if (!rule) return '';
  const n = Math.abs(Number(rule.amount) || 0);
  const unit = String(rule.unit || 'MINUTES').toLowerCase().replace(/s$/, '');
  const when = rule.when === 'AFTER' ? 'after' : 'before';
  return `${n} ${unit}${n === 1 ? '' : 's'} ${when}`;
}

// ===== Dates =====

const MS_DAY = 86400000;

const timeOf = (d) => new Date(d).toLocaleTimeString('en-IN', {
  hour: 'numeric', minute: '2-digit', hour12: true,
});

const dateOf = (d) => new Date(d).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short',
});

/**
 * When it is due, said the way somebody glancing at a row wants it.
 *
 * Relative near the present ("Today, 6:00 pm", "Tomorrow"), absolute further
 * out. Twelve-hour with am/pm throughout, which is the portal-wide rule for
 * every time of day.
 */
export function dueLabel(dueDate, status) {
  if (!dueDate) return { text: 'No deadline', tone: 'none' };

  const due = new Date(dueDate);
  const now = new Date();
  const done = TERMINAL.includes(status);

  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(due) - startOf(now)) / MS_DAY);

  if (!done && due < now) {
    const lateDays = Math.floor((now - due) / MS_DAY);
    return {
      text: lateDays >= 1 ? `${lateDays} day${lateDays === 1 ? '' : 's'} overdue` : `Overdue · ${timeOf(due)}`,
      tone: 'overdue',
    };
  }
  if (days === 0) return { text: `Today, ${timeOf(due)}`, tone: done ? 'none' : 'today' };
  if (days === 1) return { text: `Tomorrow, ${timeOf(due)}`, tone: done ? 'none' : 'soon' };
  if (days === -1) return { text: `Yesterday, ${timeOf(due)}`, tone: 'none' };
  if (days > 1 && days <= 6) {
    return {
      text: `${WEEKDAY_NAMES[due.getDay()]}, ${timeOf(due)}`,
      tone: done ? 'none' : 'soon',
    };
  }
  const withYear = due.getFullYear() !== now.getFullYear();
  return {
    text: `${dateOf(due)}${withYear ? ` ${due.getFullYear()}` : ''}, ${timeOf(due)}`,
    tone: 'none',
  };
}

export const DUE_TONES = {
  overdue: 'text-red-600 font-medium',
  today: 'text-amber-600 font-medium',
  soon: 'text-gray-600',
  none: 'text-gray-500',
};

/** "2 hours ago", for a feed. */
export function timeAgo(when) {
  if (!when) return '';
  const secs = Math.floor((Date.now() - new Date(when).getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(when).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** mm:ss for a recording's length. */
export function duration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// ===== The chip bar =====

/** The date windows above every list, in the order they are drawn. */
export const RANGES = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['nextWeek', 'Next week'],
  ['all', 'All time'],
  ['custom', 'Custom'],
];

/**
 * The counter boxes, in the order the brief's app draws them.
 *
 * They DO NOT OVERLAP — the server counts each task in exactly one of the first
 * four, so they sum to the total. In Time and Delayed are a breakdown OF
 * Completed and are drawn as a second, quieter row.
 */
export const COUNTERS = [
  ['overdue', 'Overdue', 'text-red-600', 'bg-red-500'],
  ['pending', 'Pending', 'text-amber-600', 'bg-amber-500'],
  ['inProgress', 'In progress', 'text-blue-600', 'bg-blue-500'],
  ['completed', 'Completed', 'text-green-600', 'bg-green-500'],
];

export const SUB_COUNTERS = [
  ['inTime', 'In time', 'text-green-600', 'bg-green-500'],
  ['delayed', 'Delayed', 'text-orange-600', 'bg-orange-500'],
];

// ===== Odds and ends =====

export const personName = (p) =>
  (typeof p === 'string' ? p : [p?.firstName, p?.lastName].filter(Boolean).join(' ').trim()) || '';

/** "Megha, Sonu and 2 more" — a people list that does not wrap a row. */
export function assigneeNames(assignees = [], max = 2) {
  const names = assignees
    .map((a) => a.name || personName(a.user))
    .filter(Boolean);
  if (!names.length) return '—';
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
}

export const isTerminal = (status) => TERMINAL.includes(status);

export const isOverdue = (task) => {
  if (!task?.dueDate || isTerminal(task.status)) return false;
  return new Date(task.dueDate) < new Date();
};
