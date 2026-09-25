/**
 * One task, as a row.
 *
 * REWRITTEN 2026-09-25 for the simplified page. What changed, and why:
 *
 *   ONE DROPDOWN INSTEAD OF A ROW OF BUTTONS. Accept, Decline, Claim, Submit,
 *   Approve, Send back and Template used to sit on the row, a different set on
 *   every row. The user's sketch has one dropdown on the right carrying Approve
 *   · Reject · Delegate · Transfer · In Review · Completed — TaskStatusMenu,
 *   whose button also IS the status chip, so the row says where a task is and
 *   what can be done about it in one place.
 *
 *   NO "REQUEST" BADGE. Asking upward is gone (anybody may set anybody a
 *   task), and the two rows raised as requests before that are listed with the
 *   rest in the same words.
 *
 * STILL TRUE, and load-bearing:
 *
 *   THE WHOLE ROW IS TINTED by its priority — green once it is done, faded
 *   grey once it is called off — from the SERVER's palette (`task.accent`), so
 *   the list, the detail header and the app cannot drift apart.
 *
 *   NOTHING HERE DECIDES WHAT ANYBODY MAY DO. The menu reads `task.can`, which
 *   the server computed for this person and this row.
 *
 * WHAT THE ROW SAYS, in the order a person reads it: the serial and the code,
 * the title, who set it and who it is for, the day it was assigned, the
 * deadline, how far along it is, and — on the right — overdue / priority /
 * points and the status dropdown.
 */
import { Link } from 'react-router-dom';
import { FiUser, FiLayers, FiCornerUpRight, FiUserPlus, FiArrowRight, FiCalendar } from 'react-icons/fi';
import {
  OverdueChip, PriorityChip, DueChip, PointsChip, PiecesChip, ExtensionChip,
  TransferredChip, ProgressBar, TaskMarks,
} from './TaskChips';
import TaskStatusMenu from './TaskStatusMenu';
import { useAccentStyle } from './taskColors';
import { assigneeNames, personName, dayLabel } from '../../utils/taskLifecycle';

/** Anything inside one of these answers for itself; the row must not also fire. */
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"], [role="menu"]';

