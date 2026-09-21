/**
 * Tasks — one page, five tabs, both portals.
 *
 * NEW 2026-09-21, replacing AdminTasks (755 lines), EmployeeTasks (293) and
 * AdminTaskWorkflows (1123). Three pages existed because the module had three
 * audiences; it has one, and the difference between an admin and an employee
 * here is which TABS they get, not which page they open. Keeping them apart was
 * how the board and the employee list ended up with different ideas of what
 * "overdue" meant.
 *
 *   MY TASKS        what is on me
 *   DELEGATED       what I handed out
 *   ALL TASKS       everything, inside the company wall      (tasks.manage)
 *   REQUESTS        what has been asked of me, and what I have asked for
 *   TEMPLATES       tasks worth setting again, and the directory
 *   DASHBOARD       the scoring table                        (own report always)
 *
 * EVERY FILTER RUNS ON THE SERVER, because a company with thousands of tasks
 * must never load them into a browser to count them. The chip bar, the search,
 * the filter modal and the paging are all query parameters; the page holds one
 * page of rows and the counters that came back with it.
 *
 * THE FIRST LOAD BLANKS THE LIST; NOTHING AFTER IT DOES. Setting `loading` on
 * every filter change swapped the rows for a skeleton and collapsed the page
 * under the reader's hands — the refetch-collapse trap every list in this
 * portal has now been fixed for. `refreshing` is the quiet one.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiFilter, FiSearch, FiX, FiInbox, FiUsers, FiList, FiGrid,
  FiBookmark, FiBarChart2, FiCornerUpRight, FiChevronLeft, FiChevronRight,
} from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import useViewOnly from '../hooks/useViewOnly';
import { useTabParam } from '../hooks/useTabParam';
import AssignTaskModal from '../components/task/AssignTaskModal';
import TaskUpdateModal from '../components/task/TaskUpdateModal';
import TaskFilters, { FILTER_KEYS } from '../components/task/TaskFilters';
import TaskRow from '../components/task/TaskRow';
import { CounterBar, RangeChips, EmptyTasks } from '../components/task/TaskChips';
import TaskTemplates from '../components/task/TaskTemplates';
import TaskDashboard from '../components/task/TaskDashboard';
import * as T from '../api/tasks';
import { RANGES } from '../utils/taskLifecycle';

/** A counter box maps to the query that produces exactly those rows. */
const COUNTER_QUERY = {
  overdue: { overdue: 'true', status: '' },
  pending: { overdue: '', status: 'PENDING' },
  inProgress: { overdue: '', status: 'IN_PROGRESS' },
  completed: { overdue: '', status: 'COMPLETED' },
  inTime: { overdue: '', status: 'COMPLETED' },
  delayed: { overdue: '', status: 'COMPLETED' },
};

