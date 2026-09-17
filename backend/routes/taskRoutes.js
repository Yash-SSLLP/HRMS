/**
 * Task router — mounted at /api/tasks.
 *
 * Three tiers, in this order, and the order is the permission model:
 *
 *   1. SELF-SERVICE — anything keyed to who you are. My tasks, my timer, my
 *      approvals inbox. No capability at all.
 *   2. PER-TASK — accept, start, submit, approve, comment, extend. Authorised
 *      by IDENTITY inside the handler (services/taskAccess), because the person
 *      entitled to approve a task is whoever the task says it is, not whoever
 *      holds a grant. This is the same shape /recruitment/my-interviews uses.
 *   3. ADMINISTRATION — creating, editing, deleting, bulk changes, and the
 *      incentive queue. Behind `tasks.manage`, the capability that already
 *      existed before this module was reworked.
 *
 * Workflows, templates and recurrence are NOT here — they are standing
 * configuration behind their own `tasks.workflow` capability, in
 * routes/taskWorkflowRoutes.js.
 *
 * ROUTE ORDER MATTERS. Every literal path (`/me`, `/board`, `/approvals`,
 * `/incentives`) is declared before `/:id`, or Express would match them as an
 * id and every one of them would 404 on a task that does not exist.
 */
const express = require('express');
const { createUpload } = require('../middleware/upload');
const { protect, requirePermission, requireIncentiveCreditor } = require('../middleware/authMiddleware');

const task = require('../controllers/taskController');
const work = require('../controllers/taskWorkController');
const analytics = require('../controllers/taskAnalyticsController');

const router = express.Router();

// Evidence: 10 files, 25 MB each. Generous because section 17 asks for video and
// a warehouse inspection's three photos off a modern phone are several MB each;
// capped because this goes into GridFS on the same cluster as everything else.
// The allowlist is by MIME *or* extension — an Android file provider that cannot
// identify a PDF sends application/octet-stream, and matching on the type alone
// rejected perfectly good files in the expense module for exactly that reason.
const evidenceUpload = createUpload({
  limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image|video|audio)\//.test(file.mimetype)
      || file.mimetype === 'application/pdf'
      || /officedocument|ms-excel|msword|spreadsheet|presentation/.test(file.mimetype)
      || file.mimetype === 'text/csv'
      || file.mimetype === 'application/octet-stream'
      || /\.(pdf|jpe?g|png|webp|heic|heif|gif|mp4|mov|webm|mp3|m4a|wav|amr|docx?|xlsx?|pptx?|csv|txt)$/i
        .test(file.originalname || '');
    cb(ok ? null : new Error('That kind of file cannot be attached to a task.'), ok);
  },
});

router.use(protect);

/* ============================================================
   1. SELF-SERVICE — no capability needed
   ============================================================ */

// GET /me — the signed-in person's own tasks; protected.
router.get('/me', task.listMyTasks);
// GET /me/summary — the counts an employee dashboard shows; protected.
router.get('/me/summary', task.myTaskSummary);
// GET /me/timer — the running timer, wherever it is; protected.
router.get('/me/timer', work.myTimer);
// PATCH /me/:id/status — move a task assigned to YOU.
//
// THE COMPATIBILITY ROUTE. This is the shape the module had before the
// 2026-09-17 rework, and it is what every Android build already on a phone
// calls. Removing it would break the app in the field rather than in a test,
// so it stays: it normalises the old four status words (engine.transition
// does, via normaliseStatus) and routes into the same state machine as
// everything else, so an old client gets the new rules rather than the old
// ones. It is NOT deprecated by neglect — new clients use POST /:id/status,
// /accept, /start and /submit, which carry location and evidence.
router.patch('/me/:id/status', task.changeStatus);

// GET /me/timesheet — own time across every task, by day; protected.
router.get('/me/timesheet', work.myTimesheet);
// GET /approvals — everything waiting on this person to decide; protected.
router.get('/approvals', work.myApprovals);
// GET /meta — the catalogues and lists the task forms need; protected.
router.get('/meta', task.taskMeta);
// GET /board — the same tasks grouped into Kanban columns; protected.
router.get('/board', task.taskBoard);

/* ============================================================
   3a. ADMINISTRATION — literal paths, declared before /:id
   ============================================================ */

// GET /incentives — task incentives awaiting sanction; protected, requires 'tasks.manage'.
router.get('/incentives', requirePermission('tasks.manage'), work.listIncentives);
// PATCH /incentives/:awardId — sanction or refuse one; protected, requires the
// same standing as crediting points anywhere else in the portal (HR, CEO, MD,
// SuperAdmin, or a manager of every incentive) — NOT merely 'tasks.manage',
// because this puts points into the company-wide pool.
router.patch('/incentives/:awardId', requireIncentiveCreditor, work.decideIncentive);

// PATCH /time-entries/:entryId — approve or reject claimed time; protected
// (authorised by identity in the handler: the task's reviewer).
router.patch('/time-entries/:entryId', work.decideTimeEntry);
// PATCH /extensions/:extensionId — grant or refuse an extension; protected
// (authorised by identity in the handler).
router.patch('/extensions/:extensionId', work.decideExtension);

