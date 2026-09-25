/**
 * Assign New Task — the one form.
 *
 * NEW 2026-09-21, replacing TaskFormModal (602 lines across five collapsible
 * sections: details, people, requirements, workflow, incentive). The brief is
 * unambiguous about this screen: everything on one surface, nothing folded
 * away, and the only two fields that are always required are the title and who
 * it is for. Everything else is one tap from the icon row along the bottom —
 * a link, a file, an image, the reminders, the recording.
 *
 * ── ANYBODY, YOURSELF INCLUDED (2026-09-25) ─────────────────────────────────
 *
 * The user: *"everyone can assign task to anyone"*, *"remove the option for
 * ask"*, and *"if nobody is selected in the dropdown then it will assign to
 * that user by default"*. So there is no request mode any more — no "ask only"
 * people, no form that turns itself into something else — and an empty "Assign
 * to" box means the task is yours: the server fills it in
 * (taskController.createTask). The picker opens on the people you are most
 * likely to want (yourself, your team, your line, your department) and
 * searches everybody by name, code, designation or department.
 *
 * A task that is only yours carries no points and no review step: nobody
 * scores work they set themselves (services/taskPoints.award), and reviewing
 * your own submission is a round trip to nowhere. The form hides both rather
 * than offering switches that could not do anything.
 *
 * ── POINTS ──────────────────────────────────────────────────────────────────
 *
 * Every task is worth 100 points unless the assigner says otherwise — one
 * figure, per person on it, no split arithmetic. See models/Task.points.
 *
 * ── "ASSIGN MORE TASKS" ─────────────────────────────────────────────────────
 *
 * The toggle at the bottom keeps the form open after a successful assign and
 * clears only the parts that differ between tasks — the title, the details, the
 * recording. The people, the category, the priority and the deadline STAY,
 * because somebody setting five tasks at nine in the morning is setting them
 * for the same person for the same day, and retyping that four times is the
 * friction the whole screen exists to remove.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiX, FiPlus, FiLink, FiPaperclip, FiImage, FiBell, FiFlag, FiRepeat,
  FiCalendar, FiAward, FiUsers, FiEye, FiTag, FiTrash2, FiCheck, FiSettings,
  FiGitBranch,
} from 'react-icons/fi';
import { VoiceRecorder } from './VoiceNote';
import ReminderEditor from './ReminderEditor';
import PeoplePicker from './PeoplePicker';
import CategoryManager from './CategoryManager';
import { PieceEditor, emptyPiece, filledPieces, pieceItems } from './DelegateModal';
import { priorityColor, tintStyle, useIsDark } from './taskColors';
import * as T from '../../api/tasks';
import {
  TASK_PRIORITY, FREQUENCIES, FREQUENCY_LABELS, WEEKDAYS, WEEKDAY_NAMES,
} from '../../utils/taskLifecycle';

/** A datetime-local value for `d`, in the browser's own zone. */
function toLocalInput(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}

/** Six o'clock this evening — the deadline somebody means when they mean today. */
function defaultDue() {
  const d = new Date();
  d.setHours(18, 0, 0, 0);
  if (d < new Date()) d.setDate(d.getDate() + 1);
  return toLocalInput(d);
}

const EMPTY = {
  title: '',
  description: '',
  assignees: [],
  loopUsers: [],
  category: '',
  priority: 'Medium',
  points: 100,
  // Checked by default, matching models/Task.requiresApproval: finishing is a
  // SUBMISSION and completing it is the assigner's act. Somebody who does not
  // want to be asked has to say so, rather than the other way round — the
  // whole review column on the board depends on this being the norm.
  requiresApproval: true,
  dueDate: '',
  repeat: { frequency: 'ONCE', weekdays: [], monthDay: undefined, time: '18:00' },
  reminders: [],
  links: [],
};

