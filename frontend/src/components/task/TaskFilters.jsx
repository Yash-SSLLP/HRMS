/**
 * Task Filters — the panel behind the Filter button.
 *
 * REWRITTEN 2026-09-25 around the user's list: *"the filter should be based on
 * the department, name, task due date, search by name of assignee or assigner,
 * priority"*. Category and frequency left the panel (the server still answers
 * both); the date chips that used to sit above the list moved IN, so the page
 * itself is only the piles, the figures and the rows. The name search is the
 * box beside the Filter button, not in here — it is used far more often than
 * any of these.
 *
 * ONE SCROLLING PANEL, NOT TABS. The old modal hid four of its five groups
 * behind tabs down the left, so what was set could not be seen at a glance.
 *
 * CHANGES ARE NOT LIVE until "Show tasks" is pressed: Escape or Cancel leaves
 * the list exactly as it was. Every filter runs on the server, and the figures
 * above the list come from the same filter as the rows.
 */
import { useEffect, useMemo, useState } from 'react';
import { FiX, FiCalendar, FiBriefcase, FiUser, FiFlag, FiArrowUp, FiArrowDown, FiBarChart2 } from 'react-icons/fi';
import PeoplePicker from './PeoplePicker';
import { priorityColor, useIsDark, tintStyle } from './taskColors';
import { RANGES, TASK_PRIORITY } from '../../utils/taskLifecycle';

/** What "no filter" is — and so what Reset goes back to. The page opens on this. */
export const DEFAULT_FILTERS = {
  range: 'month',
  from: '',
  to: '',
  department: '',
  assignedTo: '',
  assignedBy: '',
  priority: '',
  sort: 'due',
  dir: '',
};

/** Comma lists, as the API takes them. */
const split = (v) => String(v || '').split(',').filter(Boolean);
const join = (arr) => arr.filter(Boolean).join(',');

/**
 * How many things are narrowing the list — the number on the Filter button.
 *
 * The due-date window is NOT counted: it is always on (the page opens on This
 * month) and always shown as its own chip under the toolbar, so counting it
 * would put a "1" on the button of somebody who has set nothing.
 */
export function activeFilterCount(f = {}) {
  return split(f.department).length
    + split(f.assignedTo).length
    + split(f.assignedBy).length
    + split(f.priority).length;
}

/** The orders, for the moment before GET /tasks/meta lands (mirrors config/tasks.SORTS). */
export const FALLBACK_SORTS = [
  { key: 'due', label: 'Due date' },
  { key: 'assigned', label: 'Day assigned' },
  { key: 'pending', label: 'Pending days' },
  { key: 'points', label: 'Points' },
  { key: 'priority', label: 'Priority' },
  { key: 'title', label: 'Title' },
  { key: 'created', label: 'Newest first' },
];

