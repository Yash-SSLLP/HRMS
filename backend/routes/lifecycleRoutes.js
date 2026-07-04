const express = require('express');
const {
  listConfirmations,
  updateConfirmation,
  nextEmployeeCode,
} = require('../controllers/lifecycleController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.use(requirePermission('lifecycle.manage'));

router.get('/confirmations', listConfirmations);
router.patch('/confirmations/:id', updateConfirmation);
router.get('/next-code', nextEmployeeCode);

module.exports = router;
