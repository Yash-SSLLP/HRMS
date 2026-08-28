/**
 * Employee controller — the core employee directory (EmployeeProfile linked to
 * User). HR/Admin do profile CRUD (with org-hierarchy validation), document-status
 * checks, ZIP/Excel export and Excel import, plus a public per-employee document
 * submission link. Employees have limited self-service (own profile, birthday).
 * Visibility helpers hide SuperAdmin (and optionally CEO/MD) from non-SuperAdmins.
 */
const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { ROLES } = require('../models/User');
const SalaryStructure = require('../models/SalaryStructure');
const Company = require('../models/Company');
const WorkLocation = require('../models/WorkLocation');
const crypto = require('crypto');
const Document = require('../models/Document');
const { REQUIRED_DOCUMENT_CATEGORIES, SELF_UPLOAD_CATEGORIES, PII_CATEGORIES } = require('../models/Document');
const storage = require('../services/storage');
const cloudinary = require('../services/cloudinary');
const { writeWorkbook, parseWorkbook } = require('../services/employeeExcel');
const archiver = require('archiver');
const { appendEmployee, safe } = require('../services/employeeZip');
const { hiddenUserIds, shouldExcludeExecutives, executiveUserIds, EXECUTIVE_ROLES } = require('../utils/visibility');
const { employeeProfileScope, cannotManageProfile, viewerCompanyScope, scopeEmployeeFilter, companyOutOfScope } = require('../utils/employeeScope');
const { hasPermission, isEditingExec } = require('../middleware/authMiddleware');
const { activeAccountWithEmail } = require('../utils/loginIdentity');

/**
 * Find an account by email, preferring the ACTIVE one.
 *
 * A work address may be held by a resigned employee's (deactivated) account and
 * by whoever inherited the seat — email is no longer unique (see
 * utils/loginIdentity). A bare findOne would return whichever came first, which
 * could quietly make a resigned person somebody's reporting manager. Falls back
 * to a deactivated match so lookups that legitimately name one still resolve.
 * @param {string} email
 * @param {Object} [extra] - additional filter (e.g. a role restriction)
 * @returns {Promise<Object|null>}
 */
async function findAccountByEmail(email, extra = {}) {
  const address = String(email ?? '').trim().toLowerCase();
  if (!address) return null;
  return (await User.findOne({ email: address, isActive: true, ...extra }))
    || User.findOne({ email: address, ...extra });
}
const { FIELD_CATALOG, fmtVal: fmtFieldVal, getPath: fieldGetPath, auditFieldChange } = require('../services/profileChanges');
const { notifyMany } = require('../services/notify');
const ImportFlag = require('../models/ImportFlag');
const { purgePerson } = require('../services/purgePerson');
const orgMasterSync = require('../services/orgMasterSync');

const DEFAULT_IMPORT_PASSWORD = 'Welcome@123';

/**
 * Normalise an employee code to the form the schema stores (trimmed, uppercase),
 * so "ssl 9" and "SSL 9 " are recognised as the same code.
 * @param {*} code - raw value from the request body.
 * @returns {string} normalised code ('' when nothing was supplied).
 */
const normalizeCode = (code) => String(code ?? '').trim().toUpperCase();

/**
 * Look up the profile already holding an employee code. The code carries a
 * unique index, but that only ever surfaces as a raw duplicate-key error — this
 * check runs first so the caller gets a plain "already exists" message naming
 * the code, and (on the mobile flow) before any User account is created.
 * @param {string} code - code being saved, any case.
 * @param {*} [excludeProfileId] - profile being edited; excluded from the check.
 * @returns {Promise<Object|null>} the clashing profile, or null when free.
 */
async function findProfileByCode(code, excludeProfileId = null) {
  const employeeCode = normalizeCode(code);
  if (!employeeCode) return null;
  const query = { employeeCode };
  if (excludeProfileId) query._id = { $ne: excludeProfileId };
  // hrPartner + company ride along for the scope check in checkEmployeeCode —
  // without them cannotManageProfile judges an empty profile and gets the
  // answer wrong in both directions.
  return EmployeeProfile.findOne(query).select('_id employeeCode user hrPartner company').populate('user', 'firstName lastName email');
}

/**
 * Throw a 409 when the employee code is already taken.
 * @param {import('express').Response} res
 * @param {string} code - code being saved, any case.
 * @param {*} [excludeProfileId] - profile being edited; excluded from the check.
 * @returns {Promise<string>} the normalised code, safe to persist.
 */
async function assertCodeAvailable(res, code, excludeProfileId = null) {
  const employeeCode = normalizeCode(code);
  const clash = await findProfileByCode(employeeCode, excludeProfileId);
  if (clash) {
    const who = `${clash.user?.firstName || ''} ${clash.user?.lastName || ''}`.trim();
    res.status(409);
    throw new Error(
      `Employee code "${employeeCode}" already exists${who ? ` (${who})` : ''}. Please choose another.`
    );
  }
  return employeeCode;
}

/**
 * Live availability check for the employee-code field, so the form can say
 * "already exists" while the operator types instead of only on save.
 * @route GET /api/employees/code-available?code=SSL%209&exclude=<profileId>
 * @returns {{code: string, available: boolean, takenBy?: string}}
 */
const checkEmployeeCode = asyncHandler(async (req, res) => {
  const code = normalizeCode(req.query.code);
  if (!code) {
    res.json({ code, available: false });
    return;
  }
  const clash = await findProfileByCode(code, req.query.exclude || null);
  res.json({
    code,
    available: !clash,
    // Name the holder only when the caller may see them — a taken code from
    // another company stays just "taken", not a directory probe. The COMPANY
    // wall, not the hrPartner rule: any same-company admin may be told which
    // colleague holds the code, or the message is useless.
    takenBy: clash && !companyOutOfScope(req, clash)
      ? `${clash.user?.firstName || ''} ${clash.user?.lastName || ''}`.trim() || undefined
      : undefined,
  });
});

/**
 * Tell whoever runs payroll that new employees were added without a salary
 * basis. Payroll can compute nothing for them — they produce a ₹0 payslip, and
 * even the late-arrival penalty is ₹0 because its rate keys off monthly Basic.
 *
 * A bulk import sends ONE notification covering all of them rather than one per
 * person, so importing fifty rows doesn't bury every HR inbox. Best-effort: a
 * notification failure must never fail the employee creation that triggered it.
 *
 * @param {Array<{id?: string, employeeCode?: string, name?: string}>} people - the ones missing salary
 * @returns {Promise<void>}
 */
async function notifyMissingSalarySetup(people) {
  try {
    const list = (people || []).filter(Boolean);
    if (!list.length) return;

    // Only people who can actually fix it: SuperAdmin, plus HR Managers holding
    // the payroll capability.
    const admins = await User.find({ role: { $in: ['SuperAdmin', 'HRManager'] }, isActive: true })
      .select('_id role permissions cashbookAccess')
      .lean();
    const recipients = admins.filter((u) => hasPermission(u, 'payroll.manage')).map((u) => u._id);
    if (!recipients.length) return;

    const label = (p) => `${p.name || 'A new employee'}${p.employeeCode ? ` (${p.employeeCode})` : ''}`;
    const single = list.length === 1;
    const title = single
      ? `${label(list[0])} has no salary set up`
      : `${list.length} new employees have no salary set up`;
    const names = list.slice(0, 3).map(label).join(', ');
    const body = `${single ? '' : `${names}${list.length > 3 ? ` and ${list.length - 3} more` : ''}. `}`
      + 'No salary structure or annual CTC, so payroll will compute ₹0. '
      + 'Set it on the Hikes page.';

    await notifyMany(recipients, {
      type: 'payroll',
      // Admin-portal notification — a dual-role HR Manager should not see this
      // in My Portal (see the notification-audience convention).
      audience: 'admin',
      title,
      body,
      // Straight to the assign modal for that person when it is about one
      // employee; the bare page when it covers several, since the deep link
      // only carries one id.
      link: single && list[0].id
        ? `/admin/salary-structures?assign=${list[0].id}`
        : '/admin/salary-structures',
    });
  } catch (err) {
    console.error('missing-salary notify failed:', err.message);
  }
}

