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
  FiPlus, FiRepeat, FiUser, FiArrowRight, FiCalendar, FiBell, FiEdit2, FiStopCircle, FiCheckCircle,
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

export default function TaskRecurring({ viewOnly = false, isAdmin = false, onNew, onEdit, refreshKey = 0 }) {
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

  const stop = async (row) => {
    const ok = await confirmDialog({
      title: 'Stop this recurring task?',
      message: `"${row.title}" will not be raised again.`,
      details: ['The ones already in people’s lists stay, and so does their history.'],
      confirmText: 'Stop it',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await T.deleteRecurring(row._id);
      setRows((list) => (list || []).map((r) => (r._id === row._id ? { ...r, isActive: false, next: null } : r)));
      toast.success('Stopped.');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not stop it.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {!viewOnly && (
          <button
            type="button"
            onClick={onNew}
            className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-green-700 min-h-[40px]"
          >
            <FiPlus size={16} /> New recurring task
          </button>
        )}
        <p className="min-w-0 flex-1 text-xs text-gray-500">
          Set it up once — each time it comes round it lands in their Tasks on its own. Daily ones are only marked done.
        </p>
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
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
            The daily cash count, Friday’s report, the month-end stock take — set it up once, and each one lands in
            their Tasks when it comes round.
          </p>
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
                      {r.isActive && (
                        <button
                          type="button"
                          onClick={() => stop(r)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-red-200 bg-white px-3 text-xs font-semibold text-red-600 transition hover:bg-red-50 min-h-[36px]"
                        >
                          <FiStopCircle size={13} /> Stop
                        </button>
                      )}
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
