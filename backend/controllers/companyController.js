/**
 * Company controller — manages the companies (legal entities) the HRMS runs
 * for. Employees belong to a company (EmployeeProfile.company) and a CEO/MD can
 * be limited by the Backend to the companies they may see (User.companies).
 *
 * Reads are open to any authenticated user (dropdowns, and the Companies page
 * an HR Manager reads). Writes belong to the Backend and the executives — see
 * routes/companyRoutes.js for why CEO/MD are named there explicitly.
 */
const asyncHandler = require('express-async-handler');
const Company = require('../models/Company');
const EmployeeProfile = require('../models/EmployeeProfile');
const { EXECUTIVE_ROLES } = require('../utils/visibility');

/**
 * Refuse an executive who has been narrowed to certain companies the right to
 * touch one outside that list.
 *
 * Without this, naming CEO/MD in the write gate would hand a CEO limited to one
 * company the power to rename or delete every OTHER company — the exact thing
 * `User.companies` exists to prevent. Same semantics as everywhere else: an
 * empty/absent list means unrestricted, so only a deliberately narrowed exec is
 * held to it.
 * @param {import('express').Request} req
 * @param {object|null} company - the target; omit when creating.
 * @throws {Error} with .status 403 when the company is out of their scope.
 */
function assertCompanyScope(req, company) {
  const u = req.user;
  if (!u || !EXECUTIVE_ROLES.includes(u.role)) return; // Backend: unrestricted
  const ids = Array.isArray(u.companies) ? u.companies.filter(Boolean).map(String) : [];
  if (!ids.length) return; // not narrowed → every company
  // Creating while narrowed would produce a company they cannot then manage.
  if (!company) {
    const err = new Error('Your account is limited to certain companies, so you cannot add a new one. Ask the Backend account.');
    err.status = 403;
    throw err;
  }
  if (!ids.includes(String(company._id))) {
    const err = new Error(`Your account is not assigned to ${company.name}, so you cannot change it.`);
    err.status = 403;
    throw err;
  }
}

/**
 * List all companies, each with its assigned-employee count.
 * @route GET /api/companies
 * @returns {{count: number, companies: Object[]}} companies with assignedCount
 */
const listCompanies = asyncHandler(async (req, res) => {
  const companies = await Company.find().sort({ name: 1 }).lean();
  const counts = await EmployeeProfile.aggregate([
    { $match: { company: { $ne: null } } },
    { $group: { _id: '$company', n: { $sum: 1 } } },
  ]);
  const byId = {};
  counts.forEach((c) => { byId[String(c._id)] = c.n; });
  res.json({
    count: companies.length,
    companies: companies.map((c) => ({ ...c, assignedCount: byId[String(c._id)] || 0 })),
  });
});

/**
 * Create a company (unique name; unique code when given).
 * @route POST /api/companies  (Backend / CEO / MD)
 * @returns {{company: Object}} 201; 409 on a duplicate name/code; 403 for a company-limited exec
 */
const createCompany = asyncHandler(async (req, res) => {
  assertCompanyScope(req, null);
  const { name, code, isActive } = req.body;
  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('name is required');
  }
  const trimmed = name.trim();
  if (await Company.findOne({ name: trimmed })) {
    res.status(409);
    throw new Error('A company with that name already exists');
  }
  const cleanCode = code && code.trim() ? code.trim().toUpperCase() : undefined;
  if (cleanCode && (await Company.findOne({ code: cleanCode }))) {
    res.status(409);
    throw new Error('A company with that code already exists');
  }
  const company = await Company.create({
    name: trimmed,
    code: cleanCode,
    isActive: isActive !== false,
    createdBy: req.user._id,
  });
  res.status(201).json({ company });
});

/**
 * Update a company's fields (partial).
 * @route PUT /api/companies/:id  (Backend / CEO / MD)
 * @returns {{company: Object}}; 403 when the company is outside a limited exec's list
 */
const updateCompany = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) {
    res.status(404);
    throw new Error('Company not found');
  }
  assertCompanyScope(req, company);
  const { name, code, isActive } = req.body;
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (!trimmed) {
      res.status(400);
      throw new Error('name cannot be empty');
    }
    const clash = await Company.findOne({ name: trimmed, _id: { $ne: company._id } });
    if (clash) {
      res.status(409);
      throw new Error('A company with that name already exists');
    }
    company.name = trimmed;
  }
  if (code !== undefined) {
    const cleanCode = code && String(code).trim() ? String(code).trim().toUpperCase() : undefined;
    if (cleanCode) {
      const clash = await Company.findOne({ code: cleanCode, _id: { $ne: company._id } });
      if (clash) {
        res.status(409);
        throw new Error('A company with that code already exists');
      }
    }
    company.code = cleanCode;
  }
  if (isActive !== undefined) company.isActive = !!isActive;
  await company.save();
  res.json({ company });
});

