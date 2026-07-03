import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  InClearance: 'bg-blue-100 text-blue-800',
  Completed: 'bg-green-100 text-green-800',
  Cancelled: 'bg-gray-200 text-gray-700',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '-');

export default function EmployeeExit() {
  const [exit, setExit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    lastWorkingDay: '',
    noticePeriodDays: 30,
    reason: '',
  });
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/exits/me');
      setExit(data.exit);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onSubmit = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.post('/exits/me', form);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  const hasOpen = exit && (exit.status === 'Pending' || exit.status === 'InClearance');

  return (
    <div>
      <PageHeader title="Resignation & Exit" />

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {loading ? (
        <div className="space-y-2 py-1"><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-4 rounded w-2/3" /></div>
      ) : exit ? (
        <div className="bg-white shadow rounded-lg p-6 space-y-4">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="card-title">Your exit request</h2>
              <p className="text-xs text-gray-500">Submitted {fmtDate(exit.resignationDate)}</p>
            </div>
            <span className={`inline-block px-2 py-1 text-xs rounded-lg ${STATUS_COLORS[exit.status]}`}>
              {exit.status}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-xs text-gray-500">Type</dt>
              <dd>{exit.type}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Last Working Day</dt>
              <dd>{fmtDate(exit.lastWorkingDay)}</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">Notice Period</dt>
              <dd>{exit.noticePeriodDays ?? '-'} days</dd>
            </div>
            <div>
              <dt className="text-xs text-gray-500">HR Contact</dt>
              <dd>
                {exit.handledBy
                  ? <>{exit.handledBy.firstName} {exit.handledBy.lastName}<div className="text-xs text-gray-500">{exit.handledBy.email}</div></>
                  : <span className="text-gray-400 italic">Not yet assigned</span>}
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-gray-500">Reason</dt>
              <dd>{exit.reason || '-'}</dd>
            </div>
          </dl>

          {exit.status === 'Completed' && (
            <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm">
              <strong>Your exit has been processed.</strong>
              {exit.exitEmailSentAt && (
                <p className="text-xs mt-1">A feedback email was sent to you on {fmtDate(exit.exitEmailSentAt)}. Please check your inbox.</p>
              )}
            </div>
          )}

          {exit.status === 'Cancelled' && (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-sm">
              This request was cancelled.
              {exit.cancellationReason && <p className="text-xs mt-1">{exit.cancellationReason}</p>}
            </div>
          )}

          {hasOpen && (
            <p className="text-xs text-gray-500">
              Need to make changes? Contact your HR partner.
            </p>
          )}
        </div>
      ) : (
        <div className="bg-white shadow rounded-lg p-6">
          <h2 className="card-title mb-3">Submit your resignation</h2>
          <p className="text-sm text-gray-500 mb-4">
            HR will review your submission, confirm a last working day, and walk you through clearance.
          </p>
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-700">Last Working Day *</label>
                <input type="date" required value={form.lastWorkingDay}
                  onChange={(e) => setForm({ ...form, lastWorkingDay: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Notice period (days)</label>
                <input type="number" min={0} value={form.noticePeriodDays}
                  onChange={(e) => setForm({ ...form, noticePeriodDays: Number(e.target.value) || 0 })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-700">Reason</label>
              <textarea rows={4} value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                placeholder="Share your reason for leaving. This stays confidential with HR."
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>
            <div className="flex justify-end">
              <button type="submit" disabled={submitting}
                className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60 text-sm">
                {submitting ? 'Submitting…' : 'Submit resignation'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
