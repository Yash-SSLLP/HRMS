/**
 * Choosing people, as chips.
 *
 * REWRITTEN 2026-09-22. A <select multiple> is unusable for this: a form that
 * hands a task to four people has to SHOW the four, and a native multi-select
 * shows a scrolling box with some rows highlighted. So: a search field, a
 * dropdown, and the chosen people as removable chips — the shape everybody
 * already knows from a mail client's To: field.
 *
 * WHAT IT OPENS WITH, and why that is the whole point of this rewrite. The
 * directory is the company; the people you hand work to are a handful. So an
 * empty box lists YOUR TEAM ONLY — your direct reports under "My team", then
 * everybody under them under "Their teams" — and typing searches the lot, with
 * matches from outside the team under "Everyone else". The relation is decided
 * on the SERVER (services/taskAccess.annotatePeople, `relation` on every row of
 * `GET /api/tasks/meta`), because "who is on my team" is a walk of the
 * reporting tree and two clients walking it separately is two answers.
 *
 * Somebody with nobody under them — most of the company — would otherwise open
 * an empty box, so they get their manager instead: the one person they would
 * normally send something to.
 *
 * WHY IT MARKS RATHER THAN HIDES. Somebody this caller may only ASK (their
 * manager, anyone senior) still appears, greyed, labelled "ask only". Hiding
 * them would produce the worst question a picker can produce — "why is my
 * manager not in this list?" — and the answer, that work does not travel
 * upward, is exactly what the label says in three words. Picking one is
 * allowed: the form then turns into a request (see AssignTaskModal).
 *
 * Somebody who has LEFT is a different case and is genuinely dropped: they take
 * no new work, which is the portal-wide rule. They are kept as a chip if they
 * are already on the row, so an old task still renders the name it was given to.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FiX, FiChevronDown } from 'react-icons/fi';

/** Per heading. Beyond this the answer is "keep typing", not a longer list. */
const PER_GROUP = 20;

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
  /**
   * How many may be chosen. `1` makes it a single-select — picking replaces
   * what was there and closes the list, which is what the split form's owner
   * box and the delegate box want. 0 (the default) is no limit.
   */
  max = 0,
  /**
   * Group an empty box by team, per the note at the top. Transfer sets this
   * FALSE: a task that went to the wrong person has to be able to reach the
   * right one wherever they sit, and offering "My team" first on that form
   * quietly suggests the answer is somewhere under you, which is exactly the
   * assumption that produced the mis-assignment.
   */
  teamFirst = true,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const single = max === 1;

  // A single-select caller usually holds one id, not an array of one. Accepting
  // both and answering in the shape we were given keeps the existing multi
  // callers untouched while letting a new form keep a plain string in state.
  const selected = useMemo(
    () => (Array.isArray(value) ? value : (value ? [value] : [])).map(String),
    [value]
  );
  const emit = (ids) => onChange?.(Array.isArray(value) ? ids : (ids[0] || ''));

  const byId = useMemo(() => new Map(people.map((p) => [String(p._id), p])), [people]);
  const chosen = useMemo(
    () => selected.map((id) => byId.get(id)).filter(Boolean),
    [selected, byId]
  );

  /**
   * The list, in headings.
   *
   * Returned as `[heading, rows, extra]` so the render stays flat and the
   * keyboard can walk one array. `extra` is how many were cut off the end of
   * that heading — a count is honest, a silently truncated list is not.
   */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const picked = new Set(selected);
    const pool = people.filter((p) => !picked.has(String(p._id)) && !p.departed);

    const hit = (p) => !q
      || `${p.name || ''} ${p.role || ''} ${p.designation || ''} ${p.department || ''}`
        .toLowerCase().includes(q);

    const cut = (rows) => [rows.slice(0, PER_GROUP), Math.max(0, rows.length - PER_GROUP)];
    const direct = pool.filter((p) => p.relation === 'direct' && hit(p));
    const indirect = pool.filter((p) => p.relation === 'indirect' && hit(p));

    // One flat directory, no headings. `self` is still dropped: no form in the
    // module has a use for handing something to the person filling it in.
    if (!teamFirst) {
      const everyone = pool.filter((p) => p.relation !== 'self' && hit(p));
      return everyone.length ? [['Everyone', ...cut(everyone)]] : [];
    }

    if (!q) {
      if (direct.length || indirect.length) {
        return [
          ['My team', ...cut(direct)],
          ['Their teams', ...cut(indirect)],
        ].filter(([, rows]) => rows.length);
      }
      // Nobody reports to them. Their manager is the person they would be
      // sending something to anyway, and an empty box is not an answer.
      const above = pool.filter((p) => p.relation === 'manager' || p.relation === 'chain');
      if (above.length) return [['Who you report to', ...cut(above)]];
      // Not even a reporting line on file — show the directory rather than
      // nothing, and let the search narrow it.
      return [['Everyone else', ...cut(pool.filter((p) => p.relation !== 'self'))]];
    }

    const rest = pool.filter(
      (p) => p.relation !== 'direct' && p.relation !== 'indirect' && hit(p)
    );
    return [
      ['My team', ...cut(direct)],
      ['Their teams', ...cut(indirect)],
      ['Everyone else', ...cut(rest)],
    ].filter(([, rows]) => rows.length);
  }, [people, query, selected, teamFirst]);

  /** One array for the arrow keys to walk, in the order the headings draw. */
  const flat = useMemo(() => groups.flatMap(([, rows]) => rows), [groups]);

  useEffect(() => { setCursor(0); }, [query, open]);

  // Close on an outside click. A dropdown that stays open behind the next thing
  // somebody clicks is the single most irritating thing a picker can do.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Keep the highlighted row on screen when the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-cursor="1"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  const full = max > 0 && selected.length >= max;

  const add = (id) => {
    const key = String(id);
    if (single) {
      emit([key]);
      setQuery('');
      setOpen(false);
      return;
    }
    if (full || selected.includes(key)) return;
    emit([...selected, key]);
    setQuery('');
    inputRef.current?.focus();
  };
  const remove = (id) => emit(selected.filter((v) => v !== String(id)));

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      if (!flat.length) return;
      setCursor((c) => (c + (e.key === 'ArrowDown' ? 1 : flat.length - 1)) % flat.length);
      return;
    }
    if (e.key === 'Enter' && open && flat[cursor]) {
      e.preventDefault();
      add(flat[cursor]._id);
      return;
    }
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      setOpen(false);
      return;
    }
    // Backspace on an empty box takes the last chip off, the way a To: field
    // does — otherwise the only way back is a mouse trip to a 11px cross.
    if (e.key === 'Backspace' && !query && selected.length) {
      remove(selected[selected.length - 1]);
    }
  };

  let index = -1; // walks `flat` as the groups render, for the cursor

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
            {/* Already on the row and since departed — said plainly rather than
                quietly dropped, because the name is still on the task. */}
            {p.departed && (
              <span className="text-[10px] font-normal accent-text opacity-60">(left)</span>
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
          onKeyDown={onKeyDown}
          placeholder={chosen.length ? '' : placeholder}
          disabled={disabled}
          className="min-w-[6rem] flex-1 border-0 bg-transparent p-0 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-0"
        />
        <FiChevronDown className="shrink-0 text-gray-400" size={14} />
      </div>

      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}

      {open && !disabled && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
          <div ref={listRef} className="max-h-60 overflow-y-auto py-1">
            {!flat.length && (
              <p className="px-3 py-3 text-xs text-gray-400">
                {query ? 'Nobody matches that.' : 'Nobody to choose from.'}
              </p>
            )}

            {groups.map(([heading, rows, extra]) => (
              <div key={heading}>
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                  {heading}
                </p>
                {rows.map((p) => {
                  index += 1;
                  const here = index;
                  const askOnly = markKey && p[markKey] === false;
                  const blocked = full && !single;
                  return (
                    <button
                      key={p._id}
                      type="button"
                      data-cursor={cursor === here ? '1' : undefined}
                      onMouseEnter={() => setCursor(here)}
                      onClick={() => add(p._id)}
                      disabled={blocked}
                      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm min-h-[40px] ${
                        cursor === here ? 'bg-gray-50' : ''
                      } ${blocked ? 'cursor-not-allowed opacity-40' : ''}`}
                    >
                      <span className={`flex-1 truncate ${askOnly ? 'text-gray-400' : 'text-gray-700'}`}>
                        {p.name}
                      </span>
                      {askOnly && (
                        <span className="shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">
                          {markLabel || 'ask only'}
                        </span>
                      )}
                      {p.role && !askOnly && (
                        <span className="shrink-0 text-[11px] text-gray-400">{p.role}</span>
                      )}
                    </button>
                  );
                })}
                {extra > 0 && (
                  <p className="px-3 pb-1 text-[11px] text-gray-400">
                    +{extra} more — keep typing to narrow it down
                  </p>
                )}
              </div>
            ))}
          </div>

          {/* Always said, even mid-search: the first screen is a team, and
              nothing else on it tells you the rest of the company is reachable. */}
          <p className="border-t border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
            {full && !single
              ? `That is all ${max} — remove somebody to change it.`
              : (teamFirst ? 'Type a name to search everyone.' : 'Type a name to narrow the list.')}
          </p>
        </div>
      )}
    </div>
  );
}
