const express = require('express');
const multer = require('multer');
const {
  listJobs, createJob, updateJob, deleteJob,
  getPublicJob, submitApplication,
  listCandidates, createCandidate, updateCandidate, deleteCandidate,
  setRound, createRoundMeet, downloadResume, uploadResume,
  generateOffer, downloadOffer, onboardCandidate, updateOnboarding,
  generateAppointment, downloadAppointment, convertToEmployee,
  markOfferSent, markAppointmentSent, downloadLetterByToken,
  requestDocuments, getDocumentRequest, submitDocuments,
  downloadCandidateDocument, confirmDocuments,
} = require('../controllers/recruitmentController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

// Resume upload: 5 MB cap; accept PDF / DOC / DOCX only.
const RESUME_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = RESUME_TYPES.includes(file.mimetype) || /\.(pdf|docx?|)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF or Word documents are accepted'), ok);
  },
});

// Candidate document upload: up to 20 files, 10 MB each; PDF / Word / JPG / PNG.
const DOC_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg',
  'image/png',
];
const docUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = DOC_TYPES.includes(file.mimetype) || /\.(pdf|docx?|jpe?g|png)$/i.test(file.originalname);
    cb(ok ? null : new Error('Only PDF, Word, JPG or PNG files are accepted'), ok);
  },
});

// ----- Public application form (no auth) -----
router.get('/apply/:jobId', getPublicJob);
router.post('/apply/:jobId', resumeUpload.single('resume'), submitApplication);

// ----- Public candidate document submission (no auth, tokenised) -----
router.get('/documents/:token', getDocumentRequest);
router.post('/documents/:token', docUpload.array('files', 20), submitDocuments);

// ----- Public letter download (no auth, tokenised) -----
router.get('/letters/:token', downloadLetterByToken);

// ----- HR / Admin only -----
router.use(protect, restrictTo('SuperAdmin', 'HRManager'));

router.route('/jobs').get(listJobs).post(createJob);
router.route('/jobs/:id').put(updateJob).delete(deleteJob);

router.route('/candidates').get(listCandidates).post(createCandidate);
router.get('/candidates/:id/resume', downloadResume);
router.post('/candidates/:id/resume', resumeUpload.single('resume'), uploadResume);
router.patch('/candidates/:id/round', setRound);
router.post('/candidates/:id/round/meet', createRoundMeet);

// Pre-offer document collection (HR)
router.post('/candidates/:id/documents/request', requestDocuments);
router.post('/candidates/:id/documents/confirm', confirmDocuments);
router.get('/candidates/:id/documents/:fileId', downloadCandidateDocument);

// Offer → Onboarding → Appointment lifecycle
router.post('/candidates/:id/offer', generateOffer);
router.get('/candidates/:id/offer/pdf', downloadOffer);
router.post('/candidates/:id/offer/mark-sent', markOfferSent);
router.post('/candidates/:id/appointment/mark-sent', markAppointmentSent);
router.post('/candidates/:id/onboard', onboardCandidate);
router.patch('/candidates/:id/onboarding', updateOnboarding);
router.post('/candidates/:id/appointment', generateAppointment);
router.get('/candidates/:id/appointment/pdf', downloadAppointment);
router.post('/candidates/:id/convert-to-employee', convertToEmployee);

router.route('/candidates/:id').put(updateCandidate).delete(deleteCandidate);

module.exports = router;
