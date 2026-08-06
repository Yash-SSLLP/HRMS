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
 * A time of day in 12-hour AM/PM — "9:33 AM", "12:48 PM". THE one clock-time
 * formatter for the whole portal; every screen should route through it rather
 * than calling toLocaleTimeString itself, so times can't drift apart again.
 *
 * Accepts a Date/ISO value (a stored punch) or an "HH:mm" string (what the time
 * inputs and regularization requests carry). Both inputs now produce byte-identical
 * output: this used to hand-build "9:33 AM" for "HH:mm" but delegate Date values to
 * toLocaleTimeString with hour:'2-digit', which renders "09:33 am" — so the same
 * helper printed a different time format depending on what it was handed.
 *
 * @param {Date|string} value
 * @returns {string} '' when there is nothing to show
 */
export function formatTime12(value) {
  if (!value) return '';
  const s = String(value);
  if (value instanceof Date || s.includes('T') || s.includes('Z')) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return upperMeridiem(
      d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true })
    );
  }
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) { let h = +m[1]; const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m[2]} ${ap}`; }
  return s;
}

// en-IN renders the meridiem lower-case ("am"/"pm") in some engines and
// upper-case in others — Node and the browser disagree, which is how server-written
// remarks came out "12:41 PM" next to a table reading "12:48 pm". Force one casing.
function upperMeridiem(str) {
  return str.replace(/\b([ap])\.?\s?m\.?\b/i, (_, p) => `${p.toUpperCase()}M`);
}

/**
 * A date + time of day: "06 Aug 2026, 1:18 PM". Composes the portal's date
 * convention with formatTime12, so a combined stamp can't drift from a bare one.
 *
 * Pass `{ year: false }` for the compact "06 Aug, 1:18 PM" used in narrow tables.
 *
 * @param {Date|string} value
 * @param {{year?: boolean}} [opts]
 * @returns {string} '' when there is nothing to show
 */
export function formatDateTime12(value, { year = true } = {}) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', ...(year ? { year: 'numeric' } : {}),
  });
  return `${date}, ${formatTime12(d)}`;
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
