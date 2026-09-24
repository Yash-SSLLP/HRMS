/**
 * Salary changes, and the CEO/MD approval they wait on.
 *
 * THE RULE (user decision 2026-09-24). HR sets an employee's salary up — their
 * salary structure and annual CTC — and once it is saved, HR may only PROPOSE a
 * change to it. The proposal waits for a CEO, MD or Super Admin
 * (canApproveSalaryChanges), and only their approval writes it to the record,
 * which is the only place a payroll run reads a salary from. It covers:
 *   · changing a saved structure or CTC — Salary Revisions → Save, Salary
 *     Structures → Assign, PUT /employees/:id, an import-flag correction;
 *   · revising the CTC — Salary Revisions → Revise salary;
 *   · new percentages on a salary structure somebody is paid on.
 *
 * FILLING A BLANK IS NOT A CHANGE. An employee with no structure yet, or no CTC
 * yet, is being SET UP, and that stays HR's to do alone — the same line the rest
 * of the portal draws around an empty field (employeeController's
 * canFillHierarchyField, changeRequestController.fillMissingField). Holding a new
 * joiner's first salary for sign-off would only hold up their first payslip.
 *
 * WHO WRITES DIRECTLY: the approvers. A gate they could clear for themselves is
 * not a gate, so their own changes apply at once, as they always did. (A
 * read-only CEO/MD never reaches a salary WRITE route — `payroll.manage` refuses
 * them — but may decide a request, which is addressed to them.)
 *
 * Every path that writes a salary asks this module, so the rule is the same
 * whichever screen the change was made from.
 */
const SalaryChangeRequest = require('../models/SalaryChangeRequest');
const SalaryStructure = require('../models/SalaryStructure');
const EmployeeProfile = require('../models/EmployeeProfile');
const { canApproveSalaryChanges } = require('../middleware/authMiddleware');
const { notify, notifyMany } = require('./notify');
const { usersInRoles, scopeRecipientsToCompany } = require('./audience');
const { ymdIST } = require('../utils/dateHelpers');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** The six percentages of a salary structure, in display order. */
const COMPONENT_KEYS = ['basicPct', 'hraPct', 'specialAllowancePct', 'conveyancePct', 'medicalPct', 'ltaPct'];

/** Same allowance the structure controller gives a fully-allocated total. */
const PCT_TOTAL_EPSILON = 1e-6;

// Where each side of a request lands. The approvers' queue is a tab on the
// Approvals page; the requester is sent back to where they asked.
const APPROVER_LINK = '/admin/approvals?tab=salary';
const REQUESTER_LINK = {
  setup: '/admin/payroll-run',
  revision: '/admin/payroll-run',
  structure: '/admin/salary-structures',
};

// ---------------------------------------------------------------- basics ----

/** Does this account's own salary change apply without an approval? */
const writesSalaryDirectly = (user) => canApproveSalaryChanges(user);

/** An Error carrying the HTTP status the route should answer with. */
const httpError = (status, message) => Object.assign(new Error(message), { status });

const idOf = (v) => String(v?._id || v || '');
const actorName = (u) => u?.fullName || `${u?.firstName || ''} ${u?.lastName || ''}`.trim() || undefined;
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const monthLabel = (y, m) => `${MONTHS[(Number(m) || 1) - 1]} ${y}`;

/** This calendar month in India, whatever timezone the server runs in. */
function thisMonthIST() {
  const [year, month] = ymdIST(new Date()).split('-').map(Number);
  return { year, month };
}

const monthKey = (y, m) => Number(y) * 12 + (Number(m) - 1);

/**
 * The CTC payroll would pay this employee in a given month. Lazy require: the
 * payroll controller requires this module, and this keeps the load order
 * one-directional.
 */
function inForceCtc(profile, year, month) {
  const { resolveCtcForMonth } = require('../controllers/payrollController');
  return resolveCtcForMonth(profile, year, month) || 0;
}

/**
 * The CTC a salary change is judged against: the stored `annualCtc`, or — when
 * that was never written but a revision history exists — what payroll pays this
 * month. It is the same figure the Salary Revisions page puts in its CTC box, so
 * "unchanged" on screen is "unchanged" here.
 * @param {Object} profile - EmployeeProfile (needs annualCtc, ctcHistory)
 * @returns {number}
 */
