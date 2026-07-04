const express = require('express');
const multer = require('multer');
const {
  listJobs, createJob, updateJob, deleteJob,
  getPublicJob, submitApplication,
  listCandidates, createCandidate, updateCandidate, deleteCandidate,
  setRound, createRoundMeet, sendRoundMeetEmail, downloadResume, uploadResume,
  myInterviews, setMyInterviewRound, downloadMyInterviewResume,
  generateOffer, downloadOffer, onboardCandidate, updateOnboarding,
  generateAppointment, downloadAppointment, convertToEmployee,
  markOfferSent, markAppointmentSent, downloadLetterByToken, sendLetterEmail,
  requestDocuments, getDocumentRequest, submitDocuments,
  downloadCandidateDocument, confirmDocuments,
} = require('../controllers/recruitmentController');
const { protect, requirePermission, requireAnyPermission } = require('../middleware/authMiddleware');

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

// ----- Interviewer self-service (any signed-in employee) -----
router.get('/my-interviews', protect, myInterviews);
router.patch('/my-interviews/:id/round', protect, setMyInterviewRound);
router.get('/my-interviews/:id/resume', protect, downloadMyInterviewResume);

// ----- HR / Admin only — split into granular, SuperAdmin-grantable capabilities:
//   recruitment.jobs        → post/edit/delete jobs
//   recruitment.candidates  → candidate records, resumes, offers, onboarding, appointment
//   recruitment.interviews  → schedule / assign interview rounds
// Reads (lists, resume/letter downloads) need ANY of the three. -----
router.use(protect);

const canView = requireAnyPermission('recruitment.jobs', 'recruitment.candidates', 'recruitment.interviews');
const canJobs = requirePermission('recruitment.jobs');
const canCand = requirePermission('recruitment.candidates');
const canIntv = requirePermission('recruitment.interviews');

router.route('/jobs').get(canView, listJobs).post(canJobs, createJob);
router.route('/jobs/:id').put(canJobs, updateJob).delete(canJobs, deleteJob);

router.route('/candidates').get(canView, listCandidates).post(canCand, createCandidate);
router.get('/candidates/:id/resume', canView, downloadResume);
router.post('/candidates/:id/resume', canCand, resumeUpload.single('resume'), uploadResume);
router.patch('/candidates/:id/round', canIntv, setRound);
router.post('/candidates/:id/round/meet', canIntv, createRoundMeet);
router.post('/candidates/:id/round/meet/email', canIntv, sendRoundMeetEmail);

// Pre-offer document collection (HR)
router.post('/candidates/:id/documents/request', canCand, requestDocuments);
router.post('/candidates/:id/documents/confirm', canCand, confirmDocuments);
router.get('/candidates/:id/documents/:fileId', canView, downloadCandidateDocument);

// Offer → Onboarding → Appointment lifecycle
router.post('/candidates/:id/offer', canCand, generateOffer);
router.get('/candidates/:id/offer/pdf', canView, downloadOffer);
router.post('/candidates/:id/offer/mark-sent', canCand, markOfferSent);
router.post('/candidates/:id/letters/:kind/email', canCand, sendLetterEmail);
router.post('/candidates/:id/appointment/mark-sent', canCand, markAppointmentSent);
router.post('/candidates/:id/onboard', canCand, onboardCandidate);
router.patch('/candidates/:id/onboarding', canCand, updateOnboarding);
router.post('/candidates/:id/appointment', canCand, generateAppointment);
router.get('/candidates/:id/appointment/pdf', canView, downloadAppointment);
router.post('/candidates/:id/convert-to-employee', canCand, convertToEmployee);

router.route('/candidates/:id').put(canCand, updateCandidate).delete(canCand, deleteCandidate);

module.exports = router;
