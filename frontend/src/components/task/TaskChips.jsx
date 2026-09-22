/**
 * The small pieces every task surface repeats.
 *
 * REWRITTEN 2026-09-22. They live together because they are read together — a
 * task row IS these pieces — and because keeping them in one file is what stops
 * the list, the board, the detail page and the dashboard slowly growing four
 * different ideas of what "overdue" looks like.
 *
 * A CHIP IS minHeight + padding, NEVER a fixed height. A large system font
 * spills the label straight out of a fixed-height pill — the rule the portal's
 * responsive layer learned the hard way.
 *
 * WEIGHT AND BORDER LIVE ON THE BASE CLASS, not on the selected state, so
 * picking a chip cannot resize it and shuffle the row underneath the pointer.
 *
 * The status chip, the priority tint and the overdue chip are three different
 * colours saying three different things; utils/taskLifecycle has the note on
 * how they are kept from fighting each other.
 */
import {
  FiAlertCircle, FiPaperclip, FiMic, FiRepeat, FiMessageSquare, FiAward,
  FiEye, FiClock, FiGitBranch, FiCornerUpRight,
} from 'react-icons/fi';
import {
  statusLabel, statusStyle, dueLabel, DUE_TONES, repeatLabel,
  COUNTERS, SUB_COUNTERS, isOverdue, clampProgress, dayLabel,
} from '../../utils/taskLifecycle';
import { accentFor, priorityColor, useTintStyle } from './taskColors';

const CHIP = 'min-h-[22px] inline-flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs font-medium';

/**
 * The state of a row, in its own colour.
 *
 * It no longer turns into "Overdue" when a task is late. Being late and being
 * in review (or pending, or in hand) are two separate facts, and the row now
 * has room to say both: draw an <OverdueChip> beside this one.
 */
export function StatusChip({ task, status, kind = 'TASK', className = '' }) {
  const s = status || task?.status;
  return (
    <span className={`${CHIP} ${statusStyle(s)} ${className}`}>
      {statusLabel(s, task?.kind || kind)}
    </span>
  );
}

/**
 * Late — and the one thing in the module allowed solid red.
 *
 * An Urgent task is already a pale red row with a red hairline. A pale red chip
 * laid on that is invisible, so this one is filled: white on red, which nothing
 * else is, so red-and-solid means late and only late.
 */
export function OverdueChip({ task, label = 'Overdue', className = '' }) {
  if (task && !isOverdue(task)) return null;
  return (
    <span
      className={`${CHIP} border border-red-600 bg-red-600 text-white ${className}`}
      title={task?.dueDate ? `Was due ${dayLabel(task.dueDate)}` : undefined}
    >
      <FiAlertCircle size={11} className="shrink-0" /> {label}
    </span>
  );
}

/**
 * The priority — but only when it is worth saying.
 *
 * Medium is the default and every task has one, so a "Medium" chip on every row
 * is twelve chips of noise that make the two Urgent ones harder to find. Pass
 * `always` where the value is the point (the detail header, the assign form).
 *
 * Painted from the SERVER's palette rather than Tailwind's, so the chip, the
 * row tint behind it and the app's card are the same three colours.
 */
export function PriorityChip({ priority, task, always = false, className = '' }) {
  const value = priority || task?.priority;
  const colour = priorityColor(value);
  const style = useTintStyle(colour);
  if (!value || (!always && colour.key === 'Medium')) return null;
  return (
    <span className={`${CHIP} border ${className}`} style={style}>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: colour.solid }}
      />
      {colour.key}
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

/**
 * What a task is worth. Hidden on a request, which never carries points.
 *
 * A split task shows BOTH figures — "34 of 100" — because the pool and what the
 * person in front of you actually earns stopped being the same number the
 * moment the task was broken up, and showing only the pool on a piece's parent
 * promises a manager 100 points for work five other people are doing.
 */
export function PointsChip({ task, points, earned = false, className = '' }) {
  const pool = Number(task?.points ?? points) || 0;
  if (!pool) return null;
  const raw = Number(task?.effectivePoints);
  const mine = Number.isFinite(raw) ? raw : pool;
  const shared = mine !== pool;
  return (
    <span
      className={`${CHIP} ${earned ? 'bg-green-50 text-green-700' : 'bg-violet-50 text-violet-600'} ${className}`}
      title={
        shared
          ? `Worth ${mine} of this task's ${pool} points — the rest is shared out across the pieces`
          : (earned ? 'Earned' : 'Worth on completion')
      }
    >
      <FiAward size={11} className="shrink-0" />
      {shared ? `${mine} of ${pool}` : pool}
    </span>
  );
}