// Does this profile payload leave the employee without a computable salary?
const missingSalary = (p) => !p?.salaryStructure || !p?.annualCtc;

// Escape user text before using it inside a RegExp (for case-insensitive lookups).
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Empty-string ObjectId refs (e.g. "None (top level)" → reportingManager: "")
// can't be cast and would blow up on save. Normalise them: scalar refs → null,
// array refs → drop the blanks. Run before validate/assign on create & update.
const SCALAR_REF_FIELDS = ['reportingManager', 'hrPartner', 'company', 'workLocationRef', 'salaryStructure'];
const ARRAY_REF_FIELDS = ['regularizationApprovers', 'leaveApprovers', 'leaveFinalHrRecipients'];
function normalizeRefFields(body) {
  if (!body || typeof body !== 'object') return;
  for (const f of SCALAR_REF_FIELDS) {
    if (f in body && (body[f] === '' || body[f] === undefined)) body[f] = null;
  }
  for (const f of ARRAY_REF_FIELDS) {
    if (Array.isArray(body[f])) body[f] = body[f].filter((v) => v != null && String(v).trim() !== '');
  }
}

// Is a dot-path actually present in a (possibly nested) payload object?
function payloadHasPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}
// Set a dot-path on a (possibly nested) payload object, creating objects as needed.
function payloadSetPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

// Who a given admin may SEE and MANAGE, shared with attendance and payroll so the
// rule is identical everywhere. See utils/employeeScope.js for the rules.
//   Backend (SuperAdmin) → everyone.
//   HR Manager           → only the employees they are the HR partner for.
//   CEO / MD             → the companies the Backend has assigned them; with
//                          none set they are unrestricted (see User.companies).
const scopeForHR = (req) => employeeProfileScope(req);
const hrCannotManage = (req, profile) => cannotManageProfile(req, profile);

/**
 * A company-walled admin may only place an employee in a company they can see.
 * Without this, HR of company A could set `company` to company B — moving the
 * person straight out of their own wall (and out of reach of undoing it).
 * @param {import('express').Request} req
 * @param {*} companyId - the requested `company` value (falsy = unassigned, allowed)
 * @throws 403 via res-less Error with .status when out of scope
 */
function assertAssignableCompany(req, companyId) {
  if (!companyId) return; // clearing / leaving unassigned is always fine
  const scope = viewerCompanyScope(req);
  if (!scope) return; // Backend / unrestricted viewer
  if (!scope.ids.includes(String(companyId))) {
    const err = new Error('You can only place employees in your own company.');
    err.status = 403;
    throw err;
  }
}

// Executives (and the Backend account) can manage anyone: they have no employee
// profile and therefore no department, so the department rule below can't apply
// to them — and without this a department head would have nobody to report to.
const CROSS_DEPARTMENT_MANAGER_ROLES = ['CEO', 'MD', 'SuperAdmin'];

/**
 * A reporting manager must sit in the same department as the person reporting
 * to them, unless they are an executive.
 * @param {string} managerUserId - the proposed manager's User id
 * @param {string} department - the employee's department
 * @throws {Error} with .status 400 when the pairing is not allowed
 */
async function assertSameDepartment(managerUserId, department, allowCrossDepartment = false) {
  const manager = await User.findById(managerUserId).select('role firstName lastName');
  if (!manager) {
    const err = new Error('Reporting manager not found');
    err.status = 400;
    throw err;
  }
  if (CROSS_DEPARTMENT_MANAGER_ROLES.includes(manager.role)) return;
  // A SuperAdmin may deliberately cross departments (a matrix/dotted line), but
  // only by acknowledging it: the caller sends allowCrossDepartment after being
  // warned. Without that flag the pairing is still rejected, so an accidental
  // API call or a stale form cannot quietly reshape the hierarchy.
  if (allowCrossDepartment) return;

  const managerProfile = await EmployeeProfile.findOne({ user: managerUserId }).select('department');
  const managerDept = managerProfile && managerProfile.department;
  if (!department || managerDept !== department) {
    const name = `${manager.firstName || ''} ${manager.lastName || ''}`.trim() || 'That user';
    const err = new Error(
      `${name} is in ${managerDept || 'no department'}, so they cannot be the reporting manager for `
      + `${department ? `the ${department} department` : 'an employee with no department'}. `
      + 'Pick someone from the same department or an executive — or confirm the '
      + 'cross-department assignment when prompted.'
    );
    err.status = 400;
    throw err;
  }
}

// Enforce the org hierarchy on a profile payload:
//  - nobody manages themselves (reportingManager / hrPartner !== own user)
//  - a reporting manager is in the same department (executives excepted)
//  - hrPartner must point at an HRManager or SuperAdmin
//  - an HRManager's own profile must report to / be partnered with a SuperAdmin
// Throws an Error (with .status) on violation.
/**
 * Reject a check-in site that belongs to a different company than the employee.
 * Enforced only for NEWLY INTRODUCED mismatches: a legacy record whose stored
 * (company, site) pairing already mismatches is left alone so editing its other
 * fields never gets blocked — the pairing is refused only when this write sets it
 * to a mismatch it wasn't already at. Shared (company-less) sites and employees
 * with no company are never constrained.
 * @param {string} workLocationRefId - the resulting WorkLocation id (or falsy)
 * @param {string} companyId - the resulting employee company id (or falsy)
 * @param {Object|null} existing - the stored EmployeeProfile (null on create)
 * @throws {Error} .status 400 when the write introduces a company↔site mismatch
 */
async function assertWorkLocationCompany(workLocationRefId, companyId, existing = null) {
  if (!workLocationRefId || !companyId) return; // no site, or no company → nothing to constrain
  const site = await WorkLocation.findById(workLocationRefId).select('company');
  if (!site || !site.company) return; // unknown or shared site → allowed
  if (String(site.company) === String(companyId)) return; // company matches → allowed
  // Mismatch: allow only if it is exactly the pairing already stored (so editing
  // an unrelated field on a legacy mismatched record is not blocked).
  if (existing
    && String(existing.workLocationRef || '') === String(workLocationRefId)
    && String(existing.company || '') === String(companyId)) {
    return;
  }
  const err = new Error("That check-in site belongs to a different company than the employee. Choose a site in the employee's company, or a shared site.");
  err.status = 400;
  throw err;
}

