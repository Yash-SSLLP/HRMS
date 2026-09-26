/**
 * Asset controller — asset KINDS (Asset: "Laptop", "Phone") and the people who
 * hold one (AssetAssignment: Priya's "MacBook i5", Arjun's "Asus i7, 6GB RAM,
 * 1TB ROM"). HR/Admin create kinds, issue them to any number of employees each
 * with their own details — or several kinds to one employee at once, the
 * employee-wise way in — edit and take items back, keeping the full holding
 * history; employees list what they currently hold. Both ways of issuing write
 * the same AssetAssignment rows, so the asset-wise and employee-wise views are
 * two readings of one register and can never disagree.
 *
 * Reworked 2026-09-23 from one-unit-one-holder. The single-unit
 * `PATCH /:id/assign` endpoint survives only for app builds installed before
 * the rework — the current web page and app use the endpoints below it.
 */
const asyncHandler = require('express-async-handler');
const Asset = require('../models/Asset');
const { ASSET_STATUS } = require('../models/Asset');
const AssetAssignment = require('../models/AssetAssignment');
const { scopeUserField, scopeUserFilter, cannotSeeUser } = require('../utils/employeeScope');
const {
  HOLDING_ASSET_FIELDS, openHoldingsFor, returnHolding, clearLegacyHolder, withLegacySerial,
} = require('../services/assetHoldings');
const { notify, notifyMany } = require('../services/notify');
const { usersHoldingAny, scopeRecipientsToCompany } = require('../services/audience');

const USER_FIELDS = 'firstName lastName email role';

// The fields a client may set — never createdBy or the legacy holder fields,
// which `Object.assign(asset, req.body)` used to let through.
const ASSET_INPUT = ['name', 'category', 'assetTag', 'status', 'notes'];
const pick = (body, keys) => {
  const out = {};
  for (const k of keys) {
    if (body?.[k] === undefined) continue;
    out[k] = typeof body[k] === 'string' ? body[k].trim() : body[k];
  }
  return out;
};

/** Rethrow a service error with its HTTP status. */
const fail = (res, err) => {
  res.status(err.status || 400);
  throw err;
};

/** Load a holding the caller may act on, or 404. */
async function holdingInScope(req, res) {
  const holding = await AssetAssignment.findById(req.params.aid);
  // Company wall: a holding of somebody outside the viewer's scope is
  // indistinguishable from a missing one.
  if (!holding || (await cannotSeeUser(req, holding.employee))) {
    res.status(404);
    throw new Error('Assignment not found');
  }
  return holding;
}

// "Laptop — MacBook i5", the way a person would say which item they mean.
const itemLabel = (h) => [h.asset?.name || 'Asset', h.details].filter(Boolean).join(' — ');
const personName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();
const clip = (v, max = 500) => String(v || '').trim().slice(0, max);

// Where each side lands. The clients rewrite the admin path per portal (a
// standalone Assets grant holder has no admin portal — see resolveLink in
// components/Layout.jsx and ADMIN_PATH_SCREENS in the app).
const DECIDER_LINK = '/admin/assets?tab=returns';
const HOLDER_LINK = '/employee/assets';

const populateHolding = (id) => AssetAssignment.findById(id)
  .populate('asset', HOLDING_ASSET_FIELDS)
  .populate('employee', USER_FIELDS)
  .lean()
  .then(withLegacySerial);

// ===== Asset kinds (HR/Admin) =====

/**
 * List asset kinds, each with the people currently holding one.
 * @route GET /api/assets  (assets.manage)
 * @param {string} [req.query.status]
 * @param {string} [req.query.category]
 * @returns {{count: number, assets: Object[]}} each with `holdings` (open,
 *   employee populated, inside the viewer's company scope) and `holderCount`
 */
