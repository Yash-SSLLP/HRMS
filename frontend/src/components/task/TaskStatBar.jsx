/**
 * Total · Not Accepted Yet · Overdue · In Progress · Under Review · Completed —
 * one bar, six figures.
 *
 * NEW 2026-09-25, replacing TaskStatTiles (five separate cards). The user's
 * sketch draws the figures as ONE rounded bar split by dividers, which reads as
 * a single summary of the pile rather than things competing for attention.
 * SIX since later that day (the user's own words and order — Pending became
 * Not Accepted Yet and In Progress got a figure of its own). On a phone the six
 * sit three to a row, so the longer names are never cut; from `sm` up they are
 * one row. The dividers are a 1px gap over a grey backing, which draws the
 * lines between rows as well as between columns.
 *
 * EVERY SEGMENT IS A FILTER, and clicking the lit one clears it. The figures
 * come from the server and do not overlap (taskController.countersFor); what
 * each click asks for is in utils/taskLifecycle.STAT_BAR, so the rows that
 * appear are exactly the ones the figure counted.
 *
 * SELECTION IS PAINT ONLY: a tint and a 3px bar along the bottom, drawn
 * absolutely so it takes no space.
 */
import { FiLayers, FiAlertCircle, FiClock, FiEye, FiCheckCircle, FiPlayCircle } from 'react-icons/fi';
import { STAT_BAR, statValue } from '../../utils/taskLifecycle';

const ICONS = { FiLayers, FiAlertCircle, FiClock, FiEye, FiCheckCircle, FiPlayCircle };

export default function TaskStatBar({ counters = {}, active = '', onPick, loading = false }) {
  return (
    <div
      className="task-statbar grid grid-cols-3 gap-px overflow-hidden rounded-2xl border border-gray-200 bg-gray-200 shadow-sm sm:grid-cols-6"
      role="group"
      aria-label="Task figures"
    >
      {STAT_BAR.map(({ key, label, icon, colour }) => {
        const Icon = ICONS[icon] || FiLayers;
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
            className="relative flex min-w-0 flex-col gap-2 bg-white px-3 pb-3 pt-3 text-left transition hover:bg-gray-50 sm:px-4 sm:pt-4"
          >
            {/* The same card as the phone's: the figure, its icon chip, the name. */}
            <span className="flex items-center justify-between gap-2">
              <span
                className={`text-2xl font-bold leading-none tabular-nums sm:text-3xl ${on ? '' : value || loading ? 'text-gray-900' : 'text-gray-300'}`}
                style={on ? { color: colour } : undefined}
              >
                {loading ? <span className="text-gray-300">·</span> : value}
              </span>
              <span
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                style={on
                  ? { backgroundColor: colour, color: '#fff' }
                  : { backgroundColor: `color-mix(in srgb, ${colour} 12%, transparent)`, color: colour }}
              >
                <Icon size={14} />
              </span>
            </span>
            {/* Two lines at most, and room for two everywhere, so a wrapped
                "Not Accepted Yet" cannot leave its row at two heights. */}
            <span
              className="line-clamp-2 min-h-[2.5em] text-xs font-semibold leading-tight text-gray-500 sm:text-sm"
              style={on ? { color: colour } : undefined}
            >
              {label}
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