async function validateHierarchy(body, linkedUserId, existing = null, allowCrossDepartment = false) {
  const linkedId = String(linkedUserId);

  for (const field of ['hrPartner', 'reportingManager']) {
    if (body[field] && String(body[field]) === linkedId) {
      const err = new Error('A user cannot be their own manager or HR partner');
      err.status = 400;
      throw err;
    }
  }

  // Regularization approvers are an ordered array (1 or 2 people), so they need
  // their own checks rather than the single-field loop above.
  if (body.regularizationApprovers !== undefined) {
    const list = (body.regularizationApprovers || []).map(String).filter(Boolean);
    if (list.length > 2) {
      const err = new Error('A regularization can have at most 2 approval steps');
      err.status = 400;
      throw err;
    }
    if (list.includes(linkedId)) {
      const err = new Error('An employee cannot approve their own regularization');
      err.status = 400;
      throw err;
    }
    if (new Set(list).size !== list.length) {
      const err = new Error('The same person cannot be both regularization approvers');
      err.status = 400;
      throw err;
    }
    for (const id of list) {
      const u = await User.findById(id).select('isActive');
      if (!u || u.isActive === false) {
        const err = new Error('A regularization approver must be an active user');
        err.status = 400;
        throw err;
      }
    }
    body.regularizationApprovers = list;
  }

  // Leave approval hierarchy — same shape as the regularization ladder above,
  // but up to 4 rungs. Empty is legal and means "not configured": leave then
  // falls back to the reportingManager walk.
  if (body.leaveApprovers !== undefined) {
    const list = (body.leaveApprovers || []).map(String).filter(Boolean);
    if (list.length > 4) {
      const err = new Error('A leave approval hierarchy can have at most 4 steps');
      err.status = 400;
      throw err;
    }
    if (list.includes(linkedId)) {
      const err = new Error('An employee cannot approve their own leave');
      err.status = 400;
      throw err;
    }
    if (new Set(list).size !== list.length) {
      const err = new Error('The same person cannot appear twice in the leave approval hierarchy');
      err.status = 400;
      throw err;
    }
    for (const id of list) {
      const u = await User.findById(id).select('isActive');
      if (!u || u.isActive === false) {
        const err = new Error('A leave approver must be an active user');
        err.status = 400;
        throw err;
      }
    }
    body.leaveApprovers = list;
  }

  // HR recipients of the "fully approved" notice. Same rule as hrPartner: only
  // an HRManager or SuperAdmin can be told, since the notice carries the whole
  // request. Order is irrelevant here — it is an audience, not a ladder.
  if (body.leaveFinalHrRecipients !== undefined) {
    const list = [...new Set((body.leaveFinalHrRecipients || []).map(String).filter(Boolean))];
    for (const id of list) {
      const u = await User.findById(id).select('role isActive');
      if (!u || u.isActive === false) {
        const err = new Error('A leave HR recipient must be an active user');
        err.status = 400;
        throw err;
      }
      if (u.role !== 'HRManager' && u.role !== 'SuperAdmin') {
        const err = new Error('Only an HR Manager or SuperAdmin can be a leave HR recipient');
        err.status = 400;
        throw err;
      }
    }
    body.leaveFinalHrRecipients = list;
  }

  if (body.reportingManager) {
    // On an update the payload may not carry the department — fall back to the
    // stored one so a manager change is still checked against the real value.
    const department = body.department !== undefined ? body.department : (existing && existing.department);
    await assertSameDepartment(body.reportingManager, department, allowCrossDepartment);
  }

  const linkedUser = await User.findById(linkedUserId).select('role');

  if (body.hrPartner) {
    const partner = await User.findById(body.hrPartner).select('role');
    if (!partner || !['HRManager', 'SuperAdmin'].includes(partner.role)) {
      const err = new Error('HR Partner must be an HR Manager or SuperAdmin');
      err.status = 400;
      throw err;
    }
    // An HR Manager is managed by SuperAdmin — their HR partner must be a SuperAdmin.
    if (linkedUser && linkedUser.role === 'HRManager' && partner.role !== 'SuperAdmin') {
      const err = new Error('An HR Manager must be assigned to a SuperAdmin');
      err.status = 400;
      throw err;
    }
  }
}

/**
 * Employee self-service update of their own date of birth.
 * @route PATCH /api/employees/me/birthday
 * @param {string} req.body.dateOfBirth - required, not in the future
 * @returns {{profile: {_id, dateOfBirth}}}
 */
// PATCH /api/employees/me/birthday  { dateOfBirth }
// Self-service: an employee may set/update their own date of birth (used by the
// birthday wisher). Low-sensitivity, so it doesn't go through a change request.
const updateMyBirthday = asyncHandler(async (req, res) => {
  const { dateOfBirth } = req.body;
  if (!dateOfBirth) {
    res.status(400);
    throw new Error('A date of birth is required');
  }
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) {
    res.status(400);
    throw new Error('Invalid date of birth');
  }
  if (dob > new Date()) {
    res.status(400);
    throw new Error('Date of birth cannot be in the future');
  }

  const profile = await EmployeeProfile.findOne({ user: req.user._id });
  if (!profile) {
    res.status(404);
    throw new Error('Profile not yet created. Contact HR.');
  }
  profile.dateOfBirth = dob;
  await profile.save();
  res.json({ profile: { _id: profile._id, dateOfBirth: profile.dateOfBirth } });
});

/**
 * Get the calling user's own employee profile.
 * @route GET /api/employees/me
 * @returns {{profile: Object}} with populated user/hrPartner; 404 if not created
 */
// GET /api/employees/me  -- the calling user's own profile
const getMyProfile = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ user: req.user._id })
    .populate('user', 'firstName lastName email role phone isActive')
    .populate('hrPartner', 'firstName lastName email');
  if (!profile) {
    res.status(404);
    throw new Error('Profile not yet created. Contact HR.');
  }
  res.json({ profile });
});

/**
 * List employee profiles with optional text/department filters.
 * @route GET /api/employees  (HR/Admin)
 * @param {string} [req.query.q] - matches code/designation/name/email
 * @param {string} [req.query.department]
 * @param {string} [req.query.excludeExecutives] - 'true' hides CEO/MD from pickers
 * @returns {{count: number, profiles: Object[]}} (SuperAdmin hidden from non-SuperAdmins)
 */
// GET /api/employees  (HR/Admin)
const listEmployees = asyncHandler(async (req, res) => {
  const { q, department, company } = req.query;
  const filter = { ...scopeForHR(req) };
  if (department) filter.department = department;
  if (company) filter.company = company;
  // Hide SuperAdmin accounts from non-SuperAdmin viewers, and — for pickers that
  // opt in via ?excludeExecutives=true — the CEO/MD accounts (unless a SuperAdmin
  // has turned on includeExecutivesInLists).
  const excludeUserIds = [...(await hiddenUserIds(req.user))];
  if (await shouldExcludeExecutives(req)) {
    excludeUserIds.push(...(await executiveUserIds()));
  }

  // Search in the QUERY rather than over the fetched rows. Name and email live
  // on the User account, so matching them means resolving the matching user ids
  // first — one extra query, versus loading every profile in scope and throwing
  // most of them away in JS. The input is regex-escaped: it is user-supplied and
  // went straight into `new RegExp` before.
  let userIdFilter = null;
  const term = (q || '').trim();
  if (term) {
    const re = new RegExp(escapeRegExp(term), 'i');
    const matchedUsers = await User.find({
      $or: [{ firstName: re }, { lastName: re }, { email: re }],
    }).select('_id').lean();
    userIdFilter = matchedUsers.map((u) => u._id);
    // Composed via $and rather than assigning filter.$or: the scope fragment
    // spread in above is a SECURITY filter, and if it ever grows an $or of its
    // own a bare assignment here would silently drop it.
    filter.$and = [
      ...(filter.$and || []),
      { $or: [{ employeeCode: re }, { designation: re }, { user: { $in: userIdFilter } }] },
    ];
  }
  if (excludeUserIds.length) filter.user = { $nin: excludeUserIds };

  const profiles = await EmployeeProfile.find(filter)
    // ctcHistory is an unbounded per-employee array of salary revisions and
    // docToken is the secret behind that employee's public upload link —
    // neither is read from a directory row, and both were being shipped to
    // every HR browser on every load. The single-profile GET still returns them.
    .select('-ctcHistory -docToken')
    // `updatedAt` on the USER as well as the profile: role, login email and
    // phone are stored on the account, so an edit to any of them moves that
    // stamp and not the profile's. The directory's "last updated" column takes
    // the later of the two, which is the only honest answer.
    .populate('user', 'firstName lastName email role isActive updatedAt')
    .populate('hrPartner', 'firstName lastName email')
    .populate('company', 'name code')
    .sort({ createdAt: -1 })
    // Read-only response — skip hydrating full Mongoose documents (and their
    // subdocument schemas) only to serialise them straight back out.
    .lean();

  res.json({ count: profiles.length, profiles });
});

/**
 * Report per-employee required-document completeness.
 * @route GET /api/employees/documents-status  (HR/Admin)
 * @returns {{required: string[], statuses: Array<{employee, verified, complete, missing}>}}
 */
