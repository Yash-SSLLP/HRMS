/**
 * One task, whole — and the SAME component in a modal and on a page.
 *
 * NEW 2026-09-22. `pages/TaskDetail.jsx` is now a back-link and this; so is
 * `TaskModal`, which every list row and board card opens. One component because
 * the alternative was two: the module this replaces grew a page and then grew a
 * quick-look panel beside it, and within a week the panel could accept a task
 * and the page could not, because a `can` flag was added in one place.
 *
 * ── THE SHAPE (from TaskOPad, which the user pointed at) ────────────────────
 *
 * A SPLIT PANE. The task on the left — what it is, who it is for, what may be
 * done to it — and the talk on the right, as a tabbed Comment / Files /
 * Activity panel with the composer pinned to the bottom. On a phone the two
 * stack, task first, because somebody opening a task wants to know what it is
 * before they read what was said about it.
 *
 * Borrowed with it: the title is a LARGE HEADING that turns into an input where
 * it stands, not a labelled field in a form; and the status and priority are
 * INLINE COLOURED CHIPS that drop down, on one meta row. The colours are OURS —
 * every one of them arrives on the row from the server (`task.accent`,
 * config/tasks.PRIORITY_COLORS) and is read through ./taskColors.
 *
 * WHY THE TITLE IS NOT ALWAYS AN INPUT. index.css forces `font-size: 16px
 * !important` on every input under `(pointer: coarse)` — it is what stops iOS
 * zooming the page in on focus and never zooming back out. A permanent title
 * input would therefore be 16px on every phone and touch laptop, which is not a
 * title. So it is an <h1> until somebody edits it, and an input while they do.
 *
 * ── THE BUTTONS ARE THE SERVER'S ───────────────────────────────────────────
 *
 * Every one of them is drawn from `can` (services/taskAccess.capabilitiesFor).
 * Nothing here re-derives who may do what; the one piece of client-side logic
 * in the whole file is DE-DUPLICATION — `can.transitions` also contains the
 * moves that Submit, Approve and Send back already draw, and drawing them twice
 * would put "Mark in progress" next to "Send back" doing the same thing.
 *
 * THERE IS NO START BUTTON. Accepting starts the work (POST /:id/accept moves
 * the row to IN_PROGRESS) — the board's To do column is "assigned, not yet
 * accepted", so a separate Start would be a button that means nothing.
 *
 * ── NO SILENT MOVES ────────────────────────────────────────────────────────
 *
 * Every status change carries a note or a voice note; the server refuses one
 * without (services/taskEngine.move). So the answer buttons do not fire — they
 * put the composer on the right into ANSWER MODE, pre-set to that move, and the
 * person says what happened in the same box they would have used for a remark.
 * That is also what a board drag lands in: `initialStatus` opens the composer
 * already set to the column the card was dropped on.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
// The status/priority menus are portalled out of the header — see MenuChip.
import { createPortal } from 'react-dom';
import { toast } from 'react-toastify';
import {
  FiActivity, FiAlertTriangle, FiAward, FiBell, FiCalendar, FiCheck, FiCheckCircle,
  FiChevronDown, FiClock, FiCornerUpRight, FiDownload, FiEdit2, FiEye, FiFlag,
  FiAlertCircle, FiGitBranch, FiImage, FiLink, FiMessageSquare, FiPaperclip, FiRepeat,
  FiRotateCcw,
  FiSend, FiSlash, FiTag, FiThumbsDown, FiThumbsUp, FiTrash2, FiTrendingUp, FiUser,
  FiUserCheck, FiUsers, FiX, FiXCircle,
} from 'react-icons/fi';

import { confirmDialog, promptDialog } from '../dialogs';
import useViewOnly from '../../hooks/useViewOnly';
import { useAuthStore } from '../../store/authStore';
import { VoiceRecorder, VoicePlayer } from './VoiceNote';
import {
  StatusChip, OverdueChip, DueChip, PointsChip, PiecesChip, TransferredChip, ProgressBar,
} from './TaskChips';
import ChildTaskList from './ChildTaskList';
import ExtensionModal from './ExtensionModal';
import DelegateModal from './DelegateModal';
import TransferModal from './TransferModal';
import { accentFor, accentStyle, priorityColor, tintStyle, useIsDark } from './taskColors';
import * as T from '../../api/tasks';
import {
  STATUS, TASK_PRIORITY, PROGRESS_STEPS, clampProgress, statusLabel, statusStyle, isOverdue,
  repeatLabel, reminderLabel, timeAgo, dayLabel, personName, isTerminal,
} from '../../utils/taskLifecycle';

/* ===========================================================================
 * The one card, the one control, the one button — declared once so nothing in
 * this file can invent a second radius or a second shadow.
 * ======================================================================== */

const CARD = 'rounded-2xl border border-gray-200 bg-white shadow-sm';
const SECTION = 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500';
/**
 * A chip: padding and a minHeight from the CALLER, never a fixed height — a
 * large system font spills the label straight out of a fixed-height pill. The
 * min-height is not baked in here because two sizes use this (a read-only chip
 * and one that drops down), and two `min-h-[…]` utilities on one element is a
 * race between two equally specific rules.
 */
const CHIP = 'inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-0.5 text-xs font-medium';
const BTN = 'min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-xl border px-3.5 text-sm font-medium transition';

const TONES = {
  go: 'border-transparent bg-emerald-600 text-white hover:bg-emerald-700',
  send: 'border-transparent bg-blue-600 text-white hover:bg-blue-700',
  ghost: 'border-gray-200 bg-white text-gray-700 hover:border-gray-400 hover:text-blue-600',
  warn: 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100',
  danger: 'border-gray-200 bg-white text-gray-600 hover:border-red-300 hover:text-red-600',
};

/**
 * How the feed says each thing that can happen.
 *
 * One entry per `UPDATE_KINDS` in config/tasks.js. A row with a word of its own
 * reads as an event; a row without one falls back to the status chip, which is
 * what a plain move is. The nine added on 2026-09-22 are here for the same
 * reason they exist on the server: "status changed" cannot settle an argument
 * about who sent what back and when.
 */
/** Rows whose note the ENGINE writes, not a person — see `comments` below. */
const MACHINE_SAID = new Set(['PROGRESS', 'SPLIT', 'CLAIMED', 'REMINDER']);

const FEED_WORDS = {
  CREATED: { icon: FiFlag, says: 'set this task', tone: 'text-gray-400' },
  STATUS: { icon: FiActivity, says: '', tone: 'text-blue-500' },
  COMMENT: { icon: FiMessageSquare, says: '', tone: 'text-gray-400' },
  EDITED: { icon: FiEdit2, says: 'changed the details', tone: 'text-gray-400' },
  ASSIGNED: { icon: FiUsers, says: 'changed who is on it', tone: 'text-gray-400' },
  REMINDER: { icon: FiBell, says: 'a reminder went out', tone: 'text-gray-400' },
  ACCEPTED: { icon: FiThumbsUp, says: 'took it on', tone: 'text-emerald-500' },
  REJECTED: { icon: FiThumbsDown, says: 'could not take it on', tone: 'text-red-500' },
  DELEGATED: { icon: FiCornerUpRight, says: 'passed it on', tone: 'text-blue-500' },
  SUBTASK: { icon: FiGitBranch, says: 'changed a piece', tone: 'text-gray-400' },
  SUBMITTED: { icon: FiSend, says: 'handed it in', tone: 'text-violet-500' },
  APPROVED: { icon: FiCheckCircle, says: 'approved it', tone: 'text-emerald-500' },
  SENT_BACK: { icon: FiRotateCcw, says: 'sent it back', tone: 'text-amber-500' },
  PROGRESS: { icon: FiTrendingUp, says: 'reported progress', tone: 'text-blue-500' },
  SPLIT: { icon: FiGitBranch, says: 'split it into pieces', tone: 'text-blue-500' },
  CLAIMED: { icon: FiUserCheck, says: 'picked it up', tone: 'text-emerald-500' },
  TRANSFERRED: { icon: FiCornerUpRight, says: 'handed it to the right person', tone: 'text-gray-400' },
  EXTENSION_ASKED: { icon: FiClock, says: 'asked for more time', tone: 'text-amber-500' },
  EXTENSION_DECIDED: { icon: FiClock, says: 'answered the request for more time', tone: 'text-amber-500' },
};

