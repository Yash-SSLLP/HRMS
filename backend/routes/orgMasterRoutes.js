const express = require('express');
const {
  listMasters, createMaster, updateMaster, deleteMaster,
} = require('../controllers/orgMasterController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Reference data (designations / grades / locations) — readable by any admin for
// forms across modules (e.g. the employee form). Managing needs org.manage.
router.get('/', restrictTo('SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager'), listMasters);

router.use(requirePermission('org.manage'));
router.post('/', createMaster);
router.route('/:id').put(updateMaster).delete(deleteMaster);

module.exports = router;
