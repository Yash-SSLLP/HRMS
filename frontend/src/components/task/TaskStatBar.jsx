/**
 * Total · Overdue · Pending · In review · Completed — one bar, five figures.
 *
 * NEW 2026-09-25, replacing TaskStatTiles (five separate cards). The user's
 * sketch draws the five as ONE rounded bar split by dividers, which reads as a
 * single summary of the pile rather than five things competing for attention —
 * and takes a third of the height.
 *
 * EVERY SEGMENT IS A FILTER, and clicking the lit one clears it. The figures
 * come from the server and do not overlap (taskController.countersFor); what
 * each click asks for is in utils/taskLifecycle.STAT_BAR, so the rows that
 * appear are exactly the ones the figure counted.
 *
 * SELECTION IS PAINT ONLY: a tint and a 3px bar along the bottom, drawn
 * absolutely so it takes no space.
 */
import { FiList, FiAlertCircle, FiClock, FiEye, FiCheckCircle } from 'react-icons/fi';
import { STAT_BAR, statValue } from '../../utils/taskLifecycle';

const ICONS = { FiList, FiAlertCircle, FiClock, FiEye, FiCheckCircle };

export default function TaskStatBar({ counters = {}, active = '', onPick, loading = false }) {
  return (
    <div
      className="task-statbar grid grid-cols-5 divide-x divide-gray-100 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
      role="group"
      aria-label="Task figures"
    >
      {STAT_BAR.map(({ key, label, short, icon, colour }) => {
        const Icon = ICONS[icon] || FiList;
        const on = active === key || (!active && key === 'total');
        const value = statValue(counters, key);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            onClick={() => onPick?.(key === 'total' || active === key ? '' : key)}
            title={key === 'total' ? 'Show every task in this pile' : `Show ${label.toLowerCase()} only`}
            style={on ? { backgroundColor: `color-mix(in srgb, ${colour} 7%, var(--surface))` } : undefined}
            className="relative flex min-w-0 flex-col items-center justify-center gap-1 px-1 py-3 text-center transition hover:bg-gray-50 sm:items-start sm:px-5 sm:py-4 sm:text-left"
          >
            <span className="flex max-w-full items-center gap-1.5 text-[11px] font-medium text-gray-500 sm:text-sm">
              <Icon size={14} style={{ color: colour }} className="hidden shrink-0 sm:block" />
              {/* Five labels across a 360px phone: the short words fit, the
                  long ones ("Total tasks", "Completed") would wrap mid-bar. */}
              <span className="truncate sm:hidden">{short}</span>
              <span className="hidden truncate sm:inline">{label}</span>
            </span>
            <span className="text-xl font-bold leading-none tabular-nums text-gray-900 sm:text-3xl">
              {loading ? <span className="text-gray-300">·</span> : value}
            </span>
            <span
              aria-hidden
              className="absolute inset-x-0 bottom-0 h-[3px] transition-opacity"
              style={{ backgroundColor: colour, opacity: on ? 1 : 0 }}
            />
          </button>
        );
      })}
    </div>
  );
}
