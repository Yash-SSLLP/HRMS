/**
 * Admin router — mounted at /api/admin.
 * User/account administration: directory, user CRUD & (de)activation,
 * granular permissions, cashbook-access grants, and org settings.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listUsers,
  listSessions,
  signOutUser,
  listAccountSecurity,
  resetUserPassword,
  requirePasswordChange,
  listAppVersions,
  getUser,
  createUser,
  updateUser,
  deactivateUser,
  activateUser,
  deleteUser,
  getPermissionCatalog,
  updateUserPermissions,
  setCashbookAccess,
  setExpensesAccess,
  setAssetsAccess,
  setKhataAccess,
  setKhataExportAccess,
  setManagerProfileAccess,
  setExecEditAccess,
  setExecCompanies,
  setWfhAccess,
  setRemotePunchAccess,
  getOrgSettings,
  updateOrgSettings,
  getBrandingSettings,
  updateBrandingSettings,
  uploadBrandingLogo,
  deleteBrandingLogo,
  getBrandingLogo,
  uploadBrandingSignature,
  deleteBrandingSignature,
  getBrandingSignature,
} = require('../controllers/adminController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');
const { createUpload } = require('../middleware/upload');

const router = express.Router();

// 3 MB cap; images only. A logo/signature is a small transparent PNG — anything
// larger is a scan that would bloat every generated PDF.
const brandingUpload = createUpload({
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Only image files are accepted'), ok);
  },
});

router.use(protect);

// User directory list — readable by ANY admin-portal role (people picker for
// interviewer assignment, etc.). Managing users requires users.manage below.
// GET /users — user directory list; protected, SuperAdmin/HRManager/CEO/MD/LDManager only.
router.get('/users', restrictTo('SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager'), listUsers);

// Who is signed in right now, and signing one of them out. Backend ONLY, by
// role rather than by capability: this is not "managing users", it is ending
// somebody's session on any device they hold, which is the Backend's alone.
// Declared before the users.manage gate below so the capability cannot reach it.
router.get('/sessions', restrictTo('SuperAdmin'), listSessions);
router.post('/sessions/:id/logout', restrictTo('SuperAdmin'), signOutUser);

// Account security (credential state + password reset). SuperAdmin ONLY, and
// deliberately NOT restrictTo('SuperAdmin') — that helper waves CEO/MD through
// on safe methods (EXEC_VIEWERS in authMiddleware), which would hand a read-only
// executive the whole directory's login state. Same reasoning, same shape as
// routes/auditRoutes.js. Declared above the users.manage gate so no granted
// capability can reach it either.
const superAdminOnly = (req, res, next) => {
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    return next(new Error('Not authorised to manage account security'));
  }
  return next();
};
router.get('/account-security', superAdminOnly, listAccountSecurity);
router.post('/users/:id/reset-password', superAdminOnly, resetUserPassword);
router.post('/users/:id/require-password-change', superAdminOnly, requirePasswordChange);
// Which app build each person is on. Same Backend-only gate: it is a device
// inventory of the whole company.
router.get('/app-versions', superAdminOnly, listAppVersions);

// ----- Letterhead branding: company logo + CEO/MD/HR signatures -----
// Edited from Admin → Email & Letter Templates; the images are applied to every
// generated letter and payslip. Gated on 'branding.manage' rather than on the
// SuperAdmin role so an HR who already owns the letter wording can own the
// letterhead too. Declared ABOVE the users.manage gate below — the capability
// is about letters, and nothing here should also demand user administration.
// GET/PUT /org-settings/branding — the letterhead slice of the settings doc
// (images + printed footer). Separate from GET /org-settings, which is the
// Backend's own org preferences and stays SuperAdmin-only: holding the
// letterhead grant is not a reason to read whether chat is switched on.
router.route('/org-settings/branding')
  .all(requirePermission('branding.manage'))
  .get(getBrandingSettings)
  .put(updateBrandingSettings);

// GET/POST/DELETE /org-settings/logo
router.route('/org-settings/logo')
  .all(requirePermission('branding.manage'))
  .get(getBrandingLogo)
  .post(brandingUpload.single('image'), uploadBrandingLogo)
  .delete(deleteBrandingLogo);

// GET/POST/DELETE /org-settings/signature/:key  (key = ceo | md | hr)
router.route('/org-settings/signature/:key')
  .all(requirePermission('branding.manage'))
  .get(getBrandingSignature)
  .post(brandingUpload.single('image'), uploadBrandingSignature)
  .delete(deleteBrandingSignature);

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
// PATCH /users/:id/expenses-access — grant/revoke expense-claim review; protected, SuperAdmin only.
router.patch('/users/:id/expenses-access', restrictTo('SuperAdmin'), setExpensesAccess);
// PATCH /users/:id/assets-access — grant/revoke the assets register; protected, SuperAdmin only.
router.patch('/users/:id/assets-access', restrictTo('SuperAdmin'), setAssetsAccess);
// PATCH /users/:id/khata-access — grant/revoke the employee-khata module; protected, SuperAdmin only.
router.patch('/users/:id/khata-access', restrictTo('SuperAdmin'), setKhataAccess);
// Downloading the khata is its own grant, kept apart from the module grant
// above: reading balances on screen and carrying every employee's ledger out in
// a file are different decisions. No role confers it.
// PATCH /users/:id/khata-export-access — grant/revoke the khata download; protected, SuperAdmin only.
router.patch('/users/:id/khata-export-access', restrictTo('SuperAdmin'), setKhataExportAccess);
// Editing a Manager's employee profile — SuperAdmin only, and deliberately not
// part of the 'employees.manage' capability: that one is held by default by
// every HR account, and this is meant to be an explicit list of who may touch
// the records of the people who approve their own team's leave.
// PATCH /users/:id/manager-profile-access — grant/revoke editing Manager profiles; protected, SuperAdmin only.
router.patch('/users/:id/manager-profile-access', restrictTo('SuperAdmin'), setManagerProfileAccess);
// CEO/MD view-only ↔ edit mode — SuperAdmin only. Lifting the executive
// read-only restriction is exactly the kind of decision that stays with the one
// role that administers the system.
// PATCH /users/:id/exec-edit-access — switch a CEO/MD into edit mode; protected, SuperAdmin only.
router.patch('/users/:id/exec-edit-access', restrictTo('SuperAdmin'), setExecEditAccess);
// PATCH /users/:id/companies — set which companies a CEO/MD may see; SuperAdmin only.
router.patch('/users/:id/companies', restrictTo('SuperAdmin'), setExecCompanies);
// Work-from-home grant — SuperAdmin only. A WFH punch skips the office geofence,
// so it is deliberately not something HR or the employee can switch on.
// PATCH /users/:id/wfh-access — grant/revoke work-from-home; protected, SuperAdmin only.
router.patch('/users/:id/wfh-access', restrictTo('SuperAdmin'), setWfhAccess);
// Punch-from-anywhere grant — SuperAdmin only, and a different thing from WFH:
// this one says the office geofence does not apply to this employee at all,
// which is what field staff need. See setRemotePunchAccess.
// PATCH /users/:id/remote-punch-access — allow check-in/out from outside the office; protected, SuperAdmin only.
router.patch('/users/:id/remote-punch-access', restrictTo('SuperAdmin'), setRemotePunchAccess);

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
