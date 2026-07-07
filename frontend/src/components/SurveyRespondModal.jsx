import { useState } from 'react';
import api from '../api/client';

// Shared modal for answering a survey/poll. Used by the full Surveys page and by
// the dashboard SurveysBanner so the response flow lives in one place.
export default function SurveyRespondModal({ survey, onClose, onDone }) {
  const [answers, setAnswers] = useState(
    (survey.questions || []).map((q) => ({ choice: [], text: '', type: q.type }))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setSingle = (qi, value) => setAnswers((prev) => prev.map((a, i) => (i === qi ? { ...a, choice: [value] } : a)));
  const toggleMulti = (qi, value) => setAnswers((prev) => prev.map((a, i) => {
    if (i !== qi) return a;
    const has = a.choice.includes(value);
    return { ...a, choice: has ? a.choice.filter((c) => c !== value) : [...a.choice, value] };
  }));
  const setText = (qi, value) => setAnswers((prev) => prev.map((a, i) => (i === qi ? { ...a, text: value } : a)));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = answers.map((a, i) => ({ questionIndex: i, choice: a.choice, text: a.text }));
      await api.post(`/surveys/${survey._id}/respond`, { answers: payload });
      onDone?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit your response');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
        <h2 className="card-title mb-1">{survey.title}</h2>
        {survey.description && <p className="text-sm text-gray-500 mb-4">{survey.description}</p>}
        <form onSubmit={submit} className="space-y-5">
          {(survey.questions || []).map((q, qi) => (
            <div key={qi}>
              <label className="block text-sm font-medium text-gray-800">{q.text}</label>
              {q.type === 'text' ? (
                <textarea rows={3} value={answers[qi]?.text || ''} onChange={(e) => setText(qi, e.target.value)}
                  className="mt-2 block w-full border rounded-lg px-3 py-2" />
              ) : (
                <div className="mt-2 space-y-1.5">
                  {(q.options || []).map((opt, oi) => (
                    <label key={oi} className="flex items-center gap-2 text-sm text-gray-700">
                      <input type={q.type === 'multi' ? 'checkbox' : 'radio'} name={`q-${qi}`}
                        checked={(answers[qi]?.choice || []).includes(opt)}
                        onChange={() => (q.type === 'multi' ? toggleMulti(qi, opt) : setSingle(qi, opt))} />
                      {opt}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
          {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
              {saving ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
