/**
 * EmployeeCashbook — petty-cash voucher self-service (employee portal). Lists the
 * user's vouchers from GET /cashbook/me (categories from /cashbook/me/categories)
 * and submits new payment vouchers (optional receipt, multipart) via POST
 * /cashbook/me. Vouchers stay Pending until the Account Manager approves/pays them.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};
const PAYMENT_MODES = ['Cash', 'Bank', 'UPI', 'Cheque', 'Card', 'Other'];
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });

const blank = { amount: '', date: '', category: '', paymentMode: 'Cash', party: '', referenceNo: '', description: '' };

export default function EmployeeCashbook() {
  const [vouchers, setVouchers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(blank);
  const [receipt, setReceipt] = useState(null);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [v, c] = await Promise.all([
        api.get('/cashbook/me'),
        api.get('/cashbook/me/categories').catch(() => ({ data: { categories: [] } })),
      ]);
      setVouchers(v.data.vouchers || []);
      // Petty-cash vouchers are always payments → offer 'out'/'both' categories.
      setCategories((c.data.categories || []).filter((x) => x.isActive && x.kind !== 'in'));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setForm({ ...blank, date: new Date().toISOString().slice(0, 10) });
    setReceipt(null); setError(''); setShowModal(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!(Number(form.amount) > 0)) { setError('Enter a positive amount'); return; }
    setSaving(true); setError('');
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => { if (v !== '' && v != null) fd.append(k, v); });
      if (receipt) fd.append('receipt', receipt);
      await api.post('/cashbook/me', fd);
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit voucher');
    } finally {
      setSaving(false);
    }
  };

  const pendingTotal = vouchers.filter((v) => v.status === 'Pending').reduce((a, v) => a + v.amount, 0);

  return (
    <div>
      <PageHeader title="Cash Vouchers">
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New Voucher
        </button>
      </PageHeader>

      <p className="text-sm text-gray-500 mb-4">
        Submit a petty-cash voucher with a receipt. It stays pending until the Account Manager approves and pays it from the cashbook.
      </p>

      {error && !showModal && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {pendingTotal > 0 && (
        <div className="mb-4 text-sm bg-amber-50 border border-amber-200 text-amber-800 px-3 py-2 rounded-lg">
          Pending approval: <strong>{inr.format(pendingTotal)}</strong>
        </div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Paid To / For</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Amount</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : vouchers.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No vouchers submitted</td></tr>
            ) : vouchers.map((x) => (
              <tr key={x._id}>
                <td className="px-4 py-3 text-gray-600">{new Date(x.date).toLocaleDateString('en-IN')}</td>
                <td className="px-4 py-3 text-gray-600">{x.category}</td>
                <td className="px-4 py-3">
                  {x.party || '-'}
                  {x.description && <div className="text-xs text-gray-500">{x.description}</div>}
                </td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">{inr.format(x.amount)}</td>
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
            <h2 className="card-title mb-4">New Cash Voucher</h2>
            <form onSubmit={submit} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Amount (INR) *</label>
                  <input required type="number" min="0" step="0.01" value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Date *</label>
                  <input required type="date" value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Category</label>
                  <select value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Select…</option>
                    {categories.map((c) => <option key={c._id} value={c.name}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Payment Mode</label>
                  <select value={form.paymentMode}
                    onChange={(e) => setForm({ ...form, paymentMode: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    {PAYMENT_MODES.map((m) => <option key={m}>{m}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Paid To (payee)</label>
                  <input value={form.party}
                    onChange={(e) => setForm({ ...form, party: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Bill / Reference No.</label>
                  <input value={form.referenceNo}
                    onChange={(e) => setForm({ ...form, referenceNo: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <textarea rows={2} value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Receipt (image / PDF)</label>
                <input type="file" accept="image/*,application/pdf"
                  onChange={(e) => setReceipt(e.target.files?.[0] || null)}
                  className="mt-1 block w-full text-sm" />
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