const listAssets = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.category) filter.category = req.query.category;
  const assets = await Asset.find(filter).sort({ name: 1, createdAt: -1 }).lean();

  const hFilter = { asset: { $in: assets.map((a) => a._id) }, returnedAt: null };
  await scopeUserField(req, hFilter);
  const holdings = await AssetAssignment.find(hFilter)
    .populate('employee', USER_FIELDS)
    .sort({ assignedAt: -1, createdAt: -1 })
    .lean();
  const byAsset = new Map();
  for (const h of holdings) {
    const k = String(h.asset);
    if (!byAsset.has(k)) byAsset.set(k, []);
    byAsset.get(k).push(h);
  }
  const out = assets.map((a) => {
    const held = (byAsset.get(String(a._id)) || []).map((h) => withLegacySerial({ ...h, asset: a }));
    // `asset` is the kind itself here — send just its id on each holding.
    return { ...a, holdings: held.map((h) => ({ ...h, asset: a._id })), holderCount: held.length };
  });
  res.json({ count: out.length, assets: out });
});

/**
 * Create an asset kind. The code is optional — a blank one is minted.
 * @route POST /api/assets  (assets.manage)
 * @param {string} req.body.name - required, e.g. "Laptop"
 * @param {string} [req.body.assetTag] - unique short code
 * @param {string} [req.body.category] / [req.body.status] / [req.body.notes]
 * @returns {{asset: Object}} (201); 409 if the code exists
 */
const createAsset = asyncHandler(async (req, res) => {
  const data = pick(req.body, ASSET_INPUT);
  if (!data.name) {
    res.status(400);
    throw new Error('Give the asset a name, e.g. "Laptop".');
  }
  if (data.assetTag) {
    data.assetTag = data.assetTag.toUpperCase();
    if (await Asset.exists({ assetTag: data.assetTag })) {
      res.status(409);
      throw new Error('An asset with that code already exists');
    }
  } else {
    delete data.assetTag; // minted on validate
  }
  const asset = await Asset.create({ ...data, createdBy: req.user._id });
  res.status(201).json({ asset });
});

/**
 * Update an asset kind.
 * @route PUT /api/assets/:id  (assets.manage)
 * @returns {{asset: Object}}; 409 if the new code is taken
 */
const updateAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  const data = pick(req.body, ASSET_INPUT);
  if (data.assetTag !== undefined) {
    data.assetTag = String(data.assetTag || '').toUpperCase();
    // Clearing the code is not allowed — the kind keeps the one it has.
    if (!data.assetTag) delete data.assetTag;
    else if (data.assetTag !== asset.assetTag && (await Asset.exists({ assetTag: data.assetTag }))) {
      res.status(409);
      throw new Error('An asset with that code already exists');
    }
  }
  if (data.name === '') delete data.name;
  Object.assign(asset, data);
  await asset.save();
  res.json({ asset });
});

/**
 * Delete an asset kind and its history — refused while anybody still holds one,
 * because deleting it would erase the only record that they owe it back.
 * @route DELETE /api/assets/:id  (assets.manage)
 * @returns {{id: string, deleted: boolean}}; 409 while held
 */
const deleteAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  // Counted across EVERY company, not only the viewer's: a holding the viewer
  // cannot see is still a person who owes the item back.
  const held = await AssetAssignment.countDocuments({ asset: asset._id, returnedAt: null });
  if (held) {
    res.status(409);
    throw new Error(`${held} ${held === 1 ? 'person still holds' : 'people still hold'} this asset — take ${held === 1 ? 'it' : 'them'} back first.`);
  }
  await AssetAssignment.deleteMany({ asset: asset._id });
  await asset.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Holdings (HR/Admin) =====

/**
 * One holding row from a request row — the fields both ways of issuing accept,
 * cleaned the same way. Shared by issueAsset (one asset → many people) and
 * issueToEmployee (many assets → one person), which is what keeps the two views
 * in step: they write the very same AssetAssignment rows.
 * @param {Object} r - the request row
 * @param {number} i - its index, for "Row 2: …" messages
 * @param {{assetId: *, userId: *, body: Object, by: *}} ctx
 * @returns {Object} the document to insert
 * @throws {Error} with `.status` 400 on a bad date
 */
function holdingDoc(r, i, { assetId, userId, body, by }) {
  const dateIn = r.date || body.date;
  const when = dateIn ? new Date(dateIn) : new Date();
  if (Number.isNaN(when.getTime())) {
    throw Object.assign(new Error(`Row ${i + 1}: that date is not valid.`), { status: 400 });
  }
  return {
    asset: assetId,
    employee: userId,
    details: String(r.details || '').trim().slice(0, 300) || undefined,
    serialNumber: String(r.serialNumber || '').trim().slice(0, 100) || undefined,
    unitTag: String(r.unitTag || '').trim().slice(0, 60) || undefined,
    assignedAt: when,
    assignedBy: by,
    note: String(r.note ?? body.note ?? '').trim().slice(0, 500) || undefined,
  };
}

