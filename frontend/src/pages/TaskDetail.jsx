/**
 * One task — everything about it, and its whole history.
 *
 * REWRITTEN 2026-09-21, down from 952 lines and six tabs (overview, evidence,
 * workflow, time, comments, activity). It is now one column of facts and one
 * column of feed, because the six tabs were six places to look for the answer
 * to "what is happening with this".
 *
 * THE BUTTONS COME FROM THE SERVER. `can.transitions` is computed by
 * services/taskAccess.capabilitiesFor and drawn as-is. This page has NO opinion
 * about who may do what — the version it replaces derived the buttons from the
 * status and the user's id in the browser, and the phone derived them again,
 * differently.
 *
 * THE FEED IS ONE LIST. A status move and a remark are the same row
 * (models/TaskUpdate); the only difference on screen is that a move carries a
 * chip saying what it became. Three collections merged in the browser is how
 * the old page ended up with a history that could not be paged.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  FiArrowLeft, FiUser, FiUsers, FiEye, FiTag, FiFlag, FiCalendar, FiRepeat,
  FiAward, FiBell, FiPaperclip, FiLink, FiMessageSquare, FiTrash2, FiEdit2,
  FiPlay, FiCheck, FiRotateCcw, FiXCircle, FiCornerUpRight, FiClock, FiDownload,
  FiThumbsUp, FiThumbsDown, FiAlertTriangle,
} from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import useViewOnly from '../hooks/useViewOnly';
import { useAuthStore } from '../store/authStore';
import AuthImage from '../components/AuthImage';
import { VoicePlayer } from '../components/task/VoiceNote';
import TaskUpdateModal from '../components/task/TaskUpdateModal';
import AssignTaskModal from '../components/task/AssignTaskModal';
import { StatusChip, PriorityChip, DueChip, PointsChip } from '../components/task/TaskChips';
import SubtaskList from '../components/task/SubtaskList';
import * as T from '../api/tasks';
import {
  statusLabel, repeatLabel, reminderLabel, timeAgo, assigneeNames, personName,
  FREQUENCY_LABELS,
} from '../utils/taskLifecycle';

/** The icon and wording of each move a server may offer. */
const MOVE_UI = {
  IN_PROGRESS: { icon: FiPlay, label: 'Start working', tone: 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100' },
  COMPLETED: { icon: FiCheck, label: 'Mark complete', tone: 'border-green-200 bg-green-50 text-green-700 hover:bg-green-100' },
  PENDING: { icon: FiRotateCcw, label: 'Send back', tone: 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100' },
  CANCELLED: { icon: FiXCircle, label: 'Cancel it', tone: 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100' },
};

/** The same buttons, worded for a request. */
const REQUEST_LABELS = {
  IN_PROGRESS: 'Looking into it',
  COMPLETED: 'Mark answered',
  PENDING: 'Reopen',
  CANCELLED: 'Withdraw',
};

export default function TaskDetail({ base = '/employee/tasks' }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const viewOnly = useViewOnly();
  // Whose pieces are whose — SubtaskList greys the boxes that are not this
  // person's. The SERVER is what enforces it.
  const me = useAuthStore((st) => st.user?._id);

  const [task, setTask] = useState(null);
  const [updates, setUpdates] = useState([]);
  const [can, setCan] = useState({ transitions: [] });
  const [loading, setLoading] = useState(true);
  const [meta, setMeta] = useState(null);

  const [moving, setMoving] = useState(null);   // the target status
  const [remarking, setRemarking] = useState(false);
  // Delegating opens the SAME box, already in its delegate mode.
  const [delegating, setDelegating] = useState(false);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await T.getTask(id);
      setTask(data.task);
      setUpdates(data.updates || []);
      setCan(data.can || { transitions: [] });
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not open that task.');
      navigate(base);
    } finally {
      setLoading(false);
    }
  }, [id, base, navigate]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { T.taskMeta().then(setMeta).catch(() => {}); }, []);

  const accept = useCallback(async () => {
    try {
      await T.acceptTask(id);
      toast.success('Accepted.');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not accept that task.');
    }
  }, [id, load]);

  /** The reason is required by the server — see services/taskEngine.decline. */
  const decline = useCallback(async () => {
    const reason = await promptDialog({
      title: 'Cannot take this on?',
      message: 'Say why, so it can be given to somebody else. They will see this.',
      placeholder: 'e.g. I am on leave from Thursday',
    });
    if (!reason || !reason.trim()) return;
    try {
      await T.declineTask(id, reason.trim());
      toast.success('Declined. Whoever set it has been told.');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not decline that task.');
    }
  }, [id, load]);

  /**
   * Remove it — archive by default.
   *
   * A SuperAdmin is additionally offered a real DELETE. The two are kept as
   * separate confirmations rather than a checkbox inside one, because
   * "archive" and "gone for ever" should not be one slip apart.
   */
  const remove = useCallback(async (purge = false) => {
    const yes = await confirmDialog({
      title: purge ? 'Delete this task for good?' : 'Remove this task?',
      message: purge
        ? 'The task and its whole history are erased. This cannot be undone. '
          + 'If anybody has already been credited points for it, the server will refuse.'
        : 'It disappears from every list. The history and any points already credited stay on file.',
      confirmText: purge ? 'Delete for good' : 'Remove',
      tone: 'danger',
    });
    if (!yes) return;
    try {
      const res = await T.deleteTask(id, { purge });
      toast.success(res?.message || 'Removed.');
      navigate(base);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not remove that task.');
    }
  }, [id, base, navigate]);

  const isRequest = task?.kind === 'REQUEST';

  if (loading) {
    return (
      <div className="space-y-3">
        <div className="h-10 w-48 animate-pulse rounded-lg bg-gray-100" />
        <div className="h-64 animate-pulse rounded-2xl bg-gray-100" />
      </div>
    );
  }
  if (!task) return null;

  return (
    <div>
      <Link
        to={base}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600 min-h-[32px]"
      >
        <FiArrowLeft size={14} /> Back to tasks
      </Link>

      <PageHeader title={task.title} subtitle={task.code || undefined}>
        <StatusChip task={task} />
        <PriorityChip priority={task.priority} always />
        {!isRequest && <PointsChip points={task.points} earned={task.status === 'COMPLETED'} />}
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* ══ Left: what it is, and what has happened ══════════ */}
        <div className="space-y-4">
          {/* ── Actions ───────────────────────────────────── */}
          {/* THE HANDOVER, unanswered. Drawn as a banner rather than two more
              buttons in the row below, because "do you accept this?" is a
              different question from "how is it going?" and the answer decides
              whether the rest of the page is even relevant. */}
          {!viewOnly && can.canAccept && (
            <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
              <div className="min-w-[10rem] flex-1">
                <p className="text-sm font-medium text-amber-900">
                  {isRequest ? 'Can you help with this?' : 'Will you take this on?'}
                </p>
                <p className="text-xs text-amber-700">
                  {task.createdByName || 'Somebody'} is waiting to hear.
                </p>
              </div>
              <button
                type="button"
                onClick={accept}
                className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700"
              >
                <FiThumbsUp size={14} /> Accept
              </button>
              {can.canDecline && (
                <button
                  type="button"
                  onClick={decline}
                  className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-amber-300 bg-white px-4 text-sm font-medium text-gray-700 hover:border-red-300 hover:text-red-600"
                >
                  <FiThumbsDown size={14} /> Cannot
                </button>
              )}
            </div>
          )}

          {/* Everybody on it has said no. The person who set it has to act, so
              the reasons are on the page rather than buried in the feed. */}
          {task.declined && (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
              <p className="flex items-center gap-1.5 text-sm font-medium text-red-800">
                <FiAlertTriangle size={14} /> Nobody has taken this on
              </p>
              <ul className="mt-1.5 space-y-1">
                {(task.assignees || [])
                  .filter((a) => a.acceptance === 'REJECTED')
                  .map((a) => (
                    <li key={a._id} className="text-xs text-red-700">
                      <strong>{a.name || personName(a.user)}:</strong> {a.declineReason || 'no reason given'}
                    </li>
                  ))}
              </ul>
              {can.canEdit && (
                <p className="mt-2 text-xs text-red-600">
                  Give it to somebody else, or call it off.
                </p>
              )}
            </div>
          )}

          {!viewOnly && can.transitions?.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {can.transitions.map(({ to }) => {
                const ui = MOVE_UI[to];
                if (!ui) return null;
                const Icon = ui.icon;
                return (
                  <button
                    key={to}
                    type="button"
                    onClick={() => setMoving(to)}
                    className={`min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border px-4 text-sm font-medium transition ${ui.tone}`}
                  >
                    <Icon size={14} />
                    {isRequest ? (REQUEST_LABELS[to] || ui.label) : ui.label}
                  </button>
                );
              })}
              {/* Delegating opens the SAME update box the status moves do, in
                  its delegate mode — one screen, three things it can do. */}
              {can.canDelegate && (
                <button
                  type="button"
                  onClick={() => setDelegating(true)}
                  className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-4 text-sm font-medium text-gray-600 transition hover:border-gray-400 hover:text-blue-600"
                >
                  <FiCornerUpRight size={14} /> Delegate
                </button>
              )}
            </div>
          )}

          {/* ── What was asked for ────────────────────────── */}
          {(task.description || task.voiceNote?.storagePath || task.links?.length > 0) && (
            <section className="rounded-2xl border border-gray-200 bg-white p-4">
              {task.description && (
                <p className="whitespace-pre-wrap text-sm text-gray-700">{task.description}</p>
              )}

              {task.voiceNote?.storagePath && (
                <div className="mt-3">
                  <p className="mb-1 text-xs font-medium text-gray-500">
                    Voice note from {task.voiceNote.recordedByName || 'the assigner'}
                  </p>
                  <VoicePlayer
                    path={T.taskVoiceUrl(task._id)}
                    durationMs={task.voiceNote.durationMs}
                  />
                </div>
              )}

              {task.links?.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {task.links.map((l) => (
                    <li key={l._id || l.url}>
                      <a
                        href={l.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="inline-flex items-center gap-1.5 text-xs accent-text hover:underline"
                      >
                        <FiLink size={11} /> {l.label || l.url}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── Files ─────────────────────────────────────── */}
          {task.attachments?.length > 0 && (
            <section className="rounded-2xl border border-gray-200 bg-white p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-gray-700">
                <FiPaperclip size={12} /> Files
              </h2>
              <div className="grid gap-2 sm:grid-cols-2">
                {task.attachments.map((f) => (
                  <a
                    key={f._id}
                    href={`#${f._id}`}
                    onClick={async (e) => {
                      e.preventDefault();
                      try {
                        const url = await T.blobUrl(T.fileUrl(task._id, f._id));
                        window.open(url, '_blank', 'noopener');
                      } catch { toast.error('That file could not be opened.'); }
                    }}
                    className="flex items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-xs hover:border-gray-400"
                  >
                    <FiPaperclip className="shrink-0 text-gray-400" size={13} />
                    <span className="min-w-0 flex-1 truncate text-gray-700">{f.name}</span>
                    <FiDownload className="shrink-0 text-gray-400" size={12} />
                  </a>
                ))}
              </div>
            </section>
          )}

          {/* ── The feed ──────────────────────────────────── */}
          <SubtaskList
            task={task}
            can={can}
            me={me}
            viewOnly={viewOnly}
            onChanged={load}
          />

          <section className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
                <FiMessageSquare size={12} /> History
              </h2>
              {!viewOnly && can.canComment && (
                <button
                  type="button"
                  onClick={() => setRemarking(true)}
                  className="rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-blue-600 min-h-[32px]"
                >
                  Add a remark
                </button>
              )}
            </div>

            {updates.length === 0 ? (
              <p className="py-6 text-center text-xs text-gray-400">Nothing has happened yet.</p>
            ) : (
              <ol className="space-y-3">
                {updates.map((u) => (
                  <FeedRow key={u._id} update={u} task={task} />
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* ══ Right: the facts ═════════════════════════════════ */}
        <aside className="space-y-3">
          <section className="space-y-2.5 rounded-2xl border border-gray-200 bg-white p-4 text-sm">
            <Fact icon={FiUser} label={isRequest ? 'Asked by' : 'Assigned by'}>
              {task.createdByName || personName(task.createdBy) || '—'}
            </Fact>

            <Fact icon={FiUsers} label={isRequest ? 'Asked of' : 'Assigned to'}>
              <div className="space-y-1">
                {(task.assignees || []).map((a) => (
                  <div key={a._id || a.user?._id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-gray-700">{a.name || personName(a.user)}</span>
                    <span className="shrink-0 text-[11px] text-gray-400">
                      {statusLabel(a.status, task.kind)}
                      {a.completedLate && ' · late'}
                    </span>
                  </div>
                ))}
              </div>
            </Fact>

            {task.loopUsers?.length > 0 && (
              <Fact icon={FiEye} label="In the loop">
                {task.loopUsers.map((u) => personName(u)).filter(Boolean).join(', ')}
              </Fact>
            )}

            <Fact icon={FiCalendar} label={task.dueDate ? 'Due' : 'Deadline'}>
              <DueChip task={task} />
            </Fact>

            {task.completedAt && (
              <Fact icon={FiCheck} label="Finished">
                <span className={task.completedLate ? 'text-orange-600' : 'text-green-600'}>
                  {new Date(task.completedAt).toLocaleString('en-IN', {
                    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
                  })}
                  {task.completedLate ? ' · delayed' : ' · in time'}
                </span>
              </Fact>
            )}

            {task.category && <Fact icon={FiTag} label="Category">{task.category}</Fact>}
            <Fact icon={FiFlag} label="Priority">{task.priority}</Fact>

            {task.repeat?.frequency && task.repeat.frequency !== 'ONCE' && (
              <Fact icon={FiRepeat} label="Repeats">{repeatLabel(task.repeat)}</Fact>
            )}

            {!isRequest && (
              <Fact icon={FiAward} label="Worth">
                {task.points} points each
                {meta && !meta.pointsArePaid && (
                  <span className="block text-[11px] text-gray-400">scoring only — not paid out</span>
                )}
              </Fact>
            )}

            {task.linkedTask && (
              <Fact icon={FiCornerUpRight} label="About">
                <Link to={`${base}/${task.linkedTask._id} accent-text hover:underline`}>
                  {task.linkedTask.code || task.linkedTask.title}
                </Link>
              </Fact>
            )}

            {task.delegations?.length > 0 && (
              <Fact icon={FiCornerUpRight} label="Passed on">
                <div className="space-y-0.5">
                  {task.delegations.map((d) => (
                    <p key={d._id} className="text-xs text-gray-600">
                      {d.fromName} <span className="text-gray-400">to</span> {d.toName}
                      {d.note ? <span className="block text-[11px] text-gray-400">{d.note}</span> : null}
                    </p>
                  ))}
                </div>
              </Fact>
            )}

            <Fact icon={FiClock} label="Set">
              {timeAgo(task.createdAt)}
              {task.extensionCount > 0 && (
                <span className="block text-[11px] text-amber-600">
                  deadline moved {task.extensionCount}×
                </span>
              )}
            </Fact>
          </section>

          {task.reminders?.length > 0 && (
            <section className="rounded-2xl border border-gray-200 bg-white p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-gray-700">
                <FiBell size={12} /> Reminders
              </h2>
              <ul className="space-y-1 text-xs text-gray-600">
                {task.reminders.map((r, i) => (
                  <li key={i} className="flex items-center gap-1.5">
                    <span className="h-1 w-1 shrink-0 rounded-full bg-gray-300" />
                    {r.channel === 'EMAIL' ? 'Email' : 'App'} · {reminderLabel(r)}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!viewOnly && (
            <div className="flex flex-wrap gap-2">
              {/* Anybody on the task can raise a request about it — the "I need
                  X to finish this" case the direction rule exists to serve. */}
              <button
                type="button"
                onClick={() => setAsking(true)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-gray-200 px-3 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-blue-600 min-h-[38px]"
              >
                <FiCornerUpRight size={12} /> Ask for help
              </button>
              {can.canDelete && (
                <button
                  type="button"
                  onClick={() => remove(false)}
                  className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-gray-200 px-3 text-xs font-medium text-gray-500 hover:border-red-300 hover:text-red-600 min-h-[38px]"
                >
                  <FiTrash2 size={12} /> Remove
                </button>
              )}
              {/* A SuperAdmin may delete ANY task outright (user decision,
                  2026-09-21). Kept as its own button rather than a checkbox
                  inside Remove, because "archive" and "gone for ever" should
                  not be one slip apart. The server refuses it once points have
                  been credited. */}
              {can.canPurge && (
                <button
                  type="button"
                  onClick={() => remove(true)}
                  title="Delete for good — Super Admin only"
                  className="min-h-[38px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-200 px-3 text-xs font-medium text-red-600 hover:bg-red-50"
                >
                  <FiAlertTriangle size={12} /> Delete
                </button>
              )}
            </div>
          )}
        </aside>
      </div>

      <TaskUpdateModal
        open={Boolean(moving) || remarking || delegating}
        onClose={() => { setMoving(null); setRemarking(false); setDelegating(false); }}
        task={task}
        to={moving}
        meta={meta}
        can={can}
        initialMode={delegating ? 'delegate' : 'update'}
        onDone={load}
      />

      <AssignTaskModal
        open={asking}
        onClose={() => setAsking(false)}
        onCreated={() => toast.success('Request sent.')}
        meta={meta}
        forceRequest
        linkedTask={task._id}
        prefill={{ title: `Need help with: ${task.title}` }}
      />
    </div>
  );
}

function Fact({ icon: Icon, label, children }) {
  return (
    <div className="flex gap-2">
      <Icon className="mt-0.5 shrink-0 text-gray-400" size={13} />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] text-gray-400">{label}</p>
        <div className="text-sm text-gray-700">{children}</div>
      </div>
    </div>
  );
}

/**
 * One line of history.
 *
 * A status move and a remark are the same row; the move just carries a chip.
 * System rows (a reminder that fired, an occurrence that was minted) are drawn
 * quieter, because they are a record rather than somebody saying something.
 */
function FeedRow({ update, task }) {
  const moved = Boolean(update.to) && update.kind === 'STATUS';
  return (
    <li className={`flex gap-3 ${update.system ? 'opacity-60' : ''}`}>
      <div className="flex flex-col items-center">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
          moved ? 'accent-bg' : 'bg-gray-300'
        }`} />
        <span className="mt-1 w-px flex-1 bg-gray-100" />
      </div>

      <div className="min-w-0 flex-1 pb-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium text-gray-800">{update.byName || 'System'}</span>
          {moved && (
            <StatusChip status={update.to} kind={task.kind} />
          )}
          <span className="text-[11px] text-gray-400">{timeAgo(update.createdAt)}</span>
        </div>

        {update.note && (
          <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{update.note}</p>
        )}

        {update.voiceNote?.storagePath && (
          <VoicePlayer
            className="mt-2"
            path={T.updateVoiceUrl(task._id, update._id)}
            durationMs={update.voiceNote.durationMs}
          />
        )}

        {update.files?.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {update.files.map((f) => (
              <button
                key={f._id}
                type="button"
                onClick={async () => {
                  try {
                    const url = await T.blobUrl(T.fileUrl(task._id, f._id));
                    window.open(url, '_blank', 'noopener');
                  } catch { toast.error('That file could not be opened.'); }
                }}
                className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 py-1 text-[11px] text-gray-600 hover:border-gray-400"
              >
                <FiPaperclip size={10} /> {f.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
