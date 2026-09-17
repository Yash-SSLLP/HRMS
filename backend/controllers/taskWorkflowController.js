/**
 * Task controller, part three — the CONFIGURATION.
 *
 * Workflows, templates and recurring schedules: the standing decisions about how
 * work is routed, rather than any individual piece of work. All of it is behind
 * the `tasks.workflow` capability, which is its own key for exactly that reason
 * (see config/permissions.js).
 *
 * THE PUBLISHING RULE, which is the whole point of this file. A workflow's
 * `draft` is freely editable and runs nothing. Publishing copies it into an
 * append-only version and bumps `activeVersion`; a version is NEVER edited and
 * NEVER deleted. Starting a task copies the version's steps onto the task, so a
 * running task stops reading this document altogether. Section 7 and section 53
 * both require that editing a workflow cannot reach into work already under way,
 * and those three layers are how that is true by construction rather than by
 * everybody being careful.
 */
const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');

const Workflow = require('../models/Workflow');
const TaskTemplate = require('../models/TaskTemplate');
const RecurringTask = require('../models/RecurringTask');
const Task = require('../models/Task');
const { validateSteps } = require('../models/Workflow');
const { nextOccurrence } = require('../models/RecurringTask');

const flow = require('../services/taskWorkflow');
const { httpError, fullName } = require('../services/taskEngine');
const { viewerCompanyScope } = require('../utils/employeeScope');

/** Narrow a config listing to the viewer's companies. Shared rows stay visible. */
function companyFilter(req) {
  const scope = viewerCompanyScope(req);
  if (!scope) return {};
  return {
    company: { $in: [...scope.ids.map((id) => new mongoose.Types.ObjectId(id)), null] },
  };
}

// ===== Workflows =====

/**
 * List workflows.
 * @route GET /api/task-workflows
 */
const listWorkflows = asyncHandler(async (req, res) => {
  const filter = { ...companyFilter(req) };
  if (req.query.active !== 'all') filter.active = req.query.active !== 'false';

  const workflows = await Workflow.find(filter)
    .select('name description taskTypes department company activeVersion active createdAt updatedAt draft versions')
    .sort({ name: 1 })
    .lean();

  // How many tasks each is running, so somebody about to deactivate one can see
  // what it would stop being offered to.
  const counts = await Task.aggregate([
    { $match: { workflowRef: { $in: workflows.map((w) => w._id) } } },
    { $group: { _id: '$workflowRef', n: { $sum: 1 } } },
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.n]));

  res.json({
    count: workflows.length,
    workflows: workflows.map((w) => ({
      ...w,
      stepCount: (w.draft || []).length,
      versionCount: (w.versions || []).length,
      taskCount: byId.get(String(w._id)) || 0,
      // The step bodies are heavy and the list does not draw them.
      draft: undefined,
      versions: (w.versions || []).map((v) => ({
        version: v.version, publishedAt: v.publishedAt, publishedByName: v.publishedByName,
        note: v.note, stepCount: (v.steps || []).length,
      })),
    })),
  });
});

/**
 * One workflow, with its draft and every published version.
 * @route GET /api/task-workflows/:id
 */
const getWorkflow = asyncHandler(async (req, res) => {
  const wf = await Workflow.findById(req.params.id)
    .populate('draft.assigneeRule.users', 'firstName lastName role')
    .lean();
  if (!wf) throw httpError(404, 'That workflow does not exist.');

  const taskCount = await Task.countDocuments({ workflowRef: wf._id });
  res.json({ workflow: wf, taskCount, problems: validateSteps(wf.draft) });
});

/**
 * Create a workflow. It starts as a draft and runs nothing until published.
 * @route POST /api/task-workflows
 */
const createWorkflow = asyncHandler(async (req, res) => {
  if (!String(req.body.name || '').trim()) throw httpError(400, 'A workflow needs a name.');
  const wf = await Workflow.create({
    name: req.body.name,
    description: req.body.description,
    taskTypes: req.body.taskTypes || [],
    department: req.body.department,
    company: req.body.company || req.user.scopeCompanyId,
    draft: normaliseDraft(req.body.steps || req.body.draft || []),
    createdBy: req.user._id,
  });
  res.status(201).json({ workflow: wf, problems: validateSteps(wf.draft) });
});

/**
 * Edit a workflow's DRAFT. Never a published version.
 * @route PATCH /api/task-workflows/:id
 */
