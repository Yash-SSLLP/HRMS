/**
 * Task router — mounted at /api/tasks.
 *
 * REWRITTEN 2026-09-21. Two routers and sixty routes became one router and
 * twenty, and the permission model became a sentence:
 *
 *   EVERYBODY may assign work, and assigning it is not a privilege —
 *   `tasks.manage` only decides who sees EVERYONE'S tasks and the team
 *   dashboard.
 *
 * That is the change the brief asked for ("any employee can give the task to
 * any other teammate"), narrowed by the direction rule: work goes down the
 * reporting line or across it, and an upward ask becomes a REQUEST instead.
 * That rule is enforced in services/taskAccess, per assignee, on every create
 * and on every edit that changes who is on a task — not here, because a router
 * cannot see who was picked.
 *
 * Everything else is authorised by IDENTITY inside the handler: the person who
 * may complete a task is whoever the task says it is on, and the person who may
 * change its terms is whoever set it. The same shape /recruitment/my-interviews
 * uses.
 *
 * ROUTE ORDER MATTERS. Every literal path (`/meta`, `/categories`, `/templates`,
 * `/dashboard`, `/recurring`) is declared before `/:id`, or Express matches it
 * as an id and each of them 404s on a task that does not exist.
 */
const express = require('express');
const { createUpload } = require('../middleware/upload');
const { protect, requirePermission, restrictTo } = require('../middleware/authMiddleware');

const task = require('../controllers/taskController');
const tpl = require('../controllers/taskTemplateController');
const dash = require('../controllers/taskDashboardController');

const router = express.Router();

/**
 * Attachments and voice notes on one multipart request.
 *
 * `.any()` rather than a field list because the voice note arrives under
 * `voice` alongside any number of `files`, and a browser cannot send two
 * requests atomically — a task that saved without the recording somebody just
 * made is a bad surprise. The handlers split them by `fieldname`.
 *
 * 25 MB each, 10 files: generous because three photos off a modern phone are
 * several MB, capped because this goes into GridFS on the same cluster as
 * everything else. The allowlist matches on MIME *or* extension — an Android
 * file provider that cannot identify a PDF sends application/octet-stream, and
 * matching on the type alone rejected perfectly good files in the expense
 * module for exactly that reason.
 */
const taskUpload = createUpload({
  limits: { fileSize: 25 * 1024 * 1024, files: 11 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image|video|audio)\//.test(file.mimetype)
      || file.mimetype === 'application/pdf'
      || /officedocument|ms-excel|msword|spreadsheet|presentation/.test(file.mimetype)
      || file.mimetype === 'text/csv'
      || file.mimetype === 'application/octet-stream'
      || /\.(pdf|jpe?g|png|webp|heic|heif|gif|mp4|mov|webm|mp3|m4a|wav|amr|ogg|docx?|xlsx?|pptx?|csv|txt)$/i
        .test(file.originalname || '');
    cb(ok ? null : new Error('That kind of file cannot be attached to a task.'), ok);
  },
});

router.use(protect);

/* ── TEMPORARY DIAGNOSTIC — REMOVE ──────────────────────────────────────────
   Added 2026-09-22 to catch a reported "That task no longer exists." that
   cannot be reproduced from a script: every task opens fine for all twelve
   admin accounts over real HTTP, so the failing request is some OTHER call the
   page makes. This records any task request that does not return 2xx, with the
   path, the account and the message, so one click in the browser says exactly
   which endpoint it is. Writes to backend/logs/task-errors.log and nothing
   else; delete this block once the cause is known. */
router.use((req, res, next) => {
  res.on('finish', () => {
    if (res.statusCode < 400) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, '..', 'logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'task-errors.log'),
        `${new Date().toISOString()}  ${res.statusCode}  ${req.method} ${req.originalUrl}`
        + `  user=${req.user?._id || '?'} (${req.user?.role || '?'})\n`);
    } catch { /* a diagnostic must never break a request */ }
  });
  next();
});
/* ── end TEMPORARY DIAGNOSTIC ───────────────────────────────────────────── */

/* ============================================================
   Reference data — what the assign form needs
   ============================================================ */

router.get('/meta', task.taskMeta);
router.get('/counters', task.taskCounters);

router.get('/categories', task.listCategories);
// Anybody may ADD a category: the + beside the picker is the whole point
// (models/TaskCategory) — somebody filing the first task for a new project at
// nine at night should not have to wait for an admin.
router.post('/categories', task.createCategory);
// REMOVING one is a SuperAdmin's alone. Adding affects the person adding;
// removing hides the category from everybody and from every filter, which is a
// company-wide decision rather than a supervisor's — the same reasoning that
// keeps the leave hierarchy and the leaderboard's visibility SuperAdmin-only.
// User decision, 2026-09-21.
router.delete('/categories/:id', restrictTo('SuperAdmin'), task.deleteCategory);
router.patch('/categories/:id', restrictTo('SuperAdmin'), task.renameCategory);

/* ============================================================
   Templates & the directory
   ============================================================ */

