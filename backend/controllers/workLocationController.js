const asyncHandler = require('express-async-handler');
const WorkLocation = require('../models/WorkLocation');
const EmployeeProfile = require('../models/EmployeeProfile');

// GET /api/work-locations — all locations with how many employees are assigned.
const listLocations = asyncHandler(async (req, res) => {
  const locations = await WorkLocation.find().sort({ name: 1 }).lean();
  const counts = await EmployeeProfile.aggregate([
    { $match: { workLocationRef: { $ne: null } } },
    { $group: { _id: '$workLocationRef', n: { $sum: 1 } } },
  ]);
  const byId = {};
  counts.forEach((c) => { byId[String(c._id)] = c.n; });
  res.json({
    count: locations.length,
    locations: locations.map((l) => ({ ...l, assignedCount: byId[String(l._id)] || 0 })),
  });
});

// POST /api/work-locations
const createLocation = asyncHandler(async (req, res) => {
  const { name, lat, lng, radiusM, active } = req.body;
  if (!name || !name.trim()) {
    res.status(400);
    throw new Error('name is required');
  }
  const exists = await WorkLocation.findOne({ name: name.trim() });
  if (exists) {
    res.status(409);
    throw new Error('A work location with that name already exists');
  }
  const location = await WorkLocation.create({
    name: name.trim(),
    lat: lat != null && lat !== '' ? Number(lat) : undefined,
    lng: lng != null && lng !== '' ? Number(lng) : undefined,
    radiusM: radiusM != null && radiusM !== '' ? Math.max(0, Number(radiusM)) : undefined,
    active: active !== false,
    createdBy: req.user._id,
  });
  res.status(201).json({ location });
});

// PUT /api/work-locations/:id
const updateLocation = asyncHandler(async (req, res) => {
  const location = await WorkLocation.findById(req.params.id);
  if (!location) {
    res.status(404);
    throw new Error('Work location not found');
  }
  const { name, lat, lng, radiusM, active } = req.body;
  if (name !== undefined) location.name = name.trim();
  if (lat !== undefined) location.lat = lat === '' || lat == null ? undefined : Number(lat);
  if (lng !== undefined) location.lng = lng === '' || lng == null ? undefined : Number(lng);
  if (radiusM !== undefined) location.radiusM = Math.max(0, Number(radiusM) || 0);
  if (active !== undefined) location.active = !!active;
  await location.save();
  res.json({ location });
});

// DELETE /api/work-locations/:id — blocked while employees are still assigned.
const deleteLocation = asyncHandler(async (req, res) => {
  const location = await WorkLocation.findById(req.params.id);
  if (!location) {
    res.status(404);
    throw new Error('Work location not found');
  }
  const assigned = await EmployeeProfile.countDocuments({ workLocationRef: location._id });
  if (assigned > 0) {
    res.status(400);
    throw new Error(`${assigned} employee(s) are still assigned to this location. Reassign them before deleting.`);
  }
  await location.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// GET /api/work-locations/:id/employees — profiles assigned here.
const listAssigned = asyncHandler(async (req, res) => {
  const employees = await EmployeeProfile.find({ workLocationRef: req.params.id })
    .select('employeeCode designation user')
    .populate('user', 'firstName lastName email')
    .sort({ employeeCode: 1 })
    .lean();
  res.json({ count: employees.length, employees });
});

// POST /api/work-locations/:id/assign  { employeeIds: [profileId] }
const assignEmployees = asyncHandler(async (req, res) => {
  const location = await WorkLocation.findById(req.params.id);
  if (!location) {
    res.status(404);
    throw new Error('Work location not found');
  }
  const ids = [...new Set((req.body.employeeIds || []).map(String))].filter(Boolean);
  const result = await EmployeeProfile.updateMany(
    { _id: { $in: ids } },
    { $set: { workLocationRef: location._id } }
  );
  res.json({ assigned: result.modifiedCount ?? ids.length });
});

// POST /api/work-locations/:id/unassign  { employeeIds: [profileId] }
const unassignEmployees = asyncHandler(async (req, res) => {
  const ids = [...new Set((req.body.employeeIds || []).map(String))].filter(Boolean);
  const result = await EmployeeProfile.updateMany(
    { _id: { $in: ids }, workLocationRef: req.params.id },
    { $unset: { workLocationRef: '' } }
  );
  res.json({ unassigned: result.modifiedCount ?? 0 });
});

module.exports = {
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  listAssigned,
  assignEmployees,
  unassignEmployees,
};