export default function Tasks({ base = '/employee/tasks' }) {
  const viewOnly = useViewOnly();

  const [meta, setMeta] = useState(null);
  const isAdmin = Boolean(meta?.isAdmin);

  const TABS = useMemo(() => [
    ['mine', 'My Tasks', FiInbox],
    ['delegated', 'Delegated', FiUsers],
    ...(isAdmin ? [['all', 'All Tasks', FiList]] : []),
    ['requests', 'Requests', FiCornerUpRight],
    ['templates', 'Templates', FiBookmark],
    ['dashboard', 'Dashboard', FiBarChart2],
  ], [isAdmin]);

  const [tab, setTab] = useTabParam('mine', ['mine', 'delegated', 'all', 'requests', 'templates', 'dashboard']);

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

  // ===== Modals =====
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignPrefill, setAssignPrefill] = useState(null);
  const [assignAsRequest, setAssignAsRequest] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [moving, setMoving] = useState(null);   // { task, to }

  // Debounce the search, or every keystroke is a round trip.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    T.taskMeta().then(setMeta).catch(() => toast.error('Could not load the task lists.'));
  }, []);

  const isList = ['mine', 'delegated', 'all', 'requests'].includes(tab);

  const params = useMemo(() => ({
    scope: tab === 'requests' ? 'requests' : tab,
    range,
    ...(range === 'custom' ? { from: customFrom, to: customTo } : {}),
    ...(debounced ? { q: debounced } : {}),
    ...(counter ? COUNTER_QUERY[counter] : {}),
    // The In Time / Delayed boxes are a breakdown of Completed, so they carry
    // the same status and differ only in this one flag.
    ...(counter === 'inTime' ? { late: 'false' } : {}),
    ...(counter === 'delayed' ? { late: 'true' } : {}),
    ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)),
    page,
    limit: 50,
  }), [tab, range, customFrom, customTo, debounced, counter, filters, page]);

  const load = useCallback(async () => {
    if (!isList) return;
    if (firstLoad.current) setLoading(true); else setRefreshing(true);
    try {
      const data = await T.listTasks(params);
      setTasks(data.tasks || []);
      setCounters(data.counters || {});
      setPages(data.pages || 1);
      setTotal(data.total || 0);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not load the tasks.');
    } finally {
      firstLoad.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [params, isList]);

  useEffect(() => { load(); }, [load]);

  // Changing tab, range or filter starts at page 1 — staying on page 4 of a
  // list that now has two pages shows an empty screen and looks broken.
  useEffect(() => { setPage(1); }, [tab, range, debounced, counter, filters]);

  const activeFilters = FILTER_KEYS.reduce(
    (n, k) => n + (filters[k] ? filters[k].split(',').filter(Boolean).length : 0), 0
  );

  // ===== Actions =====

  const move = useCallback((task, to) => setMoving({ task, to }), []);

  /**
   * Accept — one press, no dialog.
   *
   * There is nothing to ask: saying yes to work you have been given needs no
   * explanation, and a confirmation step on it is pure friction.
   */
  const accept = useCallback(async (task) => {
    try {
      await T.acceptTask(task._id);
      toast.success('Accepted.');
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not accept that task.');
    }
  }, [load]);

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
      load();
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Could not decline that task.');
    }
  }, [load]);

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

  const afterCreate = useCallback(() => { firstLoad.current = false; load(); }, [load]);

  // ===== Render =====

  return (
    <div>
      <PageHeader
        title="Tasks"
        subtitle="Hand work over, and know where it has got to."
      >
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

      {tab === 'templates' && (
        <TaskTemplates
          meta={meta}
          viewOnly={viewOnly}
          onUse={(prefill) => { setAssignPrefill(prefill); setAssignAsRequest(false); setAssignOpen(true); }}
        />
      )}

      {tab === 'dashboard' && <TaskDashboard meta={meta} isAdmin={isAdmin} />}

      {isList && (
        <>
          {/* ── The chip bar ─────────────────────────────────── */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <RangeChips ranges={RANGES} value={range} onChange={setRange} />

            <div className="flex items-center gap-2">
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

          {range === 'custom' && (
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-600">
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

          {/* ── The counters ─────────────────────────────────── */}
          <div className="mb-4 rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2">
            <CounterBar
              counters={counters}
              active={counter}
              onPick={setCounter}
              loading={loading}
            />
          </div>

          {/* ── The rows ─────────────────────────────────────── */}
          {loading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-16 animate-pulse rounded-xl bg-gray-100" />
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
                  onMove={move}
                  onAccept={accept}
                  onDecline={decline}
                  onTemplate={tab === 'delegated' || tab === 'all' ? saveAsTemplate : undefined}
                />
              ))}
            </div>
          )}

          {/* ── Paging ───────────────────────────────────────── */}
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

      {/* ── Modals ───────────────────────────────────────────── */}
      <AssignTaskModal
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        onCreated={afterCreate}
        meta={meta}
        prefill={assignPrefill}
        forceRequest={assignAsRequest}
      />

      <TaskUpdateModal
        open={Boolean(moving)}
        onClose={() => setMoving(null)}
        task={moving?.task}
        to={moving?.to}
        meta={meta}
        can={moving?.task?.can}
        onDone={load}
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