// POST /bulk — act on many tasks at once; protected, requires 'tasks.manage'.
router.post('/bulk', requirePermission('tasks.manage'), task.bulkAction);

// GET /analytics — organisation-wide task metrics; protected, requires 'tasks.manage'.
router.get('/analytics', requirePermission('tasks.manage'), analytics.taskAnalytics);
// GET /workload — per-employee load for a manager's dashboard; protected.
router.get('/workload', analytics.workload);
// GET /export — tasks as a spreadsheet; protected, requires 'tasks.manage'.
router.get('/export', requirePermission('tasks.manage'), analytics.exportTasks);
// GET /export/timesheet — time entries as a spreadsheet; protected, requires 'tasks.manage'.
router.get('/export/timesheet', requirePermission('tasks.manage'), analytics.exportTimesheet);

/* ============================================================
   2 + 3b. THE LIST, AND EVERYTHING ABOUT ONE TASK
   ============================================================ */

// GET / — list tasks the caller may see; protected (the visibility filter does
// the narrowing, so an ordinary employee gets their own and their team's).
router.get('/', task.listTasks);
// POST / — create a task; protected, requires 'tasks.manage'.
router.post('/', requirePermission('tasks.manage'), task.createTask);

// GET /:id — one task with everything the detail page shows; protected.
router.get('/:id', task.getTask);
// PATCH /:id — update a task; PUT is the old shape and behaves identically;
// protected (authorised by identity: creator, supervisor, or 'tasks.manage').
router.patch('/:id', task.updateTask);
router.put('/:id', task.updateTask);
// DELETE /:id — archive, or ?hard=true to delete; protected (identity).
router.delete('/:id', task.deleteTask);

// ----- lifecycle -----
// POST /:id/status — any move the caller is entitled to make; protected.
router.post('/:id/status', task.changeStatus);
// POST /:id/accept — take on a task you were given; protected (assignee).
router.post('/:id/accept', task.acceptTask);
// POST /:id/decline — refuse it, with a reason; protected (assignee).
router.post('/:id/decline', task.declineTask);
// POST /:id/start — begin work (dependency + geofence gates); protected (assignee).
router.post('/:id/start', task.startTask);
// POST /:id/submit — hand it back with evidence; protected (assignee) + multer
// array 'files' (10 × 25 MB).
router.post('/:id/submit', evidenceUpload.array('files', 10), work.submitTask);
// POST /:id/review — take it under review; protected (reviewer).
router.post('/:id/review', work.beginReview);
// POST /:id/approve — approve; protected (reviewer).
router.post('/:id/approve', work.approveTask);
// POST /:id/reject — send it back; protected (reviewer).
router.post('/:id/reject', work.rejectTask);
// POST /:id/steps/:stepKey/decide — decide ONE workflow step, for a parallel
// group where "approve the task" would be ambiguous; protected (the step's actor).
router.post('/:id/steps/:stepKey/decide', work.decideStep);

// ----- working on it -----
// PATCH /:id/checklist/:itemId — tick or untick an item; protected.
router.patch('/:id/checklist/:itemId', task.setChecklistItem);
// PATCH /:id/progress — set your own progress figure; protected (assignee).
router.patch('/:id/progress', task.setProgress);

// ----- people -----
// POST /:id/assignees — add somebody; protected (identity: can edit).
router.post('/:id/assignees', task.addAssignee);
// DELETE /:id/assignees/:userId — take somebody off; protected (identity).
router.delete('/:id/assignees/:userId', task.removeAssignee);
// POST /:id/handover — hand the task to somebody else; protected (the holder,
// or anyone who may edit it).
router.post('/:id/handover', task.handoverTask);

// ----- time -----
// POST /:id/timer/start — start the clock; protected (assignee).
router.post('/:id/timer/start', work.startTimer);
// POST /:id/timer/:action — pause | resume | stop; protected (assignee).
router.post('/:id/timer/:action', work.controlTimer);
// POST /:id/time-entry — record work already done; protected.
router.post('/:id/time-entry', work.addManualTime);
// GET /:id/timesheet — the task's time, by person and by day; protected.
router.get('/:id/timesheet', work.taskTimesheet);

// ----- talking about it -----
// GET /:id/comments — the task's remarks; protected (internal notes filtered).
router.get('/:id/comments', work.listComments);
// POST /:id/comments — add one; protected + multer array 'files'.
router.post('/:id/comments', evidenceUpload.array('files', 10), work.addComment);

// ----- deadlines -----
// POST /:id/extensions — ask for longer; protected (assignee) + multer 'files'.
router.post('/:id/extensions', evidenceUpload.array('files', 5), work.requestExtension);

// ----- files -----
// POST /:id/attachments — hang files on the task; protected + multer 'files'.
router.post('/:id/attachments', evidenceUpload.array('files', 10), work.addAttachments);
// GET /:id/files/:fileId — stream one file back; authorised by the TASK, so
// anyone who may see the task may see its files and nobody else; protected.
router.get('/:id/files/:fileId', work.downloadFile);

// ----- history -----
// GET /:id/activity — the task's immutable trail; protected.
router.get('/:id/activity', work.taskActivity);

module.exports = router;
