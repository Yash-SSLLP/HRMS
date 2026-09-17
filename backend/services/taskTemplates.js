/**
 * Turning a TaskTemplate into an actual task (section 24).
 *
 * A template describes a shape — who does it, what the checklist is, how long
 * they have, which workflow it runs, what it is worth — in RELATIVE terms, so
 * that a template written in March still works in April. This file resolves all
 * of that against a moment and a subject, and hands back a plain object the task
 * controller can create a Task from.
 *
 * IT MAKES A COPY. Nothing about the resulting task is read back from the
 * template afterwards: editing "Employee Onboarding" must not reach into the
 * onboarding already under way for three people, for the same reason editing a
 * workflow must not. The task keeps `template` so a report can ask how tasks
 * from a template perform — that is the only use of the link.
 *
 * "THE SUBJECT" is the person the task is ABOUT, which is not always the person
 * doing it. An onboarding task is about the new joiner and done by HR; an exit
 * task is about the leaver and done by IT. `subject` is what the `subject`,
 * `reportingManager` and `hrPartner` assignee kinds resolve against, and what
 * fills the {employee} placeholder in the title.
 */
const mongoose = require('mongoose');
const User = require('../models/User');
const EmployeeProfile = require('../models/EmployeeProfile');
const { usersHoldingAny } = require('./audience');

/** Add days to a date, keeping the time of day. */
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + (Number(days) || 0));
  return d;
}

/**
 * Fill the placeholders a template's title and body may use.
 *
 * Deliberately a small fixed set rather than a template language: these are
 * written by HR in a form field, and anything that could fail at render time
 * would fail on a task nobody is watching being created.
 * @param {string} text
 * @param {object} vars
 * @returns {string}
 */
function fill(text, vars = {}) {
  if (!text) return text;
  return String(text).replace(/\{(\w+)\}/g, (whole, key) => {
    const v = vars[key];
    return v == null || v === '' ? whole : String(v);
  });
}

/**
 * Resolve one assignee slot to actual users.
 *
 * Returns a possibly-empty list, and empty is a real answer the caller handles:
 * a template addressed to an HR partner for somebody who has none should still
 * produce a task, unassigned, rather than no task at all — an onboarding that
 * silently never happened is far worse than one somebody has to assign by hand.
 *
 * @param {object} slot
 * @param {object} ctx - { actor, subject, subjectProfile, company }
 * @returns {Promise<Array>} user documents
 */
async function resolveSlot(slot, ctx) {
  if (!slot) return [];
  const kind = slot.kind || 'user';

  const load = async (ids) => {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return [];
    return User.find({ _id: { $in: list }, isActive: true }).select('firstName lastName role').lean();
  };

  switch (kind) {
    case 'user':
      return load(slot.users);

    case 'role': {
      const roles = (slot.roles || []).filter(Boolean);
      if (!roles.length) return [];
      return User.find({ role: { $in: roles }, isActive: true })
        .select('firstName lastName role').limit(25).lean();
    }

    case 'permission': {
      if (!slot.permission) return [];
      return load(await usersHoldingAny(slot.permission));
    }

    case 'department': {
      const dept = slot.department;
      if (!dept) return [];
      const profiles = await EmployeeProfile.find({ department: dept }).select('user').limit(50).lean();
      return load(profiles.map((p) => p.user));
    }

    case 'subject':
      return load([ctx.subject && (ctx.subject._id || ctx.subject)]);

    case 'reportingManager':
      return load([ctx.subjectProfile && ctx.subjectProfile.reportingManager]);

    case 'hrPartner':
      return load([ctx.subjectProfile && ctx.subjectProfile.hrPartner]);

    case 'creator':
      return load([ctx.actor && ctx.actor._id]);

    default:
      return load(slot.users);
  }
}

/**
 * Build the task fields a template describes.
 *
 * @param {object} tpl - a TaskTemplate document
 * @param {object} opts
 * @param {object} opts.actor - req.user, or a system actor
 * @param {*} [opts.subject] - the User the task is about
 * @param {Date} [opts.at] - the moment relative dates are measured from
 * @param {object} [opts.vars] - extra placeholder values
 * @param {object} [opts.overrides] - fields that win over the template
 * @returns {Promise<object>} plain fields for `new Task(...)`
 */