function currentCtcOf(profile) {
  const stored = Number(profile?.annualCtc) || 0;
  if (stored) return stored;
  const { year, month } = thisMonthIST();
  return inForceCtc(profile, year, month);
}

/** A structure's percentages as a plain snapshot. */
function componentsOf(source) {
  const c = source?.components || source || {};
  const out = {};
  for (const k of COMPONENT_KEYS) out[k] = Number(c[k]) || 0;
  return out;
}

const sameComponents = (a, b) => COMPONENT_KEYS.every(
  (k) => Math.abs((Number(a?.[k]) || 0) - (Number(b?.[k]) || 0)) < 1e-9
);

const componentTotal = (c) => COMPONENT_KEYS.reduce((sum, k) => sum + (Number(c?.[k]) || 0), 0);

// ------------------------------------------------------- salary setup ----

/**
 * What a structure/CTC save would change on this employee, and whether that is a
 * CHANGE to a saved salary (needs approval from HR) or the filling of a blank.
 *
 * @param {Object} profile - EmployeeProfile (salaryStructure, annualCtc, ctcHistory)
 * @param {Object} wanted
 * @param {*} [wanted.structure] - structure id; undefined = leave as is, null/'' = clear
 * @param {*} [wanted.ctc] - annual CTC; undefined = leave as is
 * @returns {{curStructure: string, curCtc: number, wantStructure: string, wantCtc: number,
 *   structureChanged: boolean, ctcChanged: boolean, changed: boolean, editsSaved: boolean}}
 * @throws 400 on a CTC that is not a non-negative number
 */
function classifySetup(profile, { structure, ctc } = {}) {
  const curStructure = idOf(profile.salaryStructure);
  const curCtc = currentCtcOf(profile);
  const wantStructure = structure === undefined ? curStructure : idOf(structure);
  let wantCtc = curCtc;
  if (ctc !== undefined) {
    const n = ctc === null || ctc === '' ? 0 : Number(ctc);
    if (!Number.isFinite(n) || n < 0) throw httpError(400, 'Enter a valid annual CTC');
    wantCtc = Math.round(n);
  }
  const structureChanged = wantStructure !== curStructure;
  const ctcChanged = wantCtc !== curCtc;
  return {
    curStructure,
    curCtc,
    wantStructure,
    wantCtc,
    structureChanged,
    ctcChanged,
    changed: structureChanged || ctcChanged,
    // Replacing or clearing something already SET. Filling an empty structure or
    // an empty CTC is setting the salary up, not changing it.
    editsSaved: (structureChanged && !!curStructure) || (ctcChanged && curCtc > 0),
  };
}

/**
 * Write a structure/CTC change onto the profile (not saved — the caller saves).
 *
 * REPLACING A CTC ALREADY IN FORCE RECORDS A REVISION. Payroll reads the CTC for
 * a month from the revision history and, once there is any, ignores
 * `annualCtc` altogether (payrollController.resolveCtcForMonth), so a bare
 * field write either never reached the payslip or — with no history yet —
 * silently repriced every month ever paid. An entry effective from the month the
 * change was asked for keeps the months before it paying what they paid, which
 * is what the salary-sheet import already does. FILLING a blank CTC writes the
 * field alone, as it always has: there is no earlier figure to preserve.
 *
 * @param {Object} profile - EmployeeProfile document
 * @param {Object} cls - classifySetup() result
 * @param {Object} [meta]
 * @param {*} [meta.by] / [meta.byName] - who asked for it
 * @param {*} [meta.approvedBy] / [meta.approvedByName] - who agreed (when it waited)
 * @param {*} [meta.requestId] - the SalaryChangeRequest it came from
 * @param {number} [meta.effectiveYear] / [meta.effectiveMonth] - defaults to this month
 * @param {string} [meta.reason]
 * @returns {Object} the profile
 */
