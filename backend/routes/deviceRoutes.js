const express = require('express');
const { registerDevice, unregisterDevice } = require('../controllers/deviceController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

router.post('/register', registerDevice);
router.delete('/:token', unregisterDevice);

module.exports = router;