// GET /api/employees/documents-status  (HR/Admin)
// For each in-scope employee, report whether their required documents are complete.
const employeesDocumentStatus = asyncHandler(async (req, res) => {
  const profiles = await EmployeeProfile.find(scopeForHR(req)).select('_id documentsVerified');
  const ids = profiles.map((p) => p._id);

  const docs = await Document.find({ employee: { $in: ids } }).select('employee category');
  const byEmployee = new Map(); // employeeId -> Set(categories)
  for (const d of docs) {
    const key = String(d.employee);
    if (!byEmployee.has(key)) byEmployee.set(key, new Set());
    byEmployee.get(key).add(d.category);
  }

  const statuses = profiles.map((p) => {
    const have = byEmployee.get(String(p._id)) || new Set();
    const missing = REQUIRED_DOCUMENT_CATEGORIES.filter((c) => !have.has(c));
    const complete = p.documentsVerified || missing.length === 0;
    return { employee: p._id, verified: !!p.documentsVerified, complete, missing };
  });

  res.json({ required: REQUIRED_DOCUMENT_CATEGORIES, statuses });
});

/**
 * Get one employee profile by id.
 * @route GET /api/employees/:id  (HR/Admin)
 * @param {string} req.params.id - EmployeeProfile id
 * @returns {{profile: Object}} with populated user/hrPartner/reportingManager
 */
// GET /api/employees/:id  (HR/Admin)
const getEmployee = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.params.id)
    .populate('user', 'firstName lastName email role phone isActive')
    .populate('hrPartner', 'firstName lastName email')
    .populate('company', 'name code')
    .populate('reportingManager', 'firstName lastName email');
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  if (hrCannotManage(req, profile)) {
    res.status(403);
    throw new Error('You can only view employees assigned to you');
  }
  res.json({ profile });
});

/**
 * Create an employee profile for an existing user (hierarchy-validated).
 * @route POST /api/employees  (HR/Admin)
 * @param {string} req.body.user - user id (required)
 * @param {string} req.body.employeeCode - required
 * @param {string} req.body.dateOfJoining - required
 * @returns {{profile: Object}} (201); 409 if a profile already exists
 */
// POST /api/employees  (HR/Admin)
const createEmployee = asyncHandler(async (req, res) => {
  normalizeRefFields(req.body);
  const { user: userId, employeeCode, dateOfJoining } = req.body;
  if (!userId || !employeeCode || !dateOfJoining) {
    res.status(400);
    throw new Error('user, employeeCode, dateOfJoining are required');
  }

  const user = await User.findById(userId);
  if (!user) {
    res.status(404);
    throw new Error('User not found');
  }

  const exists = await EmployeeProfile.findOne({ user: userId });
  if (exists) {
    res.status(409);
    throw new Error('Profile already exists for this user');
  }

  // The employee code is unique across the org — check it here so a clash reads
  // as "already exists" rather than as a duplicate-key error from the index.
  req.body.employeeCode = await assertCodeAvailable(res, employeeCode);

  // Same rule as updateEmployee: assigning the HR Partner / reporting manager is
  // SuperAdmin-only. Without this an HR Manager could set them on create and
  // simply never edit them again.
  if (req.user.role !== 'SuperAdmin') {
    delete req.body.hrPartner;
    delete req.body.reportingManager;
    // Who signs off this employee's attendance corrections is a control an HR
    // Manager must not be able to point at themselves.
    delete req.body.regularizationApprovers;
    // Same reasoning for leave: the approval ladder and who is told once leave
    // is fully approved are both SuperAdmin controls.
    delete req.body.leaveApprovers;
    delete req.body.leaveFinalHrRecipients;
    // With per-HR scoping on, an HR Manager only sees the employees they partner.
    // Make them the partner of anyone they create, or the new joiner would drop
    // straight out of their directory the moment it was saved.
    if (req.user.role === 'HRManager') req.body.hrPartner = req.user._id;
  }

  // Consent flag, not profile data: pull it off the body so it is never stored,
  // and honour it only for the role that is allowed to set a manager at all.
  const allowCrossDept = req.body.allowCrossDepartment === true && req.user.role === 'SuperAdmin';
  delete req.body.allowCrossDepartment;

  await validateHierarchy(req.body, userId, null, allowCrossDept);
  assertAssignableCompany(req, req.body.company);
  await assertWorkLocationCompany(req.body.workLocationRef, req.body.company, null);

  const profile = await EmployeeProfile.create(req.body);

  // Flag a new joiner with no salary basis to whoever runs payroll. Not awaited:
  // the profile is created either way, and a notification hiccup must not turn a
  // successful create into an error response.
  if (missingSalary(profile)) {
    notifyMissingSalarySetup([{
      id: String(profile._id),
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
      employeeCode: profile.employeeCode,
    }]);
  }

  res.status(201).json({ profile });
});

/**
 * Update an employee profile (hierarchy-validated). Reassigning hrPartner/
 * reportingManager is SuperAdmin-only; the linked user cannot be changed.
 * @route PUT /api/employees/:id  (HR/Admin)
 * @param {string} req.params.id - EmployeeProfile id
 * @param {Object} req.body - fields to update
 * @returns {{profile: Object}}
 */
