import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS = ['Pending', 'InProgress', 'Done'];
const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  InProgress: 'bg-blue-100 text-blue-800',
  Done: 'bg-green-100 text-green-800',
};
const CATEGORY_STYLE = 'bg-gray-100 text-gray-700';
const fmt = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

export default function EmployeeOnboarding() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/onboarding/me');
      setTasks(data.tasks);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setStatus = async (t, status) => {
    try {
      const { data } = await api.patch(`/onboarding/me/${t._id}/status`, { status });
      setTasks((prev) => prev.map((x) => (x._id === t._id ? data.task : x)));
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    }
  };

  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'Done').length;
  const pct = total ? Math.round((done / total) * 100) : 0;

  return (
    <div>
      <PageHeader title="My Onboarding" subtitle={`${done} of ${total} tasks complete`} />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg p-5 mb-5">
        <div className="flex items-center justify-between mb-2">
          <span className="card-title">Progress</span>
          <span className="text-sm text-gray-500">{pct}%</span>
        </div>
        <div className="h-2 bg-gray-100 rounded">
          <div className="h-2 accent-bg rounded transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="bg-white shadow rounded-lg overflow-hidden">
        {loading ? (
          <div className="px-4 py-6 text-center text-gray-500">Loading…</div>
        ) : tasks.length === 0 ? (
          <div className="px-4 py-6 text-center text-gray-500">No onboarding tasks assigned to you</div>
        ) : (
          <ul className="divide-y divide-gray-100">
            {tasks.map((t) => {
              const isDone = t.status === 'Done';
              return (
                <li key={t._id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <div className={`font-medium ${isDone ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                      {isDone && <span className="mr-1 text-green-600">✓</span>}{t.title}
                    </div>
                    {t.description && <div className="text-xs text-gray-500 max-w-md truncate">{t.description}</div>}
                  </div>
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${CATEGORY_STYLE}`}>{t.category}</span>
                  <span className="text-xs text-gray-500 w-28">Due {fmt(t.dueDate)}</span>
                  <select value={t.status} onChange={(e) => setStatus(t, e.target.value)}
                    className={`text-xs px-2 py-1 rounded-lg border-0 ${STATUS_STYLES[t.status]}`}>
                    {STATUS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
