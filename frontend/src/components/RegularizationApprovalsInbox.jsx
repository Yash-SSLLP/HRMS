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
 * TWO KINDS OF ROW, and the pill on the right says which. A NAMED step, where
 * approving passes the request up the ladder; and HR's FINAL step (`awaitingHr`
 * — no current approver, because HR is the last rung of every ladder and is not
 * in the chain array), where approving APPLIES the correction to the day. The
 * second kind reaches anyone holding `attendance.manage`, walled to their own
 * company, and covers employees with no configured approvers too — those come
 * straight here rather than climbing first.
 *
 * HISTORY (2026-09-25): every request whose chain I am on, or that I decided
 * as HR at the final step — with the named rungs' chips and, below them, who
 * made the final decision, when, and the note.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import ApprovalsEmpty from './ApprovalsEmpty';
import ApprovalsTabs, { useShowMore, OUTCOME_COLORS, HistoryEmpty } from './ApprovalsTabs';
import { ChainProgress } from './LeaveApprovalsInbox';
import { formatTime12, formatDateTime12 } from '../utils/time';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const empName = (r) => `${r.employee?.firstName || ''} ${r.employee?.lastName || ''}`.trim() || 'Employee';
const personName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

// Every time of day in the portal is 12-hour with a meridiem. formatTime12
// takes both a Date/ISO (the stored punch) and an "HH:mm" string (what the
// employee typed into the request), so both sides of the arrow go through it.
const t12 = (v) => formatTime12(v) || '—';

/**
 * One "In / Out" line showing what the punch is now and what it would become.
 * Rendered only for the side the employee actually asked to change, so a
 * check-in correction doesn't show a meaningless "Out — → —".
 */
function ChangeLine({ label, from, to }) {
  if (!to) return null;
  return (
    <div className="text-xs text-gray-700">
      <span className="text-gray-400 inline-block w-7">{label}</span>
      <span>{t12(from)}</span>
      <span className="text-gray-400 mx-1.5">→</span>
      <span className="font-medium">{t12(to)}</span>
    </div>
  );
}

// Where this request sits in its ladder, e.g. "Step 1 of 2".
//
// HR is the final rung and is NOT in `approvalChain` — the chain holds only the
// approvers a SuperAdmin named. So a cleared chain has no Pending rung to point
// at, and counting the array would label HR's own turn "Step 2 of 2", naming the
// step that has just finished rather than the one being asked for.
function stepLabel(r) {
  const chain = r.approvalChain || [];
  if (r.awaitingHr) return chain.length ? `Final · after ${chain.length} step${chain.length === 1 ? '' : 's'}` : 'Final';
  if (!chain.length) return null;
  const idx = chain.findIndex((s) => s.status === 'Pending');
  return `Step ${(idx < 0 ? chain.length : idx + 1)} of ${chain.length}`;
}

