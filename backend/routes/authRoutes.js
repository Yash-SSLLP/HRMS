const express = require('express');
const multer = require('multer');
const {
  signup,
  login,
  me,
  updateMyCredentials,
  uploadMyAvatar,
  deleteMyAvatar,
  getUserAvatar,
} = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB cap; accept only images for the profile photo.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/');
    cb(ok ? null : new Error('Only image files are accepted'), ok);
  },
});

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', protect, me);
router.patch('/me/credentials', protect, updateMyCredentials);

// Profile photo (self-service upload/remove + viewing any user's avatar)
router.post('/me/avatar', protect, avatarUpload.single('photo'), uploadMyAvatar);
router.delete('/me/avatar', protect, deleteMyAvatar);
router.get('/users/:id/avatar', protect, getUserAvatar);

module.exports = router;
