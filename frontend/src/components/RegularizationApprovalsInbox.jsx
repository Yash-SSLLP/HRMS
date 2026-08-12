/**
 * RegularizationApprovalsInbox — attendance-correction requests waiting on the
 * signed-in user.
 *
 * Unlike leave, this ladder is not derived from the org chart: a SuperAdmin
 * names 1 or 2 approvers per employee (Employees → Regularization approval), so
 * whoever appears here was picked explicitly. That also means an approver needs
 * no special permission — the queue is served by the protect-only
 * /approvals/regularizations routes and scoped server-side to
 * `currentApprover === me`, exactly like the leave and exit inboxes.
 *
 * Employees with no configured approvers never appear here; their requests stay
 * on the flat HR-review path in Admin → Regularizations.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const empName = (r) => `${r.employee?.firstName || ''} ${r.employee?.lastName || ''}`.trim() || 'Employee';

// Where this request sits in its ladder, e.g. "Step 1 of 2".
function stepLabel(r) {
  const chain = r.approvalChain || [];
  if (!chain.length) return null;
  const idx = chain.findIndex((s) => s.status === 'Pending');
  return `Step ${(idx < 0 ? chain.length : idx + 1)} of ${chain.length}`;
}

export default function RegularizationApprovalsInbox() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState({});

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/approvals/regularizations?scope=pending');
      setRows(data.requests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load regularizations');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const decide = async (id, action) => {
    setBusy(`${id}:${action}`); setError('');
    try {
      await api.patch(`/approvals/regularizations/${id}/${action}`, { note: notes[id] || undefined });
      // Drop it from the queue: it either advanced to the next approver or ended.
      setRows((prev) => prev.filter((r) => r._id !== id));
    } catch (err) {
      setError(err.response?.data?.message || `Could not ${action} the request`);
    } finally {
      setBusy('');
    }
  };

  if (loading) return <div className="text-sm text-gray-500">Loading…</div>;

  return (
    <div>
      {error && (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}
      {rows.length === 0 ? (
        <div className="text-sm text-gray-500">Nothing awaiting your approval.</div>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r._id} className="bg-white shadow rounded-lg p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {empName(r)}
                    <span className="ml-2 text-xs font-normal text-gray-500">{r.type}</span>
                  </div>
                  <div className="text-sm text-gray-600 mt-0.5">
                    {fmtDate(r.date)}
                    {r.requestedCheckIn ? ` · in ${r.requestedCheckIn}` : ''}
                    {r.requestedCheckOut ? ` · out ${r.requestedCheckOut}` : ''}
                  </div>
                  <div className="text-sm text-gray-700 mt-1">{r.reason}</div>
                </div>
                {stepLabel(r) && (
                  <span className="text-xs px-2 py-1 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 shrink-0">
                    {stepLabel(r)}
                  </span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  placeholder="Note (optional)"
                  value={notes[r._id] || ''}
                  onChange={(e) => setNotes({ ...notes, [r._id]: e.target.value })}
                  className="flex-1 min-w-[12rem] border rounded-lg px-3 py-1.5 text-sm"
                />
                <button
                  onClick={() => decide(r._id, 'approve')}
                  disabled={!!busy}
                  className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50"
                >
                  {busy === `${r._id}:approve` ? 'Approving…' : 'Approve'}
                </button>
                <button
                  onClick={() => decide(r._id, 'reject')}
                  disabled={!!busy}
                  className="px-3 py-1.5 text-sm border border-red-300 text-red-700 rounded-lg hover:bg-red-50 disabled:opacity-50"
                >
                  {busy === `${r._id}:reject` ? 'Rejecting…' : 'Reject'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
