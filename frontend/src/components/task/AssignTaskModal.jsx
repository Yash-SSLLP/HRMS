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
 *
 * ── RECURRING (2026-09-27) ──────────────────────────────────────────────────
 *
 * The Repeat box moved to its own tab: *"need a separate tab for recurring
 * tasks, only to assign"*. With `recurring` this same form sets up (or, with
 * `scheduleId`, edits) a SCHEDULE — every N days, weekdays, the 15th or "the
 * first Monday", yearly — with its time, start and end, and its reminders
 * ("every 2 hours until done"). Nothing is raised here: each occurrence lands
 * in the doer's Tasks when it is due to appear. The one-off form keeps a link
 * to it where the Repeat box used to be.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiX, FiPlus, FiLink, FiPaperclip, FiImage, FiBell, FiFlag, FiRepeat,
  FiCalendar, FiAward, FiUsers, FiEye, FiTag, FiTrash2, FiCheck, FiSettings,
  FiGitBranch, FiUserCheck,
} from 'react-icons/fi';
import { VoiceRecorder } from './VoiceNote';
import ReminderEditor from './ReminderEditor';
import PeoplePicker from './PeoplePicker';
import CategoryManager from './CategoryManager';
import { PieceEditor, emptyPiece, filledPieces, pieceItems } from './DelegateModal';
import { priorityColor, tintStyle, useIsDark } from './taskColors';
import * as T from '../../api/tasks';
import Stepper from './Stepper';
import ReminderPattern, { repeatingRule } from './ReminderPattern';
import {
  TASK_PRIORITY, FREQUENCY_LABELS, WEEKDAYS, WEEKDAY_NAMES,
  RECUR_FREQUENCIES, NTH_WEEKS, MONTH_NAMES, DEFAULT_LEAD_DAYS, patternLabel, time12,
  reminderLabel, reminderPattern,
} from '../../utils/taskLifecycle';

const pad2 = (n) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD' for today, in the browser's own zone. */
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
/** A day stored as IST midnight → 'YYYY-MM-DD'. */
const istYmd = (d) => (d ? new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(d)) : '');
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

/**
 * "Also remind before it is due" — the offsets the recurring form offers, in
 * minutes. A rule the form did not make (an email one, one after the
 * deadline, "2 days before") is kept as it is and shown to be removed.
 */
const BEFORE_CHOICES = [
  { mins: 30, label: '30 min', rule: { amount: 30, unit: 'MINUTES' } },
  { mins: 60, label: '1 hour', rule: { amount: 1, unit: 'HOURS' } },
  { mins: 180, label: '3 hours', rule: { amount: 3, unit: 'HOURS' } },
  { mins: 1440, label: '1 day', rule: { amount: 1, unit: 'DAYS' } },
];
const UNIT_MIN = { MINUTES: 1, HOURS: 60, DAYS: 1440 };

/** A schedule's reminders, split the way the form edits them. */
function splitReminders(list = []) {
  const every = list.find((r) => r.when === 'EVERY') || null;
  const before = [];
  const other = [];
  list.forEach((r) => {
    if (r.when === 'EVERY') return;
    const mins = (Number(r.amount) || 0) * (UNIT_MIN[r.unit] || 1);
    if (r.when === 'BEFORE' && (r.channel || 'APP') === 'APP' && BEFORE_CHOICES.some((c) => c.mins === mins)) {
      before.push(mins);
    } else {
      other.push(r);
    }
  });
  return { every: every ? { ...every, pattern: reminderPattern(every) } : null, before, otherReminders: other };
}

/**
 * What a schedule is chased with until somebody chooses: a daily routine every
 * two hours until done (the user's own example); anything else once, an hour
 * before it is due.
 */
const remindersFor = (frequency) => (frequency === 'DAILY'
  ? { every: repeatingRule('HOURLY'), before: [] }
  : { every: null, before: [60] });

