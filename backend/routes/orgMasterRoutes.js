const express = require('express');
const {
  listMasters, createMaster, updateMaster, deleteMaster,
} = require('../controllers/orgMasterController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.use(restrictTo('SuperAdmin', 'HRManager'));

router.route('/').get(listMasters).post(createMaster);
router.route('/:id').put(updateMaster).delete(deleteMaster);

module.exports = router;