const updateWorkflow = asyncHandler(async (req, res) => {
  const wf = await Workflow.findById(req.params.id);
  if (!wf) throw httpError(404, 'That workflow does not exist.');

  for (const f of ['name', 'description', 'taskTypes', 'department', 'active']) {
    if (req.body[f] !== undefined) wf[f] = req.body[f];
  }
  if (req.body.steps !== undefined || req.body.draft !== undefined) {
    wf.draft = normaliseDraft(req.body.steps || req.body.draft);
  }
  // Belt and braces: `versions` is append-only, so a client sending one is
  // ignored rather than trusted. Mongoose would happily overwrite the array.
  wf.updatedBy = req.user._id;
  await wf.save();

  res.json({ workflow: wf, problems: validateSteps(wf.draft) });
});

/**
 * Give every step a key and an order, so the caller does not have to.
 *
 * A key is what conditions and transitions point AT, and a missing one is a
 * workflow that dead-ends — so one is minted from the name rather than the
 * publish being refused over something the builder can fix itself. Keys already
 * set are left alone: changing one would silently re-point every branch aimed
 * at it.
 * @param {Array} steps
 * @returns {Array}
 */
function normaliseDraft(steps) {
  const used = new Set();
  return (steps || []).map((s, i) => {
    let key = String(s.key || '').trim();
    if (!key) {
      key = String(s.name || `step${i + 1}`)
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || `step${i + 1}`;
    }
    let unique = key;
    let n = 2;
    while (used.has(unique)) { unique = `${key}-${n}`; n += 1; }
    used.add(unique);
    return { ...s, key: unique, order: s.order != null ? s.order : i };
  });
}

/**
 * Publish the draft as a new version.
 *
 * REFUSED IF IT WOULD STRAND A TASK. A workflow with a step nobody can be
 * resolved to, a branch pointing at a step that does not exist, or a parallel
 * group whose members disagree about how it finishes is a task that stops moving
 * halfway through — and the person who would discover that is the employee whose
 * work is stuck, not the person who wrote it. So the problems are found here,
 * and said in sentences.
 *
 * @route POST /api/task-workflows/:id/publish
 */
const publishWorkflow = asyncHandler(async (req, res) => {
  const wf = await Workflow.findById(req.params.id);
  if (!wf) throw httpError(404, 'That workflow does not exist.');

  const problems = validateSteps(wf.draft);
  if (problems.length) {
    throw httpError(400, `This workflow cannot be published yet. ${problems.join(' ')}`);
  }

  const version = (wf.versions || []).reduce((max, v) => Math.max(max, v.version), 0) + 1;
  wf.versions.push({
    version,
    // A deep copy: the draft keeps being edited after this, and a shared
    // reference would make "immutable version" a lie the first time somebody
    // moved a step.
    steps: JSON.parse(JSON.stringify(wf.draft)),
    publishedAt: new Date(),
    publishedBy: req.user._id,
    publishedByName: fullName(req.user),
    note: req.body.note,
  });
  wf.activeVersion = version;
  wf.updatedBy = req.user._id;
  await wf.save();

  res.json({
    workflow: wf,
    version,
    message: `Published version ${version}. Tasks already running on an earlier version are untouched.`,
  });
});

/**
 * Delete a workflow.
 *
 * Refused while tasks are running on it — not because the tasks would break
 * (they carry their own copy of the steps and would carry on perfectly well) but
 * because the reporting link would dangle and "which workflow was this?" would
 * stop having an answer. Deactivating is the right move and is offered instead.
 *
 * @route DELETE /api/task-workflows/:id
 */
