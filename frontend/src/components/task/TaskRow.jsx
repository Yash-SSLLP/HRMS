/**
 * One task, as a row.
 *
 * REWRITTEN 2026-09-22. Four things changed with the v4 backend, and every one
 * of them is visible here:
 *
 *   THE WHOLE ROW IS TINTED by its priority — green once it is done, faded grey
 *   once it is called off. The palette is the SERVER's (`task.accent`), read
 *   through taskColors.accentStyle, so the list, the board card, the detail
 *   header and the app cannot drift into four slightly different reds.
 *
 *   THERE IS NO START BUTTON ANY MORE. Accepting a task starts it, so what
 *   somebody is offered on a fresh handover is Accept / Decline and nothing
 *   else. (config/tasks + routes/taskRoutes, 2026-09-22.)
 *
 *   FINISHING IS A SUBMISSION. Submit hands it in; Approve and Send back are
 *   the assigner's two answers to that. All three carry a note the server will
 *   not let them go without, which is why they OPEN the task rather than firing
 *   on the press — the note box has to appear somewhere, and a row is not it.
 *
 *   A PIECE IS A TASK. So a row can say "part of TSK-2026-00058", a parent can
 *   say "3 of 5 pieces", and a piece nobody has been named for offers a Claim.
 *
 * WHAT THE ROW SAYS, in the order a person reads it:
 *   the serial and the code     — which one this is
 *   the title                   — what it is
 *   who set it / who it is on   — whose it is
 *   the deadline                — when, in red once that has passed
 *   the progress bar            — how far along the doer says it is
 *   the chips                   — state, priority, points, pieces, more time
 *   the buttons                 — what THIS person may do about it
 *
 * EVERY BUTTON COMES FROM `task.can`. This file re-derives not one permission:
 * the server answered per row (services/taskAccess.capabilitiesFor) and the row
 * draws what it was told. The module this replaces derived its buttons in two
 * places, with two sets of bugs.
 */
import { Link } from 'react-router-dom';
import {
  FiThumbsUp, FiThumbsDown, FiSend, FiCheck, FiRotateCcw, FiBookmark,
  FiUserPlus, FiCornerUpRight, FiUser, FiLayers, FiClock,
} from 'react-icons/fi';
import {
  StatusChip, OverdueChip, ReviewChip, PriorityChip, DueChip, PointsChip,
  PiecesChip, ExtensionChip, TransferredChip, ProgressBar, TaskMarks,
} from './TaskChips';
import { useAccentStyle } from './taskColors';
import { assigneeNames, personName } from '../../utils/taskLifecycle';

/**
 * One shape for every action on the row.
 *
 * `min-h-[32px]`, never `h-8`: a Tailwind height utility opts the control out
 * of the phone's 40px touch floor (index.css names the exemption explicitly),
 * and a row action is exactly the sort of small target that floor exists for.
 * `bg-white/70` rather than a colour fill keeps the button legible on the
 * tinted row and, usefully, keeps it out of index.css's filled-button rule.
 */
const ACTION = 'min-h-[32px] inline-flex items-center gap-1 rounded-xl border px-2.5 '
  + 'text-xs font-medium bg-white/70 transition hover:bg-white';

/** Anything inside one of these answers for itself; the row must not also fire. */
const INTERACTIVE = 'button, a, input, select, textarea, label, [role="button"]';

