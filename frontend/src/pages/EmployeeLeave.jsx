import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const LEAVE_TYPES = ['EL', 'CL', 'SL', 'ML', 'PL', 'COMP', 'LOP'];

const STATUS_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Cancelled: 'bg-gray-200 text-gray-700',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '');

const blankForm = {
  leaveType: 'CL',
  startDate: '',
  endDate: '',
  isHalfDay: false,
  halfDaySession: 'FirstHalf',
  reason: '',
};

export default function EmployeeLeave() {
  const [balance, setBalance] = useState(null);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(blankForm);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [balRes, reqRes] = await Promise.all([
        api.get('/leave/me/balance'),
        api.get('/leave/me/requests'),
      ]);
      setBalance(balRes.data.balance);
      setRequests(reqRes.data.requests);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onApply = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await api.post('/leave/me/requests', form);
      setForm(blankForm);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to apply');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async (id) => {
    if (!window.confirm('Cancel this leave request?')) return;
    try {
      await api.patch(`/leave/me/requests/${id}/cancel`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Cancel failed');
    }
  };

  const bal = balance?.balances || {};

  return (
    <div>
      <PageHeader title="Leave" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        {[
          { key: 'EL', label: 'Earned' },
          { key: 'CL', label: 'Casual' },
          { key: 'SL', label: 'Sick' },
          { key: 'ML', label: 'Maternity' },
        ].map((t) => (
          <div key={t.key} className="bg-white shadow rounded-lg p-4">
            <div className="text-xs text-gray-500">{t.label} ({t.key})</div>
            <div className="text-2xl font-semibold">{bal[t.key]?.balance ?? 0}</div>
            <div className="text-xs text-gray-500">
              used {bal[t.key]?.used ?? 0} of {(bal[t.key]?.opening ?? 0) + (bal[t.key]?.granted ?? 0) || (bal[t.key]?.granted ?? 0)}
            </div>
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-white shadow rounded-lg p-5 lg:col-span-1">
          <h2 className="card-title mb-3">Apply for Leave</h2>
          <form onSubmit={onApply} className="space-y-3">
            <div>
              <label className="block text-sm text-gray-700">Type</label>
              <select value={form.leaveType}
                onChange={(e) => setForm({ ...form, leaveType: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2">
                {LEAVE_TYPES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>

            <label className="inline-flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={form.isHalfDay}
                onChange={(e) => setForm({ ...form, isHalfDay: e.target.checked })} />
              Half day
            </label>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm text-gray-700">From</label>
                <input type="date" required value={form.startDate}
                  onChange={(e) => setForm({ ...form, startDate: e.target.value, endDate: form.isHalfDay ? e.target.value : form.endDate })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">To</label>
                <input type="date" required value={form.endDate}
                  disabled={form.isHalfDay}
                  onChange={(e) => setForm({ ...form, endDate: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100" />
              </div>
            </div>

            {form.isHalfDay && (
              <div>
                <label className="block text-sm text-gray-700">Session</label>
                <select value={form.halfDaySession}
                  onChange={(e) => setForm({ ...form, halfDaySession: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  <option value="FirstHalf">First Half</option>
                  <option value="SecondHalf">Second Half</option>
                </select>
              </div>
            )}

            <div>
              <label className="block text-sm text-gray-700">Reason</label>
              <textarea rows={3} value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="mt-1 block w-full border rounded-lg px-3 py-2" />
            </div>

            <button type="submit" disabled={submitting}
              className="w-full bg-gray-900 text-white py-2 rounded-lg hover:bg-gray-700 disabled:opacity-60">
              {submitting ? 'Submitting…' : 'Apply'}
            </button>
          </form>
        </div>

        <div className="lg:col-span-2">
          <h2 className="card-title mb-3">My Requests</h2>
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">From</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">To</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Days</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
                  <th className="px-4 py-3 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
                ) : requests.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No requests yet</td></tr>
                ) : requests.map((r) => (
                  <tr key={r._id}>
                    <td className="px-4 py-3">
                      <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{r.leaveType}</span>
                      {r.isHalfDay && <span className="ml-1 text-xs text-gray-500">(half)</span>}
                    </td>
                    <td className="px-4 py-3">{fmtDate(r.startDate)}</td>
                    <td className="px-4 py-3">{fmtDate(r.endDate)}</td>
                    <td className="px-4 py-3 text-right">{r.totalDays}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                      {r.approver && (r.status === 'Approved' || r.status === 'Rejected') && (
                        <div className="text-[11px] text-gray-500 mt-1">
                          by {r.approver.firstName} {r.approver.lastName}
                        </div>
                      )}
                      {r.decisionNote && <div className="text-[11px] text-gray-400 mt-0.5 italic">“{r.decisionNote}”</div>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(r.status === 'Pending' || r.status === 'Approved') && (
                        <button onClick={() => cancel(r._id)} className="text-red-600 hover:underline">Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
