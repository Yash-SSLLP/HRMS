/**
 * EmployeeReviews — performance reviews for the logged-in user (employee portal).
 * Loads reviews assigned to me (GET /reviews/me/assigned) and feedback about me
 * (GET /reviews/me/about, shown anonymised), and submits filled-in reviews via
 * PATCH /reviews/me/:id (per-competency scores + overall + strengths/improvements).
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import { FiStar, FiX, FiCheck } from 'react-icons/fi';
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
// Naming the scores turns "3 stars" into a judgement the reviewer can stand
// behind, and keeps two reviewers closer to meaning the same thing by it.
const SCORE_LABELS = {
  1: 'Needs improvement',
  2: 'Developing',
  3: 'Meets expectations',
  4: 'Exceeds expectations',
  5: 'Outstanding',
};

/**
 * Star picker used for both the per-competency and the overall score. Clicking
 * the current value clears it back to unrated — the server stores "no score"
 * rather than a fake 0, so a half-finished review stays honest.
 */
function StarRating({ value = 0, onChange, size = 'md', label }) {
  // `hover` is a TRANSIENT preview only. The chosen value is the source of
  // truth for what's drawn, and the preview is dropped the moment the value
  // changes — otherwise clicking a star to clear it leaves the pointer sitting
  // on that star, previewing the rating you just removed (it looked like the
  // click did nothing until you moved the mouse away, and on touch, where no
  // mouseleave ever fires, it never recovered at all).
  const [hover, setHover] = useState(0);
  const chosen = Number(value) || 0;

  // Commit and preview move together in one batched render, so the frame drawn
  // straight after a click already shows the new value. (Clearing the preview
  // from an effect instead would paint one stale frame first — the flicker.)
  const pick = (s) => {
    const next = s === chosen ? 0 : s;
    setHover(next);
    onChange(next);
  };
  // Safety net for a value changed from outside (re-opening the form): drop a
  // stale preview BEFORE paint, never after.
  useLayoutEffect(() => { setHover((h) => (h === chosen ? h : 0)); }, [chosen]);

  const shown = hover || chosen;
  const px = size === 'lg' ? 24 : 20;
  return (
    <div className="flex items-center gap-2.5">
      <div
        // No gap: the buttons' hit areas touch, so sweeping across the row never
        // crosses a dead zone. The visual spacing comes from padding inside each
        // button instead.
        className="flex items-center select-none"
        // Pointer events cover mouse, pen and touch; mouseleave alone never
        // fires for a tap.
        onPointerLeave={() => setHover(0)}
        role="group"
        aria-label={label || 'Rating'}
      >
        {SCORES.map((s) => {
          const on = s <= shown;
          return (
            <button
              key={s}
              type="button"
              // Preview on hover only. Focus deliberately does NOT preview:
              // tabbing through must not look like it is changing the score.
              onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(s); }}
              onClick={() => pick(s)}
              aria-label={`${s} of 5 — ${SCORE_LABELS[s]}`}
              aria-pressed={chosen === s}
              title={SCORE_LABELS[s]}
              className={`star-btn px-1 py-0.5 rounded ${on ? 'is-on' : ''}`}
            >
              <FiStar size={px} className={on ? 'fill-current' : ''} aria-hidden="true" />
            </button>
          );
        })}
      </div>
      {/* Fixed width on purpose. This label changes as you hover, and it sits in
          the same flex row as the stars — letting it resize would shift the
          stars out from under the cursor, flipping the hover to another star and
          then back, forever. Reserving the widest label's space pins the row. */}
      <span className={`text-xs whitespace-nowrap w-36 shrink-0 ${chosen ? 'text-gray-600 font-medium' : 'text-gray-400'}`}>
        {shown ? SCORE_LABELS[shown] : 'Not rated'}
      </span>
    </div>
  );
}

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

  // Seed the fill-in modal: use the cycle's competency list (falling back to any
  // already-saved ratings) and pre-populate scores/comments from prior input.
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
  const initials = (name) => name.split(' ').filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || 'E';

  // Live progress for the fill-in modal header. Unrated competencies are left
  // out of the average rather than counted as zero.
  const scored = (form?.ratings || []).map((r) => Number(r.score)).filter((n) => n >= 1 && n <= 5);
  const ratedCount = scored.length;
  const avgScore = ratedCount ? (scored.reduce((a, b) => a + b, 0) / ratedCount).toFixed(1) : null;
  const progressPct = form?.ratings?.length ? Math.round((ratedCount / form.ratings.length) * 100) : 0;

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
        <p className="text-xs text-gray-500 mb-3">Submitted feedback is shown anonymously · reviewer identities are hidden.</p>
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
                        <span className="text-gray-900 font-medium">{rt.score ? `${rt.score}/5` : '-'}</span>
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
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden">
            {/* Header — who, which cycle, and how far along the reviewer is. */}
            <div className="review-head px-6 pt-5 pb-4">
              <div className="flex items-start gap-3">
                <span className="avatar-circle accent-bg text-white shrink-0">{initials(empName(active))}</span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-semibold text-gray-900 truncate">{empName(active)}</h2>
                  <div className="flex items-center gap-2 mt-1 flex-wrap">
                    <RelBadge relationship={active.relationship} />
                    <span className="text-xs text-gray-500 truncate">{active.cycle?.name}</span>
                  </div>
                </div>
                <button type="button" onClick={() => { setActive(null); setForm(null); }}
                  className="text-gray-400 hover:text-gray-700 shrink-0 p-1 rounded-lg" aria-label="Close">
                  <FiX size={18} />
                </button>
              </div>

              <div className="mt-4">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-gray-500">{ratedCount} of {form.ratings.length} competencies rated</span>
                  {avgScore ? <span className="font-semibold text-gray-700">Average {avgScore}</span> : null}
                </div>
                <div className="review-progress"><span style={{ width: `${progressPct}%` }} /></div>
              </div>
            </div>

            <form onSubmit={submit}>
              <div className="px-6 py-5 space-y-3">
                {form.ratings.map((rt, idx) => (
                  <div key={rt.competency || idx} className={`rating-card p-4 ${Number(rt.score) ? 'is-rated' : ''}`}>
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      {/* The tick occupies a reserved slot rather than appearing
                          and disappearing, so rating a row never re-flows it. */}
                      <span className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                        <FiCheck size={14} aria-hidden="true"
                          className={`accent-text shrink-0 ${Number(rt.score) ? '' : 'invisible'}`} />
                        {rt.competency}
                      </span>
                      <StarRating
                        value={rt.score}
                        label={rt.competency}
                        onChange={(s) => setRating(idx, 'score', s)}
                      />
                    </div>
                    <input
                      placeholder="Add a comment (optional)"
                      value={rt.comment}
                      onChange={(e) => setRating(idx, 'comment', e.target.value)}
                      className="block w-full bg-transparent border-0 border-b border-gray-200 focus:border-gray-400 px-0 py-2 mt-2 text-sm focus:outline-none focus:ring-0"
                    />
                  </div>
                ))}

                {/* Overall — deliberately heavier than a competency row. */}
                <div className="rating-card rating-card-overall p-4">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div>
                      <div className="text-sm font-semibold text-gray-900">Overall rating</div>
                      <p className="text-xs text-gray-500 mt-0.5">Your single summary judgement for this cycle.</p>
                    </div>
                    <StarRating
                      size="lg"
                      value={form.overallRating}
                      label="Overall rating"
                      onChange={(s) => setForm({ ...form, overallRating: s })}
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 pt-1">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Strengths</label>
                    <textarea
                      rows={3}
                      placeholder="What are they doing well?"
                      value={form.strengths}
                      onChange={(e) => setForm({ ...form, strengths: e.target.value })}
                      className="block w-full border rounded-xl px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Areas to improve</label>
                    <textarea
                      rows={3}
                      placeholder="Where could they grow?"
                      value={form.improvements}
                      onChange={(e) => setForm({ ...form, improvements: e.target.value })}
                      className="block w-full border rounded-xl px-3 py-2 text-sm"
                    />
                  </div>
                </div>

                {modalError && (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{modalError}</div>
                )}
              </div>

              {/* Footer stays in view while the body scrolls. */}
              <div className="sticky bottom-0 flex items-center justify-between gap-3 px-6 py-4 bg-gray-50 border-t border-gray-200">
                <span className="text-xs text-gray-500 hidden sm:block">
                  {ratedCount === form.ratings.length && form.overallRating
                    ? 'All set — this feedback is final once submitted.'
                    : 'You can leave scores blank; submitting is final.'}
                </span>
                <span className="flex items-center gap-2 ml-auto">
                  <button type="button" onClick={() => { setActive(null); setForm(null); }} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={saving} className="px-5 py-2 text-sm font-semibold bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Submitting…' : 'Submit review'}</button>
                </span>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
