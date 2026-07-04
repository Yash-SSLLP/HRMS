const OrgMaster = require('../models/OrgMaster');

// Register a value into the OrgMaster list if it isn't there yet, so anything
// actually used on an employee (e.g. a designation set via import or an older
// form) shows up under Admin → Org Masters. Idempotent (unique index on
// {kind,name}); best-effort — never throws into the caller.
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

const ensureDesignation = (name) => ensureMaster('Designation', name);

module.exports = { ensureMaster, ensureDesignation };
