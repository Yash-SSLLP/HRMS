const asyncHandler = require('express-async-handler');
const Department = require('../models/Department');
const EmployeeProfile = require('../models/EmployeeProfile');

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
  const countByName = new Map(counts.map((c) => [c._id, c.count]));

  const withCounts = departments.map((d) => ({ ...d, employeeCount: countByName.get(d.name) || 0 }));
  res.json({ count: withCounts.length, departments: withCounts });
});

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