async function buildTaskFromTemplate(tpl, opts = {}) {
  const at = opts.at ? new Date(opts.at) : new Date();
  const actor = opts.actor || null;

  let subject = null;
  let subjectProfile = null;
  if (opts.subject && mongoose.isValidObjectId(String(opts.subject._id || opts.subject))) {
    subject = await User.findById(opts.subject._id || opts.subject).select('firstName lastName').lean();
    subjectProfile = await EmployeeProfile.findOne({ user: opts.subject._id || opts.subject })
      .select('reportingManager hrPartner department company employeeCode').lean();
  }

  const ctx = { actor, subject, subjectProfile, company: tpl.company };

  const vars = {
    employee: subject ? `${subject.firstName || ''} ${subject.lastName || ''}`.trim() : '',
    code: subjectProfile ? subjectProfile.employeeCode : '',
    department: (subjectProfile && subjectProfile.department) || tpl.department || '',
    month: at.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }),
    date: at.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }),
    ...(opts.vars || {}),
  };

  // --- people ---
  const assigneeRows = [];
  for (const slot of tpl.assigneeSlots || []) {
    const people = await resolveSlot(slot, ctx);
    for (const p of people) {
      if (assigneeRows.some((r) => String(r.user) === String(p._id))) continue;
      assigneeRows.push({
        user: String(p._id),
        role: slot.taskRole || 'Contributor',
        responsibility: fill(slot.responsibility, vars),
        dueDate: slot.dueAfterDays != null
          ? addDays(addDays(at, tpl.startAfterDays || 0), slot.dueAfterDays)
          : undefined,
      });
    }
  }
  if (assigneeRows.length && !assigneeRows.some((r) => r.role === 'Owner')) {
    assigneeRows[0].role = 'Owner';
  }

  const [supervisors, managers] = await Promise.all([
    resolveSlot(tpl.supervisorSlot, ctx),
    resolveSlot(tpl.managerSlot, ctx),
  ]);

  // --- dates ---
  const startDate = addDays(at, tpl.startAfterDays || 0);
  const dueDate = addDays(startDate, tpl.dueAfterDays != null ? tpl.dueAfterDays : 3);

  const plain = (v) => (v && typeof v.toObject === 'function' ? v.toObject() : v);

  const fields = {
    title: fill(tpl.titleTemplate || tpl.name, vars),
    description: fill(tpl.bodyTemplate || tpl.description, vars),
    taskType: tpl.taskType,
    category: tpl.category,
    department: (subjectProfile && subjectProfile.department) || tpl.department,
    company: (subjectProfile && subjectProfile.company) || tpl.company,
    priority: tpl.priority,
    tags: [...(tpl.tags || [])],
    assignees: assigneeRows,
    supervisor: supervisors[0] ? supervisors[0]._id : undefined,
    manager: managers[0] ? managers[0]._id : undefined,
    startDate,
    dueDate,
    estimatedMinutes: tpl.estimatedMinutes,
    requiresApproval: !!tpl.requiresApproval,
    requirements: plain(tpl.requirements),
    location: plain(tpl.location),
    reminders: plain(tpl.reminders),
    incentive: plain(tpl.incentive),
    checklist: (tpl.checklist || []).map((c, i) => ({
      text: fill(c.text, vars),
      mandatory: c.mandatory !== false,
      requiresEvidence: !!c.requiresEvidence,
      dueDate: c.dueAfterDays != null ? addDays(startDate, c.dueAfterDays) : undefined,
      order: c.order != null ? c.order : i,
    })),
    customFields: (tpl.customFields || []).map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      required: !!f.required,
      options: f.options,
      value: f.defaultValue,
    })),
    template: tpl._id,
  };

  // Subtasks, resolved the same way and handed back for the caller to create.
  if ((tpl.subtasks || []).length) {
    fields.subtasks = [];
    for (const st of tpl.subtasks) {
      const people = await resolveSlot(st.assigneeSlot, ctx);
      fields.subtasks.push({
        title: fill(st.title, vars),
        description: fill(st.description, vars),
        assignees: people.map((p) => String(p._id)),
        priority: st.priority || tpl.priority,
        dueDate: st.dueAfterDays != null ? addDays(startDate, st.dueAfterDays) : dueDate,
      });
    }
  }

  if (tpl.workflow) fields.workflow = tpl.workflow;

  // The caller's own values win — a template is a starting point, not a cage.
  const overrides = { ...(opts.overrides || {}) };
  for (const k of ['template', 'subject', 'assignToAll']) delete overrides[k];
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined || v === null || v === '') continue;
    fields[k] = v;
  }

  return fields;
}

module.exports = { buildTaskFromTemplate, resolveSlot, fill, addDays };
