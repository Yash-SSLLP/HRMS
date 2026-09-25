/**
 * Choosing people, as chips.
 *
 * REWRITTEN 2026-09-22, REWORKED 2026-09-25. A <select multiple> is unusable
 * for this: a form that hands a task to four people has to SHOW the four, so it
 * is a search field, a dropdown, and the chosen people as removable chips — the
 * shape everybody knows from a mail client's To: field.
 *
 * WHAT IT OPENS WITH (2026-09-25). The brief: *"while assigning show relevant
 * one in the dropdown and we can find other by searching the name or employee
 * code or designation or department"*. So an empty box lists, in this order:
 *
 *   Myself          when the form allows it (`allowSelf`) — the assign form's
 *                   "assign it to me", and what an empty box means anyway
 *   My team         who reports to me
 *   Their teams     who reports to them
 *   Reporting line  my manager and the people above them
 *   My department   colleagues in the same department
 *
 * …and typing searches EVERYBODY on name, employee code, designation and
 * department at once. Who stands where is decided on the SERVER
 * (`relation` on every row of GET /api/tasks/meta) — "who is on my team" is a
 * walk of the reporting tree and two clients walking it separately is two
 * answers. Nobody is greyed or marked "ask only" any more: since 2026-09-25
 * anybody may be given a task.
 *
 * Somebody who has LEFT takes no new work (the portal-wide rule) and is not
 * offered; they stay as a chip if they are already on the row.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiX, FiChevronDown, FiSearch } from 'react-icons/fi';

/** Per heading. Beyond this the answer is "keep typing", not a longer list. */
const PER_GROUP = 20;

/** The second line under a name: what somebody is searching for them by. */
export function personLine(p) {
  return [p?.designation || p?.role, p?.department, p?.employeeCode].filter(Boolean).join(' · ');
}

