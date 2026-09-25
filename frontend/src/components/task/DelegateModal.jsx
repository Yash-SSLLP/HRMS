/**
 * Delegate — hand the work down, whole or in pieces.
 *
 * NEW 2026-09-22. The button that used to read "Break into pieces" is this, and
 * it now does both halves of the same idea, because they were always the same
 * idea: *give this to somebody*. Either the whole task goes to one person, or it
 * is cut up and the pieces go to several — and in both cases THE PERSON DOING
 * THE DELEGATING BECOMES THE APPROVER of what comes back.
 *
 * That last sentence is the reason the two modes share a modal rather than
 * sitting in two places. The server already works this way —
 * `POST /:id/delegate` moves `task.approver` onto the delegator, and
 * `POST /:id/split` makes them `createdBy` on every piece, which is the same
 * thing by another route — so the modal says it once, under both modes, instead
 * of leaving somebody to discover it when a submission lands in their queue.
 *
 * ── AND IT IS NOT TRANSFER ──────────────────────────────────────────────────
 *
 * Transfer (TransferModal, beside this one) corrects a mis-assignment: the
 * person it was on comes OFF, the work restarts, and the delegator hears no
 * more about it. Delegating keeps you answerable. The two buttons sit next to
 * each other, so each modal states plainly which one it is.
 *
 * ── THE POINTS LINE ─────────────────────────────────────────────────────────
 *
 * Points are money (docs/task-module.md, rule 3). What may be shared out is
 * `can.pointsBudget` — the task's pool minus whatever earlier pieces already
 * took — and the arithmetic on screen has to be the arithmetic the server will
 * do, to the point, or somebody hands out 100 and is told 96.
 *
 * So `shareOut` below is a line-for-line mirror of
 * services/taskEngine.shareOut: figures the splitter typed are honoured
 * exactly, the rest of the pool is divided among the rows they did not type
 * into, and the remainder goes to the FIRST of those rows — 100 over three is
 * 34/33/33, never 33/33/33 with a point evaporating.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiX, FiPlus, FiTrash2, FiUser, FiUsers, FiAward, FiCalendar, FiFlag,
  FiUserPlus, FiGitBranch, FiRotateCcw, FiAlertTriangle,
} from 'react-icons/fi';
import PeoplePicker from './PeoplePicker';
import * as T from '../../api/tasks';
import { TASK_PRIORITY } from '../../utils/taskLifecycle';
import { priorityColor, tintStyle, useIsDark } from './taskColors';

/**
 * How the pool comes out, mirroring services/taskEngine.shareOut exactly.
 *
 * It never throws, unlike the server's: a form that is over budget has to keep
 * rendering while it says so, and the submit button is what refuses.
 *
 * @param {Array} rows  the piece rows; `points` of '' / null / undefined = auto
 * @param {number} budget  what is left to share (`can.pointsBudget`)
 * @returns {number[]} one figure per row, in the same order
 */
export function shareOut(rows = [], budget = 0) {
  const pool = Math.max(0, Math.round(Number(budget) || 0));
  const explicit = rows.map((r) => (
    r?.points === undefined || r?.points === null || r?.points === ''
      ? null
      : Math.max(0, Math.round(Number(r.points) || 0))
  ));
  const named = explicit.reduce((sum, p) => sum + (p ?? 0), 0);

  const autoIdx = explicit.map((p, i) => (p === null ? i : -1)).filter((i) => i >= 0);
  if (!autoIdx.length) return explicit.map((p) => p ?? 0);

  // Over budget there is nothing sensible to auto-share, and the form is
  // already refusing to submit — so the auto rows show 0 rather than a negative.
  const rest = Math.max(0, pool - named);
  const base = Math.floor(rest / autoIdx.length);
  let spare = rest - base * autoIdx.length;

  const out = [...explicit];
  for (const i of autoIdx) {
    out[i] = base + (spare > 0 ? 1 : 0);
    if (spare > 0) spare -= 1;
  }
  return out.map((p) => p ?? 0);
}

let seq = 0;
/** A blank piece. `openTo` starts as the splitter's own team — see the editor. */
export const emptyPiece = (openTo = [], assignee = '') => ({
  key: `piece-${seq += 1}`,
  title: '',
  assignee,
  openTo: [...openTo],
  points: '',
  dueDate: '',
  priority: '',
});

/**
 * Has this row been started at all?
 *
 * A wholly blank row is not an error — the form opens with two of them and
 * somebody who wants one piece should not have to delete the other. It is also
 * not a piece, so it takes no share of the points: a blank row that counted
 * would show 50 beside a row that is about to be created worth 100.
 */
