/**
 * Work-location controller — manages named work sites (name, lat/lng, geofence
 * radiusM) used for attendance check-in geofencing, and the assignment of
 * EmployeeProfiles to those sites via workLocationRef.
 */
const asyncHandler = require('express-async-handler');
const WorkLocation = require('../models/WorkLocation');
const EmployeeProfile = require('../models/EmployeeProfile');

/**
 * List all work locations, each with its assigned-employee count.
 * @route GET /api/work-locations
 * @returns {{count: number, locations: Object[]}} locations with assignedCount
 */
// GET /api/work-locations — all locations with how many employees are assigned.
const listLocations = asyncHandler(async (req, res) => {
  const locations = await WorkLocation.find().sort({ name: 1 }).lean();
  const counts = await EmployeeProfile.aggregate([
    { $match: { workLocationRef: { $ne: null } } },
    { $group: { _id: '$workLocationRef', n: { $sum: 1 } } },
  ]);
  // Map location id -> headcount to attach counts without extra queries
  const byId = {};
  counts.forEach((c) => { byId[String(c._id)] = c.n; });
  res.json({
    count: locations.length,
    locations: locations.map((l) => ({ ...l, assignedCount: byId[String(l._id)] || 0 })),
  });
});

/**
 * Create a work location (unique name enforced).
 * @route POST /api/work-locations
 * @param {string} req.body.name - required, trimmed, unique
 * @param {number} [req.body.lat]
 * @param {number} [req.body.lng]
 * @param {number} [req.body.radiusM] - geofence radius in metres (clamped >= 0)
 * @param {boolean} [req.body.active=true]
 * @returns {{location: Object}} the created location (201); 409 if name exists
 */
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

/**
 * Update a work location's fields (partial); empty lat/lng clears the coordinate.
 * @route PUT /api/work-locations/:id
 * @param {string} req.params.id - location id
 * @param {Object} req.body - name/lat/lng/radiusM/active
 * @returns {{location: Object}} the updated location
 */
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

/**
 * Delete a work location, but only if no employees are still assigned to it.
 * @route DELETE /api/work-locations/:id
 * @param {string} req.params.id - location id
 * @returns {{id: string, deleted: boolean}}; 400 if employees remain assigned
 */
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

/**
 * List employee profiles assigned to a given work location.
 * @route GET /api/work-locations/:id/employees
 * @param {string} req.params.id - location id
 * @returns {{count: number, employees: Object[]}} profiles with populated user
 */
// GET /api/work-locations/:id/employees — profiles assigned here.
const listAssigned = asyncHandler(async (req, res) => {
  const employees = await EmployeeProfile.find({ workLocationRef: req.params.id })
    .select('employeeCode designation user')
    .populate('user', 'firstName lastName email')
    .sort({ employeeCode: 1 })
    .lean();
  res.json({ count: employees.length, employees });
});

/**
 * Assign employee profiles to this work location (sets workLocationRef).
 * @route POST /api/work-locations/:id/assign
 * @param {string} req.params.id - location id
 * @param {string[]} req.body.employeeIds - profile ids (deduped)
 * @returns {{assigned: number}} count of profiles updated
 */
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

/**
 * Unassign employee profiles from this work location (unsets workLocationRef).
 * @route POST /api/work-locations/:id/unassign
 * @param {string} req.params.id - location id
 * @param {string[]} req.body.employeeIds - profile ids (deduped)
 * @returns {{unassigned: number}} count of profiles updated
 */
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
