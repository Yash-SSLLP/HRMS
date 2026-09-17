/**
 * My Tasks — the employee side (section 42).
 *
 * The spec is explicit that the employee experience must stay simple:
 * "My Tasks → Open → Work → Submit". So this page is deliberately NOT the admin
 * board with a filter on it. It is a list of what is mine, grouped by how urgent
 * it is, with the one action each row actually needs on the row itself —
 * Accept, Start, Submit — so the common case never needs the detail page at all.
 *
 * Everything richer (the timeline, the evidence, the workflow, the extensions)
 * is one tap away on the same detail page the admin portal uses.
 *
 * THE GROUPS ARE THE POINT. Overdue first, then today, then this week, then the
 * rest, then what is waiting on somebody else. A flat list sorted by date makes
 * somebody scan for the urgent ones; grouping does the scanning for them.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { FiCheck, FiPlay, FiUpload, FiClock, FiChevronRight, FiInbox } from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { promptDialog } from '../components/dialogs';
import SubmitModal from '../components/task/SubmitModal';
import {
  StatusChip, PriorityChip, DueChip, ProgressBar, TaskMarks, StatTiles,
} from '../components/task/TaskChips';
import useViewOnly from '../hooks/useViewOnly';
import * as T from '../api/tasks';
import { formatMinutes, isOverdue, isTerminal } from '../utils/taskLifecycle';

const BASE = '/employee/tasks';

/** Which bucket a task falls in. Order here is the order on the page. */
const GROUPS = [
  ['overdue', 'Overdue', 'text-red-600'],
  ['today', 'Due today', 'text-amber-600'],
  ['week', 'This week', 'text-gray-700'],
  ['later', 'Later', 'text-gray-700'],
  ['waiting', 'Waiting on somebody else', 'text-gray-500'],
  ['done', 'Finished', 'text-gray-400'],
];

function groupOf(task) {
  if (isTerminal(task.status)) return 'done';
  if (['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'].includes(task.status)) return 'waiting';
  if (isOverdue(task)) return 'overdue';
  if (!task.dueDate) return 'later';
  const due = new Date(task.dueDate);
  const now = new Date();
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  if (due <= endOfToday) return 'today';
  if (due.getTime() - now.getTime() <= 7 * 86400000) return 'week';
  return 'later';
}

