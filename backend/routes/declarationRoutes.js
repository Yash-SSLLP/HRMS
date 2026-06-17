const express = require('express');
const {
  getMine,
  saveMine,
  submitMine,
  listAll,
  reviewDeclaration,
} = require('../controllers/declarationController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// Employee self routes
router.get('/me', getMine);
router.post('/me', saveMine);
router.patch('/me/submit', submitMine);

// Admin routes
router.use(restrictTo('SuperAdmin', 'HRManager'));
router.get('/', listAll);
router.patch('/:id/status', reviewDeclaration);

module.exports = router;