export default function TaskRow({
  task,
  base = '/employee/tasks',
  /** Which side of the task this viewer is on — decides whose name is shown. */
  scope = 'mine',
  /** Open it. The page shows the modal; the title stays a link for a new tab. */
  onOpen,
  onAccept,
  onDecline,
  /** The three note-bearing moves. Each opens the task with the box ready. */
  onSubmit,
  onApprove,
  onReject,
  onClaim,
  onTemplate,
  viewOnly = false,
}) {
  // What the SERVER says this person may do to this row. The list sends it per
  // task (taskController.listTasks) for exactly this.
  const can = task.can || null;
  const accent = useAccentStyle(task);

  // A piece carries its parent's id raw on a list row and populated on a detail
  // one, so both spellings are read rather than one being assumed.
  const parentId = task.parentTask?._id || task.parentTask || null;

  const asking = task.kind === 'REQUEST';
  // On "my tasks" the interesting name is who SET it; on anything else it is
  // who it is ON. Showing both on every row is twice the text for half the
  // information.
  const who = scope === 'mine'
    ? {
      label: asking ? 'Asked by' : 'Assigned by',
      name: task.createdByName || personName(task.createdBy) || '—',
    }
    : {
      label: asking ? 'Asked of' : 'Assigned to',
      name: assigneeNames(task.assignees),
    };

  /**
   * Clicking the row opens the task — except on something that is itself
   * clickable. Without the guard, pressing Accept would fire the button AND
   * open the modal behind it, which reads as the button having done the wrong
   * thing.
   *
   * No `role="button"` on the wrapper: it contains a link and several buttons,
   * and a button containing buttons is invalid and unusable with a keyboard.
   * The title link is the keyboard route into the task.
   */
  const openRow = (e) => {
    if (!onOpen) return;
    if (e.target.closest?.(INTERACTIVE)) return;
    onOpen(task);
  };

  /**
   * THE BUG THIS REWRITE FIXES.
   *
   * The className used to be pasted INSIDE the `to` prop — `to={`${base}/${id}
   * text-sm font-medium …`}` — so every title pointed at a URL with a stylesheet
   * in it and none of them was styled. It stayed invisible because the row also
   * had no other link to compare against.
   *
   * And NO `hover:underline` here, ever: index.css restyles every element
   * carrying that class into a filled pill button, which is right for a row's
   * action and very wrong for a title.
   */
  const openFromTitle = (e) => {
    // A modified click is somebody asking for a new tab. Let the browser do it.
    if (!onOpen || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onOpen(task);
  };

  return (
    <div
      onClick={openRow}
      style={accent}
      className={`rounded-2xl px-3 py-2.5 shadow-sm transition hover:shadow sm:px-4 sm:py-3 ${
        onOpen ? 'cursor-pointer' : ''
      }`}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {/* ── Which one it is ────────────────────────────────── */}
        {/* Tabular figures so a column of serials lines up; the server numbers
            them across pages (row 51 is "51"), so this is a serial rather than
            an index and quoting "number 3" stays unambiguous. */}
        <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-gray-400">
          {task.serial ? `#${task.serial}` : ''}
        </span>

        {/* ── What it is ─────────────────────────────────────── */}
        <div className="min-w-[12rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {task.code && (
              <span className="shrink-0 font-mono text-[11px] text-gray-400">{task.code}</span>
            )}
            <Link
              to={`${base}/${task._id}`}
              onClick={openFromTitle}
              className="text-sm font-medium text-gray-900 transition-colors hover:text-blue-600"
            >
              {task.title}
            </Link>
            {asking && (
              <span className="min-h-[20px] inline-flex items-center gap-1 rounded-lg bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
                <FiCornerUpRight size={10} /> Request
              </span>
            )}
          </div>

          {/* Where this piece came from. A piece is a task of its own now, so
              without this line its owner has no way of telling that the job
              they are looking at is one fifth of something. */}
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
            <span className="inline-flex items-center gap-1">
              <FiUser size={11} className="text-gray-400" />
              <span className="text-gray-400">{who.label}</span>
              <span className="text-gray-600">{who.name}</span>
            </span>
            <DueChip task={task} />
            {task.category && <span className="text-gray-500">{task.category}</span>}
            {task.frequencyLabel && task.frequencyLabel !== 'One time' && (
              <span className="text-gray-500">{task.frequencyLabel}</span>
            )}
            {/* Passed on — so the row says the work has moved without needing
                the delegation trail opened. */}
            {task.delegationCount > 0 && (
              <span className="inline-flex items-center gap-1 text-gray-400">
                <FiCornerUpRight size={11} /> passed on
              </span>
            )}
            <TaskMarks task={task} />
          </div>

          {/* How far along, as the doer declared it. Drawn only once there is
              something to say: a 0% bar on every pending row is a page of grey
              lines that mean nothing. */}
          {Number(task.progress) > 0 && (
            <ProgressBar task={task} className="mt-2 max-w-[220px]" />
          )}
        </div>

        {/* ── The state, as chips ────────────────────────────── */}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/* Two derived states matter more than the stored status does.
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
          ) : can?.canApprove ? (
            // In review AND it is this person's to answer. "Needs your review"
            // is the one thing a manager scanning a list is looking for, and
            // "In review" does not say it.
            <ReviewChip task={task} yours />
          ) : (
            <StatusChip task={task} />
          )}

          {/* Late. Solid red, beside the status rather than instead of it —
              being late and being in progress are two facts, and the tint
              deliberately stays the priority's so a late Low task still reads
              as Low. */}
          <OverdueChip task={task} />

          {/* A piece nobody has been named for. Dashed, because it is an offer
              rather than a state of the work. */}
          {task.isOpenPiece && (
            <span className="min-h-[22px] inline-flex items-center gap-1 rounded-lg border border-dashed border-gray-400 bg-white/60 px-2 py-0.5 text-xs font-medium text-gray-600">
              <FiUserPlus size={10} /> Open — pick this up
            </span>
          )}

          <PriorityChip priority={task.priority} />
          <PiecesChip task={task} />
          <ExtensionChip task={task} />
          <TransferredChip task={task} />
          {!asking && <PointsChip task={task} earned={task.status === 'COMPLETED'} />}
        </div>

        {/* ── What can be done about it ──────────────────────── */}
        {!viewOnly && can && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {/* ACCEPT AND DECLINE COME FIRST, and only while the handover is
                unanswered — they are the first thing somebody handed work has
                to decide, and burying them behind the detail page is how a task
                sits unacknowledged for a week. Accepting also STARTS it, which
                is why there is no third button beside them. */}
            {can.canAccept && (
              <button
                type="button"
                onClick={() => onAccept?.(task)}
                title="Take this on — it starts straight away"
                className={`${ACTION} border-emerald-200 text-emerald-700`}
              >
                <FiThumbsUp size={11} /> Accept
              </button>
            )}
            {can.canAccept && can.canDecline && (
              <button
                type="button"
                onClick={() => onDecline?.(task)}
                className={`${ACTION} border-gray-200 text-gray-600 hover:border-red-300 hover:text-red-600`}
              >
                <FiThumbsDown size={11} /> Decline
              </button>
            )}

            {can.canClaim && (
              <button
                type="button"
                onClick={() => onClaim?.(task)}
                className={`${ACTION} border-blue-200 text-blue-700`}
              >
                <FiUserPlus size={11} /> Claim
              </button>
            )}

            {/* Handing it in, and the two answers to that. Each opens the task
                because the server will not take any of them silently — see
                services/taskEngine.move. */}
            {can.canSubmit && (
              <button
                type="button"
                onClick={() => onSubmit?.(task)}
                className={`${ACTION} border-violet-200 text-violet-700`}
              >
                <FiSend size={11} /> {asking ? 'Answer' : 'Submit'}
              </button>
            )}
            {can.canApprove && (
              <button
                type="button"
                onClick={() => onApprove?.(task)}
                className={`${ACTION} border-green-200 text-green-700`}
              >
                <FiCheck size={11} /> Approve
              </button>
            )}
            {can.canReject && (
              <button
                type="button"
                onClick={() => onReject?.(task)}
                title="Send it back for more work — say what is missing"
                className={`${ACTION} border-amber-200 text-amber-700`}
              >
                <FiRotateCcw size={11} /> Send back
              </button>
            )}

            {onTemplate && !asking && (
              <button
                type="button"
                onClick={() => onTemplate(task)}
                title="Save this as a template"
                className={`${ACTION} border-gray-200 text-gray-600 hover:text-blue-600`}
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
        <p className="mt-2 border-t border-black/5 pt-2 text-xs text-gray-500">
          {task.stateNote}
        </p>
      )}
    </div>
  );
}
