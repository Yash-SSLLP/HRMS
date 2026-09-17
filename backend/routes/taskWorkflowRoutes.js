/**
 * Task configuration router — mounted at /api/task-workflows.
 *
 * Workflows, templates and recurring schedules: how every FUTURE task is routed,
 * as opposed to any individual piece of work. All of it behind
 * `tasks.workflow`, which is its own capability for the same reason
 * `leaveHierarchy.manage` is separate from `leave.manage` — running today's
 * tasks is a day's work, and deciding who approves what from now on is a
 * standing decision an HR Manager does not get merely by being HR.
 *
 * READING is wider than writing. `/templates` is readable by anyone who can
 * create a task, because choosing a template is part of creating one; the rest
 * needs the capability.
 *
 * ROUTE ORDER: `/templates` and `/recurring` are declared before `/:id`, or
 * Express would read them as workflow ids.
 */
const express = require('express');
const { protect, requirePermission, requireAnyPermission } = require('../middleware/authMiddleware');
const ctrl = require('../controllers/taskWorkflowController');

const router = express.Router();

router.use(protect);

/* ===== Templates ===== */
// GET /templates — list templates; protected, requires 'tasks.manage' or
// 'tasks.workflow' (picking one is part of creating a task).
router.get('/templates', requireAnyPermission('tasks.manage', 'tasks.workflow'), ctrl.listTemplates);
// GET /templates/:id — one template; protected, same grant.
router.get('/templates/:id', requireAnyPermission('tasks.manage', 'tasks.workflow'), ctrl.getTemplate);
// POST /templates/:id/preview — what it would produce, without creating it;
// protected, same grant.
router.post('/templates/:id/preview', requireAnyPermission('tasks.manage', 'tasks.workflow'), ctrl.previewTemplate);
// POST /templates — create; protected, requires 'tasks.workflow'.
router.post('/templates', requirePermission('tasks.workflow'), ctrl.createTemplate);
// PATCH /templates/:id — edit; protected, requires 'tasks.workflow'.
router.patch('/templates/:id', requirePermission('tasks.workflow'), ctrl.updateTemplate);
// DELETE /templates/:id — delete; protected, requires 'tasks.workflow'.
router.delete('/templates/:id', requirePermission('tasks.workflow'), ctrl.deleteTemplate);

/* ===== Recurring schedules ===== */
// GET /recurring — list schedules with their next occurrence; protected, requires 'tasks.workflow'.
router.get('/recurring', requirePermission('tasks.workflow'), ctrl.listRecurring);
// POST /recurring — create one; protected, requires 'tasks.workflow'.
router.post('/recurring', requirePermission('tasks.workflow'), ctrl.createRecurring);
// PATCH /recurring/:id — edit; protected, requires 'tasks.workflow'.
router.patch('/recurring/:id', requirePermission('tasks.workflow'), ctrl.updateRecurring);
// DELETE /recurring/:id — delete the schedule (its tasks stay); protected, requires 'tasks.workflow'.
router.delete('/recurring/:id', requirePermission('tasks.workflow'), ctrl.deleteRecurring);
// POST /recurring/:id/run — make the next instance now; protected, requires 'tasks.workflow'.
router.post('/recurring/:id/run', requirePermission('tasks.workflow'), ctrl.runRecurringNow);

/* ===== Workflows ===== */
// GET / — list workflows; protected, requires 'tasks.manage' or 'tasks.workflow'
// (choosing one is part of creating a task).
router.get('/', requireAnyPermission('tasks.manage', 'tasks.workflow'), ctrl.listWorkflows);
// GET /:id — one workflow with its draft and versions; protected, requires 'tasks.workflow'.
router.get('/:id', requirePermission('tasks.workflow'), ctrl.getWorkflow);
// POST / — create a workflow (a draft; it runs nothing until published);
// protected, requires 'tasks.workflow'.
router.post('/', requirePermission('tasks.workflow'), ctrl.createWorkflow);
// PATCH /:id — edit the DRAFT only; published versions are append-only and are
// never touched; protected, requires 'tasks.workflow'.
router.patch('/:id', requirePermission('tasks.workflow'), ctrl.updateWorkflow);
// POST /:id/publish — snapshot the draft as a new immutable version and make it
// the one new tasks pick up; protected, requires 'tasks.workflow'.
router.post('/:id/publish', requirePermission('tasks.workflow'), ctrl.publishWorkflow);
// POST /:id/simulate — run the resolver against a hypothetical task and show who
// would actually be asked; protected, requires 'tasks.workflow'.
router.post('/:id/simulate', requirePermission('tasks.workflow'), ctrl.simulateWorkflow);
// DELETE /:id — delete (refused while tasks are on it); protected, requires 'tasks.workflow'.
router.delete('/:id', requirePermission('tasks.workflow'), ctrl.deleteWorkflow);

module.exports = router;