export default function EmployeeTasks() {
  const viewOnly = useViewOnly();
  const [tasks, setTasks] = useState([]);
  const [summary, setSummary] = useState(null);
  const [timer, setTimer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [acting, setActing] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [submitting, setSubmitting] = useState(null); // the task being submitted

  const load = useCallback(async (first = false) => {
    if (first) setLoading(true); else setRefreshing(true);
    setError('');
    try {
      const [list, sum, t] = await Promise.all([
        T.myTasks({ includeDone: showDone ? 'true' : 'false' }),
        T.mySummary().catch(() => null),
        T.myTimer().catch(() => ({ entry: null })),
      ]);
      setTasks(list.tasks);
      setSummary(sum);
      setTimer(t.entry || null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your tasks');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [showDone]);

  useEffect(() => { load(true); }, []);            // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loading) load(); }, [showDone]); // eslint-disable-line react-hooks/exhaustive-deps

  const grouped = useMemo(() => {
    const map = new Map(GROUPS.map(([k]) => [k, []]));
    for (const t of tasks) map.get(groupOf(t)).push(t);
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return new Date(a.dueDate) - new Date(b.dueDate);
      });
    }
    return map;
  }, [tasks]);

  const run = async (key, fn, successText) => {
    setActing(key);
    try {
      await fn();
      if (successText) toast.success(successText);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'That did not work');
    } finally {
      setActing('');
    }
  };

  /** The one action this row most needs, and nothing else. */
  const rowAction = (task) => {
    if (viewOnly) return null;
    if (task.status === 'ASSIGNED') {
      return {
        key: `accept-${task._id}`, label: 'Accept', icon: FiCheck,
        run: () => run(`accept-${task._id}`, async () => {
          const pos = (task.location?.captureOn || []).includes('accept') ? await T.currentPosition() : null;
          await T.acceptTask(task._id, pos ? { location: pos } : {});
        }, 'Accepted'),
      };
    }
    if (task.status === 'ACCEPTED') {
      return {
        key: `start-${task._id}`, label: 'Start', icon: FiPlay,
        run: () => run(`start-${task._id}`, async () => {
          const wants = (task.location?.captureOn || []).includes('start')
            || (task.location?.enforceOn || []).includes('start');
          const pos = wants ? await T.currentPosition() : null;
          await T.startTask(task._id, pos ? { location: pos } : {});
        }, 'Started'),
      };
    }
    if (['IN_PROGRESS', 'REJECTED'].includes(task.status)) {
      return {
        key: `submit-${task._id}`, label: 'Submit', icon: FiUpload,
        run: () => setSubmitting(task),
      };
    }
    return null;
  };

  const tiles = summary ? [
    { label: 'Open', value: summary.open },
    { label: 'Due today', value: summary.dueToday },
    { label: 'Overdue', value: summary.overdue, tone: 'danger' },
    { label: 'To accept', value: summary.awaitingAccept },
    { label: 'Completed', value: summary.completed, tone: 'good' },
    { label: 'Points earned', value: summary.incentive?.earned || 0, tone: 'good' },
  ] : [];

  return (
    <div>
      <PageHeader title="My Tasks">
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        <label className="inline-flex items-center gap-1.5 text-sm text-gray-600" style={{ minHeight: 40 }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300" />
          Show finished
        </label>
      </PageHeader>

      {summary && <StatTiles tiles={tiles} />}

      {/* A clock still running is easy to forget, and an eight-hour entry that
          nobody meant is worse than no entry. Say so at the top. */}
      {timer && timer.task && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
          <FiClock className="text-blue-600" size={15} />
          <span className="text-sm text-blue-900">
            Your clock is running on <strong>{timer.task.title}</strong>
            {timer.liveMinutes > 0 && <span> — {formatMinutes(timer.liveMinutes)} so far</span>}
          </span>
          <Link to={`${BASE}/${timer.task._id || timer.task}`}
            className="ml-auto text-sm text-blue-700 underline">Open</Link>
        </div>
      )}

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {loading ? (
        <div className="space-y-2">
          <div className="skeleton h-16 rounded-lg" />
          <div className="skeleton h-16 rounded-lg" />
          <div className="skeleton h-16 rounded-lg" />
        </div>
      ) : tasks.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 py-12 text-center">
          <FiInbox className="mx-auto text-gray-300 mb-2" size={32} />
          <p className="text-sm text-gray-500">Nothing is assigned to you right now.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {GROUPS.map(([key, label, tone]) => {
            const list = grouped.get(key) || [];
            if (!list.length) return null;
            return (
              <section key={key}>
                <h2 className={`text-sm font-medium mb-2 ${tone}`}>
                  {label} <span className="text-gray-400 tabular-nums">({list.length})</span>
                </h2>
                <div className="space-y-2">
                  {list.map((task) => {
                    const action = rowAction(task);
                    return (
                      <div key={task._id}
                        className={`bg-white rounded-lg border p-3 ${
                          key === 'overdue' ? 'border-red-200' : 'border-gray-200'}`}>
                        <div className="flex flex-wrap items-start gap-3">
                          <Link to={`${BASE}/${task._id}`} className="flex-1 min-w-[160px] group">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium text-gray-900 group-hover:underline">{task.title}</span>
                              <PriorityChip priority={task.priority} />
                              <StatusChip status={task.status} />
                            </div>
                            {task.description && (
                              <p className="mt-0.5 text-xs text-gray-500 line-clamp-2">{task.description}</p>
                            )}
                            <div className="mt-1.5 flex flex-wrap items-center gap-3">
                              <DueChip task={task} />
                              {task.project?.name && (
                                <span className="text-xs text-gray-400">{task.project.name}</span>
                              )}
                              <TaskMarks task={task} />
                            </div>
                          </Link>

                          <div className="flex items-center gap-2 shrink-0">
                            {action && (
                              <button type="button" onClick={action.run} disabled={acting === action.key}
                                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-60"
                                style={{ minHeight: 40 }}>
                                <action.icon size={14} />
                                {acting === action.key ? '…' : action.label}
                              </button>
                            )}
                            <Link to={`${BASE}/${task._id}`}
                              className="p-2 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-50"
                              aria-label="Open" style={{ minHeight: 40, minWidth: 40 }}>
                              <FiChevronRight size={16} />
                            </Link>
                          </div>
                        </div>

                        {task.progress > 0 && task.progress < 100 && (
                          <div className="mt-2"><ProgressBar value={task.progress} /></div>
                        )}

                        {/* A task sent back has to say WHY on the row — that is
                            the whole reason the person is looking at it again. */}
                        {task.status === 'REJECTED' && task.stateNote && (
                          <div className="mt-2 text-sm text-red-800 bg-red-50 border border-red-100 rounded px-2 py-1">
                            Sent back: {task.stateNote}
                          </div>
                        )}
                        {task.status === 'BLOCKED' && task.stateNote && (
                          <div className="mt-2 text-sm text-orange-800 bg-orange-50 border border-orange-100 rounded px-2 py-1">
                            Blocked: {task.stateNote}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {submitting && (
        <SubmitModal
          task={submitting}
          onClose={() => setSubmitting(null)}
          onSubmit={async (payload) => {
            await T.submitTask(submitting._id, payload);
            setSubmitting(null);
            toast.success('Submitted for review');
            await load();
          }}
        />
      )}
    </div>
  );
}