/** Freshly inserted holdings, populated the way every holding is shown. */
const populatedHoldings = (created) => AssetAssignment.find({ _id: { $in: created.map((d) => d._id) } })
  .populate('asset', HOLDING_ASSET_FIELDS)
  .populate('employee', USER_FIELDS)
  .sort({ createdAt: 1 })
  .lean();

/**
 * Issue an asset kind to one or more employees, each with their own item.
 * @route POST /api/assets/:id/assignments  (assets.manage)
 * @param {Object[]} req.body.assignments - [{ userId, details?, serialNumber?,
 *   unitTag?, date?, note? }]; a single object in the body works too
 * @param {string} [req.body.date] / [req.body.note] - defaults for every row
 * @returns {{assignments: Object[]}} (201) with asset + employee populated
 */
const issueAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  if (asset.status === 'Retired' || asset.status === 'InRepair') {
    res.status(400);
    throw new Error(`"${asset.name}" is marked ${asset.status === 'Retired' ? 'Retired' : 'In repair'} — change its status before issuing it.`);
  }
  const rows = Array.isArray(req.body?.assignments) ? req.body.assignments : [req.body || {}];
  if (!rows.length) {
    res.status(400);
    throw new Error('Pick at least one employee.');
  }
  const docs = [];
  for (const [i, r] of rows.entries()) {
    const userId = r.userId;
    if (!userId) {
      res.status(400);
      throw new Error(`Row ${i + 1}: pick an employee.`);
    }
    // Company wall: an admin may only issue to people inside their scope.
    if (await cannotSeeUser(req, userId)) {
      res.status(404);
      throw new Error('Employee not found');
    }
    try {
      docs.push(holdingDoc(r, i, { assetId: asset._id, userId, body: req.body, by: req.user._id }));
    } catch (err) {
      fail(res, err);
    }
  }
  const created = await AssetAssignment.insertMany(docs);
  res.status(201).json({ assignments: await populatedHoldings(created) });
});

/**
 * Issue SEVERAL assets to ONE employee at once — a joiner's laptop, phone, SIM
 * and chair in one go (user request 2026-09-24). The employee-wise twin of
 * issueAsset above, which issues one asset to many people.
 *
 * Both write the same AssetAssignment rows, so there is nothing to keep in sync:
 * an item issued from either side is on the asset's card, in the employee's
 * list, in the register and on the employee's own My Assets, the moment it is
 * saved. The same asset twice (two SIMs) is allowed, as it is from the other side.
 * @route POST /api/assets/employees/:userId/assignments  (assets.manage)
 * @param {string} req.params.userId - the employee's User id
 * @param {Object[]} req.body.assignments - [{ assetId, details?, serialNumber?,
 *   unitTag?, date?, note? }], one row per item
 * @param {string} [req.body.date] / [req.body.note] - defaults for every row
 * @returns {{assignments: Object[]}} (201) with asset + employee populated
 */
const issueToEmployee = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const User = require('../models/User');
  // Company wall first, so another company's employee is indistinguishable from
  // one who does not exist.
  if (!userId || (await cannotSeeUser(req, userId)) || !(await User.exists({ _id: userId }))) {
    res.status(404);
    throw new Error('Employee not found');
  }
  const rows = Array.isArray(req.body?.assignments) ? req.body.assignments : [];
  if (!rows.length) {
    res.status(400);
    throw new Error('Add at least one asset.');
  }
  const kinds = await Asset.find({
    _id: { $in: [...new Set(rows.map((r) => String(r.assetId || '')).filter(Boolean))] },
  }).select('name status');
  const kindById = new Map(kinds.map((k) => [String(k._id), k]));

  const docs = [];
  for (const [i, r] of rows.entries()) {
    if (!r.assetId) {
      res.status(400);
      throw new Error(`Row ${i + 1}: pick an asset.`);
    }
    const kind = kindById.get(String(r.assetId));
    if (!kind) {
      res.status(404);
      throw new Error(`Row ${i + 1}: that asset no longer exists.`);
    }
    // Same rule as issuing from the asset's side: people who already hold one
    // keep it, but a Retired or In-repair kind is not handed out.
    if (kind.status === 'Retired' || kind.status === 'InRepair') {
      res.status(400);
      throw new Error(`Row ${i + 1}: "${kind.name}" is marked ${kind.status === 'Retired' ? 'Retired' : 'In repair'} — change its status before issuing it.`);
    }
    try {
      docs.push(holdingDoc(r, i, { assetId: kind._id, userId, body: req.body, by: req.user._id }));
    } catch (err) {
      fail(res, err);
    }
  }
  const created = await AssetAssignment.insertMany(docs);
  res.status(201).json({ assignments: await populatedHoldings(created) });
});

