/**
 * ApprovalsBoard — the body of the Approvals page, shared by both portals
 * (pages/AdminLeaveApprovals.jsx and pages/EmployeeApprovals.jsx, which differ
 * only in their PageHeader copy).
 *
 * WHY IT EXISTS. The page used to be five `<h2 class="card-title">` headings
 * with an inbox dropped under each. Two of those inboxes drew tabs and a card,
 * three drew a bare grey sentence — so on a quiet day the screen was a stack of
 * unaligned text five scrolls long, with no way to tell "nothing is waiting"
 * from "still loading" and no way to see whether ANY queue needed you.
 *
 * The shape now: the five approval TYPES are subtabs across the top, and the
 * selected one's queue fills the panel below. One screen, no scrolling past
 * four empty sections to reach the fifth.
 *
 * EVERY INBOX STAYS MOUNTED — the inactive ones are hidden with `hidden`
 * (display:none), never unmounted. They have to keep running to report their
 * counts, which is what puts a live badge on every tab; unmounting them would
 * blank every badge except the open one, and refetch on every tab click.
 *
 * COUNTS come from the inboxes via an optional `onCount` prop: each already
 * knows how many rows are pending, and nothing else can know it without
 * duplicating five fetches. A queue that has not reported yet is `undefined`
 * (skeleton), deliberately distinct from `0` (all clear).
 *
 * Tones are Tailwind hue families index.css remaps for dark mode (see its
 * dark-mode colour accuracy block). The accent is never hardcoded — the active
 * tab and the "waiting" line use `accent-bg`/`accent-text`, so the bar
 * follows role and portal (violet/teal admin, teal-then-gold in My Portal).
 * The one exception is the corner count badge, which is red everywhere — it is
 * the same "unread" signal as the top-bar bell and Approvals pill, and reading
 * it as the accent would sink it back into the tab it is meant to stand out of.
 */
import { useMemo, useState } from 'react';
import {
  FiCalendar, FiAlertCircle, FiClock, FiLogOut, FiCheckSquare,
} from 'react-icons/fi';

import LeaveApprovalsInbox from './LeaveApprovalsInbox';
import ExitApprovalsInbox from './ExitApprovalsInbox';
import ExitClearanceInbox from './ExitClearanceInbox';
import RegularizationApprovalsInbox from './RegularizationApprovalsInbox';
import WorkOnLeaveApprovalsInbox from './WorkOnLeaveApprovalsInbox';

// One entry per approval type. `tone` drives the icon chip only — a waiting
// badge always uses the portal accent, so "something needs you" reads the same
// whichever queue raised it.
const SECTIONS = [
  {
    key: 'leave',
    title: 'Leave',
    blurb: 'Time-off requests climbing your reporting line.',
    icon: FiCalendar,
    tone: 'indigo',
    Inbox: LeaveApprovalsInbox,
  },
  {
    key: 'work-on-leave',
    title: 'Worked on a leave day',
    blurb: 'Someone punched in on a day they were approved to be away.',
    icon: FiAlertCircle,
    tone: 'amber',
    Inbox: WorkOnLeaveApprovalsInbox,
  },
  {
    key: 'regularizations',
    title: 'Attendance regularizations',
    blurb: 'Corrections to a missed or mistaken punch.',
    icon: FiClock,
    tone: 'sky',
    Inbox: RegularizationApprovalsInbox,
  },
  {
    key: 'resignations',
    title: 'Resignations',
    blurb: 'Exit requests waiting on your decision.',
    icon: FiLogOut,
    tone: 'rose',
    Inbox: ExitApprovalsInbox,
  },
  {
    key: 'clearance',
    title: 'No-dues clearance',
    blurb: 'Department sign-off before a leaver’s account is released.',
    icon: FiCheckSquare,
    tone: 'emerald',
    Inbox: ExitClearanceInbox,
  },
];

// Spelled out rather than built by template literal: Tailwind scans source text
// for class names, so `bg-${tone}-50` would never be emitted into the CSS.
const TONE = {
  indigo: 'bg-indigo-50 text-indigo-600 border-indigo-200',
  amber: 'bg-amber-50 text-amber-700 border-amber-200',
  sky: 'bg-sky-50 text-sky-600 border-sky-200',
  rose: 'bg-rose-50 text-rose-600 border-rose-200',
  emerald: 'bg-emerald-50 text-emerald-600 border-emerald-200',
};

