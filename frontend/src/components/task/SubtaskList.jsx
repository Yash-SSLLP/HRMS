/**
 * The pieces a task has been broken into.
 *
 * NEW 2026-09-21 (second pass), at the user's request: *"they can add subtask
 * to that task and can assign those to someone particularly per sub task, or
 * any assignee can do any subtask"*.
 *
 * TWO KINDS OF PIECE, and the difference is one nullable field:
 *
 *   NAMED     "Megha" beside it. Hers to tick (and the assigner's, who has to
 *             be able to close one out when the owner has gone quiet).
 *   OPEN      no name. ANYBODY on the task can tick it — the second half of
 *             the user's sentence, and the reason a piece does not have to be
 *             assigned to be useful.
 *
 * WHO MAY TICK WHAT IS THE SERVER'S ANSWER (services/taskAccess.canTickSubtask)
 * and this component does not re-derive it — it disables the box when the
 * server has said no and lets the server refuse anything that slips through.
 * A checkbox that looks tickable and then fails is worse than one that is
 * plainly somebody else's.
 */
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiTrash2, FiUser, FiUsers, FiCheck, FiCheckSquare, FiX,
} from 'react-icons/fi';
import * as T from '../../api/tasks';
import { personName } from '../../utils/taskLifecycle';

export default function SubtaskList({ task, can, me, onChanged, viewOnly }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState('');

  const subtasks = useMemo(
    () => [...(task.subtasks || [])].sort((a, b) => (a.order || 0) - (b.order || 0)),
    [task.subtasks]
  );

  const owners = useMemo(
    () => (task.assignees || []).map((a) => ({
      _id: String(a.user?._id || a.user),
      name: a.name || personName(a.user),
    })),
    [task.assignees]
  );

  const done = subtasks.filter((st) => st.done).length;
  const pct = subtasks.length ? Math.round((done / subtasks.length) * 100) : 0;

  /**
   * May THIS person tick THIS piece?
   *
   * Mirrors services/taskAccess.canTickSubtask exactly — a named piece is its
   * owner's or the assigner's; an open one is anybody-on-the-task's. It is
   * duplicated here only to grey the box; the server is what enforces it.
   */
  const canTick = useCallback((st) => {
    if (viewOnly) return false;
    if (!st.assignee) return Boolean(can?.canTickSubtasks);
    const ownerId = String(st.assignee?._id || st.assignee);
    return ownerId === String(me || '') || can?.role === 'assigner';
  }, [can, me, viewOnly]);

  const toggle = useCallback(async (st) => {
    setBusy(String(st._id));
    try {
      await T.setSubtask(task._id, st._id, !st.done);
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not update that piece.');
    } finally {
      setBusy('');
    }
  }, [task._id, onChanged]);

  const add = useCallback(async () => {
    const title = draft.trim();
    if (!title) return;
    setBusy('add');
    try {
      await T.addSubtasks(task._id, [{ title, assignee: owner || undefined }]);
      setDraft('');
      // The owner STAYS selected — somebody adding four pieces for one person
      // should not re-pick them four times.
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not add that piece.');
    } finally {
      setBusy('');
    }
  }, [draft, owner, task._id, onChanged]);

  const remove = useCallback(async (st) => {
    setBusy(String(st._id));
    try {
      await T.removeSubtask(task._id, st._id);
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not remove that piece.');
    } finally {
      setBusy('');
    }
  }, [task._id, onChanged]);

  if (!subtasks.length && (viewOnly || !can?.canAddSubtasks)) return null;

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <FiCheckSquare size={12} /> Pieces
          {subtasks.length > 0 && (
            <span className="font-normal text-gray-400">{done} of {subtasks.length} done</span>
          )}
        </h2>
        {can?.canAddSubtasks && !viewOnly && (
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            className="min-h-[32px] rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-600 hover:border-gray-400 hover:text-blue-600"
          >
            {adding ? 'Done adding' : 'Add a piece'}
          </button>
        )}
      </div>

      {subtasks.length > 0 && (
        <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-gray-100">
          <div
            className={`h-full rounded-full transition-[width] ${pct === 100 ? 'bg-green-500' : 'bg-blue-500'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <ul className="space-y-1">
        {subtasks.map((st) => {
          const tickable = canTick(st);
          const working = busy === String(st._id);
          return (
            <li
              key={st._id}
              className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-gray-50"
            >
              <button
                type="button"
                onClick={() => tickable && toggle(st)}
                disabled={!tickable || working}
                title={tickable
                  ? (st.done ? 'Mark as not done' : 'Mark as done')
                  : `${st.assigneeName || 'Somebody else'}'s piece`}
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition ${
                  st.done
                    ? 'border-green-600 bg-green-600 text-white'
                    : tickable
                      ? 'border-gray-300 hover:border-green-500'
                      : 'border-gray-200 bg-gray-50'
                } ${working ? 'opacity-50' : ''}`}
                aria-label={st.title}
              >
                {st.done && <FiCheck size={12} />}
              </button>

              <span className={`min-w-0 flex-1 text-sm ${st.done ? 'text-gray-400 line-through' : 'text-gray-700'}`}>
                {st.title}
              </span>

              {/* Whose piece it is. "Anybody" is not decoration — it is the
                  thing that tells the other three people they may pick it up. */}
              <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-gray-400">
                {st.assignee
                  ? <><FiUser size={10} />{st.assigneeName || '—'}</>
                  : <><FiUsers size={10} />Anybody</>}
              </span>

              {st.done && st.doneByName && (
                <span className="hidden shrink-0 text-[11px] text-gray-400 sm:inline">
                  by {st.doneByName}
                </span>
              )}

              {!viewOnly && can?.canAddSubtasks && (
                <button
                  type="button"
                  onClick={() => remove(st)}
                  disabled={working}
                  className="min-h-[28px] min-w-[28px] shrink-0 rounded text-gray-300 hover:text-red-600 disabled:opacity-40"
                  aria-label={`Remove ${st.title}`}
                >
                  <FiTrash2 size={12} />
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {adding && !viewOnly && (
        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-gray-100 pt-2">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="What needs doing?"
            autoFocus
            maxLength={300}
            className="min-h-[36px] min-w-0 flex-1 rounded-lg border border-gray-200 px-2 text-xs"
          />
          <select
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
            className="min-h-[36px] rounded-lg border border-gray-200 px-1 text-xs"
            aria-label="Who does this piece"
          >
            <option value="">Anybody</option>
            {owners.map((o) => <option key={o._id} value={o._id}>{o.name}</option>)}
          </select>
          <button
            type="button"
            onClick={add}
            disabled={!draft.trim() || busy === 'add'}
            className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center rounded-lg border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-blue-600 disabled:opacity-40"
            aria-label="Add this piece"
          >
            <FiPlus size={14} />
          </button>
        </div>
      )}

      {!subtasks.length && !adding && (
        <p className="py-2 text-xs text-gray-400">
          Not split up. A piece with nobody named can be ticked off by anybody on the task.
        </p>
      )}
    </section>
  );
}