/**
 * Correct a holding — the details, serial, sticker, issue date or note.
 * @route PUT /api/assets/assignments/:aid  (assets.manage)
 * @returns {{assignment: Object}}
 */
const updateAssignment = asyncHandler(async (req, res) => {
  const holding = await holdingInScope(req, res);
  const b = req.body || {};
  if (b.details !== undefined) holding.details = String(b.details || '').trim().slice(0, 300) || undefined;
  if (b.serialNumber !== undefined) holding.serialNumber = String(b.serialNumber || '').trim().slice(0, 100) || undefined;
  if (b.unitTag !== undefined) holding.unitTag = String(b.unitTag || '').trim().slice(0, 60) || undefined;
  if (b.note !== undefined) holding.note = String(b.note || '').trim().slice(0, 500) || undefined;
  if (b.date) {
    const when = new Date(b.date);
    if (Number.isNaN(when.getTime())) {
      res.status(400);
      throw new Error('That date is not valid.');
    }
    holding.assignedAt = when;
  }
  // A returned item can still have its record corrected, including the note
  // about its condition.
  if (holding.returnedAt && b.returnNote !== undefined) {
    holding.returnNote = String(b.returnNote || '').trim().slice(0, 500) || undefined;
  }
  await holding.save();
  res.json({ assignment: await populateHolding(holding._id) });
});

/**
 * Take an item back.
 * @route PATCH /api/assets/assignments/:aid/return  (assets.manage)
 * @param {string} [req.body.date] - return date (defaults to now)
 * @param {string} [req.body.note] - condition on hand-back
 * @returns {{assignment: Object}}; 409 if already returned
 */
const returnAssignment = asyncHandler(async (req, res) => {
  const holding = await holdingInScope(req, res);
  try {
    await returnHolding(holding, { by: req.user._id, date: req.body?.date, note: req.body?.note });
  } catch (err) {
    fail(res, err);
  }
  res.json({ assignment: await populateHolding(holding._id) });
});

/**
 * Remove a holding recorded by mistake (wrong person, wrong kind). Returning
 * is the normal way out; this erases the row from the history.
 * @route DELETE /api/assets/assignments/:aid  (assets.manage)
 * @returns {{id: string, deleted: boolean}}
 */
const deleteAssignment = asyncHandler(async (req, res) => {
  const holding = await holdingInScope(req, res);
  await holding.deleteOne();
  await clearLegacyHolder(holding);
  res.json({ id: req.params.aid, deleted: true });
});

/**
 * LEGACY single-unit assign/return, kept for app builds installed before the
 * 2026-09-23 rework (the current admin screen no longer calls it; remove it
 * once those builds are gone).
 * With a userId it issues the kind to that person (one more holder); with
 * userId null it takes the item back — which is only unambiguous while exactly
 * one person holds this kind, or when `assignmentId` names the holding.
 * @route PATCH /api/assets/:id/assign  (assets.manage)
 * @param {string|null} req.body.userId
 * @param {string} [req.body.assignmentId] - which holding to close on a return
 * @param {string} [req.body.date] / [req.body.note]
 * @returns {{asset: Object}}
 */