const deleteWorkflow = asyncHandler(async (req, res) => {
  const wf = await Workflow.findById(req.params.id);
  if (!wf) throw httpError(404, 'That workflow does not exist.');

  const inUse = await Task.countDocuments({ workflowRef: wf._id });
  if (inUse) {
    throw httpError(
      409,
      `${inUse} task${inUse === 1 ? ' is' : 's are'} on this workflow, so it cannot be deleted. Deactivate it instead — tasks already running are unaffected and it stops being offered to new ones.`
    );
  }
  const templates = await TaskTemplate.countDocuments({ workflow: wf._id });
  if (templates) {
    throw httpError(409, `${templates} template${templates === 1 ? '' : 's'} use this workflow. Point ${templates === 1 ? 'it' : 'them'} elsewhere first.`);
  }

  await wf.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Try a workflow against a hypothetical task, without creating anything.
 *
 * Section 7's builder needs to be able to answer "who would actually be asked?"
 * and "which branch would this take?" before anybody's real work depends on the
 * answer. It runs the SAME resolver the live engine runs, so a preview that
 * agrees here cannot disagree in production.
 *
 * @route POST /api/task-workflows/:id/simulate
 */
const simulateWorkflow = asyncHandler(async (req, res) => {
  const wf = await Workflow.findById(req.params.id);
  if (!wf) throw httpError(404, 'That workflow does not exist.');

  const steps = req.body.useDraft === false ? wf.activeSteps() : wf.draft;
  if (!steps || !steps.length) throw httpError(400, 'There is nothing to simulate.');

  // A throwaway, never saved: the resolver needs a task-shaped thing to read
  // supervisors and custom fields off.
  const pretend = new Task({
    title: 'Simulation',
    assignedTo: req.body.assignedTo || undefined,
    supervisor: req.body.supervisor || req.user._id,
    manager: req.body.manager || undefined,
    createdBy: req.user._id,
    department: req.body.department || wf.department,
    company: req.body.company || wf.company,
    priority: req.body.priority || 'Medium',
    customFields: req.body.customFields || [],
  });
  pretend.workflowSteps = JSON.parse(JSON.stringify(steps));

  const out = [];
  for (const s of pretend.workflowSteps) {
    if (s.type === 'condition') {
      const passed = flow.evaluateCondition(pretend, s.condition);
      out.push({
        key: s.key, name: s.name, type: s.type,
        result: passed ? 'true' : 'false',
        goesTo: passed ? s.condition?.onTrue : s.condition?.onFalse,
        actors: [],
      });
      continue;
    }
    const people = await flow.resolveActors(pretend, s);
    out.push({
      key: s.key,
      name: s.name,
      type: s.type,
      parallelGroup: s.parallelGroup,
      join: s.join,
      optional: s.optional,
      actors: people.map((p) => ({ _id: p._id, name: fullName(p), role: p.role })),
      warning: people.length ? null
        : (s.optional
          ? 'Nobody matches — this step would be skipped.'
          : 'NOBODY MATCHES. This step would be skipped and the task would run past it.'),
    });
  }

  res.json({ steps: out, problems: validateSteps(steps) });
});

// ===== Templates (section 24) =====

/** @route GET /api/task-workflows/templates */
const listTemplates = asyncHandler(async (req, res) => {
  const filter = { ...companyFilter(req) };
  if (req.query.active !== 'all') filter.active = req.query.active !== 'false';
  if (req.query.trigger) filter.trigger = req.query.trigger;

  const templates = await TaskTemplate.find(filter)
    .populate('workflow', 'name activeVersion')
    .sort({ name: 1 })
    .lean();
  res.json({ count: templates.length, templates });
});

/** @route GET /api/task-workflows/templates/:id */
const getTemplate = asyncHandler(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id)
    .populate('workflow', 'name activeVersion')
    .populate('assigneeSlots.users', 'firstName lastName role')
    .lean();
  if (!tpl) throw httpError(404, 'That template does not exist.');
  res.json({ template: tpl });
});

/** @route POST /api/task-workflows/templates */
const createTemplate = asyncHandler(async (req, res) => {
  if (!String(req.body.name || '').trim()) throw httpError(400, 'A template needs a name.');
  const tpl = await TaskTemplate.create({
    ...req.body,
    // `system` marks the templates the module seeded and protects them from
    // deletion; a client may not award itself that.
    system: false,
    company: req.body.company || req.user.scopeCompanyId,
    createdBy: req.user._id,
  });
  res.status(201).json({ template: tpl });
});

/** @route PATCH /api/task-workflows/templates/:id */
const updateTemplate = asyncHandler(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) throw httpError(404, 'That template does not exist.');
  const body = { ...req.body };
  delete body.system;
  delete body.usageCount;
  Object.assign(tpl, body, { updatedBy: req.user._id });
  await tpl.save();
  res.json({ template: tpl });
});

/** @route DELETE /api/task-workflows/templates/:id */
const deleteTemplate = asyncHandler(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) throw httpError(404, 'That template does not exist.');
  if (tpl.system) {
    throw httpError(409, 'That template is wired to an HRMS event and cannot be deleted. Deactivate it instead.');
  }
  const schedules = await RecurringTask.countDocuments({ template: tpl._id });
  if (schedules) {
    throw httpError(409, `${schedules} recurring schedule${schedules === 1 ? ' uses' : 's use'} this template. Remove ${schedules === 1 ? 'it' : 'them'} first.`);
  }
  await tpl.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * What a template would produce, without creating it.
 * @route POST /api/task-workflows/templates/:id/preview
 */