export default function TaskRow({
  task,
  base = '/employee/tasks',
  /** The signed-in user's id, so a task you set yourself says "you". */
  meId = '',
  onOpen,
  /** `(actionKey, task)` — a pick from the status dropdown. */
  onAction,
  viewOnly = false,
}) {
  const accent = useAccentStyle(task);
  const parentId = task.parentTask?._id || task.parentTask || null;

  const setterId = String(task.createdBy?._id || task.createdBy || '');
  const byMe = Boolean(meId) && setterId === String(meId);
  const onlyMe = byMe && (task.assignees || []).length === 1
    && String(task.assignees[0].user?._id || task.assignees[0].user) === String(meId);

  // BOTH SIDES ON EVERY ROW, and the day it was handed over (user request
  // 2026-09-25: "show also who assigned, to whom, date of assigned"). Each
  // pile used to show only the other side — who set it on "Assigned to me",
  // who holds it elsewhere — which left "All tasks" and "In the loop" naming
  // half of every handover. A task you set yourself stays "Your own task".
  const setBy = byMe ? 'you' : (task.createdByName || personName(task.createdBy) || '—');
  // Set in somebody's name by somebody else (Task.onBehalf): who sent it.
  const sentById = String(task.onBehalf?.by?._id || task.onBehalf?.by || '');
  const sentBy = sentById ? (sentById === String(meId) ? 'you' : (task.onBehalf.byName || '')) : '';
  const setFor = task.isOpenPiece ? 'nobody yet' : (assigneeNames(task.assignees) || '—');
  // `assignedAt` moves when a task is transferred — it is the day the CURRENT
  // holder got it, the same field the "Day assigned" order sorts on.
  const assignedOn = dayLabel(task.assignedAt || task.createdAt);

  /**
   * Clicking the row opens the task — except on something that is itself
   * clickable, or the dropdown's menu would open AND the task behind it.
   * No `role="button"` on the wrapper: it contains a link and a button, and a
   * button containing buttons is invalid and unusable from a keyboard. The
   * title link is the keyboard route in.
   */
  const openRow = (e) => {
    if (!onOpen) return;
    if (e.target.closest?.(INTERACTIVE)) return;
    onOpen(task);
  };

  // A modified click is somebody asking for a new tab — let the browser have it.
  // (And NO `hover:underline` on the title: index.css turns anything carrying
  // that class into a filled pill button.)
  const openFromTitle = (e) => {
    if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(task);
  };

  return (
    <div
      onClick={openRow}
      style={accent}
      className={`task-row group rounded-2xl px-3 py-3 shadow-sm transition duration-200 hover:-translate-y-px hover:shadow-md sm:px-4 ${
        onOpen ? 'cursor-pointer' : ''
      }`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        {/* ── Which one it is, and what ─────────────────────────── */}
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {/* Tabular figures so a column of serials lines up; the server
              numbers them across pages, so "#51" on page two is row 51. */}
          <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-gray-400">
            {task.serial ? `#${task.serial}` : ''}
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              {task.code && (
                <span className="shrink-0 font-mono text-[11px] text-gray-400">{task.code}</span>
              )}
              <Link
                to={`${base}/${task._id}`}
                onClick={openFromTitle}
                className="min-w-0 break-words text-sm font-semibold text-gray-900 transition-colors hover:text-blue-600"
              >
                {task.title}
              </Link>
            </div>

            {/* Where a piece came from — without it, the person holding one
                cannot tell the job in front of them is a fifth of something. */}
            {task.isPiece && (
              <div className="mt-1 text-[11px] text-gray-500">
                <FiLayers size={10} className="mr-1 inline align-[-1px] text-gray-400" />
                part of{' '}
                {parentId ? (
                  <Link
                    to={`${base}/${parentId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-gray-600 transition-colors hover:text-blue-600"
                    title={task.parentTitle || undefined}
                  >
                    {task.parentCode || task.parentTitle || 'the parent task'}
                  </Link>
                ) : (
                  <span className="text-gray-600">{task.parentCode || task.parentTitle || 'another task'}</span>
                )}
              </div>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
              {onlyMe ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <FiUser size={11} className="shrink-0 text-gray-400" />
                  <span className="text-gray-600">Your own task</span>
                </span>
              ) : (
                <>
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <FiUser size={11} className="shrink-0 text-gray-400" />
                    <span className="text-gray-400">By</span>
                    <span className="truncate text-gray-600">{setBy}</span>
                    {sentBy && <span className="shrink-0 text-gray-400">(sent by {sentBy})</span>}
                  </span>
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <FiArrowRight size={11} className="shrink-0 text-gray-400" />
                    <span className="text-gray-400">To</span>
                    <span className="truncate text-gray-600">{setFor}</span>
                  </span>
                </>
              )}
              {assignedOn && (
                <span className="inline-flex items-center gap-1">
                  <FiCalendar size={11} className="shrink-0 text-gray-400" />
                  <span className="text-gray-400">Assigned</span>
                  <span className="text-gray-600">{assignedOn}</span>
                </span>
              )}
              <DueChip task={task} />
              {task.category && <span className="text-gray-500">{task.category}</span>}
              {task.delegationCount > 0 && (
                <span className="inline-flex items-center gap-1 text-gray-400">
                  <FiCornerUpRight size={11} /> passed on
                </span>
              )}
              {task.isOpenPiece && (
                <span className="inline-flex items-center gap-1 font-medium text-sky-700">
                  <FiUserPlus size={11} /> open — pick it up
                </span>
              )}
              <TaskMarks task={task} />
            </div>

            {/* Drawn once there is something to say: a 0% bar on every pending
                row is a page of grey lines that mean nothing. */}
            {Number(task.progress) > 0 && (
              <ProgressBar task={task} className="mt-2 w-full max-w-[240px]" />
            )}
          </div>
        </div>

        {/* ── The state, and what can be done about it ──────────── */}
        {/* On a phone this becomes its own line under the title, chips left
            and the dropdown right; from sm up it sits at the end of the row. */}
        <div className="flex flex-wrap items-center justify-between gap-2 pl-11 sm:shrink-0 sm:justify-end sm:pl-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <OverdueChip task={task} />
            <PriorityChip priority={task.priority} />
            <PiecesChip task={task} />
            <ExtensionChip task={task} />
            <TransferredChip task={task} />
            <PointsChip task={task} earned={task.status === 'COMPLETED'} />
          </div>
          <TaskStatusMenu task={task} viewOnly={viewOnly} onAction={onAction} onOpen={onOpen} />
        </div>
      </div>

      {/* Why it was called off belongs on the row — it is usually the only
          thing anybody wants to know about a cancelled task. */}
      {task.stateNote && task.status === 'CANCELLED' && (
        <p className="mt-2 border-t border-black/5 pt-2 text-xs text-gray-500">{task.stateNote}</p>
      )}
    </div>
  );
}