// PUT /api/employees/:id  (HR/Admin)
const updateEmployee = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.params.id);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  if (hrCannotManage(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  // Don't allow changing the linked user
  delete req.body.user;
  normalizeRefFields(req.body);

  // Same uniqueness rule as create, minus this profile's own current code.
  if (req.body.employeeCode !== undefined) {
    if (!normalizeCode(req.body.employeeCode)) {
      res.status(400);
      throw new Error('Employee Code is required');
    }
    req.body.employeeCode = await assertCodeAvailable(res, req.body.employeeCode, profile._id);
  }
  // Reassigning the HR Partner is a SuperAdmin-only action — an HR Manager must
  // not be able to hand an employee off (or grab one) by editing this field.
  if (req.user.role !== 'SuperAdmin') {
    delete req.body.hrPartner;
    delete req.body.reportingManager;
    // Who signs off this employee's attendance corrections is a control an HR
    // Manager must not be able to point at themselves.
    delete req.body.regularizationApprovers;
    // Same reasoning for leave: the approval ladder and who is told once leave
    // is fully approved are both SuperAdmin controls.
    delete req.body.leaveApprovers;
    delete req.body.leaveFinalHrRecipients;
  }

  // See createEmployee: consent flag, stripped before the payload is persisted.
  const allowCrossDept = req.body.allowCrossDepartment === true && req.user.role === 'SuperAdmin';
  delete req.body.allowCrossDepartment;

  await validateHierarchy(req.body, profile.user, profile, allowCrossDept);
  // Resulting (company, site) after this write — validate only a newly-introduced mismatch.
  const resultingRef = req.body.workLocationRef !== undefined ? req.body.workLocationRef : profile.workLocationRef;
  const resultingCompany = req.body.company !== undefined ? req.body.company : profile.company;
  if (req.body.company !== undefined) assertAssignableCompany(req, req.body.company);
  await assertWorkLocationCompany(resultingRef, resultingCompany, profile);

  // --- Route covered "detail" fields through the approval workflow ---
  // The Backend (SuperAdmin) and a CEO/MD in edit mode write directly (each
  // change audited). An HR Manager cannot change an employee's details directly:
  // every changed catalogue field is queued as a request to the company CEO/MD,
  // and the payload's value is reset to the current one so nothing is applied
  // now. Non-catalogue fields (company, work-location site, …) apply as before.
  const writesDirectly = req.user.role === 'SuperAdmin' || isEditingExec(req.user);
  const auditTarget = {
    name: `${profile.firstName || ''}`.trim() || undefined, // filled below from user if needed
    profileId: profile._id,
  };
  const directAudits = [];
  const queued = [];
  for (const [key, meta] of Object.entries(FIELD_CATALOG)) {
    if (meta.model !== 'Profile') continue; // name/email/phone live on User, edited elsewhere
    if (!payloadHasPath(req.body, meta.path)) continue;
    const nextVal = fmtFieldVal(meta, fieldGetPath(req.body, meta.path));
    const curVal = fmtFieldVal(meta, fieldGetPath(profile, meta.path));
    if (String(nextVal) === String(curVal)) continue; // unchanged
    if (writesDirectly) {
      directAudits.push({ meta, from: curVal, to: nextVal });
    } else {
      queued.push({ key, requestedValue: nextVal });
      // Keep the stored value so Object.assign leaves the field untouched.
      payloadSetPath(req.body, meta.path, fieldGetPath(profile, meta.path));
    }
  }

  Object.assign(profile, req.body);
  await profile.save();

  // A company change moves this person's wall — drop their cached scope so it
  // applies on their next request, not after the auth cache's TTL.
  if (req.body.company !== undefined) {
    require('../middleware/authMiddleware').invalidateScopeCompany([profile.user]);
  }

  // Audit direct edits (Backend / exec edit-mode).
  if (directAudits.length) {
    const u = await User.findById(profile.user).select('firstName lastName');
    auditTarget.name = `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
    directAudits.forEach((c) => auditFieldChange(req.user, c.meta, c.from, c.to, auditTarget));
  }

  // Queue an HR Manager's detail changes for the company CEO/MD.
  let queuedCount = 0;
  if (queued.length) {
    const { queueAdminChange } = require('./changeRequestController');
    for (const q of queued) {
      // eslint-disable-next-line no-await-in-loop
      const cr = await queueAdminChange(req.user, profile.user, q.key, q.requestedValue);
      if (cr) queuedCount += 1;
    }
  }

  res.json({ profile, queuedForApproval: queuedCount });
});

/**
 * Delete an employee profile.
 * @route DELETE /api/employees/:id  (SuperAdmin only)
 * @param {string} req.params.id - EmployeeProfile id
 * @returns {{id: string, deleted: boolean}}; 403 for non-SuperAdmin
 */
// DELETE /api/employees/:id  (SuperAdmin)
const deleteEmployee = asyncHandler(async (req, res) => {
  // Permission gate: only SuperAdmin may delete profiles
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only SuperAdmin may delete employee profiles');
  }
  const profile = await EmployeeProfile.findById(req.params.id);
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  // One cascade for both delete routes (see services/purgePerson.js): this used
  // to remove the profile and its import flags only, leaving the User login able
  // to sign in and every other record — attendance, leave, documents and their
  // files, notifications, chat, khata — orphaned in the database.
  const report = await purgePerson({ userId: profile.user, profileId: profile._id });
  res.json({ id: req.params.id, deleted: true, purged: report });
});

/**
 * Stream a ZIP of one employee's details.txt plus all their documents.
 * @route GET /api/employees/:id/export.zip  (HR/Admin)
 * @param {string} req.params.id - EmployeeProfile id
 * @returns {application/zip}
 */
// GET /api/employees/:id/export.zip  (HR/Admin; HR limited to assigned employees)
// Streams a ZIP with the employee's details.txt plus all their documents.
const exportEmployeeZip = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.params.id)
    .populate('user', 'firstName lastName email phone role isActive')
    .populate('hrPartner', 'firstName lastName email');
  if (!profile) {
    res.status(404);
    throw new Error('Employee profile not found');
  }
  if (hrCannotManage(req, profile)) {
    res.status(403);
    throw new Error('You can only export employees assigned to you');
  }

  const baseName = safe(profile.employeeCode || `${profile.user?.firstName || 'employee'}`);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Employee zip error:', err.message);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);
  await appendEmployee(archive, profile, '');
  await archive.finalize();
});

/**
 * Bulk-export all employees as a ZIP (one folder each: details.txt + documents).
 * @route GET /api/employees/export-all.zip  (SuperAdmin only)
 * @returns {application/zip}; 403 for non-SuperAdmin
 */
// GET /api/employees/export-all.zip  (SuperAdmin only)
// One folder per employee, each containing details.txt + documents.
const exportAllEmployeesZip = asyncHandler(async (req, res) => {
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    throw new Error('Only SuperAdmin may bulk-export all employees');
  }
  const profiles = await EmployeeProfile.find({})
    .populate('user', 'firstName lastName email phone role isActive')
    .populate('hrPartner', 'firstName lastName email')
    .sort({ employeeCode: 1 });

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="all-employees-${stamp}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Bulk zip error:', err.message);
    if (!res.headersSent) res.status(500);
    res.end();
  });
  archive.pipe(res);

  const usedFolders = new Set();
  for (const profile of profiles) {
    const name = `${profile.user?.firstName || ''}-${profile.user?.lastName || ''}`.trim();
    let folder = safe(`${profile.employeeCode || 'EMP'}_${name}`);
    let n = 1;
    const base = folder;
    while (usedFolders.has(folder)) { folder = `${base}_${n}`; n += 1; }
    usedFolders.add(folder);
    // eslint-disable-next-line no-await-in-loop
    await appendEmployee(archive, profile, folder);
  }

  await archive.finalize();
});

/**
 * Export all employees as an Excel workbook.
 * @route GET /api/employees/export.xlsx  (HR/Admin)
 * @returns {xlsx}
 */
// GET /api/employees/export.xlsx  (HR/Admin)
const exportEmployeesXlsx = asyncHandler(async (req, res) => {
  // Scoped like the directory: an HR Manager exports only their assigned
  // employees, a company-limited exec only their companies, the Backend all.
  const profiles = await EmployeeProfile.find(scopeForHR(req))
    .populate('user', 'firstName lastName email phone role isActive')
    .populate('hrPartner', 'firstName lastName email')
    .populate('reportingManager', 'firstName lastName email')
    .populate('salaryStructure', 'name')
    .populate('company', 'name code')
    .sort({ employeeCode: 1 });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="employees-${stamp}.xlsx"`);
  await writeWorkbook(res, profiles, { sheetName: 'Employees' });
});

/**
 * Download the employee-import Excel template (with a sample row).
 * @route GET /api/employees/template.xlsx  (HR/Admin)
 * @returns {xlsx}
 */
// GET /api/employees/template.xlsx  (HR/Admin)
const downloadImportTemplate = asyncHandler(async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="employee-import-template.xlsx"');
  await writeWorkbook(res, [], { sheetName: 'Employees', includeSample: true });
});

/**
 * Import employees from an Excel workbook (creates User + EmployeeProfile per row).
 * @route POST /api/employees/import  (HR/Admin, multipart field: file)
 * @param {File} req.file - the .xlsx (required)
 * @returns {{total, createdCount, skippedCount, errorCount, defaultPassword, created, skipped, errors}}
 * @sideeffect creates accounts with a default password; only SuperAdmin may import admin roles; rolls back the user if profile creation fails
 */
