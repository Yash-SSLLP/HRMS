/**
 * SearchableSelect — a type-to-filter replacement for a native <select>.
 *
 * Deliberately API-compatible with <select> so a long people/entity picker can
 * be converted by renaming the tag and nothing else:
 *
 *   <select value={v} onChange={(e) => set(e.target.value)} className="…">
 *     <option value="">Select employee *</option>
 *     {users.map((u) => <option key={u._id} value={u._id}>{label(u)}</option>)}
 *   </select>
 *
 * becomes <SearchableSelect …> with the same children. It reads the <option>
 * elements (including <optgroup>) as its data, and `onChange` receives the same
 * `{ target: { value, name } }` shape the existing handlers already destructure.
 *
 * `multiple` works the same way: `value` is the array, rows toggle with a
 * checkbox and the menu stays open, and the emitted event carries BOTH the array
 * and a `selectedOptions` list — so a handler written for a native multi-select
 * (`Array.from(e.target.selectedOptions, (o) => o.value)`) needs no change.
 *
 * Notes on the two fiddly bits:
 *  - The menu renders in a portal at fixed coordinates, so it is never clipped
 *    by a modal's `overflow-y-auto` or trapped under its z-index, and it flips
 *    above the field when there isn't room below.
 *  - `required` still participates in native form validation via a hidden input
 *    sized over the control (the react-select approach), so forms that rely on
 *    the browser's "please fill in this field" keep doing so.
 */
import { Children, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiChevronDown, FiSearch, FiCheck } from 'react-icons/fi';

// Below this many options a search box is more noise than help.
const SEARCH_THRESHOLD = 7;

// An <option>'s label is its text; nested elements are flattened so a label
// built from several expressions ({first} {last}) still reads as one string.
function textOf(node) {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement(node)) return textOf(node.props?.children);
  return '';
}

// Flatten children into a flat option list, keeping <optgroup> labels as
// group markers so the rendered menu can show the same structure.
function readOptions(children) {
  const out = [];
  const visit = (node, group) => {
    Children.toArray(node).forEach((child) => {
      if (!isValidElement(child)) return;
      if (child.type === 'optgroup') {
        visit(child.props.children, child.props.label || '');
        return;
      }
      if (child.type === 'option') {
        const label = textOf(child.props.children);
        out.push({
          value: child.props.value !== undefined ? String(child.props.value) : label,
          label,
          disabled: !!child.props.disabled,
          group,
        });
        return;
      }
      // Fragments / arrays from a .map() land here.
      visit(child.props?.children, group);
    });
  };
  visit(children, '');
  return out;
}

