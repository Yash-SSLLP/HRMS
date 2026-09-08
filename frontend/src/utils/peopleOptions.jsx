/**
 * The <option> list for a people picker.
 *
 * ONE RULE: somebody who has left the company is not in a picker. Not behind a
 * search, not in a collapsed group — not there. A picker is a list of people you
 * can do something with, and there is nothing to do with a leaver; offering one
 * is how an approval ladder, a task or an HR partner quietly ends up pointing at
 * an account nobody can sign into.
 *
 * The one place they are deliberately KEPT is the employee master export — the
 * Excel sheet is a record, not a picker, and a year's payroll history is not a
 * record you want with the leavers cut out of it. That export builds its rows
 * server-side and never comes through here, so nothing below can reach it.
 *
 * "Left" is `hasLeft` below, and it must agree with the server's
 * backend/utils/departed: a deactivated login OR a last working day that has
 * already passed. The second half matters — a resignation leaves the login
 * working through the notice period, so `isActive` alone still calls somebody a
 * colleague on the day after they walked out.
 */

/** Today, at midnight — so a last working day of TODAY still counts as here. */
const endOfToday = () => {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
};

/**
 * Has this person left? Reads every shape the pages hand us:
 *   · a User row from /admin/users — `isActive`, and `departed` (which the
 *     server stamps from the exit date, since a User has none of its own)
 *   · an EmployeeProfile from /employees — `user.isActive` and `dateOfExit`
 *   · anything already carrying a resolved flag (`resigned` from chat)
 * @param {Object} row
 * @returns {boolean}
 */
export const hasLeft = (row) => {
  if (!row) return false;
  if (row.departed === true || row.resigned === true) return true;
  if ((row.isActive ?? row.user?.isActive) === false) return true;
  const exit = row.dateOfExit ?? row.user?.dateOfExit;
  return !!exit && new Date(exit) <= endOfToday();
};

/**
 * @param {Array} rows - the people, in the order they should appear
 * @param {(row: Object) => string} label - the option's text
 * @param {Object} [opts]
 * @param {(row: Object) => string} [opts.value] - the option's value (default `_id`)
 * @param {Iterable<string>} [opts.keep] - ids that survive the cut. Pass the
 *   field's CURRENT value: a stored assignment that predates someone leaving
 *   must still render, or the field reads as empty and the next save clears a
 *   value nobody meant to touch. It is what is already saved, not an offer.
 * @returns {JSX.Element}
 */
export function peopleOptions(rows, label, { value = (r) => String(r._id), keep = null } = {}) {
  const kept = keep ? new Set([...keep].filter(Boolean).map(String)) : null;
  return (
    <>
      {(rows || [])
        .filter((r) => !hasLeft(r) || (kept && kept.has(value(r))))
        .map((r) => <option key={value(r)} value={value(r)}>{label(r)}</option>)}
    </>
  );
}

export default peopleOptions;
