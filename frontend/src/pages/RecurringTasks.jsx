/**
 * Recurring Tasks — the schedules, on a page of their own.
 *
 * NEW 2026-09-28. Until today this was the "Recurring" tab inside Tasks (added
 * 2026-09-27). The user, pointing at the sidebar: *"in mobile app and web the
 * Task and Recurring both should be in very different tab"* — so it is its own
 * row under Projects & Resources, right below Tasks, in both portals.
 *
 * …AND IT IS A GRANT: *"for Recurring … it should be as Permission based —
 * Super Admin can decide who to give"*. A Super Admin by role, anybody else
 * with the switch on Permissions (User.taskRecurringAccess). The sidebar row is
 * hidden without it, and every /tasks/recurring route refuses (routes/
 * taskRoutes.requireRecurring) — this page only says so politely to somebody
 * who followed an old link here.
 *
 * What it lists is SCHEDULES, not tasks: each occurrence is an ordinary task
 * that lands in the doer's Tasks when it is due to appear and is worked there.
 * Adding one is the floating button, the same shape as Tasks' "Assign task".
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { FiPlus, FiList, FiLock } from 'react-icons/fi';
import PageHeader from '../components/PageHeader';
import useViewOnly from '../hooks/useViewOnly';
import AssignTaskModal from '../components/task/AssignTaskModal';
import TaskRecurring from '../components/task/TaskRecurring';
import { useAuthStore } from '../store/authStore';
import { canManageRecurringTasks } from '../config/permissions';
import * as T from '../api/tasks';

export default function RecurringTasks({ tasksBase = '/employee/tasks' }) {
  const viewOnly = useViewOnly();
  const user = useAuthStore((s) => s.user);

  const [meta, setMeta] = useState(null);
  const [formOpen, setFormOpen] = useState(false);
  /** null = a new schedule; an id = that schedule, being edited. */
  const [scheduleId, setScheduleId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    T.taskMeta().then(setMeta).catch(() => toast.error('Could not load the task lists.'));
  }, []);

  // The server's word once it is in (fresher than a sign-in cached before a
  // Super Admin flipped the switch); the signed-in account's until then.
  const allowed = meta ? Boolean(meta.canRecur) : canManageRecurringTasks(user);
  const fab = allowed && !viewOnly;

  const openForm = (row = null) => {
    setScheduleId(row?._id || null);
    setFormOpen(true);
  };

  return (
    <div className={fab ? 'pb-20' : ''}>
      {/* Portalled to <body>, as on Tasks: the page wrapper animates in with a
          transform, and a transformed ancestor captures position:fixed. */}
      {fab && createPortal(
        <button
          type="button"
          onClick={() => openForm(null)}
          className="fixed bottom-5 right-5 z-30 inline-flex items-center gap-2 rounded-full bg-green-600 px-5 text-sm font-semibold text-white shadow-lg shadow-green-900/20 transition hover:bg-green-700 min-h-[48px] sm:bottom-6 sm:right-6 print:hidden"
        >
          <FiPlus size={18} /> New recurring task
        </button>,
        document.body,
      )}

      <PageHeader
        title="Recurring Tasks"
      >
        <Link
          to={tasksBase}
          className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3.5 text-sm font-medium text-gray-700 transition hover:border-gray-300 hover:text-blue-600 min-h-[40px]"
        >
          <FiList size={15} /> <span className="hidden sm:inline">Go to Tasks</span>
        </Link>
      </PageHeader>

      {allowed ? (
        <TaskRecurring
          viewOnly={viewOnly}
          isAdmin={Boolean(meta?.isAdmin)}
          refreshKey={refreshKey}
          onEdit={(row) => openForm(row)}
          showIntro={false}
        />
      ) : (
        <div className="rounded-2xl border border-dashed border-gray-300 bg-white px-6 py-12 text-center">
          <span className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-gray-100 text-gray-500">
            <FiLock size={20} />
          </span>
          <p className="font-semibold text-gray-800">Recurring tasks need a permission</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-gray-500">
            Ask a Super Admin to switch it on.
          </p>
        </div>
      )}

      <AssignTaskModal
        open={formOpen}
        onClose={() => { setFormOpen(false); setScheduleId(null); }}
        onCreated={() => setRefreshKey((n) => n + 1)}
        meta={meta}
        prefill={null}
        recurring
        scheduleId={scheduleId}
      />
    </div>
  );
}
