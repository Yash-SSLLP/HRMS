/**
 * Asset router — mounted at /api/assets.
 * Asset kinds ("Laptop") and the people holding one, each with their own item
 * ("MacBook i5"): employee view plus HR/Admin management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listAssets, createAsset, updateAsset, deleteAsset,
  issueAsset, updateAssignment, returnAssignment, deleteAssignment, assignAsset,
  listAssignments, listMyAssets, listAssetPeople,
  listReturnRequests, acceptReturnRequest, rejectReturnRequest, requestReturn, cancelReturnRequest,
} = require('../controllers/assetController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
// GET /me — items the current user holds; protected.
router.get('/me', listMyAssets);
// POST /me/:aid/return-request — ask to hand one of my items back;
// DELETE — withdraw that request while it is still waiting.
router.route('/me/:aid/return-request').post(requestReturn).delete(cancelReturnRequest);

// HR/Admin — everything below requires the 'assets.manage' permission.
router.use(requirePermission('assets.manage'));
// GET /assignments — the holding register (?active=true&employee=&asset=).
router.get('/assignments', listAssignments);
// GET /return-requests — items their holders asked to hand back (?status=all).
router.get('/return-requests', listReturnRequests);
// PATCH /assignments/:aid/return-request/accept|reject — answer one; accepting
// is what returns the item.
router.patch('/assignments/:aid/return-request/accept', acceptReturnRequest);
router.patch('/assignments/:aid/return-request/reject', rejectReturnRequest);
// PUT /assignments/:aid — correct a holding; DELETE — remove one made in error.
router.route('/assignments/:aid').put(updateAssignment).delete(deleteAssignment);
// PATCH /assignments/:aid/return — take an item back (date + condition note).
router.patch('/assignments/:aid/return', returnAssignment);
// GET /people — assignable people for the picker. Declared here rather than
// reusing /admin/users, which is role-gated and would 403 for the holder of
// the standalone Assets grant.
router.get('/people', listAssetPeople);
// GET / — list asset kinds with their holders; POST / — create a kind.
router.route('/').get(listAssets).post(createAsset);
// POST /:id/assignments — issue a kind to one or more employees.
router.post('/:id/assignments', issueAsset);
// PATCH /:id/assign — LEGACY single-unit assign/return, for app builds from before the rework.
router.patch('/:id/assign', assignAsset);
// PUT/DELETE /:id — update/delete an asset kind (delete refused while held).
router.route('/:id').put(updateAsset).delete(deleteAsset);

module.exports = router;
