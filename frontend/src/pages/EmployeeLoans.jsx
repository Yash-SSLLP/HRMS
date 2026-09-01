/**
 * EmployeeLoans — loans & advances self-service (employee portal). Lists the
 * user's loan requests from GET /loans/me and submits new ones via POST /loans.
 * Balance and status are set by HR/payroll and shown read-only here.
 *
 * The request carries the REPAYMENT PLAN, not just the amount: over how many
 * months, and which salary month the deduction starts in. The instalment is
 * derived from those two (principal ÷ months) rather than typed, so the figure
 * agreed here is the figure payroll takes. HR can still adjust any of it when
 * they approve.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const TYPES = ['Salary Advance', 'Personal Loan', 'Emergency', 'Other'];
const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Active: 'bg-indigo-100 text-indigo-800',
  Closed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The current month as `YYYY-MM`, which is what <input type="month"> speaks. */
function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** "Sep 2026" from a stored (year, month) pair, or a dash when none is set. */
const monthLabel = (y, m) => (y && m ? `${MONTHS[m - 1]} ${y}` : '-');

const blank = () => ({
  type: 'Salary Advance',
  principal: '',
  tenureMonths: '',
  // Defaults to this month: the common case is "start with my next salary",
  // and a pre-filled month is one less thing to get wrong.
  startMonth: thisMonth(),
  reason: '',
});

export default function EmployeeLoans() {
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

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

  const openCreate = () => { setForm(blank()); setShowModal(true); };

  // What the plan works out to, shown live under the fields. Rounded the same
  // way the server rounds it, so the preview cannot promise a different number.
  const months = Number(form.tenureMonths) || 0;
  const principal = Number(form.principal) || 0;
  const emiPreview = months > 0 && principal > 0 ? Math.round(principal / months) : 0;

  // Submit a new loan/advance request. The month input gives 'YYYY-MM'; the
  // server wants the two numbers separately (no date, so no timezone to slip on).
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    const [sy, sm] = String(form.startMonth || '').split('-');
    try {
      await api.post('/loans', {
        type: form.type,
        principal: Number(form.principal),
        reason: form.reason,
        tenureMonths: Number(form.tenureMonths),
        recoveryStartYear: Number(sy),
        recoveryStartMonth: Number(sm),
      });
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Request failed'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <PageHeader title="Loans & Advances">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ Request</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Principal</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">EMI</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Repayment</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Balance</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Note</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : loans.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No loans or advances yet</td></tr>
            ) : loans.map((l) => (
              <tr key={l._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{l.type}<div className="text-xs text-gray-500">{l.reason}</div></td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.principal || 0)}</td>
                <td className="px-4 py-3 text-right text-gray-600">{inr.format(l.emi || 0)}</td>
                <td className="px-4 py-3 text-gray-600 text-xs">
                  {l.tenureMonths ? `${l.tenureMonths} month${l.tenureMonths === 1 ? '' : 's'}` : '-'}
                  {l.recoveryStartMonth
                    ? <div className="text-gray-500">from {monthLabel(l.recoveryStartYear, l.recoveryStartMonth)}</div>
                    : null}
                </td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.balance || 0)}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[l.status] || 'bg-gray-100 text-gray-700'}`}>{l.status}</span></td>
                <td className="px-4 py-3 text-gray-500 text-xs">{l.reviewNote || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">Request Loan / Advance</h2>
            <form onSubmit={save} className="space-y-3">
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                {TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
              <input required type="number" min="1" placeholder="Principal Amount (₹) *" value={form.principal} onChange={(e) => setForm({ ...form, principal: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Repay over (months) *</label>
                  <input required type="number" min="1" max="60" placeholder="e.g. 6"
                    value={form.tenureMonths}
                    onChange={(e) => setForm({ ...form, tenureMonths: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Start deducting from *</label>
                  <input required type="month" min={thisMonth()}
                    value={form.startMonth}
                    onChange={(e) => setForm({ ...form, startMonth: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              {/* The plan in one sentence, so nobody submits a number of months
                  without seeing what it costs them each month. */}
              {emiPreview > 0 && (
                <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  About <strong>{inr.format(emiPreview)}</strong> a month for {months} month{months === 1 ? '' : 's'},
                  {' '}starting with your{' '}
                  <strong>{monthLabel(Number(String(form.startMonth).split('-')[0]), Number(String(form.startMonth).split('-')[1]))}</strong>
                  {' '}salary. HR may adjust this before approving.
                </p>
              )}

              <textarea required rows={3} placeholder="Reason *" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Submitting…' : 'Submit'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
