import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS = ['Todo', 'InProgress', 'Review', 'Done'];
const STATUS_STYLES = {
  Todo: 'bg-gray-100 text-gray-700',
  InProgress: 'bg-blue-100 text-blue-800',
  Review: 'bg-amber-100 text-amber-800',
  Done: 'bg-green-100 text-green-800',
};
const PRIORITY_STYLES = { Low: 'text-gray-500', Medium: 'text-blue-600', High: 'text-amber-600', Urgent: 'text-red-600' };
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—');

export default function EmployeeTasks() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/tasks/me');
      setTasks(data.tasks);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setStatus = async (t, status) => {
    try {
      await api.patch(`/tasks/me/${t._id}/status`, { status });
      setTasks((prev) => prev.map((x) => (x._id === t._id ? { ...x, status } : x)));
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div>
      <PageHeader title="My Tasks" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Task</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Project</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Priority</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Due</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : tasks.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No tasks assigned to you</td></tr>
            ) : tasks.map((t) => (
              <tr key={t._id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{t.title}</div>
                  {t.description && <div className="text-xs text-gray-500 max-w-md truncate">{t.description}</div>}
                </td>
                <td className="px-4 py-3 text-gray-600">{t.project?.name || '—'}</td>
                <td className={`px-4 py-3 font-medium ${PRIORITY_STYLES[t.priority]}`}>{t.priority}</td>
                <td className="px-4 py-3 text-gray-600">{fmt(t.dueDate)}</td>
                <td className="px-4 py-3">
                  <select value={t.status} onChange={(e) => setStatus(t, e.target.value)}
                    className={`text-xs px-2 py-1 rounded-lg border-0 ${STATUS_STYLES[t.status]}`}>
                    {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
