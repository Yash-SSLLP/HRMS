const express = require('express');
const {
  listRecognitions, listPeople, giveRecognition, listMine,
} = require('../controllers/recognitionController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Peer-to-peer recognition — available to every authenticated user.
router.get('/people', listPeople);
router.get('/me', listMine);
router.route('/').get(listRecognitions).post(giveRecognition);

module.exports = router;
