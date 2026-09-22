/**
 * One task, on its own page.
 *
 * REWRITTEN 2026-09-22 — and it is now nine lines of shell, because the whole
 * view moved into components/task/TaskDetailBody.jsx. The modal that every list
 * row and board card opens renders that same component, so there is ONE detail
 * view in this module and not two.
 *
 * That is not tidiness for its own sake. The version this replaces was a page,
 * and the quick-look panel beside the list was going to be a second copy of it;
 * the module before that had exactly that arrangement, and within a week the
 * panel could accept a task and the page could not, because a `can` flag was
 * added in one file.
 *
 * THE PAGE STILL MATTERS. It is what a notification link, a bookmark, a browser
 * tab somebody keeps open all afternoon and a copied URL all point at, so the
 * route and its two mounts (`/admin/tasks/:id`, `/employee/tasks/:id`) are
 * unchanged.
 *
 * NO <PageHeader>. The body opens with the task's own header — the accent rail,
 * the code, the title as the thing you can edit in place — and a page heading
 * above it would print the same title twice, one of them dead.
 */
import { Link, useNavigate, useParams } from 'react-router-dom';
import { FiArrowLeft } from 'react-icons/fi';
import TaskDetailBody from '../components/task/TaskDetailBody';

export default function TaskDetail({ base = '/employee/tasks' }) {
  const { id } = useParams();
  const navigate = useNavigate();

  return (
    <div>
      <Link
        to={base}
        /* NOT `hover:underline` — index.css restyles anything carrying that
           class into a filled pill button, which a back link is not. */
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-gray-500 transition hover:text-blue-600 min-h-[32px]"
      >
        <FiArrowLeft size={14} /> Back to tasks
      </Link>

      <TaskDetailBody
        key={id}
        taskId={id}
        base={base}
        /* A piece is a task of its own and has its own URL, so opening one on a
           page NAVIGATES — the back button then walks back up the split, which
           is what somebody three pieces deep expects. */
        onOpenTask={(childId) => navigate(`${base}/${childId}`)}
        /* Removed, or never ours to see. Either way there is nothing to show. */
        onGone={() => navigate(base)}
      />
    </div>
  );
}
