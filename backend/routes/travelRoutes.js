/**
 * Travel router — mounted at /api/travel.
 * Travel requests + reimbursement receipts (multer 5MB image/PDF)
 * for employees, plus HR/Admin review of requests and reimbursements.
 * All routes require authentication (router.use(protect)).
 */
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
// GET /me — current user's travel requests; protected.
router.get('/me', listMine);
// POST / — create a travel request; protected.
router.post('/', createRequest);
// POST /:id/receipt — upload reimbursement receipt; protected + multer single 'receipt' (5MB image/PDF).
router.post('/:id/receipt', receiptUpload.single('receipt'), uploadReceipt);
// Receipt view is owner-or-admin (checked in the controller), so it sits before
// the admin-only gate below.
// GET /:id/receipt — view a reimbursement receipt; protected (owner or admin, checked in controller).
router.get('/:id/receipt', getReceipt);

// Admin routes — everything below requires the 'travel.manage' permission.
router.use(requirePermission('travel.manage'));

// GET / — list all travel requests; protected, requires 'travel.manage'.
router.get('/', listAll);
// PATCH /:id/status — approve/reject a travel request; protected, requires 'travel.manage'.
router.patch('/:id/status', reviewRequest);
// PATCH /:id/reimbursement — review a reimbursement claim; protected, requires 'travel.manage'.
router.patch('/:id/reimbursement', reviewReimbursement);

module.exports = router;