const previewTemplate = asyncHandler(async (req, res) => {
  const tpl = await TaskTemplate.findById(req.params.id);
  if (!tpl) throw httpError(404, 'That template does not exist.');
  const { buildTaskFromTemplate } = require('../services/taskTemplates');
  const fields = await buildTaskFromTemplate(tpl, {
    actor: req.user,
    subject: req.body.subject,
    at: req.body.at,
  });
  res.json({ preview: fields });
});

// ===== Recurring schedules (section 23) =====

/** @route GET /api/task-workflows/recurring */
const listRecurring = asyncHandler(async (req, res) => {
  const filter = { ...companyFilter(req) };
  if (req.query.active !== 'all') filter.active = req.query.active !== 'false';

  const rules = await RecurringTask.find(filter)
    .populate('template', 'name taskType')
    .sort({ name: 1 })
    .lean();

  res.json({
    count: rules.length,
    recurring: rules.map((r) => ({
      ...r,
      // Computed, not stored: "when is the next one?" has to stay right after
      // the schedule is edited, and a stored answer would go stale silently.
      nextOccurrence: nextOccurrence(r),
    })),
  });
});

/** @route POST /api/task-workflows/recurring */
const createRecurring = asyncHandler(async (req, res) => {
  if (!String(req.body.name || '').trim()) throw httpError(400, 'A schedule needs a name.');
  if (!mongoose.isValidObjectId(req.body.template)) throw httpError(400, 'Choose the template it should create.');

  const tpl = await TaskTemplate.findById(req.body.template).select('_id').lean();
  if (!tpl) throw httpError(400, 'That template does not exist.');

  const rule = new RecurringTask({
    ...req.body,
    company: req.body.company || req.user.scopeCompanyId,
    startsOn: req.body.startsOn ? new Date(req.body.startsOn) : new Date(),
    createdBy: req.user._id,
  });
  const next = nextOccurrence(rule);
  if (!next) {
    throw httpError(400, 'That schedule never comes round — check the dates and the frequency.');
  }
  rule.nextRunAt = next;
  await rule.save();

  res.status(201).json({ recurring: rule, nextOccurrence: next });
});

/** @route PATCH /api/task-workflows/recurring/:id */
const updateRecurring = asyncHandler(async (req, res) => {
  const rule = await RecurringTask.findById(req.params.id);
  if (!rule) throw httpError(404, 'That schedule does not exist.');
  const body = { ...req.body };
  // The generator's own bookkeeping is not the client's to set — rewriting
  // `lastOccurrenceKey` would let the same day be minted twice.
  for (const f of ['lastOccurrenceKey', 'lastGeneratedAt', 'generatedCount']) delete body[f];
  Object.assign(rule, body);
  rule.nextRunAt = nextOccurrence(rule);
  await rule.save();
  res.json({ recurring: rule, nextOccurrence: rule.nextRunAt });
});

/** @route DELETE /api/task-workflows/recurring/:id */
const deleteRecurring = asyncHandler(async (req, res) => {
  const rule = await RecurringTask.findById(req.params.id);
  if (!rule) throw httpError(404, 'That schedule does not exist.');
  // The tasks it has already made are real work and stay; they simply stop
  // having a parent schedule.
  await rule.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

/**
 * Create this schedule's next instance right now, rather than waiting.
 * @route POST /api/task-workflows/recurring/:id/run
 */
const runRecurringNow = asyncHandler(async (req, res) => {
  const rule = await RecurringTask.findById(req.params.id);
  if (!rule) throw httpError(404, 'That schedule does not exist.');
  const { generateOne } = require('../services/taskRecurrenceWorker');
  const task = await generateOne(rule, { force: true, actor: req.user });
  if (!task) throw httpError(409, 'There is nothing due for this schedule right now.');
  res.status(201).json({ task });
});

module.exports = {
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  publishWorkflow,
  deleteWorkflow,
  simulateWorkflow,
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  previewTemplate,
  listRecurring,
  createRecurring,
  updateRecurring,
  deleteRecurring,
  runRecurringNow,
  normaliseDraft,
};
