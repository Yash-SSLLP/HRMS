/**
 * A task, opened where you already are.
 *
 * NEW 2026-09-22. Clicking a row in the list or a card on the board opens THIS
 * rather than navigating away, because the thing somebody is actually doing is
 * working down a list: navigate to a page and back, and the list has re-fetched,
 * re-sorted and lost its scroll position, so the next row is nowhere near the
 * pointer. The page at `/tasks/:id` still exists for deep links, notifications
 * and a browser tab somebody wants to keep open — it renders the SAME
 * <TaskDetailBody>, so there is one detail view and not two.
 *
 * IT IS WIDE. max-w-5xl, because the body is a split pane — the task on the
 * left, the Comment / Files / Activity panel on the right — and at max-w-lg
 * the two columns would stack even on a desktop, which is the layout the phone
 * gets and the reason this modal exists.
 *
 * THE SHELL IS THE REPO'S, not a new one: `fixed inset-0 z-[100]`, a
 * `bg-black/40 backdrop-blur-sm` scrim that closes on mousedown, an inner panel
 * that stops the propagation, Escape to close, `role="dialog" aria-modal`. See
 * components/dialogs.jsx, which is where that shape is settled.
 *
 * NOTHING HERE PADS AN INNER WRAPPER. index.css caps a modal panel's height
 * (`.fixed.inset-0 > div`) and pads it on phones; a flex-column panel with its
 * own scroller opts out of both and owns its padding, which this one does —
 * header, body and the body's sections each bring their own.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiExternalLink, FiX } from 'react-icons/fi';
import { Link, useLocation } from 'react-router-dom';
import TaskDetailBody from './TaskDetailBody';

export default function TaskModal({
  taskId,
  open,
  onClose,
  /** Something was written — the list or board behind this reloads. */
  onChanged,
  /**
   * A board drag landed on a column. The body opens its composer already set
   * to that move, because the server refuses a silent one and the note box has
   * to appear rather than the card snapping back.
   */
  initialStatus = null,
  /**
   * Where this module lives for this account.
   *
   * Worked out from the URL when the caller does not say, because the module
   * is mounted twice (`/admin/tasks` and `/employee/tasks`) and a modal opened
   * from the admin list must not hand somebody an employee-portal link that
   * their account may not even be able to open.
   */
  base = null,
}) {
  const { pathname } = useLocation();
  const home = base || (pathname.startsWith('/admin') ? '/admin/tasks' : '/employee/tasks');

  /**
   * WHICH task is on screen — not always the one we were opened with.
   *
   * Clicking a piece inside the detail swaps the window to that piece rather
   * than stacking a second modal on the first. Re-opening (a different row, a
   * different card) puts it back to whatever the caller asked for.
   */
  const [current, setCurrent] = useState(taskId);
  useEffect(() => { setCurrent(taskId); }, [taskId, open]);

  // Escape closes. Bound on the document rather than the panel so it works
  // wherever focus happens to be — inside the composer, a picker, a menu.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !taskId) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="flex w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label="Task"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-gray-200 px-4 py-2.5 sm:px-5">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Task</p>
          <div className="flex items-center gap-1">
            {/* The way OUT of the modal, kept deliberately: a link somebody can
                copy, bookmark or send to whoever should be looking at this. */}
            <Link
              to={`${home}/${current}`}
              onClick={onClose}
              title="Open the full page"
              className="min-h-[32px] inline-flex items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-500 transition hover:bg-gray-100 hover:text-gray-700"
            >
              <FiExternalLink size={13} /> Open in full
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[32px] min-w-[32px] rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600"
              aria-label="Close"
            >
              <FiX size={18} />
            </button>
          </div>
        </div>

        {/* The one scroller. The panel is a flex column, so index.css leaves the
            outer box alone and this is what actually scrolls. */}
        <div className="min-h-0 flex-1 overflow-y-auto bg-gray-50 px-3 py-3 sm:px-4 sm:py-4">
          <TaskDetailBody
            key={current}
            taskId={current}
            base={home}
            /* The dropped-on column belongs to the card that was dragged, not
               to a piece somebody opened from inside it afterwards. */
            initialStatus={current === taskId ? initialStatus : null}
            onChanged={onChanged}
            onOpenTask={(id) => { if (id) setCurrent(String(id)); }}
            onGone={onClose}
          />
        </div>
      </div>
    </div>,
    document.body
  );
}
