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

router.post('/me/checkin', photoUpload.single('photo'), checkIn);
router.post('/me/checkout', photoUpload.single('photo'), checkOut);
router.get('/me/heatmap', myHeatmap);
router.get('/me', listMine);

// Photo view — auth (owner OR admin) handled inside the controller, so it lives
// before the HR/Admin-only gate below.
router.get('/:id/photo/:which', getAttendancePhoto);

router.use(requirePermission('attendance.manage'));

router.get('/org/heatmap', orgHeatmap);
router.get('/org/day', orgDayDetails);
router.get('/month-summary', monthSummary);
router.get('/daily-stats', dailyStats);
router.get('/today-board', todayBoard);
router.get('/presence-board', presenceBoard);

router.route('/settings')
  .get(getSettings)
  .put(updateSettings);

router.route('/')
  .get(listAll)
  .post(createRecord);

router.route('/:id')
  .put(updateRecord)
  .delete(deleteRecord);

module.exports = router;
