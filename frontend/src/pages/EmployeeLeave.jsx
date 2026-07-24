/**
 * EmployeeLeave — leave balance + apply/track screen (employee portal). Loads
 * balances and requests from GET /leave/me/balance and /leave/me/requests,
 * applies for leave via POST /leave/me/requests, and cancels not-yet-started
 * requests via PATCH /leave/me/requests/:id/cancel. Requests climb an approval chain.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { ChainProgress } from '../components/LeaveApprovalsInbox';
import { confirmDialog } from '../components/dialogs';

const LEAVE_TYPES = ['EL', 'CL', 'SL', 'ML', 'PL', 'COMP', 'LOP'];

const STATUS_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Cancelled: 'bg-gray-200 text-gray-700',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '');

// A leave can be cancelled only while it hasn't started yet. Once its start date
// is in the past, the day has been taken and the option is removed. Date-only
// compare so a leave starting today is still cancellable.
const hasStarted = (startDate) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  return new Date(startDate) < startOfToday;
};

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
  // Live paid-vs-LOP preview for the dates/type currently in the apply form.
  const [preview, setPreview] = useState(null);

  // Load leave balances and my requests together on mount / after any change.
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

  // Debounced preview of how many of the requested days will be paid vs LOP under
  // the 2-paid-days/month quota, so the employee sees the impact before applying.
  useEffect(() => {
    const { leaveType, startDate, endDate, isHalfDay } = form;
    if (!startDate || !endDate) { setPreview(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/leave/me/leave-preview', {
          params: { leaveType, startDate, endDate, isHalfDay },
        });
        if (!cancelled) setPreview(data);
      } catch {
        if (!cancelled) setPreview(null);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [form.leaveType, form.startDate, form.endDate, form.isHalfDay]);

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
    if (!(await confirmDialog({ message: 'Cancel this leave request?' }))) return;
    try {
      await api.patch(`/leave/me/requests/${id}/cancel`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Cancel failed');
    }
  };

  const bal = balance?.balances || {};
  const monthly = balance?.monthly || { quota: 2, used: 0, remaining: 2, month: null, year: null };
  const monthLabel = monthly.month
    ? new Date(monthly.year, monthly.month - 1, 1).toLocaleDateString('en-IN', { month: 'long' })
    : 'this month';
  const mlBal = bal.ML?.balance ?? 0;
  const mlTotal = (bal.ML?.granted ?? 0) || 0;

  return (
    <div>
      <PageHeader title="Leave" />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-xs text-gray-500">Paid leave left ({monthLabel})</div>
          <div className="text-2xl font-semibold text-emerald-700">{monthly.remaining}</div>
          <div className="text-xs text-gray-500">of {monthly.quota} / month</div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-xs text-gray-500">Paid leave used</div>
          <div className="text-2xl font-semibold text-gray-800">{monthly.used}</div>
          <div className="text-xs text-gray-500">this month · resets monthly</div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-xs text-gray-500">Beyond quota</div>
          <div className="text-2xl font-semibold text-red-600">LOP</div>
          <div className="text-xs text-gray-500">extra days = loss of pay</div>
        </div>
        <div className="bg-white shadow rounded-lg p-4">
          <div className="text-xs text-gray-500">Maternity (ML)</div>
          <div className="text-2xl font-semibold text-purple-700">{mlBal}</div>
          <div className="text-xs text-gray-500">of {mlTotal} · separate</div>
        </div>
      </div>

      <div className="mb-6 rounded-lg bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
        ℹ️ Company policy: <strong>2 paid leave days per calendar month</strong>. Any
        leave beyond 2 in a month is <strong>Loss of Pay (LOP)</strong>. The quota
        resets each month and is not carried forward. Maternity leave is a separate
        entitlement and is not counted against this quota.
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

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

            {preview && (preview.paidDays > 0 || preview.lopDays > 0) && (
              <div className={`rounded-lg border px-3 py-2 text-xs ${preview.lopDays > 0 ? 'bg-red-50 border-red-200 text-red-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
                <div className="font-medium">
                  {preview.paidDays} paid day{preview.paidDays === 1 ? '' : 's'}
                  {preview.lopDays > 0 && <> · <span className="font-semibold">{preview.lopDays} LOP (unpaid)</span></>}
                </div>
                {preview.lopDays > 0 && (
                  <div className="mt-0.5">
                    You have used up the {preview.quota}-day monthly paid quota for the
                    covered month(s), so {preview.lopDays} day{preview.lopDays === 1 ? '' : 's'} will be Loss of Pay.
                  </div>
                )}
              </div>
            )}

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
                  <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
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
                    <td className="px-4 py-3 text-right">
                      {r.totalDays}
                      {r.lopDays > 0 && (
                        <span className="block text-[11px] text-red-600">{r.lopDays} LOP</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_COLORS[r.status]}`}>{r.status}</span>
                      {r.approvalChain?.length > 0 && (
                        <div className="mt-1"><ChainProgress chain={r.approvalChain} /></div>
                      )}
                      {r.approver && (r.status === 'Approved' || r.status === 'Rejected') && (
                        <div className="text-[11px] text-gray-500 mt-1">
                          by {r.approver.firstName} {r.approver.lastName}
                        </div>
                      )}
                      {r.decisionNote && <div className="text-[11px] text-gray-400 mt-0.5 italic">“{r.decisionNote}”</div>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {(r.status === 'Pending' || r.status === 'Approved') && !hasStarted(r.startDate) && (
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
