import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const REL_LABELS = { self: 'Self', manager: 'Manager', peer: 'Peer' };
const REL_STYLES = {
  self: 'bg-purple-100 text-purple-800',
  manager: 'bg-blue-100 text-blue-800',
  peer: 'bg-emerald-100 text-emerald-800',
};
const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Submitted: 'bg-green-100 text-green-800',
};
const SCORES = [1, 2, 3, 4, 5];

function RelBadge({ relationship }) {
  return (
    <span className={`text-xs px-2 py-0.5 rounded-lg ${REL_STYLES[relationship] || 'bg-gray-100 text-gray-700'}`}>
      {REL_LABELS[relationship] || relationship}
    </span>
  );
}

export default function EmployeeReviews() {
  const [assigned, setAssigned] = useState([]);
  const [about, setAbout] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Fill-in modal state
  const [active, setActive] = useState(null); // review being filled
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [aRes, bRes] = await Promise.all([
        api.get('/reviews/me/assigned'),
        api.get('/reviews/me/about'),
      ]);
      setAssigned(aRes.data.reviews);
      setAbout(bRes.data.reviews);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load reviews');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const openFill = (review) => {
    const competencies = review.cycle?.competencies?.length
      ? review.cycle.competencies
      : (review.ratings || []).map((r) => r.competency);
    const existing = {};
    (review.ratings || []).forEach((r) => { existing[r.competency] = r; });
    setActive(review);
    setModalError('');
    setForm({
      ratings: competencies.map((c) => ({
        competency: c,
        score: existing[c]?.score || 0,
        comment: existing[c]?.comment || '',
      })),
      overallRating: review.overallRating || 0,
      strengths: review.strengths || '',
      improvements: review.improvements || '',
    });
  };

  const setRating = (idx, key, value) => {
    setForm((f) => {
      const ratings = f.ratings.map((r, i) => (i === idx ? { ...r, [key]: value } : r));
      return { ...f, ratings };
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setModalError('');
    try {
      await api.patch(`/reviews/me/${active._id}`, {
        ratings: form.ratings.map((r) => ({
          competency: r.competency,
          score: Number(r.score) || 0,
          comment: r.comment,
        })),
        overallRating: Number(form.overallRating) || 0,
        strengths: form.strengths,
        improvements: form.improvements,
      });
      setActive(null);
      setForm(null);
      await load();
    } catch (err) {
      setModalError(err.response?.data?.message || 'Submit failed');
    } finally {
      setSaving(false);
    }
  };

  const empName = (r) =>
    r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : 'Employee';

  return (
    <div>
      <PageHeader title="Performance Reviews" subtitle="Reviews assigned to you and feedback shared about you." />
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Reviews assigned to me */}
      <section className="mb-8">
        <h2 className="card-title mb-3">Reviews assigned to me</h2>
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : assigned.length === 0 ? (
          <div className="bg-white shadow rounded-lg p-5 text-sm text-gray-500">You have no reviews assigned to you.</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {assigned.map((r) => (
              <div key={r._id} className="bg-white shadow rounded-lg p-5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium text-gray-900">{empName(r)}</div>
                    <div className="text-xs text-gray-500">{r.cycle?.name}</div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[r.status]}`}>{r.status}</span>
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <RelBadge relationship={r.relationship} />
                  {r.cycle?.status && <span className="text-xs text-gray-400">Cycle: {r.cycle.status}</span>}
                </div>
                <div className="mt-4">
                  {r.status === 'Pending' ? (
                    <button
                      onClick={() => openFill(r)}
                      className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700"
                    >
                      Fill in review
                    </button>
                  ) : (
                    <span className="text-sm text-gray-500">
                      Submitted{r.submittedAt ? ` · ${new Date(r.submittedAt).toLocaleDateString()}` : ''}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Feedback about me */}
      <section>
        <h2 className="card-title mb-3">Feedback about me</h2>
        <p className="text-xs text-gray-500 mb-3">Submitted feedback is shown anonymously — reviewer identities are hidden.</p>
        {loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : about.length === 0 ? (
          <div className="bg-white shadow rounded-lg p-5 text-sm text-gray-500">No feedback has been submitted about you yet.</div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {about.map((r) => (
              <div key={r._id} className="bg-white shadow rounded-lg p-5">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium text-gray-900">{r.cycle?.name}</div>
                  <RelBadge relationship={r.relationship} />
                </div>
                {r.overallRating ? (
                  <div className="mt-1 text-xs text-gray-500">Overall: {r.overallRating}/5</div>
                ) : null}
                <ul className="mt-3 space-y-2">
                  {(r.ratings || []).map((rt, i) => (
                    <li key={i} className="text-sm">
                      <div className="flex items-center justify-between">
                        <span className="text-gray-700">{rt.competency}</span>
                        <span className="text-gray-900 font-medium">{rt.score ? `${rt.score}/5` : '—'}</span>
                      </div>
                      {rt.comment && <div className="text-xs text-gray-500 mt-0.5">{rt.comment}</div>}
                    </li>
                  ))}
                </ul>
                {r.strengths && (
                  <div className="mt-3 text-sm">
                    <div className="text-xs font-medium text-gray-500">Strengths</div>
                    <p className="text-gray-700">{r.strengths}</p>
                  </div>
                )}
                {r.improvements && (
                  <div className="mt-2 text-sm">
                    <div className="text-xs font-medium text-gray-500">Areas to improve</div>
                    <p className="text-gray-700">{r.improvements}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Fill-in modal */}
      {active && form && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-1">Review: {empName(active)}</h2>
            <p className="text-xs text-gray-500 mb-4">{active.cycle?.name} · <RelBadge relationship={active.relationship} /></p>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-3">
                {form.ratings.map((rt, idx) => (
                  <div key={rt.competency || idx} className="border rounded-lg p-3">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <span className="text-sm font-medium text-gray-800">{rt.competency}</span>
                      <select
                        value={rt.score}
                        onChange={(e) => setRating(idx, 'score', e.target.value)}
                        className="border rounded-lg px-2 py-1 text-sm"
                      >
                        <option value={0}>— Rate —</option>
                        {SCORES.map((s) => (
                          <option key={s} value={s}>{'★'.repeat(s)} ({s})</option>
                        ))}
                      </select>
                    </div>
                    <input
                      placeholder="Comment (optional)"
                      value={rt.comment}
                      onChange={(e) => setRating(idx, 'comment', e.target.value)}
                      className="block w-full border rounded-lg px-3 py-2 text-sm"
                    />
                  </div>
                ))}
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Overall rating</label>
                <select
                  value={form.overallRating}
                  onChange={(e) => setForm({ ...form, overallRating: e.target.value })}
                  className="border rounded-lg px-2 py-1 text-sm"
                >
                  <option value={0}>— Rate —</option>
                  {SCORES.map((s) => (
                    <option key={s} value={s}>{'★'.repeat(s)} ({s})</option>
                  ))}
                </select>
              </div>

              <textarea
                rows={2}
                placeholder="Strengths"
                value={form.strengths}
                onChange={(e) => setForm({ ...form, strengths: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2 text-sm"
              />
              <textarea
                rows={2}
                placeholder="Areas to improve"
                value={form.improvements}
                onChange={(e) => setForm({ ...form, improvements: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2 text-sm"
              />

              {modalError && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{modalError}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => { setActive(null); setForm(null); }} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Submitting…' : 'Submit review'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
