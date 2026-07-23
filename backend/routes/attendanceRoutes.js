/**
 * Attendance router — mounted at /api/attendance.
 * Employee check-in/out (with selfie via multer + geofence), heatmaps and
 * own records, plus HR/Admin org boards, exports, settings, and record CRUD.
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const multer = require('multer');
const {
  checkIn,
  checkOut,
  getAttendancePhoto,
  myHeatmap,
  orgHeatmap,
  orgDayDetails,
  listMine,
  listAll,
  monthSummary,
  exportAttendance,
  punchMap,
  dailyStats,
  todayBoard,
  presenceBoard,
  createRecord,
  updateRecord,
  deleteRecord,
  getSettings,
  updateSettings,
} = require('../controllers/attendanceController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB cap; accept only images for the punch selfie.
const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(file.mimetype.startsWith('image/') ? null : new Error('Only image files are accepted'), file.mimetype.startsWith('image/'));
  },
});

router.use(protect);

// POST /me/checkin — punch in; protected + multer single 'photo' (5MB image selfie).
router.post('/me/checkin', photoUpload.single('photo'), checkIn);
// POST /me/checkout — punch out; protected + multer single 'photo' (5MB image selfie).
router.post('/me/checkout', photoUpload.single('photo'), checkOut);
// GET /me/heatmap — current user's attendance heatmap; protected.
router.get('/me/heatmap', myHeatmap);
// GET /me — current user's attendance records; protected.
router.get('/me', listMine);

// Photo view — auth (owner OR admin) handled inside the controller, so it lives
// before the HR/Admin-only gate below.
// GET /:id/photo/:which — view a punch selfie; protected (owner or admin, checked in controller).
router.get('/:id/photo/:which', getAttendancePhoto);

// Everything below requires the 'attendance.manage' permission.
router.use(requirePermission('attendance.manage'));

// GET /org/heatmap — org-wide attendance heatmap; protected, requires 'attendance.manage'.
router.get('/org/heatmap', orgHeatmap);
// GET /org/day — org attendance details for a day; protected, requires 'attendance.manage'.
router.get('/org/day', orgDayDetails);
// GET /month-summary — monthly attendance summary; protected, requires 'attendance.manage'.
router.get('/month-summary', monthSummary);
// GET /export — export attendance CSV; protected, requires 'attendance.manage'.
router.get('/export', exportAttendance);
// GET /punch-map — GPS punch-location map data; protected, requires 'attendance.manage'.
router.get('/punch-map', punchMap);
// GET /daily-stats — per-day avg-hours/present-count stats; protected, requires 'attendance.manage'.
router.get('/daily-stats', dailyStats);
// GET /today-board — today's attendance board; protected, requires 'attendance.manage'.
router.get('/today-board', todayBoard);
// GET /presence-board — live presence board; protected, requires 'attendance.manage'.
router.get('/presence-board', presenceBoard);

// GET/PUT /settings — read/update attendance settings; protected, requires 'attendance.manage'.
router.route('/settings')
  .get(getSettings)
  .put(updateSettings);

// GET / — list all records; POST / — create a record; protected, requires 'attendance.manage'.
router.route('/')
  .get(listAll)
  .post(createRecord);

// PUT /:id — update; DELETE /:id — delete an attendance record; protected, requires 'attendance.manage'.
router.route('/:id')
  .put(updateRecord)
  .delete(deleteRecord);

module.exports = router;
