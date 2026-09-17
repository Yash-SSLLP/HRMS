/**
 * The small pieces every task surface repeats: a status chip, a priority mark,
 * a deadline, a progress bar and a people list.
 *
 * They live together because they are read together — a task row is these five
 * things — and because keeping them in one file is what stops the admin list,
 * the employee list, the board and the detail page slowly growing four
 * different ideas of what "overdue" looks like.
 *
 * A CHIP IS minHeight + padding, NEVER a fixed height. A large system font
 * spills the label straight out of a fixed-height pill, which is the rule the
 * responsive layer already learned the hard way.
 */
import { Link } from 'react-router-dom';
import { FiAlertCircle, FiClock, FiPaperclip, FiMessageSquare, FiRepeat, FiMapPin, FiAward } from 'react-icons/fi';
import {
  statusLabel, statusStyle, dueLabel, DUE_TONES, PRIORITY_CHIPS,
  assigneeNames, formatMinutes, isOverdue,
} from '../../utils/taskLifecycle';

/** The status of a task, as a chip. */
export function StatusChip({ status, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium ${statusStyle(status)} ${className}`}
      style={{ minHeight: 22 }}>
      {statusLabel(status)}
    </span>
  );
}

/**
 * The priority, as a chip — but only when it is worth saying.
 *
 * Medium is the default and every task has one, so a "Medium" chip on every row
 * is twelve chips of noise that make the two Urgent ones harder to find.
 */
export function PriorityChip({ priority, always = false }) {
  if (!priority || (!always && priority === 'Medium')) return null;
  return (
    <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium ${PRIORITY_CHIPS[priority] || ''}`}
      style={{ minHeight: 22 }}>
      {priority}
    </span>
  );
}

/** When it is due, read the way somebody glancing at a row wants it. */
export function DueChip({ task }) {
  const { text, tone } = dueLabel(task?.dueDate, task?.status);
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${DUE_TONES[tone]}`}>
      {tone === 'overdue' && <FiAlertCircle className="shrink-0" size={12} />}
      {text}
    </span>
  );
}

/**
 * How far along, as a bar.
 *
 * The figure is always DERIVED on the server (from subtasks, then the
 * checklist, then the assignees) — nothing here lets anybody type one, because
 * a number somebody typed and then forgot is worse than no number.
 */
export function ProgressBar({ value = 0, className = '', showLabel = true }) {
  const pct = Math.max(0, Math.min(100, Math.round(value || 0)));
  const tone = pct >= 100 ? 'bg-green-500' : pct >= 60 ? 'bg-blue-500' : pct > 0 ? 'bg-amber-500' : 'bg-gray-300';
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden min-w-[48px]">
        <div className={`h-full rounded-full transition-[width] duration-300 ${tone}`} style={{ width: `${pct}%` }} />
      </div>
      {showLabel && <span className="text-xs text-gray-500 tabular-nums w-9 text-right">{pct}%</span>}
    </div>
  );
}

/**
 * Everybody on the task.
 *
 * A multi-assignee task has to show that it IS one — "Rahul +2" rather than
 * just "Rahul", which would quietly hide the other two people answerable for it.
 */
export function AssigneeList({ task, max = 2 }) {
  const names = assigneeNames(task);
  if (!names.length) return <span className="text-gray-400">Unassigned</span>;
  const shown = names.slice(0, max);
  const rest = names.length - shown.length;
  return (
    <span className="text-gray-700" title={names.join(', ')}>
      {shown.join(', ')}
      {rest > 0 && <span className="text-gray-400"> +{rest}</span>}
    </span>
  );
}

/**
 * The little marks that say what a row CARRIES without opening it — that it has
 * a workflow running, evidence attached, comments, a recurring parent, a
 * location requirement or points on it.
 */
export function TaskMarks({ task }) {
  const marks = [];
  if (task.workflowName) {
    marks.push([<FiRepeat key="w" size={12} />, task.workflowName]);
  }
  if ((task.attachments || []).length) {
    marks.push([<FiPaperclip key="a" size={12} />, `${task.attachments.length} file${task.attachments.length === 1 ? '' : 's'}`]);
  }
  if (task.commentCount > 0) {
    marks.push([<FiMessageSquare key="c" size={12} />, `${task.commentCount}`]);
  }
  if (task.minutesLogged > 0) {
    marks.push([<FiClock key="t" size={12} />, formatMinutes(task.minutesLogged)]);
  }
  if ((task.location?.enforceOn || []).length) {
    marks.push([<FiMapPin key="g" size={12} />, 'On site']);
  }
  if (task.incentive?.enabled && task.incentive.points > 0) {
    marks.push([<FiAward key="i" size={12} />, `${task.incentive.points} pts`]);
  }
  if (!marks.length) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-400">
      {marks.map(([icon, text], i) => (
        <span key={i} className="inline-flex items-center gap-1">{icon}{text}</span>
      ))}
    </span>
  );
}

/**
 * A task's name and code, linking to its detail page.
 *
 * `base` decides which portal the link lands in — the same task has a page in
 * both, and following a link should never silently switch which portal you are
 * in.
 */
export function TaskTitleLink({ task, base = '/admin/tasks' }) {
  return (
    <Link to={`${base}/${task._id}`} className="group block">
      <span className="font-medium text-gray-900 group-hover:underline">{task.title}</span>
      {task.code && <span className="ml-2 text-xs text-gray-400 tabular-nums">{task.code}</span>}
    </Link>
  );
}

/**
 * One task as a card — the shape the board and the phone list both use.
 *
 * Its own component because the board and the mobile-width list are the same
 * card, and two copies of it would drift the first time either gained a field.
 */
export function TaskCard({ task, base = '/admin/tasks', onClick }) {
  const overdue = isOverdue(task);
  return (
    <Link
      to={`${base}/${task._id}`}
      onClick={onClick}
      className={`block rounded-lg border bg-white p-3 hover:shadow-sm transition-shadow ${
        overdue ? 'border-red-200' : 'border-gray-200'}`}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium text-gray-900 text-sm leading-snug">{task.title}</span>
        <PriorityChip priority={task.priority} />
      </div>
      {task.code && <div className="mt-0.5 text-xs text-gray-400 tabular-nums">{task.code}</div>}
      <div className="mt-2"><ProgressBar value={task.progress} /></div>
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <AssigneeList task={task} max={1} />
        <DueChip task={task} />
      </div>
      <div className="mt-1.5"><TaskMarks task={task} /></div>
    </Link>
  );
}

/** A row of counters — the shape every task dashboard opens with. */
export function StatTiles({ tiles = [] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
      {tiles.map((t) => (
        <div key={t.label}
          className={`rounded-lg border bg-white p-3 ${t.tone === 'danger' && t.value > 0 ? 'border-red-200' : 'border-gray-200'}`}>
          <div className={`text-2xl font-semibold tabular-nums ${
            t.tone === 'danger' && t.value > 0 ? 'text-red-600'
              : t.tone === 'good' ? 'text-green-700' : 'text-gray-900'}`}>
            {t.value ?? 0}{t.suffix || ''}
          </div>
          <div className="text-xs text-gray-500 mt-0.5">{t.label}</div>
        </div>
      ))}
    </div>
  );
}
