const express = require('express');
const {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deactivateUser,
  activateUser,
  deleteUser,
  getPermissionCatalog,
  updateUserPermissions,
  setCashbookAccess,
  getOrgSettings,
  updateOrgSettings,
} = require('../controllers/adminController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// User directory list — readable by ANY admin-portal role (people picker for
// interviewer assignment, etc.). Managing users requires users.manage below.
router.get('/users', restrictTo('SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager'), listUsers);

// Everything below requires the 'users.manage' capability (SuperAdmin always has it).
router.use(requirePermission('users.manage'));

// Granular-permission administration — SuperAdmin ONLY (they alone decide what
// each HR Manager can do). Declared before '/users/:id' so 'permissions' isn't
// captured as an :id.
router.get('/permissions/catalog', getPermissionCatalog);
router.patch('/users/:id/permissions', restrictTo('SuperAdmin'), updateUserPermissions);
// Standalone Cashbook access grant for any user/employee — SuperAdmin only.
router.patch('/users/:id/cashbook-access', restrictTo('SuperAdmin'), setCashbookAccess);

// Org-wide preferences — SuperAdmin ONLY (e.g. whether CEO/MD appear in
// employee-selection pickers).
router.route('/org-settings')
  .get(restrictTo('SuperAdmin'), getOrgSettings)
  .put(restrictTo('SuperAdmin'), updateOrgSettings);

router.post('/users', createUser);

router.route('/users/:id')
  .get(getUser)
  .put(updateUser)
  .delete(deleteUser);

router.patch('/users/:id/deactivate', deactivateUser);
router.patch('/users/:id/activate', activateUser);

module.exports = router;
