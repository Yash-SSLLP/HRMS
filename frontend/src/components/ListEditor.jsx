/**
 * ListEditor — an ordered, editable list of text rows: move up, move down,
 * remove, add. The ORDER is the point of it — every list edited here is shown
 * to somebody else in exactly this order (the advance form's purposes and terms,
 * the Cash Out categories).
 *
 * Lifted out of LoanFormSettingsModal when the Cash Out categories needed the
 * same editor, so the two cannot drift into different ways of doing one thing.
 * The rows carry their own ids — build them with `rowsOf`.
 */
import { useLayoutEffect, useRef } from 'react';
import { FiArrowDown, FiArrowUp, FiPlus, FiTrash2 } from 'react-icons/fi';

// Rows carry an id so React keeps each field's focus and caret through a
// reorder; the text alone is not a key (two blank rows would collide).
let nextId = 1;

/**
 * Turn a list of strings into editor rows.
 * @param {string[]} list
 * @returns {{id: number, text: string}[]}
 */
export const rowsOf = (list) => (list || []).map((text) => ({ id: nextId++, text }));

const ICON_BTN = 'p-2 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-30';

/**
 * @param {Object} props
 * @param {{id:number,text:string}[]} props.rows
 * @param {(rows) => void} props.onChange
 * @param {boolean} [props.multiline] - paragraphs (terms) instead of one-liners
 * @param {boolean} [props.numbered] - show 1., 2. … beside each row
 * @param {number} props.maxLength - per row
 * @param {number} props.maxItems
 * @param {string} props.placeholder
 * @param {string} props.itemName - "purpose" / "term" / "category", for labels
 * @param {React.ReactNode} props.empty - shown when there are no rows
 * @param {React.ReactNode} [props.extra] - more buttons beside "Add"
 * @param {string} [props.fullText] - said once the list is full
 */
export default function ListEditor({
  rows, onChange, multiline, numbered, maxLength, maxItems, placeholder, itemName, empty, extra, fullText,
}) {
  const refs = useRef({});
  // A row just added takes the focus in the SAME commit that creates it. A timer
  // left a gap in which the next keystrokes still went to the row before —
  // type "Medical", Enter, "Education" and the first row read "MedicalEducation".
  const focusNext = useRef(null);
  useLayoutEffect(() => {
    if (focusNext.current == null) return;
    refs.current[focusNext.current]?.focus();
    focusNext.current = null;
  });

  const insertAt = (i) => {
    const row = { id: nextId++, text: '' };
    const next = [...rows];
    next.splice(i, 0, row);
    focusNext.current = row.id;
    onChange(next);
  };
  const move = (i, by) => {
    const next = [...rows];
    const [row] = next.splice(i, 1);
    next.splice(i + by, 0, row);
    onChange(next);
  };
  const full = rows.length >= maxItems;

  return (
    <>
      {rows.length ? (
        <ul className="space-y-2">
          {rows.map((row, i) => {
            const Field = multiline ? 'textarea' : 'input';
            return (
              <li key={row.id} className="flex items-start gap-1.5">
                {numbered && <span className="w-6 shrink-0 pt-2 text-sm text-gray-500 text-right">{i + 1}.</span>}
                <Field
                  ref={(el) => { refs.current[row.id] = el; }}
                  value={row.text}
                  maxLength={maxLength}
                  placeholder={placeholder}
                  rows={multiline ? 2 : undefined}
                  aria-label={`${itemName} ${i + 1}`}
                  onChange={(e) => onChange(rows.map((r) => (r.id === row.id ? { ...r, text: e.target.value } : r)))}
                  // Enter in a one-line row starts the next one, the way a list
                  // is typed; a term is a paragraph, so Enter stays a line break.
                  onKeyDown={multiline ? undefined : (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); if (!full) insertAt(i + 1); }
                  }}
                  className={`min-w-0 flex-1 border rounded-lg px-3 py-2 text-sm ${multiline ? 'resize-y' : ''}`}
                />
                <div className="flex shrink-0 items-center">
                  <button type="button" className={ICON_BTN} onClick={() => move(i, -1)} disabled={i === 0}
                    aria-label={`Move ${itemName} ${i + 1} up`} title="Move up"><FiArrowUp size={15} /></button>
                  <button type="button" className={ICON_BTN} onClick={() => move(i, 1)} disabled={i === rows.length - 1}
                    aria-label={`Move ${itemName} ${i + 1} down`} title="Move down"><FiArrowDown size={15} /></button>
                  <button type="button" className={`${ICON_BTN} hover:text-red-600`}
                    onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
                    aria-label={`Remove ${itemName} ${i + 1}`} title="Remove"><FiTrash2 size={15} /></button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : empty}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => insertAt(rows.length)} disabled={full}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50">
          <FiPlus size={14} /> Add {itemName}
        </button>
        {extra}
        {full && <span className="text-xs text-gray-500">{fullText || `That is the most the form takes (${maxItems}).`}</span>}
      </div>
    </>
  );
}
