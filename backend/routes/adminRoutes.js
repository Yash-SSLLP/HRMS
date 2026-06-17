const express = require('express');
const {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deactivateUser,
  activateUser,
  deleteUser,
} = require('../controllers/adminController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// All admin routes require auth + SuperAdmin/HRManager role
router.use(protect, restrictTo('SuperAdmin', 'HRManager'));

router.route('/users')
  .get(listUsers)
  .post(createUser);

router.route('/users/:id')
  .get(getUser)
  .put(updateUser)
  .delete(deleteUser);

router.patch('/users/:id/deactivate', deactivateUser);
router.patch('/users/:id/activate', activateUser);

module.exports = router;
