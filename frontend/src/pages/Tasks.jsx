/**
 * Tasks — one page, both portals.
 *
 * REWRITTEN 2026-09-25. The user: *"it is too much complicated now"*, with a
 * sketch of what it should be instead, which this page now is, top to bottom:
 *
 *   TWO BIG CARDS    "Assigned to me" and "Assigned by me" — the two piles of
 *                    work, each wearing its own figures (plus "All tasks" for
 *                    tasks.manage). They replaced a strip of six tabs: My
 *                    Tasks, Delegated, All Tasks, Requests, Kanban, Dashboard.
 *   SEARCH · FILTER  one box that finds a task by its name or by the name of
 *                    whoever set it or holds it, and one button for the rest —
 *                    department, people, due date, priority, order.
 *   THE FIVE FIGURES Total · Overdue · Pending · In review · Completed, as one
 *                    bar; every segment is a filter.
 *   THE ROWS         each with ONE status dropdown on the right: Approve,
 *                    Reject, Delegate, Transfer, In Review, Completed — only
 *                    the ones the server says this person may use on that row.
 *
 * WHAT WENT, AND WHERE IT WENT. "Ask for something" is gone (anybody may set
 * anybody a task now, so there is nothing to ask upward — the server stopped
 * making requests the same day). Kanban is gone. The report and the template
 * library are header buttons, because they are places you visit, not views of
 * your day. Accept/Decline/Submit/Approve/Send back/Claim moved from buttons on
 * the row into the dropdown.
 *
 * EVERY FILTER RUNS ON THE SERVER, and the figures come back WITH the rows from
 * the same filter, so they cannot disagree. The pile cards' figures come in the
 * same response (`withScopes`), rather than as two more requests.
 *
 * THE FIRST LOAD BLANKS THE LIST; NOTHING AFTER IT DOES — `refreshing` dims the
 * rows instead, so a filter change never collapses the page under the reader.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiFilter, FiSearch, FiX, FiBookmark, FiBarChart2, FiChevronLeft, FiChevronRight,
  FiArrowLeft,
} from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import useViewOnly from '../hooks/useViewOnly';
import { useTabParam } from '../hooks/useTabParam';
import AssignTaskModal from '../components/task/AssignTaskModal';
import TaskModal from '../components/task/TaskModal';
import TaskFilters, { DEFAULT_FILTERS, activeFilterCount } from '../components/task/TaskFilters';
import TaskRow from '../components/task/TaskRow';
import TaskPileCards from '../components/task/TaskPileCards';
import TaskStatBar from '../components/task/TaskStatBar';
import TaskActionDialog from '../components/task/TaskActionDialog';
import DelegateModal from '../components/task/DelegateModal';
import TransferModal from '../components/task/TransferModal';
import { EmptyTasks } from '../components/task/TaskChips';
import TaskTemplates from '../components/task/TaskTemplates';
import TaskDashboard from '../components/task/TaskDashboard';
import * as T from '../api/tasks';
import { RANGES, STAT_BAR, TASK_PRIORITY } from '../utils/taskLifecycle';

/**
 * Everything `?tab=` has ever meant here. The three piles are the page; the
 * rest are old links (Kanban, Requests, Dashboard) and the two header places,
 * each sent somewhere sensible rather than to an empty screen.
 */
const TAB_IDS = ['mine', 'delegated', 'all', 'report', 'templates', 'dashboard', 'kanban', 'requests'];

const PAGE_SIZE = 50;

