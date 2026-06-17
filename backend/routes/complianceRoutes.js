const express = require('express');
const {
  pfReport,
  esiReport,
  ptReport,
  tdsReport,
  form16Summary,
} = require('../controllers/complianceController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// Statutory compliance reports are admin-only.
router.use(protect);
router.use(restrictTo('SuperAdmin', 'HRManager'));

router.get('/pf', pfReport);
router.get('/esi', esiReport);
router.get('/pt', ptReport);
router.get('/tds', tdsReport);
router.get('/form16', form16Summary);

module.exports = router;
