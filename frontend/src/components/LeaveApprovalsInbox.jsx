// Leave-approval inbox rendered in both the admin (Leave Approvals) and employee
// (Approvals) portals. Shows requests where the current user is the active
// approver in the reporting-hierarchy chain ("To approve") plus a history tab,
// and lets them approve/reject their rung. Exports ChainProgress for reuse by
// ExitApprovalsInbox.
import { useEffect, useState } from 'react';
import api from '../api/client';
import ApprovalsEmpty from './ApprovalsEmpty';
import { promptDialog, confirmDialog } from './dialogs';

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

export default function LeaveApprovalsInbox({ onCount }) {
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

  // Emergency leave reaches a manager already granted — it needs no approval, so
  // the only lever afterwards is charging the day at double pay. Available to
  // every manager on the employee's ladder (and HR).
  const toggleDoubleCut = async (r) => {
    const apply = !r.doubleCut;
    if (apply && !(await confirmDialog({
      message: `Charge ${empName(r)}'s emergency leave at double pay? They lose 2 days' salary for ${r.totalDays} day(s) in this month's payroll.`,
      tone: 'danger',
      confirmText: 'Apply double cut',
    }))) return;
    const note = apply ? await promptDialog({ message: 'Optional note (the employee sees this):' }) : '';
    if (note === null) return;
    setBusyId(r._id); setError('');
    try {
      await api.patch(`/leave/emergency/${r._id}/double-cut`, { apply, note });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update the double cut');
    } finally {
      setBusyId(null);
    }
  };

  // Chain-history minus the ones already shown in the actionable list.
  // Report the pending count to the page shell (ApprovalsBoard) so the summary
  // rail and this section's count pill can show it. Optional — the inbox still
  // works standalone. Held back until the first load finishes, so "0" always
  // means "all clear" and never "not fetched yet".
  useEffect(() => { if (!loading) onCount?.(pending.length); }, [loading, pending, onCount]);

  const pendingIds = new Set(pending.map((r) => r._id));
  const others = history.filter((r) => !pendingIds.has(r._id));

  if (loading) return <div className="text-gray-500">Loading…</div>;

  // A segmented control, not an underline: these read as the buttons they are,
  // and the count travels in a chip rather than in dim parentheses. `bg-white`
  // and `bg-gray-100` both carry a dark-mode remap in index.css, and the active
  // chip uses the portal accent rather than a hardcoded hue.
  const tabBtn = (key, label, count) => {
    const on = tab === key;
    return (
      <button
        type="button"
        onClick={() => setTab(key)}
        aria-pressed={on}
        className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-sm font-semibold transition-all ${
          on
            ? 'bg-white text-gray-900 shadow-sm ring-1 ring-gray-200'
            : 'text-gray-500 hover:text-gray-800'
        }`}
      >
        {label}
        <span
          className={`text-[11px] font-bold leading-none px-1.5 py-0.5 rounded-full tabular-nums ${
            on ? 'accent-bg on-accent' : 'bg-gray-200 text-gray-600'
          }`}
        >
          {count}
        </span>
      </button>
    );
  };

  return (
    <div>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Tabs: the actionable approval queue is kept separate from history. */}
      <div className="inline-flex items-center gap-1 p-1 mb-4 rounded-xl bg-gray-100 border border-gray-200">
        {tabBtn('pending', 'To approve', pending.length)}
        {tabBtn('history', 'History', others.length)}
      </div>

      {tab === 'pending' && (
        <div>
          {pending.length === 0 ? (
            <ApprovalsEmpty hint="Leave requests appear here when someone in your reporting line applies." />
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
                      {r.lopDays > 0 && <span className="text-red-600 font-medium"> · {r.lopDays} LOP</span>}
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
        <div>
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
                    {r.emergencyFlagged && (
                      <div className="text-[11px] text-red-700 mt-0.5">
                        ⚑ {r.emergencyIndexInMonth} emergency leaves this month — no approval was required
                      </div>
                    )}
                    {r.doubleCut && (
                      <div className="text-[11px] text-red-600 mt-0.5 font-medium">
                        Charged at double pay{r.doubleCutByName ? ` by ${r.doubleCutByName}` : ''}
                      </div>
                    )}
                    <div className="mt-1"><ChainProgress chain={r.approvalChain} /></div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {r.leaveType === 'Emergency Leave' && r.status === 'Approved' && (
                      <button onClick={() => toggleDoubleCut(r)} disabled={busyId === r._id}
                        className={r.doubleCut ? 'text-gray-600 hover:underline' : 'text-red-600 hover:underline'}
                        title={r.doubleCut ? 'Remove the double salary cut' : 'Charge this day at 2× salary in payroll'}>
                        {r.doubleCut ? 'Undo double cut' : 'Double cut'}
                      </button>
                    )}
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${REQ_COLORS[r.status] || ''}`}>{r.status}</span>
                  </div>
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
