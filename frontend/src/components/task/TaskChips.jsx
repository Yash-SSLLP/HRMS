/**
 * The small pieces every task surface repeats.
 *
 * REWRITTEN 2026-09-21. They live together because they are read together — a
 * task row IS these pieces — and because keeping them in one file is what stops
 * the list, the detail page and the dashboard slowly growing three different
 * ideas of what "overdue" looks like.
 *
 * A CHIP IS minHeight + padding, NEVER a fixed height. A large system font
 * spills the label straight out of a fixed-height pill — the rule the portal's
 * responsive layer learned the hard way.
 *
 * WEIGHT AND BORDER LIVE ON THE BASE CLASS, not on the selected state, so
 * picking a chip cannot resize it and shuffle the row underneath the pointer.
 */
import { FiAlertCircle, FiPaperclip, FiMic, FiRepeat, FiMessageSquare, FiAward } from 'react-icons/fi';
import {
  statusLabel, statusStyle, PRIORITY_CHIPS, dueLabel, DUE_TONES,
  repeatLabel, COUNTERS, SUB_COUNTERS, isOverdue,
} from '../../utils/taskLifecycle';

/**
 * The state of a row.
 *
 * Overdue WINS over the stored status: a pending task that is three days late
 * is not usefully described as "Pending", and red is reserved for exactly this.
 */
export function StatusChip({ task, status, kind = 'TASK', className = '' }) {
  const s = status || task?.status;
  const late = task ? isOverdue(task) : false;
  return (
    <span
      className={`min-h-[22px] inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium ${statusStyle(s, late)} ${className}`}
    >
      {late ? 'Overdue' : statusLabel(s, task?.kind || kind)}
    </span>
  );
}

/**
 * The priority — but only when it is worth saying.
 *
 * Medium is the default and every task has one, so a "Medium" chip on every row
 * is twelve chips of noise that make the two High ones harder to find.
 */
export function PriorityChip({ priority, always = false }) {
  if (!priority || (!always && priority === 'Medium')) return null;
  return (
    <span
      className={`min-h-[22px] inline-flex items-center rounded-lg px-2 py-0.5 text-xs font-medium ${PRIORITY_CHIPS[priority] || ''}`}
    >
      {priority}
    </span>
  );
}

/** When it is due, phrased the way somebody glancing at a row wants it. */
export function DueChip({ task }) {
  const { text, tone } = dueLabel(task?.dueDate, task?.status);
  return (
    <span className={`inline-flex items-center gap-1 text-xs ${DUE_TONES[tone]}`}>
      {tone === 'overdue' && <FiAlertCircle className="shrink-0" size={12} />}
      {text}
    </span>
  );
}

/** What a task is worth. Hidden on a request, which never carries points. */
export function PointsChip({ points, earned = false }) {
  if (!points) return null;
  return (
    <span
      className={`min-h-[22px] inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium ${
        earned ? 'bg-green-50 text-green-700' : 'bg-violet-50 text-violet-600'
      }`}
      title={earned ? 'Earned' : 'Worth on completion'}
    >
      <FiAward size={11} /> {points}
    </span>
  );
}

/** The quiet marks along a row: files, a recording, repetition, remarks. */
export function TaskMarks({ task }) {
  const marks = [];
  if (task.hasVoiceNote || task.voiceNote?.storagePath) {
    marks.push(['voice', FiMic, 'Has a voice note']);
  }
  if (task.attachmentCount || task.attachments?.length) {
    marks.push(['files', FiPaperclip, `${task.attachmentCount || task.attachments.length} file(s)`]);
  }
  if (task.repeat?.frequency && task.repeat.frequency !== 'ONCE') {
    marks.push(['repeat', FiRepeat, repeatLabel(task.repeat)]);
  }
  if (task.updateCount > 1) {
    marks.push(['updates', FiMessageSquare, `${task.updateCount} updates`]);
  }
  if (!marks.length) return null;
  return (
    <span className="inline-flex items-center gap-2 text-gray-400">
      {marks.map(([key, Icon, title]) => (
        <span key={key} title={title} className="inline-flex items-center">
          <Icon size={12} />
        </span>
      ))}
    </span>
  );
}

/**
 * The counter row above every list.
 *
 * The four boxes DO NOT OVERLAP — the server counts each task in exactly one of
 * them, so they add up to the total and the row can be trusted
 * (taskController.countersFor). In Time and Delayed are a breakdown OF
 * Completed and are drawn as a second, quieter line so nobody adds them in.
 *
 * Every box is a filter: clicking Overdue narrows the list to the overdue ones.
 * A number you cannot click is a number you have to go and find by hand.
 */
export function CounterBar({ counters = {}, active = '', onPick, loading = false }) {
  const dot = (colour) => (
    <span className={`h-2 w-2 shrink-0 rounded-full ${colour}`} />
  );

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      {COUNTERS.map(([key, label, text, colour]) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick?.(active === key ? '' : key)}
          className={`min-h-[32px] inline-flex items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition ${
            active === key ? 'border-gray-300 bg-gray-100' : 'border-transparent hover:bg-gray-50'
          }`}
        >
          {dot(colour)}
          <span className="text-gray-600">{label}</span>
          <span className={text}>{loading ? '·' : (counters[key] ?? 0)}</span>
        </button>
      ))}

      {(counters.completed > 0 || active === 'completed') && (
        <span className="flex items-center gap-3 border-l border-gray-200 pl-4">
          {SUB_COUNTERS.map(([key, label, text, colour]) => (
            <button
              key={key}
              type="button"
              onClick={() => onPick?.(active === key ? '' : key)}
              className={`min-h-[28px] inline-flex items-center gap-1.5 rounded-lg border px-2 text-xs transition ${
                active === key ? 'border-gray-300 bg-gray-100' : 'border-transparent hover:bg-gray-50'
              }`}
            >
              {dot(colour)}
              <span className="text-gray-500">{label}</span>
              <span className={text}>{loading ? '·' : (counters[key] ?? 0)}</span>
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/** The date-window chips. */
export function RangeChips({ ranges, value, onChange }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {ranges.map(([key, label]) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange?.(key)}
          className={`min-h-[32px] rounded-lg border px-3 text-xs font-medium transition ${
            value === key
              ? 'border-green-600 bg-green-600 text-white'
              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Nothing here — said in a way that suggests what to do next. */
export function EmptyTasks({ scope, onAssign }) {
  const lines = {
    mine: ['Nothing on your plate', 'Tasks people set for you land here.'],
    delegated: ['You have not set any tasks', 'Hand something over and it will show up here.'],
    all: ['No tasks match', 'Try a wider date range, or clear the filters.'],
    requests: ['No requests', 'Ask somebody senior for what you need and it will appear here.'],
  };
  const [title, body] = lines[scope] || lines.all;
  return (
    <div className="rounded-2xl border border-dashed border-gray-200 px-6 py-12 text-center">
      <p className="text-sm font-medium text-gray-700">{title}</p>
      <p className="mt-1 text-xs text-gray-500">{body}</p>
      {onAssign && (
        <button
          type="button"
          onClick={onAssign}
          className="mt-4 rounded-xl bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700 min-h-[40px]"
        >
          Assign a task
        </button>
      )}
    </div>
  );
}
