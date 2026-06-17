const express = require('express');
const {
  listJobs, createJob, updateJob, deleteJob,
  listCandidates, createCandidate, updateCandidate, deleteCandidate,
} = require('../controllers/recruitmentController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect, restrictTo('SuperAdmin', 'HRManager'));

router.route('/jobs').get(listJobs).post(createJob);
router.route('/jobs/:id').put(updateJob).delete(deleteJob);

router.route('/candidates').get(listCandidates).post(createCandidate);
router.route('/candidates/:id').put(updateCandidate).delete(deleteCandidate);

module.exports = router;