/** The count line under a tab title: skeleton → "All clear" → "N waiting". */
function TabStatus({ count, active }) {
  if (count === undefined) {
    return <span className="mt-1 block h-3 w-16 rounded bg-gray-200 animate-pulse" aria-hidden="true" />;
  }
  if (count === 0) {
    return <span className="mt-0.5 block text-xs font-medium text-gray-400">All clear</span>;
  }
  return (
    <span className={`mt-0.5 block text-xs font-semibold tabular-nums ${active ? 'accent-text' : 'text-gray-600'}`}>
      {count} waiting
    </span>
  );
}

export default function ApprovalsBoard() {
  const [openKey, setOpenKey] = useState(SECTIONS[0].key);
  // key -> pending count; `undefined` until that inbox reports in.
  const [counts, setCounts] = useState({});

  // One stable callback per section. An inline arrow would hand each inbox a
  // fresh function on every render and re-fire its effect on every count change.
  const reporters = useMemo(() => {
    const map = {};
    for (const s of SECTIONS) {
      map[s.key] = (n) => setCounts((c) => (c[s.key] === n ? c : { ...c, [s.key]: n }));
    }
    return map;
  }, []);

  const reported = SECTIONS.filter((s) => counts[s.key] !== undefined);
  const totalPending = reported.reduce((sum, s) => sum + counts[s.key], 0);
  const allReported = reported.length === SECTIONS.length;
  const open = SECTIONS.find((s) => s.key === openKey) || SECTIONS[0];

  return (
    <div>
      {/* ---- Subtabs: one per approval type ------------------------------- */}
      {/* Scrolls sideways on a phone rather than wrapping into a ragged block;
          `.topbar-scroll` is index.css's hidden-scrollbar helper. */}
      <div
        role="tablist"
        aria-label="Approval types"
        // px/py give the active tab's shadow somewhere to land: an
        // overflow-x-auto box clips anything painted outside its padding box,
        // which sheared the left edge off the first tab whenever it was active.
        // The negative margins pull the row back into optical alignment.
        // Widened from 1.5/2 to 2.5 when the corner count badge landed: the badge
        // hangs 6px past the tab plus a 2px ring, and `overflow-x:auto` clips the
        // OTHER axis too, so 6px of side padding sheared the ring off the last
        // tab's badge and 8px of top padding grazed its top edge.
        className="topbar-scroll flex items-stretch gap-2 overflow-x-auto px-2.5 py-2.5 -mx-2.5 -mt-2.5 mb-4"
      >
        {SECTIONS.map((s) => {
          const active = s.key === open.key;
          const n = counts[s.key];
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setOpenKey(s.key)}
              className={`group relative flex-1 min-w-[11.5rem] text-left rounded-2xl border px-4 py-3.5 transition-all ${
                active
                  ? 'bg-white border-transparent shadow-md ring-2 ring-inset ring-current accent-text'
                  : 'bg-gray-50 border-gray-200 hover:bg-white hover:border-gray-300 hover:shadow-sm'
              }`}
            >
              {/* Corner count badge. The "N waiting" line below already says
                  it, but only once you are reading THAT tab — the red dot is
                  what makes a queue needing you visible while your eye is on
                  another tab, and it matches the top-bar bell/Approvals badge.
                  aria-hidden because TabStatus already announces the number. */}
              {n > 0 && (
                <span
                  className="absolute -top-1.5 -right-1.5 min-w-[19px] h-[19px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold tabular-nums flex items-center justify-center leading-none"
                  style={{ boxShadow: '0 0 0 2px var(--surface)' }}
                  aria-hidden="true"
                >
                  {n > 99 ? '99+' : n}
                </span>
              )}
              <span className="flex items-center gap-3">
                <span
                  className={`flex items-center justify-center w-10 h-10 rounded-xl border shrink-0 transition-colors ${TONE[s.tone]}`}
                >
                  <s.icon size={19} strokeWidth={2.2} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.9375rem] font-semibold tracking-tight text-gray-900 leading-snug">
                    {s.title}
                  </span>
                  <TabStatus count={n} active={active} />
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ---- The open queue ----------------------------------------------- */}
      <section className="card">
        <header className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-gray-900">{open.title}</h2>
            <p className="text-sm text-gray-500 mt-0.5 leading-relaxed">{open.blurb}</p>
          </div>
          {allReported && (
            <span className="text-xs text-gray-400 shrink-0">
              {totalPending === 0
                ? 'Nothing waiting across any type'
                : `${totalPending} waiting across all types`}
            </span>
          )}
        </header>

        {/* Every inbox stays mounted so its tab badge keeps updating — see the
            file header. `hidden` is display:none, so nothing is unmounted and
            switching tabs never refetches. */}
        <div className="px-4 sm:px-6 py-5">
          {SECTIONS.map((s) => (
            <div key={s.key} className={s.key === open.key ? '' : 'hidden'}>
              <s.Inbox onCount={reporters[s.key]} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