const assignAsset = asyncHandler(async (req, res) => {
  const asset = await Asset.findById(req.params.id);
  if (!asset) {
    res.status(404);
    throw new Error('Asset not found');
  }
  const { userId, note, date, assignmentId } = req.body || {};
  if (userId) {
    if (await cannotSeeUser(req, userId)) {
      res.status(404);
      throw new Error('Employee not found');
    }
    await AssetAssignment.create({
      asset: asset._id,
      employee: userId,
      assignedAt: date ? new Date(date) : new Date(),
      assignedBy: req.user._id,
      note: String(note || '').trim().slice(0, 500) || undefined,
    });
    return res.json({ asset });
  }
  const filter = { asset: asset._id, returnedAt: null };
  if (assignmentId) filter._id = assignmentId;
  await scopeUserField(req, filter);
  const open = await AssetAssignment.find(filter);
  if (!open.length) {
    res.status(400);
    throw new Error('Nobody holds this asset.');
  }
  if (open.length > 1) {
    res.status(400);
    throw new Error(`This asset is with ${open.length} people — take a specific one back from the Assets page.`);
  }
  try {
    await returnHolding(open[0], { by: req.user._id, date, note });
  } catch (err) {
    fail(res, err);
  }
  res.json({ asset: await Asset.findById(asset._id) });
});

/**
 * The allocation register: holdings with optional filters (max 2000).
 * @route GET /api/assets/assignments  (assets.manage)
 * @param {string} [req.query.active] - 'true' for currently held (not returned)
 * @param {string} [req.query.employee] - User id
 * @param {string} [req.query.asset] - Asset id
 * @returns {{count: number, assignments: Object[]}} asset + employee populated
 */
const listAssignments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.active === 'true') filter.returnedAt = null;
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.asset) filter.asset = req.query.asset;
  // Company wall: only holdings of employees in the viewer's scope.
  await scopeUserField(req, filter);
  const assignments = await AssetAssignment.find(filter)
    .populate('asset', HOLDING_ASSET_FIELDS)
    .populate('employee', USER_FIELDS)
    .populate('returnedBy', 'firstName lastName')
    .sort({ assignedAt: -1, createdAt: -1 })
    .limit(2000)
    .lean();
  res.json({ count: assignments.length, assignments: assignments.map(withLegacySerial) });
});

// ===== Return requests (HR/Admin) =====

/**
 * The return-request queue: items their holders have asked to hand back.
 * @route GET /api/assets/return-requests  (assets.manage)
 * @param {string} [req.query.status] - 'Pending' (default) or 'all' (every
 *   request ever made, newest first)
 * @returns {{count: number, requests: Object[]}} holdings with asset, employee
 *   and returnRequest.decidedBy populated
 */
const listReturnRequests = asyncHandler(async (req, res) => {
  const filter = req.query.status === 'all'
    ? { 'returnRequest.status': { $exists: true } }
    : { 'returnRequest.status': 'Pending', returnedAt: null };
  await scopeUserField(req, filter);
  const requests = await AssetAssignment.find(filter)
    .populate('asset', HOLDING_ASSET_FIELDS)
    .populate('employee', USER_FIELDS)
    .populate('returnRequest.decidedBy', 'firstName lastName')
    .sort({ 'returnRequest.requestedAt': -1 })
    .limit(500)
    .lean();
  res.json({ count: requests.length, requests: requests.map(withLegacySerial) });
});

/** A holding in scope with a request still waiting, or the right error. */
async function pendingRequestInScope(req, res) {
  const holding = await holdingInScope(req, res);
  if (holding.returnedAt) {
    res.status(409);
    throw new Error('This item has already been taken back.');
  }
  if (holding.returnRequest?.status !== 'Pending') {
    res.status(409);
    throw new Error('There is no open return request on this item — it may have been withdrawn or answered already.');
  }
  return holding;
}

/**
 * Accept an employee's request to hand an item back — this is what returns it.
 * @route PATCH /api/assets/assignments/:aid/return-request/accept  (assets.manage)
 * @param {string} [req.body.date] - the day it came back (defaults to now)
 * @param {string} [req.body.note] - its condition
 * @returns {{assignment: Object}}
 */
