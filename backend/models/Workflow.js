const mongoose = require('mongoose');
const { NODE_TYPES, PARALLEL_JOINS, CONDITION_OPERATORS } = require('../config/taskWorkflow');

/**
 * A reusable approval/execution route that tasks can be run through
 * (sections 6–7).
 *
 * ONE DOCUMENT, MANY VERSIONS. Section 7 forbids an edit to an active workflow
 * from retroactively changing tasks already running on it, and section 53
 * repeats it: "the workflow version used by an existing task must remain
 * immutable." The shape here is what makes that true rather than merely
 * intended:
 *
 *   draft     — the steps being edited. Freely changed, runs nothing.
 *   versions  — published snapshots, APPEND ONLY. Never edited, never deleted.
 *   activeVersion — which published version a new task picks up.
 *
 * Publishing copies `draft` into a new version and bumps `activeVersion`.
 * Starting a task copies that version's steps ONTO THE TASK
 * (Task.workflowSteps), so a running task is not even reading this document any
 * more. Three layers of the same promise, and the one that actually holds is the
 * copy on the task.
 *
 * SEQUENTIAL, PARALLEL, MIXED AND CONDITIONAL all come out of one step list
 * rather than four features:
 *   - sequential: steps run in `order`;
 *   - parallel:   steps sharing a `parallelGroup` open together, and the group
 *                 finishes on its `join` rule (all / any / majority);
 *   - mixed:      a parallel group followed by an ordinary step, which is just
 *                 the two above in one list;
 *   - conditional: a step of type 'condition' evaluates a field of the task and
 *                 names the step to jump to for true and for false.
 * The spec's "if amount > 50,000 then Manager → Finance → Director, else Manager"
 * is one condition step with `onTrue` and `onFalse` pointing into the same list.
 */

const conditionSchema = new mongoose.Schema(
  {
    // A path on the task: 'priority', 'customFields.amount', 'department'.
    field: { type: String, trim: true },
    operator: { type: String, enum: CONDITION_OPERATORS, default: 'eq' },
    value: mongoose.Schema.Types.Mixed,
    onTrue: { type: String, trim: true },   // step key
    onFalse: { type: String, trim: true },  // step key; null = end
  },
  { _id: false }
);

/**
 * How a step decides who acts on it. Resolved when the step OPENS, not when the
 * workflow is published — a reporting line that changes between the two should
 * be honoured, and a named user who has since left should not silently hold up
 * every task on the route.
 */
const assigneeRuleSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      trim: true,
      default: 'user',
      // user             — the named people below
      // role             — everyone holding one of `roles`
      // permission       — everyone holding `permission` (e.g. 'payroll.manage')
      // supervisor       — the task's supervisor
      // manager          — the task's manager
      // reportingManager — the primary assignee's reporting manager
      // hrPartner        — the primary assignee's HR partner
      // creator          — whoever created the task
      // department       — the head of `department`
    },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    roles: [String],
    permission: { type: String, trim: true },
    department: { type: String, trim: true },
    // When the rule resolves to several people, must they ALL act, or is one
    // enough? 'any' is the sane default for a role- or permission-based rule —
    // an approval addressed to "HR" is satisfied by one HR.
    quorum: { type: String, enum: ['any', 'all'], default: 'any' },
  },
  { _id: false }
);

const stepSchema = new mongoose.Schema(
  {
    // Stable within the version. Transitions and conditions name steps by this,
    // never by index — inserting a step must not silently re-point a branch.
    key: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: NODE_TYPES, default: 'approval' },
    order: { type: Number, default: 0 },

    assigneeRule: { type: assigneeRuleSchema, default: () => ({}) },

    // Steps sharing this run at the same time.
    parallelGroup: { type: String, trim: true, default: null },
    join: { type: String, enum: PARALLEL_JOINS, default: 'all' },

    // An optional step can be skipped; a mandatory one cannot.
    optional: { type: Boolean, default: false },
    // Hours from opening before this step is late and starts escalating.
    slaHours: Number,
    // A 'wait' step holds this long, then advances itself.
    waitMinutes: Number,

    condition: { type: conditionSchema, default: undefined },

    // Explicit next step. Null = whatever comes next by `order`.
    next: { type: String, trim: true, default: null },
    // 'sendBack' → the task returns to its assignees to be redone;
    // 'previousStep' → the step before reopens;
    // 'fail' → the task ends as cancelled.
    onReject: { type: String, trim: true, default: 'sendBack' },

    // What the step tells people when it opens, over and above the default.
    notifyText: { type: String, trim: true, maxlength: 500 },
    // Does this step's actor have to leave a remark? Approvals often should.
    requireNote: { type: Boolean, default: false },
  },
  { _id: false }
);

const versionSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true },
    steps: [stepSchema],
    publishedAt: { type: Date, default: Date.now },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedByName: { type: String, trim: true },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { _id: true }
);

const workflowSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, maxlength: 2000 },
    // Which kinds of task may use it. Empty = any.
    taskTypes: [{ type: String, trim: true }],
    department: { type: String, trim: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },

    // Editable. Runs nothing until published.
    draft: [stepSchema],
    // Append only. Nothing in the module updates or removes an element here.
    versions: [versionSchema],
    // Which published version new tasks pick up. Null = none published yet, so
    // the workflow cannot be chosen.
    activeVersion: { type: Number, default: null },

    // A deactivated workflow is offered to no new task. Tasks already running on
    // it are untouched — they carry their own copy of the steps.
    active: { type: Boolean, default: true, index: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

workflowSchema.index({ name: 1, company: 1 });
workflowSchema.index({ active: 1, activeVersion: 1 });

/**
 * The steps a new task should run — the active published version's.
 * @returns {Array|null} null when nothing is published yet
 */
workflowSchema.methods.activeSteps = function activeSteps() {
  if (!this.activeVersion) return null;
  const v = (this.versions || []).find((x) => x.version === this.activeVersion);
  return v ? v.steps : null;
};

/**
 * Check a step list for the mistakes that would strand a task halfway through.
 *
 * Run before publishing rather than at execution time, because a workflow that
 * dead-ends is discovered by the person who wrote it and not by the employee
 * whose task stops moving. Returns human sentences, not codes — they are shown
 * to whoever pressed Publish.
 * @param {Array} steps
 * @returns {string[]} problems; empty when the workflow is sound
 */
function validateSteps(steps) {
  const problems = [];
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) return ['A workflow needs at least one step.'];

  const keys = new Set();
  for (const s of list) {
    if (!s.key) { problems.push(`Step "${s.name || '(unnamed)'}" has no key.`); continue; }
    if (keys.has(s.key)) problems.push(`Two steps share the key "${s.key}".`);
    keys.add(s.key);
    if (!s.name) problems.push(`Step "${s.key}" has no name.`);
  }

  for (const s of list) {
    if (s.next && !keys.has(s.next)) {
      problems.push(`Step "${s.name || s.key}" points at "${s.next}", which does not exist.`);
    }
    if (s.type === 'condition') {
      if (!s.condition || !s.condition.field) {
        problems.push(`Condition step "${s.name || s.key}" does not say which field to test.`);
      }
      for (const branch of ['onTrue', 'onFalse']) {
        const target = s.condition && s.condition[branch];
        if (target && !keys.has(target)) {
          problems.push(`Condition step "${s.name || s.key}" branches to "${target}", which does not exist.`);
        }
      }
    }
    if (s.type === 'wait' && !(s.waitMinutes > 0)) {
      problems.push(`Wait step "${s.name || s.key}" has no duration.`);
    }
    // An approval nobody can be resolved to is a task that stops forever.
    const rule = s.assigneeRule || {};
    const needsActor = ['approval', 'review', 'assignment'].includes(s.type);
    if (needsActor) {
      const resolvable = (rule.kind && rule.kind !== 'user')
        || (rule.users && rule.users.length)
        || (rule.roles && rule.roles.length)
        || rule.permission;
      if (!resolvable) {
        problems.push(`Step "${s.name || s.key}" does not say who acts on it.`);
      }
    }
  }

  // A parallel group whose members disagree about how it finishes.
  const groups = new Map();
  for (const s of list) {
    if (!s.parallelGroup) continue;
    const seen = groups.get(s.parallelGroup);
    if (seen && seen !== (s.join || 'all')) {
      problems.push(`Parallel group "${s.parallelGroup}" has steps with different join rules.`);
    }
    groups.set(s.parallelGroup, s.join || 'all');
  }

  return problems;
}

workflowSchema.plugin(require('./plugins/auditStatus'), {
  entity: 'Workflow',
  fields: ['active'],
  label: (d) => d.name,
});

module.exports = mongoose.model('Workflow', workflowSchema);
module.exports.validateSteps = validateSteps;
module.exports.stepSchema = stepSchema;
