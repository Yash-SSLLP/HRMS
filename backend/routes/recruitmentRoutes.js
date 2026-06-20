const express = require('express');
const multer = require('multer');
const {
  listJobs, createJob, updateJob, deleteJob,
  getPublicJob, submitApplication,
  listCandidates, createCandidate, updateCandidate, deleteCandidate,
  setRound, downloadResume,
  generateOffer, downloadOffer, onboardCandidate, updateOnboarding,
  generateAppointment, downloadAppointment,
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

// ----- Public application form (no auth) -----
router.get('/apply/:jobId', getPublicJob);
router.post('/apply/:jobId', resumeUpload.single('resume'), submitApplication);

// ----- HR / Admin only -----
router.use(protect, restrictTo('SuperAdmin', 'HRManager'));

router.route('/jobs').get(listJobs).post(createJob);
router.route('/jobs/:id').put(updateJob).delete(deleteJob);

router.route('/candidates').get(listCandidates).post(createCandidate);
router.get('/candidates/:id/resume', downloadResume);
router.patch('/candidates/:id/round', setRound);

// Offer → Onboarding → Appointment lifecycle
router.post('/candidates/:id/offer', generateOffer);
router.get('/candidates/:id/offer/pdf', downloadOffer);
router.post('/candidates/:id/onboard', onboardCandidate);
router.patch('/candidates/:id/onboarding', updateOnboarding);
router.post('/candidates/:id/appointment', generateAppointment);
router.get('/candidates/:id/appointment/pdf', downloadAppointment);

router.route('/candidates/:id').put(updateCandidate).delete(deleteCandidate);

module.exports = router;