/** A fresh recurring pattern — daily at 6 pm from today, chased every 2 hours. */
function emptyRecur() {
  const now = new Date();
  return {
    frequency: 'DAILY',
    interval: 1,
    weekdays: [now.getDay()],
    monthlyMode: 'DATE',
    monthDay: now.getDate(),
    nthWeek: 1,
    weekday: 1,
    month: now.getMonth() + 1,
    time: '18:00',
    startDate: todayYmd(),
    until: '',
    ...remindersFor('DAILY'),
    otherReminders: [],
    // Until the reminders are touched, choosing a frequency re-picks them.
    remindersTouched: false,
  };
}

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
  // Whose task this is, when it is set on somebody else's behalf — see below.
  onBehalfOf: '',
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
  /** Set up a RECURRING task instead (2026-09-27) — and, with an id, edit one. */
  recurring: recurringProp = false,
  scheduleId = null,
}) {
  const [form, setForm] = useState(EMPTY);
  // Which form this is — decided by WHERE it was opened. Recurring tasks are
  // set up from the Recurring tab only (2026-09-27): the one-off form never
  // turns into a schedule, not from a link and not from a template's repeat.
  const recurringMode = Boolean(recurringProp);
  /**
   * SETTING REMINDERS IS A GRANT (2026-09-28 — "to set notification for a task
   * it should be as Permission based"). Without it neither Reminders section is
   * drawn and none are sent, so the server applies the company's defaults —
   * which it would do anyway, ignoring anything sent by somebody not granted.
   */
  const canRemind = Boolean(meta?.canSetReminders);
  const [recur, setRecurState] = useState(emptyRecur);
  const setRecur = useCallback((patch) => setRecurState((r) => ({ ...r, ...patch })), []);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
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
    // A template saved with a repeat keeps its pattern for the Recurring tab;
    // opened here as a one-off it is sent as ONCE (submit).
    setRecurState(() => {
      const base = emptyRecur();
      const rp = prefill?.repeat;
      if (!rp || !rp.frequency || rp.frequency === 'ONCE') return base;
      return {
        ...base,
        frequency: rp.frequency,
        ...(rp.interval ? { interval: rp.interval } : {}),
        ...(rp.weekdays?.length ? { weekdays: rp.weekdays } : {}),
        ...(rp.monthlyMode ? { monthlyMode: rp.monthlyMode } : {}),
        ...(rp.monthDay ? { monthDay: rp.monthDay } : {}),
        ...(rp.nthWeek ? { nthWeek: rp.nthWeek } : {}),
        ...(Number.isInteger(rp.weekday) ? { weekday: rp.weekday } : {}),
        ...(rp.month ? { month: rp.month } : {}),
        ...(rp.time ? { time: rp.time } : {}),
        ...remindersFor(rp.frequency),
      };
    });
    // Focus the title: the form is useless until it has one, and the pointer
    // is already where somebody clicked to open it.
    setTimeout(() => titleRef.current?.focus(), 80);
  }, [open, prefill, presetAssignees, meta?.defaultPoints, meta?.defaultReminders, recurringProp]);

  // ===== Editing a schedule: fill the form with it =====
  useEffect(() => {
    if (!open || !scheduleId) return undefined;
    let live = true;
    setLoadingSchedule(true);
    T.getRecurring(scheduleId)
      .then(({ schedule: sc }) => {
        if (!live || !sc) return;
        setForm((f) => ({
          ...f,
          title: sc.title || '',
          description: sc.description || '',
          assignees: (sc.assignees || []).map((u) => String(u?._id || u)),
          loopUsers: (sc.loopUsers || []).map((u) => String(u?._id || u)),
          category: sc.category || '',
          priority: sc.priority || 'Medium',
          points: sc.points ?? 0,
          requiresApproval: sc.requiresApproval !== false,
          links: (sc.links || []).map((l) => ({ url: l.url, label: l.label || '' })),
        }));
        setRecurState({
          ...emptyRecur(),
          frequency: sc.frequency || 'DAILY',
          interval: sc.interval || 1,
          ...(sc.weekdays?.length ? { weekdays: sc.weekdays } : {}),
          monthlyMode: sc.monthlyMode || 'DATE',
          ...(sc.monthDay ? { monthDay: sc.monthDay } : {}),
          ...(sc.nthWeek ? { nthWeek: sc.nthWeek } : {}),
          ...(Number.isInteger(sc.weekday) ? { weekday: sc.weekday } : {}),
          ...(sc.month ? { month: sc.month } : {}),
          time: sc.time || '18:00',
          startDate: istYmd(sc.startDate) || todayYmd(),
          until: istYmd(sc.until),
          ...splitReminders(sc.reminders || []),
          remindersTouched: true,
        });
      })
      .catch((err) => { toast.error(err?.response?.data?.message || 'Could not open that schedule.'); onClose?.(); })
      .finally(() => { if (live) setLoadingSchedule(false); });
    return () => { live = false; };
  }, [open, scheduleId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setCategories(meta?.categories || []); }, [meta?.categories]);

  // ===== Whose task is it? =====
  const people = meta?.people || [];
  // Who is filling this in. `meta.me` from a current server; the row marked
  // `self` from an older one.
  const myId = String(meta?.me || people.find((p) => p.relation === 'self')?._id || '');

  /**
   * ON SOMEBODY ELSE'S BEHALF (user request 2026-09-25) — offered only to
   * somebody a Super Admin granted it (meta.canAssignOnBehalf); the server
   * refuses the field from anybody else. The task goes out in THEIR name: they
   * are its setter and approve it, and an empty "Assign to" means theirs, not
   * mine. Naming yourself is just an ordinary task.
   */
  const onBehalf = meta?.canAssignOnBehalf && form.onBehalfOf && String(form.onBehalfOf) !== myId
    ? String(form.onBehalfOf) : '';
  const onBehalfName = onBehalf
    ? (people.find((p) => String(p._id) === onBehalf)?.name || 'them') : '';
  /** Whose task an empty box, or only this person, makes it. */
  const setterId = onBehalf || myId;

  /**
   * Nobody chosen, or only yourself: it is YOUR task. The server assigns an
   * empty box to its setter, gives a self-only task no points and completes it
   * without a review — so the form says so and hides what would not apply.
   */
  const selfOnly = form.assignees.length === 0
    || (form.assignees.length === 1 && String(form.assignees[0]) === setterId);

  // Only ever the Recurring tab's form: a template saved with a repeat opened
  // here is sent as a one-off (see submit).
  const recurring = recurringMode;
  // A daily schedule is ROUTINE — only ever marked done, no review.
  const routine = recurringMode && recur.frequency === 'DAILY';

  /** The schedule as the server stores it — and as the preview reads it. */
  const pattern = {
    frequency: recur.frequency,
    ...(recur.frequency === 'DAILY' ? { interval: recur.interval } : {}),
    ...(recur.frequency === 'WEEKLY' ? { weekdays: recur.weekdays } : {}),
    ...(recur.frequency === 'MONTHLY' ? {
      monthlyMode: recur.monthlyMode,
      ...(recur.monthlyMode === 'WEEKDAY' ? { nthWeek: recur.nthWeek, weekday: recur.weekday } : { monthDay: recur.monthDay }),
    } : {}),
    ...(recur.frequency === 'YEARLY' ? { month: recur.month, monthDay: recur.monthDay } : {}),
    time: recur.time || '18:00',
  };
  const leadDays = DEFAULT_LEAD_DAYS[recur.frequency] ?? 0;

  /**
   * How long each occurrence is on their list before it is due. A "before"
   * reminder earlier than that could never go — it would fall before the task
   * exists (a daily 6 PM task appears at 9 AM: "1 day before" is never sent).
   */
  const lifetimeMin = (() => {
    const [h, m] = String(recur.time || '18:00').split(':').map((n) => parseInt(n, 10) || 0);
    const due = h * 60 + m;
    if (leadDays) return leadDays * 1440 + due - 9 * 60;
    return due < 10 * 60 ? 60 : due - 9 * 60;
  })();
  /** A new weekly or monthly reminder starts on the task's own days. */
  const reminderHints = {
    firstBeatAfter: (() => {
      if (leadDays) return null;
      const [h, m] = String(recur.time || '18:00').split(':').map((n) => parseInt(n, 10) || 0);
      const due = h * 60 + m;
      const after = (due < 10 * 60 ? due - 60 : 9 * 60) + 30;
      return `${String(Math.floor(after / 60)).padStart(2, '0')}:${String(after % 60).padStart(2, '0')}`;
    })(),
    ...(recur.frequency === 'WEEKLY' ? { weekdays: recur.weekdays } : {}),
    ...(recur.frequency === 'MONTHLY' ? {
      monthlyMode: recur.monthlyMode, monthDay: recur.monthDay, nthWeek: recur.nthWeek, weekday: recur.weekday,
    } : {}),
  };

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

  /** RECURRING: save the schedule. Nothing is raised here — see the docblock. */
  const submitRecurring = useCallback(async () => {
    if (!form.title.trim()) { toast.error('Give the task a title.'); titleRef.current?.focus(); return; }
    if (recur.frequency === 'WEEKLY' && !(recur.weekdays || []).length) {
      toast.error('Pick at least one day of the week.');
      return;
    }
    if (recur.until && recur.until < recur.startDate) {
      toast.error('The end date is before the start date.');
      return;
    }
    const every = canRemind ? recur.every : null;
    if (every && reminderPattern(every) === 'WEEKLY' && !(every.weekdays || []).length) {
      toast.error('Pick at least one day for the reminder — or turn it off.');
      return;
    }
    if (every && reminderPattern(every) === 'HOURLY' && every.from && every.to && !(every.from < every.to)) {
      toast.error('The reminder window has to end after it starts.');
      return;
    }
    setSaving(true);
    try {
      const body = {
        title: form.title.trim(),
        description: form.description.trim(),
        assignees: form.assignees,
        loopUsers: form.loopUsers,
        category: form.category,
        priority: form.priority,
        points: selfOnly ? 0 : Number(form.points) || 0,
        requiresApproval: selfOnly || routine ? false : form.requiresApproval !== false,
        links: form.links,
        ...pattern,
        startDate: recur.startDate,
        until: recur.until || null,
        // Only from somebody holding the reminder grant (2026-09-28); without
        // it the server gives the schedule its defaults.
        ...(canRemind ? {
          reminders: [
            ...(every ? [every] : []),
            ...recur.before.map((mins) => ({
              channel: 'APP', when: 'BEFORE', ...(BEFORE_CHOICES.find((c) => c.mins === mins)?.rule || { amount: mins, unit: 'MINUTES' }),
            })),
            ...recur.otherReminders,
          ],
        } : {}),
        ...(onBehalf && !scheduleId ? { onBehalfOf: onBehalf } : {}),
      };
      const res = scheduleId
        ? await T.updateRecurring(scheduleId, body, { voice })
        : await T.createRecurring(body, { voice });
      toast.success(res?.message || (scheduleId ? 'Recurring task saved.' : 'Recurring task set up.'));
      onCreated?.(res?.schedule, { recurring: true });
      onClose?.();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not save the recurring task.');
    } finally {
      setSaving(false);
    }
  }, [form, recur, pattern, selfOnly, routine, onBehalf, scheduleId, voice, onCreated, onClose, canRemind]);

  const submit = useCallback(async () => {
    if (recurringMode) { submitRecurring(); return; }
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
        // A one-off, always: repeating tasks are set up on Recurring Tasks.
        repeat: { frequency: 'ONCE' },
        // The reminder grant's (2026-09-28): nothing sent without it, and the
        // task gets the company's defaults.
        ...(canRemind ? { reminders: form.reminders } : {}),
        links: form.links,
        ...(linkedTask ? { linkedTask } : {}),
        ...(onBehalf ? { onBehalfOf: onBehalf } : {}),
      };
      const { task } = await T.createTask(body, { voice, files });

      toast.success(
        recurring ? 'Repeating task set up.'
          : selfOnly ? (onBehalf ? `Added to ${onBehalfName}'s tasks.` : 'Added to your tasks.')
            : onBehalf ? `Task assigned on behalf of ${onBehalfName}. It is on their list now, not yours.` : 'Task assigned.'
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
      if (task?._id && wanted.length && !onBehalf) {
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
  }, [form, selfOnly, onBehalf, onBehalfName, voice, files, pieces, more, recurring, linkedTask, onCreated, onClose,
    recurringMode, submitRecurring, canRemind]);

  if (!open) return null;

  const iconBtn = 'inline-flex items-center justify-center rounded-lg border border-gray-200 '
    + 'text-gray-500 transition hover:border-gray-400 hover:text-blue-600';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center">
      <div className="w-full max-w-2xl rounded-2xl bg-white shadow-xl">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
            {recurringMode && <FiRepeat size={16} className="text-gray-400" />}
            {recurringMode ? (scheduleId ? 'Edit recurring task' : 'New recurring task')
              : recurring ? 'Set a repeating task' : 'Assign New Task'}
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

        <div className={`max-h-[calc(100vh-13rem)] space-y-4 overflow-y-auto px-5 py-4 transition-opacity ${loadingSchedule ? 'opacity-50' : ''}`}>
          {recurringMode && (
            <p className="flex items-start gap-2 rounded-xl border px-3 py-2 text-xs accent-border" style={{ background: 'color-mix(in srgb, var(--accent) 7%, transparent)' }}>
              <FiRepeat size={14} className="mt-0.5 shrink-0 accent-text" />
              <span className="text-gray-700">
                Set it up once. Each time it comes round it lands in their Tasks on its own
                {leadDays ? ` — ${leadDays} days before it is due` : ''}. Nothing is sent today unless one is due today.
              </span>
            </p>
          )}
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

          {/* ── On whose behalf ──────────────────────────────────── */}
          {/* Not when editing a schedule — whose it is was settled when it was set. */}
          {meta?.canAssignOnBehalf && !scheduleId && (
            <PeoplePicker
              label="On behalf of"
              icon={FiUserCheck}
              people={people.filter((p) => String(p._id) !== myId)}
              value={form.onBehalfOf}
              onChange={(id) => set({ onBehalfOf: (Array.isArray(id) ? id[0] : id) || '' })}
              max={1}
              placeholder="Yourself — or search whose task this is"
              hint={onBehalf
                ? `It goes out in ${onBehalfName}'s name and becomes theirs: they approve it, and it will not stay on your list.`
                : 'Leave empty to set it yourself.'}
            />
          )}

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
              hint={form.assignees.length ? null
                : onBehalf ? `Nobody chosen: it will be assigned to ${onBehalfName}.`
                  : 'Nobody chosen: it will be assigned to you.'}
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
              {onBehalf ? (
                <>
                  This goes on <strong>{onBehalfName}&apos;s own list</strong>. They mark it done
                  themselves — there is no review step, and a task set for yourself earns no points.
                </>
              ) : (
                <>
                  This goes on <strong>your own list</strong>. You mark it done yourself — there is no
                  review step, and a task you set yourself earns no points.
                </>
              )}
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
                {recurringMode ? 'each time, for each person' : 'each person earns this on finishing'}
                {meta?.pointsArePaid ? '' : ' · scoring only, not paid'}
              </span>
            </div>
          )}

          {/* ── Do you want the last word? ───────────────────────── */}
          {/* On by default. When it is on, their "Complete" is a SUBMISSION —
              the server coerces it (config/tasks.effectiveTarget) — and the row
              waits in your review queue until you approve it or send it back.
              A DAILY recurring task is routine: only ever marked done. */}
          {!selfOnly && !routine && (
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
          {/* Not on somebody's behalf: cutting pieces is the setter's act. Not
              on a recurring task either — each occurrence is its own task. */}
          {!selfOnly && !onBehalf && !recurringMode && (
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

          {/* ── Repeats (the Recurring tab's own section, 2026-09-27) ── */}
          {recurringMode && (
            <div className="space-y-3 rounded-2xl border border-gray-200 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400">Repeats</p>

              {/* Equal segments; the border is on the base so choosing one cannot move it. */}
              <div className="grid grid-cols-2 gap-1 rounded-xl border border-gray-200 bg-gray-50 p-1 min-[360px]:grid-cols-4" role="tablist">
                {RECUR_FREQUENCIES.map((f) => {
                  const on = recur.frequency === f;
                  return (
                    <button
                      key={f}
                      type="button"
                      role="tab"
                      aria-selected={on}
                      onClick={() => setRecurState((r) => ({
                        ...r,
                        frequency: f,
                        ...(r.remindersTouched ? {} : remindersFor(f)),
                      }))}
                      className={`rounded-lg border text-xs font-semibold transition min-h-[36px] ${
                        on ? 'border-gray-200 bg-white text-gray-900 shadow-sm' : 'border-transparent text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {FREQUENCY_LABELS[f]}
                    </button>
                  );
                })}
              </div>

              {recur.frequency === 'DAILY' && (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-gray-500">How often</span>
                  {[[1, 'Every day'], [2, 'Alternate days'], [3, 'Every 3 days']].map(([n, label]) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => setRecur({ interval: n })}
                      aria-pressed={recur.interval === n}
                      className={`rounded-lg border px-3 text-xs font-medium transition min-h-[32px] ${
                        recur.interval === n ? 'accent-border accent-bg on-accent' : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  <Stepper
                    value={recur.interval}
                    min={1}
                    max={31}
                    onChange={(n) => setRecur({ interval: n })}
                    format={(n) => `every ${n} day${n === 1 ? '' : 's'}`}
                  />
                </div>
              )}

              {recur.frequency === 'WEEKLY' && (
                <div>
                  <p className="mb-1 text-[11px] text-gray-500">On these days</p>
                  <div className="grid grid-cols-7 gap-1 sm:flex">
                    {WEEKDAYS.map((d, i) => {
                      const on = (recur.weekdays || []).includes(i);
                      return (
                        <button
                          key={i}
                          type="button"
                          title={WEEKDAY_NAMES[i]}
                          aria-pressed={on}
                          onClick={() => setRecur({
                            weekdays: on ? recur.weekdays.filter((x) => x !== i) : [...(recur.weekdays || []), i].sort(),
                          })}
                          className={`min-h-[32px] min-w-0 sm:min-w-[36px] rounded-lg border text-xs font-medium transition ${
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

              {recur.frequency === 'MONTHLY' && (
                <div className="space-y-2">
                  <div className="inline-flex rounded-xl border border-gray-200 bg-gray-50 p-1">
                    {[['DATE', 'On a date'], ['WEEKDAY', 'On a weekday']].map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={recur.monthlyMode === k}
                        onClick={() => setRecur({ monthlyMode: k })}
                        className={`rounded-lg border px-3 text-xs font-semibold transition min-h-[32px] ${
                          recur.monthlyMode === k ? 'border-gray-200 bg-white text-gray-900 shadow-sm' : 'border-transparent text-gray-500'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {recur.monthlyMode === 'DATE' ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                      Day of the month
                      <Stepper value={recur.monthDay} min={1} max={31} onChange={(n) => setRecur({ monthDay: n })} format={ordinal} />
                      {recur.monthDay > 28 && <span className="text-gray-400">In a shorter month it falls on the last day.</span>}
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                      The
                      <select
                        value={recur.nthWeek}
                        onChange={(e) => setRecur({ nthWeek: Number(e.target.value) })}
                        className="rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
                        aria-label="Which one"
                      >
                        {NTH_WEEKS.map((n) => <option key={n.key} value={n.key}>{n.label.toLowerCase()}</option>)}
                      </select>
                      <select
                        value={recur.weekday}
                        onChange={(e) => setRecur({ weekday: Number(e.target.value) })}
                        className="rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
                        aria-label="Day of the week"
                      >
                        {[1, 2, 3, 4, 5, 6, 0].map((d) => <option key={d} value={d}>{WEEKDAY_NAMES[d]}</option>)}
                      </select>
                      of every month
                    </div>
                  )}
                </div>
              )}

              {recur.frequency === 'YEARLY' && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                  On
                  <Stepper value={recur.monthDay} min={1} max={31} onChange={(n) => setRecur({ monthDay: n })} format={(n) => String(n)} />
                  <select
                    value={recur.month}
                    onChange={(e) => setRecur({ month: Number(e.target.value) })}
                    className="rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
                    aria-label="Month"
                  >
                    {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </select>
                </div>
              )}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <label className="text-xs font-medium text-gray-500">
                  Due at
                  <input
                    type="time"
                    value={recur.time || '18:00'}
                    onChange={(e) => setRecur({ time: e.target.value })}
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
                  />
                </label>
                <label className="text-xs font-medium text-gray-500">
                  Starts on
                  <input
                    type="date"
                    value={recur.startDate}
                    onChange={(e) => setRecur({ startDate: e.target.value })}
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
                  />
                </label>
                <label className="text-xs font-medium text-gray-500">
                  Ends on <span className="font-normal text-gray-400">(optional)</span>
                  <input
                    type="date"
                    value={recur.until}
                    min={recur.startDate}
                    onChange={(e) => setRecur({ until: e.target.value })}
                    className="mt-1 block w-full rounded-lg border border-gray-200 px-2 text-sm min-h-[36px]"
                  />
                </label>
              </div>

              {/* The pattern in words — the same words the list will use. */}
              <div className="flex items-start gap-3 rounded-xl px-3 py-2.5" style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }}>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg accent-bg on-accent">
                  <FiRepeat size={14} />
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{patternLabel(pattern)}</p>
                  <p className="text-xs text-gray-500">
                    {leadDays
                      ? `Appears in their Tasks ${leadDays} days before it is due, at 9:00 AM.`
                      : `Appears in their Tasks at 9:00 AM on the day${recur.time && recur.time < '10:00' ? ' (an hour before, when due earlier)' : ''}.`}
                    {routine ? ' A daily task is only marked done — nothing to accept, no review.' : ''}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* ── Reminders (recurring) — in the Repeats builder's own shapes: the
              user, of that builder, "these options should be for sending
              notifications too" (2026-09-27). ─────────────────────────── */}
          {/* Only for the reminder grant (2026-09-28). */}
          {recurringMode && canRemind && (
            <div className="space-y-4 rounded-2xl border border-gray-200 p-4">
              <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400">Reminders</p>

              <div className="space-y-2">
                <ReminderPattern
                  value={recur.every}
                  onChange={(every) => setRecur({ every, remindersTouched: true })}
                  hints={reminderHints}
                />
              </div>

              <div className="space-y-2 border-t border-gray-100 pt-3">
                <p className="text-sm font-medium text-gray-700">Also remind before it is due</p>
                <div className="flex flex-wrap gap-1.5">
                  {BEFORE_CHOICES.map(({ mins, label }) => {
                    const on = recur.before.includes(mins);
                    const tooEarly = mins > lifetimeMin;
                    return (
                      <button
                        key={mins}
                        type="button"
                        aria-pressed={on}
                        // Picking one that could never go is refused; one an older
                        // schedule already has can still be taken off.
                        disabled={tooEarly && !on}
                        title={tooEarly ? 'Earlier than it appears in their Tasks — it would never be sent.' : undefined}
                        onClick={() => setRecur({
                          remindersTouched: true,
                          before: on ? recur.before.filter((m) => m !== mins) : [...recur.before, mins].sort((a, b) => a - b),
                        })}
                        className={`rounded-lg border px-3 text-xs font-medium transition min-h-[32px] disabled:cursor-not-allowed disabled:opacity-40 ${
                          on && tooEarly ? 'border-red-300 bg-red-50 text-red-700'
                            : on ? 'accent-border accent-bg on-accent'
                              : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
                        }`}
                      >
                        {label} before
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-gray-400">
                  {recur.before.length
                    ? `Once each, counted back from ${time12(recur.time || '18:00')}.`
                    : 'None — only the reminder above, if it is on.'}
                  {recur.before.some((m) => m > lifetimeMin) && (
                    <span className="font-medium text-red-600">
                      {' '}The one in red falls before it appears in their Tasks, so it would never be sent — take it off.
                    </span>
                  )}
                </p>
                {recur.otherReminders.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {recur.otherReminders.map((r, i) => (
                      <span
                        key={`${r.when}-${r.amount}-${r.unit}-${r.channel}-${i}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 py-1 pl-2.5 pr-1 text-xs text-gray-600"
                      >
                        {reminderLabel(r)}{r.channel === 'EMAIL' ? ' · email' : ''}
                        <button
                          type="button"
                          onClick={() => setRecur({
                            remindersTouched: true,
                            otherReminders: recur.otherReminders.filter((_, j) => j !== i),
                          })}
                          className="grid place-items-center rounded-md p-1 text-gray-400 transition hover:bg-gray-200 hover:text-gray-700"
                          aria-label={`Remove the reminder ${reminderLabel(r)}`}
                        >
                          <FiX size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── When (a one-off) ─────────────────────────────────── */}
          {!recurringMode && (
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-xs font-medium text-gray-500" htmlFor="task-due">
                <FiCalendar size={12} /> Due date &amp; time
              </label>
              <input
                id="task-due"
                type="datetime-local"
                value={form.dueDate}
                onChange={(e) => set({ dueDate: e.target.value })}
                className="w-full rounded-xl border border-gray-200 px-3 text-sm sm:w-64 min-h-[40px]"
              />
            </div>
          )}

          {/* ── The icon row ─────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            <button type="button" onClick={() => setShowLinks((v) => !v)} title="Add a link"
              className={`${iconBtn} min-h-[40px] min-w-[40px]`}>
              <FiLink size={16} />
            </button>
            {/* Files belong to ONE task, so a schedule does not take them; its
                reminders have their own section above. */}
            {!recurringMode && (
              <>
                <button type="button" onClick={() => fileRef.current?.click()} title="Attach a file"
                  className={`${iconBtn} min-h-[40px] min-w-[40px]`}>
                  <FiPaperclip size={16} />
                </button>
                <button type="button" onClick={() => imageRef.current?.click()} title="Attach an image"
                  className={`${iconBtn} min-h-[40px] min-w-[40px]`}>
                  <FiImage size={16} />
                </button>
                {/* The reminder grant's alone (2026-09-28). */}
                {canRemind && (
                  <button type="button" onClick={() => setShowReminders((v) => !v)} title="Set reminders"
                    className={`min-h-[40px] min-w-[40px] ${iconBtn} ${form.reminders.length ? 'accent-border accent-text' : ''}`}>
                    <FiBell size={16} />
                    {form.reminders.length > 0 && (
                      <span className="ml-1 text-[11px] font-medium">{form.reminders.length}</span>
                    )}
                  </button>
                )}
              </>
            )}
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

          {showReminders && canRemind && (
            <ReminderEditor
              value={form.reminders}
              onChange={(reminders) => set({ reminders })}
              onClose={() => setShowReminders(false)}
            />
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3">
          {recurringMode ? (
            <span className="text-xs text-gray-400">{patternLabel(pattern)}</span>
          ) : (
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
          )}

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
              {recurringMode ? <FiRepeat size={14} /> : <FiCheck size={14} />}
              {saving ? 'Saving…'
                : recurringMode ? (scheduleId ? 'Save recurring task' : 'Set up recurring task')
                  : selfOnly ? (onBehalf ? `Add to ${onBehalfName}'s tasks` : 'Add to my tasks')
                    : 'Assign task'}
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