// POST /api/employees/import  (HR/Admin)  multipart file=<xlsx>
const importEmployeesXlsx = asyncHandler(async (req, res) => {
  if (!req.file) {
    res.status(400);
    throw new Error('Excel file is required (multipart field "file")');
  }
  let rows;
  try {
    rows = await parseWorkbook(req.file.buffer);
  } catch (err) {
    res.status(400);
    throw new Error(`Could not read workbook: ${err.message}`);
  }
  if (rows.length === 0) {
    res.status(400);
    throw new Error('No data rows found. The first row must be the header.');
  }

  const isSuperAdmin = req.user.role === 'SuperAdmin';
  const created = [];
  const skipped = [];
  const errors = [];
  const noSalary = []; // imported rows with no salary structure and/or CTC
  const flaggedRows = []; // rows that named something new, for the summary + notification
  // One id for this upload, so the review screen can group its flags together.
  const batch = crypto.randomBytes(8).toString('hex');

  for (const { excelRow, user: u, profile: p } of rows) {
    // Values this row named that did not exist yet. Collected per row and only
    // written once the employee is actually created — a flag pointing at a
    // profile that failed to save would be unresolvable.
    const rowFlags = [];
    const flag = (field, rawValue, action, note) => rowFlags.push({ field, rawValue, action, note });
    try {
      // ----- Validate required fields -----
      if (!u.firstName || !u.lastName || !u.email) {
        throw new Error('First Name, Last Name and Email are required');
      }
      if (!p.employeeCode) throw new Error('Employee Code is required');
      if (!p.dateOfJoining) throw new Error('Date of Joining is required');

      // ----- Role -----
      // A role is the ONE unknown value that is never auto-created: `ROLES` is
      // the enum the entire permission system gates on, so a role invented from
      // a spreadsheet cell would match no gate and belongs to nobody's decision.
      // An unrecognised value is almost always a job title, so the row imports
      // as an Employee (least privilege) and the flag says what was asked for.
      let role = (u.role || 'Employee').trim() || 'Employee';
      if (!ROLES.includes(role)) {
        flag('role', role, 'defaulted',
          `"${role}" is not a system role, so the account was created as an Employee. `
          + 'If it is a job title it belongs in the Designation column; otherwise set the right role here.');
        role = 'Employee';
      } else if (role !== 'Employee' && !isSuperAdmin) {
        // Same treatment for a real role the importer may not grant: import at
        // least privilege rather than losing the row, and let a SuperAdmin promote.
        flag('role', role, 'defaulted',
          `Only the Backend account may create ${role} logins, so this was created as an Employee. `
          + 'A Super Admin can change it here.');
        role = 'Employee';
      }

      // ----- Skip if email or employeeCode already exists -----
      // Only an ACTIVE account blocks the address: a resigned employee's
      // account is deactivated, which frees their work address for whoever
      // fills the seat (see utils/loginIdentity).
      const existingUser = await activeAccountWithEmail(u.email);
      if (existingUser) {
        skipped.push({ excelRow, email: u.email, reason: 'Email already in use by an active account' });
        continue;
      }
      // normalizeCode (trim + uppercase) matches what the schema actually
      // stores. Uppercasing alone left a trailing space from the spreadsheet on
      // the value, so "SSL 121 " missed the existing "SSL 121" here and then
      // tripped the unique index on save — the row failed with a raw duplicate
      // -key error instead of being skipped with a reason.
      const importCode = normalizeCode(p.employeeCode);
      const existingProfile = await EmployeeProfile.findOne({ employeeCode: importCode });
      if (existingProfile) {
        skipped.push({ excelRow, employeeCode: importCode, reason: 'Employee Code already exists' });
        continue;
      }

      // ----- References the sheet names by email / name -----
      // None of these fail the row any more. A person or a salary structure
      // cannot be invented from a string, so an unmatched one is left blank and
      // flagged; a plain NAME in a list of names is created and flagged.

      // HR partner email -> User._id (optional).
      let hrPartnerId;
      if (p.hrPartnerEmail) {
        const partner = await User.findOne({
          email: p.hrPartnerEmail,
          role: { $in: ['HRManager', 'SuperAdmin'] },
        });
        if (partner) hrPartnerId = partner._id;
        else {
          flag('hrPartner', p.hrPartnerEmail, 'unmatched',
            `No HR Manager or Backend account has the email "${p.hrPartnerEmail}", so no HR partner was set.`);
        }
      }

      // Reporting Manager email -> User._id (optional). The manager must be in
      // the same department as the employee (executives excepted) — the same
      // rule the admin form enforces. Both a missing person and a department
      // mismatch are flagged rather than thrown: the manager is very often
      // further down the SAME spreadsheet and does not exist yet at this point,
      // which used to make importing a whole team in one file impossible.
      let reportingManagerId;
      if (p.reportingManagerEmail) {
        const mgr = await findAccountByEmail(p.reportingManagerEmail);
        if (!mgr) {
          flag('reportingManager', p.reportingManagerEmail, 'unmatched',
            `No account has the email "${p.reportingManagerEmail}", so no reporting manager was set. `
            + 'If they are in this same file they exist now — set it here.');
        } else {
          try {
            await assertSameDepartment(mgr._id, p.department);
            reportingManagerId = mgr._id;
          } catch (deptErr) {
            flag('reportingManager', p.reportingManagerEmail, 'unmatched', deptErr.message);
          }
        }
      }

      // Salary Structure name -> SalaryStructure._id (case-insensitive; optional).
      // Deliberately NOT auto-created: a structure is a set of earning and
      // deduction rules, and an empty one invented here would look configured
      // while paying ₹0. Blank is the honest state, and it already feeds the
      // "no salary set up" notification below.
      let salaryStructureId;
      if (p.salaryStructureName) {
        const st = await SalaryStructure.findOne({
          name: new RegExp(`^${escapeRegExp(p.salaryStructureName)}$`, 'i'),
        });
        if (st) salaryStructureId = st._id;
        else {
          flag('salaryStructure', p.salaryStructureName, 'unmatched',
            `There is no salary structure called "${p.salaryStructureName}". It was left unset — `
            + 'create the structure under Salary Structures, then pick it here.');
        }
      }

      // Company name (or code) -> Company._id (case-insensitive; optional).
      // A company IS just a name here, so an unknown one is created.
      let companyId;
      if (p.companyName) {
        const needle = new RegExp(`^${escapeRegExp(p.companyName)}$`, 'i');
        let co = await Company.findOne({ $or: [{ name: needle }, { code: needle }] });
        if (!co) {
          co = await Company.create({ name: p.companyName, createdBy: req.user._id });
          flag('company', p.companyName, 'created',
            `"${p.companyName}" was not on the company list, so it was added. `
            + 'Check the name and fill in its details under Companies.');
        }
        companyId = co._id;
      }

      // ----- Free-text values backed by a managed list -----
      // Designation, department, grade and work-location label are plain names.
      // The profile's post-save hook registers designation and department; these
      // calls run first purely to learn whether the value is NEW, which is what
      // decides the flag. They are idempotent, so the hook stays harmless.
      const [newDesignation, newDepartment, newGrade, newLocation] = await Promise.all([
        orgMasterSync.ensureDesignation(p.designation),
        orgMasterSync.ensureDepartment(p.department),
        orgMasterSync.ensureGrade(p.grade),
        orgMasterSync.ensureLocation(p.workLocation),
      ]);
      if (newDesignation) {
        flag('designation', p.designation, 'created',
          `"${p.designation}" was not a known designation, so it was added to Org Masters.`);
      }
      if (newDepartment) {
        flag('department', p.department, 'created',
          `"${p.department}" was not a known department, so it was added to Departments.`);
      }
      if (newGrade) {
        flag('grade', p.grade, 'created',
          `"${p.grade}" was not a known grade, so it was added to Org Masters.`);
      }
      if (newLocation) {
        flag('workLocation', p.workLocation, 'created',
          `"${p.workLocation}" was not a known work location, so it was added to Org Masters. `
          + 'This is the label only — a geofenced site still has to be set up under Work Locations.');
      }

      // ----- Create the account and the employee record, together -----
      //
      // AN IMPORT ADDS AN EMPLOYEE, NEVER A BARE LOGIN. The account is created
      // HERE — last — precisely so nothing that can throw sits between it and
      // the employee record. It used to be created much further up, before the
      // four reference lookups above; when one of those threw (an unmatched
      // company or salary structure, which they no longer do), the row failed
      // with the User already saved, leaving a login belonging to nobody. That
      // is how 17 profile-less accounts appeared in one import. Keep these two
      // creates adjacent, and put new can-throw work ABOVE this line.
      const { hrPartnerEmail, reportingManagerEmail, salaryStructureName, companyName, ...profileFields } = p;
      const userDoc = await User.create({
        email: u.email,
        password: DEFAULT_IMPORT_PASSWORD,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        role,
        isActive: u.isActive !== undefined ? u.isActive : true,
      });

      let createdProfile;
      try {
        createdProfile = await EmployeeProfile.create({
          ...profileFields,
          user: userDoc._id,
          employeeCode: importCode,
          employmentType: p.employmentType || 'FullTime',
          hrPartner: hrPartnerId,
          reportingManager: reportingManagerId,
          salaryStructure: salaryStructureId,
          company: companyId,
        });
      } catch (err) {
        // The account must not outlive the failure that stopped its employee
        // record — that is the whole orphan problem, and this is its backstop.
        await User.deleteOne({ _id: userDoc._id }).catch(() => {});
        throw err;
      }

      created.push({ excelRow, email: u.email, employeeCode: importCode });

      // The row is safely on disk, so its flags now have something to point at.
      // Best-effort: a flag that fails to write must never undo an import that
      // otherwise succeeded — the employee is the thing that matters.
      if (rowFlags.length) {
        try {
          await ImportFlag.insertMany(rowFlags.map((f) => ({
            ...f,
            employee: createdProfile._id,
            user: userDoc._id,
            batch,
            excelRow,
            importedBy: req.user._id,
          })));
          flaggedRows.push({
            employeeCode: importCode,
            name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
            fields: rowFlags.map((f) => f.field),
          });
        } catch (flagErr) {
          console.error('Could not record import flags:', flagErr.message);
        }
      }

      // Imports often omit the salary columns — collect them and send ONE
      // notification after the loop rather than one per row.
      if (!salaryStructureId || !p.annualCtc) {
        noSalary.push({
          id: String(createdProfile._id),
          name: `${u.firstName || ''} ${u.lastName || ''}`.trim(),
          employeeCode: p.employeeCode,
        });
      }
    } catch (err) {
      errors.push({
        excelRow,
        message: err.message || 'Row failed',
      });
    }
  }

  notifyMissingSalarySetup(noSalary);
  notifyImportFlags(flaggedRows, batch);

  const flagCount = flaggedRows.reduce((a, r) => a + r.fields.length, 0);
  res.json({
    total: rows.length,
    createdCount: created.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    // How many values this upload had to invent or could not honour, so the
    // import dialog can send the user straight to the review list.
    flagCount,
    flaggedRows,
    batch,
    defaultPassword: DEFAULT_IMPORT_PASSWORD,
    created,
    skipped,
    errors,
  });
});

