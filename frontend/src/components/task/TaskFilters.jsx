/**
 * Task Filters — the modal behind the Filter button.
 *
 * NEW 2026-09-21. Tabs down the left, the choices on the right, Clear and
 * Filter along the bottom — the shape in the brief, and a good one: five
 * dropdowns strung across a toolbar take the same space, hide their state, and
 * cannot be cleared in one go.
 *
 * EVERY FILTER RUNS ON THE SERVER. The page holds one page of rows and nothing
 * else, so these are query parameters rather than a predicate over an array —
 * and the counters above the list come from the SAME filter, which is what
 * stops them disagreeing with the rows underneath them.
 */
import { useEffect, useMemo, useState } from 'react';
import { FiX, FiSearch, FiCheck } from 'react-icons/fi';
import { TASK_PRIORITY, FREQUENCIES, FREQUENCY_LABELS } from '../../utils/taskLifecycle';

const TABS = [
  ['category', 'Category'],
  ['assignedTo', 'Assigned to'],
  ['assignedBy', 'Assigned by'],
  ['frequency', 'Frequency'],
  ['priority', 'Priority'],
];

/** Which keys this modal owns, so Clear knows exactly what to wipe. */
export const FILTER_KEYS = TABS.map(([k]) => k);

export default function TaskFilters({ open, onClose, meta, value = {}, onApply }) {
  const [tab, setTab] = useState('category');
  const [draft, setDraft] = useState(value);
  const [query, setQuery] = useState('');

  // Opening the modal takes a fresh copy: changes are not live until Filter is
  // pressed, so backing out with Escape leaves the list exactly as it was.
  useEffect(() => { if (open) { setDraft(value); setQuery(''); } }, [open, value]);

  const options = useMemo(() => {
    const people = (meta?.people || []).map((p) => ({ key: String(p._id), label: p.name }));
    return {
      category: (meta?.categories || []).map((c) => ({ key: c.name, label: c.name })),
      assignedTo: people,
      assignedBy: people,
      frequency: FREQUENCIES.map((f) => ({ key: f, label: FREQUENCY_LABELS[f] })),
      priority: TASK_PRIORITY.map((p) => ({ key: p, label: p })),
    };
  }, [meta]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = options[tab] || [];
    return q ? list.filter((o) => o.label.toLowerCase().includes(q)) : list;
  }, [options, tab, query]);

  const selected = (key) => (draft[tab] || '').split(',').filter(Boolean).includes(key);

  const toggle = (key) => {
    const current = (draft[tab] || '').split(',').filter(Boolean);
    const next = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
    setDraft({ ...draft, [tab]: next.join(',') });
  };

  const countFor = (k) => (draft[k] || '').split(',').filter(Boolean).length;
  const total = FILTER_KEYS.reduce((n, k) => n + countFor(k), 0);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="flex w-full max-w-xl flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3">
          <h2 className="text-base font-semibold text-gray-900">Filters</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 min-h-[32px] min-w-[32px]"
            aria-label="Close"
          >
            <FiX size={18} />
          </button>
        </div>

        <div className="flex min-h-[20rem] flex-col sm:flex-row">
          {/* Tabs */}
          <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-gray-100 p-2 sm:w-40 sm:flex-col sm:border-b-0 sm:border-r">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => { setTab(key); setQuery(''); }}
                className={`min-h-[36px] flex shrink-0 items-center justify-between gap-2 rounded-lg px-3 text-left text-xs font-medium transition ${
                  tab === key ? 'bg-gray-100 accent-text' : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {label}
                {countFor(key) > 0 && (
                  <span className="rounded-full accent-bg px-1.5 text-[10px] text-white">{countFor(key)}</span>
                )}
              </button>
            ))}
          </div>

          {/* Choices */}
          <div className="flex min-w-0 flex-1 flex-col">
            {(tab === 'assignedTo' || tab === 'assignedBy' || tab === 'category') && (
              <div className="border-b border-gray-100 p-2">
                <div className="flex items-center gap-2 rounded-lg border border-gray-200 px-2">
                  <FiSearch className="shrink-0 text-gray-400" size={14} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search…"
                    className="min-w-0 flex-1 border-0 p-0 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-0 min-h-[34px]"
                  />
                </div>
              </div>
            )}

            <div className="max-h-72 flex-1 overflow-y-auto p-1">
              {shown.length === 0 ? (
                <p className="px-3 py-6 text-center text-xs text-gray-400">Nothing to choose from.</p>
              ) : (
                shown.map((o) => (
                  <button
                    key={o.key}
                    type="button"
                    onClick={() => toggle(o.key)}
                    className="flex w-full items-center gap-2 rounded-lg px-3 text-left text-sm hover:bg-gray-50 min-h-[38px]"
                  >
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      selected(o.key) ? 'border-green-600 bg-green-600 text-white' : 'border-gray-300'
                    }`}>
                      {selected(o.key) && <FiCheck size={10} />}
                    </span>
                    <span className="flex-1 truncate text-gray-700">{o.label}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={() => setDraft(Object.fromEntries(FILTER_KEYS.map((k) => [k, ''])))}
            className="rounded-xl border border-gray-200 px-4 text-sm text-gray-600 hover:bg-gray-50 min-h-[40px]"
          >
            Clear{total > 0 ? ` (${total})` : ''}
          </button>
          <button
            type="button"
            onClick={() => { onApply?.(draft); onClose?.(); }}
            className="rounded-xl bg-green-600 px-5 text-sm font-medium text-white hover:bg-green-700 min-h-[40px]"
          >
            Filter tasks
          </button>
        </div>
      </div>
    </div>
  );
}
