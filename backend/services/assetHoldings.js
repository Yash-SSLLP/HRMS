/**
 * Asset holdings — "what company property is this person carrying?"
 *
 * Asked from three places: the assets register, the exit flow (the popup that
 * lists what a leaver still has) and the no-dues inbox (so the manager
 * collecting it knows what to ask for). One module, so all three answer it the
 * same way and return an item the same way.
 */
const Asset = require('../models/Asset');
const AssetAssignment = require('../models/AssetAssignment');

/** Asset fields a holding carries when shown anywhere. */
const HOLDING_ASSET_FIELDS = 'name category assetTag status serialNumber assignedTo';

/**
 * The asset created before the 2026-09-23 rework was a single unit whose serial
 * lived on the Asset. Surface it on that unit's holding so the one legacy row
 * reads like every new one.
 * @param {Object} h - a lean holding with `asset` populated
 * @returns {Object}
 */
function withLegacySerial(h) {
  const a = h && h.asset;
  if (h && !h.serialNumber && a && a.serialNumber && a.assignedTo && String(a.assignedTo) === String(h.employee?._id || h.employee)) {
    return { ...h, serialNumber: a.serialNumber };
  }
  return h;
}

/**
 * Items one or more people hold right now, newest issue first.
 * @param {string|string[]} userIds - User id(s)
 * @returns {Promise<Object[]>} lean holdings with `asset` populated
 */
async function openHoldingsFor(userIds) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length) return [];
  const rows = await AssetAssignment.find({ employee: { $in: ids }, returnedAt: null })
    .populate('asset', HOLDING_ASSET_FIELDS)
    .sort({ assignedAt: -1, createdAt: -1 })
    .lean();
  return rows.map(withLegacySerial);
}

const badRequest = (message, status = 400) => Object.assign(new Error(message), { status });

/**
 * Take an item back. The one place a holding is closed, whether from the assets
 * register or from an exit.
 * @param {import('mongoose').Document} holding - an AssetAssignment document
 * @param {Object} opts
 * @param {string} opts.by - User id recording the return
 * @param {string} [opts.date] - return date (defaults to now)
 * @param {string} [opts.note] - condition on hand-back
 * @param {string} [opts.exitId] - the exit it was recovered through, if any
 * @returns {Promise<import('mongoose').Document>}
 * @throws {Error} with `.status` — 409 already returned, 400 bad date
 */
async function returnHolding(holding, { by, date, note, exitId } = {}) {
  if (holding.returnedAt) throw badRequest('This item has already been returned.', 409);
  const when = date ? new Date(date) : new Date();
  if (Number.isNaN(when.getTime())) throw badRequest('That return date is not a valid date.');
  // Compared by calendar day: an item issued at 10:30 today may be handed back
  // "today", which a date input sends as midnight.
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  if (day(when) < day(holding.assignedAt)) {
    throw badRequest('The return date is before the item was issued.');
  }
  // A day and a half of slack: "today" in India is still "yesterday" on a UTC
  // server for the first five and a half hours of the day.
  if (when.getTime() > Date.now() + 36 * 3600 * 1000) {
    throw badRequest('The return date is in the future.');
  }
  holding.returnedAt = when;
  holding.returnedBy = by;
  const cleaned = String(note || '').trim().slice(0, 500);
  holding.returnNote = cleaned || undefined;
  if (exitId) holding.returnedViaExit = exitId;
  // However the item came back — HR accepting the employee's request, a plain
  // Take back on the Assets page, or the exit popup — a request that was still
  // waiting is answered by it, so it cannot sit in the queue for an item that
  // is already on the shelf.
  if (holding.returnRequest?.status === 'Pending') {
    holding.returnRequest.status = 'Accepted';
    holding.returnRequest.decidedAt = new Date();
    holding.returnRequest.decidedBy = by;
  }
  await holding.save();
  await clearLegacyHolder(holding);
  return holding;
}

/**
 * The legacy single-unit asset also records its holder on itself; once that
 * holding closes (returned or deleted), clear it so the unit reads as free.
 * @param {Object} holding
 */
async function clearLegacyHolder(holding) {
  const res = await Asset.updateOne(
    { _id: holding.asset?._id || holding.asset, assignedTo: holding.employee?._id || holding.employee },
    { $unset: { assignedTo: 1, assignedAt: 1 } }
  );
  if (res.modifiedCount) {
    await Asset.updateOne({ _id: holding.asset?._id || holding.asset, status: 'Assigned' }, { $set: { status: 'Available' } });
  }
}

module.exports = {
  HOLDING_ASSET_FIELDS, openHoldingsFor, returnHolding, clearLegacyHolder, withLegacySerial, badRequest,
};
