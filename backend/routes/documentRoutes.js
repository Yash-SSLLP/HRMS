/**
 * Document router — mounted at /api/documents.
 * Employee HR-document self-upload plus HR/Admin management, with
 * multer memory upload (5MB, PDF/image/Word allowlist).
 * All routes require authentication (router.use(protect)).
 */
const express = require('express');
const { createUpload } = require('../middleware/upload');
const {
  listMine,
  uploadMine,
  listForEmployee,
  uploadForEmployee,
  download,
  remove,
  categories,
  setStatus,
  requestReplacement,
  myReplacementRequests,
  assignedReplacementRequests,
  decideReplacement,
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

const upload = createUpload({
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

// Document replacement requests — the employee raises one with the new file, the
// assigned HR (or a SuperAdmin) decides. Auth is enforced inside the handlers,
// so these sit outside the documents.manage capability gate (like field change
// requests): an HR partner can act even without the broad documents capability.
// GET /me/replace-requests — the caller's own requests.
router.get('/me/replace-requests', myReplacementRequests);
// POST /me/:id/replace-request — propose replacing a locked document (multer file).
router.post('/me/:id/replace-request', upload.single('file'), requestReplacement);
// GET /replace-requests/assigned — HR/Admin inbox.
router.get('/replace-requests/assigned', assignedReplacementRequests);
// PATCH /replace-requests/:id — approve (swap the file) / decline.
router.patch('/replace-requests/:id', decideReplacement);

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
