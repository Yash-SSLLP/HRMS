const mongoose = require('mongoose');
const {
  TASK_PRIORITY,
  ASSIGNEE_ROLES,
  LOCATION_EVENTS,
  GEOFENCE_RULES,
  INCENTIVE_OUTCOMES,
  DEFAULT_INCENTIVE_SPLIT,
} = require('../config/taskWorkflow');

/**
 * A task worth creating more than once (section 24).
 *
 * Employee onboarding, an exit, a payroll run, a monthly attendance audit — the
 * same shape every time, with the same checklist, the same workflow and the same
 * people. A template holds all of it, and creating a task from one is a copy.
 *
 * A COPY, NOT A LINK. The task keeps `template` so a report can ask "how do
 * tasks from this template perform?", but nothing about a running task is READ
 * from here: editing a template must not reach into work already under way, for
 * the same reason editing a workflow must not. What a template changes is the
 * next task made from it.
 *
 * DEADLINES ARE RELATIVE, not absolute — "due 3 days after it starts" rather
 * than a date, because a template used in March has to work in April. Same for
 * a checklist item's own deadline.
 */

// Who a template's assignee slot resolves to when a task is made from it. The
// same vocabulary the workflow's assigneeRule uses, deliberately: one idea, one
// set of words.
const ASSIGNEE_KINDS = [
  'user',              // the named people
  'role',              // everyone holding one of `roles`
  'permission',        // everyone holding `permission`
  'department',        // everyone in `department`
  'subject',           // the person the task is ABOUT (the new joiner, the leaver)
  'reportingManager',  // the subject's reporting manager
  'hrPartner',         // the subject's HR partner
  'creator',
];

const slotSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ASSIGNEE_KINDS, default: 'user' },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    roles: [String],
    permission: { type: String, trim: true },
    department: { type: String, trim: true },
    taskRole: { type: String, enum: ASSIGNEE_ROLES, default: 'Contributor' },
    responsibility: { type: String, trim: true, maxlength: 300 },
    // Days after the task starts that THIS person's part is due. Null = the
    // task's own due date.
    dueAfterDays: Number,
  },
  { _id: false }
);

const templateChecklistSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true, maxlength: 300 },
    mandatory: { type: Boolean, default: true },
    requiresEvidence: { type: Boolean, default: false },
    dueAfterDays: Number,
    order: { type: Number, default: 0 },
  },
  { _id: false }
);

const templateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, maxlength: 2000 },
    // What the tasks it makes are called. Supports the same placeholders the
    // event hooks fill in: {employee}, {month}, {department}, {company}.
    titleTemplate: { type: String, trim: true },
    bodyTemplate: { type: String, trim: true, maxlength: 4000 },

    taskType: { type: String, trim: true, default: 'General' },
    category: { type: String, trim: true },
    department: { type: String, trim: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', index: true },
    priority: { type: String, enum: TASK_PRIORITY, default: 'Medium' },
    tags: [{ type: String, trim: true }],

    // ===== People =====
    assigneeSlots: [slotSchema],
    supervisorSlot: { type: slotSchema, default: undefined },
    managerSlot: { type: slotSchema, default: undefined },

    // ===== Timing, all relative =====
    startAfterDays: { type: Number, default: 0 },
    dueAfterDays: { type: Number, default: 3 },
    estimatedMinutes: Number,

    // ===== The rest of the task's shape =====
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow' },
    checklist: [templateChecklistSchema],
    requirements: {
      remarks: { type: Boolean, default: false },
      checklist: { type: Boolean, default: false },
      attachment: { type: Boolean, default: false },
      photo: { type: Boolean, default: false },
      location: { type: Boolean, default: false },
      signature: { type: Boolean, default: false },
      minPhotos: { type: Number, default: 0 },
      minAttachments: { type: Number, default: 0 },
      note: { type: String, trim: true, maxlength: 500 },
    },
    location: {
      captureOn: [{ type: String, enum: LOCATION_EVENTS }],
      enforceOn: [{ type: String, enum: GEOFENCE_RULES }],
      workLocation: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkLocation' },
      radiusM: Number,
    },
    requiresApproval: { type: Boolean, default: false },
    reminders: {
      beforeDueHours: { type: [Number], default: undefined },
      afterDue: {
        type: [new mongoose.Schema({
          hours: Number, to: String, severity: String,
        }, { _id: false })],
        default: undefined,
      },
      acceptWithinHours: Number,
    },
    incentive: {
      enabled: { type: Boolean, default: false },
      points: { type: Number, min: 0, default: 0 },
      split: {
        type: new mongoose.Schema(
          Object.fromEntries(INCENTIVE_OUTCOMES.map((k) => [k, { type: Number, min: 0, max: 1 }])),
          { _id: false }
        ),
        default: () => ({ ...DEFAULT_INCENTIVE_SPLIT }),
      },
      distribution: { type: String, trim: true, default: 'share' },
    },
    customFields: [{
      key: { type: String, trim: true },
      label: { type: String, trim: true },
      type: { type: String, trim: true, default: 'text' },
      required: { type: Boolean, default: false },
      options: [String],
      defaultValue: mongoose.Schema.Types.Mixed,
    }],

    // Subtasks this template creates alongside the parent, each a small template
    // of its own. One level deep on purpose — a tree of templates is a workflow,
    // and workflows are the thing that already exists for that.
    subtasks: [{
      title: { type: String, trim: true },
      description: { type: String, trim: true },
      assigneeSlot: { type: slotSchema, default: undefined },
      dueAfterDays: Number,
      priority: { type: String, enum: TASK_PRIORITY },
    }],

    // Which HRMS event creates tasks from this template automatically
    // (section 31). Null = manual only. See services/taskEvents.js for the
    // catalogue of events and what each one passes in.
    trigger: { type: String, trim: true, default: null, index: true },

    active: { type: Boolean, default: true, index: true },
    // A template the module itself seeded. Protected from deletion so the event
    // hooks cannot be broken by a tidy-up, though its contents stay editable.
    system: { type: Boolean, default: false },

    usageCount: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

templateSchema.index({ active: 1, name: 1 });
templateSchema.index({ trigger: 1, active: 1 });

templateSchema.plugin(require('./plugins/auditStatus'), {
  entity: 'TaskTemplate',
  fields: ['active'],
  label: (d) => d.name,
});

module.exports = mongoose.model('TaskTemplate', templateSchema);
module.exports.ASSIGNEE_KINDS = ASSIGNEE_KINDS;
module.exports.slotSchema = slotSchema;
