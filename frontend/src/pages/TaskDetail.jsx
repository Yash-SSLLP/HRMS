/**
 * One task, in full (section 41).
 *
 * ONE PAGE, BOTH PORTALS. The same task is reachable from the admin board and
 * from My Tasks, and it is the same page in both — mounted at two routes, told
 * which portal it is in by `base`. Two copies would be two places to fix
 * everything, and the difference between them is genuinely only which tabs
 * there is any point showing.
 *
 * WHAT YOU SEE IS WHAT YOU MAY DO. The server returns `can` and `transitions`
 * alongside the task — what THIS person may do with it right now — and the
 * buttons are drawn from that rather than from the client re-deriving the rules.
 * That is what stops a button appearing that the server then refuses, and it
 * means a permission change on the server needs no change here.
 *
 * Built around the timeline, as the spec asks: the header says where the task
 * is, the rail says what is still ahead, and the Activity tab says what has
 * already happened. Sections the reader has no business in are simply not shown.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  FiArrowLeft, FiCheck, FiX, FiPlay, FiUpload, FiClock, FiPaperclip,
  FiMessageSquare, FiCalendar, FiAward, FiMapPin, FiUsers, FiList,
  FiGitBranch, FiActivity, FiRepeat, FiAlertTriangle, FiDownload, FiPlus,
} from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import WorkflowRail from '../components/task/WorkflowRail';
import TaskTimeline from '../components/task/TaskTimeline';
import TaskTimer from '../components/task/TaskTimer';
import SubmitModal from '../components/task/SubmitModal';
import { StatusChip, PriorityChip, DueChip, ProgressBar } from '../components/task/TaskChips';
import useViewOnly from '../hooks/useViewOnly';
import { useAuthStore } from '../store/authStore';
import * as T from '../api/tasks';
import { formatDateTime12 } from '../utils/time';
import {
  statusLabel, formatMinutes, personName, isOverdue, INCENTIVE_OUTCOME_LABELS,
} from '../utils/taskLifecycle';
import api from '../api/client';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
}) : '—');

/**
 * @param {object} props
 * @param {string} [props.base] - '/admin/tasks' or '/employee/tasks'
 */
