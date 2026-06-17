import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

export default function EmployeeSurveys() {
  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [active, setActive] = useState(null); // survey open in the modal
  const [answers, setAnswers] = useState([]); // index-aligned with active.questions
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState('');

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

  const open = (s) => {
    if (s.answered) return;
    setActive(s);
    setModalError('');
    setAnswers(
      (s.questions || []).map((q) => ({
        questionIndex: 0,
        choice: [],
        text: '',
        type: q.type,
      }))
    );
  };

  const setSingle = (qi, value) => {
    setAnswers((prev) => prev.map((a, i) => (i === qi ? { ...a, choice: [value] } : a)));
  };
  const toggleMulti = (qi, value) => {
    setAnswers((prev) => prev.map((a, i) => {
      if (i !== qi) return a;
      const has = a.choice.includes(value);
      return { ...a, choice: has ? a.choice.filter((c) => c !== value) : [...a.choice, value] };
    }));
  };
  const setText = (qi, value) => {
    setAnswers((prev) => prev.map((a, i) => (i === qi ? { ...a, text: value } : a)));
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setModalError('');
    try {
      const payload = answers.map((a, i) => ({
        questionIndex: i,
        choice: a.choice,
        text: a.text,
      }));
      await api.post(`/surveys/${active._id}/respond`, { answers: payload });
      setActive(null);
      await load();
    } catch (err) {
      setModalError(err.response?.data?.message || 'Could not submit your response');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Surveys & Polls" subtitle="Share your feedback — your voice helps shape the workplace." />

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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-1">{active.title}</h2>
            {active.description && <p className="text-sm text-gray-500 mb-4">{active.description}</p>}
            <form onSubmit={submit} className="space-y-5">
              {(active.questions || []).map((q, qi) => (
                <div key={qi}>
                  <label className="block text-sm font-medium text-gray-800">{q.text}</label>
                  {q.type === 'text' ? (
                    <textarea
                      rows={3}
                      value={answers[qi]?.text || ''}
                      onChange={(e) => setText(qi, e.target.value)}
                      className="mt-2 block w-full border rounded-lg px-3 py-2"
                    />
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {(q.options || []).map((opt, oi) => (
                        <label key={oi} className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type={q.type === 'multi' ? 'checkbox' : 'radio'}
                            name={`q-${qi}`}
                            checked={(answers[qi]?.choice || []).includes(opt)}
                            onChange={() => (q.type === 'multi' ? toggleMulti(qi, opt) : setSingle(qi, opt))}
                          />
                          {opt}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {modalError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{modalError}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setActive(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
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
