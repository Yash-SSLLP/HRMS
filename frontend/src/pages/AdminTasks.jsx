/**
 * Tasks — the admin portal's board (sections 27, 28, 43, 44).
 *
 * FIVE VIEWS OF ONE THING, as tabs: the list, the Kanban board, the approvals
 * inbox, workload and the incentive queue. They are tabs rather than five pages
 * because they are all answers to "what is going on with our work", and because
 * a filter set on one should still apply when you switch how you are looking at it.
 *
 * THERE IS NO CALENDAR TAB. The portal already has one calendar
 * (pages/Calendar.jsx), where a task deadline is an entry type beside holidays,
 * events, birthdays, interviews and reminders. A month grid in here would be a
 * second place to look for the same answer, and the two would drift — user
 * decision, 2026-09-17.
 *
 * EVERY FILTER RUNS ON THE SERVER. Section 46 asks that thousands of tasks never
 * be loaded into the browser, so the search box, the status/priority/department
 * filters and the paging are all query parameters — the page holds one page of
 * rows and nothing else. The search is debounced, or every keystroke would be a
 * round trip.
 *
 * THE FIRST LOAD BLANKS THE TABLE; NOTHING AFTER IT DOES. Setting `loading`
 * again on every filter change swapped the whole tbody for a skeleton and
 * collapsed the table, throwing the page around under the reader's hands — the
 * same split every other list in this portal now uses.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  FiPlus, FiSearch, FiFilter, FiDownload, FiList, FiGrid, FiCalendar,
  FiCheckSquare, FiAward, FiX, FiChevronLeft, FiChevronRight, FiUsers,
} from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import { confirmDialog, promptDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import TaskFormModal from '../components/task/TaskFormModal';
import {
  StatusChip, PriorityChip, DueChip, ProgressBar, AssigneeList,
  TaskMarks, TaskTitleLink, TaskCard, StatTiles,
} from '../components/task/TaskChips';
import useViewOnly from '../hooks/useViewOnly';
import { useTabParam } from '../hooks/useTabParam';
import api from '../api/client';
import * as T from '../api/tasks';
import { downloadFile } from '../api/download';
import {
  TASK_PRIORITY, BOARD_COLUMNS, statusLabel, formatMinutes,
  INCENTIVE_OUTCOME_LABELS, personName,
} from '../utils/taskLifecycle';
import { formatDateTime12 } from '../utils/time';

const TABS = [
  ['list', 'List', FiList],
  ['board', 'Board', FiGrid],
  ['approvals', 'Approvals', FiCheckSquare],
  ['workload', 'Workload', FiUsers],
  ['incentives', 'Incentives', FiAward],
];

const STATUS_FILTERS = [
  ['', 'All statuses'],
  ['ASSIGNED', 'Assigned'],
  ['ACCEPTED', 'Accepted'],
  ['IN_PROGRESS', 'In progress'],
  ['SUBMITTED,UNDER_REVIEW', 'Awaiting review'],
  ['REJECTED', 'Sent back'],
  ['BLOCKED,ON_HOLD', 'Stuck'],
  ['COMPLETED', 'Completed'],
  ['CANCELLED,DECLINED', 'Cancelled or declined'],
];

const VIEWS = [
  ['', 'Everything'],
  ['mine', 'Mine'],
  ['team', 'My team'],
  ['created', 'I set these'],
  ['overdue', 'Overdue'],
  ['dueToday', 'Due today'],
];

export default function AdminTasks() {
  const navigate = useNavigate();
  const viewOnly = useViewOnly();
  const [tab, setTab] = useTabParam('list', TABS.map(([k]) => k));

  // reference data
  const [meta, setMeta] = useState({});
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [workLocations, setWorkLocations] = useState([]);

  // the list
  const [tasks, setTasks] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);

  // other tabs
  const [board, setBoard] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [incentives, setIncentives] = useState([]);
  const [pendingPoints, setPendingPoints] = useState(0);
  const [people, setPeople] = useState([]);

  // filters
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [department, setDepartment] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [view, setView] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(undefined); // undefined = closed, null = new
  const [selected, setSelected] = useState([]);

  // Debounced, or the list refetches on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Changing a filter goes back to page one — page 4 of a different filter is
  // usually empty, which reads as "no results" rather than "wrong page".
  useEffect(() => { setPage(1); }, [debouncedQ, status, priority, department, assignedTo, view]);

  const filters = useMemo(() => ({
    q: debouncedQ || undefined,
    status: status || undefined,
    priority: priority || undefined,
    department: department || undefined,
    assignedTo: assignedTo || undefined,
    view: view || undefined,
  }), [debouncedQ, status, priority, department, assignedTo, view]);

  /** Load whatever the current tab needs. */
  const load = useCallback(async (first = false) => {
    if (first) setLoading(true); else setRefreshing(true);
    setError('');
    try {
      if (tab === 'list') {
        const r = await T.listTasks({ ...filters, page, limit: 50 });
        setTasks(r.tasks);
        setTotal(r.total);
        setPages(r.pages);
      } else if (tab === 'board') {
        const r = await T.taskBoard({ view: view || undefined });
        setBoard(r.columns);
      } else if (tab === 'approvals') {
        const r = await T.myApprovals();
        setApprovals(r.tasks);
      } else if (tab === 'incentives') {
        const r = await T.listIncentives({ status: 'Pending' });
        setIncentives(r.incentives);
        setPendingPoints(r.pendingPoints);
      } else if (tab === 'workload') {
        const r = await T.workload({ department: department || undefined });
        setPeople(r.people);
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tab, filters, page, view, department]);

  useEffect(() => { load(true); }, [tab]);        // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!loading) load(); }, [filters, page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reference data once, not per tab.
  useEffect(() => {
    (async () => {
      try {
        const [m, u, p, w] = await Promise.all([
          T.taskMeta(),
          api.get('/admin/users?active=true&excludeExecutives=true').then((r) => r.data.users).catch(() => []),
          api.get('/projects').then((r) => r.data.projects).catch(() => []),
          api.get('/work-locations').then((r) => r.data.locations || r.data.workLocations || []).catch(() => []),
        ]);
        setMeta(m);
        setUsers(u);
        setProjects(p);
        setWorkLocations(w);
      } catch { /* the page still works without the pickers */ }
    })();
  }, []);

  const departments = useMemo(
    () => [...new Set(tasks.map((t) => t.department).filter(Boolean))].sort(),
    [tasks]
  );

  const save = async (payload) => {
    if (editing) {
      await T.updateTask(editing._id, payload);
      toast.success('Task updated');
    } else {
      const r = await T.createTask(payload);
      toast.success(r.count > 1 ? `Created for ${r.count} people` : 'Task created');
    }
    setEditing(undefined);
    await load();
  };

  const remove = async (task) => {
    if (!(await confirmDialog({
      message: `Archive "${task.title}"? It comes off the list but nothing is deleted — its history, time and evidence stay.`,
      confirmText: 'Archive',
    }))) return;
    try {
      await T.deleteTask(task._id);
      toast.success('Archived');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not archive');
    }
  };

  const bulk = async (action, value) => {
    if (!selected.length) return;
    try {
      const r = await T.bulkTasks({ ids: selected, action, value });
      toast[r.failed.length ? 'warning' : 'success'](r.message);
      setSelected([]);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Bulk change failed');
    }
  };

  const clearFilters = () => {
    setQ(''); setStatus(''); setPriority(''); setDepartment(''); setAssignedTo(''); setView('');
  };
  const filterCount = [status, priority, department, assignedTo, view].filter(Boolean).length;

  return (
    <div>
      <PageHeader title="Tasks" subtitle={tab === 'list' && total ? `${total} task${total === 1 ? '' : 's'}` : undefined}>
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        {/* Deadlines are ON the company calendar, beside holidays, events and
            reminders — this page deliberately has no month grid of its own, so
            the way there has to be signposted rather than merely absent. */}
        <Link to="/admin/calendar"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50"
          style={{ minHeight: 40 }}>
          <FiCalendar size={14} /> Calendar
        </Link>
        <button type="button" onClick={() => downloadFile(`/tasks/export?${new URLSearchParams(
          Object.entries(filters).filter(([, v]) => v).map(([k, v]) => [k, String(v)])
        )}`, 'tasks.xlsx')}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50"
          style={{ minHeight: 40 }}>
          <FiDownload size={14} /> Export
        </button>
        {!viewOnly && meta.can?.manage && (
          <button type="button" onClick={() => setEditing(null)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm"
            style={{ minHeight: 40 }}>
            <FiPlus size={14} /> New task
          </button>
        )}
      </PageHeader>

      {/* ===== tabs ===== */}
      <div className="topbar-scroll flex gap-1 border-b border-gray-200 mb-4 overflow-x-auto">
        {TABS.map(([key, label, Icon]) => (
          <button key={key} type="button" onClick={() => setTab(key)}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${
              tab === key ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            style={{ minHeight: 40 }}>
            <Icon size={13} /> {label}
            {key === 'approvals' && approvals.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">{approvals.length}</span>
            )}
            {key === 'incentives' && incentives.length > 0 && (
              <span className="ml-1 px-1.5 py-0.5 rounded-full bg-violet-100 text-violet-800 text-xs">{incentives.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ===== search & filters ===== */}
      {['list', 'board'].includes(tab) && (
        <div className="mb-4 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
              <input value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="Search by task ID, title, description or tag"
                className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm" style={{ minHeight: 40 }} />
            </div>
            <select value={view} onChange={(e) => setView(e.target.value)}
              className="border rounded-lg px-3 py-2 text-sm" style={{ minHeight: 40 }}>
              {VIEWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button type="button" onClick={() => setShowFilters((s) => !s)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg hover:bg-gray-50"
              style={{ minHeight: 40 }}>
              <FiFilter size={14} /> Filters
              {filterCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full bg-gray-900 text-white text-xs">{filterCount}</span>
              )}
            </button>
          </div>

          {showFilters && (
            <div className="flex flex-wrap items-center gap-2 p-3 border border-gray-200 rounded-lg bg-gray-50">
              <select value={status} onChange={(e) => setStatus(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm bg-white" style={{ minHeight: 40 }}>
                {STATUS_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm bg-white" style={{ minHeight: 40 }}>
                <option value="">Any priority</option>
                {TASK_PRIORITY.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <input value={department} onChange={(e) => setDepartment(e.target.value)}
                list="task-departments" placeholder="Department"
                className="border rounded-lg px-3 py-2 text-sm bg-white" style={{ minHeight: 40 }} />
              <datalist id="task-departments">
                {departments.map((d) => <option key={d} value={d} />)}
              </datalist>
              <SearchableSelect value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm bg-white min-w-[160px]">
                <option value="">Anyone</option>
                {users.map((u) => (
                  <option key={u._id} value={u._id}>{u.firstName} {u.lastName}</option>
                ))}
              </SearchableSelect>
              {filterCount > 0 && (
                <button type="button" onClick={clearFilters}
                  className="inline-flex items-center gap-1 px-3 py-2 text-sm text-gray-600 hover:text-gray-900"
                  style={{ minHeight: 40 }}>
                  <FiX size={13} /> Clear
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* ===== bulk bar ===== */}
      {tab === 'list' && selected.length > 0 && !viewOnly && (
        <div className="mb-3 flex flex-wrap items-center gap-2 p-3 rounded-lg bg-gray-900 text-white">
          <span className="text-sm">{selected.length} selected</span>
          <select value="" onChange={async (e) => {
            const v = e.target.value;
            e.target.value = '';
            if (!v) return;
            if (v === 'archive') {
              if (!(await confirmDialog({
                message: `Archive ${selected.length} tasks? Nothing is deleted.`, confirmText: 'Archive',
              }))) return;
              return bulk('archive', true);
            }
            if (v === 'dueDate') {
              const d = await promptDialog({ message: 'New due date (YYYY-MM-DD)', inputType: 'date', confirmText: 'Set' });
              if (!d) return;
              return bulk('dueDate', d);
            }
            return bulk('priority', v);
          }}
            className="border-0 rounded-lg px-3 py-2 text-sm text-gray-900" style={{ minHeight: 40 }}>
            <option value="">Change…</option>
            <optgroup label="Priority">
              {TASK_PRIORITY.map((p) => <option key={p} value={p}>Set priority: {p}</option>)}
            </optgroup>
            <option value="dueDate">Change due date</option>
            <option value="archive">Archive</option>
          </select>
          <button type="button" onClick={() => setSelected([])}
            className="ml-auto text-sm underline" style={{ minHeight: 40 }}>Clear</button>
        </div>
      )}

      {/* ===== LIST ===== */}
      {tab === 'list' && (
        <>
          <div className="bg-white shadow rounded-lg overflow-hidden hidden md:block">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-3 w-9">
                      <input type="checkbox"
                        checked={tasks.length > 0 && selected.length === tasks.length}
                        onChange={(e) => setSelected(e.target.checked ? tasks.map((t) => t._id) : [])}
                        className="h-4 w-4 rounded border-gray-300" />
                    </th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Task</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Assignee</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Priority</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700 w-32">Progress</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Due</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr><td colSpan={8} className="px-4 py-4">
                      <div className="space-y-2.5">
                        <div className="skeleton h-4 rounded" />
                        <div className="skeleton h-4 rounded w-5/6" />
                        <div className="skeleton h-4 rounded w-2/3" />
                      </div>
                    </td></tr>
                  ) : tasks.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">
                      {filterCount || q ? 'No tasks match those filters.' : 'No tasks yet.'}
                    </td></tr>
                  ) : tasks.map((t) => (
                    <tr key={t._id} className={t.overdue ? 'bg-red-50/40' : ''}>
                      <td className="px-3 py-3">
                        <input type="checkbox" checked={selected.includes(t._id)}
                          onChange={(e) => setSelected((s) => (e.target.checked
                            ? [...s, t._id] : s.filter((x) => x !== t._id)))}
                          className="h-4 w-4 rounded border-gray-300" />
                      </td>
                      <td className="px-4 py-3">
                        <TaskTitleLink task={t} base="/admin/tasks" />
                        <div className="mt-0.5"><TaskMarks task={t} /></div>
                      </td>
                      <td className="px-4 py-3"><AssigneeList task={t} /></td>
                      <td className="px-4 py-3"><PriorityChip priority={t.priority} always /></td>
                      <td className="px-4 py-3"><ProgressBar value={t.progress} /></td>
                      <td className="px-4 py-3"><DueChip task={t} /></td>
                      <td className="px-4 py-3"><StatusChip status={t.status} /></td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <button type="button" onClick={() => navigate(`/admin/tasks/${t._id}`)}
                          className="text-blue-600 hover:underline mr-3">Open</button>
                        {!viewOnly && meta.can?.manage && (
                          <>
                            <button type="button" onClick={() => setEditing(t)}
                              className="text-gray-600 hover:underline mr-3">Edit</button>
                            <button type="button" onClick={() => remove(t)}
                              className="text-red-600 hover:underline">Archive</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* On a phone a twelve-column table is unreadable, so the same rows are
              cards — the identical component the board uses. */}
          <div className="md:hidden space-y-2">
            {loading ? (
              <div className="space-y-2">
                <div className="skeleton h-20 rounded-lg" />
                <div className="skeleton h-20 rounded-lg" />
              </div>
            ) : tasks.length === 0 ? (
              <p className="text-center text-gray-500 py-8 text-sm">No tasks.</p>
            ) : tasks.map((t) => <TaskCard key={t._id} task={t} base="/admin/tasks" />)}
          </div>

          {pages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}
                className="inline-flex items-center gap-1 px-3 py-2 text-sm border rounded-lg disabled:opacity-40"
                style={{ minHeight: 40 }}>
                <FiChevronLeft size={14} /> Previous
              </button>
              <span className="text-sm text-gray-500">Page {page} of {pages}</span>
              <button type="button" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}
                className="inline-flex items-center gap-1 px-3 py-2 text-sm border rounded-lg disabled:opacity-40"
                style={{ minHeight: 40 }}>
                Next <FiChevronRight size={14} />
              </button>
            </div>
          )}
        </>
      )}

      {/* ===== BOARD ===== */}
      {tab === 'board' && (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {(board.length ? board : BOARD_COLUMNS.map((c) => ({ ...c, tasks: [] }))).map((col) => (
              <div key={col.key} className="w-64 shrink-0">
                <div className="flex items-center justify-between mb-2 px-1">
                  <span className="text-sm font-medium text-gray-700">{col.label}</span>
                  <span className="text-xs text-gray-400 tabular-nums">{(col.tasks || []).length}</span>
                </div>
                <div className="space-y-2 min-h-[80px] rounded-lg bg-gray-50 p-2">
                  {loading ? (
                    <div className="skeleton h-20 rounded-lg" />
                  ) : (col.tasks || []).length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-4">Nothing here</p>
                  ) : col.tasks.map((t) => <TaskCard key={t._id} task={t} base="/admin/tasks" />)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== APPROVALS ===== */}
      {tab === 'approvals' && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Task</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Who</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Submitted</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Step</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Decide</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={5} className="px-4 py-4"><div className="skeleton h-4 rounded" /></td></tr>
                ) : approvals.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                    Nothing is waiting on you.
                  </td></tr>
                ) : approvals.map((t) => (
                  <tr key={t._id}>
                    <td className="px-4 py-3">
                      <TaskTitleLink task={t} base="/admin/tasks" />
                      {(t.submissions || [])[0]?.remarks && (
                        <div className="mt-0.5 text-xs text-gray-500 max-w-md truncate">
                          {t.submissions[0].remarks}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3"><AssigneeList task={t} /></td>
                    <td className="px-4 py-3 text-gray-600">
                      {t.submittedAt ? formatDateTime12(t.submittedAt) : '—'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{t.step?.name || '—'}</td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {!viewOnly && (
                        <>
                          <button type="button"
                            onClick={async () => {
                              const note = await promptDialog({
                                message: `Approve "${t.title}"?`, placeholder: 'Remark (optional)', confirmText: 'Approve',
                              });
                              if (note === null) return;
                              try {
                                await T.approveTask(t._id, { note });
                                toast.success('Approved');
                                await load();
                              } catch (err) { toast.error(err.response?.data?.message || 'Could not approve'); }
                            }}
                            className="px-3 py-1.5 text-xs rounded-lg bg-gray-900 text-white hover:bg-gray-700 mr-2"
                            style={{ minHeight: 32 }}>
                            Approve
                          </button>
                          <button type="button"
                            onClick={async () => {
                              const note = await promptDialog({
                                message: 'What needs changing?', confirmText: 'Send back',
                              });
                              if (!note) return;
                              try {
                                await T.rejectTask(t._id, note);
                                toast.success('Sent back');
                                await load();
                              } catch (err) { toast.error(err.response?.data?.message || 'Could not send back'); }
                            }}
                            className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-700 hover:bg-red-50"
                            style={{ minHeight: 32 }}>
                            Send back
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== WORKLOAD ===== */}
      {tab === 'workload' && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-700">Department</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Active</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Overdue</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Due today</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Completed</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Estimated</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-700">Logged</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={8} className="px-4 py-4"><div className="skeleton h-4 rounded" /></td></tr>
                ) : people.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-8 text-center text-gray-500">Nobody has any tasks.</td></tr>
                ) : people.map((p) => (
                  <tr key={String(p.user)}>
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {p.name}
                      {p.employeeCode && <span className="ml-2 text-xs text-gray-400">{p.employeeCode}</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{p.department || '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{p.active}</td>
                    <td className={`px-4 py-3 text-right tabular-nums ${p.overdue > 0 ? 'text-red-600 font-medium' : 'text-gray-400'}`}>
                      {p.overdue || '—'}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">{p.dueToday || '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-600">{p.completed}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-500">{p.estimatedHours ? `${p.estimatedHours}h` : '—'}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-gray-900">{p.loggedHours ? `${p.loggedHours}h` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-4 py-3 text-xs text-gray-400 border-t border-gray-100">
            A task with several people on it counts on every one of their plates — that is what a workload is.
          </p>
        </div>
      )}

      {/* ===== INCENTIVES ===== */}
      {tab === 'incentives' && (
        <div>
          {pendingPoints > 0 && (
            <StatTiles tiles={[
              { label: 'Awards waiting', value: incentives.length },
              { label: 'Points proposed', value: pendingPoints },
            ]} />
          )}
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Task</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">Outcome</th>
                    <th className="px-4 py-3 text-left font-medium text-gray-700">How it was worked out</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-700">Points</th>
                    <th className="px-4 py-3 text-right font-medium text-gray-700">Decide</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr><td colSpan={6} className="px-4 py-4"><div className="skeleton h-4 rounded" /></td></tr>
                  ) : incentives.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      No task incentives are waiting.
                    </td></tr>
                  ) : incentives.map((a) => (
                    <tr key={a._id}>
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {a.name}
                        {a.employeeCode && <span className="ml-2 text-xs text-gray-400">{a.employeeCode}</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => navigate(`/admin/tasks/${a.task?._id || a.task}`)}
                          className="text-blue-600 hover:underline text-left">
                          {a.taskTitle || a.task?.title}
                        </button>
                        <div className="text-xs text-gray-400">{a.taskCode}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-600">{INCENTIVE_OUTCOME_LABELS[a.outcome] || a.outcome}</td>
                      <td className="px-4 py-3 text-xs text-gray-500">{a.basis}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">{a.points}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        {!viewOnly && (
                          <>
                            <button type="button"
                              onClick={async () => {
                                const edited = await promptDialog({
                                  message: `Credit points to ${a.name}?`,
                                  inputLabel: 'Points',
                                  inputType: 'number',
                                  placeholder: String(a.points),
                                  confirmText: 'Credit',
                                });
                                if (edited === null) return;
                                try {
                                  await T.decideIncentive(a._id, {
                                    decision: 'approve',
                                    points: edited === '' ? undefined : Number(edited),
                                  });
                                  toast.success('Points credited');
                                  await load();
                                } catch (err) { toast.error(err.response?.data?.message || 'Could not credit'); }
                              }}
                              className="px-3 py-1.5 text-xs rounded-lg bg-gray-900 text-white hover:bg-gray-700 mr-2"
                              style={{ minHeight: 32 }}>
                              Credit
                            </button>
                            <button type="button"
                              onClick={async () => {
                                const note = await promptDialog({ message: 'Why not?', confirmText: 'Decline' });
                                if (!note) return;
                                try {
                                  await T.decideIncentive(a._id, { decision: 'reject', note });
                                  toast.success('Declined');
                                  await load();
                                } catch (err) { toast.error(err.response?.data?.message || 'Could not decline'); }
                              }}
                              className="px-3 py-1.5 text-xs rounded-lg border border-red-200 text-red-700 hover:bg-red-50"
                              style={{ minHeight: 32 }}>
                              Decline
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="px-4 py-3 text-xs text-gray-400 border-t border-gray-100">
              Crediting puts the points into the same company-wide pool as every other incentive — they show up on
              the Points Dashboard and are paid from there. Nothing here touches payroll.
            </p>
          </div>
        </div>
      )}

      {editing !== undefined && (
        <TaskFormModal
          task={editing}
          meta={meta}
          users={users}
          projects={projects}
          workLocations={workLocations}
          onSave={save}
          onClose={() => setEditing(undefined)}
        />
      )}
    </div>
  );
}
