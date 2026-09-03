/**
 * Salary-structure router — mounted at /api/salary-structures.
 * Admin-only CRUD + preview of salary structure templates, plus the bulk
 * Excel round-trip (template → upload → export).
 * All routes require auth + the 'payroll.manage' permission.
 */
const express = require('express');
const { createUpload } = require('../middleware/upload');
const {
  listStructures,
  createStructure,
  updateStructure,
  deleteStructure,
  previewStructure,
  assignStructure,
  exportStructuresXlsx,
  downloadImportTemplate,
  importStructuresXlsx,
} = require('../controllers/salaryStructureController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 2 MB cap; a salary sheet is a few hundred rows at most. The MIME list is the
// broader one from holidayRoutes, not the employee importer's single type —
// some browsers label a .xlsx as application/octet-stream, and the file name is
// read defensively because a missing one would throw inside multer.
const XLSX_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
];
const xlsxUpload = createUpload({
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = XLSX_MIME.includes(file.mimetype) || /\.xlsx$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Upload an .xlsx file'), ok);
  },
});

// Admin-only module
router.use(protect);
router.use(requirePermission('payroll.manage'));

// ----- Bulk Excel -----
// Declared before '/:id' so "export.xlsx" is never read as a structure id.
// GET /template.xlsx — the blank import template (headers, example row, reference sheet).
router.get('/template.xlsx', downloadImportTemplate);
// GET /export.xlsx — every employee in scope with their structure and CTC; re-uploadable.
router.get('/export.xlsx', exportStructuresXlsx);
// POST /import — bulk-create structures and assign employees; multipart field "file".
// POST, so requirePermission's safe-method exemption keeps a read-only CEO/MD out.
router.post('/import', xlsxUpload.single('file'), importStructuresXlsx);

// GET / — list salary structures; POST / — create one; protected, requires 'payroll.manage'.
router.route('/').get(listStructures).post(createStructure);
// POST /:id/preview — preview a computed structure; protected, requires 'payroll.manage'.
router.post('/:id/preview', previewStructure);
// POST /:id/assign — assign this structure (+ optional CTC) to an employee; requires 'payroll.manage'.
router.post('/:id/assign', assignStructure);
// PUT /:id — update a structure; DELETE /:id — delete it; protected, requires 'payroll.manage'.
router.route('/:id').put(updateStructure).delete(deleteStructure);

module.exports = router;
