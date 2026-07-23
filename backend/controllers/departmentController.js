/**
 * Department controller — CRUD for Department master data. Listing augments each
 * department with a live employeeCount aggregated from EmployeeProfile.
 * Mutations are SuperAdmin-only (enforced at the route layer).
 */
const asyncHandler = require('express-async-handler');
const Department = require('../models/Department');
const EmployeeProfile = require('../models/EmployeeProfile');

/**
 * List departments with a live employee count per department.
 * @route GET /api/departments
 * @param {string} [req.query.active] - 'true' to only return active departments
 * @returns {{count: number, departments: Object[]}} departments each with employeeCount
 */
// GET /api/departments   (any authenticated user — used to populate dropdowns)
// Each department carries an `employeeCount` so the Departments tab can show how
// many people are in it.
const listDepartments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.active === 'true') filter.isActive = true;
  const departments = await Department.find(filter).sort({ name: 1 }).lean();

  const counts = await EmployeeProfile.aggregate([
    { $match: { department: { $nin: [null, ''] } } },
    { $group: { _id: '$department', count: { $sum: 1 } } },
  ]);
  // Map department name -> headcount so we can attach counts without extra queries
  const countByName = new Map(counts.map((c) => [c._id, c.count]));

  const withCounts = departments.map((d) => ({ ...d, employeeCount: countByName.get(d.name) || 0 }));
  res.json({ count: withCounts.length, departments: withCounts });
});

/**
 * Create a department (unique name enforced).
 * @route POST /api/departments  (SuperAdmin)
 * @param {string} req.body.name - required, trimmed, must be unique
 * @param {boolean} [req.body.isActive=true]
 * @returns {{department: Object}} the created department (201); 409 if name exists
 */
// POST /api/departments   (SuperAdmin)
const createDepartment = asyncHandler(async (req, res) => {
  const { name, isActive } = req.body;
  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('name is required');
  }
  const exists = await Department.findOne({ name: name.trim() });
  if (exists) {
    res.status(409);
    throw new Error('A department with that name already exists');
  }
  const department = await Department.create({
    name: name.trim(),
    isActive: isActive !== undefined ? isActive : true,
    createdBy: req.user._id,
  });
  res.status(201).json({ department });
});

/**
 * Update a department's name and/or active flag.
 * @route PUT /api/departments/:id  (SuperAdmin)
 * @param {string} req.params.id - department id
 * @param {string} [req.body.name]
 * @param {boolean} [req.body.isActive]
 * @returns {{department: Object}} the updated department
 */
// PUT /api/departments/:id   (SuperAdmin)
const updateDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findById(req.params.id);
  if (!department) {
    res.status(404);
    throw new Error('Department not found');
  }
  const { name, isActive } = req.body;
  if (name !== undefined) department.name = name.trim();
  if (isActive !== undefined) department.isActive = isActive;
  await department.save();
  res.json({ department });
});

/**
 * Delete a department by id.
 * @route DELETE /api/departments/:id  (SuperAdmin)
 * @param {string} req.params.id - department id
 * @returns {{id: string, deleted: boolean}}
 */
// DELETE /api/departments/:id   (SuperAdmin)
const deleteDepartment = asyncHandler(async (req, res) => {
  const department = await Department.findById(req.params.id);
  if (!department) {
    res.status(404);
    throw new Error('Department not found');
  }
  await department.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

module.exports = { listDepartments, createDepartment, updateDepartment, deleteDepartment };
