/**
 * The single source of chart colour for the whole portal.
 *
 * Everything here is a CSS custom property (defined in index.css), never a raw
 * hex — so a chart automatically restyles for dark mode without reading the
 * theme store, and the palette can be tuned in one place.
 *
 * Two rules this file exists to enforce:
 *  1. **Solid colours only.** No gradient is ever applied to a data mark —
 *     a gradient makes the same series read as two different values depending
 *     on where you look at it.
 *  2. **Categorical colours are assigned in a fixed order and never cycled.**
 *     The order is what keeps neighbouring series apart for colour-blind
 *     readers; picking `slot[i % 8]` for a 9th series silently reuses a hue.
 *     Past eight, fold the tail into "Other".
 */

/** Categorical slots, in the order they must be assigned. */
export const CHART_SERIES = [
  'var(--chart-1)', // blue
  'var(--chart-2)', // orange
  'var(--chart-3)', // aqua
  'var(--chart-4)', // yellow
  'var(--chart-5)', // magenta
  'var(--chart-6)', // green
  'var(--chart-7)', // violet
  'var(--chart-8)', // red
];

/**
 * The colour for series `i`. Beyond the palette the caller should be folding
 * into "Other" rather than inventing a hue, so this clamps to the last slot
 * instead of wrapping around to slot 1 and duplicating a colour.
 * @param {number} i - zero-based series index
 * @returns {string} a `var(--chart-N)` reference
 */
export const seriesColor = (i) => CHART_SERIES[Math.min(i, CHART_SERIES.length - 1)];

/**
 * Reserved state colours. Never use one for an ordinary series — a reader who
 * has learnt "red = critical" should not meet red as "Q3 revenue". Always
 * accompanied by a text label, never colour alone.
 */
export const CHART_STATUS = {
  good: 'var(--chart-good)',
  warning: 'var(--chart-warning)',
  serious: 'var(--chart-serious)',
  critical: 'var(--chart-critical)',
};

/** Sequential ramp (one hue, light → dark) for magnitude/intensity scales. */
export const CHART_SEQUENTIAL = [
  'var(--chart-seq-1)',
  'var(--chart-seq-2)',
  'var(--chart-seq-3)',
  'var(--chart-seq-4)',
];

/** Recessive chrome — gridlines, axes, and "no data" cells. */
export const CHART_GRID = 'var(--chart-grid)';
export const CHART_EMPTY = 'var(--chart-empty)';

/**
 * Attendance day states, shared by the web and mobile heatmaps and by every
 * attendance chart, so one day never appears green in one view and teal in
 * another. Genuine states, so the reserved status colours are the right
 * vocabulary; the two that aren't good/bad take categorical slots.
 */
export const ATTENDANCE_COLORS = {
  full: CHART_STATUS.good,          // worked the full day
  half: CHART_STATUS.warning,       // half day
  late: CHART_STATUS.serious,       // present but late
  absent: CHART_STATUS.critical,    // unpaid absence
  leave: 'var(--chart-7)',          // approved leave — a state, not a failure
  compoff: 'var(--chart-1)',        // comp-off earned
};