const acceptReturnRequest = asyncHandler(async (req, res) => {
  const holding = await pendingRequestInScope(req, res);
  try {
    // returnHolding marks the pending request Accepted along with the return.
    await returnHolding(holding, { by: req.user._id, date: req.body?.date, note: req.body?.note });
  } catch (err) {
    fail(res, err);
  }
  const full = await populateHolding(holding._id);
  notify({
    recipient: holding.employee,
    sender: req.user._id,
    type: 'asset',
    audience: 'employee',
    title: 'Asset return accepted',
    body: `${personName(req.user) || 'HR'} took back your ${itemLabel(full)}. It is off your asset list now.`,
    link: HOLDER_LINK,
  }).catch(() => {});
  res.json({ assignment: full });
});

/**
 * Decline an employee's request to hand an item back; they keep it on their list.
 * @route PATCH /api/assets/assignments/:aid/return-request/reject  (assets.manage)
 * @param {string} req.body.reason - required: the employee is told why
 * @returns {{assignment: Object}}
 */
const rejectReturnRequest = asyncHandler(async (req, res) => {
  const reason = clip(req.body?.reason);
  if (!reason) {
    res.status(400);
    throw new Error('Say why — the employee sees the reason.');
  }
  const holding = await pendingRequestInScope(req, res);
  holding.returnRequest.status = 'Rejected';
  holding.returnRequest.decidedAt = new Date();
  holding.returnRequest.decidedBy = req.user._id;
  holding.returnRequest.decisionNote = reason;
  await holding.save();
  const full = await populateHolding(holding._id);
  notify({
    recipient: holding.employee,
    sender: req.user._id,
    type: 'asset',
    audience: 'employee',
    title: 'Asset return declined',
    body: `${personName(req.user) || 'HR'} did not take back your ${itemLabel(full)}: ${reason}`,
    link: HOLDER_LINK,
  }).catch(() => {});
  res.json({ assignment: full });
});

// ===== Employee self-service =====

/** One of the caller's own items still held, or the right error. */
async function myOpenHolding(req, res) {
  const holding = await AssetAssignment.findOne({ _id: req.params.aid, employee: req.user._id })
    .populate('asset', 'name');
  if (!holding) {
    res.status(404);
    throw new Error('Item not found');
  }
  if (holding.returnedAt) {
    res.status(409);
    throw new Error('This item has already been returned.');
  }
  return holding;
}

/**
 * Ask to hand an item back. HR/Admin (everyone holding `assets.manage` in the
 * caller's company) are told; the item stays on the caller's list until one of
 * them accepts.
 * @route POST /api/assets/me/:aid/return-request
 * @param {string} [req.body.note] - e.g. "left it with IT at reception"
 * @returns {{asset: Object}} the item, in the /assets/me shape
 */
const requestReturn = asyncHandler(async (req, res) => {
  const holding = await myOpenHolding(req, res);
  if (holding.returnRequest?.status === 'Pending') {
    res.status(409);
    throw new Error('You have already asked to return this — HR has not answered yet.');
  }
  const note = clip(req.body?.note);
  holding.returnRequest = { status: 'Pending', note: note || undefined, requestedAt: new Date() };
  await holding.save();

  // Asked as a CAPABILITY (HR, a granted Manager, the standalone Assets grant),
  // walled to the requester's company, never sent back to the requester.
  // audience 'all': a decider may hold the module through the standalone grant
  // and live entirely in My Portal, where an 'admin' notification never shows.
  const recipients = (await scopeRecipientsToCompany(
    await usersHoldingAny('assets.manage'),
    req.user.scopeCompanyId,
  )).filter((id) => String(id) !== String(req.user._id));
  if (recipients.length) {
    notifyMany(recipients, {
      type: 'asset',
      audience: 'all',
      title: 'Asset return request',
      body: `${personName(req.user) || 'An employee'} wants to hand back ${itemLabel(holding)}.${note ? ` Note: "${note}"` : ''}`,
      link: DECIDER_LINK,
    }).catch(() => {});
  }
  const [shaped] = shapeMine([await populateHolding(holding._id)]);
  res.json({ asset: shaped });
});

/**
 * Withdraw one's own request while it is still waiting.
 * @route DELETE /api/assets/me/:aid/return-request
 * @returns {{asset: Object}} the item, in the /assets/me shape
 */