/** A datetime-local value for `d`, in the browser's own zone. */
function toLocalInput(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

const sizeLabel = (bytes) => {
  const n = Number(bytes) || 0;
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

export default function TaskDetailBody({
  taskId,
  /** Where this module lives for this account — '/admin/tasks' or '/employee/tasks'. */
  base = '/employee/tasks',
  /**
   * A board drag landed on a column: open the composer already set to that
   * move, because the server will not take a silent one.
   */
  initialStatus = null,
  /** Something was written. The list, the board or the badge behind us reloads. */
  onChanged,
  /** A piece was opened — the modal swaps to it, the page navigates to it. */
  onOpenTask,
  /** It is not there any more (removed, or never ours to see). */
  onGone,
  className = '',
}) {
  const viewOnly = useViewOnly();
  const me = useAuthStore((s) => s.user?._id);
  const dark = useIsDark();

  const [task, setTask] = useState(null);
  const [children, setChildren] = useState([]);
  const [updates, setUpdates] = useState([]);
  const [can, setCan] = useState({ transitions: [] });
  const [meta, setMeta] = useState(null);

  /**
   * Two flags, not one. `loading` draws the skeleton and only ever runs on the
   * first read of a task; every later read sets `refreshing`, which draws a
   * hairline and leaves what is on screen exactly where it is. A single flag is
   * how a page collapses to a spinner every time somebody posts a remark.
   */
  const [loading, setLoading] = useState(true);
  /** Why the last load failed, so the window can say so instead of vanishing. */
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const [tab, setTab] = useState('comment');
  const [note, setNote] = useState('');
  const [voice, setVoice] = useState(null);
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  /** The move the composer is about to make, or null for a plain remark. */
  const [answer, setAnswer] = useState(null);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null);
  const [titling, setTitling] = useState(false);
  const [savingField, setSavingField] = useState('');

  const [extension, setExtension] = useState(null);   // { mode, requestId }
  const [delegating, setDelegating] = useState(false);
  const [transferring, setTransferring] = useState(false);

  const noteRef = useRef(null);
  const titleRef = useRef(null);
  const fileRef = useRef(null);
  const imageRef = useRef(null);
  const feedRef = useRef(null);
  /**
   * Open on the newest remark rather than the oldest. Without this the panel
   * opens on "Set this task." — the least interesting line in it — and every
   * reader scrolls down before they read anything.
   */
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [tab, updates]);
  const appliedInitial = useRef(false);

  // ===== Reading =====

  /**
   * The two callbacks live in refs, and that is not fussiness.
   *
   * `load` is a dependency of the mount effect, so anything `load` depends on
   * becomes one too — and a parent that writes `onChanged={() => reload()}`
   * inline hands us a new function on every render. That would re-create
   * `load`, re-run the effect, set state, render, and do it all again: a fetch
   * loop that only shows up in somebody else's component.
   */
  const goneRef = useRef(onGone);
  const changedRef = useRef(onChanged);
  useEffect(() => { goneRef.current = onGone; }, [onGone]);
  useEffect(() => { changedRef.current = onChanged; }, [onChanged]);

  const load = useCallback(async ({ first = false } = {}) => {
    /**
     * NEVER FETCH WITHOUT AN ID.
     *
     * `GET /tasks/null` is a 404 that reads "That task no longer exists.", and
     * the 404 branch below closes the window — so one render with a missing id
     * made a perfectly healthy task look deleted. TaskModal's lagging state was
     * the cause and is fixed, but the guard stays: this body is rendered from
     * two places, and neither should be able to do that again by accident.
     */
    if (!taskId) { setLoading(false); setRefreshing(false); return null; }
    if (first) setLoading(true); else setRefreshing(true);
    setError(null);
    try {
      const data = await T.getTask(taskId);
      setTask(data.task);
      setChildren(data.children || []);
      setUpdates(data.updates || []);
      setCan(data.can || { transitions: [] });
      return data;
    } catch (err) {
      /**
       * A FAILED LOAD MUST NOT SILENTLY SHUT THE WINDOW.
       *
       * It used to toast and call `onGone`, which closed the modal — so all
       * somebody saw was a red box floating over the list they had just clicked
       * in, with no way to tell WHICH task failed or to try again. Four clicks
       * made four toasts and no explanation. (Reported 2026-09-22.)
       *
       * Now the window stays open with the reason in it and a Retry. It only
       * closes on a genuine 404: that one means the row is stale — somebody
       * removed the task while the list was on screen — and there is nothing to
       * retry. Everything else (a 500, a dropped connection, a dev server
       * mid-reload) is worth another press.
       */
      const status = err?.response?.status;
      const message = err?.response?.data?.message
        || (status ? 'Could not open that task.' : 'Could not reach the server.');
      setError({ status, message });
      if (status === 404) {
        toast.error(message);
        goneRef.current?.();
      }
      return null;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [taskId]);

  // A different task in the same modal is a first load again, skeleton and all.
  useEffect(() => {
    appliedInitial.current = false;
    setError(null);
    setTask(null);
    setChildren([]);
    setUpdates([]);
    setCan({ transitions: [] });
    setAnswer(null);
    setEditing(false);
    setTitling(false);
    setNote('');
    setVoice(null);
    setFiles([]);
    setTab('comment');
    load({ first: true });
  }, [taskId, load]);

  // The people picker (transfer) and the category list (edit) both need it, and
  // it is one cached call for the whole module.
  useEffect(() => { T.taskMeta().then(setMeta).catch(() => {}); }, []);

  /** Reload, and tell whoever is behind us that something moved. */
  const refresh = useCallback(async () => {
    const data = await load();
    changedRef.current?.(data?.task || null);
  }, [load]);

  const isRequest = task?.kind === 'REQUEST';
  const accent = useMemo(() => accentFor(task || {}), [task]);
  const headerStyle = useMemo(() => accentStyle(task || {}, { dark, rail: 4 }), [task, dark]);

  // ===== The composer, and everything that goes through it =====

  /**
   * Put the composer into answer mode.
   *
   * `requires` is always true for a status move: the server refuses every one
   * of them without a note or a recording (services/taskEngine.move), approve
   * included — "say a word about what you are approving".
   */
  const ask = useCallback((next) => {
    setAnswer(next);
    setTab('comment');
    setTimeout(() => noteRef.current?.focus(), 60);
  }, []);

  const answerFor = useCallback((to) => {
    if (!to) return null;
    if (to === STATUS.SUBMITTED && can.canSubmit) {
      return {
        key: 'submit', to,
        title: 'Handing this in',
        hint: 'Say what you did. It goes to whoever reviews it.',
        verb: 'Submit', tone: 'send',
        needs: 'Say what you did before handing this in — a voice note counts.',
      };
    }
    if (to === STATUS.COMPLETED && can.canApprove) {
      return {
        key: 'approve', to,
        title: 'Approving this',
        hint: 'A word about what you are signing off. Points are credited on approval.',
        verb: 'Approve', tone: 'go',
        needs: 'Say a word about what you are approving.',
      };
    }
    if (to === STATUS.IN_PROGRESS && can.canReject) {
      return {
        key: 'reject', to,
        title: 'Sending this back',
        hint: 'Say what still needs doing — that is the whole point of sending it back.',
        verb: 'Send back', tone: 'warn',
        needs: 'Say what needs doing before sending this back.',
      };
    }
    if (!(can.transitions || []).some((t) => t.to === to)) return null;
    // What is LEFT after the three named answers above: calling it off,
    // reopening a finished one, putting a submission back, or an assigner
    // finishing a task they set for themselves.
    const request = task?.kind === 'REQUEST';
    const verb = {
      [STATUS.CANCELLED]: request ? 'Withdraw it' : 'Cancel it',
      [STATUS.PENDING]: can.canWithdraw ? 'Withdraw it' : 'Put it back',
      [STATUS.COMPLETED]: 'Mark complete',
      [STATUS.IN_PROGRESS]: isTerminal(task?.status) ? 'Reopen it' : 'Move it along',
    }[to] || statusLabel(to, task?.kind);
    return {
      key: 'status', to, verb,
      title: `${verb} — ${statusLabel(to, task?.kind).toLowerCase()}`,
      hint: 'Nothing moves in this module without a word about why.',
      tone: to === STATUS.CANCELLED ? 'danger' : 'ghost',
      needs: 'Add a note (or a voice note) explaining this change.',
    };
  }, [can, task]);

  // A board drag chose the move before this even opened.
  useEffect(() => {
    if (!task || !initialStatus || appliedInitial.current) return;
    appliedInitial.current = true;
    if (initialStatus === task.status) return;
    const next = answerFor(initialStatus);
    if (next) ask(next);
    else toast.info(`This ${isRequest ? 'request' : 'task'} cannot be moved there by you.`);
  }, [task, initialStatus, answerFor, ask, isRequest]);

  const pickFiles = useCallback((e) => {
    setFiles((f) => [...f, ...[...(e.target.files || [])]].slice(0, 10));
    e.target.value = '';
  }, []);

  const clearComposer = useCallback(() => {
    setNote('');
    setVoice(null);
    setFiles([]);
    setAnswer(null);
  }, []);

  const send = useCallback(async () => {
    const said = note.trim();
    if (answer && !said && !voice) {
      toast.error(answer.needs);
      noteRef.current?.focus();
      return;
    }
    if (!answer && !said && !voice && !files.length) {
      toast.error('Write something, record something, or attach a file.');
      return;
    }

    setSending(true);
    try {
      const payload = { note: said, voice, files };
      let res = null;
      if (!answer) res = await T.addUpdate(task._id, payload);
      else if (answer.key === 'submit') res = await T.submitTask(task._id, payload);
      else if (answer.key === 'approve') res = await T.approveTask(task._id, payload);
      else if (answer.key === 'reject') res = await T.rejectTask(task._id, payload);
      else res = await T.changeStatus(task._id, answer.to, payload);

      // Already there: two taps, or a phone retrying a request it never saw the
      // answer to. Not an error, and not worth claiming something happened.
      if (res?.unchanged) toast.info('That was already done.');
      else if (!answer) toast.success('Added.');
      else if (answer.key === 'submit') toast.success('Handed in — it is in review now.');
      else if (answer.key === 'reject') toast.success('Sent back.');
      else if (answer.key === 'approve') {
        const earned = (res?.awarded || []).reduce((sum, a) => sum + (a.points || 0), 0);
        toast.success(earned > 0 ? `Approved · ${earned} points credited` : 'Approved.');
      } else {
        // The SERVER says where it landed — a doer's "complete" is coerced to a
        // submission, and announcing the move we asked for would be a lie in
        // exactly the case people already find confusing.
        const landed = statusLabel(res?.task?.status || answer.to, task.kind).toLowerCase();
        toast.success(`Marked ${landed}.`);
      }

      clearComposer();
      await refresh();
      // …and to the BOTTOM, which is now where the newest row is.
      feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not save that.');
    } finally {
      setSending(false);
    }
  }, [answer, note, voice, files, task, clearComposer, refresh]);

  // ===== The answers that do not need a note =====

  const accept = useCallback(async () => {
    try {
      await T.acceptTask(task._id, note.trim() || undefined);
      toast.success('Accepted — it is on your plate now.');
      clearComposer();
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not accept that task.');
    }
  }, [task, note, clearComposer, refresh]);

  /** The reason is REQUIRED by the server — see services/taskEngine.decline. */
  const decline = useCallback(async () => {
    const why = await promptDialog({
      title: isRequest ? 'Cannot help with this?' : 'Cannot take this on?',
      message: 'Say why, so it can go to somebody else. They will see this.',
      placeholder: 'e.g. I am on leave from Thursday',
      confirmText: 'Decline',
    });
    if (!why || !why.trim()) return;
    try {
      await T.declineTask(task._id, why.trim());
      toast.success('Declined. Whoever set it has been told.');
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not decline that task.');
    }
  }, [task, isRequest, refresh]);

  const claim = useCallback(async () => {
    const yes = await confirmDialog({
      title: 'Take this piece on?',
      message: 'It becomes yours, and nobody else can pick it up.',
      details: [`Worth ${task?.points || 0} points`, task?.dueDate ? `Due ${dayLabel(task.dueDate)}` : 'No deadline'],
      confirmText: 'Take it on',
    });
    if (!yes) return;
    try {
      await T.claimTask(task._id);
      toast.success('It is yours.');
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not pick that up.');
    }
  }, [task, refresh]);

  /**
   * Remove it — archive by default.
   *
   * A SuperAdmin is additionally offered a real DELETE, as its own button and
   * its own confirmation: "archive" and "gone for ever" should not be one slip
   * apart.
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
      const res = await T.deleteTask(task._id, { purge });
      toast.success(res?.message || 'Removed.');
      changedRef.current?.(null);
      goneRef.current?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not remove that task.');
    }
  }, [task]);

  // ===== Editing in place =====

  const patch = useCallback(async (body, field) => {
    setSavingField(field);
    try {
      await T.updateTask(task._id, body);
      await refresh();
      return true;
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not save that change.');
      return false;
    } finally {
      setSavingField('');
    }
  }, [task, refresh]);

  const saveTitle = useCallback(async () => {
    const next = (titleRef.current?.value || '').trim();
    setTitling(false);
    if (!next || next === task.title) return;
    await patch({ title: next }, 'title');
  }, [task, patch]);

  const openEditor = useCallback(() => {
    setDraft({
      description: task.description || '',
      dueDate: toLocalInput(task.dueDate),
      category: task.category || '',
      points: Number(task.points) || 0,
    });
    setEditing(true);
  }, [task]);

  const saveEditor = useCallback(async () => {
    const body = {
      description: draft.description,
      category: draft.category,
      dueDate: draft.dueDate ? new Date(draft.dueDate).toISOString() : null,
    };
    // Points are money (they become an IncentiveCredit), so they are only ever
    // sent when they actually changed — a no-op PATCH of the same figure still
    // writes an EDITED row into everybody's feed.
    if (!isRequest && Number(draft.points) !== Number(task.points)) body.points = Number(draft.points);
    if (await patch(body, 'details')) {
      setEditing(false);
      toast.success('Saved.');
    }
  }, [draft, task, isRequest, patch]);

  // ===== What the header's two chips offer =====

  const statusMoves = useMemo(
    () => (can.transitions || []).map((t) => ({
      key: t.to,
      label: statusLabel(t.to, task?.kind),
      className: statusStyle(t.to),
    })),
    [can.transitions, task]
  );

  /**
   * The buttons, in the order the brief sets them out, and THE ONE PLACE this
   * file makes a decision of its own: which of `can.transitions` are already
   * drawn by a named button.
   *
   * Submit, Approve and Send back ARE transitions — the server offers
   * SUBMITTED, COMPLETED and IN_PROGRESS alongside them — and drawing both
   * would put "Mark in progress" next to "Send back" doing exactly the same
   * thing. Accepting covers IN_PROGRESS too, because accepting starts the work.
   * Whatever is left over is real and gets a button: Cancel it, Reopen, Mark
   * complete on a task the setter is doing themselves.
   */
  const actions = useMemo(() => {
    if (!task || viewOnly) return [];
    const out = [];
    const add = (key, label, icon, tone, run, title) => out.push({ key, label, icon, tone, run, title });

    if (can.canAccept) add('accept', 'Accept', FiThumbsUp, 'go', accept, 'Take it on — this also starts it');
    if (can.canDecline) add('decline', 'Decline', FiThumbsDown, 'danger', decline, 'Say why you cannot');
    if (can.canSubmit) add('submit', 'Submit', FiSend, 'send', () => ask(answerFor(STATUS.SUBMITTED)), 'Hand it in for review');
    if (can.canApprove) add('approve', 'Approve', FiCheck, 'go', () => ask(answerFor(STATUS.COMPLETED)), 'Sign it off');
    if (can.canReject) add('reject', 'Send back', FiRotateCcw, 'warn', () => ask(answerFor(STATUS.IN_PROGRESS)), 'Reopen it with what still needs doing');
    if (can.canRequestExtension) {
      add('extend', 'Ask for more time', FiClock, 'ghost', () => setExtension({ mode: 'ask' }), 'Ask to move the deadline');
    }
    /**
     * EITHER right opens it, not both.
     *
     * The modal does two things and they are gated separately on the server:
     * handing the whole task on is a DOER's move (`canDelegate` — you can only
     * pass on what you hold), while splitting it into pieces is open to anybody
     * ON the task (`canSplit`). Requiring both would take the button away from
     * the assigner who is not also doing it — which is the manager splitting
     * the CEO's task, the exact case this exists for. DelegateModal offers
     * whichever of its two modes the rights allow.
     */
    if (can.canDelegate || can.canSplit) {
      add('delegate', 'Delegate', FiCornerUpRight, 'ghost', () => setDelegating(true),
        'Hand the work down — you review it');
    }
    if (can.canTransfer) add('transfer', 'Transfer', FiUsers, 'ghost', () => setTransferring(true), 'It went to the wrong person');
    if (can.canClaim) add('claim', 'Claim', FiUserCheck, 'go', claim, 'Nobody is named on this piece');

    const covered = new Set();
    if (can.canSubmit) covered.add(STATUS.SUBMITTED);
    if (can.canApprove) covered.add(STATUS.COMPLETED);
    if (can.canReject || can.canAccept) covered.add(STATUS.IN_PROGRESS);
    for (const move of can.transitions || []) {
      if (covered.has(move.to)) continue;
      const done = isTerminal(task.status);
      const label = move.to === STATUS.CANCELLED ? (isRequest ? 'Withdraw it' : 'Cancel it')
        : done ? 'Reopen'
          : move.to === STATUS.PENDING ? (can.canWithdraw ? 'Withdraw submission' : 'Put back to pending')
            : move.to === STATUS.COMPLETED ? 'Mark complete'
              : statusLabel(move.to, task.kind);
      const icon = move.to === STATUS.CANCELLED ? FiSlash
        : move.to === STATUS.COMPLETED ? FiCheck : FiRotateCcw;
      add(`move-${move.to}`, label, icon, move.to === STATUS.CANCELLED ? 'danger' : 'ghost',
        () => ask(answerFor(move.to)));
    }

    if (can.canEdit) add('edit', 'Edit', FiEdit2, 'ghost', openEditor, 'Change the deadline, the details, the points');
    if (can.canDelete) add('remove', 'Remove', FiTrash2, 'danger', () => remove(false), 'Archive it');
    if (can.canPurge) add('purge', 'Delete', FiAlertTriangle, 'danger', () => remove(true), 'Delete for good — Super Admin only');
    return out;
  }, [task, can, viewOnly, isRequest, accept, decline, claim, remove, ask, answerFor, openEditor]);

  // ===== The feed, split three ways =====

  /**
   * THE CONVERSATION — everything anybody actually SAID, whoever they are.
   *
   * It used to be `kind === 'COMMENT'`, and that was wrong in a way nobody
   * would spot from the code: this module does not let a task move silently
   * (services/taskEngine). The note somebody writes when they hand work in,
   * accept it, decline it, approve it, send it back or ask for more time is
   * carried on THAT row, not on a separate COMMENT one. So the Comment tab was
   * hiding the most important things said about a task — the assignee's "the
   * figures are in" and the manager's "Q3 is missing" both sat under Activity,
   * behind a tab nobody opens. (Reported 2026-09-22: *"the admin and user
   * comment should be seen in the task modal, assignee and assigned people
   * both"*.)
   *
   * A row is part of the conversation when a PERSON put something on it — a
   * remark, a recording or a file. The four kinds below are excluded because
   * their note is written by the engine rather than typed by anybody:
   *
   *   PROGRESS  "Progress: 0% → 50%"      …unless they added words of their own
   *   SPLIT     "Split into 3 pieces."
   *   CLAIMED   "Megha picked this up."
   *   REMINDER  the chase the worker sent
   *
   * They stay in Activity, which is the whole record and still shows
   * everything. A status chip is drawn beside each one (see FeedRow), so
   * "handed it in — the figures are in" reads as one line rather than two.
   */
  const comments = useMemo(
    () => updates.filter((u) => {
      const kind = u.kind || 'COMMENT';
      const spoke = Boolean(String(u.note || '').trim())
        || Boolean(u.voiceNote?.storagePath)
        || (u.files || []).length > 0;
      if (!spoke) return false;
      // A recording or a file is a person either way, whatever the row is for.
      if (MACHINE_SAID.has(kind)) {
        return Boolean(u.voiceNote?.storagePath) || (u.files || []).length > 0;
      }
      return true;
    }),
    [updates]
  );
  const attachments = useMemo(
    () => [...(task?.attachments || [])].sort(
      (a, b) => new Date(b.uploadedAt || 0) - new Date(a.uploadedAt || 0)
    ),
    [task]
  );

  const openFile = useCallback(async (fileId) => {
    try {
      const url = await T.blobUrl(T.fileUrl(task._id, fileId));
      window.open(url, '_blank', 'noopener');
    } catch {
      toast.error('That file could not be opened.');
    }
  }, [task]);

  // ===== Drawing =====

  if (loading) {
    return (
      <div className={`grid gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] ${className}`}>
        <div className="space-y-4">
          <div className="h-28 animate-pulse rounded-2xl bg-gray-100" />
          <div className="h-12 animate-pulse rounded-2xl bg-gray-100" />
          <div className="h-48 animate-pulse rounded-2xl bg-gray-100" />
        </div>
        <div className="h-72 animate-pulse rounded-2xl bg-gray-100" />
      </div>
    );
  }
  /**
   * The load failed and the window stayed open to say so.
   *
   * It names the task id, because "that task no longer exists" over a list of
   * twenty is not information anybody can act on, and a support message that
   * quotes the id is worth ten that do not.
   */
  if (!task && error) {
    return (
      <div className={`rounded-2xl border border-red-200 bg-red-50 p-6 text-center ${className}`}>
        <FiAlertCircle className="mx-auto mb-3 text-red-500" size={28} />
        <p className="text-sm font-medium text-red-800">{error.message}</p>
        <p className="mt-1 font-mono text-[11px] text-red-500">
          {error.status ? `HTTP ${error.status} · ` : ''}{String(taskId || '—')}
        </p>
        <div className="mt-4 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => load({ first: true })}
            className="min-h-[40px] inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 text-sm font-medium text-white transition hover:bg-red-700"
          >
            <FiRotateCcw size={14} /> Try again
          </button>
          {onGone && (
            <button
              type="button"
              onClick={onGone}
              className="min-h-[40px] rounded-xl border border-red-200 bg-white px-4 text-sm font-medium text-red-700 transition hover:bg-red-100"
            >
              Close
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!task) return null;

  const pending = (task.extensions || []).filter((e) => e.status === 'PENDING');
  const decided = (task.extensions || []).filter((e) => e.status !== 'PENDING');

  return (
    <div className={`grid gap-4 lg:grid-cols-[minmax(0,1fr)_23rem] xl:grid-cols-[minmax(0,1fr)_26rem] ${className}`}>
      {/* ══════════════ LEFT: the task ══════════════════════════════════ */}
      <div className="min-w-0 space-y-4">
        {/* ── Header ──────────────────────────────────────────────── */}
        <section className="overflow-hidden rounded-2xl shadow-sm" style={headerStyle}>
          <div className="px-4 py-3.5 sm:px-5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px]">
              <span className="font-semibold tracking-wide" style={{ color: accent.ink }}>
                {task.code || (isRequest ? 'Request' : 'Task')}
              </span>
              {task.parentTask && (
                <button
                  type="button"
                  onClick={() => onOpenTask?.(String(task.parentTask?._id || task.parentTask))}
                  className="inline-flex items-center gap-1 rounded-lg bg-white/70 px-2 py-0.5 text-[11px] font-medium text-gray-600 min-h-[24px]"
                  title="Open the task this is a piece of"
                >
                  <FiGitBranch size={11} /> part of {task.parentCode || task.parentTitle || 'a bigger task'}
                </button>
              )}
              {task.repeat?.frequency && task.repeat.frequency !== 'ONCE' && (
                <span className="inline-flex items-center gap-1 text-gray-600">
                  <FiRepeat size={11} /> {repeatLabel(task.repeat)}
                </span>
              )}
              {refreshing && <span className="text-gray-400">updating…</span>}
            </div>

            {/* The title. A heading until somebody edits it — see the note at
                the top of this file for why it is not permanently an input. */}
            {titling ? (
              <input
                ref={titleRef}
                defaultValue={task.title}
                autoFocus
                maxLength={300}
                onBlur={saveTitle}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
                  if (e.key === 'Escape') { e.preventDefault(); setTitling(false); }
                }}
                className="mt-1.5 w-full rounded-xl border border-white/80 bg-white/80 px-3 py-1.5 text-xl font-semibold text-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-300 sm:text-2xl"
                aria-label="Task title"
              />
            ) : (
              <h1
                className={`mt-1.5 text-xl font-semibold leading-snug text-gray-900 sm:text-2xl ${
                  /* `hover:bg-gray-50`, NOT `hover:bg-white/60`: index.css's dark
                     remap matches the class ATTRIBUTE (`[class*="bg-white/"]`),
                     so a hover-only opacity utility paints a permanent grey slab
                     behind the title in dark mode. Measured. */
                  can.canEdit && !viewOnly ? 'cursor-text rounded-xl px-1 -mx-1 hover:bg-gray-50' : ''
                }`}
                onClick={() => { if (can.canEdit && !viewOnly) setTitling(true); }}
                title={can.canEdit && !viewOnly ? 'Click to rename' : undefined}
              >
                {task.title}
                {savingField === 'title' && <span className="ml-2 text-xs font-normal text-gray-500">saving…</span>}
              </h1>
            )}

            {/* One meta row: what state it is in, how much it matters, when it
                is due, what it is worth, how far along. */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <MenuChip
                label={statusLabel(task.status, task.kind)}
                className={statusStyle(task.status)}
                items={viewOnly ? [] : statusMoves}
                onPick={(key) => ask(answerFor(key))}
                title="Move this task"
              />
              <MenuChip
                label={task.priority}
                style={tintStyle(priorityColor(task.priority), { dark })}
                dot={priorityColor(task.priority).solid}
                items={can.canEdit && !viewOnly
                  ? TASK_PRIORITY.map((p) => ({
                    key: p,
                    label: p,
                    className: '',
                    style: tintStyle(priorityColor(p), { dark }),
                  }))
                  : []}
                onPick={(p) => patch({ priority: p }, 'priority')}
                title={can.canEdit ? 'Change the priority' : 'Priority'}
              />
              <OverdueChip task={task} />
              {/* One of the two, never both: `dueLabel` renders a late task as
                  "1 day overdue", which is the chip beside it said twice. The
                  full deadline is in the details grid either way. */}
              {!isOverdue(task) && <DueChip task={task} />}
              {!isRequest && <PointsChip task={task} earned={task.status === STATUS.COMPLETED} />}
              <PiecesChip task={task} />
              <TransferredChip task={task} />
              {typeof task.progress === 'number' && task.progress > 0 && (
                <ProgressBar task={task} className="min-w-[7rem]" />
              )}
            </div>
          </div>
        </section>

        {/* ── The answer buttons ──────────────────────────────────── */}
        {actions.length > 0 && (
          <section className={`${CARD} px-4 py-3 sm:px-5`}>
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={a.run}
                  title={a.title}
                  className={`${BTN} ${TONES[a.tone]}`}
                >
                  <a.icon size={14} /> {a.label}
                </button>
              ))}
            </div>
            {can.canAccept && (
              <p className="mt-2 text-xs text-gray-500">
                {task.createdByName || 'Somebody'} is waiting to hear. Accepting starts the work.
              </p>
            )}
          </section>
        )}

        {/* Everybody on it has said no. The person who set it has to act, so the
            reasons are on the page rather than buried in the feed. */}
        {task.declined && (
          <section className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="flex items-center gap-1.5 text-sm font-medium text-red-800">
              <FiAlertTriangle size={14} /> Nobody has taken this on
            </p>
            <ul className="mt-1.5 space-y-1">
              {(task.assignees || []).filter((a) => a.acceptance === 'REJECTED').map((a) => (
                <li key={a._id} className="text-xs text-red-700">
                  <strong>{a.name || personName(a.user)}:</strong> {a.declineReason || 'no reason given'}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ── Progress ────────────────────────────────────────────── */}
        {!viewOnly && can.canSetProgress && (
          <ProgressPanel task={task} can={can} accent={accent} onSaved={refresh} />
        )}

        {/* ── What was asked for ──────────────────────────────────── */}
        {(editing || task.description || task.voiceNote?.storagePath || task.links?.length > 0) && (
          <section className={`${CARD} px-4 py-4 sm:px-5`}>
            <h2 className={SECTION}><FiMessageSquare size={12} /> What was asked for</h2>

            {editing ? (
              <textarea
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                rows={5}
                maxLength={5000}
                placeholder="What needs doing?"
                className="mt-2 w-full resize-y rounded-xl border border-gray-200 px-3 py-2 text-sm"
              />
            ) : (
              task.description && (
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-gray-700">{task.description}</p>
              )
            )}

            {task.voiceNote?.storagePath && (
              <div className="mt-3">
                <p className="mb-1 text-xs text-gray-500">
                  Voice note from {task.voiceNote.recordedByName || (isRequest ? 'the asker' : 'the assigner')}
                </p>
                <VoicePlayer path={T.taskVoiceUrl(task._id)} durationMs={task.voiceNote.durationMs} />
              </div>
            )}

            {task.links?.length > 0 && (
              <ul className="mt-3 space-y-1">
                {task.links.map((l) => (
                  <li key={l._id || l.url}>
                    {/* NOT `hover:underline`: index.css restyles anything carrying
                        that class into a filled pill button. */}
                    <a
                      href={l.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="plain-link inline-flex items-center gap-1.5 text-xs accent-text"
                    >
                      <FiLink size={11} /> {l.label || l.url}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ── The facts ───────────────────────────────────────────── */}
        <section className={`${CARD} px-4 py-4 sm:px-5`}>
          {/* Wraps on a phone: in the task modal (portalled outside <main>, so
              index.css's button-row wrap never reaches it) Cancel + Save
              changes beside the heading is right at the card's width. */}
          <div className="flex flex-wrap items-center justify-between gap-y-2 sm:flex-nowrap">
            <h2 className={SECTION}><FiFlag size={12} /> Details</h2>
            {editing && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className={`${BTN} ${TONES.ghost} px-3 text-xs`}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEditor}
                  disabled={savingField === 'details'}
                  className={`${BTN} ${TONES.go} px-3 text-xs disabled:opacity-50`}
                >
                  <FiCheck size={13} /> {savingField === 'details' ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            )}
          </div>

          <div className="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2">
            <Fact icon={FiUser} label={isRequest ? 'Asked by' : 'Assigned by'}>
              {task.createdByName || personName(task.createdBy) || '—'}
              {/* Set in their name by somebody else (Task.onBehalf) — who
                  actually sent it is part of the record. */}
              {task.onBehalf?.byName && (
                <span className="block text-xs font-normal text-gray-500">
                  Sent by {task.onBehalf.byName} on their behalf
                </span>
              )}
            </Fact>

            {/* WHO SIGNS IT OFF. After a delegation this is NOT the creator —
                the person who handed the work down took the review on with it
                (models/Task.approver), and the doer needs to know whose desk
                their submission lands on. */}
            <Fact icon={FiEye} label="Reviewed by">
              {task.approverName || task.createdByName || '—'}
              {task.approverName && task.createdByName && task.approverName !== task.createdByName && (
                <span className="block text-[11px] text-gray-400">
                  took it on when the task was delegated
                </span>
              )}
            </Fact>

            {/* Deliberately NOT full width: the name and the state beside it are
                a pair, and across a 950px card they end up a hand's width
                apart with nothing between them. */}
            <Fact icon={FiUsers} label={isRequest ? 'Asked of' : 'Assigned to'}>
              {(task.assignees || []).length === 0 ? (
                <span className="text-gray-500">
                  Nobody yet — it is open for{' '}
                  {(task.openTo || []).map((u) => personName(u)).filter(Boolean).join(', ') || 'the team'}
                  {' '}to pick up
                </span>
              ) : (
                <ul className="space-y-1">
                  {(task.assignees || []).map((a) => (
                    <li key={a._id || a.user?._id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                      <span className="truncate text-gray-700">
                        {a.name || personName(a.user)}
                        {String(a.user?._id || a.user) === String(me) && (
                          <span className="ml-1 text-[11px] text-gray-400">(you)</span>
                        )}
                      </span>
                      <span className="shrink-0 text-[11px] text-gray-400">
                        {a.acceptance === 'REJECTED' ? 'declined'
                          : a.acceptance === 'AWAITING' ? 'not yet accepted'
                            : statusLabel(a.status, task.kind).toLowerCase()}
                        {Number(a.progress) > 0 && a.status !== STATUS.COMPLETED && ` · ${clampProgress(a.progress)}%`}
                        {a.completedLate && ' · late'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Fact>

            {task.loopUsers?.length > 0 && (
              <Fact icon={FiEye} label="In the loop">
                {task.loopUsers.map((u) => personName(u)).filter(Boolean).join(', ')}
              </Fact>
            )}

            <Fact icon={FiCalendar} label="Deadline">
              {editing ? (
                <input
                  type="datetime-local"
                  value={draft.dueDate}
                  onChange={(e) => setDraft({ ...draft, dueDate: e.target.value })}
                  className="min-h-[40px] w-full rounded-xl border border-gray-200 px-2 text-sm"
                />
              ) : (
                <>
                  <DueChip task={task} />
                  {task.extensionCount > 0 && (
                    <span className="block text-[11px] text-amber-600">
                      moved {task.extensionCount}× · first set for {dayLabel(task.originalDueDate)}
                    </span>
                  )}
                </>
              )}
            </Fact>

            <Fact icon={FiTag} label="Category">
              {editing ? (
                <select
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  className="min-h-[40px] w-full rounded-xl border border-gray-200 px-2 text-sm"
                >
                  <option value="">None</option>
                  {(meta?.categories || []).map((c) => (
                    <option key={c._id} value={c.name}>{c.name}</option>
                  ))}
                  {/* A task filed under a category that has since been hidden
                      still has to be able to keep it. */}
                  {task.category && !(meta?.categories || []).some((c) => c.name === task.category) && (
                    <option value={task.category}>{task.category}</option>
                  )}
                </select>
              ) : (task.category || '—')}
            </Fact>

            {!isRequest && (
              <Fact icon={FiAward} label="Worth">
                {editing ? (
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    value={draft.points}
                    onChange={(e) => setDraft({ ...draft, points: e.target.value })}
                    className="min-h-[40px] w-full rounded-xl border border-gray-200 px-2 text-sm"
                  />
                ) : (
                  <PointsLine task={task} paid={meta?.pointsArePaid} />
                )}
              </Fact>
            )}

            {task.repeat?.frequency && task.repeat.frequency !== 'ONCE' && (
              <Fact icon={FiRepeat} label="Repeats">{repeatLabel(task.repeat)}</Fact>
            )}

            {task.completedAt && (
              <Fact icon={FiCheckCircle} label="Finished">
                <span className={task.completedLate ? 'text-orange-600' : 'text-green-600'}>
                  {new Date(task.completedAt).toLocaleString('en-IN', {
                    day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
                  })}
                  {task.completedLate ? ' · delayed' : ' · in time'}
                </span>
              </Fact>
            )}

            <Fact icon={FiClock} label="Set">
              {timeAgo(task.createdAt)}
            </Fact>

            {task.reminders?.length > 0 && (
              <Fact icon={FiBell} label="Reminders">
                {task.reminders.map((r, i) => (
                  <span key={i} className="block text-[11px] text-gray-500">
                    {r.channel === 'EMAIL' ? 'Email' : 'App'} · {reminderLabel(r)}
                  </span>
                ))}
              </Fact>
            )}
          </div>
        </section>

        {/* ── The pieces ──────────────────────────────────────────── */}
        <ChildTaskList children={children} onChanged={refresh} onOpen={onOpenTask} />

        {/* ── More time ───────────────────────────────────────────── */}
        {(pending.length > 0 || decided.length > 0) && (
          <section className={`${CARD} px-4 py-4 sm:px-5`}>
            <h2 className={SECTION}><FiClock size={12} /> More time</h2>

            {pending.map((e) => (
              <div key={e._id} className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-3">
                <p className="text-sm font-medium text-amber-900">
                  {e.requestedByName || 'Somebody'} asked to move the deadline to {dayLabel(e.toDate)}
                </p>
                <p className="mt-0.5 text-xs text-amber-800">
                  {e.fromDate ? `From ${dayLabel(e.fromDate)} · ` : ''}asked {timeAgo(e.requestedAt)}
                </p>
                {e.reason && <p className="mt-1.5 whitespace-pre-wrap text-sm text-amber-900">{e.reason}</p>}

                {!viewOnly && can.canDecideExtension ? (
                  <div className="mt-2.5 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setExtension({ mode: 'decide', requestId: String(e._id), approve: true })}
                      className={`${BTN} ${TONES.go}`}
                    >
                      <FiCheck size={14} /> Give the time
                    </button>
                    <button
                      type="button"
                      onClick={() => setExtension({ mode: 'decide', requestId: String(e._id), approve: false })}
                      className={`${BTN} ${TONES.ghost}`}
                    >
                      <FiXCircle size={14} /> Decline
                    </button>
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-amber-700">
                    Waiting on {task.approverName || task.createdByName || 'whoever set it'}. The work carries on meanwhile.
                  </p>
                )}
              </div>
            ))}

            {decided.length > 0 && (
              <ul className="mt-3 space-y-2">
                {decided.map((e) => (
                  <li key={e._id} className="flex gap-2 text-xs">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                      e.status === 'APPROVED' ? 'bg-green-500' : 'bg-gray-300'
                    }`} />
                    <span className="min-w-0 flex-1 text-gray-600">
                      <span className="text-gray-700">{e.requestedByName || 'Somebody'}</span> asked for{' '}
                      {dayLabel(e.fromDate)} → {dayLabel(e.toDate)} ·{' '}
                      <span className={e.status === 'APPROVED' ? 'text-green-600' : 'text-gray-500'}>
                        {e.status === 'APPROVED' ? 'granted' : 'refused'}
                      </span>
                      {e.decidedByName ? ` by ${e.decidedByName}` : ''}
                      {e.decidedAt ? ` · ${dayLabel(e.decidedAt)}` : ''}
                      {e.reason && <span className="block text-gray-500">“{e.reason}”</span>}
                      {e.decisionNote && <span className="block text-gray-500">— {e.decisionNote}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* ── It went to the wrong person, and was put right ──────── */}
        {task.transfers?.length > 0 && (
          <section className={`${CARD} px-4 py-4 sm:px-5`}>
            <h2 className={SECTION}><FiCornerUpRight size={12} /> Handed over</h2>
            <ul className="mt-2.5 space-y-2">
              {task.transfers.map((t) => (
                <li key={t._id} className="text-xs text-gray-600">
                  <span className="text-gray-700">{t.fromName || 'Somebody'}</span>
                  <span className="text-gray-400"> → </span>
                  <span className="text-gray-700">{t.toName || 'somebody else'}</span>
                  {t.byName ? <span className="text-gray-400"> · by {t.byName}</span> : null}
                  {t.at ? <span className="text-gray-400"> · {dayLabel(t.at)}</span> : null}
                  {t.reason && <span className="block text-gray-500">{t.reason}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] text-gray-400">
              A transfer takes the previous holder off the task completely — they stop hearing about it.
            </p>
          </section>
        )}

        {/* "Ask somebody for help with this" lived here until 2026-09-25, when
            the user removed asking altogether ("remove the option for ask") —
            anybody may now simply be given a task, or this one delegated. */}
      </div>

      {/* ══════════════ RIGHT: the talk ═════════════════════════════════ */}
      <aside className="min-w-0">
        <div className={`${CARD} flex flex-col overflow-hidden lg:sticky lg:top-4`}>
          <div className="flex shrink-0 items-center gap-1 border-b border-gray-200 px-2">
            {[
              ['comment', 'Comment', FiMessageSquare, comments.length],
              ['files', 'Files', FiPaperclip, attachments.length],
              ['activity', 'Activity', FiActivity, updates.length],
            ].map(([key, label, Icon, count]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                /* Weight and the border live on the BASE class — selecting a tab
                   must not re-measure it and shuffle the strip sideways.
                   Tighter padding/gap on a phone: in the modal (outside <main>,
                   so no global wrap) three tabs with two-digit counts sat right
                   at the card's width and the last count got clipped. */
                className={`min-h-[40px] inline-flex flex-1 items-center justify-center gap-1 border-b-2 px-1.5 text-xs font-semibold transition sm:gap-1.5 sm:px-2 ${
                  tab === key
                    ? 'accent-border accent-text'
                    : 'border-transparent text-gray-500 hover:text-gray-700'
                }`}
              >
                <Icon size={13} /> {label}
                {count > 0 && <span className="text-[11px] font-normal text-gray-400">{count}</span>}
              </button>
            ))}
          </div>

          <div ref={feedRef} className="min-h-[10rem] max-h-[52vh] flex-1 overflow-y-auto px-4 py-3">
            {tab === 'files' ? (
              attachments.length === 0 ? (
                <Empty>Nothing has been attached yet.</Empty>
              ) : (
                <ul className="space-y-1.5">
                  {attachments.map((f) => (
                    <li key={f._id}>
                      <button
                        type="button"
                        onClick={() => openFile(f._id)}
                        className="flex w-full items-center gap-2 rounded-xl border border-gray-200 px-3 py-2 text-left text-xs transition hover:border-gray-400 min-h-[40px]"
                      >
                        <FiPaperclip className="shrink-0 text-gray-400" size={13} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-gray-700">{f.name}</span>
                          <span className="block truncate text-[11px] text-gray-400">
                            {[f.uploadedByName, sizeLabel(f.sizeBytes), f.uploadedAt ? timeAgo(f.uploadedAt) : '']
                              .filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <FiDownload className="shrink-0 text-gray-400" size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              (() => {
                /**
                 * OLDEST FIRST — the composer is directly underneath, so the
                 * remark somebody has just written must appear next to where
                 * they wrote it, not at the far end of the scroll.
                 *
                 * The server sends newest-first (`sort({ createdAt: -1 })`),
                 * which is right for the query — it is what a `limit` should
                 * keep — so the reversal belongs here rather than in the API.
                 * `.slice()` first: `reverse()` mutates, and `comments` and
                 * `updates` are memoised arrays that other renders share.
                 */
                const rows = (tab === 'comment' ? comments : updates).slice().reverse();
                if (!rows.length) {
                  return (
                    <Empty>
                      {tab === 'comment'
                        ? 'No remarks yet. Say something below.'
                        : 'Nothing has happened yet.'}
                    </Empty>
                  );
                }
                return (
                  <ol className="space-y-3">
                    {rows.map((u) => (
                      <FeedRow key={u._id} update={u} task={task} me={me} onOpenFile={openFile} />
                    ))}
                  </ol>
                );
              })()
            )}
          </div>

          {/* ── The composer, pinned ─────────────────────────────── */}
          {!viewOnly && can.canComment && (
            <div className="shrink-0 border-t border-gray-200 bg-gray-50/70 px-3 py-2.5">
              {answer && (
                <div className="mb-2 flex items-start gap-2 rounded-xl border border-gray-200 bg-white px-2.5 py-2">
                  <span className="mt-0.5 shrink-0 accent-text"><FiSend size={13} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-semibold text-gray-800">{answer.title}</span>
                    <span className="block text-[11px] text-gray-500">{answer.hint}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setAnswer(null)}
                    className="shrink-0 rounded-lg p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
                    aria-label="Not that — just a remark"
                  >
                    <FiX size={14} />
                  </button>
                </div>
              )}

              <textarea
                ref={noteRef}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  // Ctrl/Cmd+Enter sends, the way every chat box does. Plain
                  // Enter must not: these are paragraphs, not one-liners.
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
                }}
                rows={answer ? 3 : 2}
                maxLength={5000}
                placeholder={answer ? 'What happened?' : 'Write a remark…'}
                className="w-full resize-y rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm"
              />

              {voice && (
                <div className="mt-2">
                  <VoiceRecorder value={voice} onChange={setVoice} />
                </div>
              )}

              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((f, i) => (
                    <li key={i} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-xs">
                      <FiPaperclip className="shrink-0 text-gray-400" size={12} />
                      <span className="min-w-0 flex-1 truncate text-gray-600">{f.name}</span>
                      <button
                        type="button"
                        onClick={() => setFiles(files.filter((_, j) => j !== i))}
                        className="shrink-0 text-gray-400 hover:text-red-600"
                        aria-label={`Remove ${f.name}`}
                      >
                        <FiTrash2 size={12} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {/* flex-wrap on a phone: while recording, the compact recorder
                  becomes a full-width red bar (meter, Stop, Cancel) and pushed
                  the Send button out of the clipped card in the modal. */}
              <div className="mt-2 flex flex-wrap items-center gap-1.5 sm:flex-nowrap">
                {!voice && <VoiceRecorder value={voice} onChange={setVoice} compact />}
                <button
                  type="button"
                  onClick={() => imageRef.current?.click()}
                  title="Attach an image"
                  className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500 transition hover:border-gray-400 hover:text-blue-600"
                >
                  <FiImage size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  title="Attach a file"
                  className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl border border-gray-200 bg-white text-gray-500 transition hover:border-gray-400 hover:text-blue-600"
                >
                  <FiPaperclip size={15} />
                </button>
                <input ref={fileRef} type="file" multiple hidden onChange={pickFiles} />
                <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={pickFiles} />

                <button
                  type="button"
                  onClick={send}
                  disabled={sending}
                  /* The send button wears the answer's own colour where it has
                     one; a plain move and a plain remark are both "send". */
                  className={`${BTN} ml-auto ${
                    answer && (answer.tone === 'go' || answer.tone === 'warn')
                      ? TONES[answer.tone]
                      : TONES.send
                  } disabled:opacity-50`}
                >
                  <FiSend size={14} />
                  {sending ? 'Sending…' : (answer ? answer.verb : 'Post')}
                </button>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ══════════════ The things that open on top ═════════════════════ */}
      <ExtensionModal
        open={Boolean(extension)}
        onClose={() => setExtension(null)}
        task={task}
        can={can}
        mode={extension?.mode || 'ask'}
        requestId={extension?.requestId || null}
        initialApprove={extension?.approve}
        onDone={refresh}
      />

      {/* Hand the work DOWN — the whole thing to one person, or split into
          pieces with the points shared out. Either way the person delegating
          becomes the approver of that chain, which the modal says plainly. */}
      <DelegateModal
        open={delegating}
        onClose={() => setDelegating(false)}
        task={task}
        meta={meta}
        can={can}
        onDone={refresh}
      />

      {/* Its opposite: it went to the wrong person and comes off this one
          completely. The two are deliberately different modals. */}
      <TransferModal
        open={transferring}
        onClose={() => setTransferring(false)}
        task={task}
        meta={meta}
        onDone={refresh}
      />
    </div>
  );
}

/* ===========================================================================
 * The pieces this view is made of
 * ======================================================================== */

function Empty({ children }) {
  return <p className="py-8 text-center text-xs text-gray-400">{children}</p>;
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
 * What this task is worth, said once and properly.
 *
 * The pool and what a person actually earns stop being the same number the
 * moment the task is split, and showing only the pool promises a manager 100
 * points for work five other people are doing.
 */
function PointsLine({ task, paid }) {
  const pool = Number(task.points) || 0;
  const mine = Number.isFinite(Number(task.effectivePoints)) ? Number(task.effectivePoints) : pool;
  const shared = pool - mine;
  return (
    <>
      {shared > 0 ? `${mine} of ${pool}` : `${pool} points`}
      {shared > 0 && (
        <span className="block text-[11px] text-gray-400">
          {shared} shared out across the {task.childCount || 'other'} piece{task.childCount === 1 ? '' : 's'}
        </span>
      )}
      {paid === false && (
        <span className="block text-[11px] text-gray-400">scoring only — not paid out</span>
      )}
    </>
  );
}

/**
 * A chip that drops down — the status and the priority on the header row.
 *
 * With no items it is simply a chip: somebody who may not move a task still has
 * to be able to read what state it is in, and a dead caret on it would promise
 * a menu that never opens.
 */
function MenuChip({ label, className = '', style, dot, items = [], onPick, title }) {
  const [open, setOpen] = useState(false);
  // Viewport coordinates for the portalled menu; null until it is placed, so it
  // never paints for one frame in the top-left corner.
  const [rect, setRect] = useState(null);
  const boxRef = useRef(null);
  // The menu is NOT inside boxRef any more — it is a child of <body>. It needs
  // its own ref or the outside-click handler below would treat every click on
  // an option as an outside click and close the menu on mousedown, before the
  // option's own onClick ever fired. That is the trap this pattern always has.
  const menuRef = useRef(null);

  /**
   * Put the menu under the chip, in viewport coordinates.
   *
   * `position: fixed` rather than absolute, because the whole reason the menu
   * moved to a portal is that an ancestor clips it, and fixed coordinates are
   * the only ones that mean the same thing from inside <body>.
   */
  const place = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();

    /**
     * HAS THE CHIP GONE? Then the menu has nothing to point at.
     *
     * A portalled menu does not scroll away with the thing it belongs to — it
     * is a child of <body> now — so without this it simply hangs there. The
     * detail body scrolls inside the task modal, and scrolling the task down
     * left the status menu floating over the header of a task it was no longer
     * attached to.
     *
     * Checked HERE, synchronously, rather than with an IntersectionObserver.
     * An observer reads better, but place() already runs on every scroll and
     * resize — which is exactly when the chip can leave — so the observer would
     * be a second mechanism, delivered asynchronously on the browser's own
     * schedule, for a decision this function is already in the right place to
     * make. One mechanism, and it cannot be throttled behind the re-placement
     * it has to agree with.
     *
     * Two ways to be gone, and both matter: out of the WINDOW, and scrolled
     * out of a clipping ancestor while still nominally on screen — which is
     * the common one here, the chip sliding under the modal's own header bar.
     */
    const offScreen = r.bottom <= 0 || r.top >= window.innerHeight
      || r.right <= 0 || r.left >= window.innerWidth;
    let clipped = false;
    for (let p = el.parentElement; p && p !== document.body && !clipped; p = p.parentElement) {
      const cs = window.getComputedStyle(p);
      if (cs.overflowY === 'visible' && cs.overflowX === 'visible') continue;
      const pr = p.getBoundingClientRect();
      clipped = r.bottom <= pr.top || r.top >= pr.bottom
        || r.right <= pr.left || r.left >= pr.right;
    }
    if (offScreen || clipped) { setOpen(false); return; }
    const below = window.innerHeight - r.bottom;
    const wanted = items.length * 44 + 8;
    // Flip above when the chip sits too low for a usable menu — on a task
    // opened in the modal, the header can be most of the way down a laptop
    // screen and a menu pinned below it would be one row tall.
    const up = below < Math.min(wanted, 200) && r.top > below;
    // Wide enough to read a status in, never wider than the screen, and pulled
    // back from the right edge rather than overflowing it.
    const width = Math.min(Math.max(r.width, 176), window.innerWidth - 16);
    setRect({
      width,
      left: Math.max(8, Math.min(r.left, window.innerWidth - 8 - width)),
      // Clamped to the viewport. Following the chip on scroll means following
      // it to wherever it has got to, and an unclamped `r.bottom + 6` goes
      // NEGATIVE once the chip has scrolled off the top — the menu then paints
      // upwards across the panel's own header bar and off the screen.
      top: up ? undefined : Math.max(8, r.bottom + 6),
      bottom: up ? Math.max(8, window.innerHeight - r.top + 6) : undefined,
      maxHeight: Math.max(140, (up ? r.top : below) - 16),
    });
  }, [items.length]);


  // Before paint, so the menu's first frame is already in the right place.
  useLayoutEffect(() => { if (open) place(); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      /**
       * …AND NOTHING ELSE ACTS ON IT.
       *
       * GlobalModalEscape closes the top-most overlay on Escape and bails on
       * `e.defaultPrevented` — that is the app's convention for "this key is
       * already spoken for" (components/GlobalModalEscape). Without this,
       * dismissing the status menu inside the task modal dismissed the task
       * modal too, taking any half-typed note with it. It listens on WINDOW in
       * the bubble phase, after this document handler, so preventing here is
       * enough.
       */
      e.preventDefault();
    };
    /**
     * A menu nobody is looking at any more.
     *
     * mousedown catches a click elsewhere, but not a keyboard user tabbing on
     * or pressing Enter on another control — and Enter fires `click` without a
     * `mousedown`, so a menu could still be open when a modal opened behind
     * it. At z-110 it would then sit on top of that modal.
     */
    const onFocus = (e) => {
      if (boxRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    // `true` — capture, so scrolling of any container the chip sits in is
    // followed, not just the window. The detail panel scrolls inside the modal,
    // and without this the menu would hang in mid-air over the page.
    const onMove = () => place();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    document.addEventListener('focusin', onFocus);
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [open, place]);

  if (!items.length) {
    return (
      <span className={`${CHIP} min-h-[26px] ${className}`} style={style} title={title}>
        {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dot }} />}
        {label}
      </span>
    );
  }

  return (
    <span ref={boxRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        className={`${CHIP} min-h-[32px] cursor-pointer ${className}`}
        style={style}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dot }} />}
        {label}
        <FiChevronDown size={12} className="shrink-0 opacity-70" />
      </button>

      {/* z-[110]: above the task modal's shell (z-[100]) so the menu is not
          buried by the very panel it was opened from, and below a nested modal
          (ExtensionModal, z-[120]) so asking for more time still comes first.
          `overflow-auto` rather than hidden — the menu now has a maxHeight, and
          a list taller than the gap under the chip has to scroll. */}
      {open && rect && createPortal(
        <div
          ref={menuRef}
          className="fixed z-[110] overflow-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg"
          style={{
            left: rect.left,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
            maxHeight: rect.maxHeight,
          }}
          role="listbox"
        >
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              onClick={() => { setOpen(false); onPick?.(it.key); }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-50 min-h-[40px]"
            >
              <span className={`${CHIP} min-h-[26px] ${it.className || ''}`} style={it.style}>{it.label}</span>
            </button>
          ))}
        </div>,
        document.body
      )}
    </span>
  );
}

/**
 * How far along — declared by the person doing the work, never inferred.
 *
 * Reporting anything above 0 on a task nobody has started also STARTS it on the
 * server (services/taskEngine.setProgress), because "40% done, not started" is
 * not a state worth having. Said on the panel so the jump from To do to In
 * progress is not a surprise.
 */
function ProgressPanel({ task, can, accent, onSaved }) {
  const saved = clampProgress(can.myProgress ?? task.progress ?? 0);
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setValue(saved); }, [saved]);

  const commit = useCallback(async (next) => {
    const pct = clampProgress(next);
    setValue(pct);
    if (pct === saved) return;
    setBusy(true);
    try {
      await T.setProgress(task._id, pct);
      onSaved?.();
    } catch (err) {
      setValue(saved);
      toast.error(err?.response?.data?.message || 'Could not save that.');
    } finally {
      setBusy(false);
    }
  }, [task, saved, onSaved]);

  return (
    <section className={`${CARD} px-4 py-4 sm:px-5`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className={SECTION}><FiTrendingUp size={12} /> How far along are you?</h2>
        <span className="text-sm font-semibold tabular-nums" style={{ color: accent.solid }}>
          {value}%{busy && <span className="ml-1 text-[11px] font-normal text-gray-400">saving…</span>}
        </span>
      </div>

      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => commit(Number(e.currentTarget.value))}
        className="mt-3 w-full cursor-pointer accent-emerald-600"
        aria-label="Progress"
      />

      <div className="mt-2 flex flex-wrap gap-1.5">
        {PROGRESS_STEPS.map((step) => (
          <button
            key={step}
            type="button"
            onClick={() => commit(step)}
            /* Weight and border on the BASE class so picking one cannot resize it. */
            className={`min-h-[32px] rounded-xl border px-3 text-xs font-medium transition ${
              value === step
                ? 'border-emerald-600 bg-emerald-600 text-white'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400'
            }`}
          >
            {step}%
          </button>
        ))}
      </div>

      {saved === 0 && task.status === STATUS.PENDING && (
        <p className="mt-2 text-[11px] text-gray-400">
          Reporting anything above 0% starts this task.
        </p>
      )}
    </section>
  );
}

/**
 * One line of history.
 *
 * A status move and a remark are the same row (models/TaskUpdate); what differs
 * is the word in front of it. System rows — a reminder that fired, an
 * occurrence that was minted — are drawn quieter, because they are a record
 * rather than somebody saying something.
 */
function FeedRow({ update, task, me, onOpenFile }) {
  const words = FEED_WORDS[update.kind] || FEED_WORDS.COMMENT;
  const Icon = words.icon;
  const mine = String(update.by?._id || update.by || '') === String(me || '');
  /**
   * Did this row MOVE the task?
   *
   * Not `kind === 'STATUS'`. Since 2026-09-22 the engine words the three moves
   * people argue about for itself (services/taskEngine.FEED_KIND): a hand-in is
   * `SUBMITTED`, an approval `APPROVED`, a send-back `SENT_BACK`. Keying off
   * `STATUS` alone therefore drew the three most important rows in the feed as
   * plain remarks — no chip, no highlighted dot — which is exactly backwards.
   *
   * `to` is what actually says a status changed; `CREATED` carries one only
   * because a task starts somewhere, and it has its own wording.
   */
  const moved = Boolean(update.to) && update.kind !== 'CREATED';

  return (
    <li className={`flex gap-2.5 ${update.system ? 'opacity-60' : ''}`}>
      <span
        className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${
          mine ? 'accent-bg text-white' : 'bg-gray-100 text-gray-500'
        }`}
        title={update.byName || 'System'}
      >
        {update.system ? <Icon size={12} /> : initials(update.byName || '')}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="text-sm font-medium text-gray-800">{update.byName || 'System'}</span>
          {words.says && <span className="text-xs text-gray-500">{words.says}</span>}
          {moved && <StatusChip status={update.to} kind={task.kind} />}
          <Icon size={11} className={`shrink-0 ${words.tone}`} />
          <span className="text-[11px] text-gray-400">{timeAgo(update.createdAt)}</span>
        </div>

        {update.note && (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-600">{update.note}</p>
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
                onClick={() => onOpenFile(f._id)}
                /* Capped and ellipsed on a phone only: a long unbroken file
                   name made the chip wider than the feed column. `max-sm:`
                   rather than `truncate` / `whitespace-nowrap`, because
                   index.css keys desktop rules off those two class names. */
                className="min-h-[32px] inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2 text-[11px] text-gray-600 transition hover:border-gray-400 max-sm:max-w-full"
              >
                <FiPaperclip size={10} />
                <span className="max-sm:min-w-0 max-sm:overflow-hidden max-sm:text-ellipsis max-sm:whitespace-nowrap">{f.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}
