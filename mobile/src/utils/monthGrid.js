/**
 * Month-grid layout for the calendar screen.
 *
 * Kept out of the screen so the date arithmetic can be checked on its own —
 * an off-by-one here silently puts every event on the wrong weekday.
 *
 * Sunday-first, matching the web calendar (frontend/src/pages/Calendar.jsx),
 * so a month reads identically on both.
 */

/**
 * The cells of a month, padded with the neighbouring months' dates so every
 * row holds seven days.
 *
 * @param {number} year  full year, e.g. 2026
 * @param {number} month 1-12
 * @returns {{day: number, inMonth: boolean}[]} always a multiple of 7
 */
export function monthGrid(year, month) {
  const firstWeekday = new Date(year, month - 1, 1).getDay(); // 0 = Sunday
  const daysInMonth = new Date(year, month, 0).getDate();
  const prevMonthDays = new Date(year, month - 1, 0).getDate();

  const cells = [];
  // Tail of the previous month, so the 1st lands under its real weekday.
  for (let i = firstWeekday; i > 0; i -= 1) {
    cells.push({ day: prevMonthDays - i + 1, inMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d += 1) cells.push({ day: d, inMonth: true });
  // Head of the next month, to finish the last row.
  let trailing = 1;
  while (cells.length % 7 !== 0) cells.push({ day: trailing++, inMonth: false });
  return cells;
}

export default monthGrid;
