/**
 * EmployeePicker — a searchable person picker that defaults to one department.
 *
 * Built for the interview-round interviewer field, where the useful shortlist is
 * "people from the department this job belongs to" but HR occasionally needs
 * somebody outside it. So: scoped by default, one click to widen to everyone,
 * and always type-to-search.
 *
 * The list is passed in (the parent already loads people for the page) rather
 * than fetched here, so opening several pickers costs no extra requests.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * @param {Object} props
 * @param {string} props.value - selected person's id ('' when unassigned)
 * @param {(id: string) => void} props.onChange - receives the id, or '' when cleared
 * @param {Array<{id: string, name: string, role?: string, designation?: string, department?: string}>} props.people
 * @param {string} [props.department] - scope the default list to this department;
 *   falsy (e.g. the job has none) shows everyone and hides the toggle
 * @param {string} [props.valueLabel] - name to show when `value` is set but the
 *   person is no longer in `people` (e.g. they have since been deactivated), so
 *   an assigned round never reads as unassigned
 * @param {string} [props.placeholder]
 * @param {boolean} [props.disabled]
 */
export default function EmployeePicker({
  value,
  onChange,
  people = [],
  department = '',
  valueLabel = '',
  placeholder = 'Assign a person',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  const selected = people.find((p) => p.id === value) || null;
  // Someone is assigned but no longer selectable (deactivated, say) — show the
  // stored name rather than letting the field look empty.
  const orphanName = !selected && value ? valueLabel : '';

  // Close on an outside click — same approach as the top-bar global search.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);

  const scoped = Boolean(department) && !showAll;

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    let out = people;
    if (scoped) {
      // Keep whoever is already assigned visible even if they sit outside the
      // department — otherwise the field would look empty on an old record.
      out = out.filter((p) => p.department === department || p.id === value);
    }
    if (term) {
      out = out.filter((p) => `${p.name} ${p.designation || ''} ${p.department || ''} ${p.role || ''}`
        .toLowerCase().includes(term));
    }
    return out;
  }, [people, scoped, department, value, q]);

  const pick = (id) => { onChange(id); setOpen(false); setQ(''); };

  const sub = (p) => [p.designation, p.department].filter(Boolean).join(' · ');

  return (
    <div className="relative mb-2" ref={wrapRef}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 border border-gray-300 rounded-lg px-2 py-1.5 text-sm text-left disabled:bg-gray-100"
        title={selected?.name || orphanName || placeholder}
      >
        <span className={`truncate ${selected || orphanName ? 'text-gray-900' : 'text-gray-500'}`}>
          {selected?.name || (orphanName && `${orphanName} (inactive)`) || placeholder}
        </span>
        <span className="text-gray-400 shrink-0">▾</span>
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-lg">
          <div className="p-2 border-b border-gray-100">
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, designation…"
              className="block w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
            />
            {department && (
              <div className="flex items-center justify-between mt-1.5 text-[11px]">
                <span className="text-gray-500 truncate">
                  {showAll ? 'Showing everyone' : `Showing ${department} only`}
                </span>
                <button
                  type="button"
                  onClick={() => setShowAll((s) => !s)}
                  className="shrink-0 text-indigo-600 hover:underline font-medium"
                >
                  {showAll ? `Only ${department}` : 'Show all employees'}
                </button>
              </div>
            )}
          </div>

          <ul className="max-h-56 overflow-y-auto py-1">
            <li>
              <button type="button" onClick={() => pick('')}
                className="w-full text-left px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-50">
                {placeholder} (none)
              </button>
            </li>
            {list.length === 0 ? (
              <li className="px-3 py-3 text-sm text-gray-500">
                {department && !showAll
                  ? <>Nobody in {department} matches. <button type="button" onClick={() => setShowAll(true)} className="text-indigo-600 hover:underline">Search everyone</button>.</>
                  : 'No matches.'}
              </li>
            ) : list.map((p) => (
              <li key={p.id}>
                <button type="button" onClick={() => pick(p.id)}
                  className={`w-full text-left px-3 py-1.5 hover:bg-gray-50 ${p.id === value ? 'bg-indigo-50' : ''}`}>
                  <div className="text-sm text-gray-900 truncate">
                    {p.name}
                    {p.role && p.role !== 'Employee' && <span className="text-gray-500"> ({p.role})</span>}
                  </div>
                  {sub(p) && <div className="text-[11px] text-gray-500 truncate">{sub(p)}</div>}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
