/**
 * MarkOnLeaveModal — account for somebody's absent day on their behalf.
 *
 * Lifted out of the manager's team board so HR's org-wide presence board files
 * the leave the same way: this dialog spends a real paid-leave balance, and two
 * hand-kept copies of it would drift until the same absence priced differently
 * on two screens — which is a difference in somebody's salary, not in wording.
 *
 * The only thing the two callers disagree about is where the request goes (a
 * manager posts to /manager/team/:profileId/leave, HR to
 * /leave/employees/:profileId/mark), so `endpoint` is a prop. Both routes answer
 * alike — 201 { split: { paidDays, lopDays } } — and both write their refusals
 * as sentences aimed at the reader, so the catch shows the server's message
 * instead of guessing at one.
 */
import { useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';

// The three types either screen may record for one absent day. Maternity is in
// the leave enum too but is a 26-week statutory entitlement — never something to
// reach for while accounting for a missing morning.
export const MARK_LEAVE_TYPES = ['Unpaid Leave', 'Paid Leave', 'Emergency Leave'];

const days = (n) => `${n} day${Number(n) === 1 ? '' : 's'}`;
const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

/**
 * How the server actually priced the day, in the reader's words. Paid Leave can
 * come back part paid and part LOP once the monthly quota is spent, and that is
 * the bit they need to hear back — so this reports the response, never the
 * request.
 */
export const splitNote = ({ paidDays = 0, lopDays = 0 } = {}) => {
  if (paidDays > 0 && lopDays > 0) return ` — ${days(paidDays)} paid, ${days(lopDays)} loss of pay`;
  if (lopDays > 0) return ` — ${days(lopDays)} loss of pay`;
  if (paidDays > 0) return ` — ${days(paidDays)} paid`;
  return '';
};

/**
 * @param {object|null} person - who to mark ({ profileId, name, employeeCode });
 *   null renders nothing, so the parent can hold it in one piece of state
 * @param {string} date - 'YYYY-MM-DD' the leave lands on (the day the board shows)
 * @param {(profileId: string) => string} endpoint - route to POST to
 * @param {() => void} onClose
 * @param {() => (void|Promise<void>)} onDone - re-read the board; the marked day
 *   has to come back from the server rather than be patched in
 */
export default function MarkOnLeaveModal({ person, date, endpoint, onClose, onDone }) {
  const [leaveType, setLeaveType] = useState('Unpaid Leave');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  if (!person) return null;

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { data } = await api.post(endpoint(person.profileId), {
        leaveType,
        date,
        reason: reason.trim() || undefined,
      });
      onClose();
      toast.success(`${person.name} — recorded as ${leaveType}${splitNote(data.split)}`);
      await onDone?.();
    } catch (err) {
      // 400/403/404/409 each carry a written explanation (unknown type, not
      // yours to mark, no such employee, that day is already covered). Show
      // theirs — ours would be a guess at which one fired.
      toast.error(err.response?.data?.message || 'Could not record that leave');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4" onClick={() => !saving && onClose()}>
      {/* The panel has to be a <div>: every modal rule in index.css selects
          `.fixed.inset-0 > div`, so while this was a bare <form> it got none of
          them — no height cap and no scrolling, which put 'Record leave' off the
          bottom of a landscape phone with no way to reach it. The click-stopper
          belongs on the panel, not the form inside it: a click landing on the
          panel's own padding would otherwise reach the overlay and throw away a
          half-written reason. */}
      <div className="bg-white rounded-xl p-5 w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <h3 className="text-base font-semibold text-gray-900">Mark on leave</h3>
              <p className="text-xs text-gray-500 mt-0.5">
                {person.name}{person.employeeCode ? ` (${person.employeeCode})` : ''} · {fmtDay(date)}
              </p>
            </div>
            <button type="button" aria-label="Close" title="Close" onClick={onClose}
              className="topbar-icon-btn shrink-0">×</button>
          </div>

          <label className="block text-xs text-gray-600 mb-1">Leave type</label>
          <select value={leaveType} onChange={(e) => setLeaveType(e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white mb-3">
            {MARK_LEAVE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          <label className="block text-xs text-gray-600 mb-1">Reason</label>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
            placeholder="What they told you — a call, a message, a family emergency."
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-2" />

          <p className="text-xs text-gray-500 mb-4">
            Paid Leave draws their paid quota of 2 days a month; anything past it becomes loss of pay.
            Unpaid Leave is loss of pay outright. Emergency Leave is granted without anyone&apos;s approval.
            They are told either way.
          </p>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={saving}
              className="px-3 py-1.5 text-sm font-medium border border-gray-300 rounded-lg bg-white hover:bg-gray-50 disabled:opacity-60">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="px-3 py-1.5 text-sm font-medium border border-indigo-600 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60">
              {saving ? 'Recording…' : 'Record leave'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
