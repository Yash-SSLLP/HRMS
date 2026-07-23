/**
 * AdminTravel — travel request review (admin portal). Lists/filters requests from
 * GET /travel, approves/rejects/completes via PATCH /travel/:id/status, and
 * separately reviews any reimbursement claim via PATCH /travel/:id/reimbursement
 * (viewing the uploaded receipt from GET /travel/:id/receipt).
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import { fetchImageObjectUrl } from '../api/download';
import PageHeader from '../components/PageHeader';
import { promptDialog } from '../components/dialogs';

const STATUSES = ['Pending', 'Approved', 'Rejected', 'Completed'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Completed: 'bg-blue-100 text-blue-800',
  Rejected: 'bg-red-100 text-red-800',
};

const REIMB_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Reimbursed: 'bg-blue-100 text-blue-800',
};

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

export default function AdminTravel() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [busyId, setBusyId] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/travel${statusFilter ? `?status=${statusFilter}` : ''}`);
      setItems(data.items);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]);

  const review = async (t, status) => {
    let reviewNote;
    if (status === 'Rejected') {
      reviewNote = (await promptDialog({ message: 'Reason for rejection (optional):' })) || '';
    }
    setBusyId(t._id);
    setError('');
    try {
      await api.patch(`/travel/${t._id}/status`, { status, reviewNote });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    } finally {
      setBusyId('');
    }
  };

  const reviewReimb = async (t, status) => {
    let note;
    if (status === 'Rejected') note = (await promptDialog({ message: 'Reason for rejecting the reimbursement (optional):' })) || '';
    setBusyId(t._id);
    setError('');
    try {
      await api.patch(`/travel/${t._id}/reimbursement`, { status, note });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    } finally {
      setBusyId('');
    }
  };

  const openReceipt = async (id) => {
    try {
      const url = await fetchImageObjectUrl(`/travel/${id}/receipt`);
      window.open(url, '_blank', 'noopener');
    } catch {
      setError('Could not open the receipt');
    }
  };

  return (
    <div>
      <PageHeader title="Travel Requests" subtitle="Review and approve employee travel.">
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
              <th className="px-4 py-3 text-left font-medium text-gray-700">Purpose</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Route</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Dates</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Mode</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Est. cost</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Advance</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reimbursement</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={10} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={10} className="px-4 py-6 text-center text-gray-500">No travel requests</td></tr>
            ) : items.map((t) => (
              <tr key={t._id}>
                <td className="px-4 py-3">
                  {t.employee ? `${t.employee.firstName} ${t.employee.lastName}` : '-'}
                  <div className="text-xs text-gray-500">{t.employee?.email}</div>
                </td>
                <td className="px-4 py-3">{t.purpose}</td>
                <td className="px-4 py-3">{t.origin} → {t.destination}</td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(t.fromDate).toLocaleDateString()} – {new Date(t.toDate).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">{t.modeOfTravel}</td>
                <td className="px-4 py-3 text-right">{inr.format(t.estimatedCost || 0)}</td>
                <td className="px-4 py-3 text-right">{inr.format(t.advanceRequested || 0)}</td>
                <td className="px-4 py-3">
                  {t.reimbursementRequested ? (
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{inr.format(t.reimbursementAmount || 0)}</span>
                        <span className="text-xs text-gray-400">paid by employee</span>
                        <span className={`text-xs px-2 py-0.5 rounded-lg ${REIMB_STYLES[t.reimbursementStatus] || 'bg-gray-100 text-gray-700'}`}>
                          {t.reimbursementStatus}
                        </span>
                      </div>
                      {t.reimbursementPaidOn && <div className="text-xs text-gray-400 mt-0.5">Paid on {new Date(t.reimbursementPaidOn).toLocaleDateString()}</div>}
                      {t.reimbursementNote && <div className="text-xs text-gray-500 mt-0.5">{t.reimbursementNote}</div>}
                      {t.reimbursementReceiptName && (
                        <button onClick={() => openReceipt(t._id)} className="text-xs text-blue-600 hover:underline mt-0.5">View receipt</button>
                      )}
                      {t.reimbursementDecisionNote && <div className="text-xs text-gray-400 mt-0.5">Decision: {t.reimbursementDecisionNote}</div>}
                      {t.reimbursementStatus !== 'Reimbursed' && t.reimbursementStatus !== 'Rejected' && (
                        <div className="flex gap-2 mt-1 text-xs">
                          {t.reimbursementStatus === 'Pending' && (
                            <>
                              <button disabled={busyId === t._id} onClick={() => reviewReimb(t, 'Approved')}
                                className="text-green-600 hover:underline disabled:opacity-50">Approve</button>
                              <button disabled={busyId === t._id} onClick={() => reviewReimb(t, 'Rejected')}
                                className="text-red-600 hover:underline disabled:opacity-50">Reject</button>
                            </>
                          )}
                          {t.reimbursementStatus === 'Approved' && (
                            <button disabled={busyId === t._id} onClick={() => reviewReimb(t, 'Reimbursed')}
                              className="text-blue-600 hover:underline disabled:opacity-50">Mark Reimbursed</button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : <span className="text-gray-400">-</span>}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-lg ${STATUS_STYLES[t.status]}`}>
                    {t.status}
                  </span>
                  {t.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {t.reviewNote}</div>
                  )}
                </td>
                <td className="px-4 py-3 text-right whitespace-nowrap">
                  <div className="flex justify-end gap-3">
                    <button disabled={busyId === t._id} onClick={() => review(t, 'Approved')}
                      className="text-green-600 hover:underline disabled:opacity-50">Approve</button>
                    <button disabled={busyId === t._id} onClick={() => review(t, 'Rejected')}
                      className="text-red-600 hover:underline disabled:opacity-50">Reject</button>
                    <button disabled={busyId === t._id} onClick={() => review(t, 'Completed')}
                      className="text-blue-600 hover:underline disabled:opacity-50">Mark Completed</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
