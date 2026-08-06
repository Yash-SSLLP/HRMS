/**
 * Holiday router — mounted at /api/holidays.
 * Holiday calendar (readable by all) plus HR/Admin management.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const multer = require('multer');
const {
  listHolidays,
  createHoliday,
  updateHoliday,
  deleteHoliday,
  downloadCalendarTemplate,
  importCalendar,
} = require('../controllers/holidayController');
const { protect, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 2 MB cap; a calendar workbook is a few hundred rows at most.
const XLSX_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // some browsers send this for .xlsx
];
const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = XLSX_MIME.includes(file.mimetype) || /\.xlsx$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Upload an .xlsx file'), ok);
  },
});

router.use(protect);

// Everyone may read the holiday list.
// GET / — list holidays; protected (any authenticated user).
router.get('/', listHolidays);

// Bulk calendar upload (holidays + comp-off days + celebrations).
// GET /template.xlsx — download the import template; requires 'leave.manage'.
router.get('/template.xlsx', requirePermission('leave.manage'), downloadCalendarTemplate);
// POST /import — bulk-create from an .xlsx; requires 'leave.manage'
// (the Celebrations sheet additionally needs 'events.manage' — checked in the handler).
router.post('/import', requirePermission('leave.manage'), sheetUpload.single('file'), importCalendar);

// Only HR/SuperAdmin may manage holidays (guarded by 'leave.manage').
// POST / — create a holiday; protected, requires 'leave.manage'.
router.post('/', requirePermission('leave.manage'), createHoliday);
// PUT /:id — update a holiday; protected, requires 'leave.manage'.
router.put('/:id', requirePermission('leave.manage'), updateHoliday);
// DELETE /:id — delete a holiday; protected, requires 'leave.manage'.
router.delete('/:id', requirePermission('leave.manage'), deleteHoliday);

module.exports = router;
