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
const crypto = require('crypto');
const Document = require('../models/Document');
const { REQUIRED_DOCUMENT_CATEGORIES, SELF_UPLOAD_CATEGORIES, PII_CATEGORIES } = require('../models/Document');
const storage = require('../services/storage');
const cloudinary = require('../services/cloudinary');
const { writeWorkbook, parseWorkbook } = require('../services/employeeExcel');
const archiver = require('archiver');
const { appendEmployee, safe } = require('../services/employeeZip');
const { hiddenUserIds, shouldExcludeExecutives, executiveUserIds } = require('../utils/visibility');

const DEFAULT_IMPORT_PASSWORD = 'Welcome@123';

// Escape user text before using it inside a RegExp (for case-insensitive lookups).
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every HR/SuperAdmin sees and manages ALL employees — there is no per-HR
// "assigned employees" ownership. (Kept as functions so call sites are unchanged.)
function scopeForHR() {
  return {};
}

function hrCannotManage() {
  return false;
}

// Enforce the org hierarchy on a profile payload:
//  - nobody manages themselves (reportingManager / hrPartner !== own user)
//  - hrPartner must point at an HRManager or SuperAdmin
//  - an HRManager's own profile must report to / be partnered with a SuperAdmin
// Throws an Error (with .status) on violation.
async function validateHierarchy(body, linkedUserId) {
  const linkedId = String(linkedUserId);

  for (const field of ['hrPartner', 'reportingManager']) {
    if (body[field] && String(body[field]) === linkedId) {
      const err = new Error('A user cannot be their own manager or HR partner');
      err.status = 400;
      throw err;
    }
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
  const { q, department } = req.query;
  const filter = { ...scopeForHR(req) };
  if (department) filter.department = department;
  // Hide SuperAdmin accounts from non-SuperAdmin viewers, and — for pickers that
  // opt in via ?excludeExecutives=true — the CEO/MD accounts (unless a SuperAdmin
  // has turned on includeExecutivesInLists).
  const excludeUserIds = [...(await hiddenUserIds(req.user))];
  if (await shouldExcludeExecutives(req)) {
    excludeUserIds.push(...(await executiveUserIds()));
  }
  if (excludeUserIds.length) filter.user = { $nin: excludeUserIds };
  let query = EmployeeProfile.find(filter)
    .populate('user', 'firstName lastName email role isActive')
    .populate('hrPartner', 'firstName lastName email')
    .sort({ createdAt: -1 });
  let profiles = await query;
  if (q) {
    const re = new RegExp(q, 'i');
    profiles = profiles.filter(
      (p) =>
        re.test(p.employeeCode || '') ||
        re.test(p.designation || '') ||
        re.test(p.user?.firstName || '') ||
        re.test(p.user?.lastName || '') ||
        re.test(p.user?.email || '')
    );
  }
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

  await validateHierarchy(req.body, userId);

  const profile = await EmployeeProfile.create(req.body);
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
  // Reassigning the HR Partner is a SuperAdmin-only action — an HR Manager must
  // not be able to hand an employee off (or grab one) by editing this field.
  if (req.user.role !== 'SuperAdmin') {
    delete req.body.hrPartner;
    delete req.body.reportingManager;
  }

  await validateHierarchy(req.body, profile.user);

  Object.assign(profile, req.body);
  await profile.save();
  res.json({ profile });
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
  await profile.deleteOne();
  res.json({ id: req.params.id, deleted: true });
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
  const profiles = await EmployeeProfile.find({})
    .populate('user', 'firstName lastName email phone role isActive')
    .populate('hrPartner', 'firstName lastName email')
    .populate('reportingManager', 'firstName lastName email')
    .populate('salaryStructure', 'name')
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

  for (const { excelRow, user: u, profile: p } of rows) {
    try {
      // ----- Validate required fields -----
      if (!u.firstName || !u.lastName || !u.email) {
        throw new Error('First Name, Last Name and Email are required');
      }
      if (!p.employeeCode) throw new Error('Employee Code is required');
      if (!p.dateOfJoining) throw new Error('Date of Joining is required');

      // Role / privilege guard — only SuperAdmin can create admin-level
      // accounts via import; everyone else is limited to Employee.
      const role = u.role || 'Employee';
      if (!ROLES.includes(role)) throw new Error(`Invalid role "${role}"`);
      if (role !== 'Employee' && !isSuperAdmin) {
        throw new Error('Only SuperAdmin may create admin accounts');
      }

      // ----- Skip if email or employeeCode already exists -----
      const existingUser = await User.findOne({ email: u.email });
      if (existingUser) {
        skipped.push({ excelRow, email: u.email, reason: 'Email already exists' });
        continue;
      }
      const existingProfile = await EmployeeProfile.findOne({
        employeeCode: String(p.employeeCode).toUpperCase(),
      });
      if (existingProfile) {
        skipped.push({ excelRow, employeeCode: p.employeeCode, reason: 'Employee Code already exists' });
        continue;
      }

      // ----- Create User -----
      const userDoc = await User.create({
        email: u.email,
        password: DEFAULT_IMPORT_PASSWORD,
        firstName: u.firstName,
        lastName: u.lastName,
        phone: u.phone,
        role,
        isActive: u.isActive !== undefined ? u.isActive : true,
      });

      // Resolve HR partner email -> User._id (optional)
      let hrPartnerId;
      if (p.hrPartnerEmail) {
        const partner = await User.findOne({
          email: p.hrPartnerEmail,
          role: { $in: ['HRManager', 'SuperAdmin'] },
        });
        if (!partner) {
          throw new Error(`HR Partner email "${p.hrPartnerEmail}" does not match any HRManager or SuperAdmin`);
        }
        hrPartnerId = partner._id;
      }

      // Resolve Reporting Manager email -> User._id (any user; optional)
      let reportingManagerId;
      if (p.reportingManagerEmail) {
        const mgr = await User.findOne({ email: p.reportingManagerEmail });
        if (!mgr) {
          throw new Error(`Reporting Manager email "${p.reportingManagerEmail}" does not match any user`);
        }
        reportingManagerId = mgr._id;
      }

      // Resolve Salary Structure name -> SalaryStructure._id (case-insensitive; optional)
      let salaryStructureId;
      if (p.salaryStructureName) {
        const st = await SalaryStructure.findOne({
          name: new RegExp(`^${escapeRegExp(p.salaryStructureName)}$`, 'i'),
        });
        if (!st) {
          throw new Error(`Salary Structure "${p.salaryStructureName}" not found — create it under Salary Structures first`);
        }
        salaryStructureId = st._id;
      }

      // ----- Create EmployeeProfile (rollback user on failure) -----
      // Spread all parsed profile fields (address, emergencyContact, bankDetails,
      // grade, probation, statutory, CTC, …) then override the resolved refs and
      // the special lookup columns.
      const { hrPartnerEmail, reportingManagerEmail, salaryStructureName, ...profileFields } = p;
      try {
        await EmployeeProfile.create({
          ...profileFields,
          user: userDoc._id,
          employeeCode: String(p.employeeCode).toUpperCase(),
          employmentType: p.employmentType || 'FullTime',
          hrPartner: hrPartnerId,
          reportingManager: reportingManagerId,
          salaryStructure: salaryStructureId,
        });
      } catch (err) {
        await User.deleteOne({ _id: userDoc._id });
        throw err;
      }

      created.push({ excelRow, email: u.email, employeeCode: p.employeeCode });
    } catch (err) {
      errors.push({
        excelRow,
        message: err.message || 'Row failed',
      });
    }
  }

  res.json({
    total: rows.length,
    createdCount: created.length,
    skippedCount: skipped.length,
    errorCount: errors.length,
    defaultPassword: DEFAULT_IMPORT_PASSWORD,
    created,
    skipped,
    errors,
  });
});

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
    const { storagePath, sha256, sizeBytes } = storage.saveBuffer({
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
  createEmployee,
  updateEmployee,
  deleteEmployee,
  exportEmployeesXlsx,
  downloadImportTemplate,
  importEmployeesXlsx,
};
