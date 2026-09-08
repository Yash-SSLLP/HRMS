/**
 * The <option> list for a people picker.
 *
 * Everyone still with the company is listed as usual; everyone whose account has
 * been deactivated goes into a `searchOnly` group, which SearchableSelect keeps
 * out of the menu until something is typed (and counts in its footer, so the
 * list never looks like it is simply missing people). Typing a name — or an
 * employee code, wherever the label carries one — brings them back.
 *
 * Why hide rather than drop them, which is what several of these pickers used
 * to do: half of them are FILTERS over records that outlive the person — last
 * year's attendance, a payroll register, a chat export — and the ex-employee is
 * exactly who is being looked for. The other half assign work or approvals, and
 * there a leaver is noise that gets picked by accident. Hidden-until-searched is
 * the one rule that serves both, and it is the same rule the reporting-manager
 * picker already used for other departments.
 *
 * Pass whatever the page already loaded: a User (`isActive`) or an
 * EmployeeProfile (`user.isActive`) — `hasLeft` reads both shapes.
 */

/** True when this row's login has been deactivated (they have left). */
export const hasLeft = (row) => (row?.isActive ?? row?.user?.isActive) === false;

/**
 * @param {Array} rows - the people, in the order they should appear
 * @param {(row: Object) => string} label - the option's text
 * @param {Object} [opts]
 * @param {(row: Object) => string} [opts.value] - the option's value (default `_id`)
 * @param {Iterable<string>} [opts.keep] - ids that stay in the visible list even
 *   when the person has left. Pass the current selection so re-opening a picker
 *   shows what is already chosen.
 * @param {string} [opts.groupLabel]
 * @returns {JSX.Element}
 */
export function peopleOptions(rows, label, {
  value = (r) => String(r._id),
  keep = null,
  groupLabel = 'Inactive · search by name or code',
} = {}) {
  const list = rows || [];
  const kept = keep ? new Set([...keep].filter(Boolean).map(String)) : null;
  const gone = (r) => hasLeft(r) && !(kept && kept.has(value(r)));
  const here = list.filter((r) => !gone(r));
  const left = list.filter(gone);

  return (
    <>
      {here.map((r) => <option key={value(r)} value={value(r)}>{label(r)}</option>)}
      {left.length > 0 && (
        // `searchOnly` is read by SearchableSelect, not rendered to the DOM —
        // so this helper belongs to that component, not to a native <select>.
        <optgroup label={groupLabel} searchOnly>
          {left.map((r) => (
            <option key={value(r)} value={value(r)}>{label(r)} · inactive</option>
          ))}
        </optgroup>
      )}
    </>
  );
}

export default peopleOptions;