export const isLivePiece = (r) => Boolean(
  r && (String(r.title || '').trim() || r.assignee
    || (r.points !== '' && r.points !== null && r.points !== undefined))
);

/** The rows that are actually pieces. */
export const filledPieces = (rows = []) => rows.filter(isLivePiece);

/**
 * The rows as the server wants them.
 *
 * The computed share is sent for EVERY row, not only the typed ones, so what
 * the form showed is what gets created — the server would reach the same
 * figures, but only if nothing about the rows changed in between.
 */
export function pieceItems(rows = [], budget = 0) {
  const live = filledPieces(rows);
  const shares = shareOut(live, budget);
  return live.map((r, i) => ({
    title: r.title.trim(),
    assignee: r.assignee || undefined,
    openTo: r.assignee ? undefined : (r.openTo || []),
    points: shares[i],
    dueDate: r.dueDate ? new Date(r.dueDate).toISOString() : undefined,
    priority: r.priority || undefined,
  }));
}

const num = (v) => (v === '' || v === null || v === undefined ? null : Math.max(0, Math.round(Number(v) || 0)));

/* ===========================================================================
 * The rows, shared with the assign form
 *
 * AssignTaskModal offers "delegate it straight away", which is this same form
 * against a task that does not exist yet. Exported rather than copied: the
 * point-sharing rule is subtle enough that a second implementation of it would
 * be a second set of rounding bugs.
 * ======================================================================== */
