/**
 * The status dropdown on every task row.
 *
 * NEW 2026-09-25. The user's sketch put one dropdown on the right of each row
 * and named what goes in it: Approve · Reject · Delegate · Transfer · In Review
 * · Completed. It replaced a row of up to seven buttons (Accept, Decline,
 * Claim, Submit, Approve, Send back, Template) that changed shape from row to
 * row and was most of what made the page feel complicated.
 *
 * THE BUTTON SAYS WHERE THE TASK IS; THE MENU SAYS WHAT YOU CAN DO ABOUT IT.
 * The items come from utils/taskLifecycle.statusActions, which reads nothing
 * but the server's per-row `can` — so a person is only ever offered a move the
 * server will take, and the phone offers the same list for the same task.
 * Anything the six do not cover (progress, more time, comments, editing,
 * cancelling) is one click further, behind "Open task".
 *
 * RENDERED IN A PORTAL at fixed coordinates, like SearchableSelect's menu: a
 * row near the bottom of the page would otherwise open a menu under the fold,
 * and any ancestor with overflow clipping would cut it in half. It flips above
 * the button when there is no room below, and closes on scroll rather than
 * drifting away from the row it belongs to.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  FiChevronDown, FiCheckCircle, FiThumbsUp, FiRotateCcw, FiThumbsDown, FiGitBranch,
  FiRepeat, FiSend, FiCheck, FiUserPlus, FiExternalLink,
} from 'react-icons/fi';
import { statusActions, statusBadge, statusStyle } from '../../utils/taskLifecycle';

const ICONS = {
  FiCheckCircle, FiThumbsUp, FiRotateCcw, FiThumbsDown, FiGitBranch, FiRepeat, FiSend, FiCheck, FiUserPlus,
};

/**
 * The icon chip beside each item, per tone. Tints from the families index.css
 * remaps for dark mode (and never `text-blue-600`, which is the portal accent
 * in disguise — see the note in ui-design notes on that remap).
 */
const TONE_CHIP = {
  green: 'bg-green-50 text-green-700',
  red: 'bg-red-50 text-red-600',
  indigo: 'bg-indigo-50 text-indigo-600',
  slate: 'bg-gray-100 text-gray-600',
  violet: 'bg-violet-50 text-violet-700',
  blue: 'bg-sky-50 text-sky-700',
};

/** The dot inside the button, in the status chip's own family. */
const DOT = {
  PENDING: 'bg-amber-500',
  IN_PROGRESS: 'bg-sky-500',
  SUBMITTED: 'bg-violet-500',
  COMPLETED: 'bg-green-500',
  CANCELLED: 'bg-gray-400',
  DECLINED: 'bg-red-500',
};

const MENU_WIDTH = 288;
const GAP = 6;

export default function TaskStatusMenu({ task, onAction, onOpen, viewOnly = false, className = '' }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState(null);
  const buttonRef = useRef(null);
  const menuRef = useRef(null);

  const badge = statusBadge(task);
  const actions = viewOnly ? [] : statusActions(task);
  // A declined task keeps the chip colours of the status it is stuck at, but a
  // red dot, so "Declined" and "Pending" are not the same amber at a glance.
  const chipClass = badge.key === 'DECLINED'
    ? 'bg-red-50 text-red-700 border border-red-200'
    : statusStyle(badge.key);

  const close = useCallback(() => setOpen(false), []);

  /**
   * Where the panel goes. Measured AFTER it renders (its height depends on how
   * many moves this person has), then placed below the button, or above it
   * when below would run off the screen, and kept inside the viewport sideways.
   */
  const place = useCallback(() => {
    const btn = buttonRef.current?.getBoundingClientRect();
    if (!btn) return;
    const height = menuRef.current?.offsetHeight || 0;
    const width = Math.min(MENU_WIDTH, window.innerWidth - 16);
    const below = btn.bottom + GAP;
    const fitsBelow = below + height <= window.innerHeight - 8;
    const top = fitsBelow || btn.top - GAP - height < 8 ? below : btn.top - GAP - height;
    const left = Math.max(8, Math.min(btn.right - width, window.innerWidth - width - 8));
    setPos({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, actions.length]);

  // Outside click, Escape, scroll and resize all close it. Scroll is listened
  // for in the CAPTURE phase so a scroll inside any container counts.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (menuRef.current?.contains(e.target) || buttonRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        buttonRef.current?.focus();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]') || [])];
      if (!items.length) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown'
        ? items[(at + 1) % items.length]
        : items[(at - 1 + items.length) % items.length];
      next?.focus();
    };
    const onScroll = (e) => {
      if (menuRef.current?.contains(e.target)) return;
      close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  // First item takes the focus, so the keyboard can walk the menu at once.
  useEffect(() => {
    if (!open || !pos) return;
    menuRef.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [open, pos]);

  const pick = (key) => {
    close();
    if (key === 'open') onOpen?.(task);
    else onAction?.(key, task);
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-haspopup="menu"
        aria-expanded={open}
        title={actions.length ? 'Change the status' : 'See what can be done'}
        // The weight and the border live on the BASE class — opening the menu
        // changes nothing about the button's box (the layout-stability rule).
        className={`task-status-btn min-h-[34px] inline-flex items-center gap-2 rounded-xl px-3 text-xs font-semibold shadow-sm transition ${chipClass} ${
          open ? 'ring-2 ring-gray-300' : 'hover:shadow'
        } ${className}`}
      >
        <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[badge.key] || DOT.PENDING}`} aria-hidden />
        <span className="whitespace-nowrap">{badge.label}</span>
        <FiChevronDown
          size={14}
          className={`shrink-0 opacity-70 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`Status of ${task?.title || 'this task'}`}
          onClick={(e) => e.stopPropagation()}
          style={pos
            ? { top: pos.top, left: pos.left, width: pos.width }
            : { top: -9999, left: -9999, width: MENU_WIDTH }}
          className="task-status-menu fixed z-[80] overflow-hidden rounded-2xl border border-gray-200 bg-white p-1.5 shadow-xl"
        >
          <p className="px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
            {actions.length ? 'Change status' : 'Status'}
          </p>

          {actions.length === 0 && (
            <p className="px-3 pb-2 text-xs text-gray-500">
              Nothing for you to change on this one right now.
            </p>
          )}

          {actions.map((a) => {
            const Icon = ICONS[a.icon] || FiCheck;
            return (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                onClick={() => pick(a.key)}
                className="flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left outline-none transition hover:bg-gray-50 focus:bg-gray-50 min-h-[44px]"
              >
                <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${TONE_CHIP[a.tone] || TONE_CHIP.slate}`}>
                  <Icon size={15} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900">{a.label}</span>
                  <span className="block text-xs leading-snug text-gray-500">{a.hint}</span>
                </span>
              </button>
            );
          })}

          <div className="my-1 border-t border-gray-100" />
          <button
            type="button"
            role="menuitem"
            onClick={() => pick('open')}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-medium text-gray-600 outline-none transition hover:bg-gray-50 focus:bg-gray-50 min-h-[40px]"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gray-50 text-gray-500">
              <FiExternalLink size={14} />
            </span>
            Open task
            <span className="ml-auto text-[11px] font-normal text-gray-400">progress · comments</span>
          </button>
        </div>,
        document.body
      )}
    </>
  );
}