export default function TaskDetail({ base = '/admin/tasks' }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const viewOnly = useViewOnly();
  const me = useAuthStore((s) => s.user);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('overview');
  const [acting, setActing] = useState('');
  const [showSubmit, setShowSubmit] = useState(false);
  const [comment, setComment] = useState('');
  const [commentFiles, setCommentFiles] = useState([]);
  const [internal, setInternal] = useState(false);
  const [timer, setTimer] = useState(null);

  /**
   * Reload.
   *
   * The FIRST load blanks the page; every later one keeps what is on screen and
   * just marks it stale. Setting `loading` again swapped the whole page for a
   * skeleton after every action, which threw the reader back to the top — the
   * same refetch-collapse this portal has already fixed elsewhere.
   */
  const load = useCallback(async (first = false) => {
    if (first) setLoading(true); else setRefreshing(true);
    setError('');
    try {
      const [detail, mine] = await Promise.all([
        T.getTask(id),
        T.myTimer().catch(() => ({ entry: null })),
      ]);
      setData(detail);
      setTimer(mine.entry || null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load this task');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);

  useEffect(() => { load(true); }, [load]);

  const task = data?.task;
  const can = data?.can || {};

  /** Run an action, reload, and turn any refusal into a toast the person can read. */
  const run = useCallback(async (name, fn, successText) => {
    setActing(name);
    try {
      await fn();
      if (successText) toast.success(successText);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'That did not work');
    } finally {
      setActing('');
    }
  }, [load]);

  // The timer entry that belongs to THIS task, as against one running elsewhere.
  const myEntryHere = useMemo(() => {
    if (!timer) return null;
    const timerTaskId = String(timer.task?._id || timer.task || '');
    return timerTaskId === String(id) ? timer : null;
  }, [timer, id]);

  const timerElsewhere = timer && !myEntryHere ? timer : null;

  const tabs = useMemo(() => {
    if (!task) return [];
    const list = [['overview', 'Overview', FiList]];
    if ((data.workflow || []).length) list.push(['workflow', 'Workflow', FiGitBranch]);
    if ((task.assignees || []).length > 1) list.push(['people', 'Assignees', FiUsers]);
    if ((task.checklist || []).length) list.push(['checklist', 'Checklist', FiCheck]);
    if (can.work || can.review || can.manage) list.push(['time', 'Time', FiClock]);
    if ((data.submissions || []).length) list.push(['submissions', 'Submissions', FiUpload]);
    list.push(['comments', `Comments${task.commentCount ? ` (${task.commentCount})` : ''}`, FiMessageSquare]);
    if ((task.attachments || []).length) list.push(['files', 'Files', FiPaperclip]);
    if ((data.extensions || []).length || can.work) list.push(['extensions', 'Extensions', FiCalendar]);
    if (task.incentive?.enabled) list.push(['incentive', 'Incentive', FiAward]);
    if ((task.location?.captured || []).length) list.push(['location', 'Location', FiMapPin]);
    if ((data.subtasks || []).length) list.push(['subtasks', 'Subtasks', FiList]);
    list.push(['activity', 'Activity', FiActivity]);
    return list;
  }, [task, data, can]);

  if (loading) {
    return (
      <div>
        <PageHeader title="Task" />
        <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-3">
          <div className="skeleton h-6 rounded w-1/3" />
          <div className="skeleton h-4 rounded w-2/3" />
          <div className="skeleton h-4 rounded w-1/2" />
        </div>
      </div>
    );
  }

  if (error || !task) {
    return (
      <div>
        <PageHeader title="Task" />
        <div className="bg-white rounded-lg border border-gray-200 p-6 text-center">
          <p className="text-sm text-gray-600">{error || 'That task does not exist.'}</p>
          <Link to={base} className="mt-3 inline-block text-sm text-blue-600 hover:underline">Back to tasks</Link>
        </div>
      </div>
    );
  }

  // ===== the actions bar =====
  const actions = [];
  if (!viewOnly) {
    if (can.work && task.status === 'ASSIGNED') {
      actions.push({
        key: 'accept', label: 'Accept', icon: FiCheck, primary: true,
        run: () => run('accept', async () => {
          const pos = (task.location?.captureOn || []).includes('accept') ? await T.currentPosition() : null;
          await T.acceptTask(id, pos ? { location: pos } : {});
        }, 'Task accepted'),
      });
      actions.push({
        key: 'decline', label: 'Decline', icon: FiX,
        run: async () => {
          const reason = await promptDialog({
            message: 'Why can you not take this task on?',
            placeholder: 'Your reason — the person who set it will see this',
            confirmText: 'Decline task',
          });
          if (!reason) return;
          await run('decline', () => T.declineTask(id, reason), 'Task declined');
        },
      });
    }

    if (can.work && ['ASSIGNED', 'ACCEPTED', 'REJECTED', 'BLOCKED'].includes(task.status)) {
      actions.push({
        key: 'start', label: task.status === 'REJECTED' ? 'Work on it again' : 'Start', icon: FiPlay, primary: true,
        run: () => run('start', async () => {
          const wantsPos = (task.location?.captureOn || []).includes('start')
            || (task.location?.enforceOn || []).includes('start');
          const pos = wantsPos ? await T.currentPosition() : null;
          await T.startTask(id, pos ? { location: pos } : {});
        }, 'Started'),
      });
    }

    if (can.work && ['ACCEPTED', 'IN_PROGRESS', 'REJECTED'].includes(task.status)) {
      actions.push({
        key: 'submit', label: 'Submit', icon: FiUpload, primary: true,
        run: () => setShowSubmit(true),
      });
    }

    if (can.review && ['SUBMITTED', 'UNDER_REVIEW'].includes(task.status)) {
      actions.push({
        key: 'approve', label: 'Approve', icon: FiCheck, primary: true,
        run: async () => {
          const note = await promptDialog({
            message: 'Approve this task?', placeholder: 'Remark (optional)',
            confirmText: 'Approve',
          });
          if (note === null) return;
          await run('approve', () => T.approveTask(id, { note }), 'Approved');
        },
      });
      actions.push({
        key: 'reject', label: 'Send back', icon: FiX,
        run: async () => {
          const note = await promptDialog({
            message: 'What needs changing?',
            placeholder: 'The assignee will see this',
            confirmText: 'Send back',
          });
          if (!note) return;
          await run('reject', () => T.rejectTask(id, note), 'Sent back');
        },
      });
    }
  }

  // Anything else the server says this person may do, that is not already a
  // button above. Drawn from `transitions`, so the list is the server's answer
  // and not a second copy of the rules.
  const shown = new Set(['ACCEPTED', 'DECLINED', 'IN_PROGRESS', 'SUBMITTED', 'APPROVED', 'REJECTED']);
  const extraMoves = viewOnly ? [] : (data.transitions || []).filter((t) => !shown.has(t.to));

  return (
    <div>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <button type="button" onClick={() => navigate(base)}
              className="text-gray-400 hover:text-gray-700" aria-label="Back">
              <FiArrowLeft size={18} />
            </button>
            {task.title}
          </span>
        }
        subtitle={[task.code, task.taskType, task.department].filter(Boolean).join(' · ')}
      >
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        {actions.map((a) => (
          <button key={a.key} type="button" onClick={a.run} disabled={!!acting}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg disabled:opacity-60 ${
              a.primary ? 'bg-gray-900 text-white hover:bg-gray-700' : 'border border-gray-300 hover:bg-gray-50'}`}
            style={{ minHeight: 40 }}>
            <a.icon size={14} />
            {acting === a.key ? '…' : a.label}
          </button>
        ))}
        {extraMoves.length > 0 && (
          <select value="" disabled={!!acting}
            onChange={async (e) => {
              const move = extraMoves.find((m) => m.to === e.target.value);
              if (!move) return;
              let note = '';
              if (move.needsReason) {
                note = await promptDialog({
                  message: `Why is this task being marked ${move.label.toLowerCase()}?`,
                  confirmText: move.label,
                });
                if (!note) return;
              }
              await run('move', () => T.changeStatus(id, move.to, note), `Marked ${move.label.toLowerCase()}`);
            }}
            className="border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }}>
            <option value="">More…</option>
            {extraMoves.map((m) => <option key={m.to} value={m.to}>{m.label}</option>)}
          </select>
        )}
      </PageHeader>

      {/* ===== the header card ===== */}
      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <StatusChip status={task.status} />
          <PriorityChip priority={task.priority} always />
          {isOverdue(task) && (
            <span className="inline-flex items-center gap-1 text-xs text-red-600 font-medium">
              <FiAlertTriangle size={12} /> Overdue
            </span>
          )}
          {task.extensionCount > 0 && (
            <span className="text-xs text-gray-400">
              {task.extensionCount} extension{task.extensionCount === 1 ? '' : 's'}
            </span>
          )}
          {task.rejectionCount > 0 && (
            <span className="text-xs text-amber-600">
              sent back {task.rejectionCount}×
            </span>
          )}
        </div>

        <div className="mb-3"><ProgressBar value={task.progress} /></div>

        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-sm">
          <div>
            <dt className="text-xs text-gray-500">Assigned to</dt>
            <dd className="text-gray-900">
              {(task.assignees || []).map((a) => personName(a.user) || a.name).filter(Boolean).join(', ') || '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Supervisor</dt>
            <dd className="text-gray-900">{personName(task.supervisor) || '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Due</dt>
            <dd className="text-gray-900">
              {task.dueDate ? formatDateTime12(task.dueDate) : '—'}
              {/* An extension moved the deadline; the ORIGINAL is never deleted,
                  so it is shown rather than quietly replaced. */}
              {task.originalDueDate && task.dueDate
                && new Date(task.originalDueDate).getTime() !== new Date(task.dueDate).getTime() && (
                <span className="block text-xs text-gray-400 line-through">
                  was {fmtDate(task.originalDueDate)}
                </span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-gray-500">Time logged</dt>
            <dd className="text-gray-900">
              {formatMinutes(task.minutesLogged)}
              {task.estimatedMinutes > 0 && (
                <span className="text-gray-400"> of {formatMinutes(task.estimatedMinutes)}</span>
              )}
            </dd>
          </div>
        </dl>

        {task.stateNote && (
          <div className="mt-3 text-sm text-gray-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {task.stateNote}
          </div>
        )}

        {(data.blockers || []).length > 0 && (
          <div className="mt-3 text-sm text-orange-800 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2">
            Waiting on {data.blockers.map((b) => `"${b.title}"`).join(', ')} — this task cannot start until
            {data.blockers.length === 1 ? ' it is' : ' they are'} done.
          </div>
        )}
      </div>

      {/* ===== tabs ===== */}
      <div className="topbar-scroll flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
        {tabs.map(([key, label, Icon]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
              tab === key ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            style={{ minHeight: 40 }}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4">
        {tab === 'overview' && (
          <div className="space-y-4">
            {task.description ? (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{task.description}</p>
            ) : (
              <p className="text-sm text-gray-400">No description.</p>
            )}

            {(data.requirements || []).length > 0 && (
              <div>
                <div className="text-xs font-medium text-gray-500 mb-1">Submission must carry</div>
                <div className="flex flex-wrap gap-2">
                  {data.requirements.map((r) => (
                    <span key={r.key} className="inline-flex items-center rounded-lg bg-gray-100 text-gray-700 px-2 py-0.5 text-xs"
                      style={{ minHeight: 22 }}>
                      {r.label}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {(task.customFields || []).length > 0 && (
              <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                {task.customFields.map((f) => (
                  <div key={f.key}>
                    <dt className="text-xs text-gray-500">{f.label || f.key}</dt>
                    <dd className="text-gray-900">{f.value == null || f.value === '' ? '—' : String(f.value)}</dd>
                  </div>
                ))}
              </dl>
            )}

            {(task.tags || []).length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {task.tags.map((t) => (
                  <span key={t} className="inline-flex items-center rounded-lg bg-gray-100 text-gray-600 px-2 py-0.5 text-xs"
                    style={{ minHeight: 22 }}>#{t}</span>
                ))}
              </div>
            )}

            <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm pt-3 border-t border-gray-100">
              <div><dt className="text-xs text-gray-500">Set by</dt><dd>{personName(task.createdBy) || '—'}</dd></div>
              <div><dt className="text-xs text-gray-500">Started</dt><dd>{task.startedAt ? formatDateTime12(task.startedAt) : '—'}</dd></div>
              <div><dt className="text-xs text-gray-500">Submitted</dt><dd>{task.submittedAt ? formatDateTime12(task.submittedAt) : '—'}</dd></div>
              <div><dt className="text-xs text-gray-500">Completed</dt><dd>{task.completedAt ? formatDateTime12(task.completedAt) : '—'}</dd></div>
            </dl>
          </div>
        )}

        {tab === 'workflow' && (
          <WorkflowRail
            steps={data.workflow}
            name={task.workflowName}
            version={task.workflowVersion}
            deciding={acting === 'step'}
            canDecide={(step) => !viewOnly && step.status === 'Pending'
              && (step.actors || []).some((a) => String(a.user) === String(me?._id) && !a.decision)}
            onDecide={async (step, decision) => {
              const note = await promptDialog({
                message: decision === 'approved' ? `Approve "${step.name}"?` : `Reject "${step.name}"?`,
                placeholder: decision === 'rejected' ? 'Say why' : 'Remark (optional)',
                confirmText: decision === 'approved' ? 'Approve' : 'Reject',
              });
              if (decision === 'rejected' && !note) return;
              if (note === null) return;
              await run('step', () => T.decideStep(id, step.key, decision, note), 'Recorded');
            }}
          />
        )}

        {tab === 'people' && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Person</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Role</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Their part</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Status</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Progress</th>
                  <th className="px-3 py-2 text-left font-medium text-gray-700">Time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(task.assignees || []).map((a) => (
                  <tr key={String(a._id || a.user?._id || a.user)}>
                    <td className="px-3 py-2 font-medium text-gray-900">{personName(a.user) || a.name}</td>
                    <td className="px-3 py-2 text-gray-600">{a.role}</td>
                    <td className="px-3 py-2 text-gray-600">{a.responsibility || '—'}</td>
                    <td className="px-3 py-2"><StatusChip status={a.status} /></td>
                    <td className="px-3 py-2 w-32"><ProgressBar value={a.progress} /></td>
                    <td className="px-3 py-2 text-gray-600 tabular-nums">{formatMinutes(a.minutesLogged)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'checklist' && (
          <ul className="space-y-1.5">
            {(task.checklist || []).map((item) => (
              <li key={item._id} className="flex items-start gap-2">
                <input type="checkbox" checked={!!item.done}
                  disabled={viewOnly || !(can.work || can.manage)}
                  onChange={(e) => run('check', () => T.setChecklistItem(id, item._id, e.target.checked))}
                  className="mt-1 h-4 w-4 rounded border-gray-300" />
                <span className="flex-1">
                  <span className={`text-sm ${item.done ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                    {item.text}
                  </span>
                  {item.mandatory === false && <span className="ml-2 text-xs text-gray-400">optional</span>}
                  {item.done && item.doneByName && (
                    <span className="block text-xs text-gray-400">
                      {item.doneByName} · {formatDateTime12(item.doneAt)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {tab === 'time' && (
          <div className="space-y-4">
            {can.work && !viewOnly && (
              <TaskTimer
                task={task}
                entry={myEntryHere}
                elsewhere={timerElsewhere}
                totalMinutes={task.minutesLogged}
                disabled={!['ACCEPTED', 'IN_PROGRESS', 'REJECTED'].includes(task.status)}
                onAction={async (action) => {
                  try {
                    if (action === 'start') await T.startTimer(id);
                    else await T.timerAction(id, action);
                    await load();
                  } catch (err) {
                    toast.error(err.response?.data?.message || 'The timer did not move');
                    throw err;
                  }
                }}
                onManual={async () => {
                  const mins = await promptDialog({
                    message: 'How many minutes did you work?',
                    placeholder: 'e.g. 90',
                    confirmText: 'Record',
                  });
                  if (!mins) return;
                  const when = new Date(Date.now() - Number(mins) * 60000).toISOString();
                  await run('manual', () => T.addManualTime(id, {
                    startedAt: when, minutes: Number(mins),
                  }), 'Time recorded');
                }}
              />
            )}

            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Person</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Started</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Worked</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Break</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">How</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Approval</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(data.timeEntries || []).length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-gray-500">No time logged yet.</td></tr>
                  ) : data.timeEntries.map((e) => (
                    <tr key={e._id}>
                      <td className="px-3 py-2">{e.userName || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{formatDateTime12(e.startedAt)}</td>
                      <td className="px-3 py-2 tabular-nums">{formatMinutes(e.activeMinutes)}</td>
                      <td className="px-3 py-2 tabular-nums text-gray-500">{e.breakMinutes ? formatMinutes(e.breakMinutes) : '—'}</td>
                      <td className="px-3 py-2 text-gray-500">{e.source}</td>
                      <td className="px-3 py-2">
                        {!e.approvalStatus ? <span className="text-gray-400">—</span>
                          : e.approvalStatus === 'Pending' && can.review && !viewOnly ? (
                            <span className="flex gap-1">
                              <button type="button" onClick={() => run('timeok', () => T.decideTimeEntry(e._id, 'approve'), 'Approved')}
                                className="text-xs px-2 py-1 rounded border border-gray-300 hover:bg-gray-50" style={{ minHeight: 30 }}>
                                Approve
                              </button>
                              <button type="button" onClick={() => run('timeno', () => T.decideTimeEntry(e._id, 'reject'), 'Rejected')}
                                className="text-xs px-2 py-1 rounded border border-red-200 text-red-700 hover:bg-red-50" style={{ minHeight: 30 }}>
                                Reject
                              </button>
                            </span>
                          ) : <span className="text-xs text-gray-600">{e.approvalStatus}</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'submissions' && (
          <div className="space-y-3">
            {(data.submissions || []).map((s) => (
              <div key={s._id} className="border border-gray-200 rounded-lg p-3">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-900">{s.submittedByName}</span>
                  <span className="text-xs text-gray-400">attempt {s.attempt}</span>
                  <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-xs ${
                    s.status === 'Approved' ? 'bg-green-100 text-green-800'
                      : s.status === 'Rejected' ? 'bg-red-100 text-red-800'
                        : 'bg-amber-100 text-amber-800'}`} style={{ minHeight: 22 }}>
                    {s.status}
                  </span>
                  <span className="text-xs text-gray-400 ml-auto">{formatDateTime12(s.submittedAt)}</span>
                </div>
                {s.remarks && <p className="text-sm text-gray-700 whitespace-pre-wrap">{s.remarks}</p>}
                {(s.evidence || []).length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {s.evidence.map((f) => (
                      <button key={f._id} type="button"
                        onClick={() => openFile(id, f)}
                        className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-gray-200 rounded-lg hover:bg-gray-50"
                        style={{ minHeight: 30 }}>
                        <FiPaperclip size={11} /> {f.name}
                      </button>
                    ))}
                  </div>
                )}
                {(s.urls || []).length > 0 && (
                  <ul className="mt-2 space-y-0.5">
                    {s.urls.map((u) => (
                      <li key={u}>
                        <a href={u} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline break-all">{u}</a>
                      </li>
                    ))}
                  </ul>
                )}
                {s.location && s.location.lat != null && (
                  <div className="mt-2 text-xs text-gray-400 inline-flex items-center gap-1">
                    <FiMapPin size={11} />
                    {s.location.address || `${s.location.lat.toFixed(5)}, ${s.location.lng.toFixed(5)}`}
                    {s.location.distanceM != null && (
                      <span className={s.location.insideFence ? 'text-green-600' : 'text-red-600'}>
                        · {s.location.distanceM} m {s.location.insideFence ? 'inside' : 'outside'}
                      </span>
                    )}
                  </div>
                )}
                {s.reviewNote && (
                  <div className="mt-2 text-sm bg-gray-50 border border-gray-100 rounded px-2 py-1">
                    <span className="text-gray-400 text-xs">{s.reviewedByName}:</span>{' '}
                    <span className="text-gray-700">{s.reviewNote}</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {tab === 'comments' && (
          <div className="space-y-4">
            <div className="space-y-3 max-h-[420px] overflow-y-auto">
              {(data.comments || []).length === 0 && <p className="text-sm text-gray-400">No comments yet.</p>}
              {(data.comments || []).map((c) => (
                <div key={c._id} className={`rounded-lg p-3 ${c.internal ? 'bg-violet-50 border border-violet-100' : 'bg-gray-50'}`}>
                  <div className="flex items-baseline gap-2 mb-0.5">
                    <span className="text-sm font-medium text-gray-900">{c.authorName || personName(c.author)}</span>
                    {c.authorRole && <span className="text-xs text-gray-400">{c.authorRole}</span>}
                    {c.internal && <span className="text-xs text-violet-600">internal</span>}
                    <span className="text-xs text-gray-400 ml-auto">{formatDateTime12(c.createdAt)}</span>
                  </div>
                  <p className="text-sm text-gray-700 whitespace-pre-wrap">{c.body}</p>
                  {(c.attachments || []).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {c.attachments.map((f) => (
                        <button key={f._id} type="button" onClick={() => openFile(id, f)}
                          className="inline-flex items-center gap-1 text-xs px-2 py-1 border border-gray-200 rounded-lg bg-white hover:bg-gray-50"
                          style={{ minHeight: 30 }}>
                          <FiPaperclip size={11} /> {f.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>

            {!viewOnly && (
              <form className="space-y-2" onSubmit={async (e) => {
                e.preventDefault();
                if (!comment.trim()) return;
                await run('comment', async () => {
                  await T.addComment(id, { body: comment, files: commentFiles, internal });
                  setComment('');
                  setCommentFiles([]);
                });
              }}>
                <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
                  placeholder="Add a remark…" className="block w-full border rounded-lg px-3 py-2 text-sm" />
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 text-xs text-gray-600 px-2 py-1 border rounded-lg cursor-pointer hover:bg-gray-50"
                    style={{ minHeight: 32 }}>
                    <FiPaperclip size={12} />
                    {commentFiles.length ? `${commentFiles.length} file${commentFiles.length === 1 ? '' : 's'}` : 'Attach'}
                    <input type="file" multiple className="hidden"
                      onChange={(e) => { setCommentFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
                  </label>
                  {can.review && (
                    <label className="inline-flex items-center gap-1.5 text-xs text-gray-600" style={{ minHeight: 32 }}>
                      <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)}
                        className="h-3.5 w-3.5 rounded border-gray-300" />
                      Internal — the assignee will not see this
                    </label>
                  )}
                  <button type="submit" disabled={!comment.trim() || acting === 'comment'}
                    className="ml-auto px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
                    style={{ minHeight: 40 }}>
                    {acting === 'comment' ? 'Posting…' : 'Comment'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}

        {tab === 'files' && (
          <div className="space-y-2">
            {(task.attachments || []).map((f) => (
              <div key={f._id} className="flex items-center gap-2 text-sm border border-gray-200 rounded-lg px-3 py-2">
                <FiPaperclip size={13} className="text-gray-400 shrink-0" />
                <span className="flex-1 truncate">{f.name}</span>
                <span className="text-xs text-gray-400 shrink-0">{f.uploadedByName}</span>
                <button type="button" onClick={() => openFile(id, f)}
                  className="text-blue-600 hover:underline text-xs shrink-0">Open</button>
              </div>
            ))}
            {!viewOnly && (can.work || can.manage) && (
              <label className="inline-flex items-center gap-1.5 text-sm px-3 py-2 border rounded-lg cursor-pointer hover:bg-gray-50"
                style={{ minHeight: 40 }}>
                <FiPlus size={14} /> Add files
                <input type="file" multiple className="hidden"
                  onChange={async (e) => {
                    const files = Array.from(e.target.files || []);
                    e.target.value = '';
                    if (files.length) await run('attach', () => T.addAttachments(id, files), 'Attached');
                  }} />
              </label>
            )}
          </div>
        )}

        {tab === 'extensions' && (
          <div className="space-y-3">
            {can.work && !viewOnly && ['ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'REJECTED', 'BLOCKED'].includes(task.status) && (
              <ExtensionForm taskId={id} currentDue={task.dueDate} onDone={load} />
            )}
            {(data.extensions || []).map((x) => (
              <div key={x._id} className="border border-gray-200 rounded-lg p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-gray-900">{x.requestedByName}</span>
                  <span className="text-xs text-gray-400">
                    {fmtDate(x.currentDueDate)} → {fmtDate(x.requestedDueDate)}
                  </span>
                  <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-xs ml-auto ${
                    x.status === 'Approved' ? 'bg-green-100 text-green-800'
                      : x.status === 'Rejected' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}
                    style={{ minHeight: 22 }}>
                    {x.status}
                  </span>
                </div>
                <p className="mt-1 text-sm text-gray-700">{x.reason}</p>
                {x.approvedDueDate && x.status === 'Approved' && (
                  <p className="mt-1 text-xs text-gray-500">Granted to {fmtDate(x.approvedDueDate)}</p>
                )}
                {x.decisionNote && <p className="mt-1 text-xs text-gray-500">{x.decidedByName}: {x.decisionNote}</p>}
                {x.status === 'Pending' && can.review && !viewOnly && (
                  <div className="mt-2 flex gap-2">
                    <button type="button"
                      onClick={() => run('ext', () => T.decideExtension(x._id, { decision: 'approve' }), 'Extension granted')}
                      className="px-3 py-1.5 text-xs rounded-lg bg-gray-900 text-white hover:bg-gray-700" style={{ minHeight: 32 }}>
                      Grant
                    </button>
                    <button type="button"
                      onClick={async () => {
                        const note = await promptDialog({ message: 'Why not?', confirmText: 'Refuse' });
                        if (!note) return;
                        await run('ext', () => T.decideExtension(x._id, { decision: 'reject', note }), 'Refused');
                      }}
                      className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-700 hover:bg-red-50" style={{ minHeight: 32 }}>
                      Refuse
                    </button>
                  </div>
                )}
              </div>
            ))}
            {(data.extensions || []).length === 0 && <p className="text-sm text-gray-400">No extensions asked for.</p>}
          </div>
        )}

        {tab === 'incentive' && (
          <div className="space-y-3">
            <div className="text-sm text-gray-600">
              This task is worth <span className="font-medium text-gray-900">{task.incentive.points} points</span>
              {task.incentive.setByName && <span className="text-gray-400">, set by {task.incentive.setByName}</span>}
              {task.incentive.distribution === 'share' && (task.assignees || []).length > 1
                && <span className="text-gray-400"> — split between the people on it</span>}.
            </div>
            {(data.incentives || []).length === 0 ? (
              <p className="text-sm text-gray-400">
                Nothing is worked out until the task is done and approved.
              </p>
            ) : (
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Person</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Outcome</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">How it was worked out</th>
                    <th className="px-3 py-2 text-right font-medium text-gray-700">Points</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.incentives.map((a) => (
                    <tr key={a._id}>
                      <td className="px-3 py-2">{a.name}</td>
                      <td className="px-3 py-2 text-gray-600">{INCENTIVE_OUTCOME_LABELS[a.outcome] || a.outcome}</td>
                      <td className="px-3 py-2 text-xs text-gray-500">{a.basis}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-medium">{a.approvedPoints ?? a.points}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center rounded-lg px-2 py-0.5 text-xs ${
                          a.status === 'Credited' ? 'bg-green-100 text-green-800'
                            : a.status === 'Rejected' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'}`}
                          style={{ minHeight: 22 }}>{a.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-gray-400">
              Points are approved on the Tasks page (Incentives) and join the same company-wide pool as every
              other incentive.
            </p>
          </div>
        )}

        {tab === 'location' && (
          <div className="space-y-2">
            {(task.location.captured || []).map((c, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2 text-sm border border-gray-200 rounded-lg px-3 py-2">
                <FiMapPin size={13} className="text-gray-400" />
                <span className="text-gray-700">{c.userName || '—'}</span>
                <span className="text-xs text-gray-400">{c.event}</span>
                <span className="text-xs text-gray-500 tabular-nums">
                  {c.address || `${(c.lat ?? 0).toFixed(5)}, ${(c.lng ?? 0).toFixed(5)}`}
                </span>
                {c.distanceM != null && (
                  <span className={`text-xs ${c.insideFence ? 'text-green-600' : 'text-red-600'}`}>
                    {c.distanceM} m {c.insideFence ? 'inside' : 'outside'}
                  </span>
                )}
                <span className="text-xs text-gray-400 ml-auto">{formatDateTime12(c.at)}</span>
              </div>
            ))}
          </div>
        )}

        {tab === 'subtasks' && (
          <div className="space-y-2">
            {(data.subtasks || []).map((s) => (
              <Link key={s._id} to={`${base}/${s._id}`}
                className="flex flex-wrap items-center gap-2 text-sm border border-gray-200 rounded-lg px-3 py-2 hover:bg-gray-50">
                <span className="flex-1 font-medium text-gray-900">{s.title}</span>
                <span className="text-xs text-gray-500">{personName(s.assignedTo)}</span>
                <StatusChip status={s.status} />
                <DueChip task={s} />
              </Link>
            ))}
          </div>
        )}

        {tab === 'activity' && <TaskTimeline activity={data.activity} />}
      </div>

      {showSubmit && (
        <SubmitModal
          task={task}
          onClose={() => setShowSubmit(false)}
          onSubmit={async (payload) => {
            await T.submitTask(id, payload);
            setShowSubmit(false);
            toast.success('Submitted for review');
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * Open a task file in a new tab.
 *
 * Fetched through axios rather than linked directly, because the endpoint is
 * authenticated and a plain <a href> carries no Authorization header — the same
 * reason AuthImage exists for avatars.
 */
async function openFile(taskId, file) {
  try {
    const res = await api.get(T.fileUrl(taskId, file._id), { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    window.open(url, '_blank', 'noopener');
    // Give the new tab time to take the blob before the URL is revoked.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch {
    toast.error('Could not open that file');
  }
}

/** Ask for more time. Its own component so the date field can hold its own state. */
function ExtensionForm({ taskId, currentDue, onDone }) {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50"
        style={{ minHeight: 40 }}>
        <FiCalendar size={14} /> Ask for more time
      </button>
    );
  }

  return (
    <form className="border border-gray-200 rounded-lg p-3 space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setSaving(true);
        try {
          await T.requestExtension(taskId, { requestedDueDate: date, reason });
          toast.success('Asked for an extension');
          setOpen(false);
          setDate('');
          setReason('');
          await onDone();
        } catch (err) {
          toast.error(err.response?.data?.message || 'Could not ask');
        } finally {
          setSaving(false);
        }
      }}>
      <div className="text-xs text-gray-500">
        Currently due {currentDue ? fmtDate(currentDue) : 'with no deadline'}
      </div>
      <input type="datetime-local" required value={date} onChange={(e) => setDate(e.target.value)}
        className="block w-full border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }} />
      <textarea required rows={2} value={reason} onChange={(e) => setReason(e.target.value)}
        placeholder="Why do you need longer?" className="block w-full border rounded-lg px-3 py-2 text-sm" />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => setOpen(false)}
          className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50" style={{ minHeight: 36 }}>Cancel</button>
        <button type="submit" disabled={saving}
          className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60"
          style={{ minHeight: 36 }}>{saving ? 'Asking…' : 'Ask'}</button>
      </div>
    </form>
  );
}
