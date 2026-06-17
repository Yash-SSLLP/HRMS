import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const QUESTION_TYPES = [
  { value: 'single', label: 'Single choice' },
  { value: 'multi', label: 'Multiple choice' },
  { value: 'text', label: 'Free text' },
];

const blankQuestion = () => ({ text: '', type: 'single', options: [''] });
const blankForm = () => ({ title: '', description: '', anonymous: false, active: true, questions: [blankQuestion()] });

export default function AdminSurveys() {
  const [surveys, setSurveys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState('');

  const [resultsFor, setResultsFor] = useState(null); // survey
  const [resultsData, setResultsData] = useState(null);
  const [resultsLoading, setResultsLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/surveys/admin/all');
      setSurveys(res.data.surveys);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load surveys');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // ---- form / question builder helpers ----
  const openCreate = () => {
    setEditingId(null);
    setForm(blankForm());
    setModalError('');
    setShowModal(true);
  };
  const openEdit = (s) => {
    setEditingId(s._id);
    setForm({
      title: s.title || '',
      description: s.description || '',
      anonymous: !!s.anonymous,
      active: s.active !== false,
      questions: (s.questions || []).length
        ? s.questions.map((q) => ({ text: q.text || '', type: q.type || 'single', options: (q.options || []).length ? [...q.options] : [''] }))
        : [blankQuestion()],
    });
    setModalError('');
    setShowModal(true);
  };

  const setQuestion = (qi, patch) => {
    setForm((f) => ({ ...f, questions: f.questions.map((q, i) => (i === qi ? { ...q, ...patch } : q)) }));
  };
  const addQuestion = () => setForm((f) => ({ ...f, questions: [...f.questions, blankQuestion()] }));
  const removeQuestion = (qi) => setForm((f) => ({ ...f, questions: f.questions.filter((_, i) => i !== qi) }));
  const setOption = (qi, oi, value) => {
    setForm((f) => ({
      ...f,
      questions: f.questions.map((q, i) => (i === qi ? { ...q, options: q.options.map((o, j) => (j === oi ? value : o)) } : q)),
    }));
  };
  const addOption = (qi) => {
    setForm((f) => ({ ...f, questions: f.questions.map((q, i) => (i === qi ? { ...q, options: [...q.options, ''] } : q)) }));
  };
  const removeOption = (qi, oi) => {
    setForm((f) => ({ ...f, questions: f.questions.map((q, i) => (i === qi ? { ...q, options: q.options.filter((_, j) => j !== oi) } : q)) }));
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setModalError('');
    try {
      const payload = {
        title: form.title,
        description: form.description,
        anonymous: form.anonymous,
        active: form.active,
        questions: form.questions.map((q) => ({
          text: q.text,
          type: q.type,
          options: q.type === 'text' ? [] : q.options.map((o) => o.trim()).filter(Boolean),
        })),
      };
      if (editingId) await api.put(`/surveys/${editingId}`, payload);
      else await api.post('/surveys', payload);
      setShowModal(false);
      await load();
    } catch (err) {
      setModalError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s) => {
    if (!window.confirm(`Delete survey "${s.title}"? Its responses will also be deleted.`)) return;
    try {
      await api.delete(`/surveys/${s._id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    }
  };

  const openResults = async (s) => {
    setResultsFor(s);
    setResultsData(null);
    setResultsLoading(true);
    try {
      const res = await api.get(`/surveys/${s._id}/results`);
      setResultsData(res.data);
    } catch (err) {
      setResultsData({ error: err.response?.data?.message || 'Failed to load results' });
    } finally {
      setResultsLoading(false);
    }
  };

  return (
    <div>
      <PageHeader title="Surveys & Polls" subtitle="Create surveys, collect responses, and review the results.">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Survey</button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Title</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Questions</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Responses</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : surveys.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No surveys yet</td></tr>
            ) : surveys.map((s) => (
              <tr key={s._id}>
                <td className="px-4 py-3 font-medium text-gray-900">
                  {s.title}
                  {s.anonymous && <span className="ml-2 text-xs px-2 py-0.5 rounded-lg bg-purple-100 text-purple-800">anonymous</span>}
                  {s.description && <div className="text-xs text-gray-500">{s.description}</div>}
                </td>
                <td className="px-4 py-3 text-gray-600">{(s.questions || []).length}</td>
                <td className="px-4 py-3 text-gray-600">{s.responseCount ?? 0}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${s.active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                    {s.active ? 'Active' : 'Closed'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openResults(s)} className="text-emerald-700 hover:underline">Results</button>
                  <button onClick={() => openEdit(s)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(s)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create / Edit modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Survey' : 'New Survey'}</h2>
            <form onSubmit={save} className="space-y-4">
              <div>
                <label className="block text-sm text-gray-700">Title *</label>
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.anonymous} onChange={(e) => setForm({ ...form, anonymous: e.target.checked })} />
                  Anonymous responses
                </label>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Active
                </label>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-gray-800">Questions</span>
                  <button type="button" onClick={addQuestion} className="text-sm text-blue-600 hover:underline">+ Add question</button>
                </div>
                {form.questions.map((q, qi) => (
                  <div key={qi} className="border rounded-lg p-3 space-y-2">
                    <div className="flex items-start gap-2">
                      <input required placeholder={`Question ${qi + 1} *`} value={q.text}
                        onChange={(e) => setQuestion(qi, { text: e.target.value })}
                        className="block w-full border rounded-lg px-3 py-2" />
                      <select value={q.type} onChange={(e) => setQuestion(qi, { type: e.target.value })}
                        className="border rounded-lg px-2 py-2 text-sm">
                        {QUESTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                      </select>
                      {form.questions.length > 1 && (
                        <button type="button" onClick={() => removeQuestion(qi)} className="text-red-600 text-sm px-2 py-2">✕</button>
                      )}
                    </div>
                    {q.type !== 'text' && (
                      <div className="pl-1 space-y-1.5">
                        {q.options.map((opt, oi) => (
                          <div key={oi} className="flex items-center gap-2">
                            <input placeholder={`Option ${oi + 1}`} value={opt}
                              onChange={(e) => setOption(qi, oi, e.target.value)}
                              className="block w-full border rounded-lg px-3 py-1.5 text-sm" />
                            {q.options.length > 1 && (
                              <button type="button" onClick={() => removeOption(qi, oi)} className="text-red-600 text-sm px-1">✕</button>
                            )}
                          </div>
                        ))}
                        <button type="button" onClick={() => addOption(qi)} className="text-xs text-blue-600 hover:underline">+ Add option</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {modalError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{modalError}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Results modal */}
      {resultsFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="card-title">{resultsFor.title} — Results</h2>
              <button type="button" onClick={() => setResultsFor(null)} className="text-gray-500 hover:text-gray-800 text-sm">✕</button>
            </div>
            {resultsLoading ? (
              <div className="text-sm text-gray-500 py-4">Loading…</div>
            ) : resultsData?.error ? (
              <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{resultsData.error}</div>
            ) : resultsData ? (
              <div className="space-y-5">
                <p className="text-sm text-gray-500">{resultsData.totalResponses} total response{resultsData.totalResponses === 1 ? '' : 's'}{resultsData.survey?.anonymous ? ' · anonymous' : ''}</p>
                {(resultsData.results || []).map((r) => (
                  <div key={r.questionIndex}>
                    <p className="text-sm font-medium text-gray-800 mb-2">{r.text}</p>
                    {r.type === 'text' ? (
                      (r.texts || []).length === 0 ? (
                        <p className="text-xs text-gray-400">No answers</p>
                      ) : (
                        <ul className="space-y-1">
                          {r.texts.map((t, ti) => (
                            <li key={ti} className="text-sm text-gray-700 bg-gray-50 border rounded-lg px-3 py-1.5">{t}</li>
                          ))}
                        </ul>
                      )
                    ) : (
                      (() => {
                        const counts = r.counts || {};
                        const entries = Object.entries(counts);
                        const max = Math.max(1, ...entries.map(([, c]) => c));
                        return entries.length === 0 ? (
                          <p className="text-xs text-gray-400">No options</p>
                        ) : (
                          <div className="space-y-1.5">
                            {entries.map(([opt, count]) => (
                              <div key={opt}>
                                <div className="flex justify-between text-xs text-gray-600 mb-0.5">
                                  <span>{opt}</span>
                                  <span>{count}</span>
                                </div>
                                <div className="h-2 bg-gray-100 rounded-lg overflow-hidden">
                                  <div className="h-full bg-blue-500 rounded-lg" style={{ width: `${(count / max) * 100}%` }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      })()
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
