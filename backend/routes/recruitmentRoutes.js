/**
 * Recruitment router — mounted at /api/recruitment.
 * ATS: public job apply + tokenised candidate document/letter flows,
 * interviewer self-service, and HR/Admin jobs/candidates/interviews
 * management with resume/document multer uploads. Access split across
 * recruitment.jobs / .candidates / .interviews permissions.
 */
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
// GET /apply/:jobId — public job posting; public.
router.get('/apply/:jobId', getPublicJob);
// POST /apply/:jobId — submit application; public + multer single 'resume' (5MB PDF/Word).
router.post('/apply/:jobId', resumeUpload.single('resume'), submitApplication);

// ----- Public candidate document submission (no auth, tokenised) -----
// GET /documents/:token — load document-request context; public (token-scoped).
router.get('/documents/:token', getDocumentRequest);
// POST /documents/:token — upload requested documents; public + multer array 'files' (max 20, 10MB each).
router.post('/documents/:token', docUpload.array('files', 20), submitDocuments);

// ----- Public letter download (no auth, tokenised) -----
// GET /letters/:token — download offer/appointment letter; public (token-scoped).
router.get('/letters/:token', downloadLetterByToken);

// ----- Interviewer self-service (any signed-in employee) -----
// GET /my-interviews — interviews assigned to the current user; protected.
router.get('/my-interviews', protect, myInterviews);
// PATCH /my-interviews/:id/round — record interview round result; protected.
router.patch('/my-interviews/:id/round', protect, setMyInterviewRound);
// GET /my-interviews/:id/resume — download candidate resume for own interview; protected.
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

// GET /jobs — list jobs (canView); POST /jobs — create job (recruitment.jobs); protected.
router.route('/jobs').get(canView, listJobs).post(canJobs, createJob);
// PUT/DELETE /jobs/:id — update/delete job; protected, requires 'recruitment.jobs'.
router.route('/jobs/:id').put(canJobs, updateJob).delete(canJobs, deleteJob);

// GET /candidates — list (canView); POST /candidates — create (recruitment.candidates); protected.
router.route('/candidates').get(canView, listCandidates).post(canCand, createCandidate);
// GET /candidates/:id/resume — download resume; protected, requires any recruitment perm.
router.get('/candidates/:id/resume', canView, downloadResume);
// POST /candidates/:id/resume — replace resume; protected, requires 'recruitment.candidates' + multer single 'resume'.
router.post('/candidates/:id/resume', canCand, resumeUpload.single('resume'), uploadResume);
// PATCH /candidates/:id/round — set interview round; protected, requires 'recruitment.interviews'.
router.patch('/candidates/:id/round', canIntv, setRound);
// POST /candidates/:id/round/meet — create round meeting link; protected, requires 'recruitment.interviews'.
router.post('/candidates/:id/round/meet', canIntv, createRoundMeet);
// POST /candidates/:id/round/meet/email — email round meeting invite; protected, requires 'recruitment.interviews'.
router.post('/candidates/:id/round/meet/email', canIntv, sendRoundMeetEmail);

// Pre-offer document collection (HR)
// POST /candidates/:id/documents/request — send document request; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/documents/request', canCand, requestDocuments);
// POST /candidates/:id/documents/confirm — confirm submitted documents; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/documents/confirm', canCand, confirmDocuments);
// GET /candidates/:id/documents/:fileId — download a candidate document; protected, requires any recruitment perm.
router.get('/candidates/:id/documents/:fileId', canView, downloadCandidateDocument);

// Offer → Onboarding → Appointment lifecycle
// POST /candidates/:id/offer — generate offer letter; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/offer', canCand, generateOffer);
// GET /candidates/:id/offer/pdf — download offer PDF; protected, requires any recruitment perm.
router.get('/candidates/:id/offer/pdf', canView, downloadOffer);
// POST /candidates/:id/offer/mark-sent — mark offer as sent; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/offer/mark-sent', canCand, markOfferSent);
// POST /candidates/:id/letters/:kind/email — email an offer/appointment letter; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/letters/:kind/email', canCand, sendLetterEmail);
// POST /candidates/:id/appointment/mark-sent — mark appointment as sent; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/appointment/mark-sent', canCand, markAppointmentSent);
// POST /candidates/:id/onboard — start onboarding; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/onboard', canCand, onboardCandidate);
// PATCH /candidates/:id/onboarding — update onboarding progress; protected, requires 'recruitment.candidates'.
router.patch('/candidates/:id/onboarding', canCand, updateOnboarding);
// POST /candidates/:id/appointment — generate appointment letter; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/appointment', canCand, generateAppointment);
// GET /candidates/:id/appointment/pdf — download appointment PDF; protected, requires any recruitment perm.
router.get('/candidates/:id/appointment/pdf', canView, downloadAppointment);
// POST /candidates/:id/convert-to-employee — convert candidate to employee; protected, requires 'recruitment.candidates'.
router.post('/candidates/:id/convert-to-employee', canCand, convertToEmployee);

// PUT/DELETE /candidates/:id — update/delete candidate; protected, requires 'recruitment.candidates'.
router.route('/candidates/:id').put(canCand, updateCandidate).delete(canCand, deleteCandidate);

module.exports = router;
