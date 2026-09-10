// Leave-approval inbox rendered in both the admin (Leave Approvals) and employee
// (Approvals) portals. Shows requests where the current user is the active
// approver in the reporting-hierarchy chain ("To approve") plus a history tab,
// and lets them approve/reject their rung. Exports ChainProgress for reuse by
// ExitApprovalsInbox.
import { useEffect, useState } from 'react';
import api from '../api/client';
import ApprovalsEmpty from './ApprovalsEmpty';
import LeaveAmendModal from './LeaveAmendModal';
import { useAuthStore } from '../store/authStore';
import { hasPermission } from '../config/permissions';
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
//
// An OVERRIDE rung (somebody senior deciding over the approvers' heads) shows
// the person's name like any other rung, followed by a small "override" tag —
// the two facts are separate and both matter: who decided, and that they did it
// out of turn. It used to render as the bare words "HR override" with no name at
// all. Rows decided before that was fixed still carry the old text, so they read
// as "HR override · override"; nothing is lost, and new ones name the person.
function ChainProgress({ chain = [] }) {
  if (!chain.length) return <span className="text-xs text-gray-400 italic">No hierarchy - HR decides</span>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {chain.map((s, i) => {
        const name = s.approverName || 'Approver';
        const isOverride = s.role === 'Override';
        const when = s.decidedAt ? new Date(s.decidedAt).toLocaleString('en-IN', {
          day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
        }) : '';
        return (
          <span key={s._id || i} className="inline-flex items-center gap-1">
            {i > 0 && <span className="text-gray-300 text-xs">→</span>}
            <span
              className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-lg ${STEP_COLORS[s.status] || 'bg-gray-100 text-gray-600'}`}
              title={[
                `${name}${s.role && !isOverride ? ` (${s.role})` : ''}`,
                s.status,
                isOverride ? 'decided over the remaining approvers' : '',
                when,
                s.note ? `Note: ${s.note}` : '',
              ].filter(Boolean).join(' · ')}
            >
              {name}
              {isOverride && (
                <span className="px-1 rounded bg-amber-100 text-amber-800 text-[10px] font-semibold uppercase tracking-wide">
                  override
                </span>
              )}
            </span>
          </span>
        );
      })}
    </div>
  );
}

const empName = (r) => `${r.employee?.user?.firstName || ''} ${r.employee?.user?.lastName || ''}`.trim() || 'Employee';

export default function LeaveApprovalsInbox({ onCount }) {
  const [pending, setPending] = useState([]);
  const [history, setHistory] = useState([]);
  // Emergency leave that was granted on filing and that nobody has yet ruled on.
  // Its own list, not folded into `pending`: these days have already been taken,
  // and a queue whose buttons say Approve would be describing a decision that is
  // no longer available to anyone.
  const [emergency, setEmergency] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [tab, setTab] = useState('pending'); // 'pending' | 'emergency' | 'history'
  // The request being edited, or null. One modal for every tab.
  const [amending, setAmending] = useState(null);
  // The audit grant: see every leave's full trail, and correct one that is
  // already decided. Without it the Edit button stops at open requests, which is
  // exactly what the server enforces.
  const mayEditDecided = hasPermission(useAuthStore.getState().user, 'leave.history');

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [p, h, e] = await Promise.all([
        api.get('/approvals/leave?scope=pending'),
        api.get('/approvals/leave?scope=history'),
        api.get('/approvals/leave?scope=emergency'),
      ]);
      setPending(p.data.requests || []);
      setHistory(h.data.requests || []);
      setEmergency(e.data.requests || []);
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
      // Take the decided row out of the queue in place. `await load()` here
      // unmounted the entire panel behind a "Loading…" line and dropped the
      // reviewer back at the top of a list they were working down.
      setPending((prev) => prev.filter((r) => r._id !== id));
      // The history tab still has to catch up, but quietly: never through
      // `loading`, which is what caused the collapse.
      api.get('/approvals/leave?scope=history')
        .then((h) => setHistory(h.data.requests || []))
        .catch(() => {});
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

  /**
   * Confirm that an emergency leave stands, or reject it.
   *
   * Emergency leave is granted the moment it is filed — nobody was asked — so
   * this is the only place anyone gets to disagree with it. Rejecting takes the
   * days off the calendar and they count as absence instead, which is a real
   * cost to the employee, so the confirmation says so plainly and the reason is
   * required rather than optional.
   */
  const review = async (r, decision) => {
    if (decision === 'reject' && !(await confirmDialog({
      title: `Reject ${empName(r)}'s emergency leave?`,
      message: `${r.totalDays} day${r.totalDays === 1 ? '' : 's'} will stop being leave and count as absence instead. `
        + 'They are told, with your reason. You can put it back afterwards if this turns out to be wrong.',
      tone: 'danger',
      confirmText: 'Reject the leave',
    }))) return;
    const note = await promptDialog({
      message: decision === 'reject'
        ? 'Why is it being rejected? The employee sees this.'
        : 'Optional note (the employee sees this):',
    });
    if (note === null) return;
    if (decision === 'reject' && !note.trim()) return;
    setBusyId(r._id); setError('');
    try {
      await api.patch(`/leave/emergency/${r._id}/review`, { decision, note });
      // Out of the queue in place — the same reason `decide` does it rather than
      // reloading: a full reload drops the reviewer back to the top of a list
      // they were working down.
      setEmergency((prev) => prev.filter((x) => x._id !== r._id));
      api.get('/approvals/leave?scope=history')
        .then((h) => setHistory(h.data.requests || []))
        .catch(() => {});
    } catch (err) {
      setError(err.response?.data?.message || `Could not ${decision} the leave`);
    } finally {
      setBusyId(null);
    }
  };

  // Chain-history minus the ones already shown in the actionable list.
  // Report the pending count to the page shell (ApprovalsBoard) so the summary
  // rail and this section's count pill can show it. Optional — the inbox still
  // works standalone. Held back until the first load finishes, so "0" always
  // means "all clear" and never "not fetched yet".
  // Both queues count towards the section badge: an emergency leave nobody has
  // ruled on is as much "waiting on you" as a request awaiting approval, and a
  // badge that ignored it would leave the tab looking clear while it is not.
  useEffect(() => {
    if (!loading) onCount?.(pending.length + emergency.length);
  }, [loading, pending, emergency, onCount]);

  const pendingIds = new Set(pending.map((r) => r._id));
  const others = history.filter((r) => !pendingIds.has(r._id));

  // Only the FIRST load takes the panel away. Any later refetch happens under
  // the per-row busy state, so the list a reviewer is reading stays on screen.
  if (loading && !pending.length && !history.length) return <div className="text-gray-500">Loading…</div>;

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
        {tabBtn('emergency', 'Emergency', emergency.length)}
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
                    {/* Correcting the ask is a third answer alongside yes and
                        no: a request with the wrong dates or the wrong type does
                        not need rejecting, it needs fixing. */}
                    <button onClick={() => setAmending(r)} disabled={busyId === r._id}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">Edit</button>
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

      {/* Emergency leave: already taken, still unruled-on. The wording carries the
          whole difference from the queue above — nothing here is being approved,
          because it already happened. */}
      {tab === 'emergency' && (
        <div>
          <p className="text-xs text-gray-500 mb-3 max-w-2xl">
            Emergency leave is granted the moment it is filed — nobody is asked first, which is the point of it.
            These are the ones you were told about and nobody has ruled on yet. <strong>Confirm</strong> the ones
            that stand; <strong>reject</strong> one that should not, which takes those days off the calendar and
            counts them as absence instead.
          </p>
          {emergency.length === 0 ? (
            <ApprovalsEmpty hint="Emergency leave taken by anyone in your reporting line appears here, already granted, for you to confirm or reject." />
          ) : (
            <ul className="divide-y divide-gray-100">
              {emergency.map((r) => (
                <li key={r._id} className="py-3 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-900">
                      {empName(r)}
                      <span className="ml-2 text-xs font-mono text-gray-400">{r.employee?.employeeCode}</span>
                    </div>
                    <div className="text-xs text-gray-500">
                      {fmtDate(r.startDate)}–{fmtDate(r.endDate)} · {r.totalDays}d
                      {r.lopDays > 0 && <span className="text-red-600 font-medium"> · {r.lopDays} LOP</span>}
                      {r.reason ? ` · “${r.reason}”` : ''}
                    </div>
                    {/* Repeat use is the thing a reviewer most needs to know before
                        deciding, so it is stated on the row rather than left to be
                        inferred from the dates. */}
                    {r.emergencyFlagged && (
                      <div className="text-[11px] text-red-700 mt-0.5">
                        ⚑ {r.emergencyIndexInMonth} emergency leaves that month
                      </div>
                    )}
                    {r.doubleCut && (
                      <div className="text-[11px] text-red-600 mt-0.5 font-medium">
                        Charged at double pay{r.doubleCutByName ? ` by ${r.doubleCutByName}` : ''} · undo it before rejecting
                      </div>
                    )}
                    <div className="mt-1"><ChainProgress chain={r.approvalChain} /></div>
                  </div>
                  <div className="flex flex-wrap gap-2 shrink-0">
                    <button onClick={() => setAmending(r)} disabled={busyId === r._id}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50">
                      Edit
                    </button>
                    <button onClick={() => review(r, 'confirm')} disabled={busyId === r._id}
                      className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                      Confirm
                    </button>
                    <button onClick={() => review(r, 'reject')} disabled={busyId === r._id}
                      className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-red-600 hover:bg-red-50 disabled:opacity-50">
                      Reject
                    </button>
                    <button onClick={() => toggleDoubleCut(r)} disabled={busyId === r._id}
                      className={`text-xs px-3 py-1.5 rounded-lg border border-gray-300 disabled:opacity-50 ${
                        r.doubleCut ? 'text-gray-600 hover:bg-gray-50' : 'text-red-600 hover:bg-red-50'}`}
                      title={r.doubleCut ? 'Remove the double salary cut' : 'Charge this day at 2× salary in payroll'}>
                      {r.doubleCut ? 'Undo double cut' : 'Double cut'}
                    </button>
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
                    {/* How an emergency leave ended up. 'Approved' on one of these
                        only ever meant "taken", so the row has to say separately
                        whether a human agreed with it. */}
                    {r.leaveType === 'Emergency Leave' && r.emergencyReview?.status
                      && r.emergencyReview.status !== 'Pending' && (
                      <div className={`text-[11px] mt-0.5 ${r.emergencyReview.status === 'Rejected' ? 'text-red-700' : 'text-green-700'}`}>
                        {r.emergencyReview.status === 'Rejected' ? 'Rejected' : 'Confirmed'} by{' '}
                        {r.emergencyReview.byName || 'a reviewer'}
                        {r.emergencyReview.byRole ? ` (${r.emergencyReview.byRole})` : ''}
                        {r.emergencyReview.note ? ` — “${r.emergencyReview.note}”` : ''}
                      </div>
                    )}
                    {/* EVERY CORRECTION MADE TO THIS LEAVE, oldest last. The
                        chain above says who approved what; without this the row
                        could not say that the thing they approved has since been
                        changed, or by whom — and a record that quietly differs
                        from the decision is the one an audit asks about. Shown
                        to everyone who can see the row: the trail is the point
                        of a history tab, and the GRANT is about changing it. */}
                    {(r.amendments || []).length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {r.amendments.map((a, i) => (
                          <div key={a.at || i} className="text-[11px] text-gray-500">
                            <span className="text-gray-400">{fmtDate(a.at)}</span>{' '}
                            {a.byName || 'Someone'}
                            {a.byRole ? ` (${a.byRole})` : ''} changed {a.summary}
                            {a.note ? ` \\u2014 \\u201c${a.note}\\u201d` : ''}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="mt-1"><ChainProgress chain={r.approvalChain} /></div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {/* Still correctable once approved: the days are on a
                        calendar somebody has to live with, and the API amends
                        that calendar with the request. A CANCELLED or REJECTED
                        one is correctable too, but only with the audit grant —
                        changing what a settled record says is a different act
                        from fixing a live one. */}
                    {(r.status === 'Approved' || (mayEditDecided && ['Cancelled', 'Rejected'].includes(r.status))) && (
                      <button onClick={() => setAmending(r)} disabled={busyId === r._id}
                        className="text-gray-600 hover:underline">
                        Edit
                      </button>
                    )}
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
      {amending && (
        <LeaveAmendModal
          request={amending}
          onClose={() => setAmending(null)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}

export { ChainProgress };