export default function SearchableSelect({
  value,
  onChange,
  children,
  className = '',
  disabled = false,
  required = false,
  multiple = false,
  name,
  id,
  placeholder = 'Select…',
  searchPlaceholder = 'Type to search…',
  ...rest
}) {
  const options = useMemo(() => readOptions(children), [children]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [rect, setRect] = useState(null);

  const wrapRef = useRef(null);
  const triggerRef = useRef(null);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  // Single mode tracks one value; multi mode an array (`value` is the array, as
  // it is on a native `<select multiple>`).
  const selected = useMemo(() => (
    multiple
      ? (Array.isArray(value) ? value : []).map((v) => String(v))
      : [String(value ?? '')]
  ), [multiple, value]);
  const isSelected = (v) => selected.includes(v);

  const current = options.find((o) => o.value === selected[0]);
  // The empty-value option doubles as the placeholder, as it does in a <select>.
  const chosen = multiple ? options.filter((o) => isSelected(o.value)) : [];
  const triggerLabel = multiple
    ? (chosen.length === 0 ? placeholder
      : chosen.length > 3 ? `${chosen.length} selected`
        : chosen.map((o) => o.label).join(', '))
    : (current?.label || placeholder);
  const isPlaceholder = multiple ? chosen.length === 0 : (!current || current.value === '');

  const filtered = useMemo(() => {
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return options;
    return options.filter((o) => {
      const hay = `${o.group} ${o.label}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [options, query]);

  const place = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const menuH = Math.min(320, Math.max(180, filtered.length * 36 + 56));
    // Flip above when the field sits too low to show a usable menu.
    const up = below < menuH && r.top > below;
    setRect({ left: r.left, width: r.width, top: up ? undefined : r.bottom + 4, bottom: up ? window.innerHeight - r.top + 4 : undefined, maxHeight: Math.max(160, (up ? r.top : below) - 12) });
  }, [filtered.length]);

  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onScroll = () => place();
    // `true` → also follow scrolling of any container the field sits in.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current?.contains(e.target)) return;
      if (listRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => {
    if (!open) { setQuery(''); return; }
    const i = filtered.findIndex((o) => isSelected(o.value));
    setActive(i >= 0 ? i : 0);
    // Focus the filter box so the user can just start typing.
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  // `selectedOptions` is emitted alongside `value` so the multi-select handlers
  // that already do `Array.from(e.target.selectedOptions, (o) => o.value)` keep
  // working against this component unchanged.
  const emitMulti = (values) => {
    const opts = values.map((v) => ({ value: v, label: options.find((o) => o.value === v)?.label || v }));
    onChange?.({ target: { value: values, name, selectedOptions: opts } });
  };

  const pick = (opt) => {
    if (!opt || opt.disabled) return;
    if (multiple) {
      // Toggle and stay open — picking several in a row is the whole point.
      emitMulti(isSelected(opt.value) ? selected.filter((v) => v !== opt.value) : [...selected, opt.value]);
      return;
    }
    setOpen(false);
    triggerRef.current?.focus();
    if (String(value ?? '') === opt.value) return;
    onChange?.({ target: { value: opt.value, name } });
  };

  const onKeyDown = (e) => {
    if (disabled) return;
    if (!open) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, filtered.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(filtered.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(filtered[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); triggerRef.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  const showSearch = options.length > SEARCH_THRESHOLD;

  // A native <select> with no width class sizes to its content; a block-level
  // flex trigger would instead stretch across its parent. Match the original by
  // going inline unless the call site asked for a width (block/w-full/w-…), and
  // keep a floor so the control doesn't jitter as the chosen label changes.
  const sized = /\bblock\b|\bw-(full|\d|\[|px|auto)/.test(className);
  const layout = sized ? 'flex' : 'inline-flex min-w-[9rem]';

  return (
    <div ref={wrapRef} className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={triggerRef}
        id={id}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`${className} text-left ${layout} items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed`}
        {...rest}
      >
        <span className={`flex-1 truncate ${isPlaceholder ? 'text-gray-500' : ''}`}>{triggerLabel}</span>
        <FiChevronDown size={16} className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>

      {/* Keeps `required` working with native form validation. */}
      {required && (
        <input
          type="text"
          tabIndex={-1}
          aria-hidden="true"
          required
          value={multiple ? selected.join(',') : (value ?? '')}
          onChange={() => {}}
          onFocus={() => triggerRef.current?.focus()}
          style={{ opacity: 0, position: 'absolute', bottom: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        />
      )}

      {open && rect && createPortal(
        <div
          ref={listRef}
          role="listbox"
          className="z-[100] bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden flex flex-col"
          style={{ position: 'fixed', left: rect.left, top: rect.top, bottom: rect.bottom, width: rect.width, maxHeight: rect.maxHeight }}
        >
          {showSearch && (
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100 shrink-0">
              <FiSearch size={14} className="text-gray-400 shrink-0" aria-hidden="true" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setActive(0); }}
                placeholder={searchPlaceholder}
                className="w-full text-sm outline-none bg-transparent"
              />
            </div>
          )}
          <div className="overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div className="px-3 py-3 text-sm text-gray-500">No matches</div>
            ) : filtered.map((o, i) => {
              const on = isSelected(o.value);
              const prev = filtered[i - 1];
              return (
                <div key={`${o.group}|${o.value}|${o.label}`}>
                  {o.group && o.group !== prev?.group && (
                    <div className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{o.group}</div>
                  )}
                  <button
                    type="button"
                    role="option"
                    aria-selected={on}
                    data-active={i === active}
                    disabled={o.disabled}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(o)}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 disabled:opacity-40 ${i === active ? 'bg-gray-100' : ''} ${on ? 'font-semibold text-gray-900' : 'text-gray-700'}`}
                  >
                    {multiple && (
                      <span className={`shrink-0 w-4 h-4 rounded border flex items-center justify-center ${on ? 'accent-bg border-transparent text-white' : 'border-gray-300'}`} aria-hidden="true">
                        {on && <FiCheck size={11} />}
                      </span>
                    )}
                    <span className="flex-1 truncate">{o.label}</span>
                    {!multiple && on && <FiCheck size={14} className="shrink-0 text-gray-500" aria-hidden="true" />}
                  </button>
                </div>
              );
            })}
          </div>
          {multiple && (
            <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100 shrink-0 text-xs">
              <span className="text-gray-500">{selected.length} selected</span>
              <span className="flex items-center gap-3">
                {selected.length > 0 && (
                  <button type="button" onClick={() => emitMulti([])} className="text-gray-600 hover:underline">Clear</button>
                )}
                <button type="button" onClick={() => { setOpen(false); triggerRef.current?.focus(); }} className="font-semibold text-gray-900 hover:underline">Done</button>
              </span>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
