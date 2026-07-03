import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS = ['Pending', 'Approved', 'Rejected', 'Reimbursed'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Reimbursed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });

export default function AdminExpenses() {
  const [expenses, setExpenses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/expenses', { params: filter ? { status: filter } : {} });
      setExpenses(res.data.expenses);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filter]);

  const review = async (x, status) => {
    let reviewNote;
    if (status === 'Rejected') {
      reviewNote = window.prompt('Reason for rejection (optional):') || '';
    }
    try {
      await api.patch(`/expenses/${x._id}/status`, { status, reviewNote });
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div>
      <PageHeader title="Expense Claims">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}
          className="px-3 py-2 text-sm border rounded-lg">
          <option value="">All statuses</option>
          {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Merchant</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Amount</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : expenses.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No claims</td></tr>
            ) : expenses.map((x) => (
              <tr key={x._id}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {x.employee ? `${x.employee.firstName} ${x.employee.lastName}` : '-'}
                  <div className="text-xs text-gray-500">{x.employee?.role}</div>
                </td>
                <td className="px-4 py-3 text-gray-600">{new Date(x.expenseDate).toLocaleDateString()}</td>
                <td className="px-4 py-3 text-gray-600">{x.category}</td>
                <td className="px-4 py-3">
                  {x.merchant || '-'}
                  {x.description && <div className="text-xs text-gray-500">{x.description}</div>}
                  {x.receiptUrl && (
                    <div className="text-xs">
                      <a href={x.receiptUrl} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline">Receipt</a>
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">{inr.format(x.amount)}</td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[x.status] || 'bg-gray-100 text-gray-700'}`}>{x.status}</span>
                  {x.reviewNote && <div className="text-xs text-gray-500 mt-1">Note: {x.reviewNote}</div>}
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  <button onClick={() => review(x, 'Approved')} className="text-blue-600 hover:underline">Approve</button>
                  <button onClick={() => review(x, 'Rejected')} className="text-red-600 hover:underline">Reject</button>
                  <button onClick={() => review(x, 'Reimbursed')} className="text-emerald-700 hover:underline">Mark Reimbursed</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
