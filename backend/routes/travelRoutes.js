const express = require('express');
const multer = require('multer');
const {
  listMine,
  createRequest,
  listAll,
  reviewRequest,
  reviewReimbursement,
  uploadReceipt,
  getReceipt,
} = require('../controllers/travelController');
const { protect, restrictTo, requirePermission } = require('../middleware/authMiddleware');

const router = express.Router();

// 5 MB cap; accept images or PDF for the reimbursement receipt.
const receiptUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Only image or PDF receipts are accepted'), ok);
  },
});

router.use(protect);

// Employee self routes
router.get('/me', listMine);
router.post('/', createRequest);
router.post('/:id/receipt', receiptUpload.single('receipt'), uploadReceipt);
// Receipt view is owner-or-admin (checked in the controller), so it sits before
// the admin-only gate below.
router.get('/:id/receipt', getReceipt);

// Admin routes
router.use(requirePermission('travel.manage'));

router.get('/', listAll);
router.patch('/:id/status', reviewRequest);
router.patch('/:id/reimbursement', reviewReimbursement);

module.exports = router;
