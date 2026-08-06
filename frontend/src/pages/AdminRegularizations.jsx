/**
 * AdminRegularizations — attendance-regularization review (admin portal). Lists
 * requests from GET /regularizations and approves/rejects via
 * PATCH /regularizations/:id/status (an approval applies the corrected punch).
 * CEO/MD see the oversight columns (who changed what); their only action here is
 * deciding an HR's OWN request, which HR may not decide for themselves.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useAuthStore } from '../store/authStore';
import { promptDialog } from '../components/dialogs';
import { formatTime12 as fmt12 } from '../utils/time';
import { isReadOnlyExec } from '../config/permissions';

const STATUSES = ['Pending', 'Approved', 'Rejected'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

export default function AdminRegularizations() {
  const me = useAuthStore((s) => s.user);
  const myId = me?._id || me?.id;
  // A view-only CEO/MD is read-only everywhere except one row type: an HR's own
  // regularization, which HR must not decide for themselves. So the actions
  // column is no longer hidden from them — it is decided per row below. An exec
  // a SuperAdmin has put in edit mode decides any row, like HR.
  const isExec = isReadOnlyExec(me);
  const readOnly = isExec;

  // Who may decide this request, mirroring regularizationController.js. Returns
  // null when the viewer may act, otherwise the reason they may not.
  const blockedReason = (r) => {
    const requesterId = r.employee?._id || r.employee;
    const requesterIsHr = r.employee?.role === 'HRManager';
    if (myId && String(requesterId) === String(myId)) return 'Your own request';
    if (requesterIsHr && !['SuperAdmin', 'CEO', 'MD'].includes(me?.role)) return 'Needs CEO / MD / Super Admin';
    if (isExec && !requesterIsHr) return 'HR to decide';
    return null;
  };
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/regularizations${statusFilter ? `?status=${statusFilter}` : ''}`);
      setItems(data.items);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const review = async (r, status) => {
    setError('');
    let reviewNote = '';
    if (status === 'Rejected') {
      reviewNote = (await promptDialog({ message: 'Reason for rejection (optional):' })) || '';
    }
    try {
      await api.patch(`/regularizations/${r._id}/status`, { status, reviewNote });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div>
      <PageHeader
        title="Attendance Regularization"
        subtitle={readOnly
          ? 'Oversight: who changed which employee’s attendance, on which day, and from what to what. You approve HR’s own requests.'
          : undefined}
      >
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Change (from → to)</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">By</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">No regularization requests</td></tr>
            ) : items.map((r) => {
              const toIn = fmt12(r.appliedCheckIn) || fmt12(r.requestedCheckIn) || '-';
              const toOut = fmt12(r.appliedCheckOut) || fmt12(r.requestedCheckOut) || '-';
              const fromIn = fmt12(r.previousCheckIn) || '-';
              const fromOut = fmt12(r.previousCheckOut) || '-';
              const blocked = blockedReason(r);
              return (
              <tr key={r._id}>
                <td className="px-4 py-3">
                  {r.employee ? `${r.employee.firstName} ${r.employee.lastName}` : '-'}
                  {r.employee?.role === 'HRManager' && (
                    <span className="ml-1.5 align-middle text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-indigo-100 text-indigo-700"
                      title="HR's own request — only the CEO, MD or a Super Admin can decide it">
                      HR
                    </span>
                  )}
                  <div className="text-xs text-gray-500">{r.employee?.email}</div>
                </td>
                <td className="px-4 py-3 text-gray-700">{new Date(r.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                <td className="px-4 py-3">{r.type}</td>
                <td className="px-4 py-3 whitespace-nowrap">
                  <div className="text-xs text-gray-700">
                    <span className="text-gray-400">In</span> {fromIn} <span className="text-gray-400">→</span> <span className="font-medium">{toIn}</span>
                  </div>
                  <div className="text-xs text-gray-700 mt-0.5">
                    <span className="text-gray-400">Out</span> {fromOut} <span className="text-gray-400">→</span> <span className="font-medium">{toOut}</span>
                  </div>
                  {r.previousStatus && (
                    <div className="text-[11px] text-gray-400 mt-0.5">was: {r.previousStatus}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  {r.reason}
                  {r.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {r.reviewNote}</div>
                  )}
                </td>
                <td className="px-4 py-3 whitespace-nowrap">
                  {r.reviewedBy ? (
                    <>
                      <div className="text-gray-800">{r.reviewedBy.firstName} {r.reviewedBy.lastName}</div>
                      <div className="text-xs text-gray-500">
                        {r.reviewedBy.role}{r.reviewedAt ? ` · ${new Date(r.reviewedAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}` : ''}
                      </div>
                    </>
                  ) : <span className="text-gray-400">-</span>}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[r.status]}`}>
                    {r.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  {r.status !== 'Pending' ? (
                    <span className="text-xs text-gray-400">Reviewed</span>
                  ) : blocked ? (
                    <span className="text-xs text-gray-500" title="An HR's own attendance correction is decided by the CEO, MD or a Super Admin">
                      {blocked}
                    </span>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <button onClick={() => review(r, 'Approved')}
                        className="px-3 py-1 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700">
                        Approve
                      </button>
                      <button onClick={() => review(r, 'Rejected')}
                        className="px-3 py-1 text-xs border border-red-300 text-red-700 rounded-lg hover:bg-red-50">
                        Reject
                      </button>
                    </div>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
