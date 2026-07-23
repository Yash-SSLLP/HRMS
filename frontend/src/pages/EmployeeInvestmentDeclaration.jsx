/**
 * EmployeeInvestmentDeclaration — Form 12BB tax-saving declaration (employee
 * portal). Loads the declaration for a financial year via GET /declarations/me,
 * saves drafts with POST /declarations/me and submits via
 * PATCH /declarations/me/submit. Submitted/Verified declarations are read-only.
 */
import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

// Section fields, in display order, with clear labels.
const SECTION_FIELDS = [
  { key: 'section80C', label: '80C · PF / ELSS / LIC / PPF (max 1,50,000)' },
  { key: 'section80CCD1B', label: '80CCD(1B) · NPS (max 50,000)' },
  { key: 'section80D', label: '80D · Medical Insurance' },
  { key: 'section24B', label: '24B · Home Loan Interest (max 2,00,000)' },
  { key: 'section80E', label: '80E · Education Loan Interest' },
  { key: 'section80G', label: '80G · Donations' },
  { key: 'hraAnnualRent', label: 'HRA · Annual Rent Paid' },
  { key: 'ltaClaimed', label: 'LTA · Leave Travel Allowance Claimed' },
  { key: 'otherDeductions', label: 'Other Deductions' },
];

const EMPTY_SECTIONS = SECTION_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: 0 }), {});