// ===== Import review — values the import had to create or could not match =====

/**
 * List the flags an import left behind.
 * @route GET /api/employees/import-flags  (employees.manage — HR, admins, CEO/MD)
 * @param {string} [req.query.status] - 'Open' (default) or 'Resolved'/'all'.
 * @param {string} [req.query.batch] - narrow to one upload.
 * @returns {{count: number, flags: Object[]}}
 */
const listImportFlags = asyncHandler(async (req, res) => {
  const status = req.query.status || 'Open';
  const filter = {};
  if (status !== 'all') filter.status = status;
  if (req.query.batch) filter.batch = req.query.batch;

  // Company wall: flags about another company's employees stay invisible.
  await scopeEmployeeFilter(req, filter);
  const flags = await ImportFlag.find(filter)
    .populate('user', 'firstName lastName email role')
    .populate({ path: 'employee', select: 'employeeCode designation department grade workLocation' })
    .populate('resolvedBy', 'firstName lastName')
    .populate('importedBy', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();

  res.json({ count: flags.length, flags });
});

/**
 * Field-by-field writers for resolving a flag with a corrected value.
 *
 * Each takes the raw string a reviewer typed and applies it to the right
 * document, resolving names/emails to ids the same way the import does. Kept as
 * one table rather than a switch so the set of settable fields is visibly the
 * same set the flag model enumerates.
 */
const FLAG_WRITERS = {
  role: async (value, { profile, user, actor }) => {
    if (!ROLES.includes(value)) throw new Error(`"${value}" is not a system role`);
    // Same rule as the import and the admin form: handing out an admin login is
    // the Backend account's call alone.
    if (value !== 'Employee' && actor.role !== 'SuperAdmin') {
      throw new Error('Only the Backend account may grant an admin role');
    }
    await User.updateOne({ _id: user._id }, { role: value });
    return value;
  },
  designation: async (value, { profile }) => {
    await orgMasterSync.ensureDesignation(value);
    profile.designation = value;
    await profile.save();
    return value;
  },
  department: async (value, { profile }) => {
    await orgMasterSync.ensureDepartment(value);
    profile.department = value;
    await profile.save();
    return value;
  },
  grade: async (value, { profile }) => {
    await orgMasterSync.ensureGrade(value);
    profile.grade = value;
    await profile.save();
    return value;
  },
  workLocation: async (value, { profile }) => {
    await orgMasterSync.ensureLocation(value);
    profile.workLocation = value;
    await profile.save();
    return value;
  },
  company: async (value, { profile }) => {
    const needle = new RegExp(`^${escapeRegExp(value)}$`, 'i');
    const co = await Company.findOne({ $or: [{ name: needle }, { code: needle }] });
    if (!co) throw new Error(`No company called "${value}" — add it under Companies first`);
    profile.company = co._id;
    await profile.save();
    require('../middleware/authMiddleware').invalidateScopeCompany([profile.user]);
    return co.name;
  },
  salaryStructure: async (value, { profile }) => {
    const st = await SalaryStructure.findOne({ name: new RegExp(`^${escapeRegExp(value)}$`, 'i') });
    if (!st) throw new Error(`No salary structure called "${value}" — create it under Salary Structures first`);
    profile.salaryStructure = st._id;
    await profile.save();
    return st.name;
  },
  reportingManager: async (value, { profile, actor }) => {
    const mgr = await findAccountByEmail(value);
    if (!mgr) throw new Error(`No account has the email "${value}"`);
    // A Backend account may knowingly cross departments (a dotted line); for
    // anyone else the same-department rule still applies.
    await assertSameDepartment(mgr._id, profile.department, actor.role === 'SuperAdmin');
    profile.reportingManager = mgr._id;
    await profile.save();
    return `${mgr.firstName || ''} ${mgr.lastName || ''}`.trim() || mgr.email;
  },
  hrPartner: async (value, { profile }) => {
    const partner = await findAccountByEmail(value, { role: { $in: ['HRManager', 'SuperAdmin'] } });
    if (!partner) throw new Error(`"${value}" is not an HR Manager or Backend account`);
    profile.hrPartner = partner._id;
    await profile.save();
    return `${partner.firstName || ''} ${partner.lastName || ''}`.trim() || partner.email;
  },
};

/**
 * Resolve one flag — optionally correcting the value first.
 *
 * Sending a `value` writes it onto the employee and closes the flag; sending
 * none just closes it ("what the import did was right"). Either way the flag is
 * kept, not deleted: it is the record of what the spreadsheet actually said.
 * @route PATCH /api/employees/import-flags/:id  (employees.manage; writes, so not a read-only exec)
 * @param {string} [req.body.value] - corrected value; omit to accept as-is.
 * @returns {{flag: Object, message: string}}
 */
const resolveImportFlag = asyncHandler(async (req, res) => {
  const flagDoc = await ImportFlag.findById(req.params.id);
  if (!flagDoc) {
    res.status(404);
    throw new Error('That import flag no longer exists');
  }
  if (flagDoc.status === 'Resolved') {
    res.status(400);
    throw new Error('This flag has already been dealt with');
  }

  const raw = req.body.value;
  const value = typeof raw === 'string' ? raw.trim() : '';
  let resolution = 'Accepted as imported';

  if (value) {
    const profile = await EmployeeProfile.findById(flagDoc.employee);
    if (!profile) {
      res.status(404);
      throw new Error('That employee no longer exists');
    }
    const write = FLAG_WRITERS[flagDoc.field];
    if (!write) {
      res.status(400);
      throw new Error(`"${flagDoc.field}" cannot be changed from here`);
    }
    let applied;
    try {
      applied = await write(value, { profile, user: { _id: flagDoc.user }, actor: req.user });
    } catch (err) {
      res.status(err.status || 400);
      throw err;
    }
    resolution = `Changed to ${applied}`;
  }

  flagDoc.status = 'Resolved';
  flagDoc.resolution = resolution;
  flagDoc.resolvedBy = req.user._id;
  flagDoc.resolvedAt = new Date();
  await flagDoc.save();

  res.json({ flag: flagDoc, message: resolution });
});

/**
 * Tell HR, the admins and the executives that an import invented values.
 *
 * ONE notification per upload, not one per flag: an import of fifty people who
 * all share a new department would otherwise fill every inbox with the same
 * fact. Best-effort — a notification failure never fails the import.
 * @param {Array<{employeeCode?: string, name?: string, fields: string[]}>} rows
 * @param {string} batch - the upload's id, so the link opens just its flags.
 * @returns {Promise<void>}
 */
async function notifyImportFlags(rows, batch) {
  try {
    const list = (rows || []).filter(Boolean);
    if (!list.length) return;

    // Everyone who can act on it: the Backend account, HR Managers holding the
    // employees capability, and the executives — the audience the business
    // asked for. CEO/MD see it even in view-only mode; opening the list is a read.
    const admins = await User.find({
      role: { $in: ['SuperAdmin', 'HRManager', 'CEO', 'MD'] },
      isActive: true,
    }).select('_id role permissions').lean();
    const recipients = admins
      .filter((u) => ['SuperAdmin', 'CEO', 'MD'].includes(u.role) || hasPermission(u, 'employees.manage'))
      .map((u) => u._id);
    if (!recipients.length) return;

    const flagCount = list.reduce((a, r) => a + r.fields.length, 0);
    // Name the actual fields — "3 new values" says nothing about whether this
    // needs looking at today, but "department, role" does.
    const fields = [...new Set(list.flatMap((r) => r.fields))];
    const LABELS = {
      role: 'role', designation: 'designation', department: 'department', grade: 'grade',
      workLocation: 'work location', company: 'company', salaryStructure: 'salary structure',
      reportingManager: 'reporting manager', hrPartner: 'HR partner',
    };
    const named = fields.map((f) => LABELS[f] || f).join(', ');
    const people = list.length === 1
      ? (list[0].name || list[0].employeeCode || 'one employee')
      : `${list.length} employees`;

    await notifyMany(recipients, {
      type: 'employee',
      // Admin-portal notification: a dual-role HR Manager should not meet this
      // in My Portal (see the notification-audience convention).
      audience: 'admin',
      title: `${flagCount} imported ${flagCount === 1 ? 'value needs' : 'values need'} a check`,
      body: `The Excel import created or could not match ${named} for ${people}. `
        + 'They were imported anyway — review and correct the values.',
      link: `/admin/employees?importFlags=${batch}`,
    });
  } catch (err) {
    console.error('notifyImportFlags failed:', err.message);
  }
}

// ===== Per-employee document submission link =====

/**
 * Ensure a public document-submission token exists for an employee.
 * @route POST /api/employees/:id/doc-link  (HR)
 * @param {string} req.params.id - EmployeeProfile id
 * @returns {{token: string}}
 */
// POST /api/employees/:id/doc-link  (HR) — ensure a public submission token.
const createDocLink = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findById(req.params.id);
  if (!profile) {
    res.status(404);
    throw new Error('Employee not found');
  }
  // Same wall as every other per-employee admin action — minting a public
  // upload/view link for another company's employee is exactly the kind of
  // side door the scope exists to close.
  if (hrCannotManage(req, profile)) {
    res.status(403);
    throw new Error('You can only manage employees assigned to you');
  }
  if (!profile.docToken) {
    profile.docToken = crypto.randomBytes(24).toString('hex');
    await profile.save();
  }
  res.json({ token: profile.docToken });
});

