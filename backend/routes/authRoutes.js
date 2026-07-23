/**
 * Auth router — mounted at /api/auth.
 * Signup/login, current-user profile & credentials, plus self-service
 * avatar and banner upload/removal (and viewing any user's images).
 */
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
  uploadMyBanner,
  deleteMyBanner,
  getUserBanner,
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

// POST /signup — register a new user; public.
router.post('/signup', signup);
// POST /login — authenticate and issue a token; public.
router.post('/login', login);
// GET /me — current user's profile; protected.
router.get('/me', protect, me);
// PATCH /me/credentials — update own username/password; protected.
router.patch('/me/credentials', protect, updateMyCredentials);

// Profile photo (self-service upload/remove + viewing any user's avatar)
// POST /me/avatar — upload own avatar; protected + multer single 'photo' (5MB image-only).
router.post('/me/avatar', protect, avatarUpload.single('photo'), uploadMyAvatar);
// DELETE /me/avatar — remove own avatar; protected.
router.delete('/me/avatar', protect, deleteMyAvatar);
// GET /users/:id/avatar — fetch a user's avatar image; protected.
router.get('/users/:id/avatar', protect, getUserAvatar);

// Cover/banner photo (self-service upload/remove + viewing any user's banner)
// POST /me/banner — upload own banner; protected + multer single 'photo' (5MB image-only).
router.post('/me/banner', protect, avatarUpload.single('photo'), uploadMyBanner);
// DELETE /me/banner — remove own banner; protected.
router.delete('/me/banner', protect, deleteMyBanner);
// GET /users/:id/banner — fetch a user's banner image; protected.
router.get('/users/:id/banner', protect, getUserBanner);

module.exports = router;
