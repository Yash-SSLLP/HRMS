/**
 * A text box with suggestions — pick one, or keep what you typed.
 *
 * Built for two Training fields that a plain dropdown cannot do:
 *   · Trainer   — one of the staff, OR anybody from outside, by name.
 *   · Category  — one from the list, OR a new one, added on the spot.
 *
 * The menu is portalled to <body> at fixed coordinates (the same trick
 * SearchableSelect uses), so the form's own scroller can never clip it, and it
 * flips above the field when there is no room below. Arrow keys move, Enter
 * picks, Escape closes — and Escape is swallowed (preventDefault), so the
 * global "Esc closes the modal" handler leaves the form alone.
 *
 * THE TYPED-TEXT ROW. With `addLabel` + `onAdd`, text that matches no option
 * exactly is offered back as a row of its own ("Use “Rajesh Kumar” — outside
 * trainer", "Add “Sales” as a new category"). `addFirst` puts that row at the
 * TOP and makes it the default: for the trainer, Enter after typing an outside
 * name must keep that name — not quietly swap in the first colleague whose
 * name happens to contain the same letters. The category keeps it at the
 * bottom, so Enter after "Sal" picks "Sales" instead of creating "Sal".
 *
 * Props:
 *   value        the text in the box
 *   onChange     (text) => void — every keystroke
 *   onPick       (option) => void — an option was chosen
 *   groups       [{ label?, options: [{ key, label, sub?, icon? }] }]
 *   addLabel     (text) => string
 *   onAdd        (text) => void
 *   addFirst     boolean
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MENU_MAX_H = 288;
const ADD = '__typed__';

export default function Combobox({
  value, onChange, onPick, groups = [], placeholder, addLabel, onAdd, addFirst = false,
  leading, inputClass = '', id, autoFocus,
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState(null);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);

  const typed = String(value || '').trim();
  const q = typed.toLowerCase();
  const filtered = useMemo(() => groups
    .map((g) => ({
      ...g,
      options: (g.options || []).filter((o) => !q
        || o.label.toLowerCase().includes(q)
        || String(o.sub || '').toLowerCase().includes(q)),
    }))
    .filter((g) => g.options.length), [groups, q]);
  const flat = useMemo(() => filtered.flatMap((g) => g.options), [filtered]);
  const exact = flat.some((o) => o.label.trim().toLowerCase() === q);
  const showAdd = !!(addLabel && onAdd && q && !exact);

  // One ordered list of selectable rows, so the keyboard and the mouse agree.
  const rows = useMemo(() => {
    const opts = flat.map((o) => ({ kind: 'opt', o }));
    if (!showAdd) return opts;
    return addFirst ? [{ kind: ADD }, ...opts] : [...opts, { kind: ADD }];
  }, [flat, showAdd, addFirst]);

  useEffect(() => { setActive(0); }, [q, open]);

  const place = () => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 180 && above > below;
    const maxH = Math.max(140, Math.min(MENU_MAX_H, up ? above : below));
    const width = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos(up ? { left, width, bottom: window.innerHeight - r.top + 6, maxHeight: maxH }
      : { left, width, top: r.bottom + 6, maxHeight: maxH });
  };

  useLayoutEffect(() => {
    if (!open) return undefined;
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  // Keep the highlighted row in view while arrowing.
  useEffect(() => {
    if (!open || !menuRef.current) return;
    const el = menuRef.current.querySelector(`[data-idx="${active}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const choose = (i) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === ADD) onAdd(typed);
    else onPick?.(row.o);
    setOpen(false);
  };

  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); else setActive((a) => Math.min(rows.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') {
      if (open && rows.length) { e.preventDefault(); choose(active); }
    } else if (e.key === 'Escape') {
      if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    } else if (e.key === 'Tab') setOpen(false);
  };

  const addRow = (i) => (
    <button
      key={ADD}
      type="button"
      data-idx={i}
      role="option"
      aria-selected={active === i}
      className={`trn-combo-opt is-add ${active === i ? 'is-active' : ''}`}
      onMouseEnter={() => setActive(i)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => choose(i)}
    >
      <span className="text-lg leading-none">＋</span>
      <span className="truncate">{addLabel(typed)}</span>
    </button>
  );

  let idx = showAdd && addFirst ? 0 : -1;
  return (
    <div ref={wrapRef} className="trn-combo">
      <div className="relative">
        {leading && <span className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">{leading}</span>}
        <input
          id={id}
          autoFocus={autoFocus}
          className={`trn-input ${leading ? 'has-lead' : ''} ${inputClass}`}
          value={value || ''}
          placeholder={placeholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(e) => { onChange?.(e.target.value); setOpen(true); }}
          onKeyDown={onKey}
        />
      </div>
      {open && pos && rows.length > 0 && createPortal(
        <div ref={menuRef} className="trn-combo-menu text-gray-800" style={pos} role="listbox">
          {showAdd && addFirst && addRow(0)}
          {filtered.map((g, gi) => (
            <div key={g.label || gi}>
              {g.label && <div className="trn-combo-head">{g.label}</div>}
              {g.options.map((o) => {
                idx += 1;
                const i = idx;
                return (
                  <button
                    key={o.key}
                    type="button"
                    data-idx={i}
                    role="option"
                    aria-selected={active === i}
                    className={`trn-combo-opt ${active === i ? 'is-active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(i)}
                  >
                    {o.icon}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-gray-900">{o.label}</span>
                      {o.sub && <span className="block truncate text-xs text-gray-500">{o.sub}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {showAdd && !addFirst && addRow(rows.length - 1)}
        </div>,
        document.body,
      )}
    </div>
  );
}
