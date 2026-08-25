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

module.exports = {
  listCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  // exported for unit tests
  assertCompanyScope,
};
