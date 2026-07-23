/**
 * Guide controller — HR-editable overrides for the app's built-in help guides,
 * keyed by a fixed set (GUIDE_KEYS). Reading returns the override or null (so the
 * client falls back to its bundled default); saving upserts; deleting reverts.
 */
const asyncHandler = require('express-async-handler');
const Guide = require('../models/Guide');
const { GUIDE_KEYS } = require('../models/Guide');

// Reject any key not in the known guide catalogue
function assertKey(key, res) {
  if (!GUIDE_KEYS.includes(key)) {
    res.status(400);
    throw new Error('Unknown guide');
  }
}

/**
 * Get a guide's HR override (content:null means use the client default).
 * @route GET /api/guides/:key  (any authenticated user)
 * @param {string} req.params.key - one of GUIDE_KEYS
 * @returns {{key, content, updatedAt, updatedByName}}
 */
// GET /api/guides/:key  (any authenticated user)
// Returns the HR-edited override, or content:null so the client uses its
// bundled default.
const getGuide = asyncHandler(async (req, res) => {
  assertKey(req.params.key, res);
  const doc = await Guide.findOne({ key: req.params.key });
  res.json({
    key: req.params.key,
    content: doc?.content || null,
    updatedAt: doc?.updatedAt || null,
    updatedByName: doc?.updatedByName || null,
  });
});

/**
 * Save (upsert) a guide override, stamping the editor's name.
 * @route PUT /api/guides/:key  (announcements.manage)
 * @param {string} req.params.key - one of GUIDE_KEYS
 * @param {string} req.body.content
 * @returns {{key, content, updatedAt, updatedByName}}
 */
// PUT /api/guides/:key { content }  (announcements.manage)
const saveGuide = asyncHandler(async (req, res) => {
  assertKey(req.params.key, res);
  const content = String(req.body.content ?? '');
  const name = req.user.fullName
    || `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim()
    || 'HR';
  const doc = await Guide.findOneAndUpdate(
    { key: req.params.key },
    { content, updatedBy: req.user._id, updatedByName: name },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ key: doc.key, content: doc.content, updatedAt: doc.updatedAt, updatedByName: doc.updatedByName });
});

/**
 * Delete a guide override, reverting to the client's bundled default.
 * @route DELETE /api/guides/:key  (announcements.manage)
 * @param {string} req.params.key - one of GUIDE_KEYS
 * @returns {{key, content: null, reset: true}}
 */
// DELETE /api/guides/:key  (announcements.manage) — revert to the bundled default.
const resetGuide = asyncHandler(async (req, res) => {
  assertKey(req.params.key, res);
  await Guide.deleteOne({ key: req.params.key });
  res.json({ key: req.params.key, content: null, reset: true });
});

module.exports = { getGuide, saveGuide, resetGuide };
