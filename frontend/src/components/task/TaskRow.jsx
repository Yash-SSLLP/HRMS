/**
 * One task, as a row.
 *
 * NEW 2026-09-21. The whole design of this module hangs off one decision: the
 * action a row needs is ON THE ROW. "In progress", "Complete", "Save as
 * template" — three buttons, no menu, no detail page. Opening a task to press
 * a button in it is the friction that stops people updating anything, and a
 * task nobody updates is a task list nobody trusts.
 *
 * The detail page is still one click away on the title, for the feed, the
 * recording and the files.
 *
 * WHAT THE ROW SAYS, in the order a person reads it:
 *   the code and the title          — what it is
 *   who set it / who it is on       — whose it is
 *   the deadline                    — when, in red if that has passed
 *   category · priority · repeat    — the qualifiers, quietly
 *   the marks                       — is there a recording, files, remarks
 *   the points                      — what it is worth
 */
import { Link } from 'react-router-dom';
import {
  FiPlay, FiCheck, FiBookmark, FiCornerUpRight, FiUser,
  FiThumbsUp, FiThumbsDown, FiCheckSquare, FiClock,
} from 'react-icons/fi';
import { StatusChip, PriorityChip, DueChip, PointsChip, TaskMarks } from './TaskChips';
import { assigneeNames, personName, isTerminal } from '../../utils/taskLifecycle';

export default function TaskRow({
  task,
  base = '/employee/tasks',
  /** Which side of the task this viewer is on — decides whose name is shown. */
  scope = 'mine',
  onMove,
  onAccept,
  onDecline,
  onTemplate,
  viewOnly = false,
}) {
  // What the SERVER says this person may do to this row. The list sends it per
  // task (taskController.listTasks) for exactly this.
  const can = task.can;
  const done = isTerminal(task.status);

  // On "my tasks" the interesting name is who SET it; on anything else it is
  // who it is ON. Showing both on every row is twice the text for half the
  // information.
  const who = scope === 'mine'
    ? { label: 'Assigned by', name: task.createdByName || personName(task.createdBy) || '—' }
    : { label: 'Assigned to', name: assigneeNames(task.assignees) };

  const qualifiers = [
    task.category,
    task.priority !== 'Medium' ? null : null, // drawn as a chip instead
    task.frequencyLabel && task.frequencyLabel !== 'One time' ? task.frequencyLabel : null,
  ].filter(Boolean);

  return (
    <div className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 transition hover:border-gray-300 hover:shadow-sm">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {/* ── What it is ─────────────────────────────────────── */}
        <div className="min-w-[12rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {task.code && (
              <span className="shrink-0 font-mono text-[11px] text-gray-400">{task.code}</span>
            )}
            {/* NO `hover:underline` here. index.css restyles every element
                carrying that class into a filled pill button — which is right
                for a row's "Edit"/"View" action and very wrong for a title, as
                it turns every row into a wall of buttons. */}
            <Link
              to={`${base}/${task._id} text-sm font-medium text-gray-900 decoration-1 underline-offset-2 transition-colors hover:text-blue-600 hover:underline-offset-4`}
            >
              {task.title}
            </Link>
            {task.kind === 'REQUEST' && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600 min-h-[20px]">
                <FiCornerUpRight size={10} /> Request
              </span>
            )}
          </div>

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
            <span className="inline-flex items-center gap-1">
              <FiUser size={11} className="text-gray-400" />
              <span className="text-gray-400">{who.label}</span>
              <span className="text-gray-600">{who.name}</span>
            </span>
            <DueChip task={task} />
            {qualifiers.map((q) => (
              <span key={q} className="text-gray-500">{q}</span>
            ))}
            {/* "2 of 5 done" earns its place on the row: it is the only thing
                that distinguishes a task somebody is working through from one
                they have not opened. */}
            {task.subtaskCount > 0 && (
              <span className="inline-flex items-center gap-1 text-gray-500">
                <FiCheckSquare size={11} className="text-gray-400" />
                {task.subtasksDone} of {task.subtaskCount}
              </span>
            )}
            {/* Passed on — so the row says who has it now without needing the
                delegation trail opened. */}
            {task.delegationCount > 0 && (
              <span className="inline-flex items-center gap-1 text-gray-400">
                <FiCornerUpRight size={11} /> passed on
              </span>
            )}
            <TaskMarks task={task} />
          </div>
        </div>

        {/* ── The qualifiers, as chips ───────────────────────── */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/* Two derived states that matter more than the stored status does.
              Declined wins: a task everybody has refused is not usefully
              described as "Pending". */}
          {task.declined ? (
            <span className="min-h-[22px] inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
              <FiThumbsDown size={10} /> Declined
            </span>
          ) : task.awaitingAcceptance && task.status === 'PENDING' ? (
            <span className="min-h-[22px] inline-flex items-center gap-1 rounded-lg border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
              <FiClock size={10} /> Not yet accepted
            </span>
          ) : (
            <StatusChip task={task} />
          )}
          <PriorityChip priority={task.priority} />
          {task.kind !== 'REQUEST' && (
            <PointsChip points={task.points} earned={task.status === 'COMPLETED'} />
          )}
        </div>

        {/* ── What can be done about it ──────────────────────── */}
        {!viewOnly && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {/* ACCEPT AND DECLINE COME FIRST, and only while the handover is
                unanswered. They are the first thing somebody handed work has to
                decide, and burying them behind the detail page is how a task
                sits unacknowledged for a week. The SERVER decides whether to
                offer them (`can.canAccept` / `can.canDecline`); this row has no
                opinion of its own. */}
            {can?.canAccept && (
              <button
                type="button"
                onClick={() => onAccept?.(task)}
                className="min-h-[32px] inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
              >
                <FiThumbsUp size={11} /> Accept
              </button>
            )}
            {can?.canAccept && can?.canDecline && (
              <button
                type="button"
                onClick={() => onDecline?.(task)}
                className="min-h-[32px] inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 hover:border-red-300 hover:text-red-600"
              >
                <FiThumbsDown size={11} /> Decline
              </button>
            )}
            {task.status === 'PENDING' && (
              <button
                type="button"
                onClick={() => onMove?.(task, 'IN_PROGRESS')}
                className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 text-xs font-medium text-blue-700 hover:bg-blue-100 min-h-[32px]"
              >
                <FiPlay size={11} /> In progress
              </button>
            )}
            {!done && (
              <button
                type="button"
                onClick={() => onMove?.(task, 'COMPLETED')}
                className="inline-flex items-center gap-1 rounded-lg border border-green-200 bg-green-50 px-2.5 text-xs font-medium text-green-700 hover:bg-green-100 min-h-[32px]"
              >
                <FiCheck size={11} /> {task.kind === 'REQUEST' ? 'Answered' : 'Complete'}
              </button>
            )}
            {onTemplate && task.kind !== 'REQUEST' && (
              <button
                type="button"
                onClick={() => onTemplate(task)}
                title="Save this as a template"
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-blue-600 min-h-[32px]"
              >
                <FiBookmark size={11} /> Template
              </button>
            )}
          </div>
        )}
      </div>

      {/* The reason a task was cancelled or reopened belongs on the row, not
          behind a click — it is usually the only thing anybody wants to know. */}
      {task.stateNote && task.status === 'CANCELLED' && (
        <p className="mt-2 border-t border-gray-100 pt-2 text-xs text-gray-500">
          {task.stateNote}
        </p>
      )}
    </div>
  );
}
