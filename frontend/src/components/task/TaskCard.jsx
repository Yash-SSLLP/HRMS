/**
 * One task, as a board card.
 *
 * NEW 2026-09-22 for the board. It is the same information as TaskRow in a
 * column's worth of width, with two deliberate differences:
 *
 *   NO STATUS CHIP.  The column it is sitting in IS the status. Repeating it on
 *                    every card costs a line and says nothing.
 *   NO ACTIONS.      A row has room for Accept / In progress / Complete; a
 *                    120px-wide card does not, and a board of forty cards each
 *                    carrying three buttons is unreadable. The card opens the
 *                    task (click, or Enter — it is focusable) and the answer
 *                    buttons are in there.
 *
 * The tint is the module's one colour rule (contract §3, components/taskColors):
 * the card is painted by PRIORITY and turns green when it is done, with a 4px
 * rail of the solid colour down its left edge. Being late does NOT change the
 * tint — it adds the solid red Overdue chip and paints the due date red — so a
 * late Low task still reads as Low.
 */
import { FiUser, FiGitBranch, FiEye, FiUserPlus } from 'react-icons/fi';
import {
  PriorityChip, OverdueChip, DueChip, PointsChip, PiecesChip,
  ProgressBar, ExtensionChip, TransferredChip, TaskMarks,
} from './TaskChips';
import { useAccentStyle } from './taskColors';
import { assigneeNames, personName } from '../../utils/taskLifecycle';

export default function TaskCard({
  task,
  /** Which board this card is on — decides whose name is worth the line. */
  scope = 'mine',
  onOpen,
  /** The board owns the drag; the card only reports that one has started. */
  onDragStart,
  onDragEnd,
  dragging = false,
  draggable = true,
}) {
  const style = useAccentStyle(task, { rail: 4 });
  const can = task.can;

  /**
   * On "assigned to me" the assignee is always the reader, so the name worth
   * the line is who SET it. On "assigned by me" it is the other way round.
   * Printing both on a card this narrow is twice the text for half the fact.
   */
  const who = scope === 'mine'
    ? { label: 'from', name: task.createdByName || personName(task.createdBy) || '—' }
    : { label: 'on', name: assigneeNames(task.assignees, 1) };

  /**
   * Who signs it off. `approver` is set to the creator when a task is made and
   * moves to the delegator on a delegation, so the creator is the correct
   * fallback for a row whose projection did not carry the field.
   */
  const approver = can?.canApprove
    ? 'you'
    : (task.approverName || personName(task.approver)
      || task.createdByName || personName(task.createdBy) || 'the assigner');

  const open = () => onOpen?.(task);

  /**
   * A div rather than a <button>: Firefox will not start an HTML5 drag from a
   * real button element, and a filled button would also pick up the portal's
   * own button elevation on top of the card's. `role="button"` with a tabIndex
   * gives it the semantics and the focus ring without either.
   */
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${task.code ? `${task.code} — ` : ''}${task.title}`}
      draggable={draggable}
      onClick={open}
      onKeyDown={(e) => {
        // Enter opens it. Space is claimed by the page's scroll on a div, so it
        // is handled here too rather than left to swallow the keypress.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      onDragStart={(e) => onDragStart?.(task, e)}
      onDragEnd={(e) => onDragEnd?.(task, e)}
      style={style}
      className={`rounded-2xl px-3 py-2.5 shadow-sm transition hover:shadow
        ${draggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}
        ${dragging ? 'opacity-50' : ''}`}
    >
      {/* A piece nobody has been named for. It is the one thing on a board that
          is nobody's yet, so it is said first and said plainly. */}
      {task.isOpenPiece && (
        <p className="mb-1.5 inline-flex min-h-[20px] items-center gap-1 rounded-lg border border-dashed border-gray-400 px-1.5 py-0.5 text-[11px] font-medium text-gray-700">
          <FiUserPlus size={11} className="shrink-0" />
          {can?.canClaim ? 'Open — pick up' : 'Open — unclaimed'}
        </p>
      )}

      <div className="flex items-start justify-between gap-2">
        {task.code && (
          <span className="shrink-0 font-mono text-[11px] text-gray-500">{task.code}</span>
        )}
        <OverdueChip task={task} />
      </div>

      {/* NO `hover:underline` and no <Link>: index.css restyles anything
          carrying that class into a filled pill button, and the whole card is
          already the click target. */}
      <p className="mt-0.5 line-clamp-2 text-sm font-medium text-gray-900" title={task.title}>
        {task.title}
      </p>

      {task.isPiece && task.parentCode && (
        <p
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-gray-500"
          title={task.parentTitle || undefined}
        >
          <FiGitBranch size={10} className="shrink-0" />
          part of {task.parentCode}
        </p>
      )}

      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="inline-flex min-w-0 items-center gap-1 text-gray-600">
          <FiUser size={11} className="shrink-0 text-gray-400" />
          <span className="text-gray-400">{who.label}</span>
          <span className="truncate">{who.name}</span>
        </span>
        <DueChip task={task} />
      </div>

      {/* Progress is what the doer typed in, never inferred from the clock. */}
      <ProgressBar task={task} className="mt-2 w-full" />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <PriorityChip priority={task.priority} />
        {task.kind !== 'REQUEST' && (
          <PointsChip task={task} earned={task.status === 'COMPLETED'} />
        )}
        <PiecesChip task={task} />
        <ExtensionChip task={task} />
        <TransferredChip task={task} />
        <TaskMarks task={task} />
      </div>

      {/* Whose move it is, on the one column where the work is out of the
          doer's hands and waiting on a person by name. */}
      {task.status === 'SUBMITTED' && (
        <p className="mt-2 inline-flex items-center gap-1 border-t border-black/5 pt-2 text-[11px] font-medium text-violet-700">
          <FiEye size={11} className="shrink-0" /> Review by {approver}
        </p>
      )}
    </div>
  );
}
