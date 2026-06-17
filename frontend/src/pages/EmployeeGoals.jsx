import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_STYLES = {
  Draft: 'bg-gray-100 text-gray-700',
  Active: 'bg-blue-100 text-blue-800',
  Completed: 'bg-green-100 text-green-800',
  Cancelled: 'bg-red-100 text-red-700',
};

export default function EmployeeGoals() {
  const [goals, setGoals] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/performance/goals/me');
      setGoals(data.goals);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setProgress = async (g, progress) => {
    try {
      await api.patch(`/performance/goals/me/${g._id}/progress`, { progress });
      setGoals((prev) => prev.map((x) => (x._id === g._id ? { ...x, progress } : x)));
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div>
      <PageHeader title="My Goals" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : goals.length === 0 ? (
        <p className="text-sm text-gray-500">No goals assigned to you yet.</p>
      ) : (
        <div className="space-y-3">
          {goals.map((g) => (
            <div key={g._id} className="bg-white shadow rounded-lg p-5">
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-medium text-gray-900">{g.title}</div>
                  {g.description && <div className="text-sm text-gray-500 mt-0.5">{g.description}</div>}
                  <div className="text-xs text-gray-400 mt-1">{g.period || ''}</div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[g.status]}`}>{g.status}</span>
              </div>

              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                  <span>Progress</span><span>{g.progress || 0}%</span>
                </div>
                <input type="range" min="0" max="100" value={g.progress || 0}
                  onChange={(e) => setProgress(g, Number(e.target.value))}
                  className="w-full" />
              </div>

              {g.reviewNote && (
                <div className="mt-3 text-sm text-gray-600 bg-gray-50 border rounded-lg p-2">
                  <span className="font-medium">Review: </span>{g.reviewNote}
                  {g.rating > 0 && <span className="ml-2 text-amber-600">{'★'.repeat(g.rating)}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
