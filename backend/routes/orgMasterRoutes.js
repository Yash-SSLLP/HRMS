/**
 * Org-master router — mounted at /api/org-masters.
 * Org reference data (designations/grades/locations) — admin read plus
 * org.manage CRUD.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const {
  listMasters, createMaster, updateMaster, deleteMaster,
} = require('../controllers/orgMasterController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Reference data (designations / grades / locations) — readable by any admin for
// forms across modules (e.g. the employee form). Managing needs org.manage.
// GET / — list org masters; protected, SuperAdmin/HRManager/CEO/MD/LDManager only.
router.get('/', restrictTo('SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager'), listMasters);

// Everything below requires the 'org.manage' permission.
router.use(requirePermission('org.manage'));
// POST / — create an org master; protected, requires 'org.manage'.
router.post('/', createMaster);
// PUT/DELETE /:id — update/delete an org master; protected, requires 'org.manage'.
router.route('/:id').put(updateMaster).delete(deleteMaster);

module.exports = router;