/**
 * Delete a company, but only when no employees are still assigned to it.
 * @route DELETE /api/companies/:id  (Backend / CEO / MD)
 * @returns {{id: string, deleted: boolean}}; 400 if employees remain assigned, 403 if out of scope
 */
const deleteCompany = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) {
    res.status(404);
    throw new Error('Company not found');
  }
  assertCompanyScope(req, company);
  const assigned = await EmployeeProfile.countDocuments({ company: company._id });
  if (assigned > 0) {
    res.status(400);
    throw new Error(`${assigned} employee(s) are still assigned to this company. Reassign them before deleting.`);
  }
  await company.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Who belongs to a company =====

/** Shape one profile for the roster lists. */
const publicMember = (p) => ({
  _id: p._id,
  name: `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode,
  email: p.user?.email || '',
  employeeCode: p.employeeCode,
  designation: p.designation || '',
  department: p.department || '',
  isActive: p.user?.isActive !== false,
  company: p.company ? String(p.company._id || p.company) : null,
  companyName: p.company?.name || null,
});

/**
 * The employees assigned to a company, plus everyone who could be moved into it.
 *
 * Both lists come back in one call because the screen is one screen: you decide
 * who belongs here by looking at who is here and who is not, side by side.
 * `others` carries each person's CURRENT company, so moving somebody is a
 * visible move rather than a silent reassignment.
 * @route GET /api/companies/:id/employees  (any authenticated admin-portal user)
 * @returns {{company: Object, members: Object[], others: Object[]}}
 */
const listCompanyEmployees = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id).lean();
  if (!company) {
    res.status(404);
    throw new Error('Company not found');
  }
  const profiles = await EmployeeProfile.find({})
    .select('employeeCode designation department company user')
    .populate('user', 'firstName lastName email isActive')
    .populate('company', 'name')
    .sort({ employeeCode: 1 })
    .lean();

  const mine = String(company._id);
  const rows = profiles.filter((p) => p.user).map(publicMember);
  res.json({
    company: { _id: company._id, name: company.name, code: company.code || null },
    members: rows.filter((r) => r.company === mine),
    others: rows.filter((r) => r.company !== mine),
  });
});

/**
 * Move employees into this company, or clear them out of it.
 *
 * Writes `EmployeeProfile.company` directly rather than going through the
 * employee update endpoint: this is one field, the audience is different (the
 * Companies page, not HR's employee form), and a bulk move should be one
 * request rather than N.
 * @route PATCH /api/companies/:id/employees  (Backend / CEO / MD)
 * @param {string[]} [req.body.add] - profile ids to place in this company.
 * @param {string[]} [req.body.remove] - profile ids to leave company-less.
 * @returns {{added: number, removed: number}}
 */
const updateCompanyEmployees = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) {
    res.status(404);
    throw new Error('Company not found');
  }
  assertCompanyScope(req, company);

  const add = Array.isArray(req.body.add) ? req.body.add.filter(Boolean) : [];
  const remove = Array.isArray(req.body.remove) ? req.body.remove.filter(Boolean) : [];
  if (!add.length && !remove.length) {
    res.status(400);
    throw new Error('Nothing to change');
  }

  // A narrowed executive must not reach into a company they do not manage to
  // take its people — the scope check above only cleared the TARGET company.
  const u = req.user;
  const ids = EXECUTIVE_ROLES.includes(u.role) && Array.isArray(u.companies)
    ? u.companies.filter(Boolean).map(String)
    : [];
  if (ids.length && add.length) {
    const incoming = await EmployeeProfile.find({ _id: { $in: add } }).select('company').lean();
    const poaching = incoming.find((p) => p.company && !ids.includes(String(p.company)));
    if (poaching) {
      res.status(403);
      throw new Error('Some of those employees belong to a company your account is not assigned to.');
    }
  }

  const [added, removed] = await Promise.all([
    add.length
      ? EmployeeProfile.updateMany({ _id: { $in: add } }, { company: company._id })
      : Promise.resolve({ modifiedCount: 0 }),
    // Removing from a company means "no company", not "some other company" —
    // there is nowhere else to put them from this screen.
    remove.length
      ? EmployeeProfile.updateMany({ _id: { $in: remove }, company: company._id }, { $unset: { company: 1 } })
      : Promise.resolve({ modifiedCount: 0 }),
  ]);

  res.json({ added: added.modifiedCount || 0, removed: removed.modifiedCount || 0 });
});

module.exports = {
  listCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  listCompanyEmployees,
  updateCompanyEmployees,
  // exported for unit tests
  assertCompanyScope,
};