router.get('/templates', tpl.listTemplates);
router.post('/templates', tpl.createTemplate);
router.post('/templates/:id/copy', tpl.copyTemplate);
router.get('/templates/:id/prefill', tpl.prefillFromTemplate);
router.patch('/templates/:id', tpl.updateTemplate);
router.delete('/templates/:id', tpl.deleteTemplate);

/* ============================================================
   Repeating schedules
   ============================================================ */

router.get('/recurring', tpl.listRecurring);
router.patch('/recurring/:id', tpl.updateRecurring);
router.delete('/recurring/:id', tpl.deleteRecurring);
router.post('/recurring/:id/run', tpl.runRecurringNow);

/* ============================================================
   The dashboard
   ============================================================ */

// No capability here: `view=mine` is every employee's own report and needs
// none. The `employee` view checks `tasks.manage` inside the handler, so an
// ordinary person gets a clear message rather than a blanket 403 on the tab.
router.get('/dashboard', dash.dashboard);
router.get('/dashboard/overdue', dash.overdueReport);

/* ============================================================
   The tasks themselves
   ============================================================ */

router.get('/', task.listTasks);
// The same filters as the list, grouped into the four board columns. Declared
// BEFORE '/:id' or Express would read "board" as a task id.
router.get('/board', task.boardTasks);
// Not gated. See the docblock: assigning is not a privilege, direction is.
router.post('/', taskUpload.any(), task.createTask);

router.get('/:id', task.getTask);
router.patch('/:id', taskUpload.any(), task.updateTask);
router.put('/:id', taskUpload.any(), task.updateTask);
router.delete('/:id', task.deleteTask);

// The ONE endpoint that moves a STATUS. There is still no /start or /complete —
// two endpoints doing one thing is two places for the rule to drift.
router.post('/:id/status', taskUpload.any(), task.changeStatus);

/* --- The doer's three answers to being handed work ---------------------
   None of them goes through the transition table. Accepting takes the job on —
   and since 2026-09-22 it also STARTS it, because the brief describes the board
   as "in todo all the assigned task will come, after accepting that it will
   come to in progress". Declining hands the problem back without cancelling
   anything. Delegating changes WHO rather than WHERE, and moves the approval to
   the delegator (models/Task.approver).

   Each is gated by identity inside the engine — only somebody actually on the
   task may use them, so an assigner cannot accept on a doer's behalf. */
router.post('/:id/accept', task.acceptTask);
router.post('/:id/decline', task.declineTask);
router.post('/:id/delegate', task.delegateTask);

/* --- Handing it in, and the two answers to that ------------------------
   Added 2026-09-22. All three are the ONE status endpoint underneath; they
   exist as their own routes for the WORDING, because "Submit", "Approve" and
   "Send back" are not "mark it in progress" however much they share a code
   path, and a client that had to work out which move its button meant would be
   re-deriving the server's review rule. Rejecting REQUIRES a note — a
   submission sent back with no reason is a task that will come back identical. */
router.post('/:id/submit', taskUpload.any(), task.submitTask);
router.post('/:id/approve', taskUpload.any(), task.approveTask);
router.post('/:id/reject', taskUpload.any(), task.rejectTask);

/* --- How far along ----------------------------------------------------- */
router.patch('/:id/progress', task.setProgress);

/* --- More time ---------------------------------------------------------
   The doer asks, the assigner answers. Not a status: the work carries on while
   the answer is awaited. Approving MOVES the deadline and re-arms the
   reminders; neither answer touches anybody's frozen `completedLate`. */
router.post('/:id/extension', task.askExtension);
router.post('/:id/extension/:reqId', task.decideExtension);

/* --- Pieces ------------------------------------------------------------
   A piece is a TASK OF ITS OWN (models/Task.parentTask) as of 2026-09-22, so
   it carries its own points, deadline, progress and submission and shows up in
   its owner's list. Anybody on the task may split it — the person doing the
   work is the one who knows what the pieces are. A piece with no owner is
   OFFERED to `openTo` and the first person to claim it gets it. */
router.post('/:id/split', task.splitTask);
router.post('/:id/claim', task.claimTask);

/* --- It went to the wrong person --------------------------------------
   TRANSFER, which is the opposite of DELEGATE in the one way that matters:
   the person it comes off drops out of the task completely, including out
   of its notifications. Whoever set it and whoever it is on may both do it,
   because they are the two people who can see the mistake. */
router.post('/:id/transfer', task.transferTask);
router.get('/:id/children', task.getChildren);

/* --- The old subtask endpoints, kept working ---------------------------
   Adapters onto child tasks. An Android build from before 2026-09-22 calls all
   three, and an APK in somebody's pocket does not update because the server
   did. `:subId` is a child task's id now; an old client only ever round-trips
   the id it was given, so it cannot tell. */
router.post('/:id/subtasks', task.addSubtasks);
router.patch('/:id/subtasks/:subId', task.setSubtask);
router.delete('/:id/subtasks/:subId', task.removeSubtask);

router.get('/:id/updates', task.taskFeed);
router.post('/:id/updates', taskUpload.any(), task.addUpdate);

router.get('/:id/files/:fileId', task.downloadFile);
router.get('/:id/updates/:updateId/voice', task.downloadUpdateVoice);

module.exports = router;
