/**
 * Admin router — mounted at /api/admin.
 * User/account administration: directory, user CRUD & (de)activation,
 * granular permissions, cashbook-access grants, and org settings.
 * All routes require authentication (router.use(protect)).
 */
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
// GET /users — user directory list; protected, SuperAdmin/HRManager/CEO/MD/LDManager only.
router.get('/users', restrictTo('SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager'), listUsers);

// Everything below requires the 'users.manage' capability (SuperAdmin always has it).
router.use(requirePermission('users.manage'));

// Granular-permission administration — SuperAdmin ONLY (they alone decide what
// each HR Manager can do). Declared before '/users/:id' so 'permissions' isn't
// captured as an :id.
// GET /permissions/catalog — list assignable permissions; protected, requires 'users.manage'.
router.get('/permissions/catalog', getPermissionCatalog);
// PATCH /users/:id/permissions — set a user's granular permissions; protected, SuperAdmin only.
router.patch('/users/:id/permissions', restrictTo('SuperAdmin'), updateUserPermissions);
// Standalone Cashbook access grant for any user/employee — SuperAdmin only.
// PATCH /users/:id/cashbook-access — grant/revoke cashbook access; protected, SuperAdmin only.
router.patch('/users/:id/cashbook-access', restrictTo('SuperAdmin'), setCashbookAccess);

// Org-wide preferences — SuperAdmin ONLY (e.g. whether CEO/MD appear in
// employee-selection pickers).
// GET/PUT /org-settings — read/update org-wide settings; protected, SuperAdmin only.
router.route('/org-settings')
  .get(restrictTo('SuperAdmin'), getOrgSettings)
  .put(restrictTo('SuperAdmin'), updateOrgSettings);

// POST /users — create a user; protected, requires 'users.manage'.
router.post('/users', createUser);

// GET /users/:id — fetch; PUT — update; DELETE — delete a user; protected, requires 'users.manage'.
router.route('/users/:id')
  .get(getUser)
  .put(updateUser)
  .delete(deleteUser);

// PATCH /users/:id/deactivate — deactivate a user; protected, requires 'users.manage'.
router.patch('/users/:id/deactivate', deactivateUser);
// PATCH /users/:id/activate — reactivate a user; protected, requires 'users.manage'.
router.patch('/users/:id/activate', activateUser);

module.exports = router;
