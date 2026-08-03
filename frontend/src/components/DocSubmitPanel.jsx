/**
 * Phone-only summary panel for the public document forms
 * (pages/DocumentSubmitForm.jsx, pages/EmployeeDocSubmit.jsx).
 *
 * On a wide screen the slots are a tile grid and the progress bar sits above
 * it. On a phone that grid collapses to one column, which would bury the sense
 * of "how much is left" under eight scrolling slots — so below `sm` the page
 * leads with this instead: who it is, a progress ring, the checklist, and the
 * submit button, all before the first slot.
 *
 * Rendered inside the <form>, so its button is a real submit.
 */
import { FiCheck } from 'react-icons/fi';

const R = 26;
const C = 2 * Math.PI * R;

/** Gold progress ring — `done` of `total` slots covered. */
export function ProgressRing({ done, total }) {
  const pct = total ? done / total : 0;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true" className="shrink-0">
      <circle cx="32" cy="32" r={R} fill="none" strokeWidth="5" className="docform-ring-track" />
      <circle
        cx="32" cy="32" r={R} fill="none" strokeWidth="5" strokeLinecap="round"
        className="docform-ring-fill"
        strokeDasharray={`${(C * pct).toFixed(1)} ${C.toFixed(1)}`}
        transform="rotate(-90 32 32)"
      />
      <text x="32" y="36" textAnchor="middle" className="docform-ring-text" fontSize="15" fontWeight="700">
        {done}/{total}
      </text>
    </svg>
  );
}

/**
 * @param {string} name - who is submitting
 * @param {string} [subtitle] - job title / employee code
 * @param {{label: string, done: boolean}[]} items - the checklist
 * @param {boolean} submitting
 * @param {string} [note] - small line under the button
 */
export default function DocSubmitPanel({ name, subtitle, items, submitting, note }) {
  const done = items.filter((i) => i.done).length;
  return (
    <div className="docform-panel sm:hidden mb-4">
      <div className="flex items-center gap-3">
        <ProgressRing done={done} total={items.length} />
        <div className="min-w-0">
          <div className="text-sm font-semibold docfield-label truncate">{name}</div>
          {subtitle && <div className="text-xs docfield-meta truncate">{subtitle}</div>}
          <div className="text-xs docform-sub font-medium mt-0.5">
            {done === items.length ? 'All documents attached' : `${items.length - done} still to attach`}
          </div>
        </div>
      </div>

      <ul className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1">
        {items.map((i) => (
          <li key={i.label} className="flex items-center gap-1.5 text-[11px] min-w-0">
            {i.done
              ? <FiCheck size={12} className="docform-check shrink-0" />
              : <span className="docform-todo shrink-0" aria-hidden="true">○</span>}
            <span className={`truncate ${i.done ? 'docfield-label' : 'docfield-meta'}`}>{i.label}</span>
          </li>
        ))}
      </ul>

      <button type="submit" disabled={submitting} className="docform-submit w-full py-2.5 font-semibold mt-3">
        {submitting ? 'Submitting…' : 'Submit documents'}
      </button>
      {note && <p className="text-[11px] text-center docfield-meta mt-1.5">{note}</p>}
    </div>
  );
}
