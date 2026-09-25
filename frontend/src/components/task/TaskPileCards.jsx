/**
 * "Assigned to me" · "Assigned by me" — the two big cards the page opens on.
 *
 * NEW 2026-09-25, straight off the user's sketch: two large cards across the
 * top, replacing a strip of six tabs (My Tasks, Delegated, All Tasks,
 * Requests, Kanban, Dashboard). They ARE the tabs — each is one pile of work,
 * the API's `scope` — and each wears its own figures, so the pile you are not
 * looking at still says whether it needs you.
 *
 * Whoever holds tasks.manage gets a third, "All tasks": the company-wide view
 * they had before, kept so the simplification takes nothing away from them.
 *
 * THE BIG NUMBER IS WHAT IS STILL OPEN — everything not finished or called
 * off. "Total" is on the stat bar below; on a card the question is "how much is
 * sitting in this pile", and a figure that grew every time something was
 * completed would answer the wrong one.
 *
 * SELECTED IS PAINT ONLY. Both states carry the same 1px border; selection
 * changes its colour and adds a glow drawn with box-shadow, so picking a pile
 * cannot move anything on the page (the layout-stability rule).
 */
import { FiInbox, FiSend, FiLayers, FiCheck } from 'react-icons/fi';
import { PILES } from '../../utils/taskLifecycle';

const ICONS = { FiInbox, FiSend, FiLayers };

/** What is still open in a pile: everything bar the finished and the called-off. */
export function openCount(c = {}) {
  return Math.max(0, (Number(c.total) || 0) - (Number(c.completed) || 0) - (Number(c.cancelled) || 0));
}

export default function TaskPileCards({ isAdmin = false, active, onPick, scopes = null }) {
  const piles = PILES.filter((p) => !p.adminOnly || isAdmin);

  return (
    <div className={`grid gap-3 sm:gap-4 ${piles.length === 3 ? 'grid-cols-2 lg:grid-cols-3' : 'grid-cols-2'}`}>
      {piles.map((pile, i) => {
        const Icon = ICONS[pile.icon] || FiInbox;
        const on = active === pile.key;
        const c = scopes?.[pile.key] || null;
        const review = Number(c?.inReview) || 0;
        const overdue = Number(c?.overdue) || 0;
        const done = Number(c?.completed) || 0;

        return (
          <button
            key={pile.key}
            type="button"
            onClick={() => onPick?.(pile.key)}
            aria-pressed={on}
            // The third card spans the row on a phone rather than sitting alone
            // in half of it.
            className={`task-pile group relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-2xl border bg-white p-3.5 text-left shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-md sm:p-5 ${
              on ? 'accent-border is-active' : 'border-gray-200'
            } ${piles.length === 3 && i === 2 ? 'col-span-2 lg:col-span-1' : ''}`}
          >
            {/* A phone stacks the icon over the name: beside it, a half-width
                card cut "Assigned to me" down to "Assig…" — and the name of
                the pile is the whole point of the card. */}
            <span className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
              <span
                className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl transition sm:h-11 sm:w-11 ${
                  on ? 'accent-bg on-accent' : 'bg-gray-100 text-gray-500 group-hover:text-gray-700'
                }`}
              >
                <Icon size={18} />
              </span>
              <span className="min-w-0 flex-1 text-sm font-semibold leading-tight text-gray-800 sm:text-base">
                {pile.label}
              </span>
              {/* The tick is a desktop nicety; on a phone the frame and the
                  glow already say which pile is open, and the room is needed. */}
              <span
                className={`hidden h-6 w-6 shrink-0 place-items-center rounded-full transition sm:grid ${
                  on ? 'accent-bg on-accent opacity-100' : 'opacity-0'
                }`}
                aria-hidden
              >
                <FiCheck size={13} />
              </span>
            </span>

            <span className="flex items-baseline gap-2">
              <span className="text-3xl font-bold leading-none tabular-nums text-gray-900 sm:text-4xl">
                {c ? openCount(c) : <span className="text-gray-300">—</span>}
              </span>
              <span className="text-xs font-medium text-gray-500 sm:text-sm">open</span>
            </span>

            {/* The figures that need somebody. Wraps rather than truncating —
                a phone card is narrow, and "2 to review" cut to "2 to r…" is
                worse than a second line. */}
            <span className="flex min-h-[20px] flex-wrap items-center gap-x-3 gap-y-1 text-[11px] font-medium sm:text-xs">
              {c && overdue > 0 && (
                <span className="inline-flex items-center gap-1 text-red-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-red-500" /> {overdue} overdue
                </span>
              )}
              {c && review > 0 && (
                <span className="inline-flex items-center gap-1 text-violet-700">
                  <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
                  {review} {pile.key === 'mine' ? 'in review' : 'to review'}
                </span>
              )}
              {c && (
                <span className="inline-flex items-center gap-1 text-gray-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" /> {done} done
                </span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}
