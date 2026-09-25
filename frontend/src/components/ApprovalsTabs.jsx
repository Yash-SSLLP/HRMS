/**
 * The "To approve | History" switch at the top of every queue on the Approvals
 * page, and the "Show more" that pages a long history.
 *
 * One component because six queues draw it (user request 2026-09-25: history
 * in every approval type, inside its own tab) and the two hand-written copies
 * had already drifted — only one of them shared its row evenly on a phone.
 *
 * A segmented control, not an underline: these read as the buttons they are,
 * and the count travels in a chip rather than in dim parentheses. `bg-white`
 * and `bg-gray-100` both carry a dark-mode remap in index.css, and the active
 * chip uses the portal accent rather than a hardcoded hue. Selection repaints
 * only — weight and padding are the same on and off, so a pill never changes
 * size under the pointer. On a phone the track wraps (index.css) and each pill
 * grows to share its row; from sm up the pills sit at their own width.
 */
import { useEffect, useState } from 'react';

/**
 * @param {Object} props
 * @param {{key: string, label: string, count?: number}[]} props.tabs
 * @param {string} props.value - the selected key
 * @param {(key: string) => void} props.onChange
 */
export default function ApprovalsTabs({ tabs, value, onChange }) {
  return (
    <div className="flex sm:inline-flex items-center gap-1 p-1 mb-4 rounded-xl bg-gray-100 border border-gray-200">
      {tabs.map(({ key, label, count }) => {
        const on = value === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-pressed={on}
            className={`inline-flex flex-auto justify-center sm:flex-initial sm:justify-start items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${
              on
                ? 'bg-white text-gray-900 shadow-sm ring-1 ring-gray-200'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
            {count !== undefined && (
              <span
                className={`text-[11px] font-bold leading-none px-1.5 py-0.5 rounded-full tabular-nums ${
                  on ? 'accent-bg on-accent' : 'bg-gray-200 text-gray-600'
                }`}
              >
                {count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** How many history rows a list shows at first, and adds per "Show more". */
export const HISTORY_PAGE = 30;

/**
 * Pages a history list: the first HISTORY_PAGE rows, then more on request.
 *
 * The histories used to stop at 30 with nothing beyond it — the server sends
 * up to 200, so the rest were fetched and never reachable.
 *
 * Back to the first page only when the FETCHED array is replaced (a reload
 * after a decision) — hence `resetKey`. Keying on `list` would reset on every
 * render, because callers derive it afresh each time (history minus pending),
 * and "Show more" would snap straight back.
 * @param {Object[]} list - the rows to page
 * @param {*} resetKey - the fetched array `list` is derived from
 * @returns {{shown: Object[], more: JSX.Element|null}}
 */
export function useShowMore(list, resetKey) {
  const [limit, setLimit] = useState(HISTORY_PAGE);
  useEffect(() => { setLimit(HISTORY_PAGE); }, [resetKey]);
  const left = list.length - limit;
  return {
    shown: list.slice(0, limit),
    more: left > 0 ? (
      <div className="pt-3 text-center">
        <button
          type="button"
          onClick={() => setLimit((n) => n + HISTORY_PAGE)}
          className="text-sm font-medium text-blue-600 hover:underline"
        >
          Show {Math.min(left, HISTORY_PAGE)} more
        </button>
      </div>
    ) : null,
  };
}

/** Colours for a request's final state on a history row. */
export const OUTCOME_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Cancelled: 'bg-gray-100 text-gray-700',
  Withdrawn: 'bg-gray-100 text-gray-700',
  InClearance: 'bg-blue-100 text-blue-800',
  Completed: 'bg-green-100 text-green-800',
};

/** "No history yet" — quieter than the queue's empty state, as on Leave. */
export function HistoryEmpty({ children }) {
  return <p className="text-sm text-gray-400 italic py-2">{children}</p>;
}
