import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUSES = ['Pending', 'Approved', 'Rejected', 'Availed'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Availed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');

export default function AdminCompOff() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/compoff${statusFilter ? `?status=${statusFilter}` : ''}`);
      setItems(data.items);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const review = async (id, status) => {
    setError('');
    let reviewNote = '';
    if (status === 'Rejected') {
      reviewNote = window.prompt('Reason for rejection (optional):') || '';
    }
    try {
      await api.patch(`/compoff/${id}/status`, { status, reviewNote });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div>
      <PageHeader title="Comp-off">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
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
              <th className="px-4 py-3 text-left font-medium text-gray-700">Worked date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Expiry</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No comp-off requests</td></tr>
            ) : items.map((it) => (
              <tr key={it._id}>
                <td className="px-4 py-3">
                  {it.employee ? `${it.employee.firstName} ${it.employee.lastName}` : '—'}
                  <div className="text-xs text-gray-500">{it.employee?.email}</div>
                </td>
                <td className="px-4 py-3 text-gray-700">{fmtDate(it.workedDate)}</td>
                <td className="px-4 py-3">
                  <div className="max-w-md">{it.reason}</div>
                  {it.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {it.reviewNote}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-lg ${STATUS_STYLES[it.status]}`}>
                    {it.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{fmtDate(it.expiryDate)}</td>
                <td className="px-4 py-3 text-right">
                  {it.status === 'Pending' ? (
                    <div className="flex justify-end gap-3">
                      <button onClick={() => review(it._id, 'Approved')}
                        className="text-green-600 hover:underline">Approve</button>
                      <button onClick={() => review(it._id, 'Rejected')}
                        className="text-red-600 hover:underline">Reject</button>
                    </div>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
