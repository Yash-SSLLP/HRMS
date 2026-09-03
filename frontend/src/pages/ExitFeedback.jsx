/**
 * ExitFeedback — public (no-login) exit survey, route /exit-feedback/:token, that
 * a departing employee fills from a tokenised HR link. Loads context via
 * GET /exits/feedback/:token and submits responses via POST to the same URL;
 * re-visits after submission show a thank-you state.
 */
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';

const REASONS = [
  { value: 'CareerGrowth', label: 'Better career growth opportunity' },
  { value: 'Compensation', label: 'Compensation / benefits' },
  { value: 'WorkLifeBalance', label: 'Work-life balance' },
  { value: 'Management', label: 'Management / culture' },
  { value: 'RoleMismatch', label: 'Role / responsibilities mismatch' },
  { value: 'Relocation', label: 'Relocation' },
  { value: 'Personal', label: 'Personal reasons' },
  { value: 'Other', label: 'Other' },
];

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

export default function ExitFeedback() {
  const { token } = useParams();
  const [ctx, setCtx] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submittedNow, setSubmittedNow] = useState(false);

  const [form, setForm] = useState({
    primaryReason: '',
    likedMost: '',
    couldImprove: '',
    recommendScore: '',
    openFeedback: '',
  });

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/exits/feedback/${token}`);
        setCtx(data);
      } catch (err) {
        setError(err.response?.data?.message || 'Could not load this feedback form');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!form.primaryReason) {
      setError('Please pick a primary reason for leaving.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await api.post(`/exits/feedback/${token}`, {
        ...form,
        recommendScore: form.recommendScore ? Number(form.recommendScore) : undefined,
      });
      setSubmittedNow(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-10">
      <div className="max-w-2xl mx-auto">
        <header className="text-center mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">
            {ctx?.orgName || 'Sequence Surface'} · Exit Feedback
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Your honest input helps us improve. This takes about 2 minutes.
          </p>
        </header>

        {/* The relieving letter lives here too: by the time this page is opened
            the company login is switched off, so this tokenised page is the only
            way the letter reaches the person it is about. Shown whatever the
            feedback state — it must not depend on filling the survey in. */}
        {ctx && !loading && <RelievingLetterCard token={token} />}

        {loading ? (
          <p className="text-center text-gray-500">Loading…</p>
        ) : error && !ctx ? (
          <div className="bg-white shadow-lg rounded-2xl p-6 text-center">
            <p className="text-red-700">{error}</p>
            <p className="text-sm text-gray-500 mt-2">
              If you think this is a mistake, reply to the email you received from HR.
            </p>
          </div>
        ) : (ctx?.alreadySubmitted && !submittedNow) ? (
          <div className="bg-white shadow-lg rounded-2xl p-6 text-center">
            <h2 className="text-lg font-semibold text-green-800 mb-2">Thank you</h2>
            <p className="text-sm text-gray-700">
              You already submitted feedback for this exit on {fmtDate(ctx.submittedAt)}. We appreciate it.
            </p>
          </div>
        ) : submittedNow ? (
          <div className="bg-white shadow-lg rounded-2xl p-6 text-center">
            <h2 className="text-lg font-semibold text-green-800 mb-2">Thank you, {ctx?.employeeName?.split(' ')[0] || ''}.</h2>
            <p className="text-sm text-gray-700">
              Your feedback has been recorded and shared with HR. We wish you the very best in your next chapter.
            </p>
          </div>
        ) : (
          <div className="bg-white shadow-lg rounded-2xl p-6">
            <p className="text-sm text-gray-700 mb-4">
              Hi {ctx?.employeeName?.split(' ')[0] || ''}, your last working day with us was <strong>{fmtDate(ctx?.lastWorkingDay)}</strong>.
              {ctx?.handledBy && <> Your HR contact was <strong>{ctx.handledBy}</strong>.</>}
            </p>

            {error && (
              <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
            )}

            <form onSubmit={onSubmit} className="space-y-5">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Primary reason for leaving *
                </label>
                <div className="space-y-1">
                  {REASONS.map((r) => (
                    <label key={r.value} className="flex items-center gap-2 text-sm">
                      <input type="radio" name="primaryReason" value={r.value}
                        checked={form.primaryReason === r.value}
                        onChange={(e) => setForm({ ...form, primaryReason: e.target.value })} />
                      {r.label}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  What did you like most about working here?
                </label>
                <textarea rows={3} value={form.likedMost}
                  onChange={(e) => setForm({ ...form, likedMost: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  What could we improve?
                </label>
                <textarea rows={3} value={form.couldImprove}
                  onChange={(e) => setForm({ ...form, couldImprove: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Would you recommend us as a workplace?
                </label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <label key={n} className={`flex-1 text-center border rounded-lg px-3 py-2 cursor-pointer text-sm ${
                      // The ring, not just the fill: on a public page in dark mode the
                      // accent fill and the card were within 1.00:1 of each other, so the
                      // chip you had picked looked exactly like the four you had not.
                      // ring-gray-900 is remapped to a light ink in dark (index.css).
                      String(form.recommendScore) === String(n)
                        ? 'bg-gray-900 text-white ring-2 ring-gray-900 font-semibold'
                        : 'hover:bg-gray-50'
                    }`}>
                      <input type="radio" name="recommendScore" value={n} className="hidden"
                        checked={String(form.recommendScore) === String(n)}
                        onChange={(e) => setForm({ ...form, recommendScore: e.target.value })} />
                      {n}
                    </label>
                  ))}
                </div>
                <div className="flex justify-between text-xs text-gray-500 mt-1">
                  <span>Definitely not</span>
                  <span>Definitely yes</span>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  Anything else you'd like to share?
                </label>
                <textarea rows={4} value={form.openFeedback}
                  onChange={(e) => setForm({ ...form, openFeedback: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>

              <div className="flex justify-end">
                <button type="submit" disabled={submitting}
                  className="px-6 py-2.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60 text-sm">
                  {submitting ? 'Submitting…' : 'Submit feedback'}
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The relieving letter, offered on the same tokenised page as the feedback form.
 *
 * Fetched as a blob rather than linked with a bare <a href> so a refusal (the
 * server withholds the letter until clearance is done and the last working day
 * has passed) can be shown as a sentence instead of dumping raw JSON into a tab.
 */
function RelievingLetterCard({ token }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const open = async () => {
    setBusy(true); setErr('');
    try {
      const res = await api.get(`/exits/feedback/${token}/relieving-letter.pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) {
      let msg = 'Your relieving letter is not available yet.';
      try {
        const text = e.response?.data instanceof Blob ? await e.response.data.text() : null;
        if (text) msg = JSON.parse(text).message || msg;
      } catch { /* keep the fallback */ }
      setErr(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white shadow-lg rounded-2xl p-5 mb-5">
      <h2 className="text-sm font-semibold text-gray-900">Your relieving letter</h2>
      <p className="text-sm text-gray-600 mt-1">
        Keep a copy for your records — a future employer will usually ask for it.
      </p>
      {err && <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 px-3 py-2 rounded-lg mt-3">{err}</p>}
      <button onClick={open} disabled={busy}
        className="mt-3 px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-60">
        {busy ? 'Opening…' : 'Download relieving letter'}
      </button>
    </div>
  );
}
