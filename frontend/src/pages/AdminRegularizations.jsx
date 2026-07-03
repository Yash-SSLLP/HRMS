import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUSES = ['Pending', 'Approved', 'Rejected'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

export default function AdminRegularizations() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/regularizations${statusFilter ? `?status=${statusFilter}` : ''}`);
      setItems(data.items);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const review = async (r, status) => {
    setError('');
    let reviewNote = '';
    if (status === 'Rejected') {
      reviewNote = window.prompt('Reason for rejection (optional):') || '';
    }
    try {
      await api.patch(`/regularizations/${r._id}/status`, { status, reviewNote });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div>
      <PageHeader title="Attendance Regularization">
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
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Requested times</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No regularization requests</td></tr>
            ) : items.map((r) => (
              <tr key={r._id}>
                <td className="px-4 py-3">
                  {r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : '-'}
                  <div className="text-xs text-gray-500">{r.employee?.email}</div>
                </td>
                <td className="px-4 py-3 text-gray-700">{new Date(r.date).toLocaleDateString()}</td>
                <td className="px-4 py-3">{r.type}</td>
                <td className="px-4 py-3 text-gray-700">
                  {r.requestedCheckIn || '-'} – {r.requestedCheckOut || '-'}
                </td>
                <td className="px-4 py-3">
                  {r.reason}
                  {r.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {r.reviewNote}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[r.status]}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {r.status === 'Pending' ? (
                    <div className="flex justify-end gap-2">
                      <button onClick={() => review(r, 'Approved')}
                        className="px-3 py-1 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700">
                        Approve
                      </button>
                      <button onClick={() => review(r, 'Rejected')}
                        className="px-3 py-1 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50">
                        Reject
                      </button>
                    </div>
                  ) : (
                    <span className="text-xs text-gray-400">Reviewed</span>
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
