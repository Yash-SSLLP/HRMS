const express = require('express');
const { signup, login, me, updateMyCredentials } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.post('/signup', signup);
router.post('/login', login);
router.get('/me', protect, me);
router.patch('/me/credentials', protect, updateMyCredentials);

module.exports = router;
