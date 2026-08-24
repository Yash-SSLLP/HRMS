/**
 * Company controller — manages the companies (legal entities) the HRMS runs
 * for. Employees belong to a company (EmployeeProfile.company) and a CEO/MD can
 * be limited by the Backend to the companies they may see (User.companies).
 * Reads are open to any authenticated user (dropdowns); writes are Backend-only.
 */
const asyncHandler = require('express-async-handler');
const Company = require('../models/Company');
const EmployeeProfile = require('../models/EmployeeProfile');

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
 * @route POST /api/companies  (Backend / SuperAdmin)
 * @returns {{company: Object}} 201; 409 on a duplicate name/code
 */
const createCompany = asyncHandler(async (req, res) => {
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
 * @route PUT /api/companies/:id  (Backend / SuperAdmin)
 * @returns {{company: Object}}
 */
const updateCompany = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) {
    res.status(404);
    throw new Error('Company not found');
  }
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
 * @route DELETE /api/companies/:id  (Backend / SuperAdmin)
 * @returns {{id: string, deleted: boolean}}; 400 if employees remain assigned
 */
const deleteCompany = asyncHandler(async (req, res) => {
  const company = await Company.findById(req.params.id);
  if (!company) {
    res.status(404);
    throw new Error('Company not found');
  }
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
};
