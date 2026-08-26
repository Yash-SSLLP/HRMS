/**
 * Work-location controller — manages named work sites (name, lat/lng, geofence
 * radiusM) used for attendance check-in geofencing, and the assignment of
 * EmployeeProfiles to those sites via workLocationRef.
 */
const asyncHandler = require('express-async-handler');
const WorkLocation = require('../models/WorkLocation');
const EmployeeProfile = require('../models/EmployeeProfile');
// Company wall: WorkLocation carries its own `company`; assigned-employee
// listings are EmployeeProfile queries.
const { viewerCompanyScope, employeeProfileScope, allowedEmployeeIds } = require('../utils/employeeScope');

/**
 * List all work locations, each with its assigned-employee count.
 * @route GET /api/work-locations
 * @returns {{count: number, locations: Object[]}} locations with assignedCount
 */
// GET /api/work-locations — all locations with how many employees are assigned.
const listLocations = asyncHandler(async (req, res) => {
  // Company wall: a walled viewer sees only their own companies' sites, plus
  // company-less sites — those are shared and belong to nobody else's company.
  const scope = viewerCompanyScope(req);
  const siteFilter = scope
    ? { $or: [{ company: { $in: scope.ids } }, { company: null }] }
    : {};
  const locations = await WorkLocation.find(siteFilter)
    .populate('company', 'name code')
    .sort({ name: 1 })
    .lean();
  // Headcounts likewise only count in-scope employees. allowedEmployeeIds gives
  // real ObjectIds — aggregate() does no ref casting, so the profile-scope
  // filter fragment (string ids) can't be $match-ed directly.
  const empIds = await allowedEmployeeIds(req);
  const counts = await EmployeeProfile.aggregate([
    { $match: { workLocationRef: { $ne: null }, ...(empIds ? { _id: { $in: empIds } } : {}) } },
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
  const { name, company, lat, lng, radiusM, active } = req.body;
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
    company: company || undefined,
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
  const { name, company, lat, lng, radiusM, active, acknowledgeStranded } = req.body;
  if (name !== undefined) location.name = name.trim();
  if (company !== undefined) {
    const newCompany = company || null;
    const changing = String(location.company || '') !== String(newCompany || '');
    // Retagging a site to a different company can strand employees already
    // assigned here who belong to another company. Don't silently do it — return
    // a structured 409 the client turns into a warning, and only proceed once the
    // admin acknowledges. Moving TO "no company" (a shared site) strands nobody.
    if (changing && newCompany && acknowledgeStranded !== true) {
      const assigned = await EmployeeProfile.find({ workLocationRef: location._id })
        .select('company employeeCode user')
        .populate('user', 'firstName lastName')
        .lean();
      const stranded = assigned.filter((p) => p.company && String(p.company) !== String(newCompany));
      if (stranded.length) {
        res.status(409);
        return res.json({
          code: 'STRANDED_EMPLOYEES',
          count: stranded.length,
          message: `${stranded.length} employee(s) assigned to this site belong to a different company. Changing its company leaves them at a site outside their own company.`,
          employees: stranded.slice(0, 20).map((p) => ({
            employeeCode: p.employeeCode || '',
            name: `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim(),
          })),
        });
      }
    }
    location.company = newCompany || undefined;
  }
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
  // Company wall: on a shared (company-less) site, a walled viewer still only
  // sees their own company's people assigned there.
  const employees = await EmployeeProfile.find({ workLocationRef: req.params.id, ...employeeProfileScope(req) })
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
  // A company-tagged site only accepts employees of that company (or company-less
  // employees). This is a new assignment, so any mismatch is a new one — reject
  // the batch with a clear message rather than silently creating a bad pairing.
  if (location.company) {
    const targets = await EmployeeProfile.find({ _id: { $in: ids } }).select('company');
    const mismatched = targets.filter((p) => p.company && String(p.company) !== String(location.company));
    if (mismatched.length) {
      res.status(400);
      throw new Error(`${mismatched.length} of the selected employee(s) belong to a different company than this site. Assign only employees in the site's company, or company-less employees.`);
    }
  }
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
