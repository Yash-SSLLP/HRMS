const express = require('express');
const multer = require('multer');
const {
  checkIn,
  checkOut,
  getAttendancePhoto,
  listMine,
  listAll,
  createRecord,
  updateRecord,
  deleteRecord,
} = require('../controllers/attendanceController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

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
router.get('/me', listMine);

// Photo view — auth (owner OR admin) handled inside the controller, so it lives
// before the HR/Admin-only gate below.
router.get('/:id/photo/:which', getAttendancePhoto);

router.use(restrictTo('SuperAdmin', 'HRManager'));

router.route('/')
  .get(listAll)
  .post(createRecord);

router.route('/:id')
  .put(updateRecord)
  .delete(deleteRecord);

module.exports = router;