function applySetup(profile, cls, meta = {}) {
  if (cls.ctcChanged && cls.curCtc > 0) {
    const now = thisMonthIST();
    const year = Number(meta.effectiveYear) || now.year;
    const month = Number(meta.effectiveMonth) || now.month;
    profile.ctcHistory = [...(profile.ctcHistory || []), {
      previousCtc: inForceCtc(profile, year, month) || cls.curCtc,
      newCtc: cls.wantCtc,
      mode: 'set',
      value: cls.wantCtc,
      previousStructure: cls.curStructure || null,
      newStructure: cls.wantStructure || null,
      effectiveYear: year,
      effectiveMonth: month,
      reason: (meta.reason || '').trim() || 'Salary setup changed',
      by: meta.by,
      byName: meta.byName,
      at: new Date(),
      ...(meta.approvedBy ? {
        approvedBy: meta.approvedBy,
        approvedByName: meta.approvedByName,
        approvedAt: new Date(),
        request: meta.requestId,
      } : {}),
    }];
  }
  if (cls.structureChanged) profile.salaryStructure = cls.wantStructure || null;
  if (cls.ctcChanged) profile.annualCtc = cls.wantCtc;
  return profile;
}

// ----------------------------------------------------------- revisions ----

/**
 * Work out a CTC revision — up OR down — and refuse the ones that make no sense.
 * The arithmetic and messages giveHike has always used (scripts/
 * testSalaryRevision.js pins them).
 *
 * @param {Object} profile - EmployeeProfile (annualCtc, salaryStructure)
 * @param {Object} body - { mode, value, newStructure, effectiveYear, effectiveMonth, reason }
 * @returns {Promise<Object>} the ctcHistory entry, minus who/when
 * @throws 400 on a zero, negative-result, unchanged or malformed revision
 */
async function computeRevision(profile, body = {}) {
  const { mode, value, newStructure, effectiveYear, effectiveMonth, reason } = body;
  const prevCtc = Number(profile.annualCtc) || 0;
  const v = Number(value) || 0;

  // A revision may go DOWN as well as up. Demotions, a corrected offer, a move
  // to a shorter week — all are real, and refusing them forced HR to fix the
  // CTC by hand, which left no record of what changed or why. So a negative
  // percent/amount, or a lower "set to", is accepted; only a revision that
  // changes nothing is refused, because it would be an empty history entry.
  if (v === 0) throw httpError(400, 'Enter a value — a revision of zero changes nothing.');
  if ((mode === 'percent' || mode === 'amount') && !prevCtc) {
    throw httpError(400, 'Set a current CTC for this employee before applying a percentage/amount revision (or use "Set to" mode).');
  }
  let newCtc;
  if (mode === 'percent') newCtc = Math.round(prevCtc * (1 + v / 100));
  else if (mode === 'amount') newCtc = Math.round(prevCtc + v);
  else if (mode === 'set') newCtc = Math.round(v);
  else throw httpError(400, 'Invalid revision mode.');

  if (newCtc < 0) {
    throw httpError(400, `That reduction would take the CTC below zero (${prevCtc.toLocaleString('en-IN')} → ${newCtc.toLocaleString('en-IN')}).`);
  }
  if (newCtc === prevCtc) throw httpError(400, 'That leaves the CTC unchanged.');

  const now = thisMonthIST();
  const eYear = Number(effectiveYear) || now.year;
  const eMonth = Number(effectiveMonth) || now.month;
  if (eMonth < 1 || eMonth > 12) throw httpError(400, 'Pick an effective month between January and December.');

  if (newStructure && !(await SalaryStructure.exists({ _id: newStructure }))) {
    throw httpError(400, 'That salary structure no longer exists — pick another, or keep the current one.');
  }
  const prevStructure = profile.salaryStructure?._id || profile.salaryStructure || null;
  return {
    previousCtc: prevCtc,
    newCtc,
    mode,
    value: v,
    previousStructure: prevStructure,
    newStructure: newStructure || prevStructure,
    effectiveYear: eYear,
    effectiveMonth: eMonth,
    reason: String(reason || '').trim(),
  };
}

/**
 * Put a revision on the profile (not saved — the caller saves). Effective this
 * month or earlier, it updates the live CTC (and structure) now; a future month
 * stays in the history and payroll picks it up when that month is run.
 * @param {Object} profile - EmployeeProfile document
 * @param {Object} entry - computeRevision() result
 * @param {Object} [meta] - { by, byName, approvedBy, approvedByName, requestId }
 * @returns {{entry: Object, live: boolean}}
 */
