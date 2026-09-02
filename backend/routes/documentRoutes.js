/**
 * Document router — mounted at /api/documents.
 * Employee HR-document self-upload plus HR/Admin management, with
 * multer memory upload (10MB, PDF/image/Word allowlist by MIME or extension).
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

// Allowlist of common HR document types.
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
// ...and the extensions that mean the same thing. This route used to test the
// MIME string alone, which made it stricter than every sibling upload route for
// no reason: a client that labels a PDF anything other than the literal
// 'application/pdf' — 'application/octet-stream' from an Android file provider
// that could not identify it, 'application/x-pdf' from an older one, or an empty
// type — was rejected outright, and the message named a type the person never
// chose. The filename is the more reliable signal in exactly those cases.
const ALLOWED_EXTENSIONS = /\.(pdf|jpe?g|png|webp|heic|heif|docx?)$/i;

// 10 MB cap: a phone-scanned multi-page document (the Aadhaar/PAN/marksheet
// scans this endpoint exists to collect) routinely runs past 5 MB, and the
// PUBLIC submission link already accepts 10 MB for the very same files — so the
// old 5 MB here meant a document could be submitted through one door and not the
// other. See employeeRoutes docUpload.
const upload = createUpload({
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ALLOWED_MIMES.has(file.mimetype) || ALLOWED_EXTENSIONS.test(file.originalname || '');
    if (!ok) {
      return cb(new Error('Only PDF, Word or image files are accepted'));
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
