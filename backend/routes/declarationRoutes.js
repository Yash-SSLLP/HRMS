/**
 * Declaration router — mounted at /api/declarations.
 * Employee tax/investment declaration self-service plus HR review.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  getMine,
  saveMine,
  submitMine,
  listAll,
  reviewDeclaration,
} = require('../controllers/declarationController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Employee self routes
// GET /me — fetch own declaration; protected.
router.get('/me', getMine);
// POST /me — save own declaration draft; protected.
router.post('/me', saveMine);
// PATCH /me/submit — submit own declaration for review; protected.
router.patch('/me/submit', submitMine);

// Admin routes — everything below requires the 'declarations.manage' permission.
router.use(requirePermission('declarations.manage'));
// GET / — list all declarations; protected, requires 'declarations.manage'.
router.get('/', listAll);
// PATCH /:id/status — review (approve/reject) a declaration; protected, requires 'declarations.manage'.
router.patch('/:id/status', reviewDeclaration);

module.exports = router;
