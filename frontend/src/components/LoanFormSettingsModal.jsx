/**
 * LoanFormSettingsModal — the two parts of the Advance Request Form the company
 * writes for itself: the "Purpose of Advance" dropdown and the Terms &
 * Conditions an employee must accept to submit. Opened from Admin → Loans &
 * Advances by a SuperAdmin, the CEO, the MD, or an HR Manager holding
 * loans.manage (the server's `canEdit` on GET /loans/form decides the button).
 *
 * Saving changes what NEW requests offer and ask. A request already filed keeps
 * the purpose it was filed under and the exact terms its employee accepted —
 * those were copied onto the loan when it was submitted.
 *
 * The terms follow the printed form's seven until somebody edits them; "Reset
 * to the printed terms" goes back to following them. Terms are only sent when
 * they were actually edited, so opening the dialog to add a purpose never turns
 * the printed terms into a frozen custom copy.
 *
 * PUT /loans/form { purposes, terms?, resetTerms? }.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
// The ordered-list editor, shared with Permissions → Cash Out categories.
import ListEditor, { rowsOf } from './ListEditor';

// The server's limits (config/loanForm.js), so the editor cannot build a list
// the save would refuse.
const MAX_PURPOSES = 40;
const MAX_PURPOSE_LENGTH = 80;
const MAX_TERMS = 20;
const MAX_TERM_LENGTH = 600;

/**
 * @param {Object} props
 * @param {Object} props.config - GET /loans/form (purposes, terms, termsCustom, defaultTerms, updatedAt, updatedByName)
 * @param {() => void} props.onClose
 * @param {(config) => void} props.onSaved - receives the saved configuration
 */
export default function LoanFormSettingsModal({ config, onClose, onSaved }) {
  const [purposes, setPurposes] = useState(() => rowsOf(config.purposes));
  const [terms, setTerms] = useState(() => rowsOf(config.terms));
  const [termsDirty, setTermsDirty] = useState(false);
  const [resetRequested, setResetRequested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // What the terms will be after saving: the printed form's, or a custom list.
  const followingPrinted = termsDirty ? false : (resetRequested || !config.termsCustom);

  const changeTerms = (rows) => { setTerms(rows); setTermsDirty(true); };
  const resetTerms = () => {
    setTerms(rowsOf(config.defaultTerms || []));
    setTermsDirty(false);
    setResetRequested(true);
  };

  const filledPurposes = purposes.map((r) => r.text.trim()).filter(Boolean);
  const filledTerms = terms.map((r) => r.text.trim()).filter(Boolean);

  const save = async () => {
    setSaving(true); setError('');
    const body = { purposes: filledPurposes };
    if (termsDirty) body.terms = filledTerms;
    else if (resetRequested) body.resetTerms = true;
    try {
      const { data } = await api.put('/loans/form', body);
      toast.success('Advance request form updated');
      onSaved(data);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save');
    } finally { setSaving(false); }
  };

  const updated = config.updatedAt
    ? `Last changed${config.updatedByName ? ` by ${config.updatedByName}` : ''} on ${new Date(config.updatedAt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).replace(/\b(am|pm)\b/i, (p) => p.toUpperCase())}.`
    : '';

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="card-title">Advance Request Form settings</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              What employees choose from and what they accept. Changes apply to new requests; a request already
              submitted keeps the purpose and terms it was submitted with.
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none px-1">×</button>
        </div>

        <section className="mb-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2">
            <h3 className="text-sm font-semibold text-gray-900">
              Purpose of Advance <span className="text-gray-400 font-normal">({filledPurposes.length})</span>
            </h3>
            <span className="text-xs text-gray-500">Employees must pick one of these.</span>
          </div>
          <ListEditor
            rows={purposes}
            onChange={setPurposes}
            maxLength={MAX_PURPOSE_LENGTH}
            maxItems={MAX_PURPOSES}
            placeholder="e.g. Medical emergency"
            itemName="purpose"
            empty={(
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                No purposes yet. Employees cannot submit an advance request until at least one is added.
              </p>
            )}
          />
        </section>

        <section>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 mb-2">
            <h3 className="text-sm font-semibold text-gray-900">
              Terms &amp; Conditions <span className="text-gray-400 font-normal">({filledTerms.length})</span>
            </h3>
            <span className="text-xs text-gray-500">
              {followingPrinted ? 'The printed form’s terms' : 'Custom terms'}
              {resetRequested && !termsDirty && config.termsCustom ? ' (once saved)' : ''}
            </span>
          </div>
          <ListEditor
            rows={terms}
            onChange={changeTerms}
            multiline
            numbered
            maxLength={MAX_TERM_LENGTH}
            maxItems={MAX_TERMS}
            placeholder="Write the term…"
            itemName="term"
            empty={<p className="text-sm text-gray-500">No terms. Employees will only confirm the declaration.</p>}
            extra={!followingPrinted && (
              <button type="button" onClick={resetTerms} className="px-3 py-1.5 text-sm text-gray-600 hover:underline">
                Reset to the printed terms
              </button>
            )}
          />
        </section>

        {updated && <p className="text-xs text-gray-400 mt-5">{updated}</p>}
        {error && <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
        <div className="flex justify-end gap-2 pt-4">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
          <button type="button" onClick={save} disabled={saving}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
