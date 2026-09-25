/**
 * The task vocabulary, mirrored for the browser.
 *
 * REWRITTEN 2026-09-22 (previously 2026-09-21). This is PRESENTATION ONLY — the
 * server's config/tasks.js is the single source of truth for what a status is,
 * which moves are legal and who may make them, and it is the server that says
 * which buttons to draw (services/taskAccess.capabilitiesFor, returned as `can`
 * on every row). What lives here is colour, wording and date phrasing: the
 * things a server has no opinion about.
 *
 * The module this replaces had the client deriving its own buttons from the
 * status and the user's id, in two places, with two sets of bugs. If you find
 * yourself about to write a rule here, it belongs on the server.
 */

// ===== States =====

export const STATUS = {
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  /**
   * Handed in, awaiting the assigner's word. Added 2026-09-22 alongside the
   * server's fifth state: finishing is a SUBMISSION and completing is the
   * assigner's act. It is the state the board's "In review" column has to have.
   */
  SUBMITTED: 'SUBMITTED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
};

export const TASK_STATUS = Object.values(STATUS);
export const TERMINAL = [STATUS.COMPLETED, STATUS.CANCELLED];

const LABELS = {
  TASK: {
    PENDING: 'Pending',
    IN_PROGRESS: 'In progress',
    SUBMITTED: 'In review',
    COMPLETED: 'Completed',
    CANCELLED: 'Cancelled',
  },
  REQUEST: {
    PENDING: 'Open',
    IN_PROGRESS: 'Looking into it',
    SUBMITTED: 'Answer sent',
    COMPLETED: 'Answered',
    CANCELLED: 'Withdrawn',
  },
};

export const statusLabel = (status, kind = 'TASK') =>
  (LABELS[kind] || LABELS.TASK)[status] || status || '';

/**
 * The board, left to right — a mirror of config/tasks.BOARD_COLUMNS.
 *
 * `GET /api/tasks/board` returns its own columns with their labels, and the
 * board page draws THOSE. This copy is for the moments before that answer
 * lands: the four skeleton columns a loading board shows, and any place that
 * needs the order without a fetch. If the two ever disagree, the server wins.
 *
 * CANCELLED is not a column here for the same reason it is not one there: a
 * called-off task is not a stage of the work.
 */
export const BOARD_COLUMNS = [
  { key: STATUS.PENDING, label: 'To do' },
  { key: STATUS.IN_PROGRESS, label: 'In progress' },
  { key: STATUS.SUBMITTED, label: 'Review' },
  { key: STATUS.COMPLETED, label: 'Done' },
];

/* ===========================================================================
 * COLOUR — and the one collision worth explaining
 *
 * Three things on a task row want colour, and two of them want red. They are
 * settled like this, everywhere, in both clients:
 *
 *   THE ROW      is tinted by PRIORITY — Urgent red, Medium amber, Low grey —
 *                and turns GREEN the moment it is completed (grey and faded
 *                when it is called off). That palette belongs to the server
 *                (config/tasks.PRIORITY_COLORS) and arrives on every row as
 *                `accent`; the client reads it through
 *                components/task/taskColors.js and never picks it again.
 *
 *   THE STATUS   keeps its own chip: amber pending, blue in hand, VIOLET in
 *                review, green done, grey cancelled. It answers a different
 *                question from the tint — how far along the work is, rather
 *                than how much it matters — so the two are allowed to differ
 *                and an in-review Urgent task reads as both at once.
 *
 *   OVERDUE      is neither. It is not a status, and it deliberately does NOT
 *                change the tint: promoting a late Low task to red would throw
 *                away the only thing the tint is for.
 *
 * So overdue is drawn as a SOLID red chip (white on red) beside the status
 * chip, plus a red due date. Solid is what separates it — an Urgent row is a
 * pale red wash with a red hairline, and a pale red chip laid on that
 * disappears. Nothing else in the module may use solid red.
 * ======================================================================== */

export const STATUS_STYLES = {
  PENDING: 'bg-amber-50 text-amber-700 border border-amber-200',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 border border-blue-200',
  SUBMITTED: 'bg-violet-50 text-violet-700 border border-violet-200',
  COMPLETED: 'bg-green-50 text-green-700 border border-green-200',
  CANCELLED: 'bg-gray-100 text-gray-500 border border-gray-200',
};