const STATUS_STYLES = {
  Draft: 'bg-gray-200 text-gray-700',
  Submitted: 'bg-amber-100 text-amber-800',
  Verified: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

// Current Indian financial year: Apr–Mar. e.g. June 2026 -> '2026-27'.
function currentFinancialYear() {
  const now = new Date();
  const y = now.getFullYear();
  const startYear = now.getMonth() >= 3 ? y : y - 1; // month 3 === April
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endShort}`;
}

export default function EmployeeInvestmentDeclaration() {
  const [financialYear, setFinancialYear] = useState(currentFinancialYear());
  const [regime, setRegime] = useState('Old');
  const [sections, setSections] = useState(EMPTY_SECTIONS);
  const [proofs, setProofs] = useState([]);
  const [status, setStatus] = useState(null); // null = no declaration yet
  const [reviewNote, setReviewNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const readOnly = status === 'Submitted' || status === 'Verified';

  // Live sum of all declared section amounts, shown as "Total declared".
  const total = useMemo(
    () => SECTION_FIELDS.reduce((sum, f) => sum + (Number(sections[f.key]) || 0), 0),
    [sections]
  );

  const applyDeclaration = (d) => {
    if (d) {
      setRegime(d.regime || 'Old');
      setSections({ ...EMPTY_SECTIONS, ...(d.sections || {}) });
      setProofs(Array.isArray(d.proofs) ? d.proofs.map((p) => ({ label: p.label || '', url: p.url || '' })) : []);
      setStatus(d.status || null);
      setReviewNote(d.reviewNote || '');
    } else {
      setRegime('Old');
      setSections(EMPTY_SECTIONS);
      setProofs([]);
      setStatus(null);
      setReviewNote('');
    }
  };

  const load = async (fy) => {
    setLoading(true);
    setError('');
    setSuccess('');
    try {
      const { data } = await api.get(`/declarations/me?financialYear=${encodeURIComponent(fy)}`);
      applyDeclaration(data.declaration);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load declaration');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(financialYear);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [financialYear]);

  const setSection = (key, value) => {
    const n = value === '' ? 0 : Math.max(0, Number(value) || 0);
    setSections((prev) => ({ ...prev, [key]: n }));
  };

  const addProof = () => setProofs((prev) => [...prev, { label: '', url: '' }]);
  const updateProof = (i, field, value) =>
    setProofs((prev) => prev.map((p, idx) => (idx === i ? { ...p, [field]: value } : p)));
  const removeProof = (i) => setProofs((prev) => prev.filter((_, idx) => idx !== i));

  const saveDraft = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const { data } = await api.post('/declarations/me', {
        financialYear,
        regime,
        sections,
        proofs,
      });
      applyDeclaration(data.declaration);
      setSuccess('Draft saved');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save draft');
    } finally {
      setSaving(false);
    }
  };

  // Save then submit so the reviewer always sees the latest entered values.
  const submit = async () => {
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      // Persist current values first, then submit.
      await api.post('/declarations/me', { financialYear, regime, sections, proofs });
      const { data } = await api.patch('/declarations/me/submit', { financialYear });
      applyDeclaration(data.declaration);
      setSuccess('Declaration submitted for review');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit declaration');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Investment Declaration"
        subtitle="Form 12BB · declare tax-saving investments"
      >
        <input
          type="text"
          value={financialYear}
          onChange={(e) => setFinancialYear(e.target.value)}
          placeholder="2025-26"
          className="border rounded-lg px-3 py-2 text-sm w-32"
        />
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}
      {success && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">{success}</div>
      )}

      {loading ? (
        <div className="bg-white shadow rounded-lg p-5 text-center text-gray-500">Loading…</div>
      ) : (
        <div className="space-y-5">
          {status && (
            <div className="bg-white shadow rounded-lg p-5 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-700">Status</span>
                <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[status] || 'bg-gray-200 text-gray-700'}`}>
                  {status}
                </span>
              </div>
              {reviewNote && (
                <div className="text-sm text-gray-600">
                  Reviewer note: <span className="text-gray-800">{reviewNote}</span>
                </div>
              )}
            </div>
          )}

          {readOnly && (
            <div className="text-sm text-gray-600 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg">
              This declaration has been {status.toLowerCase()} and is read-only.
            </div>
          )}

          <div className="bg-white shadow rounded-lg p-5">
            <h2 className="card-title mb-4">Tax Regime</h2>
            <div className="flex gap-6">
              {['Old', 'New'].map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="radio"
                    name="regime"
                    value={r}
                    checked={regime === r}
                    disabled={readOnly}
                    onChange={() => setRegime(r)}
                  />
                  {r} Regime
                </label>
              ))}
            </div>
          </div>

          <div className="bg-white shadow rounded-lg p-5">
            <h2 className="card-title mb-4">Declared Investments &amp; Deductions</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {SECTION_FIELDS.map((f) => (
                <div key={f.key}>
                  <label className="block text-sm text-gray-700">{f.label}</label>
                  <input
                    type="number"
                    min={0}
                    value={sections[f.key] ?? 0}
                    disabled={readOnly}
                    onChange={(e) => setSection(f.key, e.target.value)}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-50"
                  />
                </div>
              ))}
            </div>
            <div className="mt-5 pt-4 border-t flex items-center justify-between">
              <span className="text-sm text-gray-600">Total declared</span>
              <span className="text-lg font-semibold text-gray-900">{inr.format(total)}</span>
            </div>
          </div>

          <div className="bg-white shadow rounded-lg p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="card-title">Proofs</h2>
              {!readOnly && (
                <button
                  type="button"
                  onClick={addProof}
                  className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50"
                >
                  + Add proof
                </button>
              )}
            </div>
            {proofs.length === 0 ? (
              <p className="text-sm text-gray-500">No proofs added.</p>
            ) : (
              <div className="space-y-3">
                {proofs.map((p, i) => (
                  <div key={i} className="flex flex-wrap gap-2 items-center">
                    <input
                      type="text"
                      value={p.label}
                      placeholder="Label (e.g. LIC receipt)"
                      disabled={readOnly}
                      onChange={(e) => updateProof(i, 'label', e.target.value)}
                      className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[12rem] disabled:bg-gray-50"
                    />
                    <input
                      type="text"
                      value={p.url}
                      placeholder="URL / document link"
                      disabled={readOnly}
                      onChange={(e) => updateProof(i, 'url', e.target.value)}
                      className="border rounded-lg px-3 py-2 text-sm flex-1 min-w-[12rem] disabled:bg-gray-50"
                    />
                    {!readOnly && (
                      <button
                        type="button"
                        onClick={() => removeProof(i)}
                        className="px-3 py-2 text-sm text-red-600 hover:underline"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {!readOnly && (
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={saveDraft}
                disabled={saving}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save Draft'}
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={saving}
                className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
              >
                {saving ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