export default function RegularizationApprovalsInbox({ onCount }) {
  const [rows, setRows] = useState([]);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState('pending'); // 'pending' | 'history'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState({});

  const loadHistory = () => api.get('/approvals/regularizations?scope=history')
    .then(({ data }) => setHistory(data.requests || []));

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [{ data }] = await Promise.all([
        api.get('/approvals/regularizations?scope=pending'),
        // History failing must not take the queue down with it.
        loadHistory().catch(() => {}),
      ]);
      setRows(data.requests || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load regularizations');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Report the pending count to the page shell (ApprovalsBoard) so the summary
  // rail and this section's count pill can show it. Optional — the inbox still
  // works standalone. Held back until the first load finishes, so "0" always
  // means "all clear" and never "not fetched yet".
  useEffect(() => { if (!loading) onCount?.(rows.length); }, [loading, rows, onCount]);

  // History minus anything still in the actionable list above.
  const pendingIds = new Set(rows.map((r) => r._id));
  const others = history.filter((r) => !pendingIds.has(r._id));
  const { shown, more } = useShowMore(others, history);

  const decide = async (id, action) => {
    setBusy(`${id}:${action}`); setError('');
    try {
      await api.patch(`/approvals/regularizations/${id}/${action}`, { note: notes[id] || undefined });
      // Drop it from the queue: it either advanced to the next approver or ended.
      setRows((prev) => prev.filter((r) => r._id !== id));
      // Either way it belongs in History now; catch it up quietly.
      loadHistory().catch(() => {});
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
      <ApprovalsTabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'pending', label: 'To approve', count: rows.length },
          { key: 'history', label: 'History', count: others.length },
        ]}
      />

      {tab === 'pending' && (rows.length === 0 ? (
        <ApprovalsEmpty message="No regularizations are waiting on you." hint="These are corrections to a missed or mistaken punch." />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r._id} className="bg-white shadow rounded-lg p-4">
              {/* The details take the room the step pill leaves, so a long
                  reason wraps beside it instead of pushing it onto a line of
                  its own at the left. */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">
                    {empName(r)}
                    <span className="ml-2 text-xs font-normal text-gray-500">{r.type}</span>
                  </div>
                  <div className="text-sm text-gray-600 mt-0.5">{fmtDate(r.date)}</div>
                  {/* previousCheckIn/Out are written at approval time and hold the
                      true before-value, so history rows show the real change.
                      A pending request has them empty, so it falls back to the
                      day's current punch — which is the before-value it would
                      overwrite. */}
                  <div className="mt-1.5 space-y-0.5">
                    <ChangeLine label="In" from={r.previousCheckIn || r.current?.checkIn} to={r.requestedCheckIn} />
                    <ChangeLine label="Out" from={r.previousCheckOut || r.current?.checkOut} to={r.requestedCheckOut} />
                  </div>
                  <div className="text-sm text-gray-700 mt-1 break-words">{r.reason}</div>
                </div>
                {/* The final rung reads differently from a step on the way to
                    it: approving here APPLIES the correction to the day, where
                    approving a named step only passes it on. Same pill, own
                    colour, so a mixed queue can be scanned rather than read. */}
                {stepLabel(r) && (
                  <span className={`text-xs px-2 py-1 rounded-full border shrink-0 ${
                    r.awaitingHr
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                  }`}>
                    {stepLabel(r)}
                  </span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
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
      ))}

      {tab === 'history' && (others.length === 0 ? (
        <HistoryEmpty>No other regularizations reference you.</HistoryEmpty>
      ) : (
        <>
          <ul className="divide-y divide-gray-100">
            {shown.map((r) => {
              const finalBy = personName(r.reviewedBy);
              return (
                <li key={r._id} className="py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="min-w-0 sm:flex-1">
                    <div className="text-sm text-gray-800">
                      {empName(r)}
                      <span className="text-xs text-gray-500"> · {r.type} · {fmtDate(r.date)}</span>
                    </div>
                    <div className="mt-1 space-y-0.5">
                      <ChangeLine label="In" from={r.previousCheckIn || r.current?.checkIn} to={r.requestedCheckIn} />
                      <ChangeLine label="Out" from={r.previousCheckOut || r.current?.checkOut} to={r.requestedCheckOut} />
                    </div>
                    {r.reason && <div className="text-xs text-gray-600 mt-0.5 break-words">“{r.reason}”</div>}
                    {r.approvalChain?.length > 0 && (
                      <div className="mt-1"><ChainProgress chain={r.approvalChain} /></div>
                    )}
                    {/* The final decision is not a chip: HR's rung is not in the
                        chain. Named here, with when and why. */}
                    {r.status !== 'Pending' && (finalBy || r.reviewedAt) && (
                      <div className="text-[11px] text-gray-500 mt-0.5 break-words">
                        {r.status}{finalBy ? ` by ${finalBy}` : ''}
                        {r.reviewedAt ? ` · ${formatDateTime12(r.reviewedAt)}` : ''}
                        {r.reviewNote ? ` — “${r.reviewNote}”` : ''}
                      </div>
                    )}
                    {r.status === 'Pending' && !r.currentApprover && (
                      <div className="text-[11px] text-gray-500 mt-0.5">With HR for the final decision</div>
                    )}
                  </div>
                  <span className={`inline-block self-start sm:self-center px-2 py-0.5 text-xs rounded-lg shrink-0 ${OUTCOME_COLORS[r.status] || ''}`}>
                    {r.status}
                  </span>
                </li>
              );
            })}
          </ul>
          {more}
        </>
      ))}
    </div>
  );
}
