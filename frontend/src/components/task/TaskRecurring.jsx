/**
 * The Recurring tab (2026-09-27).
 *
 * The user: *"need a separate tab for recurring tasks, only to assign; after
 * assigned it will show them in their task tab"*. So this lists SCHEDULES, not
 * tasks. Each occurrence is an ordinary task that lands in the doer's Tasks
 * list when it is due to appear — 9 am on its day, a monthly one two days
 * early — and is worked there like any other.
 *
 * You see the schedules you set; a tasks.manage holder can switch to
 * everybody's. A schedule can be paused and resumed (nothing is back-filled for
 * the pause — the server moves `mintFrom`), edited, or stopped.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiRepeat, FiUser, FiArrowRight, FiCalendar, FiBell, FiEdit2, FiCheckCircle, FiTrash2,
} from 'react-icons/fi';
import ToggleSwitch from '../ToggleSwitch';
import { confirmDialog } from '../dialogs';
import * as T from '../../api/tasks';
import { useAuthStore } from '../../store/authStore';
import { patternLabel, reminderLabel, statusLabel, PRIORITY_CHIPS } from '../../utils/taskLifecycle';

const whenText = (d) => {
  if (!d) return '';
  const when = new Date(d);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  const time = when.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });
  if (same(when, today)) return `Today, ${time}`;
  if (same(when, tomorrow)) return `Tomorrow, ${time}`;
  return `${when.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}, ${time}`;
};

// Adding one is the Tasks page's floating button (2026-09-27 — the same one the
// Tasks tab has), not a button of this tab's own.
// `showIntro`: the one-line explainer. The Recurring Tasks page (2026-09-28)
// says it in its own header, so it switches this one off.
export default function TaskRecurring({
  viewOnly = false, isAdmin = false, onEdit, refreshKey = 0,
}) {
  const me = useAuthStore((s) => s.user?._id);
  const [rows, setRows] = useState(null);
  const [scope, setScope] = useState('mine');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await T.listRecurring(scope === 'all' ? {} : { scope: 'mine' });
      setRows(data.schedules || []);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not load the recurring tasks.');
      setRows((r) => r || []);
    }
  }, [scope]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const toggle = async (row) => {
    setBusy(row._id);
    try {
      const { schedule } = await T.updateRecurring(row._id, { isActive: !row.isActive });
      setRows((list) => (list || []).map((r) => (r._id === row._id ? { ...r, ...schedule } : r)));
      toast.success(schedule?.isActive
        ? 'Resumed — it picks up from the next one. Nothing missed is sent.'
        : 'Paused — no more will be raised until you resume it.');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not change that.');
    } finally {
      setBusy('');
    }
  };

  // DELETE (2026-09-30, user: "in recurring task give an option to delete any
  // task"): stopped AND gone from this list for good. Unlike the pause switch, it cannot be
  // switched back on — hence the stronger confirm.
  const remove = async (row) => {
    const ok = await confirmDialog({
      title: 'Delete this recurring task?',
      message: `"${row.title}" will be deleted and never raised again.`,
      details: [
        'It disappears from this list for good — it cannot be switched back on.',
        'Tasks it already put in people’s lists stay, with their history.',
      ],
      confirmText: 'Delete it',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await T.removeRecurring(row._id);
      setRows((list) => (list || []).filter((r) => r._id !== row._id));
      toast.success('Deleted.');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not delete it.');
    }
  };

  return (
    <div className="space-y-4">
      <div className={`flex flex-wrap items-center justify-end gap-3 ${!isAdmin ? 'hidden' : ''}`}>
        {isAdmin && (
          <div className="inline-flex rounded-xl border border-gray-200 bg-gray-50 p-1" role="tablist">
            {[['mine', 'Set by me'], ['all', 'Everyone’s']].map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={scope === k}
                onClick={() => setScope(k)}
                className={`rounded-lg border px-3 text-xs font-semibold transition min-h-[32px] ${
                  scope === k ? 'border-gray-200 bg-white text-gray-900 shadow-sm' : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {rows === null ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {[0, 1].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-gray-100" />)}
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gray-100 text-gray-500">
            <FiRepeat size={20} />
          </span>
          <p className="font-semibold text-gray-800">No recurring tasks yet</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {rows.map((r) => {
            const who = r.who || (r.assignees || []).map((u) => [u.firstName, u.lastName].filter(Boolean).join(' ')).join(', ');
            // BOTH SIDES, the way every task row reads (TaskRow): who set it —
            // "you", or on "Everyone's" the manager whose schedule it is — and
            // who it is for. Set in somebody's name: who sent it, too.
            const byMe = Boolean(me) && String(r.createdBy?._id || r.createdBy || '') === String(me);
            const onlyMe = byMe && (r.assignees || []).length === 1
              && String(r.assignees[0]?._id || r.assignees[0]) === String(me);
            const setBy = byMe ? 'you' : (r.createdByName || '—');
            const sentById = String(r.onBehalf?.by?._id || r.onBehalf?.by || '');
            const sentBy = sentById ? (sentById === String(me) ? 'you' : (r.onBehalf.byName || '')) : '';
            const future = r.next && new Date(r.next.appearAt) > new Date();
            return (
              <div
                key={r._id}
                className={`flex flex-col gap-3 rounded-2xl border p-4 shadow-sm transition ${
                  r.isActive ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="flex items-start gap-3">
                  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${r.isActive ? 'accent-bg on-accent' : 'bg-gray-100 text-gray-400'}`}>
                    <FiRepeat size={17} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-semibold text-gray-900">{r.title}</p>
                    <p className="mt-0.5 text-xs font-semibold text-gray-500">{r.patternLabel || patternLabel(r)}</p>
                  </div>
                  {!viewOnly && (
                    <ToggleSwitch
                      checked={Boolean(r.isActive)}
                      onChange={() => toggle(r)}
                      busy={busy === r._id}
                      label={r.isActive ? 'Pause it' : 'Resume it'}
                      title={r.isActive ? 'On — pause it' : 'Paused — resume it'}
                      size="sm"
                    />
                  )}
                </div>

                <div className="space-y-1.5 text-xs text-gray-600">
                  <p className="flex items-start gap-2">
                    <FiUser size={13} className="mt-0.5 shrink-0 text-gray-400" />
                    {onlyMe ? (
                      <span className="min-w-0 break-words">Your own task</span>
                    ) : (
                      <span className="min-w-0 break-words">
                        <span className="text-gray-400">By </span>
                        <span className="font-medium text-gray-700">{setBy}</span>
                        {sentBy && <span className="text-gray-400"> (sent by {sentBy})</span>}
                        <FiArrowRight size={11} className="mx-1.5 inline-block align-[-1px] text-gray-400" />
                        <span className="text-gray-400">To </span>
                        <span className="font-medium text-gray-700">{who || '—'}</span>
                      </span>
                    )}
                  </p>
                  <p className="flex items-start gap-2">
                    <FiCalendar size={13} className="mt-0.5 shrink-0 text-gray-400" />
                    {r.isActive && r.next ? (
                      <span>
                        Next due <span className="font-semibold text-gray-800">{whenText(r.next.dueAt)}</span>
                        {future && <span className="text-gray-400"> · appears {whenText(r.next.appearAt)}</span>}
                      </span>
                    ) : (
                      <span className="text-gray-400">{r.isActive ? 'Nothing more to raise — it has ended.' : 'Paused — nothing is being raised.'}</span>
                    )}
                  </p>
                  {(r.reminders || []).length > 0 && (
                    <p className="flex items-start gap-2">
                      <FiBell size={13} className="mt-0.5 shrink-0 text-gray-400" />
                      <span>{(r.reminderLabels || r.reminders.map(reminderLabel)).join(' · ')}</span>
                    </p>
                  )}
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
                  <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${PRIORITY_CHIPS[r.priority] || PRIORITY_CHIPS.Medium}`}>
                    {r.priority}
                  </span>
                  {r.routine && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
                      <FiCheckCircle size={11} /> Mark done only
                    </span>
                  )}
                  {r.stats?.raised > 0 && (
                    <span className="text-[11px] text-gray-400">
                      {r.stats.raised} raised · {r.stats.open} open · {r.stats.done} done
                      {r.stats.last ? ` · latest ${r.stats.last.code || ''} ${statusLabel(r.stats.last.status).toLowerCase()}` : ''}
                    </span>
                  )}
                  {!viewOnly && (
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => onEdit?.(r)}
                        className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 text-xs font-semibold text-gray-700 transition hover:border-gray-300 min-h-[36px]"
                      >
                        <FiEdit2 size={13} /> Edit
                      </button>
                      {/* No Stop button (2026-10-02, the user: "remove these button as it
                          extra") — the switch pauses a schedule, Delete ends it. */}
                      <button
                        type="button"
                        onClick={() => remove(r)}
                        title="Delete this recurring task"
                        className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 text-xs font-semibold text-red-600 transition hover:bg-red-50 min-h-[36px]"
                      >
                        <FiTrash2 size={13} /> Delete
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
