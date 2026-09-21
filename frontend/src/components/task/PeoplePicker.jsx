/**
 * Choosing people, as chips.
 *
 * NEW 2026-09-21. A <select multiple> is unusable for this: a form that hands a
 * task to four people has to SHOW the four, and a native multi-select shows a
 * scrolling box with some rows highlighted. So: a search field, a dropdown, and
 * the chosen people as removable chips — the shape the brief's picker uses and
 * the one everybody already knows from a mail client's To: field.
 *
 * WHY IT MARKS RATHER THAN HIDES. Somebody this caller may only ASK (their
 * manager, anyone senior) still appears in the list, greyed, labelled "ask
 * only". Hiding them would produce the worst question a picker can produce —
 * "why is my manager not in this list?" — and the answer, that work does not
 * travel upward, is exactly what the label says in three words. Picking one is
 * allowed: the form then turns into a request (see AssignTaskModal).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FiX, FiSearch, FiChevronDown } from 'react-icons/fi';

export default function PeoplePicker({
  label,
  hint,
  icon: Icon,
  people = [],
  value = [],
  onChange,
  placeholder = 'Choose someone…',
  /** A field on a person that, when false, greys them and shows `markLabel`. */
  markKey = null,
  markLabel = '',
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  const byId = useMemo(() => new Map(people.map((p) => [String(p._id), p])), [people]);
  const chosen = useMemo(
    () => value.map((id) => byId.get(String(id))).filter(Boolean),
    [value, byId]
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const picked = new Set(value.map(String));
    return people
      .filter((p) => !picked.has(String(p._id)))
      .filter((p) => !q || `${p.name} ${p.role || ''}`.toLowerCase().includes(q))
      .slice(0, 50);
  }, [people, query, value]);

  // Close on an outside click. A dropdown that stays open behind the next thing
  // somebody clicks is the single most irritating thing a picker can do.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const add = (id) => {
    onChange?.([...value, String(id)]);
    setQuery('');
    inputRef.current?.focus();
  };
  const remove = (id) => onChange?.(value.filter((v) => String(v) !== String(id)));

  return (
    <div ref={boxRef} className="relative">
      {label && (
        <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
          {Icon && <Icon size={12} />} {label}
        </label>
      )}

      <div
        role="button"
        tabIndex={0}
        onClick={() => { if (!disabled) { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); } }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
        className={`min-h-[40px] flex w-full flex-wrap items-center gap-1.5 rounded-xl border px-2 py-1.5 text-sm ${
          open ? 'accent-border ring-2 ring-gray-200' : 'border-gray-200'
        } ${disabled ? 'bg-gray-50 opacity-60' : 'bg-white cursor-text'}`}
      >
        {chosen.map((p) => (
          <span
            key={p._id}
            className="inline-flex items-center gap-1 rounded-lg accent-bg/10 px-2 py-0.5 text-xs font-medium accent-text min-h-[24px]"
          >
            {p.name}
            {markKey && p[markKey] === false && (
              <span className="text-[10px] font-normal accent-text opacity-60">({markLabel})</span>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); remove(p._id); }}
                className="accent-text opacity-60 hover:text-blue-600"
                aria-label={`Remove ${p.name}`}
              >
                <FiX size={11} />
              </button>
            )}
          </span>
        ))}

        <input
          ref={inputRef}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder={chosen.length ? '' : placeholder}
          disabled={disabled}
          className="min-w-[6rem] flex-1 border-0 bg-transparent p-0 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-0"
        />
        <FiChevronDown className="shrink-0 text-gray-400" size={14} />
      </div>

      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}

      {open && !disabled && (
        <div className="absolute z-30 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg">
          {matches.length === 0 ? (
            <p className="px-3 py-3 text-xs text-gray-400">
              {query ? 'Nobody matches that.' : 'Everybody here is already on it.'}
            </p>
          ) : (
            matches.map((p) => {
              const askOnly = markKey && p[markKey] === false;
              return (
                <button
                  key={p._id}
                  type="button"
                  onClick={() => add(p._id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-gray-50 min-h-[40px]"
                >
                  <span className={`flex-1 truncate ${askOnly ? 'text-gray-400' : 'text-gray-700'}`}>
                    {p.name}
                  </span>
                  {askOnly && (
                    <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
                      {markLabel}
                    </span>
                  )}
                  {p.role && !askOnly && (
                    <span className="shrink-0 text-[11px] text-gray-400">{p.role}</span>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
