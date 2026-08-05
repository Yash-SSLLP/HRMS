/**
 * Shared date-order control for attendance tables/lists.
 *
 * `useDateSort` returns a sorted COPY, never mutating the fetched array — a
 * re-fetch (month change, a punch that reloads the list) must not fight the
 * toggle or reorder the caller's state. Sorting is on the parsed Date, not the
 * rendered "1/8/2026" string, which sorts wrong lexically as soon as the day of
 * month reaches two digits.
 *
 *   const [rows, dir, toggleDir] = useDateSort(records);
 *   <DateSortButton dir={dir} onToggle={toggleDir} />      // header cell
 *   <DateSortButton dir={dir} onToggle={toggleDir} compact /> // next to a heading
 */
import { useMemo, useState } from 'react';
import { FiArrowUp, FiArrowDown } from 'react-icons/fi';

/**
 * @param {Array} records - rows carrying a date field.
 * @param {string} [key] - the date field's name.
 * @param {'asc'|'desc'} [initial] - default order; newest-first by default,
 *   because the day someone just worked is the one they came to look at.
 * @returns {[Array, 'asc'|'desc', () => void]} sorted rows, direction, toggle.
 */
export function useDateSort(records = [], key = 'date', initial = 'desc') {
  const [dir, setDir] = useState(initial);
  const sorted = useMemo(() => {
    const sign = dir === 'asc' ? 1 : -1;
    return [...records].sort((a, b) => (new Date(a[key]) - new Date(b[key])) * sign);
  }, [records, key, dir]);
  const toggle = () => setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
  return [sorted, dir, toggle];
}

/** The control itself: states the current order in its tooltip, not just an arrow. */
export function DateSortButton({ dir, onToggle, label = 'Date', compact = false }) {
  const asc = dir === 'asc';
  const Arrow = asc ? FiArrowUp : FiArrowDown;
  const title = asc
    ? 'Sorted oldest first — click for newest first'
    : 'Sorted newest first — click for oldest first';
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-label={`${label}, sorted ${asc ? 'oldest' : 'newest'} first. Activate to reverse.`}
      className={compact
        ? 'inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50'
        : 'inline-flex items-center gap-1.5 font-medium hover:text-gray-900'}
    >
      {label}
      <Arrow size={13} className="shrink-0 accent-text" aria-hidden="true" />
    </button>
  );
}

export default DateSortButton;