function Section({ icon: Icon, title, hint, children }) {
  return (
    <section className="py-4 first:pt-1">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
        <Icon size={13} className="text-gray-400" /> {title}
      </h3>
      {hint && <p className="mt-0.5 text-[11px] text-gray-400">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

/** A chip that toggles. Weight and border on the base, so selecting cannot resize it. */
function Chip({ on, onClick, children, style }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={style}
      className={`min-h-[34px] inline-flex items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition ${
        style ? '' : on ? 'accent-border accent-bg on-accent' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
      }`}
    >
      {children}
    </button>
  );
}

export default function TaskFilters({ open, onClose, meta, scope = 'mine', value = DEFAULT_FILTERS, onApply }) {
  const [draft, setDraft] = useState(value);
  const dark = useIsDark();

  // A fresh copy each time it opens, so backing out changes nothing.
  useEffect(() => { if (open) setDraft({ ...DEFAULT_FILTERS, ...value }); }, [open, value]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const toggleIn = (key, item) => {
    const cur = split(draft[key]);
    set({ [key]: join(cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item]) });
  };

  const people = meta?.people || [];
  const departments = meta?.departments || [];
  const sorts = meta?.sorts?.length ? meta.sorts : FALLBACK_SORTS;

  /**
   * Which side of the task the department filter reads — the server decides
   * (taskController.buildQuery) and this only says it, so nobody wonders why
   * "Sales" on their own pile changes nothing.
   */
  const deptHint = scope === 'mine'
    ? 'Of whoever assigned the task to you.'
    : scope === 'delegated'
      ? 'Of the people you assigned it to.'
      : 'Of either the assigner or the assignee.';

  const count = useMemo(() => activeFilterCount(draft), [draft]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Filter tasks"
        className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Filter tasks</h2>
            <p className="text-xs text-gray-500">
              {count ? `${count} filter${count === 1 ? '' : 's'} set` : 'Nothing narrowed down yet'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 min-h-[32px] min-w-[32px]"
            aria-label="Close"
          >
            <FiX size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto px-5">
          {/* ── Due date ───────────────────────────────────────── */}
          <Section
            icon={FiCalendar}
            title="Due date"
            hint="Today, this week and this month always keep unfinished work in view."
          >
            <div className="flex flex-wrap gap-1.5">
              {RANGES.map(([key, label]) => (
                <Chip key={key} on={draft.range === key} onClick={() => set({ range: key })}>
                  {label}
                </Chip>
              ))}
            </div>
            {draft.range === 'custom' && (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="text-[11px] font-medium text-gray-500">
                  From
                  <input
                    type="date"
                    value={draft.from}
                    onChange={(e) => set({ from: e.target.value })}
                    className="mt-1 block w-full rounded-xl border border-gray-200 px-3 text-sm min-h-[40px]"
                  />
                </label>
                <label className="text-[11px] font-medium text-gray-500">
                  To
                  <input
                    type="date"
                    value={draft.to}
                    min={draft.from || undefined}
                    onChange={(e) => set({ to: e.target.value })}
                    className="mt-1 block w-full rounded-xl border border-gray-200 px-3 text-sm min-h-[40px]"
                  />
                </label>
              </div>
            )}
          </Section>

          {/* ── Department ─────────────────────────────────────── */}
          <Section icon={FiBriefcase} title="Department" hint={deptHint}>
            {departments.length ? (
              <div className="flex flex-wrap gap-1.5">
                {departments.map((d) => (
                  <Chip key={d} on={split(draft.department).includes(d)} onClick={() => toggleIn('department', d)}>
                    {d}
                  </Chip>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400">No departments on file yet.</p>
            )}
          </Section>

          {/* ── People ─────────────────────────────────────────── */}
          {/* Only the side that can vary: on your own pile "Assigned to" would
              only ever be you, and on the pile you set "Assigned by" likewise. */}
          <Section icon={FiUser} title="People" hint="Search by name, employee code, designation or department.">
            <div className="grid gap-3">
              {scope !== 'mine' && (
                <PeoplePicker
                  label="Assigned to"
                  people={people}
                  value={split(draft.assignedTo)}
                  onChange={(ids) => set({ assignedTo: join(ids) })}
                  teamFirst={false}
                  allowSelf
                  selfId={meta?.me}
                  placeholder="Anyone"
                />
              )}
              {scope !== 'delegated' && (
                <PeoplePicker
                  label="Assigned by"
                  people={people}
                  value={split(draft.assignedBy)}
                  onChange={(ids) => set({ assignedBy: join(ids) })}
                  teamFirst={false}
                  allowSelf
                  selfId={meta?.me}
                  placeholder="Anyone"
                />
              )}
            </div>
          </Section>

          {/* ── Priority ───────────────────────────────────────── */}
          <Section icon={FiFlag} title="Priority">
            <div className="flex flex-wrap gap-1.5">
              {TASK_PRIORITY.map((p) => {
                const colour = priorityColor(p);
                const on = split(draft.priority).includes(p);
                return (
                  <Chip
                    key={p}
                    on={on}
                    onClick={() => toggleIn('priority', p)}
                    // Painted from the SERVER's palette, like the row tint the
                    // choice filters by — filled when on, tinted when off.
                    style={on
                      ? { backgroundColor: colour.solid, borderColor: colour.solid, color: '#fff' }
                      : tintStyle(colour, { dark })}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: on ? '#fff' : colour.solid }} />
                    {p}
                  </Chip>
                );
              })}
            </div>
          </Section>

          {/* ── Order ──────────────────────────────────────────── */}
          <Section icon={FiBarChart2} title="Sort by">
            <div className="flex items-center gap-2">
              <select
                value={draft.sort}
                onChange={(e) => set({ sort: e.target.value, dir: '' })}
                aria-label="Sort by"
                className="min-h-[40px] flex-1 rounded-xl border border-gray-200 bg-white px-3 text-sm text-gray-700"
              >
                {sorts.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <button
                type="button"
                onClick={() => set({ dir: draft.dir === 'desc' ? 'asc' : 'desc' })}
                aria-label="Reverse the order"
                title={draft.dir === 'desc' ? 'Descending' : draft.dir === 'asc' ? 'Ascending' : 'Natural order — click to reverse'}
                className="grid w-10 h-10 shrink-0 place-items-center rounded-xl border border-gray-200 text-gray-600 transition hover:border-gray-400"
              >
                {draft.dir === 'desc' ? <FiArrowDown size={15} /> : <FiArrowUp size={15} />}
              </button>
            </div>
          </Section>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={() => setDraft({ ...DEFAULT_FILTERS })}
            className="rounded-xl border border-gray-200 px-4 text-sm text-gray-600 transition hover:bg-gray-50 min-h-[40px]"
          >
            Reset
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl px-4 text-sm text-gray-500 transition hover:bg-gray-50 min-h-[40px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { onApply?.(draft); onClose?.(); }}
              className="rounded-xl bg-green-600 px-5 text-sm font-semibold text-white transition hover:bg-green-700 min-h-[40px]"
            >
              Show tasks
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