function applyRevision(profile, entry, meta = {}) {
  const full = {
    ...entry,
    by: meta.by,
    byName: meta.byName,
    at: new Date(),
    ...(meta.approvedBy ? {
      approvedBy: meta.approvedBy,
      approvedByName: meta.approvedByName,
      approvedAt: new Date(),
      request: meta.requestId,
    } : {}),
  };
  profile.ctcHistory = [...(profile.ctcHistory || []), full];
  const now = thisMonthIST();
  const live = monthKey(entry.effectiveYear, entry.effectiveMonth) <= monthKey(now.year, now.month);
  if (live) {
    profile.annualCtc = entry.newCtc;
    if (entry.newStructure) profile.salaryStructure = entry.newStructure;
  }
  return { entry: full, live };
}

// ------------------------------------------------------------ requests ----

const fmtDay = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

/**
 * Refuse a second proposal while one is still waiting. Checked up front for the
 * message; the partial unique indexes on the model make it true under a race.
 * @param {{employee?: *, structure?: *}} subject
 * @throws 409 naming who asked and when
 */
async function assertNoPendingFor({ employee, structure }) {
  const q = employee ? { employee, status: 'Pending' } : { structure, status: 'Pending' };
  const open = await SalaryChangeRequest.findOne(q).select('requestedByName createdAt').lean();
  if (!open) return;
  throw httpError(409, `A ${employee ? 'salary change for this employee' : 'change to this salary structure'} is already `
    + `waiting for CEO/MD approval${open.requestedByName ? ` (asked by ${open.requestedByName}` : ' ('}`
    + `${open.createdAt ? ` on ${fmtDay(open.createdAt)}` : ''}). Withdraw it, or wait for the decision, before asking for another.`);
}

async function createRequest(doc) {
  try {
    return await SalaryChangeRequest.create(doc);
  } catch (err) {
    if (err.code === 11000) {
      throw httpError(409, 'A change to this salary is already waiting for CEO/MD approval.');
    }
    throw err;
  }
}

/** Snapshot of a structure's percentages, or a 400 when it has gone. */
async function structureSnapshot(structureId) {
  const st = await SalaryStructure.findById(structureId).select('name components').lean();
  if (!st) throw httpError(400, 'That salary structure no longer exists — pick another.');
  return componentsOf(st);
}

/**
 * Raise a structure/CTC change for approval instead of applying it.
 * @param {import('express').Request} req
 * @param {Object} profile - EmployeeProfile (needs _id, user, company, salaryStructure, annualCtc)
 * @param {Object} cls - classifySetup() result
 * @param {{reason?: string}} [opts]
 * @returns {Promise<Object>} the request
 */
async function raiseSetupChange(req, profile, cls, { reason } = {}) {
  await assertNoPendingFor({ employee: profile._id });
  const swap = cls.structureChanged && cls.wantStructure;
  const { year, month } = thisMonthIST();
  const request = await createRequest({
    kind: 'setup',
    employee: profile._id,
    targetUser: idOf(profile.user) || undefined,
    company: idOf(profile.company) || undefined,
    previousStructure: cls.curStructure || undefined,
    newStructure: swap ? cls.wantStructure : undefined,
    clearStructure: cls.structureChanged && !cls.wantStructure,
    newStructureComponents: swap ? await structureSnapshot(cls.wantStructure) : undefined,
    previousCtc: cls.curCtc,
    newCtc: cls.wantCtc,
    effectiveYear: year,
    effectiveMonth: month,
    reason: String(reason || '').trim().slice(0, 500) || undefined,
    requestedBy: req.user._id,
    requestedByName: actorName(req.user),
  });
  notifyApprovers(request, req.user).catch(() => {});
  return request;
}

/**
 * Raise a CTC revision for approval instead of applying it.
 * @param {import('express').Request} req
 * @param {Object} profile - EmployeeProfile
 * @param {Object} entry - computeRevision() result
 * @returns {Promise<Object>} the request
 */
async function raiseRevision(req, profile, entry) {
  await assertNoPendingFor({ employee: profile._id });
  const swap = idOf(entry.newStructure) && idOf(entry.newStructure) !== idOf(entry.previousStructure);
  const request = await createRequest({
    kind: 'revision',
    employee: profile._id,
    targetUser: idOf(profile.user) || undefined,
    company: idOf(profile.company) || undefined,
    previousStructure: entry.previousStructure || undefined,
    newStructure: swap ? entry.newStructure : undefined,
    newStructureComponents: swap ? await structureSnapshot(entry.newStructure) : undefined,
    previousCtc: entry.previousCtc,
    newCtc: entry.newCtc,
    mode: entry.mode,
    value: entry.value,
    effectiveYear: entry.effectiveYear,
    effectiveMonth: entry.effectiveMonth,
    reason: entry.reason ? entry.reason.slice(0, 500) : undefined,
    requestedBy: req.user._id,
    requestedByName: actorName(req.user),
  });
  notifyApprovers(request, req.user).catch(() => {});
  return request;
}

/**
 * People paid on a structure right now — across EVERY company, deliberately: a
 * template repriced because its other holders sit behind somebody's company wall
 * still reprices them.
 * @param {*} structureId
 * @returns {Promise<number>}
 */
function holdersOf(structureId) {
  return EmployeeProfile.countDocuments({ salaryStructure: structureId });
}

/**
 * Is this structure's pay-bearing half locked to an HR? It is once anybody is
 * paid on it, or a waiting request would put somebody on it — rewriting the
 * percentages of a template the approver is about to agree to move a person onto
 * would change what they are agreeing to.
 * @param {*} structureId
 * @returns {Promise<{locked: boolean, holders: number}>}
 */
async function structureLock(structureId) {
  const [holders, pendingTarget] = await Promise.all([
    holdersOf(structureId),
    SalaryChangeRequest.exists({ status: 'Pending', newStructure: structureId }),
  ]);
  return { locked: holders > 0 || !!pendingTarget, holders };
}

/**
 * Raise new percentages for a structure people are paid on.
 * @param {import('express').Request} req
 * @param {Object} structure - SalaryStructure document
 * @param {Object} components - the asked-for percentages
 * @param {number} holders - people on it now
 * @param {{reason?: string}} [opts]
 * @returns {Promise<Object>} the request
 */
async function raiseStructureChange(req, structure, components, holders, { reason } = {}) {
  await assertNoPendingFor({ structure: structure._id });
  const request = await createRequest({
    kind: 'structure',
    structure: structure._id,
    structureName: structure.name,
    previousComponents: componentsOf(structure),
    newComponents: componentsOf(components),
    holderCount: holders,
    reason: String(reason || '').trim().slice(0, 500) || undefined,
    requestedBy: req.user._id,
    requestedByName: actorName(req.user),
  });
  notifyApprovers(request, req.user).catch(() => {});
  return request;
}

// ------------------------------------------------------- describing one ----

const pctLabel = (v) => `${Number(Number(v || 0).toFixed(2))}%`;
const COMPONENT_LABELS = {
  basicPct: 'Basic', hraPct: 'HRA', specialAllowancePct: 'Special', conveyancePct: 'Conveyance', medicalPct: 'Medical', ltaPct: 'LTA',
};

/**
 * One sentence saying what a request would do — the notification body, and the
 * line an approver reads before deciding.
 * @param {Object} r - the request (structure names populated where available)
 * @returns {string}
 */
function describeRequest(r) {
  if (r.kind === 'structure') {
    const moved = COMPONENT_KEYS
      .filter((k) => Math.abs((r.previousComponents?.[k] || 0) - (r.newComponents?.[k] || 0)) >= 1e-9)
      .map((k) => `${COMPONENT_LABELS[k]} ${pctLabel(r.previousComponents?.[k])} → ${pctLabel(r.newComponents?.[k])}`);
    return `new percentages for the "${r.structureName || 'salary'}" structure (${moved.join(', ') || 'no change'})`
      + `${r.holderCount ? ` — ${r.holderCount} ${r.holderCount === 1 ? 'person is' : 'people are'} paid on it` : ''}`;
  }
  const parts = [];
  if (r.newCtc != null && r.previousCtc !== r.newCtc) {
    parts.push(`CTC ${inr(r.previousCtc)} → ${inr(r.newCtc)}${r.kind === 'revision' || r.previousCtc > 0
      ? ` from ${monthLabel(r.effectiveYear, r.effectiveMonth)}` : ''}`);
  }
  const stName = (s) => (s && typeof s === 'object' && s.name) || null;
  if (r.newStructure) parts.push(`structure → ${stName(r.newStructure) || 'another structure'}`);
  else if (r.clearStructure) parts.push('structure removed');
  return parts.join(' · ') || 'a salary change';
}

/** "Asha Patel (SSL 12)", from a request with employee → user populated. */
function subjectName(r) {
  if (r.kind === 'structure') return `the "${r.structureName || 'salary'}" structure`;
  const u = r.employee?.user;
  const name = `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
  const code = r.employee?.employeeCode;
  return `${name || 'an employee'}${code ? ` (${code})` : ''}`;
}

/**
 * A request as one viewer should receive it: with its one-line summary, and
 * what THIS viewer may do with it. An approver never decides their own ask, nor
 * a change to their own salary.
 * @param {import('express').Request} req
 * @param {Object} r - lean request, populated
 * @returns {Object}
 */
function shapeForViewer(req, r) {
  const me = String(req.user?._id || '');
  const mine = String(r.requestedBy?._id || r.requestedBy || '') === me;
  const aboutMe = !!r.employee?.user && String(r.employee.user._id || r.employee.user) === me;
  const pending = r.status === 'Pending';
  return {
    ...r,
    summary: describeRequest(r),
    canDecide: pending && canApproveSalaryChanges(req.user) && !mine && !aboutMe,
    canWithdraw: pending && mine,
  };
}

/** Load a request with everything describeRequest/subjectName read. */
function populated(query) {
  return query
    .populate({ path: 'employee', select: 'employeeCode designation department company user', populate: { path: 'user', select: 'firstName lastName email role' } })
    .populate('previousStructure', 'name components')
    .populate('newStructure', 'name components')
    .populate('structure', 'name components')
    .populate('requestedBy', 'firstName lastName role')
    .populate('decidedBy', 'firstName lastName role');
}

/**
 * Tell the approvers a change is waiting on them: every CEO/MD who covers the
 * employee's company. With none (or no CEO/MD at all) the Backend is the
 * approver of last resort — the same fall-back services/profileChanges uses for
 * an HR-raised detail change.
 * @param {Object} request
 * @param {Object} actor - the HR who asked
 */
async function notifyApprovers(request, actor) {
  try {
    let recipients = await scopeRecipientsToCompany(await usersInRoles('CEO', 'MD'), request.company);
    if (!recipients.length) recipients = await usersInRoles('SuperAdmin');
    recipients = recipients.filter((id) => String(id) !== String(actor?._id));
    if (!recipients.length) return;
    const full = await populated(SalaryChangeRequest.findById(request._id)).lean();
    await notifyMany(recipients, {
      type: 'payroll',
      audience: 'admin',
      title: 'Salary change needs your approval',
      body: `${actorName(actor) || 'HR'} asked for ${request.kind === 'structure' ? '' : `a change to ${subjectName(full)}'s salary: `}`
        + `${describeRequest(full)}. Nothing reaches payroll until it is approved.`,
      link: APPROVER_LINK,
    });
  } catch (err) {
    console.error('salary-change approver notify failed:', err.message);
  }
}

/** Tell whoever asked how it went. */
async function notifyRequester(request, actor) {
  try {
    const full = await populated(SalaryChangeRequest.findById(request._id)).lean();
    const approved = request.status === 'Approved';
    await notify({
      recipient: request.requestedBy?._id || request.requestedBy,
      sender: actor?._id,
      type: 'payroll',
      audience: 'admin',
      title: approved ? 'Salary change approved' : 'Salary change not approved',
      body: `${actorName(actor) || 'An approver'} ${approved ? 'approved' : 'turned down'} `
        + `${request.kind === 'structure' ? '' : `the change to ${subjectName(full)}'s salary: `}${describeRequest(full)}.`
        + (approved && request.kind === 'revision' && request.appliedLive === false
          ? ` It takes effect from ${monthLabel(request.effectiveYear, request.effectiveMonth)}.` : '')
        + (request.decisionNote ? ` Note: "${request.decisionNote}"` : ''),
      link: REQUESTER_LINK[request.kind] || REQUESTER_LINK.setup,
    });
  } catch (err) {
    console.error('salary-change requester notify failed:', err.message);
  }
}

// ------------------------------------------------------------ deciding ----

/**
 * Refuse to approve a request whose starting point has moved since it was
 * raised — the approver agreed to "X → Y", not to "whatever is there now → Y".
 * Happens when a CEO/MD/Backend changed the salary directly in the meantime, or
 * somebody rewrote the structure it moves the person onto.
 * @param {Object} request
 * @param {Object|null} profile - EmployeeProfile document (employee kinds)
 * @param {Object|null} structure - SalaryStructure document ('structure' kind)
 * @throws 409 with what moved
 */
async function assertNotStale(request, profile, structure) {
  const moved = (what) => httpError(409, `${what} has changed since this was asked for, so approving it now would `
    + 'apply something nobody reviewed. Turn it down and ask HR to raise it again against the current salary.');

  if (request.kind === 'structure') {
    if (!structure) throw httpError(409, 'That salary structure has been deleted, so there is nothing to apply this to. Turn it down.');
    if (!sameComponents(componentsOf(structure), request.previousComponents)) throw moved(`The "${structure.name}" structure`);
    return;
  }
  if (!profile) throw httpError(409, 'That employee no longer exists. Turn this request down.');
  if (idOf(profile.salaryStructure) !== idOf(request.previousStructure)) throw moved('The employee\'s salary structure');
  const cur = request.kind === 'revision' ? (Number(profile.annualCtc) || 0) : currentCtcOf(profile);
  if (cur !== (Number(request.previousCtc) || 0)) throw moved('The employee\'s CTC');
  if (request.newStructure) {
    const target = await SalaryStructure.findById(request.newStructure).select('name components').lean();
    if (!target) throw httpError(409, 'The salary structure this moves them onto has been deleted. Turn it down.');
    if (request.newStructureComponents && !sameComponents(componentsOf(target), request.newStructureComponents)) {
      throw moved(`The "${target.name}" structure`);
    }
  }
}

/**
 * Apply an approved request to the record it is about.
 * @param {Object} request - SalaryChangeRequest document (Pending)
 * @param {Object} actor - the approver
 * @param {{profile?: Object, structure?: Object}} targets - loaded documents
 * @returns {Promise<void>}
 */
async function applyApproved(request, actor, { profile, structure }) {
  await assertNotStale(request, profile, structure);
  const meta = {
    by: request.requestedBy?._id || request.requestedBy,
    byName: request.requestedByName,
    approvedBy: actor._id,
    approvedByName: actorName(actor),
    requestId: request._id,
  };

  if (request.kind === 'structure') {
    const next = componentsOf(request.newComponents);
    const total = componentTotal(next);
    if (total > 100 + PCT_TOTAL_EPSILON) {
      throw httpError(400, `These percentages add up to ${total}%, which is more than the whole CTC.`);
    }
    structure.components = next;
    await structure.save();
    return;
  }

  if (request.kind === 'setup') {
    const cls = classifySetup(profile, {
      structure: request.newStructure ? request.newStructure : (request.clearStructure ? null : undefined),
      ctc: request.newCtc,
    });
    applySetup(profile, cls, {
      ...meta,
      reason: request.reason,
      effectiveYear: request.effectiveYear,
      effectiveMonth: request.effectiveMonth,
    });
    await profile.save();
    return;
  }

  // 'revision' — exactly the entry the approver was shown, not a recomputation.
  const { live } = applyRevision(profile, {
    previousCtc: request.previousCtc,
    newCtc: request.newCtc,
    mode: request.mode,
    value: request.value,
    previousStructure: request.previousStructure || null,
    newStructure: request.newStructure || request.previousStructure || null,
    effectiveYear: request.effectiveYear,
    effectiveMonth: request.effectiveMonth,
    reason: request.reason || '',
  }, meta);
  request.appliedLive = live;
  await profile.save();
}

module.exports = {
  COMPONENT_KEYS,
  APPROVER_LINK,
  writesSalaryDirectly,
  httpError,
  thisMonthIST,
  currentCtcOf,
  componentsOf,
  sameComponents,
  classifySetup,
  applySetup,
  computeRevision,
  applyRevision,
  assertNoPendingFor,
  raiseSetupChange,
  raiseRevision,
  raiseStructureChange,
  structureLock,
  holdersOf,
  describeRequest,
  subjectName,
  shapeForViewer,
  populated,
  notifyRequester,
  assertNotStale,
  applyApproved,
  actorName,
};
