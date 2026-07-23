/**
 * Document router — mounted at /api/documents.
 * Employee HR-document self-upload plus HR/Admin management, with
 * multer memory upload (5MB, PDF/image/Word allowlist).
 * All routes require authentication (router.use(protect)).
 */
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

// GET /categories — list document categories; protected.
router.get('/categories', categories);

// Employee self-service
// GET /me — list current user's documents; protected.
router.get('/me', listMine);
// POST /me — upload own document; protected + multer single 'file' (5MB allowlist).
router.post('/me', upload.single('file'), uploadMine);

// Download is auth-checked inside the controller (allows both owner + admin)
// GET /:id/download — download a document; protected (owner or admin, checked in controller).
router.get('/:id/download', download);
// DELETE /:id — delete a document; protected (owner or admin, checked in controller).
router.delete('/:id', remove);

// HR/Admin — everything below requires the 'documents.manage' permission.
router.use(requirePermission('documents.manage'));
// GET / — list an employee's documents; protected, requires 'documents.manage'.
router.get('/', listForEmployee);
// POST / — upload a document for an employee; protected, requires 'documents.manage' + multer single 'file'.
router.post('/', upload.single('file'), uploadForEmployee);
// PATCH /:id/status — set document verify status; protected, requires 'documents.manage'.
router.patch('/:id/status', setStatus);

module.exports = router;