/** Initials for the little avatar — no photo fetch per row in a dropdown. */
function initials(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** Does this person match what was typed — on any of the four things asked for? */
function matches(p, q) {
  if (!q) return true;
  return `${p.name || ''} ${p.employeeCode || ''} ${p.designation || ''} ${p.department || ''} ${p.role || ''}`
    .toLowerCase()
    .includes(q);
}

export default function PeoplePicker({
  label,
  hint,
  icon: Icon,
  people = [],
  value = [],
  onChange,
  placeholder = 'Choose someone…',
  disabled = false,
  /**
   * How many may be chosen. `1` makes it a single-select — picking replaces
   * what was there and closes the list. 0 (the default) is no limit.
   */
  max = 0,
  /**
   * Group an empty box by who is likely to be wanted, per the note at the top.
   * Transfer and the filters set this FALSE: a task that went to the wrong
   * person has to reach the right one wherever they sit, and a filter is a
   * search of everybody.
   */
  teamFirst = true,
  /** Offer "Myself" at the top. The assign form's own-task case. */
  allowSelf = false,
  /** The signed-in user's id (meta.me); falls back to the row marked `self`. */
  selfId = '',
  /** Focus the search the moment the list opens (and open it on mount). */
  autoOpen = false,
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState(null);
  const boxRef = useRef(null);
  const fieldRef = useRef(null);
  const panelRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const single = max === 1;

  // A single-select caller usually holds one id, not an array of one. Accepting
  // both and answering in the shape we were given keeps the multi callers
  // untouched while letting a form keep a plain string in state.
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

  const me = useMemo(
    () => (selfId ? byId.get(String(selfId)) : people.find((p) => p.relation === 'self')) || null,
    [selfId, byId, people]
  );
  const myId = me ? String(me._id) : '';

  /**
   * The list, in headings: `[heading, rows, extra]`, flat so the keyboard can
   * walk one array. `extra` is how many were cut off the end of that heading —
   * a count is honest, a silently truncated list is not.
   */
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const picked = new Set(selected);
    const pool = people.filter((p) => !picked.has(String(p._id)) && !p.departed);
    const others = pool.filter((p) => String(p._id) !== myId);
    const cut = (rows) => [rows.slice(0, PER_GROUP), Math.max(0, rows.length - PER_GROUP)];
    const self = allowSelf && me && !picked.has(myId) && matches(me, q) ? [me] : [];

    if (!teamFirst) {
      const everyone = others.filter((p) => matches(p, q));
      return [
        ['Myself', self, 0],
        [q ? 'Matches' : 'Everyone', ...cut(everyone)],
      ].filter(([, rows]) => rows.length);
    }

    const direct = others.filter((p) => p.relation === 'direct');
    const indirect = others.filter((p) => p.relation === 'indirect');
    // Nearest first: my own manager, then the people above them.
    const line = [...others.filter((p) => p.relation === 'manager'), ...others.filter((p) => p.relation === 'chain')];

    if (q) {
      const team = new Set([...direct, ...indirect].map((p) => String(p._id)));
      return [
        ['Myself', self, 0],
        ['My team', ...cut([...direct, ...indirect].filter((p) => matches(p, q)))],
        ['Everyone else', ...cut(others.filter((p) => !team.has(String(p._id)) && matches(p, q)))],
      ].filter(([, rows]) => rows.length);
    }

    const shown = new Set([...direct, ...indirect, ...line].map((p) => String(p._id)));
    const myDept = String(me?.department || '').trim().toLowerCase();
    const dept = myDept
      ? others.filter((p) => !shown.has(String(p._id))
        && String(p.department || '').trim().toLowerCase() === myDept)
      : [];

    const out = [
      ['Myself', self, 0],
      ['My team', ...cut(direct)],
      ['Their teams', ...cut(indirect)],
      ['Reporting line', ...cut(line)],
      [me?.department ? `${me.department} department` : 'My department', ...cut(dept)],
    ].filter(([, rows]) => rows.length);

    // Nothing at all to suggest — no team, no line, no department on file.
    // Show the directory rather than an empty box; the search narrows it.
    if (!out.some(([h]) => h !== 'Myself')) out.push(['Everyone', ...cut(others)]);
    return out;
  }, [people, query, selected, teamFirst, allowSelf, me, myId]);

  /** One array for the arrow keys to walk, in the order the headings draw. */
  const flat = useMemo(() => groups.flatMap(([, rows]) => rows), [groups]);

  useEffect(() => { setCursor(0); }, [query, open]);

  useEffect(() => {
    if (!autoOpen || disabled) return undefined;
    setOpen(true);
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [autoOpen, disabled]);

  /**
   * WHERE THE LIST GOES. It renders in a portal at fixed coordinates (like
   * SearchableSelect's menu), because every form this sits in scrolls — the
   * assign modal, the filter panel — and an absolutely positioned list inside a
   * scroller is clipped by it. Below the field when there is room, above it
   * when there is more room there, never wider than the screen.
   */
  const place = useCallback(() => {
    const r = fieldRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(Math.max(r.width, 280), window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 260 && above > below;
    setPos({
      left,
      width,
      maxHeight: Math.max(160, Math.min(380, up ? above : below)),
      ...(up ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }),
    });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place, selected.length]);

  // Close on an outside click — the field and the portalled list both count as
  // inside. A dropdown left open behind the next click is the single most
  // irritating thing a picker can do. Scrolling or resizing moves it WITH the
  // field instead of closing it: the forms it lives in scroll.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target) || panelRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

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
    // does — otherwise the only way back is a mouse trip to an 11px cross.
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

      {/* Clicking anywhere on the field opens the list AND puts the cursor in
          the search box, so the first key pressed is already a search — no
          second click into the input. The input itself is the keyboard stop. */}
      <div
        ref={fieldRef}
        onClick={() => { if (!disabled) { setOpen(true); setTimeout(() => inputRef.current?.focus(), 0); } }}
        className={`min-h-[40px] flex w-full flex-wrap items-center gap-1.5 rounded-xl border px-2 py-1.5 text-sm ${
          open ? 'accent-border ring-2 ring-gray-200' : 'border-gray-200'
        } ${disabled ? 'bg-gray-50 opacity-60' : 'bg-white cursor-text'}`}
      >
        {chosen.map((p) => (
          <span
            key={p._id}
            className="inline-flex items-center gap-1 rounded-lg bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 min-h-[24px]"
          >
            {String(p._id) === myId ? 'Myself' : p.name}
            {/* Already on the row and since departed — said plainly rather
                than quietly dropped, because the name is still on the task. */}
            {p.departed && <span className="text-[10px] font-normal text-gray-500">(left)</span>}
            {!disabled && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); remove(p._id); }}
                className="text-gray-400 transition-colors hover:text-red-600"
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
          aria-label={label || placeholder}
          className="min-w-[6rem] flex-1 border-0 bg-transparent p-0 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-0"
        />
        <FiChevronDown className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} size={14} />
      </div>

      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}

      {open && !disabled && pos && createPortal(
        <div
          ref={panelRef}
          // Above every modal this can sit in (they top out at z-[90]).
          className="people-picker-menu fixed z-[100] flex flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
          style={{
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
          }}
          // A press inside the list must not blur the search box first, or the
          // first tap on a name would close the list instead of choosing it.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
            {!flat.length && (
              <p className="px-3 py-3 text-xs text-gray-400">
                {query ? 'Nobody matches that — try a code, a designation or a department.' : 'Nobody to choose from.'}
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
                  const blocked = full && !single;
                  const isMe = String(p._id) === myId;
                  const sub = isMe ? 'Assign it to yourself' : personLine(p);
                  return (
                    <button
                      key={p._id}
                      type="button"
                      data-cursor={cursor === here ? '1' : undefined}
                      onMouseEnter={() => setCursor(here)}
                      onClick={() => add(p._id)}
                      disabled={blocked}
                      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left min-h-[44px] ${
                        cursor === here ? 'bg-gray-50' : ''
                      } ${blocked ? 'cursor-not-allowed opacity-40' : ''}`}
                    >
                      <span
                        className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-[11px] font-semibold ${
                          isMe ? 'accent-bg on-accent' : 'bg-gray-100 text-gray-600'
                        }`}
                        aria-hidden
                      >
                        {isMe ? 'Me' : initials(p.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm text-gray-800">{isMe ? `Myself (${p.name})` : p.name}</span>
                        {sub && <span className="block truncate text-[11px] text-gray-500">{sub}</span>}
                      </span>
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

          {/* Always said, even mid-search: the first screen is a shortlist, and
              nothing else on it tells you the rest of the company is reachable. */}
          <p className="flex shrink-0 items-center gap-1.5 border-t border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-500">
            <FiSearch size={11} className="shrink-0" />
            {full && !single
              ? `That is all ${max} — remove somebody to change it.`
              : 'Search anyone by name, employee code, designation or department.'}
          </p>
        </div>,
        document.body
      )}
    </div>
  );
}
