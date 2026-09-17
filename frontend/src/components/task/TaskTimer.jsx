/**
 * The clock on a task (section 11).
 *
 * Start, pause, resume, stop — and while it runs, the figure ticks so somebody
 * can see it IS running. That matters more than it sounds: a timer that shows a
 * frozen number is indistinguishable from one that has stopped, and the whole
 * point of tracking time is that the figure means something.
 *
 * THE TICK IS LOCAL, THE FIGURE IS THE SERVER'S. The component counts seconds
 * off its own clock between actions, and every action returns the entry the
 * server measured — so a drifting browser clock can make the display a few
 * seconds out for a moment, and can never put a wrong figure into the record.
 *
 * ONE TIMER PER PERSON is enforced by the DATABASE (a partial unique index), so
 * this does not have to police it. What it does is render the refusal properly:
 * starting a second timer says which task the first one is on.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { FiPlay, FiPause, FiSquare, FiPlus } from 'react-icons/fi';
import { formatMinutes } from '../../utils/taskLifecycle';

/** Elapsed working seconds for an entry, as of now — the same sum the server makes. */
function liveSeconds(entry, now) {
  if (!entry || !entry.startedAt) return 0;
  const start = new Date(entry.startedAt).getTime();
  const end = entry.endedAt ? new Date(entry.endedAt).getTime() : now;
  let breakMs = 0;
  for (const p of entry.pauses || []) {
    if (!p || !p.at) continue;
    const from = new Date(p.at).getTime();
    const to = p.until ? new Date(p.until).getTime() : Math.min(end, now);
    if (to > from) breakMs += to - from;
  }
  return Math.max(0, Math.floor((end - start - breakMs) / 1000));
}

/** "01:23:45" — a running clock reads better as a clock than as "83m". */
function clock(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * @param {object} props
 * @param {object} props.task
 * @param {object|null} props.entry - the running/paused entry on THIS task, if any
 * @param {object|null} props.elsewhere - a running entry on a DIFFERENT task
 * @param {(action:string) => Promise<void>} props.onAction - 'start'|'pause'|'resume'|'stop'
 * @param {() => void} [props.onManual] - open the "record time already worked" form
 * @param {boolean} [props.disabled] - the task is in a state the clock does not run in
 * @param {number} [props.totalMinutes] - what has been logged in total
 */
export default function TaskTimer({
  task, entry, elsewhere, onAction, onManual, disabled, totalMinutes = 0,
}) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState('');
  const timer = useRef(null);

  const running = entry && entry.status === 'running';
  const paused = entry && entry.status === 'paused';

  // Tick only while something is actually running. A paused entry's figure is
  // frozen by definition, and an interval running against a stopped clock is a
  // re-render a second for nothing.
  useEffect(() => {
    if (!running) { clearInterval(timer.current); return undefined; }
    timer.current = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer.current);
  }, [running]);

  const seconds = useMemo(() => liveSeconds(entry, now), [entry, now]);

  const act = async (action) => {
    setBusy(action);
    try { await onAction(action); } finally { setBusy(''); }
  };

  const Btn = ({ onClick, icon: Icon, label, tone = 'default', name }) => (
    <button type="button" onClick={onClick} disabled={!!busy || disabled}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg disabled:opacity-50 ${
        tone === 'primary' ? 'bg-gray-900 text-white hover:bg-gray-700' : 'border border-gray-300 hover:bg-gray-50'}`}
      style={{ minHeight: 40 }}>
      <Icon size={14} />
      {busy === name ? '…' : label}
    </button>
  );

  return (
    <div className="rounded-lg border border-gray-200 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[120px]">
          <div className={`text-2xl font-semibold tabular-nums ${running ? 'text-gray-900' : 'text-gray-400'}`}>
            {entry ? clock(seconds) : '00:00:00'}
          </div>
          <div className="text-xs text-gray-500">
            {running ? 'Running' : paused ? 'Paused' : 'Not running'}
            {totalMinutes > 0 && <span> · {formatMinutes(totalMinutes)} logged in total</span>}
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {!entry && (
            <Btn name="start" onClick={() => act('start')} icon={FiPlay} label="Start" tone="primary" />
          )}
          {running && (
            <>
              <Btn name="pause" onClick={() => act('pause')} icon={FiPause} label="Pause" />
              <Btn name="stop" onClick={() => act('stop')} icon={FiSquare} label="Stop" tone="primary" />
            </>
          )}
          {paused && (
            <>
              <Btn name="resume" onClick={() => act('resume')} icon={FiPlay} label="Resume" tone="primary" />
              <Btn name="stop" onClick={() => act('stop')} icon={FiSquare} label="Stop" />
            </>
          )}
          {onManual && (
            <button type="button" onClick={onManual}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-gray-300 hover:bg-gray-50"
              style={{ minHeight: 40 }}>
              <FiPlus size={14} /> Add time
            </button>
          )}
        </div>
      </div>

      {/* A pause is part of one stretch of work, not a second entry — worth
          saying once, where somebody is about to press it. */}
      {paused && (
        <p className="mt-2 text-xs text-gray-400">
          The break comes off this stretch; stopping records the working time, not the elapsed time.
        </p>
      )}

      {elsewhere && !entry && (
        <p className="mt-2 text-xs text-amber-600">
          Your clock is already running on &quot;{elsewhere.task?.title || 'another task'}&quot;. Stop it there first.
        </p>
      )}

      {disabled && !entry && (
        <p className="mt-2 text-xs text-gray-400">
          The clock does not run on a task in this state.
        </p>
      )}
    </div>
  );
}
