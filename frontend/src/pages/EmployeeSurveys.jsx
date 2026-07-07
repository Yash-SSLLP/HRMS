import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import SurveyRespondModal from '../components/SurveyRespondModal';

export default function EmployeeSurveys() {
  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [active, setActive] = useState(null); // survey open in the modal

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/surveys');
      setSurveys(res.data.surveys);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load surveys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const open = (s) => { if (!s.answered) setActive(s); };

  return (
    <div>
      <PageHeader title="Surveys & Polls" subtitle="Share your feedback · your voice helps shape the workplace." />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {loading ? (
        <div className="text-gray-500 text-sm">Loading…</div>
      ) : surveys.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-5 text-center text-gray-500 text-sm">No active surveys right now.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {surveys.map((s) => (
            <button
              key={s._id}
              type="button"
              onClick={() => open(s)}
              disabled={s.answered}
              className={`text-left bg-white shadow rounded-lg p-5 transition ${s.answered ? 'opacity-90 cursor-default' : 'hover:shadow-md'}`}
            >
              <div className="flex items-start justify-between gap-3">
                <h3 className="card-title">{s.title}</h3>
                {s.answered && (
                  <span className="shrink-0 text-xs px-2 py-0.5 rounded-lg bg-green-100 text-green-800">✓ Submitted</span>
                )}
              </div>
              {s.description && <p className="text-sm text-gray-600 mt-1">{s.description}</p>}
              <p className="text-xs text-gray-400 mt-3">
                {(s.questions || []).length} question{(s.questions || []).length === 1 ? '' : 's'}
                {s.anonymous ? ' · anonymous' : ''}
              </p>
            </button>
          ))}
        </div>
      )}

      {active && (
        <SurveyRespondModal
          survey={active}
          onClose={() => setActive(null)}
          onDone={() => { setActive(null); load(); }}
        />
      )}
    </div>
  );
}
