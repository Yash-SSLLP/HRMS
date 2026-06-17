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
} = require('../controllers/employeeController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

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

router.use(protect);

// Employee self-service
router.get('/me', getMyProfile);
router.patch('/me/birthday', updateMyBirthday);

// HR/Admin only
router.use(restrictTo('SuperAdmin', 'HRManager'));

// Bulk Excel — keep these BEFORE /:id so route matching doesn't grab "export.xlsx" as an id
router.get('/export.xlsx', exportEmployeesXlsx);
router.get('/template.xlsx', downloadImportTemplate);
router.get('/documents-status', employeesDocumentStatus);
router.get('/export-all.zip', exportAllEmployeesZip);
router.post('/import', xlsxUpload.single('file'), importEmployeesXlsx);

router.route('/')
  .get(listEmployees)
  .post(createEmployee);

router.get('/:id/export.zip', exportEmployeeZip);

router.route('/:id')
  .get(getEmployee)
  .put(updateEmployee)
  .delete(deleteEmployee);

module.exports = router;
