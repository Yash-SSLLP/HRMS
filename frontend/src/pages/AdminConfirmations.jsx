import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_FILTERS = ['All', 'Probation', 'Extended', 'Confirmed'];
const STATUS_STYLES = {
  Probation: 'bg-amber-100 text-amber-800',
  Extended: 'bg-blue-100 text-blue-800',
  Confirmed: 'bg-green-100 text-green-800',
};

const fmtDate = (d) => {
  if (!d) return '-';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleDateString();
};

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const daysUntil = (d) => {
  if (!d) return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return Math.ceil((date.getTime() - Date.now()) / MS_PER_DAY);
};

export default function AdminConfirmations() {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('All');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const qs = status && status !== 'All' ? `?status=${encodeURIComponent(status)}` : '';
      const res = await api.get(`/lifecycle/confirmations${qs}`);
      setItems(res.data.items);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (row, action) => {
    let note;
    if (action === 'confirm') {
      note = window.prompt('Optional confirmation note:', row.confirmationNote || '');
      if (note === null) return; // cancelled
    }
    try {
      const body = { action };
      if (note) body.note = note;
      await api.patch(`/lifecycle/confirmations/${row._id}`, body);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Action failed');
    }
  };

  return (
    <div>
      <PageHeader title="Confirmations" subtitle="Probation & confirmation tracking">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm"
        >
          {STATUS_FILTERS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Role</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Joined</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Probation</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Due Date</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No employees</td></tr>
            ) : items.map((row) => {
              const days = daysUntil(row.dueDate);
              const flagged = row.confirmationStatus !== 'Confirmed' && days != null && days <= 30;
              const dueClass = flagged
                ? (days < 0 ? 'text-red-700 font-semibold' : 'text-amber-700 font-semibold')
                : 'text-gray-600';
              return (
                <tr key={row._id}>
                  <td className="px-4 py-3 font-medium text-gray-900">{row.name}<div className="text-xs font-mono text-gray-500">{row.employeeCode}</div></td>
                  <td className="px-4 py-3 text-gray-600">{[row.designation, row.department].filter(Boolean).join(' · ') || '-'}</td>
                  <td className="px-4 py-3 text-gray-600">{fmtDate(row.dateOfJoining)}</td>
                  <td className="px-4 py-3 text-gray-600">{row.probationMonths != null ? `${row.probationMonths} mo` : '-'}</td>
                  <td className={`px-4 py-3 ${dueClass}`}>
                    {fmtDate(row.dueDate)}
                    {flagged && <div className="text-xs">{days < 0 ? `${Math.abs(days)}d overdue` : `in ${days}d`}</div>}
                  </td>
                  <td className="px-4 py-3"><span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[row.confirmationStatus] || 'bg-gray-200 text-gray-600'}`}>{row.confirmationStatus}</span></td>
                  <td className="px-4 py-3 text-right space-x-2">
                    {row.confirmationStatus !== 'Confirmed' && (
                      <>
                        <button onClick={() => act(row, 'confirm')} className="text-green-700 hover:underline">Confirm</button>
                        <button onClick={() => act(row, 'extend')} className="text-blue-600 hover:underline">Extend</button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