/** Solid, per the note above. Never a tint. */
export const OVERDUE_STYLE = 'bg-red-600 text-white border border-red-600';

export const statusStyle = (status, overdue = false) =>
  (overdue ? OVERDUE_STYLE : STATUS_STYLES[status]) || STATUS_STYLES.PENDING;

/** The word for a row in a sentence. */
export const kindNoun = (kind) => (kind === 'REQUEST' ? 'request' : 'task');

// ===== Priority =====

/**
 * Three levels, changed 2026-09-22 from `['High','Medium','Low']`.
 *
 * `High` became `Urgent` rather than the other way round because the live data
 * had already drifted there: most rows carried an `Urgent` no picker offered
 * and no filter matched. See config/tasks.js for the full account.
 */
export const TASK_PRIORITY = ['Urgent', 'Medium', 'Low'];
export const DEFAULT_PRIORITY = 'Medium';

/** Every word that has meant one of the three, in this collection or another. */
const LEGACY_PRIORITY = {
  High: 'Urgent', HIGH: 'Urgent', Critical: 'Urgent', Highest: 'Urgent', Immediate: 'Urgent',
  Normal: 'Medium', MEDIUM: 'Medium', Moderate: 'Medium',
  Lowest: 'Low', LOW: 'Low', Minor: 'Low',
};

/**
 * Whatever came in — old word, new word, any case — as a current priority.
 * Mirrors config/tasks.normalisePriority exactly; a row written by an Android
 * build that predates the rename still has to colour itself.
 */
export function normalisePriority(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (TASK_PRIORITY.includes(raw)) return raw;
  if (LEGACY_PRIORITY[raw]) return LEGACY_PRIORITY[raw];
  const title = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  if (TASK_PRIORITY.includes(title)) return title;
  return LEGACY_PRIORITY[title] || null;
}

/**
 * The priority as a chip class.
 *
 * The legacy keys point at the same strings so `PRIORITY_CHIPS[row.priority]`
 * on an un-migrated row renders a chip rather than an unstyled word — the
 * templates list and the assign form both index it directly.
 */
export const PRIORITY_CHIPS = {
  Urgent: 'bg-red-50 text-red-700 border border-red-200',
  Medium: 'bg-amber-50 text-amber-700 border border-amber-200',
  Low: 'bg-gray-100 text-gray-600 border border-gray-200',
};
PRIORITY_CHIPS.High = PRIORITY_CHIPS.Urgent;
PRIORITY_CHIPS.Critical = PRIORITY_CHIPS.Urgent;
PRIORITY_CHIPS.Normal = PRIORITY_CHIPS.Medium;
PRIORITY_CHIPS.Lowest = PRIORITY_CHIPS.Low;

/** The colour of the selected priority pill in the assign form. */
export const PRIORITY_ACTIVE = {
  Urgent: 'bg-red-600 text-white border-red-600',
  Medium: 'bg-amber-500 text-white border-amber-500',
  Low: 'bg-slate-500 text-white border-slate-500',
};
PRIORITY_ACTIVE.High = PRIORITY_ACTIVE.Urgent;
PRIORITY_ACTIVE.Critical = PRIORITY_ACTIVE.Urgent;
PRIORITY_ACTIVE.Normal = PRIORITY_ACTIVE.Medium;
PRIORITY_ACTIVE.Lowest = PRIORITY_ACTIVE.Low;

// ===== Progress =====

/** The quick buttons beside the slider. `GET /meta` sends the same list. */
export const PROGRESS_STEPS = [0, 25, 50, 75, 100];

export const clampProgress = (value) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
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
 *
 * A SUBMITTED task never reads as overdue here, matching the server: the doer
 * handed it in, and painting their row red because the assigner has not looked
 * at it yet blames them for somebody else's inbox.
 */