export default function AssignTaskModal({
  open,
  onClose,
  onCreated,
  meta,
  prefill = null,
  /** Pre-select people — a caller that already knows who it is for. */
  presetAssignees = null,
  linkedTask = null,
}) {
  const [form, setForm] = useState(EMPTY);
  const [voice, setVoice] = useState(null);
  const [files, setFiles] = useState([]);
  const [showReminders, setShowReminders] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [addingCategory, setAddingCategory] = useState(false);
  const [categories, setCategories] = useState([]);
  const [managingCategories, setManagingCategories] = useState(false);
  const [saving, setSaving] = useState(false);
  const [more, setMore] = useState(false);

  // "Delegate it straight away" — the same rows DelegateModal collects, posted
  // to /split the moment the task exists. See the submit handler.
  const [showPieces, setShowPieces] = useState(false);
  const [pieces, setPieces] = useState([]);

  const dark = useIsDark();
  const fileRef = useRef(null);
  const imageRef = useRef(null);
  const titleRef = useRef(null);

  const set = useCallback((patch) => setForm((f) => ({ ...f, ...patch })), []);

  // ===== Opening =====
  useEffect(() => {
    if (!open) return;
    setForm({
      ...EMPTY,
      points: meta?.defaultPoints ?? 100,
      dueDate: defaultDue(),
      reminders: meta?.defaultReminders || [],
      assignees: presetAssignees || [],
      ...(prefill || {}),
      ...(prefill?.dueDate ? { dueDate: toLocalInput(prefill.dueDate) } : {}),
    });
    setVoice(null);
    setFiles([]);
    setShowReminders(false);
    setShowLinks(false);
    setLinkDraft('');
    setShowPieces(false);
    setPieces([]);
    // Focus the title: the form is useless until it has one, and the pointer
    // is already where somebody clicked to open it.
    setTimeout(() => titleRef.current?.focus(), 80);
  }, [open, prefill, presetAssignees, meta?.defaultPoints, meta?.defaultReminders]);

  useEffect(() => { setCategories(meta?.categories || []); }, [meta?.categories]);

  // ===== Whose task is it? =====
  const people = meta?.people || [];
  // Who is filling this in. `meta.me` from a current server; the row marked
  // `self` from an older one.
  const myId = String(meta?.me || people.find((p) => p.relation === 'self')?._id || '');

  /**
   * Nobody chosen, or only yourself: it is YOUR task. The server assigns an
   * empty box to its setter, gives a self-only task no points and completes it
   * without a review — so the form says so and hides what would not apply.
   */
  const selfOnly = form.assignees.length === 0
    || (form.assignees.length === 1 && String(form.assignees[0]) === myId);

  const recurring = form.repeat.frequency !== 'ONCE';

  // ===== Actions =====

  const addCategory = useCallback(async () => {
    const name = newCategory.trim();
    if (!name) return;
    setAddingCategory(true);
    try {
      const { category } = await T.createCategory(name);
      setCategories((cs) => (cs.some((c) => c._id === category._id) ? cs : [...cs, category]));
      set({ category: category.name });
      setNewCategory('');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not add that category.');
    } finally {
      setAddingCategory(false);
    }
  }, [newCategory, set]);

  const pickFiles = useCallback((e) => {
    const chosen = [...(e.target.files || [])];
    // Ten is the server's cap (routes/taskRoutes); saying so here beats a 400.
    setFiles((f) => [...f, ...chosen].slice(0, 10));
    e.target.value = '';
  }, []);

  const addLink = useCallback(() => {
    const url = linkDraft.trim();
    if (!url) return;
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    set({ links: [...form.links, { url: withScheme, label: '' }] });
    setLinkDraft('');
  }, [linkDraft, form.links, set]);

  const submit = useCallback(async () => {
    if (!form.title.trim()) { toast.error('Give the task a title.'); titleRef.current?.focus(); return; }

    // The pieces are checked here rather than after the task exists: a task
    // created and then refused its split leaves somebody looking at a row they
    // did not mean to make on its own.
    const wanted = filledPieces(pieces);
    if (wanted.some((p) => !p.title.trim())) {
      toast.error('Give every piece a name, or remove the blank one.');
      return;
    }
    const budget = selfOnly ? 0 : Number(form.points) || 0;
    const pinned = wanted.reduce(
      (sum, p) => sum + (p.points === '' || p.points === null ? 0 : Math.max(0, Math.round(Number(p.points) || 0))),
      0
    );
    if (pinned > budget) {
      toast.error(`The pieces hand out ${pinned} points and the task is only worth ${budget}.`);
      return;
    }

    setSaving(true);
    try {
      const body = {
        kind: 'TASK',
        title: form.title.trim(),
        description: form.description.trim(),
        // Left empty on purpose when nobody was picked: the server assigns it
        // to whoever set it (the brief's "assign to that user by default").
        assignees: form.assignees,
        loopUsers: form.loopUsers,
        category: form.category,
        priority: form.priority,
        points: budget,
        requiresApproval: selfOnly ? false : form.requiresApproval !== false,
        dueDate: form.dueDate ? new Date(form.dueDate).toISOString() : null,
        repeat: form.repeat,
        reminders: form.reminders,
        links: form.links,
        ...(linkedTask ? { linkedTask } : {}),
      };
      const { task } = await T.createTask(body, { voice, files });

      toast.success(
        recurring ? 'Repeating task set up.'
          : selfOnly ? 'Added to your tasks.'
            : 'Task assigned.'
      );

      /**
       * The pieces can only be cut once the task has an id, so this is a second
       * call rather than part of the create.
       *
       * It is deliberately NOT fatal. The task exists either way, and a split
       * the server refuses — somebody has left, a piece pointed upward — must
       * not read as "the task was not assigned", which is the one thing that
       * definitely did happen.
       */
      if (task?._id && wanted.length) {
        try {
          const { children } = await T.splitTask(task._id, pieceItems(pieces, budget));
          const n = children?.length || wanted.length;
          toast.success(`Split into ${n} piece${n === 1 ? '' : 's'} — you approve each one.`);
        } catch (err) {
          toast.error(
            err?.response?.data?.message
            || 'The task was assigned, but it could not be split up. Open it and split it there.'
          );
        }
      }

      onCreated?.(task);

      if (more) {
        // Keep the people, the category, the priority and the date — see the
        // docblock. Clear what is different every time.
        setForm((f) => ({ ...f, title: '', description: '', links: [] }));
        setVoice(null);
        setFiles([]);
        setPieces([]);
        setShowPieces(false);
        titleRef.current?.focus();
      } else {
        onClose?.();
      }
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not assign that task.');
    } finally {
      setSaving(false);
    }
  }, [form, selfOnly, voice, files, pieces, more, recurring, linkedTask, onCreated, onClose]);

  if (!open) return null;

  const iconBtn = 'inline-flex items-center justify-center rounded-lg border border-gray-200 '
    + 'text-gray-500 transition hover:border-gray-400 hover:text-blue-600';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="text-base font-semibold text-gray-900">
            {recurring ? 'Set a repeating task' : 'Assign New Task'}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 min-h-[32px] min-w-[32px]"
            aria-label="Close"
          >
            <FiX size={18} />
          </button>
        </div>

        <div className="max-h-[calc(100vh-13rem)] space-y-4 overflow-y-auto px-5 py-4">
          {/* ── Title & details ──────────────────────────────────── */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500" htmlFor="task-title">
              Task title
            </label>
            <input
              id="task-title"
              ref={titleRef}
              value={form.title}
              onChange={(e) => set({ title: e.target.value })}
              placeholder="e.g. Create the sales report for tax calculation"
              className="min-h-[40px] w-full rounded-xl border border-gray-200 px-3 text-sm"
              maxLength={300}
            />
          </div>

          <textarea
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
            placeholder="A short description…"
            rows={3}
            className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2 text-sm"
            maxLength={5000}
          />

          {/* ── Who, and under what ──────────────────────────────── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <PeoplePicker
              label="Assign to"
              icon={FiUsers}
              people={people}
              value={form.assignees}
              onChange={(ids) => set({ assignees: ids })}
              // "Myself" heads the list, and an empty box means the same thing
              // — the server assigns it to whoever set it.
              allowSelf
              selfId={myId}
              placeholder="Myself — or search anyone"
              hint={form.assignees.length ? null : 'Nobody chosen: it will be assigned to you.'}
            />

            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                  <FiTag size={12} /> Category
                </label>
                {/* Adding is everybody's; renaming and removing are a
                    SuperAdmin's alone — see components/task/CategoryManager. */}
                {meta?.canManageCategories && (
                  <button
                    type="button"
                    onClick={() => setManagingCategories(true)}
                    className="inline-flex items-center gap-1 rounded px-1 text-[11px] text-gray-400 hover:text-blue-600"
                    title="Rename or remove categories"
                  >
                    <FiSettings size={11} /> Manage
                  </button>
                )}
              </div>
              <select
                value={form.category}
                onChange={(e) => set({ category: e.target.value })}
                className="w-full rounded-xl border border-gray-200 px-3 text-sm min-h-[40px]"
              >
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c._id || c.name} value={c.name}>{c.name}</option>
                ))}
              </select>
              {/* The + from the brief: a category nobody has to wait for. */}
              <div className="mt-1.5 flex gap-1.5">
                <input
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } }}
                  placeholder="New category…"
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 text-xs min-h-[32px]"
                  maxLength={80}
                />
                <button
                  type="button"
                  onClick={addCategory}
                  disabled={!newCategory.trim() || addingCategory}
                  className={`min-h-[32px] min-w-[32px] ${iconBtn} shrink-0 disabled:opacity-40`}
                  aria-label="Add this category"
                >
                  <FiPlus size={14} />
                </button>
              </div>
            </div>
          </div>

          <PeoplePicker
            label="Keep in the loop"
            hint="They see it and hear about every move, without being answerable for it."
            icon={FiEye}
            people={people}
            value={form.loopUsers}
            onChange={(ids) => set({ loopUsers: ids })}
            placeholder="Nobody"
          />

          {/* ── Priority ─────────────────────────────────────────── */}
          {/* Urgent · Medium · Low, painted from the SERVER's palette
              (config/tasks.PRIORITY_COLORS, via taskColors) rather than
              Tailwind's near-misses — the pill, the row tint it produces and
              the card on the phone are then the same three colours. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
              <FiFlag size={12} /> Priority
            </span>
            {TASK_PRIORITY.map((p) => {
              const colour = priorityColor(p);
              const on = form.priority === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => set({ priority: p })}
                  // Weight and border live on the BASE class, not on the selected
                  // state, so picking one cannot resize the pill and shuffle the
                  // row — the portal-wide layout-stability rule.
                  className="min-h-[32px] inline-flex items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition"
                  style={on
                    ? { backgroundColor: colour.solid, borderColor: colour.solid, color: '#fff' }
                    : tintStyle(colour, { dark })}
                  aria-pressed={on}
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: on ? '#fff' : colour.solid }}
                  />
                  {p}
                </button>
              );
            })}
          </div>

          {/* ── Your own task: what does not apply, said once ────── */}
          {selfOnly && (
            <p className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
              This goes on <strong>your own list</strong>. You mark it done yourself — there is no
              review step, and a task you set yourself earns no points.
            </p>
          )}

          {/* ── Points ───────────────────────────────────────────── */}
          {!selfOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
                <FiAward size={12} /> Points
              </span>
              <input
                type="number"
                min={0}
                step={5}
                value={form.points}
                onChange={(e) => set({ points: e.target.value })}
                className="w-24 rounded-lg border border-gray-200 px-2 text-sm min-h-[32px]"
              />
              <span className="text-xs text-gray-400">
                each person earns this on finishing
                {meta?.pointsArePaid ? '' : ' · scoring only, not paid'}
              </span>
            </div>
          )}

          {/* ── Do you want the last word? ───────────────────────── */}
          {/* On by default. When it is on, their "Complete" is a SUBMISSION —
              the server coerces it (config/tasks.effectiveTarget) — and the row
              waits in your review queue until you approve it or send it back. */}
          {!selfOnly && (
            <label className="flex items-start gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={form.requiresApproval !== false}
                onChange={(e) => set({ requiresApproval: e.target.checked })}
                className="mt-0.5 rounded border-gray-300"
                style={{ accentColor: 'var(--accent)' }}
              />
              <span>
                I want to review this before it is marked done
                <span className="block text-[11px] text-gray-400">
                  {form.requiresApproval !== false
                    ? 'They hand it in, it waits in your review queue, and you approve it or send it back.'
                    : 'Their Complete finishes it outright — nothing comes back to you.'}
                </span>
              </span>
            </label>
          )}

          {/* ── Delegate it straight away ────────────────────────── */}
          {/* A manager who already knows the three pieces should not have to
              assign the task, find it again and split it. The rows are the same
              ones DelegateModal collects and they are POSTed to /split the
              moment the task has an id — see the submit handler. */}
          {!selfOnly && (
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
              <button
                type="button"
                onClick={() => {
                  const opening = !showPieces;
                  setShowPieces(opening);
                  // Two rows, because one piece is not a split.
                  if (opening && !pieces.length) {
                    const team = (meta?.team?.direct || []).map(String);
                    setPieces([emptyPiece(team), emptyPiece(team)]);
                  }
                }}
                className="flex w-full items-center justify-between gap-2 text-left"
              >
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-gray-700">
                  <FiGitBranch size={12} /> Delegate it straight away
                  {filledPieces(pieces).length > 0 && (
                    <span className="font-normal text-gray-400">
                      {filledPieces(pieces).length} piece{filledPieces(pieces).length === 1 ? '' : 's'}
                    </span>
                  )}
                </span>
                <span className="text-[11px] font-medium text-gray-500">
                  {showPieces ? 'Hide' : 'Split it up'}
                </span>
              </button>

              {showPieces && (
                <div className="mt-3 space-y-3">
                  <p className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-800">
                    The pieces are cut as soon as the task is assigned, and
                    <strong> you approve each one</strong> when it is handed in. What is not
                    shared out stays with the people you assigned the task to.
                  </p>
                  <PieceEditor
                    rows={pieces}
                    onRows={setPieces}
                    budget={Number(form.points) || 0}
                    people={people}
                    defaultOpenTo={(meta?.team?.direct || []).map(String)}
                    maxPieces={meta?.maxPieces || 50}
                    remainderLabel="stays on the task"
                  />
                </div>
              )}
            </div>
          )}

          {/* ── Repeat ───────────────────────────────────────────── */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-xs font-medium text-gray-500">
              <input
                type="checkbox"
                checked={recurring}
                onChange={(e) => set({
                  repeat: e.target.checked
                    ? { ...form.repeat, frequency: 'WEEKLY', weekdays: [new Date().getDay()] }
                    : { frequency: 'ONCE', weekdays: [] },
                })}
                className="rounded border-gray-300"
                style={{ accentColor: 'var(--accent)' }}
              />
              <FiRepeat size={12} /> Repeat
            </label>

            {recurring && (
              <div className="space-y-2 rounded-xl border border-gray-100 bg-gray-50 p-3">
                <select
                  value={form.repeat.frequency}
                  onChange={(e) => set({ repeat: { ...form.repeat, frequency: e.target.value } })}
                  className="w-full rounded-lg border border-gray-200 px-2 text-sm sm:w-48 min-h-[36px]"
                >
                  {FREQUENCIES.filter((f) => f !== 'ONCE').map((f) => (
                    <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
                  ))}
                </select>

                {form.repeat.frequency === 'WEEKLY' && (
                  <div>
                    <p className="mb-1 text-[11px] text-gray-500">On these days</p>
                    {/* Seven equal cells on a phone: seven 32px pills do not fit
                        the ~227px this box has at 360px and left Saturday alone
                        on a second line. From sm up, the row it always was. */}
                    <div className="grid grid-cols-7 gap-1 sm:flex">
                      {WEEKDAYS.map((d, i) => {
                        const on = (form.repeat.weekdays || []).includes(i);
                        return (
                          <button
                            key={i}
                            type="button"
                            title={WEEKDAY_NAMES[i]}
                            onClick={() => set({
                              repeat: {
                                ...form.repeat,
                                weekdays: on
                                  ? form.repeat.weekdays.filter((x) => x !== i)
                                  : [...(form.repeat.weekdays || []), i].sort(),
                              },
                            })}
                            className={`min-h-[32px] min-w-0 sm:min-w-[32px] rounded-lg border text-xs font-medium transition ${
                              on ? 'accent-border accent-bg on-accent' : 'border-gray-200 bg-white text-gray-500'
                            }`}
                          >
                            {d}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {['MONTHLY', 'YEARLY'].includes(form.repeat.frequency) && (
                  <label className="flex flex-wrap items-center gap-2 text-xs text-gray-600 sm:flex-nowrap">
                    Day of the month
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={form.repeat.monthDay || ''}
                      onChange={(e) => set({ repeat: { ...form.repeat, monthDay: Number(e.target.value) } })}
                      className="w-16 rounded-lg border border-gray-200 px-2 text-sm min-h-[32px]"
                    />
                    <span className="text-gray-400">29–31 fall on the last day of a short month</span>
                  </label>
                )}

                <label className="flex items-center gap-2 text-xs text-gray-600">
                  Due at
                  <input
                    type="time"
                    value={form.repeat.time || '18:00'}
                    onChange={(e) => set({ repeat: { ...form.repeat, time: e.target.value } })}
                    className="rounded-lg border border-gray-200 px-2 text-sm min-h-[32px]"
                  />
                </label>
              </div>
            )}
          </div>

          {/* ── When ─────────────────────────────────────────────── */}
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500" htmlFor="task-due">
              <FiCalendar size={12} />
              {/* On a repeating task the date picked is the START — the brief's
                  "this due date gets converted to a start date". */}
              {recurring ? 'Start from' : 'Due date & time'}
            </label>
            <input
              id="task-due"
              type="datetime-local"
              value={form.dueDate}
              onChange={(e) => set({ dueDate: e.target.value })}
              className="w-full rounded-xl border border-gray-200 px-3 text-sm sm:w-64 min-h-[40px]"
            />
          </div>

          {/* ── The icon row ─────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            <button type="button" onClick={() => setShowLinks((v) => !v)} title="Add a link"
              className={`${iconBtn} min-h-[40px] min-w-[40px]`}>
              <FiLink size={16} />
            </button>
            <button type="button" onClick={() => fileRef.current?.click()} title="Attach a file"
              className={`${iconBtn} min-h-[40px] min-w-[40px]`}>
              <FiPaperclip size={16} />
            </button>
            <button type="button" onClick={() => imageRef.current?.click()} title="Attach an image"
              className={`${iconBtn} min-h-[40px] min-w-[40px]`}>
              <FiImage size={16} />
            </button>
            <button type="button" onClick={() => setShowReminders((v) => !v)} title="Set reminders"
              className={`min-h-[40px] min-w-[40px] ${iconBtn} ${form.reminders.length ? 'accent-border accent-text' : ''}`}>
              <FiBell size={16} />
              {form.reminders.length > 0 && (
                <span className="ml-1 text-[11px] font-medium">{form.reminders.length}</span>
              )}
            </button>
            {/* Only the MIC lives in this row. VoiceRecorder ignores `compact`
                once it holds a recording and becomes a full player with its own
                Remove cross, so leaving it mounted here drew a second, identical
                player beside the one below the file list. The player belongs in
                one place — see the `{voice && …}` mount further down. */}
            {!voice && <VoiceRecorder value={voice} onChange={setVoice} compact />}

            <input ref={fileRef} type="file" multiple hidden onChange={pickFiles} />
            <input ref={imageRef} type="file" accept="image/*" multiple hidden onChange={pickFiles} />
          </div>

          {showLinks && (
            <div className="space-y-1.5 rounded-xl border border-gray-100 bg-gray-50 p-3">
              <div className="flex gap-1.5">
                <input
                  value={linkDraft}
                  onChange={(e) => setLinkDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink(); } }}
                  placeholder="Paste a sheet, drive folder or ticket link…"
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2 text-xs min-h-[32px]"
                />
                <button type="button" onClick={addLink} className={`min-h-[32px] min-w-[32px] ${iconBtn} shrink-0`} aria-label="Add this link">
                  <FiPlus size={14} />
                </button>
              </div>
              {form.links.map((l, i) => (
                <div key={i} className="flex items-center gap-2 text-xs">
                  <FiLink className="shrink-0 text-gray-400" size={12} />
                  <span className="flex-1 truncate text-gray-600">{l.url}</span>
                  <button type="button" onClick={() => set({ links: form.links.filter((_, j) => j !== i) })}
                    className="text-gray-400 hover:text-red-600" aria-label="Remove">
                    <FiX size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {files.length > 0 && (
            <div className="space-y-1">
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 rounded-lg bg-gray-50 px-2 py-1.5 text-xs">
                  <FiPaperclip className="shrink-0 text-gray-400" size={12} />
                  <span className="flex-1 truncate text-gray-600">{f.name}</span>
                  <span className="shrink-0 text-gray-400">{Math.round(f.size / 1024)} KB</span>
                  <button type="button" onClick={() => setFiles(files.filter((_, j) => j !== i))}
                    className="shrink-0 text-gray-400 hover:text-red-600" aria-label="Remove">
                    <FiTrash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {voice && <VoiceRecorder value={voice} onChange={setVoice} />}

          {showReminders && (
            <ReminderEditor
              value={form.reminders}
              onChange={(reminders) => set({ reminders })}
              onClose={() => setShowReminders(false)}
            />
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input
              type="checkbox"
              checked={more}
              onChange={(e) => setMore(e.target.checked)}
              className="rounded border-gray-300"
              style={{ accentColor: 'var(--accent)' }}
            />
            Assign more tasks
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-gray-200 px-4 text-sm text-gray-600 hover:bg-gray-50 min-h-[40px]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50 min-h-[40px]"
            >
              <FiCheck size={14} />
              {saving ? 'Saving…' : selfOnly ? 'Add to my tasks' : 'Assign task'}
            </button>
          </div>
        </div>
      </div>

      <CategoryManager
        open={managingCategories}
        onClose={() => setManagingCategories(false)}
        onChanged={async () => {
          // The list may have lost or renamed the one that is selected, so it
          // is reloaded and a selection that no longer exists is cleared —
          // leaving a task filed under a category nobody can see again is
          // exactly what the manage screen is there to end.
          try {
            const { categories: fresh } = await T.listCategories();
            setCategories(fresh || []);
            if (form.category && !(fresh || []).some((c) => c.name === form.category)) {
              set({ category: '' });
            }
          } catch { /* the picker keeps what it has */ }
        }}
      />
    </div>
  );
}
