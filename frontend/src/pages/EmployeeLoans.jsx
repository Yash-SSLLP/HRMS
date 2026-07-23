/**
 * EmployeeLoans — loans & advances self-service (employee portal). Lists the
 * user's loan requests from GET /loans/me and submits new ones via POST /loans.
 * EMI/balance and status are set by HR/payroll and shown read-only here.
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
const blank = { type: 'Salary Advance', principal: '', reason: '' };

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

  const openCreate = () => { setForm(blank); setShowModal(true); };
  // Submit a new loan/advance request (principal coerced to a number).
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      await api.post('/loans', { ...form, principal: Number(form.principal) });
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
            <th className="px-4 py-3 text-right font-medium text-gray-700">Balance</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Note</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : loans.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No loans or advances yet</td></tr>
            ) : loans.map((l) => (
              <tr key={l._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{l.type}<div className="text-xs text-gray-500">{l.reason}</div></td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.principal || 0)}</td>
                <td className="px-4 py-3 text-right text-gray-600">{inr.format(l.emi || 0)}</td>
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