export default function Tasks({ base = '/employee/tasks' }) {
  const viewOnly = useViewOnly();

  const [meta, setMeta] = useState(null);
  const isAdmin = Boolean(meta?.isAdmin);
  const meId = String(meta?.me || (meta?.people || []).find((p) => p.relation === 'self')?._id || '');

  const [tab, setTab] = useTabParam('mine', TAB_IDS);

  /** Which pile the list shows. An old link to a retired tab lands on your own. */
  const pile = tab === 'delegated' ? 'delegated'
    : tab === 'all' && (isAdmin || !meta) ? 'all'
      : 'mine';
  /** The page itself, or one of the two places reached from the header. */
  const view = tab === 'report' || tab === 'dashboard' ? 'report'
    : tab === 'templates' ? 'templates'
      : 'list';

  // "All tasks" is tasks.manage's — somebody who followed an old link to it
  // without the grant is put on their own pile once meta says so.
  useEffect(() => {
    if (meta && tab === 'all' && !isAdmin) setTab('mine');
  }, [meta, tab, isAdmin, setTab]);

  // The pile to come back to from the report or the templates — the one you
  // left, not always your own.
  const lastPile = useRef('mine');
  useEffect(() => {
    if (view === 'list') lastPile.current = pile;
  }, [view, pile]);
  const backTo = view === 'list' ? pile : lastPile.current;

  // ===== The list =====
  const [tasks, setTasks] = useState([]);
  const [counters, setCounters] = useState({});
  const [scopes, setScopes] = useState(null);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);     // the first load only
  const [refreshing, setRefreshing] = useState(false);
  const firstLoad = useRef(true);

  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [stat, setStat] = useState('');

  // ===== Dialogs =====
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignPrefill, setAssignPrefill] = useState(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** `{ id, to }` — the task opened over the list. */
  const [openTask, setOpenTask] = useState(null);
  /** `{ key, task }` — a status move waiting on its remark. */
  const [action, setAction] = useState(null);
  const [delegating, setDelegating] = useState(null);
  const [transferring, setTransferring] = useState(null);

  // Debounced, or every keystroke is a round trip.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    T.taskMeta().then(setMeta).catch(() => toast.error('Could not load the task lists.'));
  }, []);

  /**
   * The query. A people filter for the side of the pile that is always the
   * reader is dropped rather than sent: "assigned to Ravi" carried over onto
   * YOUR pile would empty it for a reason nothing on screen shows.
   */
  const params = useMemo(() => {
    const f = filters;
    const statQuery = STAT_BAR.find((s) => s.key === stat)?.query || {};
    return {
      scope: pile,
      range: f.range,
      ...(f.range === 'custom' ? { from: f.from, to: f.to } : {}),
      ...(f.department ? { department: f.department } : {}),
      ...(f.assignedTo && pile !== 'mine' ? { assignedTo: f.assignedTo } : {}),
      ...(f.assignedBy && pile !== 'delegated' ? { assignedBy: f.assignedBy } : {}),
      ...(f.priority ? { priority: f.priority } : {}),
      ...(debounced ? { q: debounced } : {}),
      ...statQuery,
      sort: f.sort,
      ...(f.dir ? { dir: f.dir } : {}),
      page,
      limit: PAGE_SIZE,
      withScopes: 1,
    };
  }, [filters, stat, pile, debounced, page]);

  const load = useCallback(async () => {
    if (view !== 'list') return;
    if (firstLoad.current) setLoading(true); else setRefreshing(true);
    try {
      const data = await T.listTasks(params);
      setTasks(data.tasks || []);
      setCounters(data.counters || {});
      if (data.scopes) setScopes(data.scopes);
      setPages(data.pages || 1);
      setTotal(data.total || 0);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not load the tasks.');
    } finally {
      firstLoad.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [params, view]);

  useEffect(() => { load(); }, [load]);

  // A different pile, window, search or figure starts at page 1 — staying on
  // page 4 of a list that now has two pages shows an empty screen.
  useEffect(() => { setPage(1); }, [pile, filters, debounced, stat]);

  const refresh = useCallback(() => {
    firstLoad.current = false;
    load();
  }, [load]);

  const pickPile = useCallback((key) => {
    setStat('');
    setTab(key);
  }, [setTab]);

  // ===== The status dropdown =====

  const showTask = useCallback((task) => setOpenTask({ id: task._id }), []);

  /**
   * One pick from a row's dropdown. Two moves need nothing more than the
   * click — taking a job on, and picking up an open piece — and run at once.
   * Delegate and Transfer open their own forms. Everything else asks for a
   * remark first (TaskActionDialog).
   */
  const onAction = useCallback(async (key, task) => {
    if (key === 'accept') {
      try {
        await T.acceptTask(task._id);
        toast.success('Accepted — it is in progress now.');
        refresh();
      } catch (err) {
        toast.error(err?.response?.data?.message || 'Could not accept that task.');
      }
      return;
    }
    if (key === 'claim') {
      const ok = await confirmDialog({
        title: 'Pick this up?',
        message: `"${task.title}" has nobody on it yet.`,
        details: [
          'It becomes yours, and nobody else can claim it.',
          task.effectivePoints ? `It is worth ${task.effectivePoints} points.` : null,
        ].filter(Boolean),
        confirmText: 'Pick it up',
      });
      if (!ok) return;
      try {
        await T.claimTask(task._id);
        toast.success('It is yours now.');
        refresh();
      } catch (err) {
        toast.error(err?.response?.data?.message || 'Could not pick that up.');
      }
      return;
    }
    if (key === 'delegate') { setDelegating(task); return; }
    if (key === 'transfer') { setTransferring(task); return; }
    setAction({ key, task });
  }, [refresh]);

  /** The remark came back from the dialog — make the move. Throws to keep it open. */
  const confirmAction = useCallback(async (note) => {
    const { key, task } = action;
    let res = null;
    if (key === 'approve') res = await T.approveTask(task._id, { note });
    else if (key === 'sendBack') res = await T.rejectTask(task._id, { note });
    else if (key === 'decline') res = await T.declineTask(task._id, note);
    else if (key === 'submit') res = await T.submitTask(task._id, { note });
    else if (key === 'complete') res = await T.changeStatus(task._id, 'COMPLETED', { note });

    const said = {
      approve: 'Approved — it is completed.',
      sendBack: 'Sent back. They have been told what is missing.',
      decline: 'Rejected. Whoever set it has been told.',
      submit: 'Sent for review.',
      // A doer's Complete on a reviewed task lands in review instead, and the
      // server says so (`coerced`) — the toast must not claim it is done.
      complete: res?.coerced ? 'Sent for review — it needs approving first.' : 'Marked completed.',
    }[key];
    toast.success(said);
    setAction(null);
    refresh();
  }, [action, refresh]);

  // ===== Filters, as chips under the toolbar =====

  const people = meta?.people || [];
  const nameOf = useCallback(
    (id) => (String(id) === meId ? 'me' : people.find((p) => String(p._id) === String(id))?.name || 'someone'),
    [people, meId]
  );
  const rangeLabel = RANGES.find(([k]) => k === filters.range)?.[1] || 'All time';

  /** What is narrowing the list, each removable on its own. */
  const chips = useMemo(() => {
    const out = [];
    const split = (v) => String(v || '').split(',').filter(Boolean);
    if (filters.range && filters.range !== 'all') {
      out.push({
        key: 'range',
        label: filters.range === 'custom'
          ? `Due ${filters.from || '…'} – ${filters.to || '…'}`
          : `Due: ${rangeLabel}`,
        clear: { range: 'all', from: '', to: '' },
      });
    }
    split(filters.department).forEach((d) => out.push({
      key: `d-${d}`,
      label: d,
      clear: { department: split(filters.department).filter((x) => x !== d).join(',') },
    }));
    if (pile !== 'mine') {
      split(filters.assignedTo).forEach((id) => out.push({
        key: `t-${id}`,
        label: `To ${nameOf(id)}`,
        clear: { assignedTo: split(filters.assignedTo).filter((x) => x !== id).join(',') },
      }));
    }
    if (pile !== 'delegated') {
      split(filters.assignedBy).forEach((id) => out.push({
        key: `b-${id}`,
        label: `By ${nameOf(id)}`,
        clear: { assignedBy: split(filters.assignedBy).filter((x) => x !== id).join(',') },
      }));
    }
    split(filters.priority).filter((p) => TASK_PRIORITY.includes(p)).forEach((p) => out.push({
      key: `p-${p}`,
      label: p,
      clear: { priority: split(filters.priority).filter((x) => x !== p).join(',') },
    }));
    return out;
  }, [filters, pile, rangeLabel, nameOf]);

  const filterCount = activeFilterCount({
    ...filters,
    // Only the people filter that applies to this pile counts.
    assignedTo: pile === 'mine' ? '' : filters.assignedTo,
    assignedBy: pile === 'delegated' ? '' : filters.assignedBy,
  });
  // Narrowed BY THE READER. The page opens on "Due: This month", and that
  // default window must not turn a pile's own empty message into "Nothing
  // matches", as if a filter had been set.
  const narrowed = Boolean(debounced || stat
    || chips.some((c) => c.key !== 'range' || filters.range !== DEFAULT_FILTERS.range));

  // ===== Render =====

  return (
    <div className="tasks-page">
      <PageHeader title="Tasks" subtitle="Hand work over, and know where it has got to.">
        <button
          type="button"
          onClick={() => setTab(view === 'report' ? backTo : 'report')}
          aria-pressed={view === 'report'}
          aria-label="Report"
          title="Report — who is on top of their work"
          className={`inline-flex items-center gap-2 rounded-xl border px-3.5 text-sm font-medium transition min-h-[40px] ${
            view === 'report'
              ? 'accent-border accent-text bg-white'
              : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:text-blue-600'
          }`}
        >
          <FiBarChart2 size={15} /> <span className="hidden sm:inline">Report</span>
        </button>
        <button
          type="button"
          onClick={() => setTab(view === 'templates' ? backTo : 'templates')}
          aria-pressed={view === 'templates'}
          aria-label="Templates"
          title="Templates — tasks worth setting again"
          className={`inline-flex items-center gap-2 rounded-xl border px-3.5 text-sm font-medium transition min-h-[40px] ${
            view === 'templates'
              ? 'accent-border accent-text bg-white'
              : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300 hover:text-blue-600'
          }`}
        >
          <FiBookmark size={15} /> <span className="hidden sm:inline">Templates</span>
        </button>
        {!viewOnly && (
          <button
            type="button"
            onClick={() => { setAssignPrefill(null); setAssignOpen(true); }}
            className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-green-700 min-h-[40px]"
          >
            <FiPlus size={16} /> Assign task
          </button>
        )}
      </PageHeader>

      {/* ── The two places reached from the header ──────────── */}
      {view !== 'list' && (
        <>
          <button
            type="button"
            onClick={() => setTab(backTo)}
            className="mb-4 inline-flex items-center gap-1.5 rounded-xl px-2 text-sm font-medium text-gray-600 transition hover:text-blue-600 min-h-[36px]"
          >
            <FiArrowLeft size={15} /> Back to tasks
          </button>
          {view === 'report' && <TaskDashboard meta={meta} isAdmin={isAdmin} />}
          {view === 'templates' && (
            <TaskTemplates
              meta={meta}
              viewOnly={viewOnly}
              onUse={(prefill) => { setAssignPrefill(prefill); setAssignOpen(true); }}
            />
          )}
        </>
      )}

      {view === 'list' && (
        <div className="space-y-4">
          {/* ── The piles ─────────────────────────────────────── */}
          <TaskPileCards isAdmin={isAdmin} active={pile} onPick={pickPile} scopes={scopes} />

          {/* ── Search · Filter ───────────────────────────────── */}
          <div className="flex items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 shadow-sm transition focus-within:border-gray-300 sm:max-w-md">
              <FiSearch className="shrink-0 text-gray-400" size={15} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search task or person…"
                aria-label="Search tasks"
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-0 min-h-[40px]"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="shrink-0 text-gray-400 transition-colors hover:text-gray-600"
                  aria-label="Clear the search"
                >
                  <FiX size={15} />
                </button>
              )}
            </label>

            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              className={`ml-auto inline-flex shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-semibold shadow-sm transition min-h-[40px] ${
                filterCount
                  ? 'accent-border accent-text bg-white'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'
              }`}
            >
              <FiFilter size={15} /> Filter
              {filterCount > 0 && (
                <span className="grid min-w-[20px] place-items-center rounded-full accent-bg px-1.5 text-[11px] font-bold on-accent min-h-[20px]">
                  {filterCount}
                </span>
              )}
            </button>
          </div>

          {/* What is narrowing the list — each one removable on its own, so a
              filter never hides work without saying so. */}
          {chips.length > 0 && (
            <div className="-mt-1 flex flex-wrap items-center gap-1.5">
              {chips.map((c) => (
                <span
                  key={c.key}
                  className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white py-0.5 pl-2.5 pr-1 text-xs font-medium text-gray-600 min-h-[28px]"
                >
                  {c.label}
                  <button
                    type="button"
                    onClick={() => setFilters((f) => ({ ...f, ...c.clear }))}
                    className="grid h-6 w-6 place-items-center rounded-md text-gray-400 transition hover:bg-gray-100 hover:text-gray-700"
                    aria-label={`Remove ${c.label}`}
                  >
                    <FiX size={12} />
                  </button>
                </span>
              ))}
              {chips.length > 1 && (
                <button
                  type="button"
                  onClick={() => setFilters((f) => ({ ...DEFAULT_FILTERS, range: 'all', sort: f.sort, dir: f.dir }))}
                  className="px-2 text-xs font-medium text-gray-500 transition hover:text-blue-600 min-h-[28px]"
                >
                  Clear all
                </button>
              )}
            </div>
          )}

          {/* ── The five figures ──────────────────────────────── */}
          <TaskStatBar counters={counters} active={stat} onPick={setStat} loading={loading} />

          {/* ── The rows ──────────────────────────────────────── */}
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-gray-100" />
              ))}
            </div>
          ) : tasks.length === 0 ? (
            <EmptyTasks
              scope={pile}
              filtered={narrowed}
              olderHint={['today', 'week', 'month'].includes(filters.range)}
              onAssign={viewOnly || narrowed ? undefined : () => { setAssignPrefill(null); setAssignOpen(true); }}
            />
          ) : (
            <div className={`space-y-2.5 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
              {tasks.map((task) => (
                <TaskRow
                  key={task._id}
                  task={task}
                  base={base}
                  scope={pile}
                  meId={meId}
                  viewOnly={viewOnly}
                  onOpen={showTask}
                  onAction={onAction}
                />
              ))}
            </div>
          )}

          {/* ── Paging ────────────────────────────────────────── */}
          {pages > 1 && (
            <div className="flex items-center justify-between pt-1 text-xs text-gray-500">
              <span>{total} task{total === 1 ? '' : 's'}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                  className="grid w-10 h-10 place-items-center rounded-xl border border-gray-200 bg-white transition hover:border-gray-300 disabled:opacity-40"
                  aria-label="Previous page"
                >
                  <FiChevronLeft size={15} />
                </button>
                <span className="tabular-nums">Page {page} of {pages}</span>
                <button
                  type="button"
                  disabled={page >= pages}
                  onClick={() => setPage((p) => p + 1)}
                  className="grid w-10 h-10 place-items-center rounded-xl border border-gray-200 bg-white transition hover:border-gray-300 disabled:opacity-40"
                  aria-label="Next page"
                >
                  <FiChevronRight size={15} />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Dialogs ──────────────────────────────────────────── */}
      <AssignTaskModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        onCreated={refresh}
        meta={meta}
        prefill={assignPrefill}
      />

      <TaskFilters
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        meta={meta}
        scope={pile}
        value={filters}
        onApply={setFilters}
      />

      <TaskActionDialog
        action={action?.key}
        task={action?.task}
        onClose={() => setAction(null)}
        onConfirm={confirmAction}
      />

      <DelegateModal
        open={Boolean(delegating)}
        onClose={() => setDelegating(null)}
        task={delegating}
        meta={meta}
        can={delegating?.can}
        onDone={refresh}
      />

      <TransferModal
        open={Boolean(transferring)}
        onClose={() => setTransferring(null)}
        task={transferring}
        meta={meta}
        onDone={refresh}
      />

      {/* One task, opened over the list rather than navigated to: somebody
          working through twenty rows keeps their place, filters and page. */}
      <TaskModal
        taskId={openTask?.id || null}
        open={Boolean(openTask)}
        onClose={() => setOpenTask(null)}
        onChanged={refresh}
        initialStatus={openTask?.to || null}
      />
    </div>
  );
}
