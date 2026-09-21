/**
 * Managing the category list — SuperAdmin only.
 *
 * NEW 2026-09-21. Anybody can ADD a category from the + beside the picker,
 * which is deliberate: somebody filing the first task for a new project at nine
 * at night should not have to wait for an admin. The cost of that is a list
 * that collects typos and "temp", and until now there was no way to take one
 * back out. This is that way.
 *
 * REMOVING IS A SUPERADMIN'S ALONE, because adding affects the person adding
 * and removing hides the label from everybody and from every filter — a
 * company-wide decision rather than a supervisor's, the same reasoning that
 * keeps the leave hierarchy and the leaderboard's visibility SuperAdmin-only
 * (user decision, 2026-09-21).
 *
 * WHAT HAPPENS TO THE TASKS is the whole design of this screen. A task stores
 * the category's NAME, so:
 *
 *   used by nothing   really deleted, so the name is free again and the right
 *                     spelling can be created
 *   used by tasks     the server HIDES it and the tasks keep their label —
 *                     wiping `category` off two hundred rows to tidy a dropdown
 *                     is destroying records to fix a list
 *   merging           "Move them into…" refiles the tasks first, which is the
 *                     honest fix for two categories that should have been one
 *
 * The row says which of those will happen BEFORE it is pressed, because "12
 * tasks" beside a name is the only thing that makes the choice an informed one.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiX, FiTrash2, FiEdit2, FiCheck, FiTag, FiCornerDownRight, FiAlertTriangle } from 'react-icons/fi';
import { confirmDialog } from '../dialogs';
import * as T from '../../api/tasks';

export default function CategoryManager({ open, onClose, onChanged }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);   // id being renamed
  const [draft, setDraft] = useState('');
  const [merging, setMerging] = useState(null);   // id being merged away
  const [mergeTo, setMergeTo] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // `withCounts` is what makes the list honest — see the docblock.
      const { categories } = await T.listCategories({ withCounts: 1 });
      setRows(categories || []);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not load the categories.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) { load(); setEditing(null); setMerging(null); } }, [open, load]);

  const rename = useCallback(async (cat) => {
    const name = draft.trim();
    if (!name || name === cat.name) { setEditing(null); return; }
    setBusy(true);
    try {
      const { movedTasks } = await T.renameCategory(cat._id, name);
      toast.success(
        movedTasks
          ? `Renamed. ${movedTasks} task${movedTasks === 1 ? '' : 's'} moved with it.`
          : 'Renamed.'
      );
      setEditing(null);
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not rename that category.');
    } finally {
      setBusy(false);
    }
  }, [draft, load, onChanged]);

  const remove = useCallback(async (cat) => {
    const used = cat.taskCount || 0;
    const yes = await confirmDialog({
      title: `Remove "${cat.name}"?`,
      message: used
        ? `${used} task${used === 1 ? ' is' : 's are'} filed under this. It will be hidden from every `
          + 'picker and filter, and those tasks keep the label they were filed under. '
          + 'To move them somewhere else instead, use "Merge into" first.'
        : 'Nothing is filed under this, so it will be removed outright and the name freed up.',
      confirmText: used ? 'Hide it' : 'Remove it',
      tone: 'danger',
    });
    if (!yes) return;
    setBusy(true);
    try {
      const res = await T.deleteCategory(cat._id);
      toast.success(res.message || 'Removed.');
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not remove that category.');
    } finally {
      setBusy(false);
    }
  }, [load, onChanged]);

  const merge = useCallback(async (cat) => {
    const target = mergeTo.trim();
    if (!target) return;
    const used = cat.taskCount || 0;
    const yes = await confirmDialog({
      title: `Merge "${cat.name}" into "${target}"?`,
      message: `${used} task${used === 1 ? '' : 's'} will be refiled under "${target}", `
        + `and "${cat.name}" will be removed. This cannot be undone in one step.`,
      confirmText: 'Merge them',
      tone: 'danger',
    });
    if (!yes) return;
    setBusy(true);
    try {
      const res = await T.deleteCategory(cat._id, { moveTo: target, force: true });
      toast.success(res.message || 'Merged.');
      setMerging(null);
      setMergeTo('');
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not merge those categories.');
    } finally {
      setBusy(false);
    }
  }, [mergeTo, load, onChanged]);

  if (!open) return null;

  const iconBtn = 'inline-flex items-center justify-center rounded-lg border border-gray-200 '
    + 'text-gray-500 transition hover:border-gray-400 hover:text-blue-600 disabled:opacity-40';

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-gray-100 px-5 py-3">
          <div>
            <h2 className="flex items-center gap-1.5 text-base font-semibold text-gray-900">
              <FiTag size={15} /> Categories
            </h2>
            <p className="mt-0.5 text-xs text-gray-500">
              Anybody can add one. Only you can rename or remove one.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[32px] min-w-[32px] rounded-lg p-1.5 text-gray-400 hover:bg-gray-100"
            aria-label="Close"
          >
            <FiX size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => <div key={i} className="h-11 animate-pulse rounded-xl bg-gray-100" />)}
            </div>
          ) : rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No categories yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {rows.map((cat) => (
                <li key={cat._id} className="rounded-xl border border-gray-200 px-3 py-2">
                  <div className="flex items-center gap-2">
                    {editing === cat._id ? (
                      <>
                        <input
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); rename(cat); }
                            if (e.key === 'Escape') setEditing(null);
                          }}
                          autoFocus
                          maxLength={80}
                          className="min-h-[32px] min-w-0 flex-1 rounded-lg border border-gray-200 px-2 text-sm"
                        />
                        <button type="button" onClick={() => rename(cat)} disabled={busy}
                          className={`min-h-[32px] min-w-[32px] ${iconBtn}`} aria-label="Save the name">
                          <FiCheck size={14} />
                        </button>
                        <button type="button" onClick={() => setEditing(null)}
                          className="min-h-[32px] min-w-[32px] rounded-lg px-2 text-xs text-gray-500 hover:bg-gray-100">
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="min-w-0 flex-1 truncate text-sm text-gray-800">{cat.name}</span>
                        <span className={`shrink-0 text-xs ${cat.taskCount ? 'text-gray-500' : 'text-gray-300'}`}>
                          {cat.taskCount
                            ? `${cat.taskCount} task${cat.taskCount === 1 ? '' : 's'}`
                            : 'unused'}
                        </span>
                        <button
                          type="button"
                          onClick={() => { setEditing(cat._id); setDraft(cat.name); }}
                          className={`min-h-[32px] min-w-[32px] ${iconBtn}`}
                          aria-label={`Rename ${cat.name}`}
                          title="Rename — the tasks move with it"
                        >
                          <FiEdit2 size={13} />
                        </button>
                        {cat.taskCount > 0 && (
                          <button
                            type="button"
                            onClick={() => { setMerging(merging === cat._id ? null : cat._id); setMergeTo(''); }}
                            className={`min-h-[32px] min-w-[32px] ${iconBtn}`}
                            aria-label={`Merge ${cat.name} into another category`}
                            title="Merge into another category"
                          >
                            <FiCornerDownRight size={13} />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => remove(cat)}
                          disabled={busy}
                          className="min-h-[32px] min-w-[32px] inline-flex items-center justify-center rounded-lg border border-gray-200 text-gray-400 transition hover:border-red-300 hover:text-red-600 disabled:opacity-40"
                          aria-label={`Remove ${cat.name}`}
                          title={cat.taskCount ? 'Hide it — the tasks keep their label' : 'Remove it'}
                        >
                          <FiTrash2 size={13} />
                        </button>
                      </>
                    )}
                  </div>

                  {merging === cat._id && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-gray-100 pt-2">
                      <span className="text-xs text-gray-500">Move its tasks into</span>
                      <select
                        value={mergeTo}
                        onChange={(e) => setMergeTo(e.target.value)}
                        className="min-h-[32px] rounded-lg border border-gray-200 px-2 text-xs"
                      >
                        <option value="">Choose…</option>
                        {rows.filter((r) => r._id !== cat._id).map((r) => (
                          <option key={r._id} value={r.name}>{r.name}</option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => merge(cat)}
                        disabled={!mergeTo || busy}
                        className="min-h-[32px] rounded-lg bg-green-600 px-3 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-40"
                      >
                        Merge
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-start gap-2 border-t border-gray-100 px-5 py-3 text-[11px] text-gray-500">
          <FiAlertTriangle className="mt-0.5 shrink-0 text-amber-500" size={12} />
          <p>
            A category with tasks under it is <strong>hidden</strong> rather than deleted, and those
            tasks keep the label they were filed under. Merge first if you want them moved.
          </p>
        </div>
      </div>
    </div>
  );
}