/**
 * Public: fetch the document-submission context for an employee via token.
 * @route GET /api/employees/public-docs/:token  (PUBLIC, no auth)
 * @param {string} req.params.token - docToken
 * @returns {{employee, docTypes, files}}; 404 if the link is invalid
 */
// GET /api/employees/public-docs/:token  (public) — what the employee sees.
const getPublicDocRequest = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ docToken: req.params.token })
    .populate('user', 'firstName lastName');
  if (!profile || !profile.docToken) {
    res.status(404);
    throw new Error('This document submission link is invalid or has expired.');
  }
  const docs = await Document.find({ employee: profile._id })
    .select('category fileName status createdAt')
    .sort({ createdAt: -1 })
    .lean();
  res.json({
    employee: {
      name: `${profile.user?.firstName || ''} ${profile.user?.lastName || ''}`.trim(),
      employeeCode: profile.employeeCode,
    },
    docTypes: SELF_UPLOAD_CATEGORIES,
    files: docs.map((d) => ({ category: d.category, fileName: d.fileName, status: d.status })),
  });
});

/**
 * Public: an employee uploads documents via their token (saved as Submitted).
 * @route POST /api/employees/public-docs/:token  (PUBLIC, multipart files[] + labels[])
 * @param {string} req.params.token - docToken
 * @param {File[]} req.files - documents (at least one required)
 * @param {string[]} [req.body.labels] - per-file category (unknown -> 'Other')
 * @returns {{ok: true, count}} (201)
 * @sideeffect best-effort Cloudinary backup of each file
 */
// POST /api/employees/public-docs/:token  (public, multipart files[] + labels[])
const submitPublicDocs = asyncHandler(async (req, res) => {
  const profile = await EmployeeProfile.findOne({ docToken: req.params.token });
  if (!profile || !profile.docToken) {
    res.status(404);
    throw new Error('This document submission link is invalid or has expired.');
  }
  const files = req.files || [];
  if (!files.length) {
    res.status(400);
    throw new Error('Please attach at least one document.');
  }
  const labels = Array.isArray(req.body.labels)
    ? req.body.labels
    : (req.body.labels != null ? [req.body.labels] : []);

  let saved = 0;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const category = SELF_UPLOAD_CATEGORIES.includes(labels[i]) ? labels[i] : 'Other';
    const { storagePath, sha256, sizeBytes } = await storage.saveBuffer({
      buffer: file.buffer,
      ownerType: 'employee',
      ownerId: profile._id,
      originalName: file.originalname || 'document',
    });
    const doc = await Document.create({
      employee: profile._id,
      category,
      fileName: file.originalname || 'document',
      storagePath,
      mime: file.mimetype,
      sizeBytes,
      sha256,
      isPii: PII_CATEGORIES.includes(category),
      status: 'Submitted',
    });
    // Best-effort durable backup to Cloudinary (never blocks the submission).
    if (cloudinary.enabled()) {
      try {
        doc.cloud = await cloudinary.uploadFileBuffer(file.buffer, {
          folder: `${process.env.CLOUDINARY_FOLDER || 'hrms-lms'}/documents/${profile._id}`,
        });
        await doc.save();
      } catch (err) {
        console.error('[employees] Cloudinary doc backup failed:', err.message);
      }
    }
    saved += 1;
  }
  res.status(201).json({ ok: true, count: saved });
});

module.exports = {
  getMyProfile,
  updateMyBirthday,
  createDocLink,
  getPublicDocRequest,
  submitPublicDocs,
  listEmployees,
  employeesDocumentStatus,
  exportEmployeeZip,
  exportAllEmployeesZip,
  getEmployee,
  checkEmployeeCode,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  exportEmployeesXlsx,
  downloadImportTemplate,
  importEmployeesXlsx,
  listImportFlags,
  resolveImportFlag,
  // exported for unit tests
  assertSameDepartment,
  assertWorkLocationCompany,
  validateHierarchy,
};
