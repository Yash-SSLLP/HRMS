import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const TYPES = ['Salary Advance', 'Personal Loan', 'Emergency', 'Other'];
const STATUS = ['Pending', 'Approved', 'Active', 'Closed', 'Rejected'];
const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Active: 'bg-indigo-100 text-indigo-800',
  Closed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
const blank = { employee: '', type: 'Salary Advance', principal: '', emi: '', tenureMonths: '', reason: '' };

export default function AdminLoans() {
  const [loans, setLoans] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    // Load the two lists independently so a failing employee lookup doesn't
    // blank the whole page (and vice versa).
    const q = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : '';
    const [lRes, uRes] = await Promise.allSettled([
      api.get(`/loans${q}`),
      api.get('/admin/users?active=true&excludeExecutives=true'),
    ]);
    if (lRes.status === 'fulfilled') setLoans(lRes.value.data.loans);
    else setError(lRes.reason?.response?.data?.message || 'Failed to load loans');
    if (uRes.status === 'fulfilled') setUsers(uRes.value.data.users);
    else if (lRes.status === 'fulfilled') setError(uRes.reason?.response?.data?.message || 'Could not load the employee list for the form · reload and try again.');
    setLoading(false);
  };
  useEffect(() => { load(); }, [statusFilter]);

  const openCreate = () => { setForm(blank); setShowModal(true); };
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      await api.post('/loans/admin', {
        ...form,
        principal: Number(form.principal),
        emi: Number(form.emi) || 0,
        tenureMonths: Number(form.tenureMonths) || 0,
      });
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  const setStatus = async (l, status) => {
    const body = { status };
    if (status === 'Rejected') {
      const note = window.prompt('Reason for rejection (optional):', '');
      if (note === null) return;
      body.reviewNote = note;
    }
    try { await api.patch(`/loans/${l._id}/status`, body); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Update failed'); }
  };

  const repay = async (l) => {
    const raw = window.prompt(`Record repayment for ${l.employee?.firstName || 'employee'} (balance ${inr.format(l.balance || 0)}):`, '');
    if (raw === null) return;
    const amount = Number(raw);
    if (!(amount > 0)) { alert('Enter a valid amount'); return; }
    try { await api.patch(`/loans/${l._id}/repay`, { amount }); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Repayment failed'); }
  };

  return (
    <div>
      <PageHeader title="Loans & Advances">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Loan</button>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Principal</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">EMI</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Balance</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : loans.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No loans</td></tr>
            ) : loans.map((l) => (
              <tr key={l._id}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {l.employee ? `${l.employee.firstName} ${l.employee.lastName}` : '-'}
                  <div className="text-xs text-gray-500">{l.employee?.email}</div>
                </td>
                <td className="px-4 py-3 text-gray-600">{l.type}</td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.principal || 0)}</td>
                <td className="px-4 py-3 text-right text-gray-600">{inr.format(l.emi || 0)}</td>
                <td className="px-4 py-3 text-right text-gray-700">{inr.format(l.balance || 0)}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[l.status] || 'bg-gray-100 text-gray-700'}`}>{l.status}</span></td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  {l.status === 'Pending' && (
                    <>
                      <button onClick={() => setStatus(l, 'Approved')} className="text-emerald-700 hover:underline">Approve</button>
                      <button onClick={() => setStatus(l, 'Rejected')} className="text-red-600 hover:underline">Reject</button>
                    </>
                  )}
                  {(l.status === 'Approved' || l.status === 'Active') && (
                    <button onClick={() => repay(l)} className="text-blue-600 hover:underline">Record Repayment</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">New Loan / Advance</h2>
            <form onSubmit={save} className="space-y-3">
              <select required value={form.employee} onChange={(e) => setForm({ ...form, employee: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                <option value="">Select employee *</option>
                {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.email})</option>)}
              </select>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                {TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
              <input required type="number" min="1" placeholder="Principal Amount (₹) *" value={form.principal} onChange={(e) => setForm({ ...form, principal: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input type="number" min="0" placeholder="Monthly EMI (₹)" value={form.emi} onChange={(e) => setForm({ ...form, emi: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <input type="number" min="0" placeholder="Tenure (months)" value={form.tenureMonths} onChange={(e) => setForm({ ...form, tenureMonths: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <textarea rows={2} placeholder="Reason" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
