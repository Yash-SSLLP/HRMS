import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ReceiptView from '../components/ReceiptView';

const CATEGORIES = ['Travel', 'Food', 'Accommodation', 'Supplies', 'Medical', 'Communication', 'Other'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Reimbursed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

const blank = { category: 'Travel', amount: '', expenseDate: '', merchant: '', description: '' };

export default function EmployeeExpenses() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(blank);
  const [receiptFile, setReceiptFile] = useState(null);
  const fileRef = useRef(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/expenses/me');
      setExpenses(res.data.expenses);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setForm(blank); setReceiptFile(null); setError(''); setShowModal(true);
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!receiptFile) { setError('Please attach a receipt (image or PDF)'); return; }
    setSaving(true);
    setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v));
      fd.append('receipt', receiptFile);
      await api.post('/expenses', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setShowModal(false);
      setForm(blank);
      setReceiptFile(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit claim');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Expense Claims">
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New Claim
        </button>
      </PageHeader>

      {error && !showModal && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Merchant</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Amount</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Receipt</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : expenses.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No claims submitted</td></tr>
            ) : expenses.map((x) => (
              <tr key={x._id}>
                <td className="px-4 py-3 text-gray-600">{new Date(x.expenseDate).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-gray-600">{x.category}</td>
                <td className="px-4 py-3">
                  {x.merchant || '-'}
                  {x.description && <div className="text-xs text-gray-500">{x.description}</div>}
                </td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">{inr.format(x.amount)}</td>
                <td className="px-4 py-3">
                  <ReceiptView expense={x} />
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[x.status] || 'bg-gray-100 text-gray-700'}`}>{x.status}</span>
                  {x.reviewNote && <div className="text-xs text-gray-500 mt-1">Note: {x.reviewNote}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">New Expense Claim</h2>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Category *</label>
                <select required value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Amount (INR) *</label>
                  <input required type="number" min="0" step="0.01" value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Expense Date *</label>
                  <input required type="date" value={form.expenseDate}
                    onChange={(e) => setForm({ ...form, expenseDate: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Merchant</label>
                <input value={form.merchant}
                  onChange={(e) => setForm({ ...form, merchant: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <textarea rows={3} value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Receipt (image or PDF) *</label>
                <input ref={fileRef} type="file" accept="image/*,application/pdf" required
                  onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                  className="mt-1 block w-full text-sm border rounded-lg px-3 py-2 file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:bg-gray-100 file:text-gray-700" />
                <p className="mt-1 text-xs text-gray-500">A receipt is required to verify your claim. Max 5 MB.</p>
              </div>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Submitting…' : 'Submit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
