/**
 * Duration formatting for "late by" / hours-worked figures.
 *
 * These are DURATIONS, not times of day, so the 12-hour AM/PM rule does not
 * apply — but they must never be mistakable for a clock time either, which is
 * why the unit letters are always present.
 */

/**
 * A duration in minutes, spelled with its units.
 * 75 → "1h 15m", 45 → "45m", 120 → "2h", 0 → "0m".
 * @param {number} min - minutes; negatives and nulls clamp to 0
 * @returns {string}
 */
export function formatDuration(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (!h) return `${mm}m`;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

/**
 * A duration in decimal hours, spelled with its units. 7.53 → "7h 32m".
 * @param {number} hours
 * @returns {string} '-' when there is nothing to show
 */
export function formatHours(hours) {
  const h = Number(hours);
  if (!h || h <= 0) return '-';
  return formatDuration(h * 60);
}
