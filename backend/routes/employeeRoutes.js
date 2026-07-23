/**
 * Employee router — mounted at /api/employees.
 * Employee self-profile, admin directory, HR/Admin employee CRUD, bulk
 * xlsx import/export & zip exports, plus public tokenised document
 * submission (multer uploads for xlsx and documents).
 */
const express = require('express');
const multer = require('multer');
const {
  getMyProfile,
  updateMyBirthday,
  listEmployees,
  employeesDocumentStatus,
  exportEmployeeZip,
  exportAllEmployeesZip,
  getEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  exportEmployeesXlsx,
  downloadImportTemplate,
  importEmployeesXlsx,
  createDocLink,
  getPublicDocRequest,
  submitPublicDocs,
} = require('../controllers/employeeController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 2 MB cap on xlsx uploads; allow only xlsx mime
const xlsxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      || file.originalname.toLowerCase().endsWith('.xlsx');
    cb(ok ? null : new Error('Only .xlsx files are accepted'), ok);
  },
});

// 10 MB cap; documents the employee submits via the public link.
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf'
      || file.mimetype === 'application/msword'
      || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    cb(ok ? null : new Error('Only PDF, Word or image files are accepted'), ok);
  },
});

// Public, no-login document submission via tokenised link (before auth guard).
// GET /public-docs/:token — load public doc-submission context; public (token-scoped).
router.get('/public-docs/:token', getPublicDocRequest);
// POST /public-docs/:token — submit documents; public + multer array 'files' (max 20, 10MB each).
router.post('/public-docs/:token', docUpload.array('files', 20), submitPublicDocs);

router.use(protect);

// Employee self-service
// GET /me — current user's employee profile; protected.
router.get('/me', getMyProfile);
// PATCH /me/birthday — update own birthday; protected.
router.patch('/me/birthday', updateMyBirthday);

// Employee directory list — readable by ANY admin-portal role (it's the people
// picker used across many panels: course assign, payroll, reviews, onboarding,
// exit, …). Managing employees still requires the employees.manage capability.
// GET / — employee directory list; protected, SuperAdmin/HRManager/CEO/MD/LDManager only.
router.get('/', restrictTo('SuperAdmin', 'HRManager', 'CEO', 'MD', 'LDManager'), listEmployees);

// HR/Admin management — everything below requires the 'employees.manage' capability.
router.use(requirePermission('employees.manage'));

// Bulk Excel — keep these BEFORE /:id so route matching doesn't grab "export.xlsx" as an id
// GET /export.xlsx — export employees to xlsx; protected, requires 'employees.manage'.
router.get('/export.xlsx', exportEmployeesXlsx);
// GET /template.xlsx — download the import template; protected, requires 'employees.manage'.
router.get('/template.xlsx', downloadImportTemplate);
// GET /documents-status — per-employee document-status overview; protected, requires 'employees.manage'.
router.get('/documents-status', employeesDocumentStatus);
// GET /export-all.zip — export all employees' files as a zip; protected, requires 'employees.manage'.
router.get('/export-all.zip', exportAllEmployeesZip);
// POST /import — bulk-import employees from xlsx; protected, requires 'employees.manage' + multer single 'file' (2MB xlsx).
router.post('/import', xlsxUpload.single('file'), importEmployeesXlsx);

// POST / — create an employee; protected, requires 'employees.manage'.
router.post('/', createEmployee);

// POST /:id/doc-link — create a public document-submission link; protected, requires 'employees.manage'.
router.post('/:id/doc-link', createDocLink);
// GET /:id/export.zip — export one employee's files as a zip; protected, requires 'employees.manage'.
router.get('/:id/export.zip', exportEmployeeZip);

// GET /:id — fetch; PUT — update; DELETE — delete an employee; protected, requires 'employees.manage'.
router.route('/:id')
  .get(getEmployee)
  .put(updateEmployee)
  .delete(deleteEmployee);

module.exports = router;
