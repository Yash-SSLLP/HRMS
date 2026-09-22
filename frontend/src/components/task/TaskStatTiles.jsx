/**
 * The five figures above a task list or a board section.
 *
 * NEW 2026-09-22. The counters used to be a row of dots and numbers
 * (TaskChips.CounterBar, still used where there is no room for these); the brief
 * asked for the dashboard treatment instead — a white card each, a soft-tinted
 * icon square, the label, the number.
 *
 * THE FIGURES COME FROM THE SERVER AND DO NOT OVERLAP. `taskController`
 * counts every task into exactly one of overdue / pending / inProgress /
 * inReview / completed, so the five boxes add up to `total` and nobody has to
 * wonder whether a late pending task is being counted twice. `total` is the sum
 * of the others, which is why it is a tile and not one of the COUNTERS boxes.
 *
 * Every tile is a FILTER. A number you cannot click is a number you then have to
 * go and find by hand; clicking the active one again clears it.
 */
import { FiList, FiAlertCircle, FiClock, FiEye, FiCheckCircle } from 'react-icons/fi';
import { COUNTER_TILES } from '../../utils/taskLifecycle';

/**
 * The tile list names its icon as a string (utils/taskLifecycle is vocabulary
 * and must not drag react-icons into every file that wants `dueLabel`), so the
 * component that already imports the set does the mapping.
 */
const ICONS = { FiList, FiAlertCircle, FiClock, FiEye, FiCheckCircle };

export default function TaskStatTiles({ counters = {}, active = '', onPick, compact = false }) {
  return (
    <div className={`grid grid-cols-2 lg:grid-cols-5 ${compact ? 'gap-3' : 'gap-4'}`}>
      {COUNTER_TILES.map(({ key, label, icon, colour }) => {
        const Icon = ICONS[icon] || FiList;
        const on = active === key;
        const value = counters[key] ?? 0;

        return (
          <button
            key={key}
            type="button"
            aria-pressed={on}
            onClick={() => onPick?.(on ? '' : key)}
            title={on ? `Showing ${label.toLowerCase()} only — click again to clear` : `Show ${label.toLowerCase()} only`}
            /**
             * The selected ring is drawn in the tile's OWN colour by overriding
             * the variable Tailwind's `ring-*` utilities read. Doing it this way
             * keeps the whole thing paint-only: no border appears or disappears,
             * so picking a tile cannot re-measure the row underneath the pointer
             * — the layout-stability rule this portal has paid for twice.
             */
            style={on ? { '--tw-ring-color': colour } : undefined}
            className={`rounded-2xl border border-gray-100 bg-white text-left shadow-sm transition
              ${compact ? 'px-4 py-3' : 'px-5 py-4'}
              ${on ? 'ring-2' : 'hover:border-gray-200 hover:shadow'}`}
          >
            <span
              className={`grid place-items-center rounded-xl ${compact ? 'h-9 w-9' : 'h-10 w-10'}`}
              /**
               * A 12% mix with `transparent` rather than a second hex per theme:
               * the tint then sits on whatever the card's surface actually is,
               * which in dark mode is --surface and not white.
               */
              style={{ backgroundColor: `color-mix(in srgb, ${colour} 12%, transparent)`, color: colour }}
            >
              <Icon size={compact ? 16 : 18} />
            </span>

            <span className={`block text-gray-500 ${compact ? 'mt-2 text-xs' : 'mt-3 text-sm'}`}>
              {label}
            </span>
            <span
              className={`block font-semibold tabular-nums text-gray-900 ${compact ? 'text-xl' : 'mt-1 text-2xl'}`}
            >
              {value}
            </span>
          </button>
        );
      })}
    </div>
  );
}
