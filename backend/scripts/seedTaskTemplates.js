/**
 * Seed the task templates and workflows the module ships with (section 56).
 *
 *   node scripts/seedTaskTemplates.js            # report only, writes nothing
 *   node scripts/seedTaskTemplates.js --apply    # create what is missing
 *
 * DRY RUN BY DEFAULT — this project's MONGO_URI points at the live cluster.
 *
 * WHAT IT SEEDS is deliberately the five things every company in this business
 * actually does, wired to the HRMS events that already exist
 * (services/taskEvents.js): a joiner, a confirmation, a resignation, a salary
 * revision, and the monthly attendance audit that is the module's worked example
 * of a recurring task.
 *
 * SAFE TO RUN TWICE. A template is matched by NAME and skipped if it is already
 * there; nothing is overwritten, so a template HR has since edited is left
 * exactly as they edited it. That is the whole point — this seeds a starting
 * point, it does not enforce one.
 *
 * `system: true` marks them as wired to an event, which stops them being deleted
 * out from under the hooks. Their CONTENTS stay fully editable, which is how HR
 * changes what happens on a new joiner without anybody touching code.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const APPLY = process.argv.includes('--apply');

// ===== Workflows =====

const WORKFLOWS = [
  {
    name: 'Employee Onboarding',
    description: 'HR prepares, then IT and Admin run in parallel, then the reporting manager signs off.',
    steps: [
      { key: 'hr', name: 'HR paperwork', type: 'assignment', order: 0,
        assigneeRule: { kind: 'permission', permission: 'employees.manage', quorum: 'any' }, slaHours: 48 },
      { key: 'it', name: 'IT setup', type: 'assignment', order: 1, parallelGroup: 'setup', join: 'all',
        assigneeRule: { kind: 'permission', permission: 'assets.manage', quorum: 'any' }, slaHours: 48 },
      { key: 'admin', name: 'Workspace & access', type: 'assignment', order: 2, parallelGroup: 'setup', join: 'all',
        assigneeRule: { kind: 'permission', permission: 'org.manage', quorum: 'any' }, slaHours: 48 },
      { key: 'mgr', name: 'Reporting manager sign-off', type: 'approval', order: 3,
        assigneeRule: { kind: 'reportingManager', quorum: 'any' }, slaHours: 72, requireNote: false },
    ],
  },
  {
    name: 'Employee Exit',
    description: 'Assets, IT access and finance clear in parallel, then HR closes it out.',
    steps: [
      { key: 'assets', name: 'Asset recovery', type: 'assignment', order: 0, parallelGroup: 'clearance', join: 'all',
        assigneeRule: { kind: 'permission', permission: 'assets.manage', quorum: 'any' }, slaHours: 72 },
      { key: 'it', name: 'IT access removal', type: 'assignment', order: 1, parallelGroup: 'clearance', join: 'all',
        assigneeRule: { kind: 'permission', permission: 'org.manage', quorum: 'any' }, slaHours: 24 },
      { key: 'fin', name: 'Finance settlement', type: 'assignment', order: 2, parallelGroup: 'clearance', join: 'all',
        assigneeRule: { kind: 'permission', permission: 'payroll.manage', quorum: 'any' }, slaHours: 120 },
      { key: 'hr', name: 'HR clearance & experience letter', type: 'approval', order: 3,
        assigneeRule: { kind: 'permission', permission: 'exit.manage', quorum: 'any' }, slaHours: 72 },
    ],
  },
  {
    name: 'Simple Approval',
    description: 'The supervisor decides; the manager sees it only if they reject.',
    steps: [
      { key: 'sup', name: 'Supervisor approval', type: 'approval', order: 0,
        assigneeRule: { kind: 'supervisor', quorum: 'any' }, slaHours: 24, onReject: 'sendBack' },
    ],
  },
];

// ===== Templates =====

const TEMPLATES = [
  {
    name: 'Employee Onboarding',
    description: 'Everything a new joiner needs in their first week.',
    titleTemplate: 'Onboarding — {employee}',
    bodyTemplate: 'Bring {employee} ({code}, {department}) fully on board: documents, systems, workspace and introductions.',
    taskType: 'Onboarding',
    category: 'People',
    priority: 'High',
    trigger: 'employee.created',
    workflowName: 'Employee Onboarding',
    startAfterDays: 0,
    dueAfterDays: 7,
    requiresApproval: true,
    assigneeSlots: [
      { kind: 'hrPartner', taskRole: 'Owner', responsibility: 'The whole plan' },
    ],
    supervisorSlot: { kind: 'permission', permission: 'employees.manage' },
    requirements: { checklist: true, remarks: true },
    checklist: [
      'Documents collected',
      'Documents verified',
      'Employee code and profile created',
      'Work email created',
      'ID card issued',
      'Laptop and assets allotted',
      'Attendance and shift set up',
      'Salary structure assigned',
      'Reporting manager introduced',
      'Orientation completed',
    ],
    reminders: { beforeDueHours: [48, 8], acceptWithinHours: 8 },
  },
  {
    name: 'Employee Exit',
    description: 'Asset recovery, access removal, settlement and clearance.',
    titleTemplate: 'Exit — {employee}',
    bodyTemplate: '{employee} ({code}, {department}) is serving notice{lastWorkingDay}. Complete clearance before the last working day.',
    taskType: 'Exit',
    category: 'People',
    priority: 'High',
    trigger: 'exit.approved',
    workflowName: 'Employee Exit',
    startAfterDays: 0,
    dueAfterDays: 21,
    requiresApproval: true,
    assigneeSlots: [
      { kind: 'hrPartner', taskRole: 'Owner', responsibility: 'Clearance' },
    ],
    supervisorSlot: { kind: 'permission', permission: 'exit.manage' },
    requirements: { checklist: true, remarks: true },
    checklist: [
      'Assets recovered (laptop, ID card, keys)',
      'IT access removed',
      'Email forwarded or closed',
      'Handover completed and signed',
      'Exit interview done',
      'Final settlement calculated',
      'No-dues clearance signed',
      'Experience and relieving letters issued',
    ],
    reminders: { beforeDueHours: [72, 24], acceptWithinHours: 8 },
  },
  {
    name: 'Confirmation Paperwork',
    description: 'What follows a probation confirmation.',
    titleTemplate: 'Confirmation — {employee}',
    taskType: 'Lifecycle',
    category: 'People',
    priority: 'Medium',
    trigger: 'employee.confirmed',
    workflowName: 'Simple Approval',
    dueAfterDays: 5,
    assigneeSlots: [{ kind: 'hrPartner', taskRole: 'Owner' }],
    requirements: { checklist: true },
    checklist: [
      'Confirmation letter issued',
      'Payroll updated with the confirmed salary',
      'Leave entitlement updated',
      'Reporting line confirmed',
    ],
  },
  {
    name: 'Salary Revision Paperwork',
    description: 'The records a CTC revision drags behind it.',
    titleTemplate: 'Salary revision — {employee}',
    bodyTemplate: '{employee} ({code}) has been revised from ₹{from} to ₹{to}. Bring the records into line.',
    taskType: 'Payroll',
    category: 'Payroll',
    priority: 'Medium',
    trigger: 'employee.promoted',
    workflowName: 'Simple Approval',
    dueAfterDays: 5,
    assigneeSlots: [{ kind: 'permission', permission: 'payroll.manage', taskRole: 'Owner' }],
    requirements: { checklist: true },
    checklist: [
      'Salary structure reassigned',
      'Revision letter issued',
      'Designation updated where it changed',
      'Employee informed',
    ],
  },
  {
    name: 'Monthly Attendance Audit',
    description: 'The worked example of a recurring task — wire a schedule to it under Recurring.',
    titleTemplate: 'Attendance audit — {month}',
    bodyTemplate: 'Check last month\'s attendance for missing punches, unapproved regularizations and unexplained absence.',
    taskType: 'Audit',
    category: 'Compliance',
    priority: 'Medium',
    trigger: null,
    workflowName: 'Simple Approval',
    dueAfterDays: 5,
    assigneeSlots: [{ kind: 'permission', permission: 'attendance.manage', taskRole: 'Owner' }],
    requirements: { checklist: true, remarks: true, attachment: true, minAttachments: 1 },
    checklist: [
      'No-punch-out days reviewed',
      'Open regularizations cleared',
      'Unexplained absence chased',
      'Late-marking exceptions checked',
      'Summary shared with HR',
    ],
  },
];

async function main() {
  await connectDB();

  const Workflow = require('../models/Workflow');
  const TaskTemplate = require('../models/TaskTemplate');
  const { validateSteps } = require('../models/Workflow');

  const made = { workflows: [], templates: [], skipped: [] };
  const workflowIds = new Map();

  // ----- workflows -----
  for (const def of WORKFLOWS) {
    const existing = await Workflow.findOne({ name: def.name }).lean();
    if (existing) {
      workflowIds.set(def.name, existing._id);
      made.skipped.push(`workflow "${def.name}"`);
      continue;
    }
    const problems = validateSteps(def.steps);
    if (problems.length) {
      console.error(`Workflow "${def.name}" is not sound: ${problems.join(' ')}`);
      continue;
    }
    made.workflows.push(def.name);
    if (!APPLY) continue;

    const wf = await Workflow.create({
      name: def.name,
      description: def.description,
      draft: def.steps,
      // Published immediately, at version 1: a seeded workflow that runs nothing
      // until somebody finds the Publish button is a seeded workflow that gets
      // reported as broken.
      versions: [{ version: 1, steps: JSON.parse(JSON.stringify(def.steps)), publishedAt: new Date(), note: 'Seeded' }],
      activeVersion: 1,
      active: true,
    });
    workflowIds.set(def.name, wf._id);
  }

  // ----- templates -----
  for (const def of TEMPLATES) {
    const existing = await TaskTemplate.findOne({ name: def.name }).lean();
    if (existing) { made.skipped.push(`template "${def.name}"`); continue; }
    made.templates.push(def.name);
    if (!APPLY) continue;

    const { workflowName, checklist, ...rest } = def;
    await TaskTemplate.create({
      ...rest,
      workflow: workflowIds.get(workflowName),
      checklist: (checklist || []).map((text, i) => ({ text, mandatory: true, order: i })),
      // Marked so the event hooks cannot be broken by a tidy-up. The CONTENTS
      // stay editable — that is how HR changes what happens on a new joiner.
      system: !!def.trigger,
      active: true,
    });
  }

  console.log('');
  console.log(APPLY ? '===== APPLIED =====' : '===== DRY RUN (nothing written) =====');
  console.log(`  workflows to create : ${made.workflows.length}${made.workflows.length ? ` — ${made.workflows.join(', ')}` : ''}`);
  console.log(`  templates to create : ${made.templates.length}${made.templates.length ? ` — ${made.templates.join(', ')}` : ''}`);
  console.log(`  already there       : ${made.skipped.length}${made.skipped.length ? ` — ${made.skipped.join(', ')}` : ''}`);
  if (!APPLY) {
    console.log('');
    console.log('Nothing was written. Re-run with --apply to seed.');
  } else if (made.templates.length) {
    console.log('');
    console.log('Wired to HRMS events: creating an employee now raises onboarding,');
    console.log('accepting a resignation raises the exit plan, and so on. Edit any of');
    console.log('them under Admin → Task Workflows → Templates.');
  }
}

main()
  .then(() => mongoose.disconnect())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error('Seeding failed:', err.message);
    console.error(err.stack);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
