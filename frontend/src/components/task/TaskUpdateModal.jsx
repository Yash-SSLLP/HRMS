/**
 * "Add a note before marking this In Progress."
 *
 * NEW 2026-09-21, replacing SubmitModal. The box that opens on every status
 * move, and the single most important interaction in the module: it is the
 * reason a completed task carries a record of what was actually done rather
 * than a green tick and a shrug.
 *
 * IT WILL NOT SUBMIT EMPTY — but a VOICE NOTE counts. Somebody who would not
 * type three sentences will happily say them, and for a lot of the people this
 * portal serves the sentences come out better in their own language. The
 * server enforces the same rule (services/taskEngine), so an older client
 * cannot slip a silent completion past it.
 *
 * ── THREE MODES, ONE BOX (added 2026-09-21, second pass) ────────────────────
 *
 * The user asked for Delegate and subtasks to live on THIS screen, because it
 * is where somebody already is when they realise they cannot do the job alone.
 * So the same box does three things, and which one is decided by the strip of
 * choices under the note:
 *
 *   UPDATE    (the default) move the status, with the note attached
 *   DELEGATE  hand your own piece to somebody else — the status does NOT move,
 *             because passing work on is not progress on it
 *   PIECES    split it up. Runs ALONGSIDE the update: you can add three
 *             subtasks and mark the task In Progress in one press, which is
 *             exactly what somebody does when they start planning a big job.
 *
 * Delegate is a MODE rather than an extra button because delegating and
 * completing in the same press is incoherent — you cannot finish something you
 * have just given away — and a form that lets somebody express that has to
 * explain itself afterwards.
 *
 * The same component still handles a plain remark: pass no `to`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiX, FiPaperclip, FiImage, FiTrash2, FiSend, FiCornerUpRight, FiPlus,
  FiCheckSquare, FiUser, FiUsers,
} from 'react-icons/fi';
import { VoiceRecorder } from './VoiceNote';
import * as T from '../../api/tasks';
import { statusLabel, personName } from '../../utils/taskLifecycle';

export default function TaskUpdateModal({
  open,
  onClose,
  task,
  /** The status being moved to. Null = a plain remark. */
  to = null,
  /** People this caller may delegate to — from GET /tasks/meta. */
  meta = null,
  /** What the server says this caller may do (the detail response's `can`). */
  can = null,
  /**
   * Which mode to OPEN in — 'update' (the default) or 'delegate'.
   *
   * The detail page's Delegate button passes 'delegate' so the box opens ready
   * to hand the task on. Without it somebody presses Delegate and then has to
   * press Delegate again inside, which reads as the first press not working.
   */
  initialMode = 'update',
  onDone,
}) {
  const [note, setNote] = useState('');
  const [voice, setVoice] = useState(null);
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);

  // Delegate is a mode; pieces run alongside whatever else is happening.
  const [mode, setMode] = useState(initialMode);
  const [delegateTo, setDelegateTo] = useState('');
  const [showPieces, setShowPieces] = useState(false);
  const [pieces, setPieces] = useState([]);
  const [pieceDraft, setPieceDraft] = useState('');
  const [pieceOwner, setPieceOwner] = useState('');

  const fileRef = useRef(null);
  const imageRef = useRef(null);
  const noteRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setNote('');
    setVoice(null);
    setFiles([]);
    setMode(initialMode);
    setDelegateTo('');
    setShowPieces(false);
    setPieces([]);
    setPieceDraft('');
    setPieceOwner('');
    setTimeout(() => noteRef.current?.focus(), 80);
  }, [open, initialMode]);

  /** Who this caller may hand it to — never upward, never themselves. */
  const delegatable = useMemo(() => {
    const onIt = new Set((task?.assignees || []).map((a) => String(a.user?._id || a.user)));
    return (meta?.people || []).filter((p) => p.canAssign !== false && !onIt.has(String(p._id)));
  }, [meta, task]);

  /** Who a PIECE may be given to — the people already on the task. */
  const pieceOwners = useMemo(
    () => (task?.assignees || []).map((a) => ({
      _id: String(a.user?._id || a.user),
      name: a.name || personName(a.user),
    })),
    [task]
  );

  const pickFiles = useCallback((e) => {
    setFiles((f) => [...f, ...[...(e.target.files || [])]].slice(0, 10));
    e.target.value = '';
  }, []);

  const addPiece = useCallback(() => {
    const title = pieceDraft.trim();
    if (!title) return;
    setPieces((p) => [...p, { title, assignee: pieceOwner || undefined }].slice(0, 50));
    setPieceDraft('');
    // The owner STAYS selected: somebody splitting a job into four pieces for
    // one person should not re-pick them four times.
  }, [pieceDraft, pieceOwner]);

  const submit = useCallback(async () => {
    const said = note.trim();

    if (mode === 'delegate') {
      if (!delegateTo) { toast.error('Choose who to pass it to.'); return; }
      setSaving(true);
      try {
        // Pieces first: they belong to the task, not to whoever holds it, and
        // adding them after delegating would need a second round of permission.
        if (pieces.length) await T.addSubtasks(task._id, pieces);
        const res = await T.delegateTask(task._id, delegateTo, said);
        toast.success(`Passed to ${res.delegatedTo?.name || 'them'}.`);
        onDone?.(res);
        onClose?.();
      } catch (err) {
        toast.error(err?.response?.data?.message || 'Could not pass that task on.');
      } finally {
        setSaving(false);
      }
      return;
    }

    // A status move still has to be said out loud; adding pieces on its own
    // does not, because the pieces themselves are the record.
    if (to && !said && !voice) {
      toast.error('Say what has happened — type a line or record a voice note.');
      noteRef.current?.focus();
      return;
    }
    if (!to && !said && !voice && !files.length && !pieces.length) {
      toast.error('Write something, record something, attach a file, or add a piece.');
      return;
    }

    setSaving(true);
    try {
      if (pieces.length) await T.addSubtasks(task._id, pieces);

      let result = null;
      if (to) {
        result = await T.changeStatus(task._id, to, { note: said, voice, files });
      } else if (said || voice || files.length) {
        result = await T.addUpdate(task._id, { note: said, voice, files });
      }

      // A task that was already where it was being moved to is not an error —
      // two taps on Complete, or a phone retrying a request it never saw the
      // answer to. Say nothing rather than claiming something happened.
      if (result?.unchanged) {
        toast.info('That was already done.');
      } else if (to) {
        const earned = (result?.awarded || []).reduce((sum, a) => sum + (a.points || 0), 0);
        toast.success(
          earned > 0
            ? `Marked ${statusLabel(to, task.kind).toLowerCase()} · ${earned} points`
            : `Marked ${statusLabel(to, task.kind).toLowerCase()}.`
        );
      } else if (pieces.length && !said && !voice) {
        toast.success(`Added ${pieces.length} piece${pieces.length === 1 ? '' : 's'}.`);
      } else {
        toast.success('Added.');
      }
      onDone?.(result);
      onClose?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not save that update.');
    } finally {
      setSaving(false);
    }
  }, [note, voice, files, to, task, mode, delegateTo, pieces, onDone, onClose]);

  if (!open || !task) return null;

  const delegating = mode === 'delegate';
  const heading = delegating ? 'Pass this on' : to ? 'Task update' : 'Add a remark';
  const prompt = delegating
    ? 'They start fresh — they can accept or decline it, and you keep hearing about it.'
    : to
      ? `Please add a note before marking this ${statusLabel(to, task.kind).toLowerCase()}.`
      : 'Everyone on this task will see it.';

  const iconBtn = 'inline-flex items-center justify-center rounded-lg border border-gray-200 '
    + 'text-gray-500 transition hover:border-gray-400 hover:text-blue-600';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{heading}</h2>
            <p className="mt-0.5 text-xs text-gray-500">{prompt}</p>
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

        <div className="max-h-[calc(100vh-14rem)] space-y-3 overflow-y-auto px-5 py-4">
          <div className="relative">
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={4}
              placeholder={
                delegating ? 'Why are you passing it on? (optional)'
                  : to ? 'What has been done?' : 'Write a remark…'
              }
              className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2 pr-8 text-sm"
              maxLength={5000}
            />
            {note && (
              <button
                type="button"
                onClick={() => { setNote(''); noteRef.current?.focus(); }}
                className="absolute right-2 top-2 rounded p-1 text-gray-300 hover:text-gray-500"
                aria-label="Clear"
              >
                <FiX size={14} />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <VoiceRecorder value={voice} onChange={setVoice} compact={!voice} />
            <button type="button" onClick={() => imageRef.current?.click()} title="Attach an image"
              className={`min-h-[40px] min-w-[40px] ${iconBtn}`}>
              <FiImage size={16} />
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} title="Attach a file"
              className={`min-h-[40px] min-w-[40px] ${iconBtn}`}>
              <FiPaperclip size={16} />
            </button>
            <input ref={fileRef} type="file" multiple hidden onChange={pickFiles} />
            <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={pickFiles} />
          </div>

          {voice && <VoiceRecorder value={voice} onChange={setVoice} />}

          {files.length > 0 && (
            <div className="space-y-1">
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-gray-50 px-2 py-1.5 text-xs">
                  <FiPaperclip className="shrink-0 text-gray-400" size={12} />
                  <span className="flex-1 truncate text-gray-600">{f.name}</span>
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="shrink-0 text-gray-400 hover:text-red-600" aria-label="Remove">
                    <FiTrash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* ── Can't do it alone? ─────────────────────────────────── */}
          {(can?.canDelegate || can?.canAddSubtasks) && (
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
              {can?.canDelegate && (
                <button
                  type="button"
                  onClick={() => setMode(delegating ? 'update' : 'delegate')}
                  className={`min-h-[36px] inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition ${
                    delegating
                      ? 'border-blue-300 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-400 hover:text-blue-600'
                  }`}
                >
                  <FiCornerUpRight size={13} />
                  {delegating ? 'Passing it on' : 'Delegate'}
                </button>
              )}
              {can?.canAddSubtasks && (
                <button
                  type="button"
                  onClick={() => setShowPieces((v) => !v)}
                  className={`min-h-[36px] inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition ${
                    showPieces || pieces.length
                      ? 'border-green-300 bg-green-50 text-green-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-400 hover:text-blue-600'
                  }`}
                >
                  <FiCheckSquare size={13} />
                  Break into pieces
                  {pieces.length > 0 && <span>({pieces.length})</span>}
                </button>
              )}
            </div>
          )}

          {/* ── Delegate ───────────────────────────────────────────── */}
          {delegating && (
            <div className="space-y-2 rounded-xl border border-blue-200 bg-blue-50/50 p-3">
              <label className="flex items-center gap-1.5 text-xs font-medium text-gray-600" htmlFor="delegate-to">
                <FiUser size={12} /> Pass it to
              </label>
              <select
                id="delegate-to"
                value={delegateTo}
                onChange={(e) => setDelegateTo(e.target.value)}
                className="min-h-[40px] w-full rounded-lg border border-gray-200 px-2 text-sm"
              >
                <option value="">Choose somebody…</option>
                {delegatable.map((p) => (
                  <option key={p._id} value={p._id}>{p.name}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-500">
                Only people you could set work for in the first place — a task cannot be
                passed <em>up</em> the line any more than it can be assigned up it.
              </p>
            </div>
          )}

          {/* ── Pieces ─────────────────────────────────────────────── */}
          {showPieces && (
            <div className="space-y-2 rounded-xl border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs font-medium text-gray-600">Break it into pieces</p>

              <div className="flex flex-wrap gap-1.5">
                <input
                  value={pieceDraft}
                  onChange={(e) => setPieceDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPiece(); } }}
                  placeholder="What needs doing?"
                  className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-gray-200 px-2 text-xs"
                  maxLength={300}
                />
                <select
                  value={pieceOwner}
                  onChange={(e) => setPieceOwner(e.target.value)}
                  className="min-h-[36px] rounded-lg border border-gray-200 px-1 text-xs"
                  aria-label="Who does this piece"
                >
                  {/* The default is deliberately "anybody": the user's rule is
                      that any assignee can do any subtask unless it is named. */}
                  <option value="">Anybody</option>
                  {pieceOwners.map((p) => (
                    <option key={p._id} value={p._id}>{p.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addPiece}
                  disabled={!pieceDraft.trim()}
                  className={`min-h-[36px] min-w-[36px] ${iconBtn} shrink-0 disabled:opacity-40`}
                  aria-label="Add this piece"
                >
                  <FiPlus size={14} />
                </button>
              </div>

              {pieces.map((p, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-white px-2 py-1.5 text-xs">
                  <FiCheckSquare className="shrink-0 text-gray-300" size={12} />
                  <span className="flex-1 truncate text-gray-700">{p.title}</span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-gray-400">
                    {p.assignee
                      ? <>{<FiUser size={10} />}{pieceOwners.find((o) => o._id === p.assignee)?.name || '—'}</>
                      : <>{<FiUsers size={10} />}Anybody</>}
                  </span>
                  <button type="button" onClick={() => setPieces(pieces.filter((_, j) => j !== i))}
                    className="shrink-0 text-gray-400 hover:text-red-600" aria-label="Remove">
                    <FiX size={12} />
                  </button>
                </div>
              ))}

              {pieces.length === 0 && (
                <p className="text-[11px] text-gray-400">
                  A piece with nobody named can be ticked off by anybody on the task.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-gray-100 px-5 py-3">
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="min-h-[44px] inline-flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 px-5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {delegating ? <FiCornerUpRight size={14} /> : <FiSend size={14} />}
            {saving ? 'Saving…'
              : delegating ? 'Pass it on'
                : to ? 'Update task' : 'Add remark'}
          </button>
        </div>
      </div>
    </div>
  );
}
