/**
 * The reminder bell on a task (2026-09-27) — the web twin of the app's
 * components/NudgeBell.
 *
 * The user: *"add a bell icon here if somebody wants to send a notification
 * again reminding whom the task has been assigned, in not accepted, in progress
 * and overdue — and in review, a bell from the assignee to the assigner to
 * review it"*, and *"a repeat reminder only after 30 mins of the previous one
 * for each task"*.
 *
 * WHO HAS A BELL, AND WHOM IT RINGS, is the server's answer (`task.can
 * .canNudge` / `nudgeTo`); so is the 30-minute gate. This draws it: a bell that
 * is waiting shows how long for ("25m") and counts down on its own, and a
 * press inside the gate says when it opens instead of sending.
 *
 * `override` is the moment THIS tab last rang it, so the countdown starts at
 * once instead of at the next fetch.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiBell } from 'react-icons/fi';
import * as T from '../../api/tasks';
import { nudgeState } from '../../utils/taskLifecycle';

const timeOf = (d) => new Date(d).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

export default function NudgeBell({ task, override = null, onNudged, labelled = false, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const state = nudgeState(task, override);

  // While the gate is shut, redraw every half minute so "25m" counts down.
  useEffect(() => {
    if (!state.can || !state.waitMin) return undefined;
    const id = setInterval(() => setTick((n) => n + 1), 30 * 1000);
    return () => clearInterval(id);
  }, [state.can, state.waitMin]);

  if (!state.can) return null;

  const review = state.to === 'approver';
  const waiting = state.waitMin > 0;
  const who = review ? 'the reviewer' : 'them';

  const ring = async (e) => {
    e?.stopPropagation?.();
    if (busy || disabled) return;
    if (waiting) {
      toast.info(`Reminder already sent — you can remind ${who} again at ${timeOf(state.readyAt)}.`);
      return;
    }
    setBusy(true);
    try {
      const res = await T.nudgeTask(task._id);
      toast.success(res?.message || 'Reminder sent.');
      onNudged?.(task._id, res?.nextAt ? new Date(res.nextAt) : new Date(Date.now() + 30 * 60000));
    } catch (err) {
      const data = err?.response?.data;
      if (err?.response?.status === 429 && data?.nextAt) {
        onNudged?.(task._id, new Date(data.nextAt));
        toast.info(data.message || `Try again at ${timeOf(data.nextAt)}.`);
      } else {
        toast.error(data?.message || 'Could not send the reminder.');
      }
    } finally {
      setBusy(false);
    }
  };

  const tone = waiting
    ? 'border-gray-200 bg-gray-50 text-gray-400'
    : review
      ? 'border-violet-200 bg-violet-50 text-violet-700'
      : 'border-amber-200 bg-amber-50 text-amber-700';
  const title = waiting
    ? `Reminder sent — you can remind ${who} again in ${state.waitMin} min`
    : (review ? 'Remind the reviewer to review it' : 'Send a reminder');

  if (labelled) {
    return (
      <button
        type="button"
        onClick={ring}
        disabled={busy || disabled}
        title={title}
        aria-label={title}
        className={`inline-flex items-center gap-2 rounded-xl border px-3.5 text-sm font-semibold transition min-h-[40px] disabled:opacity-60 ${tone}`}
      >
        <FiBell size={15} className={busy ? 'animate-pulse' : ''} />
        {waiting ? `Reminded · again in ${state.waitMin}m` : (review ? 'Remind to review' : 'Remind')}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={ring}
      disabled={busy || disabled}
      title={title}
      aria-label={title}
      className={`nudge-bell relative grid w-10 h-10 shrink-0 place-items-center rounded-xl border transition disabled:opacity-60 ${tone}`}
    >
      <FiBell size={16} className={busy ? 'animate-pulse' : ''} />
      {waiting && (
        <span className="pointer-events-none absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-md border border-gray-200 bg-white px-1 text-[9.5px] font-bold leading-4 tabular-nums text-gray-500">
          {state.waitMin}m
        </span>
      )}
    </button>
  );
}
