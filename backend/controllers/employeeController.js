const asyncHandler = require('express-async-handler');
const EmployeeProfile = require('../models/EmployeeProfile');
const User = require('../models/User');
const { ROLES } = require('../models/User');
const Document = require('../models/Document');
const { REQUIRED_DOCUMENT_CATEGORIES } = require('../models/Document');
const { writeWorkbook, parseWorkbook } = require('../services/employeeExcel');
const archiver = require('archiver');
const { appendEmployee, safe } = require('../services/employeeZip');
const { hiddenUserIds } = require('../utils/visibility');

const DEFAULT_IMPORT_PASSWORD = 'Welcome@123';

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

// GET /api/employees  (HR/Admin)
const listEmployees = asyncHandler(async (req, res) => {
  const { q, department } = req.query;
  const filter = { ...scopeForHR(req) };
  if (department) filter.department = department;
  // Hide SuperAdmin accounts from non-SuperAdmin viewers.
  const hidden = await hiddenUserIds(req.user);
  if (hidden.length) filter.user = { $nin: hidden };
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

// DELETE /api/employees/:id  (SuperAdmin)
const deleteEmployee = asyncHandler(async (req, res) => {
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

// GET /api/employees/export.xlsx  (HR/Admin)
const exportEmployeesXlsx = asyncHandler(async (req, res) => {
  const profiles = await EmployeeProfile.find({})
    .populate('user', 'firstName lastName email phone role isActive')
    .populate('hrPartner', 'firstName lastName email')
    .sort({ employeeCode: 1 });
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="employees-${stamp}.xlsx"`);
  await writeWorkbook(res, profiles, { sheetName: 'Employees' });
});

// GET /api/employees/template.xlsx  (HR/Admin)
const downloadImportTemplate = asyncHandler(async (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="employee-import-template.xlsx"');
  await writeWorkbook(res, [], { sheetName: 'Employees', includeSample: true });
});

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

      // ----- Create EmployeeProfile (rollback user on failure) -----
      try {
        await EmployeeProfile.create({
          user: userDoc._id,
          employeeCode: String(p.employeeCode).toUpperCase(),
          dateOfBirth: p.dateOfBirth,
          gender: p.gender,
          maritalStatus: p.maritalStatus,
          dateOfJoining: p.dateOfJoining,
          designation: p.designation,
          department: p.department,
          workLocation: p.workLocation,
          employmentType: p.employmentType || 'FullTime',
          pan: p.pan,
          uan: p.uan,
          pfNumber: p.pfNumber,
          esicNumber: p.esicNumber,
          bankDetails: p.bankDetails,
          hrPartner: hrPartnerId,
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

module.exports = {
  getMyProfile,
  updateMyBirthday,
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
