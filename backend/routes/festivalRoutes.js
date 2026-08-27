/**
 * Festival router — mounted at /api/festivals.
 * Reminder-only festival calendar (readable by all) plus HR/Admin management.
 * These entries never mark a non-working day — see models/Festival.js.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listFestivals,
  createFestival,
  updateFestival,
  deleteFestival,
  seedFestivals,
} = require('../controllers/festivalController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Everyone may read the festival list.
// GET / — list festivals; protected (any authenticated user).
router.get('/', listFestivals);

// Managing festivals rides on the same capability as the holiday calendar.
// POST /seed — fill a year from the built-in list; requires 'leave.manage'.
router.post('/seed', requirePermission('leave.manage'), seedFestivals);
// POST / — create a festival; requires 'leave.manage'.
router.post('/', requirePermission('leave.manage'), createFestival);
// PUT /:id — update a festival; requires 'leave.manage'.
router.put('/:id', requirePermission('leave.manage'), updateFestival);
// DELETE /:id — delete a festival; requires 'leave.manage'.
router.delete('/:id', requirePermission('leave.manage'), deleteFestival);

module.exports = router;
