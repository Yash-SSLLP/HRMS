import { useState } from 'react';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { hasPermission } from '../config/permissions';

/**
 * Change a leave request's TYPE or DURATION on the employee's behalf.
 *
 * Shared by the approvals inbox (managers, executives) and the HR leave list, so
 * the two cannot offer different fields or different wording for the same act.
 * The server (PATCH /leave/requests/:id/amend) decides who may do it — a manager
 * on the ladder, HR, or a CEO/MD who was told about it — so nothing here is
 * role-gated; the button is simply not worth showing on a decided request.
 *
 * WHAT THE FORM HAS TO SAY OUT LOUD. On an approved leave this is not editing a
 * form, it is moving days on somebody's attendance calendar and possibly moving
 * pay between paid and unpaid. So the panel says so before the fields, and the
 * reason is required rather than optional — the employee is shown it.
 * @param {{request: Object, onClose: Function, onSaved: Function}} props
 */
export default function LeaveAmendModal({ request, onClose, onSaved }) {
  const ymd = (d) => (d ? String(d).slice(0, 10) : '');
  // Only the audit grant may overrule the approvers, so the field is not even
  // drawn without it — the server refuses it either way.
  const me = useAuthStore((s) => s.user);
  const maySetStatus = hasPermission(me, 'leave.history');
  const [form, setForm] = useState({
    status: request.status,
    leaveType: request.leaveType,
    startDate: ymd(request.startDate),
    endDate: ymd(request.endDate),
    isHalfDay: !!request.isHalfDay,
    halfDaySession: request.halfDaySession || 'FirstHalf',
    note: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (patch) => setForm((f) => {
    const next = { ...f, ...patch };
    // A half day is one day by definition. Collapsing the range here rather than
    // leaving the server to reject it means the form can never be in a shape the
    // API would refuse.
    if (next.isHalfDay) next.endDate = next.startDate;
    return next;
  });

  const submit = async (e) => {
    e.preventDefault();
    if (!form.note.trim()) { setError('Say why it is being changed — the employee is shown the reason.'); return; }
    setSaving(true); setError('');
    try {
      const { data } = await api.patch(`/leave/requests/${request._id}/amend`, {
        ...(maySetStatus && form.status !== request.status ? { status: form.status } : {}),
        leaveType: form.leaveType,
        startDate: form.startDate,
        endDate: form.isHalfDay ? form.startDate : form.endDate,
        isHalfDay: form.isHalfDay,
        halfDaySession: form.isHalfDay ? form.halfDaySession : undefined,
        note: form.note.trim(),
      });
      onSaved?.(data.request);
      onClose();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not change the leave');
    } finally {
      setSaving(false);
    }
  };

  const who = `${request.employee?.user?.firstName || ''} ${request.employee?.user?.lastName || ''}`.trim()
    || 'this employee';

  return (
    /* index.css's modal safety net is written as `.fixed.inset-0 > div` — an
       element-typed selector that skips a <form> entirely — so the overlay
       carries `overflow-y-auto` and the form `my-8`, which is what keeps the top
       of an over-tall panel reachable once the overlay scrolls. */
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <form onSubmit={submit} className="bg-white rounded-xl shadow-xl w-full max-w-md p-5 my-8">
        <h3 className="text-lg font-semibold text-gray-900">Change this leave</h3>
        <p className="text-xs text-gray-500 mt-1 mb-4">
          {who}&apos;s {request.leaveType}, currently {request.totalDays} day{request.totalDays === 1 ? '' : 's'}.
          {request.status === 'Approved'
            ? ' It is already approved, so changing it moves the days on their attendance calendar and recalculates how much of it is paid.'
            : request.status === 'Pending'
              ? ' It has not been decided yet, so this only changes what is being asked for.'
              : ` It is ${request.status.toLowerCase()}, so nothing is on their calendar for these days right now.`}
        </p>

        {error && (
          <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
        )}

        {/* WHAT THE DAY ACTUALLY WAS. Drawn first, because on a decided leave it
            is the question being answered — the type and the dates are detail
            beside it. Only for the audit grant; the server refuses it from
            anyone else, so a manager fixing a typo never sees it.

            There is no "Present" option because presence is not a property of a
            leave: it is what the attendance calendar says once the leave stops
            claiming the day. Rejected/Cancelled is what frees the day, and the
            wording below says so rather than making the reader work it out. */}
        {maySetStatus && (
          <>
            <label className="block text-sm text-gray-700 mb-1">What the day was</label>
            <select value={form.status} onChange={(e) => set({ status: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1 text-sm">
              <option value="Approved">Taken as leave — the days stay on their calendar</option>
              <option value="Rejected">Rejected — the days come off; they count as a normal working day</option>
              <option value="Cancelled">Cancelled — same, but nobody refused it</option>
              {request.status === 'Pending' && <option value="Pending">Still waiting on a decision</option>}
            </select>
            {form.status !== request.status && (
              <p className="text-xs text-amber-700 mb-3">
                {form.status === 'Approved'
                  ? 'Those days go back onto their attendance calendar as leave.'
                  : 'Those days come off their attendance calendar — whether they were present is then whatever their punches say.'}
              </p>
            )}
            {form.status === request.status && <div className="mb-3" />}
          </>
        )}

        <label className="block text-sm text-gray-700 mb-1">Type of leave</label>
        <select value={form.leaveType} onChange={(e) => set({ leaveType: e.target.value })}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3 text-sm">
          {['Paid Leave', 'Unpaid Leave', 'Emergency Leave', 'Maternity Leave'].map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-sm text-gray-700 mb-3">
          <input type="checkbox" checked={form.isHalfDay}
            onChange={(e) => set({ isHalfDay: e.target.checked })} />
          Half day
        </label>

        {form.isHalfDay ? (
          <>
            <label className="block text-sm text-gray-700 mb-1">Date</label>
            <input type="date" required value={form.startDate}
              onChange={(e) => set({ startDate: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3 text-sm" />
            <label className="block text-sm text-gray-700 mb-1">Which half</label>
            <select value={form.halfDaySession} onChange={(e) => set({ halfDaySession: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-3 text-sm">
              <option value="FirstHalf">First half</option>
              <option value="SecondHalf">Second half</option>
            </select>
          </>
        ) : (
          <div className="flex gap-3 mb-3">
            <div className="flex-1">
              <label className="block text-sm text-gray-700 mb-1">From</label>
              <input type="date" required value={form.startDate}
                onChange={(e) => set({ startDate: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
            <div className="flex-1">
              <label className="block text-sm text-gray-700 mb-1">To</label>
              <input type="date" required value={form.endDate}
                onChange={(e) => set({ endDate: e.target.value })}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </div>
          </div>
        )}

        <label className="block text-sm text-gray-700 mb-1">
          Why is it being changed? <span aria-hidden="true" className="text-red-600">*</span>
        </label>
        <input type="text" required maxLength={500} value={form.note}
          onChange={(e) => set({ note: e.target.value })}
          placeholder="e.g. Came back a day early"
          className="w-full border border-gray-300 rounded-lg px-3 py-2 mb-1 text-sm" />
        <p className="text-xs text-gray-400 mb-4">{who} is told about the change and shown this reason.</p>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose}
            className="px-4 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50">Cancel</button>
          <button type="submit" disabled={saving}
            className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm hover:bg-gray-700 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save the change'}
          </button>
        </div>
      </form>
    </div>
  );
}
