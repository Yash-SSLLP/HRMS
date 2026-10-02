/**
 * Training router — mounted at /api/training.
 * All routes require authentication (router.use(protect)).
 *
 * TWO HALVES (2026-10-02):
 *
 *   SELF-SERVICE, above the gate — authorised by IDENTITY inside the handler
 *   ("are you on this training?"), so any employee booked on a session can see
 *   it, join it, download its files and review it, whatever they hold:
 *     GET  /mine                       my sessions (participant or trainer)
 *     POST /:id/join                   open the meeting; records attendance
 *     POST /:id/feedback               my review, once it has taken place
 *     GET  /:id/files/:fileId          a handout (participants, trainer, managers)
 *
 *   RUNNING TRAINING, below the gate — `training.manage`, the WHOLE module as
 *   one grant ("whoever has access they can create that"). It is held three
 *   ways: the capability ticked for an HR Manager or Manager, the standalone
 *   User.trainingAccess switch a SuperAdmin turns on for ANY account, or the
 *   L&D Manager role. A CEO/MD (and the God audit login) read it all through
 *   the viewer exemption in makePermissionGuard and write nothing.
 *
 * Specific paths are declared before `/:id` so they are never read as an id.
 */
const express = require('express');
const {
  listTrainings, getTraining, listTrainingPeople, createTraining, updateTraining, deleteTraining,
  createTrainingMeet, uploadTrainingFiles, deleteTrainingFile, downloadTrainingFile,
  listCategories, createCategory, renameCategory, deleteCategory,
  myTrainings, joinTraining, submitFeedback, exportTrainings,
} = require('../controllers/trainingController');
const { protect, requirePermission } = require('../middleware/authMiddleware');
const { createUpload } = require('../middleware/upload');

const router = express.Router();
router.use(protect);

// Handouts: slides, PDFs, documents, spreadsheets, pictures. NOT video or
// audio — the bytes live in MongoDB (GridFS), next to every other record, and
// one week of uploaded recordings could fill the database the whole portal
// runs on. Recordings belong in Courses, which streams them from Cloudinary.
// Matched by MIME *or* extension — an Android file provider that cannot name a
// type sends application/octet-stream, and the filename is then the better
// signal (same reasoning as routes/documentRoutes.js).
const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/csv',
  'application/zip',
  'application/x-zip-compressed',
]);
const ALLOWED_EXTENSIONS = /\.(pdf|docx?|xlsx?|pptx?|txt|csv|zip|jpe?g|png|webp|gif|heic|heif)$/i;
const fileUpload = createUpload({
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const mime = String(file.mimetype || '');
    const ok = ALLOWED_MIMES.has(mime) || mime.startsWith('image/')
      || ALLOWED_EXTENSIONS.test(file.originalname || '');
    if (!ok) return cb(new Error('Attach PDFs, Office documents, pictures or zip files. Videos belong in Courses.'));
    cb(null, true);
  },
});

// ── Self-service: authorised by identity in the handler ──────────────────
router.get('/mine', myTrainings);
router.post('/:id/join', joinTraining);
router.post('/:id/feedback', submitFeedback);
router.get('/:id/files/:fileId', downloadTrainingFile);

// ── Running training: everything below needs 'training.manage' ───────────
router.use(requirePermission('training.manage'));
router.get('/', listTrainings);
router.get('/people', listTrainingPeople);
router.get('/export', exportTrainings);
router.get('/categories', listCategories);
router.post('/categories', createCategory);
router.put('/categories/:id', renameCategory);
router.delete('/categories/:id', deleteCategory);
router.post('/', createTraining);
router.get('/:id', getTraining);
router.put('/:id', updateTraining);
router.delete('/:id', deleteTraining);
router.post('/:id/meet', createTrainingMeet);
router.post('/:id/files', fileUpload.array('files', 10), uploadTrainingFiles);
router.delete('/:id/files/:fileId', deleteTrainingFile);

module.exports = router;