const cancelReturnRequest = asyncHandler(async (req, res) => {
  const holding = await myOpenHolding(req, res);
  if (holding.returnRequest?.status !== 'Pending') {
    res.status(409);
    throw new Error('There is no waiting request to withdraw — HR may have answered it already.');
  }
  holding.returnRequest.status = 'Cancelled';
  holding.returnRequest.decidedAt = new Date();
  holding.returnRequest.decidedBy = req.user._id;
  await holding.save();
  const [shaped] = shapeMine([await populateHolding(holding._id)]);
  res.json({ asset: shaped });
});

/**
 * What the caller holds right now. Shaped like an asset per item (name,
 * category, assetTag, serialNumber, assignedAt, status) — the shape this
 * endpoint had before the rework, which the mobile app still reads — plus
 * the item's own `details` and `note`.
 * @route GET /api/assets/me
 * @returns {{count: number, assets: Object[]}}
 */
const listMyAssets = asyncHandler(async (req, res) => {
  const assets = shapeMine(await openHoldingsFor(req.user._id));
  res.json({ count: assets.length, assets });
});

/**
 * A holding in the /assets/me shape — an asset per item, as the endpoint
 * answered before the rework (old app builds read it), plus `details`, `note`
 * and the item's `returnRequest` so the page can show "Return requested".
 * @param {Object[]} holdings - lean, asset populated
 * @returns {Object[]}
 */
function shapeMine(holdings) {
  return holdings.map((h) => ({
    _id: h._id,
    assignmentId: h._id,
    assetId: h.asset?._id,
    name: h.asset?.name || 'Asset',
    category: h.asset?.category,
    assetTag: h.unitTag || h.asset?.assetTag,
    serialNumber: h.serialNumber,
    details: h.details,
    note: h.note,
    assignedAt: h.assignedAt,
    status: h.asset?.status === 'InRepair' ? 'InRepair' : 'Assigned',
    returnRequest: h.returnRequest
      ? {
        status: h.returnRequest.status,
        note: h.returnRequest.note,
        requestedAt: h.returnRequest.requestedAt,
        decidedAt: h.returnRequest.decidedAt,
        decisionNote: h.returnRequest.decisionNote,
      }
      : null,
  }));
}

/**
 * People an asset can be issued to.
 *
 * Exists because the assets page needs a person picker, and GET /admin/users is
 * gated by ROLE, not capability — so the holder of the standalone Assets grant
 * (usually a plain employee) is refused by it and the whole page fails to load.
 * Serving the picker from the assets router keeps it behind the same
 * `assets.manage` gate as everything else here. Mirrors the /rnr/people
 * precedent. Same field shape as /admin/users so the client is unchanged.
 * @route GET /api/assets/people  (assets.manage)
 * @returns {{count: number, users: Object[]}} active, non-executive accounts
 */
const listAssetPeople = asyncHandler(async (req, res) => {
  const User = require('../models/User');
  const { EXECUTIVE_ROLES, shouldExcludeExecutives } = require('../utils/visibility');
  const filter = { isActive: true };
  // The picker asks to hide execs, the same opt-in /admin/users honours.
  const excluded = ['SuperAdmin'];
  if (await shouldExcludeExecutives(req)) excluded.push(...EXECUTIVE_ROLES);
  filter.role = { $nin: excluded };
  // Company wall: the picker only offers people of the viewer's own company.
  await scopeUserFilter(req, filter);
  const rows = await User.find(filter).select(USER_FIELDS).sort({ firstName: 1, lastName: 1 }).lean();
  // Nobody who has left, on either half of the rule (utils/departed): `isActive`
  // above misses a last working day already past on a login still switched on.
  // Dropped here rather than flagged — the rows carry no exit date, and an app
  // already on phones renders whatever this returns.
  const { departedUserIdSet } = require('../utils/departed');
  const gone = await departedUserIdSet(rows.map((u) => u._id));
  const users = rows.filter((u) => !gone.has(String(u._id)));
  res.json({ count: users.length, users });
});

module.exports = {
  listAssets, createAsset, updateAsset, deleteAsset,
  issueAsset, issueToEmployee, updateAssignment, returnAssignment, deleteAssignment, assignAsset,
  listAssignments, listMyAssets, listAssetPeople, ASSET_STATUS,
  listReturnRequests, acceptReturnRequest, rejectReturnRequest, requestReturn, cancelReturnRequest,
};
