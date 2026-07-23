// Leave-approval inbox rendered in both the admin (Leave Approvals) and employee
// (Approvals) portals. Shows requests where the current user is the active
// approver in the reporting-hierarchy chain ("To approve") plus a history tab,
// and lets them approve/reject their rung. Exports ChainProgress for reuse by
// ExitApprovalsInbox.
import { useEffect, useState } from 'react';
import api from '../api/client';
import { promptDialog } from './dialogs';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '-');

const STEP_COLORS = {
  Waiting: 'bg-gray-100 text-gray-500',
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Skipped: 'bg-gray-100 text-gray-400 line-through',
};
const REQ_COLORS = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
  Cancelled: 'bg-gray-100 text-gray-700',
};

// Renders the reporting-hierarchy approval ladder as a row of chips so you can
// see who has approved, whose turn it is, and where a rejection happened.
function ChainProgress({ chain = [] }) {
  if (!chain.length) return <span className="text-xs text-gray-400 italic">No hierarchy - HR decides</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {chain.map((s, i) => (
        <span key={s._id || i} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-gray-300 text-xs">→</span>}
          <span
            className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STEP_COLORS[s.status] || 'bg-gray-100 text-gray-600'}`}
            title={`${s.approverName || 'Approver'}${s.role ? ` (${s.role})` : ''} · ${s.status}`}
          >
            {s.approverName || 'Approver'}
          </span>
        </span>
      ))}
    </div>
  );
}

const empName = (r) => `${r.employee?.user?.firstName || ''} ${r.employee?.user?.lastName || ''}`.trim() || 'Employee';

export default function LeaveApprovalsInbox() {
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [tab, setTab] = useState('pending'); // 'pending' (to approve) | 'history'

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [p, h] = await Promise.all([
        api.get('/approvals/leave?scope=pending'),
        api.get('/approvals/leave?scope=history'),
      ]);
      setPending(p.data.requests || []);
      setHistory(h.data.requests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load approvals');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const decide = async (id, action) => {
    const note = await promptDialog({ message: `Optional note for ${action}:` });
    if (note === null) return; // cancelled the prompt
    setBusyId(id); setError('');
    try {
      await api.patch(`/approvals/leave/${id}/${action}`, { note });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || `Could not ${action} the request`);
    } finally {
      setBusyId(null);
    }
  };

  // Chain-history minus the ones already shown in the actionable list.
  const pendingIds = new Set(pending.map((r) => r._id));
  const others = history.filter((r) => !pendingIds.has(r._id));

  if (loading) return <div className="text-gray-500">Loading…</div>;

  const tabBtn = (key, label, count) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        tab === key
          ? 'border-indigo-600 text-indigo-700'
          : 'border-transparent text-gray-500 hover:text-gray-700'
      }`}
    >
      {label} <span className="ml-1 text-xs text-gray-400">({count})</span>
    </button>
  );

  return (
    <div>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Tabs: the actionable approval queue is kept separate from history. */}
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {tabBtn('pending', 'To approve', pending.length)}
        {tabBtn('history', 'History', others.length)}
      </div>

      {tab === 'pending' && (
        <div className="bg-white shadow rounded-lg p-5">
          {pending.length === 0 ? (
            <p className="text-sm text-gray-400 italic">Nothing is waiting on you right now.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {pending.map((r) => (
                <li key={r._id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900">
                      {empName(r)}
                      <span className="ml-2 text-xs font-mono text-gray-400">{r.employee?.employeeCode}</span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.leaveType} · {fmtDate(r.startDate)}–{fmtDate(r.endDate)} · {r.totalDays}d
                      {r.reason ? ` · “${r.reason}”` : ''}
                    </div>
                    <div className="mt-1"><ChainProgress chain={r.approvalChain} /></div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => decide(r._id, 'approve')} disabled={busyId === r._id}
                      className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">Approve</button>
                    <button onClick={() => decide(r._id, 'reject')} disabled={busyId === r._id}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-red-600 hover:bg-red-50 disabled:opacity-50">Reject</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="bg-white shadow rounded-lg p-5">
          {others.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No other requests reference you.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {others.slice(0, 30).map((r) => (
                <li key={r._id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-gray-800">
                      {empName(r)}
                      <span className="text-xs text-gray-500"> · {r.leaveType} · {fmtDate(r.startDate)}–{fmtDate(r.endDate)} · {r.totalDays}d</span>
                    </div>
                    <div className="mt-1"><ChainProgress chain={r.approvalChain} /></div>
                  </div>
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg shrink-0 ${REQ_COLORS[r.status] || ''}`}>{r.status}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export { ChainProgress };