/**
 * How far along, as the doer declared it.
 *
 * Coloured with the row's own accent so a bar on a tinted card belongs to it.
 * Nothing here infers progress from the clock: the number is typed in by the
 * person doing the work, and a bar computed from elapsed time against the
 * deadline is a lie that looks like data.
 */
export function ProgressBar({ value, task, showLabel = true, className = '' }) {
  const pct = clampProgress(value ?? task?.progress ?? 0);
  const solid = accentFor(task || {}).solid;
  return (
    <span className={`inline-flex min-w-0 items-center gap-2 ${className}`}>
      <span className="h-1.5 min-w-[48px] flex-1 overflow-hidden rounded-full bg-gray-200">
        <span
          className="block h-full rounded-full transition-[width]"
          style={{ width: `${pct}%`, backgroundColor: solid }}
        />
      </span>
      {showLabel && (
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-gray-500">{pct}%</span>
      )}
    </span>
  );
}

/** "3 of 5 pieces" — nothing at all on a task nobody has split. */
export function PiecesChip({ task, className = '' }) {
  const total = Number(task?.childCount ?? task?.subtaskCount) || 0;
  if (!total) return null;
  const done = Number(task?.childDoneCount ?? task?.subtasksDone) || 0;
  return (
    <span
      className={`${CHIP} bg-gray-100 text-gray-600 ${className}`}
      title={`This task is split into ${total} piece${total === 1 ? '' : 's'}`}
    >
      <FiGitBranch size={11} className="shrink-0" />
      {done} of {total} piece{total === 1 ? '' : 's'}
    </span>
  );
}

/**
 * Handed in, waiting on somebody.
 *
 * Says WHOSE move it is when that is known — a manager scanning their list
 * wants the four rows waiting on them, not the twelve that are merely in
 * review somewhere.
 */
export function ReviewChip({ task, yours = false, className = '' }) {
  if (task && task.status !== 'SUBMITTED') return null;
  return (
    <span
      className={`${CHIP} border border-violet-200 bg-violet-50 text-violet-700 ${className}`}
      title={task?.submittedAt ? `Submitted ${dayLabel(task.submittedAt)}` : undefined}
    >
      <FiEye size={11} className="shrink-0" />
      {yours ? 'Needs your review' : 'In review'}
    </span>
  );
}

/**
 * Somebody has asked for more time and nobody has answered yet.
 *
 * Deliberately quiet: the work carries on while the answer is awaited, which is
 * the whole point of asking rather than stopping, so this must not read as a
 * blocker.
 */
export function ExtensionChip({ task, className = '' }) {
  const ask = task?.pendingExtension;
  if (!ask) return null;
  const who = ask.requestedByName ? `${ask.requestedByName} asked` : 'Asked';
  const till = ask.toDate ? ` to move the deadline to ${dayLabel(ask.toDate)}` : '';
  return (
    <span
      className={`${CHIP} border border-amber-200 bg-amber-50 text-amber-700 ${className}`}
      title={`${who}${till}${ask.reason ? ` — ${ask.reason}` : ''}`}
    >
      <FiClock size={11} className="shrink-0" /> more time asked
    </span>
  );
}

/** The quiet marks along a row: files, a recording, repetition, remarks. */
/**
 * "Transferred" — this row is not where it started.
 *
 * It reads the LAST hop only. `transfers` is append-only and a row that has
 * moved twice is rare enough that the trail belongs on the detail page, not in
 * a chip; what the list has to answer is the question a reassigned task always
 * raises — "why is this mine?" — and the previous holder's name answers it.
 *
 * Grey on purpose. A transfer is a correction, not a problem with the work.
 */
export function TransferredChip({ task, className = '' }) {
  const hops = task?.transfers;
  if (!Array.isArray(hops) || !hops.length) return null;
  const last = hops[hops.length - 1];
  const from = last.fromName ? `from ${last.fromName}` : '';
  const by = last.byName ? ` by ${last.byName}` : '';
  const when = last.at ? ` · ${dayLabel(last.at)}` : '';
  return (
    <span
      className={`${CHIP} border border-gray-200 bg-gray-50 text-gray-600 ${className}`}
      title={`Transferred ${from}${by}${when}${last.reason ? ` — ${last.reason}` : ''}`.trim()}
    >
      <FiCornerUpRight size={11} className="shrink-0" /> transferred
    </span>
  );
}

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
 * The counter row — the compact form, for a panel that has no room for the
 * stat tiles (the dashboard, a drawer). The list page draws COUNTER_TILES
 * instead.
 *
 * The boxes DO NOT OVERLAP — the server counts each task in exactly one of them
 * (taskController.countersFor), so they add up to the total and the row can be
 * trusted. In Time and Delayed are a breakdown OF Completed and are drawn as a
 * second, quieter line so nobody adds them in.
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
