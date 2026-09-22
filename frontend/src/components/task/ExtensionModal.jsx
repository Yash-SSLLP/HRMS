/**
 * "I will do it — but not by then."
 *
 * NEW 2026-09-22, the doer's third answer after accept and decline. Both sides
 * of it live here, because they are one conversation and splitting them into
 * two components is how the wording on the asking side and the wording on the
 * answering side drift apart.
 *
 *   mode 'ask'     the doer names a new date and says why. POST /:id/extension
 *   mode 'decide'  the approver answers. POST /:id/extension/:reqId
 *
 * IT IS NOT A STATUS. The work carries on while the answer is awaited — that is
 * the whole point of asking rather than stopping — so nothing here moves the
 * task, and the modal says so in as many words.
 *
 * THE REASON IS REQUIRED and the server enforces it: *"Say why you need longer
 * — the person deciding has nothing else to go on."* So is a date LATER than
 * the current deadline, which is checked here too, before the round trip,
 * because being told no by a server after typing a paragraph is the worst way
 * to learn a rule.
 *
 * What approving actually does (services/taskEngine.decideExtension): it moves
 * `task.dueDate`, counts the extension, and CLEARS the fired-reminder memory so
 * the new date gets chased. What it deliberately does not do is re-derive
 * anybody's `completedLate` — extending a deadline after the fact never turns a
 * late delivery punctual.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { FiCalendar, FiCheck, FiClock, FiX, FiXCircle } from 'react-icons/fi';
import * as T from '../../api/tasks';
import { dayLabel, timeAgo } from '../../utils/taskLifecycle';

const BTN = 'min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border px-3.5 text-sm font-medium transition';
const GHOST = 'border-gray-200 bg-white text-gray-700 hover:border-gray-400 hover:text-blue-600';
const GO = 'border-transparent bg-emerald-600 text-white hover:bg-emerald-700';
const WARN = 'border-transparent bg-amber-600 text-white hover:bg-amber-700';

/** A datetime-local value for `d`, in the browser's own zone. */
function toLocalInput(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

/**
 * The date to open with: two working days on from the deadline, at the same
 * hour. A blank date box asks somebody to think about a calendar; a sensible
 * one asks them to check it, which is a much smaller job.
 */
function suggested(dueDate) {
  const base = dueDate ? new Date(dueDate) : new Date();
  if (Number.isNaN(base.getTime())) return '';
  const out = new Date(base);
  out.setDate(out.getDate() + 2);
  if (!dueDate) out.setHours(18, 0, 0, 0);
  return toLocalInput(out);
}

/** When it is due, in full — a deadline being moved deserves the whole date. */
const fullWhen = (d) => (d
  ? new Date(d).toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  })
  : 'no deadline set');

