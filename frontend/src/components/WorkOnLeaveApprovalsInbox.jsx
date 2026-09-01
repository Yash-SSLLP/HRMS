/**
 * WorkOnLeaveApprovalsInbox — days someone punched in on while they were on
 * approved leave, waiting on the signed-in user.
 *
 * Unlike leave this is not a ladder. The whole hierarchy already granted the
 * leave, so only its TOP rung rules on whether working through it counts, and
 * that is who this queue is scoped to (server-side, on
 * `workOnLeave.approver === me`). The claim lives on the attendance record
 * itself, so a row here is a DAY, not a request.
 *
 * Approving returns the leave day to the employee and turns the day into a
 * normal worked one; rejecting keeps the punches on the record for audit but
 * leaves the day as leave. HR is notified either way by the server.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import ApprovalsEmpty from './ApprovalsEmpty';
import { formatTime12, formatHours } from '../utils/time';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
const empName = (r) =>
  `${r.employee?.user?.firstName || ''} ${r.employee?.user?.lastName || ''}`.trim() || 'Employee';
const t12 = (v) => formatTime12(v) || '—';

export default function WorkOnLeaveApprovalsInbox({ onCount }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [notes, setNotes] = useState({});

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/approvals/work-on-leave?scope=pending');
      setRows(data.claims || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load punch-ins on leave days');
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


  const decide = async (id, action) => {
    setBusy(`${id}:${action}`); setError('');
    try {
      await api.patch(`/approvals/work-on-leave/${id}/${action}`, { note: notes[id] || undefined });
      setRows((prev) => prev.filter((r) => r._id !== id));
    } catch (err) {
      setError(err.response?.data?.message || `Could not ${action} the punch-in`);
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
        <ApprovalsEmpty message="No punch-ins on a leave day to review." hint="One appears here when somebody clocks in on a day they were approved to be away." />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r._id} className="bg-white shadow rounded-lg p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {empName(r)}
                    {r.employee?.employeeCode && (
                      <span className="ml-2 text-xs font-normal text-gray-500">{r.employee.employeeCode}</span>
                    )}
                  </div>
                  <div className="text-sm text-gray-600 mt-0.5">{fmtDate(r.date)}</div>
                  <div className="text-xs text-gray-700 mt-1.5">
                    <span className="text-gray-400 inline-block w-7">In</span>
                    <span className="font-medium">{t12(r.checkIn)}</span>
                    <span className="text-gray-400 mx-1.5">·</span>
                    <span className="text-gray-400 inline-block w-7">Out</span>
                    <span className="font-medium">{t12(r.checkOut)}</span>
                    {r.hoursWorked > 0 && (
                      <span className="text-gray-400 ml-2">{formatHours(r.hoursWorked)}</span>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-2 max-w-prose">
                    Punched in while on approved <strong>{r.workOnLeave?.leaveType || 'leave'}</strong>.
                    Approving returns the leave day and records the day as worked; rejecting keeps the
                    punches on the record but the day stays as leave.
                  </p>
                </div>
                <span className="text-xs px-2 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-200 shrink-0">
                  Worked on leave
                </span>
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
