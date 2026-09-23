import { useState } from 'react';

/**
 * The job-form locations editor: a chip per place, plus a box to add another.
 * A requisition open in Delhi, Indore and Raipur is one job with three
 * locations, and the applicant picks which one they are applying to.
 *
 * Shared by HR's job form (AdminRecruitment), the consultancy's "request a new
 * opening" form and the approver's "approve & open" form (ConsultancyJobs), so
 * all three spell a place list the same way.
 * @param {object} props
 * @param {string[]} props.value
 * @param {(next: string[]) => void} props.onChange
 * @param {string} [props.hint] - replaces the default helper line under the box
 */
export default function LocationsField({ value = [], onChange, hint }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const name = draft.trim();
    if (!name) return;
    // Case-insensitive, so "delhi" cannot join "Delhi" as a second branch.
    if (!value.some((l) => l.toLowerCase() === name.toLowerCase())) onChange([...value, name]);
    setDraft('');
  };
  return (
    <div className="sm:col-span-2">
      <label className="block text-xs text-gray-600 mb-1">Locations</label>
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {value.map((l) => (
            <span key={l} className="inline-flex items-center gap-1 text-xs font-medium bg-gray-100 text-gray-800 rounded-lg pl-2.5 pr-1 py-1 min-h-[28px]">
              {l}
              <button type="button" aria-label={`Remove ${l}`} title={`Remove ${l}`}
                onClick={() => onChange(value.filter((x) => x !== l))}
                className="inline-flex items-center justify-center w-6 h-6 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">×</button>
            </span>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          // Enter adds a location; it must not submit the whole job form, which
          // is what a bare Enter in a text input inside a <form> does.
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          placeholder={value.length ? 'Add another location' : 'e.g. Indore'}
          className="flex-1 border rounded-lg px-3 py-2"
        />
        <button type="button" onClick={add} disabled={!draft.trim()}
          className="px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap">Add</button>
      </div>
      <p className="text-[11px] text-gray-500 mt-1">
        {hint || (value.length > 1
          ? 'Applicants choose one of these on the application form.'
          : 'Add every place this role is open in — applicants then choose which one they are applying to.')}
      </p>
    </div>
  );
}
