/**
 * Turn attendance records into the per-day series AttendanceDayChart draws.
 *
 * One employee: each punched day is one point. All employees (ALL_EMPLOYEES):
 * the records are grouped by day and each point is that day's AVERAGE login,
 * logout and hours across the people who punched — so the chart still reads
 * as "a typical day" instead of one line per person.
 *
 * `entries` (one per person-day) is returned alongside so the summary cards can
 * average over real punches, not over already-averaged days.
 */

// Option value for "every employee" in the report pickers.
export const ALL_EMPLOYEES = 'all';

const minutesOfDay = (d) => { const t = new Date(d); return t.getHours() * 60 + t.getMinutes(); };
const mean = (arr) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null);

export function attendanceSeries(records) {
  const entries = [...(records || [])]
    .filter((r) => r.checkIn || r.checkOut)
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((r) => {
      const login = r.checkIn ? minutesOfDay(r.checkIn) : null;
      const logout = r.checkOut ? minutesOfDay(r.checkOut) : null;
      let present = null;
      if (login != null && logout != null && logout > login) present = logout - login;
      else if (r.hoursWorked) present = Math.round(r.hoursWorked * 60);
      return { label: new Date(r.date).getDate().toString().padStart(2, '0'), login, logout, present };
    });

  // Group by day label (entries are date-sorted, so the Map keeps day order).
  const byDay = new Map();
  entries.forEach((e) => {
    if (!byDay.has(e.label)) byDay.set(e.label, []);
    byDay.get(e.label).push(e);
  });
  const days = [...byDay.entries()].map(([label, list]) => ({
    label,
    login: mean(list.filter((e) => e.login != null).map((e) => e.login)),
    logout: mean(list.filter((e) => e.logout != null).map((e) => e.logout)),
    present: mean(list.filter((e) => e.present).map((e) => e.present)),
    people: list.length,
  }));

  return { entries, days };
}
