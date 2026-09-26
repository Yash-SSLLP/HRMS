// The Sunday & comp-off duty list as a queue rather than a ledger.
//
// It used to open on every claim of the month, so a month with nothing left to
// decide still stacked 49 settled "Paid 2×" rows above the attendance table the
// page is for. Now (user request 2026-09-26):
//  · the list opens by itself only while a claim is awaiting a decision, and
//    folds away once none is — deciding the last one closes it;
//  · open, it shows just the claims awaiting a decision, and "See all" brings
//    the decided ones back, below the waiting ones.
// Clicking either control pins that choice until another month (or person) is
// loaded.
//
// Shared by Admin → Attendance and My Team, which list the same claims.
import { useEffect, useState } from 'react';

const isWaiting = (c) => c.state === 'Pending';

/**
 * @param {Object[]} claims - as GET .../rest-day-work returns them
 * @param {*} resetKey - names the set that was fetched (month, person); a new one
 *   hands both switches back to the queue. Not `claims` itself: that array is
 *   replaced after every decision, and "See all" would snap shut on each one.
 * @returns {{rows: Object[], total: number, isOpen: boolean, toggle: Function,
 *   canSeeAll: boolean, canShowLess: boolean, seeAll: Function, showLess: Function}}
 */
export function useRestDayQueue(claims, resetKey) {
  const [open, setOpen] = useState(null); // null = follow the queue
  const [all, setAll] = useState(false);
  useEffect(() => { setOpen(null); setAll(false); }, [resetKey]);

  const waiting = claims.filter(isWaiting);
  const decided = claims.filter((c) => !isWaiting(c));
  const isOpen = open ?? waiting.length > 0;
  // With nothing waiting there is nothing to narrow to, so the list opens on the
  // decided claims rather than on an empty table.
  const rows = all || waiting.length === 0 ? [...waiting, ...decided] : waiting;

  return {
    rows,
    total: claims.length,
    isOpen,
    toggle: () => setOpen(!isOpen),
    // Closed, "See all" is the way in; open, it shows while rows are left out.
    canSeeAll: claims.length > 0 && (!isOpen || rows.length < claims.length),
    canShowLess: isOpen && all && waiting.length > 0 && decided.length > 0,
    seeAll: () => { setAll(true); setOpen(true); },
    // Back to following the queue, so deciding the last waiting claim closes it.
    showLess: () => { setAll(false); setOpen(null); },
  };
}

/** "See all 52" / "Show less" — the switch between the queue and the whole month. */
export function QueueSwitch({ queue }) {
  if (!queue.canShowLess && !queue.canSeeAll) return null;
  return (
    <button type="button" onClick={queue.canShowLess ? queue.showLess : queue.seeAll}
      className="shrink-0 whitespace-nowrap text-xs text-blue-600 hover:underline">
      {queue.canShowLess ? 'Show less' : `See all ${queue.total}`}
    </button>
  );
}
