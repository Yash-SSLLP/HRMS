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
router.get('/', listActive);
router.post('/:id/respond', respond);

// HR/Admin — register static '/admin/all' before the dynamic '/:id' GET so it
// is not shadowed. restrictTo is applied per-route for the admin endpoints.
const adminOnly = requirePermission('surveys.manage');
router.get('/admin/all', adminOnly, listAllAdmin);
router.post('/', adminOnly, createSurvey);
router.get('/:id/results', adminOnly, results);
router.put('/:id', adminOnly, updateSurvey);
router.delete('/:id', adminOnly, deleteSurvey);

// Shared / Employee — dynamic GET last so static admin paths take precedence
router.get('/:id', getSurvey);

module.exports = router;
