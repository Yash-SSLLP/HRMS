/**
 * EmployeeLoans — loans & advances self-service (employee portal). Lists the
 * user's loan requests from GET /loans/me and files new ones via POST /loans.
 * Balance and status are set by HR/payroll and shown read-only here.
 *
 * The request is the company's printed ADVANCE REQUEST FORM, section for
 * section: Employee Details (read-only, from their profile), Advance Details,
 * the Terms & Conditions, and the Employee Declaration, which has to be ticked
 * before the form will submit. The purposes in the dropdown and the terms are
 * written by HR / CEO / MD / Admin and come from GET /loans/form, fetched fresh
 * each time the form opens so a newly added purpose is there at once.
 *
 * The monthly deduction is derived (amount ÷ months, rounded as the server
 * rounds it) rather than typed, so the figure on the form is the figure payroll
 * takes. The amount is capped at 3 × the employee's monthly salary; the form
 * shows their limit (`maxAmount`, their own figure only) and the server enforces
 * it. Every loan can be opened as the filled-in form (PDF) to print or keep.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiCheck } from 'react-icons/fi';
import api from '../api/client';
import { openProtectedPdf } from '../api/download';
import PageHeader from '../components/PageHeader';

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Active: 'bg-indigo-100 text-indigo-800',
  Closed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
/** Today as `YYYY-MM-DD`, which is what <input type="date"> speaks. */
function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** A year from today — the furthest the server accepts a disbursement date. */
function yearAhead() {
  const d = new Date();
  d.setDate(d.getDate() + 365);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** The current month as `YYYY-MM`, which is what <input type="month"> speaks. */
function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
/** "Sep 2026" from a stored (year, month) pair, or a dash when none is set. */
const monthLabel = (y, m) => (y && m ? `${MONTHS[m - 1]} ${y}` : '-');
/** "05 Oct 2026" from 'YYYY-MM-DD'. */
function dayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  return m ? `${m[3]} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

const blank = () => ({
  principal: '',
  purpose: '',
  // Today and this month by default: the common case is "as soon as possible,
  // from my next salary", and a pre-filled answer is one less to get wrong.
  disburseOn: today(),
  startMonth: thisMonth(),
  tenureMonths: '',
  accepted: false,
});

const LABEL = 'block text-xs font-medium text-gray-600 mb-1';
const INPUT = 'block w-full border rounded-lg px-3 py-2';
// A value the employee cannot change: looks like the field it stands in for.
const READ_ONLY = 'block w-full border rounded-lg px-3 py-2 bg-gray-50 text-gray-700 min-h-[2.5rem]';

/** One section of the form, headed the way the printed form heads it. */
function FormSection({ title, children }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-900 mb-2 pb-1 border-b border-gray-200">{title}</h3>
      {children}
    </section>
  );
}

export default function EmployeeLoans() {
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [cfg, setCfg] = useState(null);          // GET /loans/form
  const [cfgError, setCfgError] = useState('');
  const [form, setForm] = useState(blank);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(null); // the loan just filed
  const [opening, setOpening] = useState(null);     // id of the form being fetched

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/loans/me');
      setLoans(data.loans);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Fetched on every open, never cached: the purposes and the terms are edited
  // by HR, and the ones on screen are the ones the employee is accepting.
  const openCreate = async () => {
    setForm(blank());
    setFormError('');
    setSubmitted(null);
    setCfg(null);
    setCfgError('');
    setShowModal(true);
    try {
      const { data } = await api.get('/loans/form');
      setCfg(data);
    } catch (err) {
      setCfgError(err.response?.data?.message || 'Could not load the form. Close it and try again.');
    }
  };
  const close = () => { setShowModal(false); setSubmitted(null); };

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  // Repayment cannot start before the month the money is paid in, nor in a
  // month payroll has already run. Moving the date past the chosen start month
  // carries the start month along rather than leaving the form invalid.
  const disburseMonth = (form.disburseOn || '').slice(0, 7);
  const minStart = disburseMonth > thisMonth() ? disburseMonth : thisMonth();
  // Twelve months to choose from, starting there — the same window the app's
  // month chips offer, so the two clients accept the same plans.
  const maxStart = (() => {
    const [y, m] = minStart.split('-').map(Number);
    const d = new Date(y, m - 1 + 11, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  })();
  const onDisburseChange = (value) => {
    const month = (value || '').slice(0, 7);
    set(month && form.startMonth < month ? { disburseOn: value, startMonth: month } : { disburseOn: value });
  };

  // The instalment, rounded the same way the server rounds it, so the form
  // cannot promise a different number from the one payroll takes.
  const maxMonths = cfg?.maxTenureMonths || 60;
  const months = Math.round(Number(form.tenureMonths)) || 0;
  const principal = Number(form.principal) || 0;
  const emi = months > 0 && principal > 0 ? Math.round(principal / months) : 0;

  const purposes = cfg?.purposes || [];
  const terms = cfg?.terms || [];
  const applicant = cfg?.applicant || {};
  // The most this employee may ask for: salaryMultiple × their monthly salary,
  // worked out by the server (which also enforces it). 0 = no salary set up.
  const maxAmount = cfg?.maxAmount || 0;
  const multiple = cfg?.salaryMultiple || 3;
  const noSalary = !!cfg && !(maxAmount > 0);
  const overLimit = maxAmount > 0 && principal > maxAmount;
  const canSubmit = !!cfg && purposes.length > 0 && !noSalary && !overLimit && form.accepted && !saving;

  // The month input gives 'YYYY-MM'; the server wants the two numbers separately
  // (no date, so no timezone to slip on).
  const save = async (e) => {
    e.preventDefault();
    if (!form.accepted) { setFormError('Tick the declaration to accept the terms & conditions.'); return; }
    setSaving(true); setFormError('');
    const [sy, sm] = String(form.startMonth || '').split('-');
    try {
      const { data } = await api.post('/loans', {
        principal: Number(form.principal),
        purpose: form.purpose,
        requestedDisbursementOn: form.disburseOn,
        tenureMonths: months,
        recoveryStartYear: Number(sy),
        recoveryStartMonth: Number(sm),
        termsAccepted: true,
        // The terms on screen: the server refuses (409) if HR changed them
        // while the form was open, so nobody is recorded accepting unseen terms.
        acceptedTerms: cfg?.terms || [],
      });
      setSubmitted(data.loan);
      load();
    } catch (err) {
      setFormError(err.response?.data?.message || 'Request failed');
      // Terms (or the purposes) changed underneath the form: show the current
      // ones, and make the declaration be ticked again against them. On a 409
      // the tick goes FIRST, so it is gone even if the refetch below fails.
      const stale = err.response?.status === 409;
      if (stale) set({ accepted: false });
      if (stale || /purpose/i.test(err.response?.data?.message || '')) {
        try {
          const shownTerms = JSON.stringify(cfg?.terms || []);
          const { data } = await api.get('/loans/form');
          setCfg(data);
          setForm((f) => ({
            ...f,
            // Any change to the terms voids the tick, whatever error revealed it.
            accepted: JSON.stringify(data.terms || []) === shownTerms ? f.accepted : false,
            purpose: (data.purposes || []).includes(f.purpose) ? f.purpose : '',
          }));
        } catch { /* the message above still stands */ }
      }
    }
    finally { setSaving(false); }
  };

  const openForm = async (loan) => {
    setOpening(loan._id);
    try { await openProtectedPdf(`/loans/me/${loan._id}/form.pdf`, 'Could not open the form'); }
    catch (err) { toast.error(err.message); }
    finally { setOpening(null); }
  };

  return (
    <div>
      <PageHeader title="Loans & Advances">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ Request an advance</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Purpose</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Amount</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">EMI</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Repayment</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Balance</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Note</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Form</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : loans.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No loans or advances yet</td></tr>
            ) : loans.map((l) => (
              <tr key={l._id}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {l.purpose || l.type}
                  <div className="text-xs text-gray-500 font-normal">{l.purpose ? l.type : l.reason}</div>
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.principal || 0)}</td>
                <td className="px-4 py-3 text-right text-gray-600">{inr.format(l.emi || 0)}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">
                  {l.tenureMonths ? `${l.tenureMonths} month${l.tenureMonths === 1 ? '' : 's'}` : '-'}
                  {l.recoveryStartMonth
                    ? <div className="text-gray-500">from {monthLabel(l.recoveryStartYear, l.recoveryStartMonth)}</div>
                    : null}
                  {l.requestedDisbursementOn
                    ? <div className="text-gray-500">wanted {dayLabel(l.requestedDisbursementOn)}</div>
                    : null}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.balance || 0)}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[l.status] || 'bg-gray-100 text-gray-700'}`}>{l.status}</span></td>
                <td className="px-4 py-3 text-gray-500 text-xs">{l.reviewNote || '-'}</td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <button onClick={() => openForm(l)} disabled={opening === l._id} className="text-blue-600 hover:underline disabled:opacity-60">
                    {opening === l._id ? 'Opening…' : 'View form'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            {submitted ? (
              // Filed. The form is ready to open, print or keep straight away.
              <div className="text-center py-4">
                <div className="mx-auto w-12 h-12 rounded-full bg-green-100 text-green-700 flex items-center justify-center">
                  <FiCheck size={24} />
                </div>
                <h2 className="card-title mt-3">Request submitted</h2>
                <p className="text-sm text-gray-600 mt-1 max-w-md mx-auto">
                  HR has been told. Your Advance Request Form for {inr.format(submitted.principal || 0)} is ready to
                  open, print or keep for your records.
                </p>
                <div className="flex flex-wrap justify-center gap-2 mt-5">
                  <button type="button" onClick={() => openForm(submitted)} disabled={opening === submitted._id}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {opening === submitted._id ? 'Opening…' : 'Open form (PDF)'}
                  </button>
                  <button type="button" data-modal-close onClick={close} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Done</button>
                </div>
              </div>
            ) : (
              <form onSubmit={save} className="space-y-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="card-title">Advance Request Form</h2>
                    <p className="text-xs text-gray-500 mt-0.5">
                      The company&apos;s advance request form. Once you submit it, HR can print it for signing.
                    </p>
                  </div>
                  <button type="button" aria-label="Close" onClick={close} className="text-gray-400 hover:text-gray-600 text-2xl leading-none px-1">×</button>
                </div>

                {cfgError ? (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{cfgError}</div>
                ) : !cfg ? (
                  <div className="space-y-2.5 py-2"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /><div className="skeleton h-24 rounded" /></div>
                ) : (
                  <>
                    <FormSection title="Employee Details">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3 text-sm">
                        <div><span className={LABEL}>Employee Name</span><div className={READ_ONLY}>{applicant.name || '-'}</div></div>
                        <div><span className={LABEL}>Employee ID</span><div className={READ_ONLY}>{applicant.employeeCode || '-'}</div></div>
                        <div><span className={LABEL}>Designation</span><div className={READ_ONLY}>{applicant.designation || '-'}</div></div>
                        <div><span className={LABEL}>Department</span><div className={READ_ONLY}>{applicant.department || '-'}</div></div>
                      </div>
                    </FormSection>

                    <FormSection title="Advance Details">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-3">
                        <div>
                          <label htmlFor="adv-amount" className={LABEL}>Amount Requested (₹) *</label>
                          <input id="adv-amount" required type="number" min="1" max={maxAmount || undefined} step="any" inputMode="decimal"
                            placeholder="e.g. 25000" aria-invalid={overLimit || undefined} aria-describedby="adv-amount-limit"
                            value={form.principal} onChange={(e) => set({ principal: e.target.value })} className={INPUT} />
                          {maxAmount > 0 && (
                            <p id="adv-amount-limit" className={`text-[11px] mt-1 ${overLimit ? 'text-red-600' : 'text-gray-500'}`}>
                              {overLimit
                                ? `That is more than your limit of ${inr.format(maxAmount)} (${multiple} × your monthly salary).`
                                : `Up to ${inr.format(maxAmount)}, ${multiple} × your monthly salary.`}
                            </p>
                          )}
                        </div>
                        <div>
                          <label htmlFor="adv-purpose" className={LABEL}>Purpose of Advance *</label>
                          <select id="adv-purpose" required value={form.purpose} disabled={!purposes.length}
                            onChange={(e) => set({ purpose: e.target.value })} className={INPUT}>
                            <option value="">{purposes.length ? 'Select a purpose' : 'No purposes set up yet'}</option>
                            {purposes.map((p) => <option key={p} value={p}>{p}</option>)}
                          </select>
                        </div>
                        <div>
                          <label htmlFor="adv-date" className={LABEL}>Request Date of disbursement *</label>
                          <input id="adv-date" required type="date" min={today()} max={yearAhead()}
                            value={form.disburseOn} onChange={(e) => onDisburseChange(e.target.value)} className={INPUT} />
                        </div>
                        <div>
                          <label htmlFor="adv-start" className={LABEL}>Repayment Start Month *</label>
                          <input id="adv-start" required type="month" min={minStart} max={maxStart}
                            value={form.startMonth} onChange={(e) => set({ startMonth: e.target.value })} className={INPUT} />
                        </div>
                        <div>
                          <label htmlFor="adv-months" className={LABEL}>Total Repayment Months *</label>
                          <input id="adv-months" required type="number" min="1" max={maxMonths} step="1" inputMode="numeric" placeholder="e.g. 6"
                            value={form.tenureMonths} onChange={(e) => set({ tenureMonths: e.target.value })} className={INPUT} />
                        </div>
                        <div>
                          <span className={LABEL}>Monthly deduction (₹)</span>
                          <div className={READ_ONLY} aria-live="polite">{emi ? inr.format(emi) : '-'}</div>
                          <p className="text-[11px] text-gray-500 mt-1">Amount ÷ months. HR may adjust it when approving.</p>
                        </div>
                      </div>
                      {noSalary && (
                        <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          Your salary has not been set up yet, so your advance limit cannot be worked out and this form
                          cannot be submitted. Please ask HR.
                        </p>
                      )}
                      {!purposes.length && (
                        <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                          HR has not added the purposes of advance yet, so this form cannot be submitted. Please ask HR.
                        </p>
                      )}
                    </FormSection>

                    <FormSection title="Terms & Conditions">
                      {terms.length ? (
                        <ol className="list-decimal space-y-1.5 text-sm text-gray-700 max-h-56 overflow-y-auto border border-gray-200 rounded-lg py-3 pr-3 pl-8 bg-gray-50">
                          {terms.map((t, i) => <li key={i} className="whitespace-pre-line">{t}</li>)}
                        </ol>
                      ) : (
                        <p className="text-sm text-gray-500">No terms have been set.</p>
                      )}
                    </FormSection>

                    <FormSection title="Employee Declaration">
                      <label className="flex items-start gap-2.5 text-sm text-gray-800 cursor-pointer">
                        <input type="checkbox" className="mt-1 shrink-0" checked={form.accepted}
                          onChange={(e) => set({ accepted: e.target.checked })} />
                        <span>{cfg.declaration}</span>
                      </label>
                      <p className="text-[11px] text-gray-500 mt-1.5 ml-6">
                        Ticking this is your acceptance of the terms above. The date and time are recorded on the form.
                      </p>
                    </FormSection>
                  </>
                )}

                {formError && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{formError}</div>}
                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={close} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={!canSubmit}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {saving ? 'Submitting…' : 'Submit request'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
