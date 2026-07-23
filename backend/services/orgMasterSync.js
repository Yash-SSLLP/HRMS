/**
 * Org-master auto-registration helpers.
 *
 * Keeps the admin-managed lookup lists (OrgMaster designations, Department names)
 * in sync with values that arrive on employees through side doors — Excel import,
 * older forms, recruitment conversion — so those values still appear under
 * Admin → Org Masters / Departments. All helpers are idempotent and best-effort
 * (they swallow duplicate-key races and never throw into the caller).
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
 * @returns {Promise<void>}
 * @sideEffects Upserts a document into the OrgMaster collection.
 */
async function ensureMaster(kind, name) {
  const clean = (name || '').trim();
  if (!clean) return;
  try {
    await OrgMaster.updateOne(
      { kind, name: clean },
      { $setOnInsert: { kind, name: clean, isActive: true } },
      { upsert: true }
    );
  } catch (err) {
    // 11000 = duplicate key from a race; harmless (the value already exists).
    if (err.code !== 11000) console.error(`ensureMaster(${kind}) failed:`, err.message);
  }
}

/**
 * Convenience wrapper: register a designation into OrgMaster.
 * @param {string} name - Designation to ensure exists.
 * @returns {Promise<void>}
 * @sideEffects Upserts into the OrgMaster collection.
 */
const ensureDesignation = (name) => ensureMaster('Designation', name);

/**
 * Register a department name into the managed Department list if missing, so any
 * department set on an employee (via the form, import, or recruitment conversion)
 * shows up under Admin → Departments. Idempotent (unique index on name).
 * @param {string} name - Department name to ensure exists; trimmed, blanks ignored.
 * @returns {Promise<void>}
 * @sideEffects Upserts a document into the Department collection.
 */
async function ensureDepartment(name) {
  const clean = (name || '').trim();
  if (!clean) return;
  try {
    const Department = require('../models/Department');
    await Department.updateOne(
      { name: clean },
      { $setOnInsert: { name: clean, isActive: true } },
      { upsert: true }
    );
  } catch (err) {
    if (err.code !== 11000) console.error('ensureDepartment failed:', err.message);
  }
}

module.exports = { ensureMaster, ensureDesignation, ensureDepartment };
