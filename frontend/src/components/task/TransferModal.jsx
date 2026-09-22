/**
 * Transfer — it went to the wrong person.
 *
 * NEW 2026-09-22, from the brief: *"if the task is assigned to wrong user then
 * they can transfer to anyone and it will be fully transferred to the new
 * user"*. It sits beside Delegate and is its opposite, which is the one thing
 * this screen has to make impossible to misread:
 *
 *              delegate                      transfer
 *   answerable  ME — I become the approver    the new person's own approver
 *   updates     I hear about every one        I hear nothing, ever again
 *   direction   down or across only           anywhere — a mistake can point
 *                                             in any direction
 *   progress    kept                          reset; they did not do it
 *
 * So this modal is deliberately not shaped like the delegate one. It is short,
 * it has an amber panel spelling out what comes off the task, its reason box is
 * REQUIRED (the server refuses an empty one — the person picking it up has
 * nothing else to go on), and it asks a `tone: 'warning'` confirm naming both
 * people before it fires.
 *
 * ITS PICKER IS NOT TEAM-RESTRICTED (`teamFirst={false}`). Every other picker in
 * the module opens on your own team, because work travels down or across. This
 * one opens on the whole company, because the assumption that the right person
 * is somewhere under you is exactly what produced the mis-assignment. The
 * server agrees: transferTask is the one operation that skips the direction
 * rule (the company wall still applies).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { FiX, FiUser, FiAlertTriangle, FiCornerUpRight } from 'react-icons/fi';
import PeoplePicker from './PeoplePicker';
import { confirmDialog } from '../dialogs';
import * as T from '../../api/tasks';
import { personName } from '../../utils/taskLifecycle';

export default function TransferModal({ task, meta, open, onClose, onDone }) {
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTo('');
    setReason('');
    setSaving(false);
  }, [open]);

  /** Whoever holds it now — the people about to come off it. */
  const holders = useMemo(
    () => (task?.assignees || [])
      .map((a) => a.name || personName(a.user))
      .filter(Boolean),
    [task]
  );

  // Everybody, minus the people who already have it. `canAssign` is deliberately
  // NOT consulted: a task that should have gone to a senior has to be able to
  // reach them, and refusing that would leave the wrong person holding it.
  const people = useMemo(() => {
    const onIt = new Set((task?.assignees || []).map((a) => String(a.user?._id || a.user)));
    return (meta?.people || []).filter((p) => !onIt.has(String(p._id)));
  }, [meta, task]);

  const target = people.find((p) => String(p._id) === String(to));
  const leaving = holders.length ? holders.join(', ') : 'Nobody';

  const submit = useCallback(async () => {
    if (!to) { toast.error('Choose who it should have gone to.'); return; }
    const said = reason.trim();
    if (!said) { toast.error('Say why it is moving.'); return; }

    const ok = await confirmDialog({
      title: 'Transfer this task?',
      message: `${leaving} will come off "${task.title}" completely, and ${target?.name || 'the new person'} will hold it as if it had been theirs from the start.`,
      details: [
        `${leaving} will stop seeing it and stop being notified about it.`,
        'Any progress reported so far is wiped — the new person starts at To do and has to accept it.',
        'They answer to whoever set the task. If you want it to come back to you, delegate it instead.',
      ],
      tone: 'warning',
      confirmText: 'Transfer it',
      cancelText: 'Leave it where it is',
    });
    if (!ok) return;

    setSaving(true);
    try {
      const res = await T.transferTask(task._id, to, said);
      toast.success(`Transferred to ${res.transferredTo?.name || target?.name || 'them'}.`);
      onDone?.(res);
      onClose?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not transfer that task.');
    } finally {
      setSaving(false);
    }
  }, [to, reason, leaving, target, task, onDone, onClose]);

  if (!open || !task) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="flex w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">Transfer this task</h2>
            <p className="mt-0.5 truncate text-xs text-gray-500">
              {task.code ? `${task.code} · ` : ''}{task.title}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[32px] min-w-[32px] rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Close"
          >
            <FiX size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {/* ── What this is, and what it is not ─────────────────── */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
              <FiAlertTriangle size={13} className="shrink-0" />
              This is not delegating — it hands the task over completely
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[11px] leading-relaxed text-amber-900 marker:text-amber-500">
              <li>
                <strong>{leaving}</strong> comes off the task. It leaves their list and they
                stop hearing about it.
              </li>
              <li>
                Any progress reported so far is <strong>reset</strong>. The new person starts
                at To do and has to accept it first.
              </li>
              <li>
                You do <strong>not</strong> become the approver — it goes on being signed off by
                whoever set it. To keep the outcome yours, use <strong>Delegate</strong> instead.
              </li>
              <li>
                A correction can point any way, so this is the one place the task can travel
                <em> up</em> the line as easily as down it.
              </li>
            </ul>
          </div>

          <PeoplePicker
            label="It should have gone to"
            icon={FiUser}
            people={people}
            value={to}
            onChange={setTo}
            max={1}
            // Not team-first — see the note at the top of this file.
            teamFirst={false}
            placeholder="Search anyone in the company…"
          />

          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500" htmlFor="transfer-reason">
              Why is it moving? <span className="text-red-500">*</span>
            </label>
            <textarea
              id="transfer-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="e.g. This is the accounts team's, not ours — it was raised against the wrong department."
              className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2 text-sm"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              Required. It is written into the task&apos;s history and is the only thing the
              person picking it up has to go on.
            </p>
          </div>
        </div>

        {/* ── Footer ───────────────────────────────────────────── */}
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] rounded-xl border border-gray-200 px-4 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !to || !reason.trim()}
            className="min-h-[40px] inline-flex items-center gap-2 rounded-xl bg-amber-600 px-5 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            <FiCornerUpRight size={14} />
            {saving ? 'Transferring…' : 'Transfer it'}
          </button>
        </div>
      </div>
    </div>
  );
}
