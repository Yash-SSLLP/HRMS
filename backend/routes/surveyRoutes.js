/**
 * Survey router — mounted at /api/surveys.
 * Employee survey listing/response plus HR/Admin survey CRUD and results.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listActive,
  getSurvey,
  respond,
  listAllAdmin,
  createSurvey,
  updateSurvey,
  deleteSurvey,
  results,
} = require('../controllers/surveyController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Shared / Employee
// GET / — list active surveys; protected.
router.get('/', listActive);
// POST /:id/respond — submit a survey response; protected.
router.post('/:id/respond', respond);

// HR/Admin — register static '/admin/all' before the dynamic '/:id' GET so it
// is not shadowed. restrictTo is applied per-route for the admin endpoints.
const adminOnly = requirePermission('surveys.manage');
// GET /admin/all — list all surveys (admin view); protected, requires 'surveys.manage'.
router.get('/admin/all', adminOnly, listAllAdmin);
// POST / — create a survey; protected, requires 'surveys.manage'.
router.post('/', adminOnly, createSurvey);
// GET /:id/results — survey results/aggregates; protected, requires 'surveys.manage'.
router.get('/:id/results', adminOnly, results);
// PUT /:id — update a survey; protected, requires 'surveys.manage'.
router.put('/:id', adminOnly, updateSurvey);
// DELETE /:id — delete a survey; protected, requires 'surveys.manage'.
router.delete('/:id', adminOnly, deleteSurvey);

// Shared / Employee — dynamic GET last so static admin paths take precedence
// GET /:id — fetch a single survey to take; protected.
router.get('/:id', getSurvey);

module.exports = router;
