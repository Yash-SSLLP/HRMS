/**
 * Tasks — one page, six tabs, both portals.
 *
 * REWRITTEN 2026-09-22 on top of the v4 backend. The 2026-09-21 page had one
 * view (a list), one order (by deadline) and a counter strip; this one keeps
 * every tab it had and adds what the brief asked for:
 *
 *   MY TASKS        what is on me
 *   DELEGATED       what I handed out
 *   ALL TASKS       everything, inside the company wall      (tasks.manage)
 *   REQUESTS        what has been asked of me, and what I have asked for
 *   KANBAN          TWO BOARDS — "Assigned to me" over "Assigned by me", four
 *                   columns each. The shape the user drew, and the screen most
 *                   people open this module for. It took the Templates tab's
 *                   place; templates moved to a button in the header.
 *   DASHBOARD       the scoring table                        (own report always)
 *
 *   THE SORT        due · day assigned · pending days · points · priority ·
 *                   title · newest, each with a direction. The keys come from
 *                   `meta.sorts`; the SERVER orders the rows.
 *   THE STAT TILES  the counter strip became five cards, and each is a filter.
 *
 * EVERY FILTER RUNS ON THE SERVER, because a company with thousands of tasks
 * must never load them into a browser to count them. The chip bar, the search,
 * the sort, the filter modal and the paging are all query parameters; the page
 * holds one page of rows and the counters that came back with it.
 *
 * THE FIRST LOAD BLANKS THE LIST; NOTHING AFTER IT DOES. Setting `loading` on
 * every filter change swapped the rows for a skeleton and collapsed the page
 * under the reader's hands — the refetch-collapse trap every list in this
 * portal has now been fixed for. `refreshing` is the quiet one.
 *
 * NOTHING HERE DECIDES WHAT ANYBODY MAY DO. Each row carries the server's `can`
 * and TaskRow draws it; this page only routes the press to the right call, and
 * every move that needs a note opens the task so the note box can appear.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiFilter, FiSearch, FiX, FiInbox, FiUsers, FiList, FiGrid,
  FiBookmark, FiBarChart2, FiCornerUpRight, FiChevronLeft, FiChevronRight,
  FiArrowUp, FiArrowDown, FiLayers,
} from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import useViewOnly from '../hooks/useViewOnly';
import { useTabParam } from '../hooks/useTabParam';
import AssignTaskModal from '../components/task/AssignTaskModal';
import TaskModal from '../components/task/TaskModal';
import TaskFilters, { FILTER_KEYS } from '../components/task/TaskFilters';
import TaskRow from '../components/task/TaskRow';
import TaskBoard from '../components/task/TaskBoard';
import TaskStatTiles from '../components/task/TaskStatTiles';
import { RangeChips, EmptyTasks } from '../components/task/TaskChips';
import TaskTemplates from '../components/task/TaskTemplates';
import TaskDashboard from '../components/task/TaskDashboard';
import * as T from '../api/tasks';
import { RANGES, STATUS } from '../utils/taskLifecycle';

/**
 * A stat tile maps to the query that produces those rows.
 *
 * `total` clears the narrowing rather than adding one — it is the sum of the
 * others, so "filter by total" is "filter by nothing".
 *
 * One honest wrinkle: the server's PENDING figure EXCLUDES the pending tasks
 * that are also late (the tiles do not overlap — Overdue wins), but there is no
 * "pending and not late" query to send, so clicking Pending lists those late
 * ones too. The alternative is a figure that cannot be clicked, which is worse.
 */
const COUNTER_QUERY = {
  total: { overdue: '', status: '', late: '' },
  overdue: { overdue: 'true', status: '', late: '' },
  pending: { overdue: '', status: STATUS.PENDING, late: '' },
  inProgress: { overdue: '', status: STATUS.IN_PROGRESS, late: '' },
  inReview: { overdue: '', status: STATUS.SUBMITTED, late: '' },
  completed: { overdue: '', status: STATUS.COMPLETED, late: '' },
  // In time / Delayed are a breakdown OF Completed: same status, one flag apart.
  inTime: { overdue: '', status: STATUS.COMPLETED, late: 'false' },
  delayed: { overdue: '', status: STATUS.COMPLETED, late: 'true' },
};

