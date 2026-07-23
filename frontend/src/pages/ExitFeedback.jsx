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

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '');

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
                      String(form.recommendScore) === String(n) ? 'bg-gray-900 text-white' : 'hover:bg-gray-50'
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
