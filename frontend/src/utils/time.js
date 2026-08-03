/**
 * Time formatting helpers.
 *
 * Two kinds live here. Durations ("late by" / hours-worked figures) are NOT
 * times of day, so the 12-hour AM/PM rule does not apply to them — but they
 * must never be mistakable for a clock time either, which is why the unit
 * letters are always present. Clock times (formatTime12) always render as
 * 12-hour AM/PM per the portal convention.
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

/**
 * A time of day in 12-hour AM/PM. Accepts a Date/ISO value (a stored punch) or
 * an "HH:mm" string (what the time inputs and regularization requests carry).
 * @param {Date|string} value
 * @returns {string} '' when there is nothing to show
 */
export function formatTime12(value) {
  if (!value) return '';
  const s = String(value);
  if (value instanceof Date || s.includes('T') || s.includes('Z')) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; }
  return s;
}

/**
 * A Date → "HH:mm" (24-hour, local) — the value an <input type="time"> wants.
 * @param {Date|string} value
 * @returns {string} '' when the value is missing/invalid
 */
export function toHM(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A Date → "YYYY-MM-DD" using LOCAL parts (never toISOString, which shifts the
 * day for IST). Matches what <input type="date"> reads and writes.
 * @param {Date|string} value
 * @returns {string} '' when the value is missing/invalid
 */
export function toYMD(value) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
