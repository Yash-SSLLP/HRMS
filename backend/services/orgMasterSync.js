/**
 * Org-master auto-registration helpers.
 *
 * Keeps the admin-managed lookup lists (OrgMaster designations/grades/locations,
 * Department names) in sync with values that arrive on employees through side
 * doors — Excel import, older forms, recruitment conversion — so those values
 * still appear under Admin → Org Masters / Departments. All helpers are
 * idempotent and best-effort (they swallow duplicate-key races and never throw
 * into the caller).
 *
 * Each helper answers whether it ACTUALLY created the entry, because the Excel
 * import needs to tell "this designation is new, flag it for review" from "this
 * one already existed, say nothing". Callers that don't care ignore the return.
 *
 * External systems: none. Writes to the OrgMaster and Department collections.
 */
const OrgMaster = require('../models/OrgMaster');

/**
 * Register a value into the OrgMaster list if it isn't there yet, so anything
 * actually used on an employee (e.g. a designation set via import or an older
 * form) shows up under Admin → Org Masters. Idempotent (unique index on
 * {kind,name}); best-effort — never throws into the caller.
 * @param {string} kind - OrgMaster category, e.g. 'Designation'.
 * @param {string} name - The value to ensure exists; trimmed, blanks ignored.
 * @returns {Promise<boolean>} true when this call created the entry.
 * @sideEffects Upserts a document into the OrgMaster collection.
 */
async function ensureMaster(kind, name) {
  const clean = (name || '').trim();
  if (!clean) return false;
  try {
    const res = await OrgMaster.updateOne(
      { kind, name: clean },
      { $setOnInsert: { kind, name: clean, isActive: true } },
      { upsert: true }
    );
    // upsertedCount is 1 only on a genuine insert, which is exactly the
    // "this value is new to the company" signal the importer flags on.
    return res.upsertedCount === 1;
  } catch (err) {
    // 11000 = duplicate key from a race; harmless (the value already exists),
    // and NOT a creation — the other writer made it.
    if (err.code !== 11000) console.error(`ensureMaster(${kind}) failed:`, err.message);
    return false;
  }
}

/**
 * Convenience wrapper: register a designation into OrgMaster.
 * @param {string} name - Designation to ensure exists.
 * @returns {Promise<boolean>} true when this call created it.
 * @sideEffects Upserts into the OrgMaster collection.
 */
const ensureDesignation = (name) => ensureMaster('Designation', name);

/**
 * Register a grade band into OrgMaster.
 * @param {string} name - Grade to ensure exists.
 * @returns {Promise<boolean>} true when this call created it.
 * @sideEffects Upserts into the OrgMaster collection.
 */
const ensureGrade = (name) => ensureMaster('Grade', name);

/**
 * Register a work-location name into the WORK LOCATIONS register.
 *
 * This used to add an OrgMaster row of kind 'Location' — a second list of the
 * same places, which nothing offered as options and nobody could give a
 * geofence. It now creates the real site instead, with its name and nothing
 * else: a spreadsheet cell cannot supply coordinates or a radius, so the site
 * lands WITHOUT a geofence and the import flags it, which is the signal for
 * somebody to open Work Locations and finish it. A site with no coordinates
 * simply has no geofence to check against (see utils/resolveGeofence), so it is
 * safe to create in that state — it never silently narrows where anyone may
 * punch.
 * @param {string} name - Location name to ensure exists.
 * @returns {Promise<boolean>} true when this call created it.
 * @sideEffects Upserts into the WorkLocation collection.
 */
async function ensureWorkLocation(name) {
  const clean = (name || '').trim();
  if (!clean) return false;
  try {
    const WorkLocation = require('../models/WorkLocation');
    const res = await WorkLocation.updateOne(
      { name: clean },
      { $setOnInsert: { name: clean, active: true } },
      { upsert: true }
    );
    return res.upsertedCount === 1;
  } catch (err) {
    if (err.code !== 11000) console.error('ensureWorkLocation failed:', err.message);
    return false;
  }
}

/**
 * Register a department name into the managed Department list if missing, so any
 * department set on an employee (via the form, import, or recruitment conversion)
 * shows up under Admin → Departments. Idempotent (unique index on name).
 * @param {string} name - Department name to ensure exists; trimmed, blanks ignored.
 * @returns {Promise<boolean>} true when this call created it.
 * @sideEffects Upserts a document into the Department collection.
 */
async function ensureDepartment(name) {
  const clean = (name || '').trim();
  if (!clean) return false;
  try {
    const Department = require('../models/Department');
    const res = await Department.updateOne(
      { name: clean },
      { $setOnInsert: { name: clean, isActive: true } },
      { upsert: true }
    );
    return res.upsertedCount === 1;
  } catch (err) {
    if (err.code !== 11000) console.error('ensureDepartment failed:', err.message);
    return false;
  }
}

module.exports = {
  ensureMaster, ensureDesignation, ensureGrade, ensureWorkLocation, ensureDepartment,
};
