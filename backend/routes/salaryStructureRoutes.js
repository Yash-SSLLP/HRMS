const express = require('express');
const {
  listStructures,
  createStructure,
  updateStructure,
  deleteStructure,
  previewStructure,
} = require('../controllers/salaryStructureController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// Admin-only module
router.use(protect);
router.use(requirePermission('payroll.manage'));

router.route('/').get(listStructures).post(createStructure);
router.post('/:id/preview', previewStructure);
router.route('/:id').put(updateStructure).delete(deleteStructure);

module.exports = router;
