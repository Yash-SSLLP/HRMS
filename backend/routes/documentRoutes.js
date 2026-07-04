const express = require('express');
const multer = require('multer');
const {
  listMine,
  uploadMine,
  listForEmployee,
  uploadForEmployee,
  download,
  remove,
  categories,
  setStatus,
} = require('../controllers/documentController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB cap, allowlist common HR document types
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

router.use(protect);

router.get('/categories', categories);

// Employee self-service
router.get('/me', listMine);
router.post('/me', upload.single('file'), uploadMine);

// Download is auth-checked inside the controller (allows both owner + admin)
router.get('/:id/download', download);
router.delete('/:id', remove);

// HR/Admin
router.use(requirePermission('documents.manage'));
router.get('/', listForEmployee);
router.post('/', upload.single('file'), uploadForEmployee);
router.patch('/:id/status', setStatus);

module.exports = router;