export function dueLabel(dueDate, status) {
  if (!dueDate) return { text: 'No deadline', tone: 'none' };

  const due = new Date(dueDate);
  const now = new Date();
  const settled = TERMINAL.includes(status) || status === STATUS.SUBMITTED;

  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(due) - startOf(now)) / MS_DAY);

  if (!settled && due < now) {
    const lateDays = Math.floor((now - due) / MS_DAY);
    return {
      text: lateDays >= 1 ? `${lateDays} day${lateDays === 1 ? '' : 's'} overdue` : `Overdue · ${timeOf(due)}`,
      tone: 'overdue',
    };
  }
  if (days === 0) return { text: `Today, ${timeOf(due)}`, tone: settled ? 'none' : 'today' };
  if (days === 1) return { text: `Tomorrow, ${timeOf(due)}`, tone: settled ? 'none' : 'soon' };
  if (days === -1) return { text: `Yesterday, ${timeOf(due)}`, tone: 'none' };
  if (days > 1 && days <= 6) {
    return {
      text: `${WEEKDAY_NAMES[due.getDay()]}, ${timeOf(due)}`,
      tone: settled ? 'none' : 'soon',
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

/** A date on its own — an extension's new deadline, a submission's day. */
export function dayLabel(when) {
  if (!when) return '';
  const d = new Date(when);
  const withYear = d.getFullYear() !== new Date().getFullYear();
  return `${dateOf(d)}${withYear ? ` ${d.getFullYear()}` : ''}`;
}

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

/** mm:ss for a recording's length. A duration, so not 12-hour. */
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
 * The counters, in the order they are drawn.
 *
 * They DO NOT OVERLAP — the server counts each task in exactly one of them
 * (taskController.countersFor), so they sum to the total and the row can be
 * trusted. In Time and Delayed are a breakdown OF Completed and are drawn as a
 * second, quieter line so nobody adds them in.
 *
 * `inReview` sits between in-progress and completed because that is where the
 * work is: out of the doer's hands, not yet accepted.
 */
export const COUNTERS = [
  ['overdue', 'Overdue', 'text-red-600', 'bg-red-500'],
  ['pending', 'Pending', 'text-amber-600', 'bg-amber-500'],
  ['inProgress', 'In progress', 'text-blue-600', 'bg-blue-500'],
  ['inReview', 'In review', 'text-violet-600', 'bg-violet-500'],
  ['completed', 'Completed', 'text-green-600', 'bg-green-500'],
];

export const SUB_COUNTERS = [
  ['inTime', 'In time', 'text-green-600', 'bg-green-500'],
  ['delayed', 'Delayed', 'text-orange-600', 'bg-orange-500'],
];

// ===== The simplified page (2026-09-25) =====

/**
 * The two piles the page opens on — the user's sketch had exactly these two
 * cards — plus the company-wide one for whoever holds tasks.manage. The keys
 * are the API's `scope` values.
 */
export const PILES = [
  { key: 'mine', label: 'Assigned to me', icon: 'FiInbox' },
  { key: 'delegated', label: 'Assigned by me', icon: 'FiSend' },
  { key: 'all', label: 'All tasks', icon: 'FiLayers', adminOnly: true },
];

/**
 * The five figures in the stat bar, and the query each one stands for.
 *
 * PENDING here means "not finished and not late" — the server's `pending`
 * (not started) plus `inProgress` (started). Two boxes for "not done yet" was
 * one more thing to read on a page the user asked to be simpler, and In
 * progress never had a box of its own anyway. `overdue=false` is what lets a
 * click on it list exactly what it counted (taskController.buildQuery).
 */
export const STAT_BAR = [
  {
    key: 'total', label: 'Total tasks', short: 'Total', icon: 'FiList', colour: '#2a78d6',
    query: {},
  },
  {
    key: 'overdue', label: 'Overdue', short: 'Overdue', icon: 'FiAlertCircle', colour: '#D92D20',
    query: { overdue: 'true' },
  },
  {
    key: 'pending', label: 'Pending', short: 'Pending', icon: 'FiClock', colour: '#F79009',
    query: { status: `${STATUS.PENDING},${STATUS.IN_PROGRESS}`, overdue: 'false' },
  },
  {
    key: 'inReview', label: 'In review', short: 'Review', icon: 'FiEye', colour: '#7c3aed',
    query: { status: STATUS.SUBMITTED },
  },
  {
    key: 'completed', label: 'Completed', short: 'Done', icon: 'FiCheckCircle', colour: '#12B76A',
    query: { status: STATUS.COMPLETED },
  },
];

/** A stat-bar figure out of the server's counters. */
export function statValue(counters = {}, key) {
  if (key === 'pending') return (Number(counters.pending) || 0) + (Number(counters.inProgress) || 0);
  return Number(counters[key]) || 0;
}

/**
 * THE STATUS DROPDOWN ON EVERY ROW — the user's six words, 2026-09-25:
 * Approve · Reject · Delegate · Transfer · In Review · Completed.
 *
 * Presentation only, like everything in this file. WHETHER an item appears is
 * the server's answer (`task.can`, computed per row by
 * services/taskAccess.capabilitiesFor); this only turns those flags into menu
 * items in one fixed order, so the web row and the phone card offer the same
 * list for the same task.
 *
 * Two of the words mean different things depending on which side of the task
 * you are on, and the `key` says which:
 *
 *   Approve   the doer, on a task not yet answered → accept (it starts)
 *             the assigner, on a submission        → approve (it completes)
 *   Reject    the doer                             → decline, with a reason
 *             the assigner, on a submission        → send back, with a reason
 *
 * Completed is left out when Approve is offered: on a submission they are the
 * same move, and two items doing one thing is how a menu stops being trusted.
 * Claim is not one of the six but is offered on an open piece, because without
 * it nobody could take one from the list.
 */
export function statusActions(task) {
  const can = task?.can || {};
  const out = [];
  if (can.canClaim) {
    out.push({ key: 'claim', label: 'Pick it up', hint: 'Nobody is on this piece yet — make it yours', tone: 'blue', icon: 'FiUserPlus' });
  }
  if (can.canApprove) {
    out.push({ key: 'approve', label: 'Approve', hint: 'Sign off the work — it is completed', tone: 'green', icon: 'FiCheckCircle' });
  } else if (can.canAccept) {
    out.push({ key: 'accept', label: 'Approve', hint: 'Accept it and start working on it', tone: 'green', icon: 'FiThumbsUp' });
  }
  if (can.canReject) {
    out.push({ key: 'sendBack', label: 'Reject', hint: 'Send it back with what still needs doing', tone: 'red', icon: 'FiRotateCcw' });
  } else if (can.canDecline) {
    out.push({ key: 'decline', label: 'Reject', hint: 'Turn it down — say why', tone: 'red', icon: 'FiThumbsDown' });
  }
  if (can.canDelegate || can.canSplit) {
    out.push({ key: 'delegate', label: 'Delegate', hint: 'Hand it to someone — you review their work', tone: 'indigo', icon: 'FiGitBranch' });
  }
  if (can.canTransfer) {
    out.push({ key: 'transfer', label: 'Transfer', hint: 'It went to the wrong person — move it fully', tone: 'slate', icon: 'FiRepeat' });
  }
  if (can.canSubmit) {
    out.push({ key: 'submit', label: 'In Review', hint: 'Hand it in for the assigner to check', tone: 'violet', icon: 'FiSend' });
  }
  const canComplete = (can.transitions || []).some((t) => t.to === STATUS.COMPLETED);
  if (canComplete && !can.canApprove) {
    out.push({ key: 'complete', label: 'Completed', hint: 'Mark it done', tone: 'green', icon: 'FiCheck' });
  }
  return out;
}

/**
 * What the dropdown's own button says: where the task is, from THIS reader's
 * side. Two derived states beat the stored one, as on every task surface —
 * a task everybody refused is "Declined", one nobody has answered yet is "Not
 * accepted" — and a submission waiting on this reader says so.
 */
export function statusBadge(task) {
  if (!task) return { label: '', key: STATUS.PENDING };
  if (task.declined) return { label: 'Declined', key: 'DECLINED' };
  if (task.status === STATUS.SUBMITTED && task.can?.canApprove) return { label: 'Needs your review', key: STATUS.SUBMITTED };
  if (task.status === STATUS.PENDING && task.awaitingAcceptance) return { label: 'Not accepted', key: STATUS.PENDING };
  return { label: statusLabel(task.status, task.kind), key: task.status };
}

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

/**
 * Is this row late?
 *
 * The server already answered on every row it sent (`decorate` → `overdue`),
 * and its answer wins: it applied the company clock and the SUBMITTED
 * exemption. The derivation below is only for a row that came from somewhere
 * else — a freshly posted task, an optimistic update — and it mirrors
 * config/tasks.isOverdue rather than inventing a second rule.
 */
export const isOverdue = (task) => {
  if (!task) return false;
  if (typeof task.overdue === 'boolean') return task.overdue;
  if (!task.dueDate || isTerminal(task.status)) return false;
  if (task.status === STATUS.SUBMITTED) return false;
  return new Date(task.dueDate) < new Date();
};

/** Handed in and waiting on somebody to look at it. */
export const isInReview = (task) => task?.status === STATUS.SUBMITTED;