export function PieceEditor({
  rows,
  onRows,
  budget,
  people = [],
  defaultOpenTo = [],
  maxPieces = 50,
  /** What the undistributed remainder does. The splitter is not always a doer. */
  remainderLabel = 'stays with you',
}) {
  const dark = useIsDark();
  const [oneOwner, setOneOwner] = useState(false);
  const [owner, setOwner] = useState('');

  /**
   * The share each row will actually get.
   *
   * Only the started rows are counted, and the map is back by row index, so
   * what a row shows is exactly what `pieceItems` will send for it. Sharing 100
   * across two rows when one of them is blank would show 50 beside a piece that
   * is about to be created worth the lot.
   */
  const shares = useMemo(() => {
    const liveIdx = rows.map((r, i) => (isLivePiece(r) ? i : -1)).filter((i) => i >= 0);
    const figures = shareOut(liveIdx.map((i) => rows[i]), budget);
    return new Map(liveIdx.map((rowIdx, k) => [rowIdx, figures[k]]));
  }, [rows, budget]);

  const given = [...shares.values()].reduce((sum, n) => sum + n, 0);
  const pinned = rows.reduce((sum, r) => sum + (num(r.points) ?? 0), 0);
  const over = Math.max(0, pinned - Math.max(0, Number(budget) || 0));
  const left = Math.max(0, (Number(budget) || 0) - given);

  const set = (i, patch) => onRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () => {
    if (rows.length >= maxPieces) {
      toast.info(`A task can hold ${maxPieces} pieces.`);
      return;
    }
    onRows([...rows, emptyPiece(defaultOpenTo, oneOwner ? owner : '')]);
  };
  const drop = (i) => onRows(rows.filter((_, j) => j !== i));

  /** "Same person, every piece" — one pick instead of the same pick five times. */
  const applyOwner = (id) => {
    setOwner(id);
    onRows(rows.map((r) => ({ ...r, assignee: id })));
  };
  const toggleOneOwner = (on) => {
    setOneOwner(on);
    if (!on) return;
    // Adopt whoever the first named row already has, so ticking the box does
    // not quietly throw away a choice that has been made.
    const first = rows.find((r) => r.assignee)?.assignee || owner || '';
    if (first) applyOwner(first);
  };

  return (
    <div className="space-y-3">
      {/* ── The points line ──────────────────────────────────────── */}
      <div
        className={`rounded-xl border px-3 py-2.5 ${
          over ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700">
            <FiAward size={12} /> Points
          </span>
          <span className="text-xs tabular-nums text-gray-600">
            <strong className="text-gray-900">{given}</strong> of {Math.max(0, Number(budget) || 0)} points
            shared out — <strong className="text-gray-900">{left}</strong> {remainderLabel}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-gray-500">
          {over > 0
            ? `That is ${over} point${over === 1 ? '' : 's'} more than this task has left. Lower a figure to carry on.`
            : 'Shared out equally until you type a figure. Typing one pins that piece and re-shares the rest.'}
        </p>
      </div>

      {/* ── Same person, every piece ─────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white p-3">
        <label className="flex items-center gap-2 text-xs font-medium text-gray-600">
          <input
            type="checkbox"
            checked={oneOwner}
            onChange={(e) => toggleOneOwner(e.target.checked)}
            className="rounded border-gray-300"
            style={{ accentColor: 'var(--accent)' }}
          />
          <FiUsers size={12} /> Same person, every piece
        </label>
        {oneOwner && (
          <div className="mt-2">
            <PeoplePicker
              people={people}
              value={owner}
              onChange={applyOwner}
              max={1}
              placeholder="Who gets all of them?"
            />
          </div>
        )}
      </div>

      {/* ── The pieces ───────────────────────────────────────────── */}
      {rows.map((row, i) => {
        const auto = num(row.points) === null;
        const colour = priorityColor(row.priority || 'Medium');
        return (
          <div key={row.key} className="rounded-xl border border-gray-200 bg-white p-3">
            <div className="flex items-start gap-2">
              <span
                className="mt-1 inline-flex min-h-[22px] min-w-[22px] items-center justify-center rounded-lg border text-[11px] font-semibold tabular-nums"
                style={tintStyle(colour, { dark })}
              >
                {i + 1}
              </span>
              <input
                value={row.title}
                onChange={(e) => set(i, { title: e.target.value })}
                placeholder="What is this piece?"
                maxLength={300}
                className="min-h-[40px] min-w-0 flex-1 rounded-xl border border-gray-200 px-3 text-sm"
              />
              <button
                type="button"
                onClick={() => drop(i)}
                disabled={rows.length <= 1}
                className="min-h-[40px] min-w-[40px] inline-flex shrink-0 items-center justify-center rounded-xl border border-gray-200 text-gray-400 transition hover:border-red-300 hover:text-red-600 disabled:opacity-30"
                aria-label={`Remove piece ${i + 1}`}
                title={rows.length <= 1 ? 'A split needs at least one piece' : 'Remove this piece'}
              >
                <FiTrash2 size={14} />
              </button>
            </div>

            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {/* Who does it. My team first: a piece may only go down or across,
                  and the server checks every named person separately. */}
              {oneOwner ? (
                <div className="flex min-h-[40px] items-center gap-1.5 rounded-xl border border-dashed border-gray-200 px-3 text-xs text-gray-500">
                  <FiUser size={12} />
                  {people.find((p) => String(p._id) === String(owner))?.name || 'Nobody chosen yet'}
                </div>
              ) : (
                <PeoplePicker
                  label="Who does it"
                  icon={FiUser}
                  people={people}
                  value={row.assignee}
                  onChange={(id) => set(i, { assignee: id })}
                  max={1}
                  placeholder="Leave blank to open it up"
                />
              )}

              <div>
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  <FiAward size={12} /> Points
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={0}
                    value={row.points}
                    onChange={(e) => set(i, { points: e.target.value })}
                    placeholder={shares.has(i) ? String(shares.get(i)) : '—'}
                    className="min-h-[40px] w-full min-w-0 rounded-xl border border-gray-200 px-3 text-sm tabular-nums"
                    aria-label={`Points for piece ${i + 1}`}
                  />
                  {!auto && (
                    <button
                      type="button"
                      onClick={() => set(i, { points: '' })}
                      className="min-h-[40px] min-w-[40px] inline-flex shrink-0 items-center justify-center rounded-xl border border-gray-200 text-gray-400 hover:border-gray-400 hover:text-gray-600"
                      title="Share this one out with the rest again"
                      aria-label={`Un-pin the points on piece ${i + 1}`}
                    >
                      <FiRotateCcw size={13} />
                    </button>
                  )}
                </div>
                <p className="mt-1 text-[11px] text-gray-400">
                  {!auto ? 'pinned'
                    : shares.has(i) ? `shared out · ${shares.get(i)}`
                      : 'name it first'}
                </p>
              </div>

              <div>
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  <FiCalendar size={12} /> Deadline
                </label>
                <input
                  type="datetime-local"
                  value={row.dueDate}
                  onChange={(e) => set(i, { dueDate: e.target.value })}
                  className="min-h-[40px] w-full rounded-xl border border-gray-200 px-3 text-sm"
                  aria-label={`Deadline for piece ${i + 1}`}
                />
                <p className="mt-1 text-[11px] text-gray-400">the task&apos;s, if left blank</p>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-gray-500">
                <FiFlag size={12} /> Priority
              </span>
              <select
                value={row.priority}
                onChange={(e) => set(i, { priority: e.target.value })}
                className="min-h-[40px] rounded-xl border border-gray-200 px-2 text-sm"
                aria-label={`Priority for piece ${i + 1}`}
              >
                <option value="">Same as the task</option>
                {TASK_PRIORITY.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>

            {/* ── Nobody named: the piece is open ─────────────────── */}
            {/* Only once the row is a piece at all. The form opens with two
                blank rows, and two dashed "Open to" panels before a word has
                been typed is the form shouting about a decision nobody has
                reached yet. */}
            {isLivePiece(row) && !row.assignee && !oneOwner && (
              <div className="mt-2 rounded-xl border border-dashed border-gray-300 bg-gray-50 p-3">
                <PeoplePicker
                  label="Open to"
                  icon={FiUsers}
                  people={people}
                  value={row.openTo}
                  onChange={(ids) => set(i, { openTo: ids })}
                  placeholder="Your team"
                />
                <p className="mt-1.5 text-[11px] text-gray-500">
                  Nobody is named for this piece, so it is offered to these people and
                  <strong> the first one to pick it up gets it</strong>.
                  {(row.openTo || []).length === 0 && ' Left empty, it goes to your own team.'}
                </p>
              </div>
            )}
          </div>
        );
      })}

      <button
        type="button"
        onClick={add}
        className="min-h-[40px] inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-gray-300 text-sm font-medium text-gray-600 transition hover:border-gray-400 hover:text-gray-800"
      >
        <FiPlus size={14} /> Add a piece
      </button>
    </div>
  );
}

/* ===========================================================================
 * The modal
 * ======================================================================== */
export default function DelegateModal({
  task,
  meta,
  open,
  onClose,
  onDone,
  /**
   * What the server says this caller may do. A list row carries it as
   * `task.can`; the detail response hands it over separately, so both are
   * accepted. Never re-derived here — rule 6.
   */
  can = null,
}) {
  const rights = can || task?.can || {};
  // An undefined flag means the caller did not have one to give, not "no": a
  // row fetched before this change would otherwise lose both modes at once.
  const mayGiveWhole = rights.canDelegate !== false;
  const maySplit = rights.canSplit !== false;

  const [mode, setMode] = useState('whole');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [rows, setRows] = useState([]);
  const [saving, setSaving] = useState(false);

  const team = useMemo(() => (meta?.team?.direct || []).map(String), [meta]);

  /**
   * Who work may be handed to — anybody but the people already on it. It was
   * "never upward" until 2026-09-25, when anybody became assignable; the server
   * stopped refusing it the same day (services/taskAccess).
   */
  const assignable = useMemo(() => {
    const onIt = new Set((task?.assignees || []).map((a) => String(a.user?._id || a.user)));
    return (meta?.people || []).filter((p) => !onIt.has(String(p._id)));
  }, [meta, task]);

  /** A piece may go to somebody already on the task — they own that bit of it. */
  const splitTo = useMemo(() => meta?.people || [], [meta]);

  const budget = useMemo(() => {
    const served = Number(rights.pointsBudget);
    if (Number.isFinite(served)) return served;
    return Math.max(0, (Number(task?.points) || 0) - (Number(task?.distributedPoints) || 0));
  }, [rights.pointsBudget, task]);

  // Reset on the OPENING, not on every render the deps happen to change on: the
  // parent refetches its meta while this is open, and a fresh `people` array
  // must not wipe three pieces somebody has just typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setMode(mayGiveWhole ? 'whole' : 'split');
      setTo('');
      setNote('');
      // Two rows, because one piece is not a split and somebody who wanted one
      // would have used the whole-task mode.
      setRows([emptyPiece(team), emptyPiece(team)]);
      setSaving(false);
    }
    wasOpen.current = open;
  }, [open, mayGiveWhole, team]);

  const live = filledPieces(rows);
  const pinned = rows.reduce((sum, r) => sum + (num(r.points) ?? 0), 0);
  const over = Math.max(0, pinned - budget);

  const submit = useCallback(async () => {
    if (mode === 'whole') {
      if (!to) { toast.error('Choose who to hand it to.'); return; }
      setSaving(true);
      try {
        const res = await T.delegateTask(task._id, to, note.trim());
        toast.success(`Handed to ${res.delegatedTo?.name || 'them'} — you approve it when it comes back.`);
        onDone?.(res);
        onClose?.();
      } catch (err) {
        toast.error(err?.response?.data?.message || 'Could not hand that task over.');
      } finally {
        setSaving(false);
      }
      return;
    }

    const started = filledPieces(rows);
    if (!started.length) { toast.error('Add at least one piece.'); return; }
    if (started.some((r) => !r.title.trim())) { toast.error('Give every piece a name.'); return; }

    setSaving(true);
    try {
      const res = await T.splitTask(task._id, pieceItems(rows, budget));
      const n = res.children?.length || started.length;
      toast.success(`Split into ${n} piece${n === 1 ? '' : 's'} — you approve each one.`);
      onDone?.(res);
      onClose?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not split that task up.');
    } finally {
      setSaving(false);
    }
  }, [mode, to, note, rows, budget, task, onDone, onClose]);

  if (!open || !task) return null;

  const splitting = mode === 'split';
  const blocked = saving || (splitting && (over > 0 || !live.length));

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="flex w-full max-w-2xl flex-col rounded-2xl bg-white shadow-xl">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900">Delegate this task</h2>
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
          {/* ── Which kind of delegation ─────────────────────────── */}
          {/* Two choice cards rather than a segmented pill: these labels are
              sentences, and at 375px a pill track wrapped them to 91px and 51px
              — two tabs of different heights. A grid keeps both the same size
              in one column on a phone and two side by side above that. */}
          {mayGiveWhole && maySplit && (
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                ['whole', FiUserPlus, 'Give the whole task to one person',
                  'They pick it up as it stands and it stays one task.'],
                ['split', FiGitBranch, 'Split it into pieces',
                  'Several people, a piece each, the points shared out.'],
              ].map(([key, Icon, title, blurb]) => {
                const on = mode === key;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setMode(key)}
                    aria-pressed={on}
                    // Border width and weight are on the BASE class so choosing
                    // one cannot resize the pair.
                    className={`min-h-[40px] rounded-xl border-2 p-3 text-left text-sm font-medium transition ${
                      on ? 'accent-border bg-gray-50' : 'border-gray-200 hover:border-gray-300'
                    }`}
                  >
                    <span className="flex items-center gap-1.5 text-gray-900">
                      <Icon size={14} className="shrink-0" /> {title}
                    </span>
                    <span className="mt-1 block text-[11px] font-normal text-gray-500">{blurb}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* ── Who signs it off ─────────────────────────────────── */}
          <p className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
            <strong>You will be the one to approve this.</strong>{' '}
            {splitting
              ? 'Every piece comes back to you when it is handed in, whoever set the task originally.'
              : 'When they submit it, it lands in your queue rather than with whoever set it.'}
          </p>

          {/* ── Whole ───────────────────────────────────────────── */}
          {!splitting && (
            <div className="space-y-3">
              <PeoplePicker
                label="Hand it to"
                icon={FiUser}
                people={assignable}
                value={to}
                onChange={setTo}
                max={1}
                placeholder="Choose somebody…"
                hint="Your own team first — search anyone by name, code, designation or department."
              />
              <div>
                <label className="mb-1 block text-xs font-medium text-gray-500" htmlFor="delegate-note">
                  Why are you passing it on? <span className="text-gray-400">(optional)</span>
                </label>
                <textarea
                  id="delegate-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={3}
                  maxLength={1000}
                  placeholder="Anything they need to know to pick it up…"
                  className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2 text-sm"
                />
              </div>
              <p className="text-[11px] text-gray-500">
                They start fresh — it is theirs to accept or decline — and you keep hearing
                about every move on it. A task cannot be passed <em>up</em> the line any more
                than it can be assigned up it.
              </p>
            </div>
          )}

          {/* ── Pieces ──────────────────────────────────────────── */}
          {splitting && (
            <>
              {budget <= 0 && (
                <p className="inline-flex w-full items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                  <FiAlertTriangle className="mt-0.5 shrink-0" size={13} />
                  This task has no points left to share out — the pieces will be worth nothing
                  until the task&apos;s own points are raised.
                </p>
              )}
              <PieceEditor
                rows={rows}
                onRows={setRows}
                budget={budget}
                people={splitTo}
                defaultOpenTo={team}
                maxPieces={meta?.maxPieces || 50}
                // `myProgress` is null for somebody who is not on the task: an
                // assigner splitting their own task keeps nothing themselves.
                remainderLabel={rights.myProgress === null || rights.myProgress === undefined
                  ? 'stays on the task'
                  : 'stays with you'}
              />
            </>
          )}
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
            disabled={blocked}
            className="min-h-[40px] inline-flex items-center gap-2 rounded-xl bg-green-600 px-5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {splitting ? <FiGitBranch size={14} /> : <FiUserPlus size={14} />}
            {saving
              ? 'Saving…'
              : splitting
                ? `Create ${live.length || 0} piece${live.length === 1 ? '' : 's'}`
                : 'Hand it over'}
          </button>
        </div>
      </div>
    </div>
  );
}
