/**
 * The pieces a task has been split into.
 *
 * NEW 2026-09-22, replacing the embedded checklist SubtaskList draws. A piece is
 * no longer a line in an array — it is a real task with its own owner, its own
 * deadline, its own share of the points and its own place in somebody's list —
 * so this reads as a list of tasks rather than a list of tick boxes, and a row
 * opens the piece instead of completing it. Completing one is done on the piece
 * itself by the person holding it, which is the whole reason it was made a task.
 *
 * TWO KINDS OF ROW, and the difference is whether anybody is named:
 *
 *   OWNED  somebody's name on it. Nothing to press here; it moves when they
 *          move it.
 *   OPEN   nobody named. Offered to a pool (`openTo`), and whoever presses
 *          Claim first becomes its sole assignee. The button is drawn only when
 *          the SERVER says `can.canClaim` — the pool, the company wall and the
 *          task's state all feed that answer, and re-deriving any of it here
 *          would be rule 6 broken.
 *
 * Tinted per the module's one colour rule (taskColors.accentStyle): priority
 * tint, green when done, grey and faded when called off — so a row of pieces
 * reads the same way as a row of tasks anywhere else in the portal.
 */
import { useCallback, useState } from 'react';
import { toast } from 'react-toastify';
import { FiUser, FiUsers, FiGitBranch, FiDownloadCloud } from 'react-icons/fi';
import * as T from '../../api/tasks';
import { StatusChip, OverdueChip, PointsChip, ProgressBar, DueChip } from './TaskChips';
import { accentStyle, useIsDark } from './taskColors';
import { personName } from '../../utils/taskLifecycle';

export default function ChildTaskList({ children = [], onChanged, onOpen }) {
  const dark = useIsDark();
  const [claiming, setClaiming] = useState('');

  const claim = useCallback(async (piece) => {
    setClaiming(String(piece._id));
    try {
      await T.claimTask(piece._id);
      toast.success('That piece is yours now.');
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not pick that piece up.');
    } finally {
      setClaiming('');
    }
  }, [onChanged]);

  if (!children.length) return null;

  const done = children.filter((c) => c.status === 'COMPLETED').length;
  const shared = children.reduce((sum, c) => sum + (Number(c.points) || 0), 0);

  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
          <FiGitBranch size={12} /> Pieces
          <span className="font-normal text-gray-400">
            {done} of {children.length} done
          </span>
        </h2>
        {shared > 0 && (
          <span className="text-[11px] text-gray-400 tabular-nums">
            {shared} points shared out
          </span>
        )}
      </div>

      <ul className="space-y-2">
        {children.map((piece, i) => {
          const owner = piece.assignees?.[0];
          const ownerName = owner ? (owner.name || personName(owner.user)) : '';
          const working = claiming === String(piece._id);
          return (
            <li key={piece._id}>
              <div
                role="button"
                tabIndex={0}
                /* AN ID, NOT THE ROW. The only consumer is TaskDetailBody's
                   `onOpenTask`, which TaskModal wires to
                   `setOverride(String(id))` — handed the object it stringified
                   to "[object Object]" and the piece could never be opened.
                   (2026-09-22.) */
                onClick={() => onOpen?.(String(piece._id))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpen?.(String(piece._id));
                  }
                }}
                // The rail, the tint and the hairline all come from one helper so
                // a piece and a task are never two slightly different reds.
                style={accentStyle(piece, { dark })}
                className={`w-full rounded-xl px-3 py-2.5 text-left transition ${
                  onOpen ? 'cursor-pointer hover:brightness-[.98]' : 'cursor-default'
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="mt-0.5 shrink-0 text-[11px] font-semibold tabular-nums text-gray-500">
                    {piece.serial || i + 1}.
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-900">{piece.title}</p>

                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                      {/* Whose it is. "Open" is not decoration — it is what tells
                          everybody else in the pool they may take it. */}
                      <span className="inline-flex items-center gap-1 text-[11px] text-gray-600">
                        {ownerName
                          ? <><FiUser size={10} className="shrink-0" />{ownerName}</>
                          : <><FiUsers size={10} className="shrink-0" />Open — nobody has taken it</>}
                      </span>
                      <StatusChip task={piece} />
                      <OverdueChip task={piece} />
                      <PointsChip task={piece} />
                      {piece.dueDate && <DueChip task={piece} />}
                    </div>

                    <ProgressBar task={piece} className="mt-2 w-full max-w-[16rem]" />
                  </div>

                  {piece.can?.canClaim && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); claim(piece); }}
                      disabled={working}
                      className="min-h-[36px] inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-gray-300 bg-white/80 px-3 text-xs font-medium text-gray-700 transition hover:border-green-500 hover:text-green-700 disabled:opacity-50"
                    >
                      <FiDownloadCloud size={13} />
                      {working ? 'Taking…' : 'Claim'}
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