/**
 * The list's own two shapes.
 *
 * The BOARD is NOT one of them — it is a tab of its own ("Kanban", user
 * decision 2026-09-22), because it is the screen people open the module for
 * rather than an alternative rendering of the tab they are already on. Leaving
 * it here as well would be two routes to one screen, which is two things to
 * keep in step and one more question to answer about where the board lives.
 */
const VIEWS = [
  ['list', 'List', FiList],
  ['report', 'Report', FiBarChart2],
];

/** The orders, for the moment before `GET /tasks/meta` lands. The server's list
 *  wins the instant it arrives — these keys mirror config/tasks.SORTS. */
const FALLBACK_SORTS = [
  { key: 'due', label: 'Due date' },
  { key: 'assigned', label: 'Day assigned' },
  { key: 'pending', label: 'Pending days' },
  { key: 'points', label: 'Points' },
  { key: 'priority', label: 'Priority' },
  { key: 'title', label: 'Title' },
  { key: 'created', label: 'Newest first' },
];

export default function Tasks({ base = '/employee/tasks' }) {
  const viewOnly = useViewOnly();

  const [meta, setMeta] = useState(null);
  const isAdmin = Boolean(meta?.isAdmin);

  /**
   * KANBAN TOOK TEMPLATES' PLACE IN THE STRIP (user decision, 2026-09-22).
   *
   * The two-board screen — everything assigned TO me over everything assigned
   * BY me — is what people open this module to look at, and it was sitting
   * behind a view switch on a tab five along from a template library.
   *
   * Templates did NOT go: "Save as template" on a row has to lead somewhere.
   * They moved to a button in the header (`showTemplates` below), which is
   * where a thing you visit occasionally rather than daily belongs. The tab id
   * is mirrored in config/nav.jsx, which draws the same strip in the sidebar.
   */
  const TABS = useMemo(() => [
    ['mine', 'My Tasks', FiInbox],
    ['delegated', 'Delegated', FiUsers],
    ...(isAdmin ? [['all', 'All Tasks', FiList]] : []),
    ['requests', 'Requests', FiCornerUpRight],
    ['kanban', 'Kanban', FiGrid],
    ['dashboard', 'Dashboard', FiBarChart2],
  ], [isAdmin]);

  const [tab, setTab] = useTabParam('mine', ['mine', 'delegated', 'all', 'requests', 'kanban', 'dashboard']);
  const [view, setView] = useState('list');
  /** The template library, reached from the header rather than the tab strip. */
  const [showTemplates, setShowTemplates] = useState(false);

  // ===== List state =====
  const [tasks, setTasks] = useState([]);
  const [counters, setCounters] = useState({});
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);

  const [loading, setLoading] = useState(true);     // first load only
  const [refreshing, setRefreshing] = useState(false);
  const firstLoad = useRef(true);

  const [range, setRange] = useState('month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [counter, setCounter] = useState('');
  const [filters, setFilters] = useState(
    Object.fromEntries(FILTER_KEYS.map((k) => [k, '']))
  );

  const [sort, setSort] = useState('due');
  /**
   * '' means "whatever that sort's natural direction is" — newest first for
   * Newest, soonest first for Due date. The server answers with the direction it
   * actually used (`data.dir`), which is what the arrow shows and what the
   * toggle flips, so the button can never disagree with the rows.
   */
  const [dir, setDir] = useState('');
  const [effectiveDir, setEffectiveDir] = useState('asc');

  // Pieces are tasks of their own, so without this a manager who split one job
  // into five would see six rows for it. The server's own default differs by
  // tab (in on My Tasks, out elsewhere) and this mirrors it.
  const [includePieces, setIncludePieces] = useState(true);

  // ===== Modals =====
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignPrefill, setAssignPrefill] = useState(null);
  const [assignAsRequest, setAssignAsRequest] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  /** `{ id, to }` — `to` opens the update box already pointed at that status. */
  const [openTask, setOpenTask] = useState(null);
  /** Bumped when anything changes, so the two boards refetch themselves. */
  const [refreshKey, setRefreshKey] = useState(0);

  // Debounce the search, or every keystroke is a round trip.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    T.taskMeta().then(setMeta).catch(() => toast.error('Could not load the task lists.'));
  }, []);

  // Kanban and Dashboard are NOT list tabs: they bring their own data, their
  // own filters and their own empty states, so the chip bar, the tiles, the
  // sort control and the paging below all sit behind this.
  const isList = ['mine', 'delegated', 'all', 'requests'].includes(tab) && !showTemplates;

  // The tab decides whether pieces are in by default, the same way the server
  // does — somebody switching to Delegated should not find their colleagues'
  // fragments in a list of the jobs they handed out.
  useEffect(() => {
    setIncludePieces(tab === 'mine' || tab === 'requests');
  }, [tab]);

  /** Everything that narrows a set of tasks — shared by the list and the board. */
  const filterParams = useMemo(() => ({
    range,
    ...(range === 'custom' ? { from: customFrom, to: customTo } : {}),
    ...(debounced ? { q: debounced } : {}),
    ...(counter ? COUNTER_QUERY[counter] : {}),
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    sort,
    ...(dir ? { dir } : {}),
    includeSubtasks: includePieces ? 1 : 0,
  }), [range, customFrom, customTo, debounced, counter, filters, sort, dir, includePieces]);

  const params = useMemo(() => ({
    ...filterParams,
    scope: tab === 'requests' ? 'requests' : tab,
    page,
    limit: 50,
  }), [filterParams, tab, page]);

  /**
   * What the Kanban tab passes to its two boards.
   *
   * The chip bar belongs to the LIST tabs, so the board has no date window, no
   * search box and no counter selection to inherit — it shows the work, all of
   * it, which is the point of a board. `includeSubtasks` is the exception: a
   * piece is genuinely somebody's column card and hiding it would leave a
   * delegated team's board empty.
   *
   * `scope` is NOT here — each section passes its own.
   */
  const boardParams = useMemo(() => ({ includeSubtasks: 1, sort, ...(dir ? { dir } : {}) }), [sort, dir]);

  const load = useCallback(async () => {
    // The board and the report fetch their own figures; loading a page of rows
    // nobody is looking at is a round trip for nothing.
    if (!isList || view !== 'list') return;
    if (firstLoad.current) setLoading(true); else setRefreshing(true);
    try {
      const data = await T.listTasks(params);
      setTasks(data.tasks || []);
      setCounters(data.counters || {});
      setPages(data.pages || 1);
      setTotal(data.total || 0);
      if (data.dir) setEffectiveDir(data.dir);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not load the tasks.');
    } finally {
      firstLoad.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [params, isList, view]);

  useEffect(() => { load(); }, [load]);

  // Changing tab, range or filter starts at page 1 — staying on page 4 of a
  // list that now has two pages shows an empty screen and looks broken.
  useEffect(() => { setPage(1); }, [tab, range, debounced, counter, filters, sort, dir, includePieces]);

  const activeFilters = FILTER_KEYS.reduce(
    (n, k) => n + (filters[k] ? filters[k].split(',').filter(Boolean).length : 0), 0
  );

  /** Reload whatever is on screen: the list, and the two boards. */
  const refresh = useCallback(() => {
    firstLoad.current = false;
    load();
    setRefreshKey((k) => k + 1);
  }, [load]);

  // ===== Actions =====
  //
  // Three of them are one press, because there is nothing to ask. The rest open
  // the task: the server refuses a silent status move (services/taskEngine), so
  // the note box has to appear, and a row is not the place for it.

  const showTask = useCallback((task) => setOpenTask({ id: task._id }), []);
  const showTaskAt = useCallback((task, to) => setOpenTask({ id: task._id, to }), []);

  /**
   * Accept — one press, no dialog.
   *
   * There is nothing to ask: saying yes to work you have been given needs no
   * explanation. Since 2026-09-22 it also STARTS the task, which is why the
   * toast says so — somebody who pressed Accept and found the row in "In
   * progress" would otherwise think they had pressed the wrong thing.
   */
  const accept = useCallback(async (task) => {
    try {
      await T.acceptTask(task._id);
      toast.success('Accepted — it is now in progress.');
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not accept that task.');
    }
  }, [refresh]);

  /**
   * Decline — always asks for a reason, because the server requires one.
   *
   * A refusal with no reason cannot be acted on by whoever now has to reassign
   * the work, and "declined" on its own reads as insubordination when it is
   * usually "I am on leave from Thursday".
   */
  const decline = useCallback(async (task) => {
    const reason = await promptDialog({
      title: 'Cannot take this on?',
      message: 'Say why, so it can be given to somebody else. They will see this.',
      placeholder: 'e.g. I am on leave from Thursday',
    });
    if (!reason || !reason.trim()) return;
    try {
      await T.declineTask(task._id, reason.trim());
      toast.success('Declined. Whoever set it has been told.');
      refresh();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not decline that task.');
    }
  }, [refresh]);

  /**
   * Claim — take a piece nobody was named for.
   *
   * Confirmed rather than instant: it is the one action on the list that makes
   * somebody answerable for work they were not given, and the first person to
   * press it gets it.
   */
  const claim = useCallback(async (task) => {
    const ok = await confirmDialog({
      title: 'Pick this up?',
      message: `"${task.title}" has nobody on it yet.`,
      details: [
        'It becomes yours, and nobody else can claim it.',
        task.points ? `It is worth ${task.effectivePoints ?? task.points} points.` : null,
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
  }, [refresh]);

  const saveAsTemplate = useCallback(async (task) => {
    const name = await promptDialog({
      title: 'Save as a template',
      message: 'What should this template be called?',
      initialValue: task.title,
    });
    if (!name) return;
    try {
      await T.createTemplate({ fromTask: task._id, name });
      toast.success('Saved. You will find it under Templates.');
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not save that template.');
    }
  }, []);

  const openAssign = useCallback((asRequest = false) => {
    setAssignPrefill(null);
    setAssignAsRequest(asRequest);
    setAssignOpen(true);
  }, []);

  /**
   * A tile toggles its own filter off.
   *
   * Written to survive either convention: a tile row that sends '' to clear,
   * and one that simply sends the key that is already active.
   */
  const pickCounter = useCallback((key) => {
    setCounter((prev) => (!key || key === prev ? '' : key));
  }, []);

  const sorts = meta?.sorts?.length ? meta.sorts : FALLBACK_SORTS;

  // ===== Render =====

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle="Hand work over, and know where it has got to."
      >
        {isList && (
          <div className="seg-track" role="group" aria-label="View">
            {VIEWS.map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setView(key)}
                aria-pressed={view === key}
                className={`seg-btn inline-flex items-center gap-1.5 ${view === key ? 'is-active' : ''}`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
        )}
        {/* Templates moved out of the tab strip when Kanban took its place
            (2026-09-22). It is a library you visit occasionally rather than a
            view of your work, so it belongs beside the actions rather than
            among the tabs — but it has to stay REACHABLE, because "Save as
            template" on a row leads here. */}
        <button
          type="button"
          onClick={() => setShowTemplates((v) => !v)}
          aria-pressed={showTemplates}
          className={`inline-flex items-center gap-2 rounded-xl border px-4 text-sm font-medium transition min-h-[40px] ${
            showTemplates
              ? 'accent-border accent-text bg-white'
              : 'border-gray-200 text-gray-700 hover:border-gray-400 hover:text-blue-600'
          }`}
        >
          <FiBookmark size={15} /> Templates
        </button>
        {!viewOnly && (
          <>
            <button
              type="button"
              onClick={() => openAssign(true)}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-200 px-4 text-sm font-medium text-gray-700 hover:border-gray-400 hover:text-blue-600 min-h-[40px]"
            >
              <FiCornerUpRight size={15} /> Ask for something
            </button>
            <button
              type="button"
              onClick={() => openAssign(false)}
              className="inline-flex items-center gap-2 rounded-xl bg-green-600 px-4 text-sm font-medium text-white hover:bg-green-700 min-h-[40px]"
            >
              <FiPlus size={15} /> Assign task
            </button>
          </>
        )}
      </PageHeader>

      {/* ── Tabs ─────────────────────────────────────────────── */}
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-gray-200">
        {TABS.map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            // The weight lives on the base class; only the colour and the
            // underline change, so selecting a tab cannot resize it.
            className={`min-h-[40px] -mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition ${
              tab === key
                ? 'accent-border accent-text'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {showTemplates && (
        <TaskTemplates
          meta={meta}
          viewOnly={viewOnly}
          onUse={(prefill) => {
            setAssignPrefill(prefill);
            setAssignAsRequest(false);
            setAssignOpen(true);
          }}
        />
      )}

      {/* ── Kanban ───────────────────────────────────────────
          TWO BOARDS, stacked: everything assigned TO me over everything
          assigned BY me — the shape the brief drew. Each section fetches its
          own four columns (GET /tasks/board?scope=…), so the two never have to
          be sliced out of one payload and a column can be capped on its own.

          Dragging a card OPENS the task with the note box pointed at the new
          column. The server refuses a silent status change, so there is no drop
          that quietly moves anything — that is the module's rule holding, not
          an omission. */}
      {tab === 'kanban' && !showTemplates && (
        <div className="space-y-6">
          <TaskBoard
            scope="mine"
            title="Assigned to me"
            params={boardParams}
            onOpen={showTask}
            onMove={showTaskAt}
            refreshKey={refreshKey}
          />
          <TaskBoard
            scope="delegated"
            title="Assigned by me"
            params={boardParams}
            onOpen={showTask}
            onMove={showTaskAt}
            refreshKey={refreshKey}
          />
        </div>
      )}

      {tab === 'dashboard' && !showTemplates && <TaskDashboard meta={meta} isAdmin={isAdmin} />}

      {isList && (
        <>
          {/* ── The chip bar ───────────────────────────────────
              Drawn for the list and the board, which read the same filters and
              the same order. The report is self-contained — it brings its own
              date chips and its own views — so putting a second set of controls
              above it would be two windows onto one figure. */}
          {view !== 'report' && (
          <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <RangeChips ranges={RANGES} value={range} onChange={setRange} />

            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-2 rounded-xl border border-gray-200 px-2">
                <FiSearch className="shrink-0 text-gray-400" size={14} />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search tasks…"
                  className="w-36 min-w-0 border-0 p-0 text-sm placeholder:text-gray-400 focus:outline-none focus:ring-0 sm:w-48 min-h-[38px]"
                />
                {search && (
                  <button type="button" onClick={() => setSearch('')} className="text-gray-400 hover:text-gray-600" aria-label="Clear search">
                    <FiX size={14} />
                  </button>
                )}
              </div>

              {/* ── Order ──────────────────────────────────────
                  The keys are the server's (`meta.sorts`) and so is the
                  ordering itself — the client never re-sorts a page, which
                  would only ever sort the fifty rows it happens to hold. */}
              <div className="flex items-center gap-1">
                <select
                  value={sort}
                  onChange={(e) => { setSort(e.target.value); setDir(''); }}
                  aria-label="Sort by"
                  title="Order the list"
                  className="min-h-[40px] rounded-xl border border-gray-200 bg-white px-2 text-sm text-gray-700"
                >
                  {sorts.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => setDir(effectiveDir === 'asc' ? 'desc' : 'asc')}
                  title={`${effectiveDir === 'asc' ? 'Ascending' : 'Descending'} — click to reverse`}
                  aria-label="Reverse the order"
                  className="min-h-[40px] min-w-[40px] inline-flex items-center justify-center rounded-xl border border-gray-200 text-gray-600 transition hover:border-gray-400 hover:text-blue-600"
                >
                  {effectiveDir === 'asc' ? <FiArrowUp size={14} /> : <FiArrowDown size={14} />}
                </button>
              </div>

              <button
                type="button"
                onClick={() => setFiltersOpen(true)}
                className={`min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border px-3 text-sm font-medium transition ${
                  activeFilters
                    ? 'border-green-600 bg-green-600 text-white'
                    : 'border-gray-200 text-gray-600 hover:border-gray-300'
                }`}
              >
                <FiFilter size={14} /> Filter
                {activeFilters > 0 && <span className="text-xs">({activeFilters})</span>}
              </button>
            </div>
          </div>

          <div className="mb-3 flex flex-wrap items-center gap-3">
            {range === 'custom' && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                <label className="flex items-center gap-1.5">
                  From
                  <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)}
                    className="rounded-lg border border-gray-200 px-2 text-xs min-h-[32px]" />
                </label>
                <label className="flex items-center gap-1.5">
                  to
                  <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)}
                    className="rounded-lg border border-gray-200 px-2 text-xs min-h-[32px]" />
                </label>
              </div>
            )}

            {/* A piece is a task of its own, so it can be listed beside the
                others or folded back under the job it came from. */}
            <label className="min-h-[40px] inline-flex cursor-pointer items-center gap-2 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={includePieces}
                onChange={(e) => setIncludePieces(e.target.checked)}
                className="rounded border-gray-300"
              />
              <FiLayers size={13} className="text-gray-400" />
              Include pieces
            </label>
          </div>
          </>
          )}

          {/* ── The figures ────────────────────────────────────
              The list's own. The board draws a set per section, because
              "assigned to me" and "assigned by me" are two different piles and
              one row of figures over both would describe neither. */}
          {view === 'list' && (
            <div className="mb-4">
              <TaskStatTiles
                counters={counters}
                active={counter}
                onPick={pickCounter}
              />
            </div>
          )}

          {/* ── List ─────────────────────────────────────────── */}
          {view === 'list' && (
            <>
              {loading ? (
                <div className="space-y-2">
                  {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-16 animate-pulse rounded-2xl bg-gray-100" />
                  ))}
                </div>
              ) : tasks.length === 0 ? (
                <EmptyTasks scope={tab} onAssign={viewOnly ? undefined : () => openAssign(false)} />
              ) : (
                <div className={`space-y-2 transition-opacity ${refreshing ? 'opacity-60' : ''}`}>
                  {tasks.map((task) => (
                    <TaskRow
                      key={task._id}
                      task={task}
                      base={base}
                      scope={tab}
                      viewOnly={viewOnly}
                      onOpen={showTask}
                      onAccept={accept}
                      onDecline={decline}
                      onClaim={claim}
                      // Submit, Approve and Send back all carry a note the
                      // server will not waive, so each opens the task with the
                      // box already pointed at where it is going.
                      onSubmit={(t) => showTaskAt(t, STATUS.SUBMITTED)}
                      onApprove={(t) => showTaskAt(t, STATUS.COMPLETED)}
                      onReject={(t) => showTaskAt(t, STATUS.IN_PROGRESS)}
                      onTemplate={tab === 'delegated' || tab === 'all' ? saveAsTemplate : undefined}
                    />
                  ))}
                </div>
              )}

              {/* ── Paging ─────────────────────────────────── */}
              {pages > 1 && (
                <div className="mt-4 flex items-center justify-between text-xs text-gray-500">
                  <span>{total} task{total === 1 ? '' : 's'}</span>
                  <div className="flex items-center gap-2">
                    <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                      className="rounded-lg border border-gray-200 px-2 disabled:opacity-40 min-h-[32px] min-w-[32px]" aria-label="Previous page">
                      <FiChevronLeft size={14} />
                    </button>
                    <span>Page {page} of {pages}</span>
                    <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}
                      className="rounded-lg border border-gray-200 px-2 disabled:opacity-40 min-h-[32px] min-w-[32px]" aria-label="Next page">
                      <FiChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── Report ───────────────────────────────────────
              The same component the Dashboard tab renders, deliberately: two
              reports of the same work, reached two ways, would be two sets of
              figures to reconcile the first time they disagreed. */}
          {view === 'report' && <TaskDashboard meta={meta} isAdmin={isAdmin} />}
        </>
      )}

      {/* ── Modals ───────────────────────────────────────────── */}
      <AssignTaskModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        onCreated={refresh}
        meta={meta}
        prefill={assignPrefill}
        forceRequest={assignAsRequest}
      />

      {/* One task, opened over the list rather than navigated to: somebody
          working through twenty rows loses their place, their filters and their
          page every time a task costs them a round trip. */}
      <TaskModal
        taskId={openTask?.id || null}
        open={Boolean(openTask)}
        onClose={() => setOpenTask(null)}
        onChanged={refresh}
        initialStatus={openTask?.to || null}
      />

      <TaskFilters
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        meta={meta}
        value={filters}
        onApply={setFilters}
      />
    </div>
  );
}