export default function ExtensionModal({
  open,
  onClose,
  task,
  can = {},
  /** 'ask' — the doer's form. 'decide' — the approver's answer. */
  mode = 'ask',
  /** Which request is being answered, in 'decide' mode. */
  requestId = null,
  /** Which button they pressed to get here, so the modal opens on that answer. */
  initialApprove,
  onDone,
}) {
  const [toDate, setToDate] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const deciding = mode === 'decide';

  const request = useMemo(() => {
    if (!deciding) return null;
    const rows = (task?.extensions || []).filter((e) => e.status === 'PENDING');
    return rows.find((e) => String(e._id) === String(requestId)) || rows[0] || null;
  }, [deciding, task, requestId]);

  useEffect(() => {
    if (!open) return;
    setToDate(suggested(task?.dueDate));
    setReason('');
    setNote('');
  }, [open, task]);

  if (!open || !task) return null;

  const askIt = async () => {
    const said = reason.trim();
    if (!toDate) { toast.error('Pick the new date you need.'); return; }
    if (!said) { toast.error('Say why you need longer — the person deciding has nothing else to go on.'); return; }
    const when = new Date(toDate);
    if (Number.isNaN(when.getTime())) { toast.error('That date did not make sense.'); return; }
    if (task.dueDate && when <= new Date(task.dueDate)) {
      toast.error('That is not later than the current deadline.');
      return;
    }

    setSaving(true);
    try {
      await T.requestExtension(task._id, { toDate: when.toISOString(), reason: said });
      toast.success('Asked. The work carries on while you wait for an answer.');
      onDone?.();
      onClose?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not send that request.');
    } finally {
      setSaving(false);
    }
  };

  const decide = async (approve) => {
    if (!request) { toast.error('That request is no longer there.'); return; }
    setSaving(true);
    try {
      await T.decideExtension(task._id, String(request._id), { approve, note: note.trim() });
      toast.success(
        approve
          ? `Deadline moved to ${dayLabel(request.toDate)}.`
          : 'Declined — the deadline stands.'
      );
      onDone?.();
      onClose?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not save that answer.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 px-4 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={deciding ? 'Answer the request for more time' : 'Ask for more time'}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-gray-900">
              <FiClock size={16} className="shrink-0 text-amber-500" />
              {deciding ? 'More time?' : 'Ask for more time'}
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              {deciding
                ? 'Nothing else moves either way — the task stays exactly where it is.'
                : 'The task does not stop while you wait for an answer.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[32px] min-w-[32px] shrink-0 rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <FiX size={18} />
          </button>
        </div>

        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5">
          <p className="truncate text-sm font-medium text-gray-800">{task.title}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500">
            <FiCalendar size={11} className="shrink-0" /> Due {fullWhen(task.dueDate)}
          </p>
        </div>

        {deciding ? (
          !request ? (
            <p className="mt-4 text-sm text-gray-500">That request has already been answered.</p>
          ) : (
            <>
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
                <p className="text-sm font-medium text-amber-900">
                  {request.requestedByName || 'Somebody'} wants until {fullWhen(request.toDate)}
                </p>
                <p className="mt-0.5 text-[11px] text-amber-700">asked {timeAgo(request.requestedAt)}</p>
                {request.reason && (
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-amber-900">{request.reason}</p>
                )}
              </div>

              <div className="mt-3">
                <label className="mb-1 block text-xs font-medium text-gray-500" htmlFor="extension-note">
                  Anything to say back? <span className="font-normal text-gray-400">(optional)</span>
                </label>
                <textarea
                  id="extension-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={1000}
                  placeholder="e.g. fine, but it cannot slip again — the client sees this on Friday"
                  className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2 text-sm"
                />
              </div>

              <p className="mt-2 text-[11px] text-gray-400">
                Giving the time moves the deadline and re-arms the reminders. It does not
                undo anybody's late delivery already on file.
              </p>

              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button type="button" onClick={onClose} className={`${BTN} ${GHOST}`}>Cancel</button>
                <button
                  type="button"
                  onClick={() => decide(false)}
                  disabled={saving}
                  className={`${BTN} ${GHOST} disabled:opacity-50`}
                >
                  <FiXCircle size={14} /> Decline
                </button>
                <button
                  type="button"
                  onClick={() => decide(true)}
                  disabled={saving}
                  /* Which button they pressed on the task to get here is the
                     answer they already had in mind; it opens highlighted. */
                  className={`${BTN} ${initialApprove === false ? WARN : GO} disabled:opacity-50`}
                >
                  <FiCheck size={14} /> {saving ? 'Saving…' : `Give until ${dayLabel(request.toDate)}`}
                </button>
              </div>
            </>
          )
        ) : (
          <>
            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-500" htmlFor="extension-date">
                New date you need <span className="text-red-500">*</span>
              </label>
              <input
                id="extension-date"
                type="datetime-local"
                value={toDate}
                min={toLocalInput(task.dueDate)}
                onChange={(e) => setToDate(e.target.value)}
                className="min-h-[40px] w-full rounded-xl border border-gray-200 px-3 text-sm"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                It has to be later than the deadline you have now.
              </p>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-xs font-medium text-gray-500" htmlFor="extension-reason">
                Why <span className="text-red-500">*</span>
              </label>
              <textarea
                id="extension-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                maxLength={1000}
                placeholder="e.g. the vendor has not sent the invoices yet — I have chased twice"
                className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2 text-sm"
              />
            </div>

            <p className="mt-2 text-[11px] text-gray-400">
              {task.approverName || task.createdByName || 'Whoever set this'} answers it. You can only
              have one request outstanding at a time.
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className={`${BTN} ${GHOST}`}>Cancel</button>
              <button
                type="button"
                onClick={askIt}
                disabled={saving || !can.canRequestExtension}
                title={can.canRequestExtension ? undefined : 'You already have a request waiting on this task'}
                className={`${BTN} ${WARN} disabled:opacity-50`}
              >
                <FiClock size={14} /> {saving ? 'Asking…' : 'Ask for more time'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
