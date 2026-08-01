/**
 * Duration formatting, shared by exports and any server-rendered document.
 *
 * These are DURATIONS, not times of day. The unit letters are always present so
 * a value like "1h 15m" can never be misread as the clock time 1:15.
 * Mirrors frontend/src/utils/time.js and mobile/src/utils/format.js — keep the
 * three in step so the same figure reads identically everywhere.
 */

/**
 * A duration in minutes, spelled with its units.
 * 75 -> '1h 15m', 45 -> '45m', 120 -> '2h', 0 -> '0m'.
 * @param {number} min - minutes; negatives and nulls clamp to 0
 * @returns {string}
 */
function formatDuration(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (!h) return `${mm}m`;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

/**
 * A duration in decimal hours, spelled with its units. 7.53 -> '7h 32m'.
 * @param {number} hours
 * @returns {string} '' when there is nothing to show
 */
function formatHours(hours) {
  const h = Number(hours);
  if (!h || h <= 0) return '';
  return formatDuration(h * 60);
}

module.exports = { formatDuration, formatHours };
