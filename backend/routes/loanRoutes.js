const express = require('express');
const {
  listMine, requestLoan, listAll, createForEmployee, reviewLoan, recordRepayment,
} = require('../controllers/loanController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// Employee self-service
router.get('/me', listMine);
router.post('/', requestLoan);

// HR/Admin
router.use(restrictTo('SuperAdmin', 'HRManager'));
router.get('/', listAll);
router.post('/admin', createForEmployee);
router.patch('/:id/status', reviewLoan);
router.patch('/:id/repay', recordRepayment);

module.exports = router;
