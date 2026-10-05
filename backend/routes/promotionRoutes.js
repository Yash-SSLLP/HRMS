/**
 * Promotions router — mounted at /api/promotions.
 * Readable and writable by SuperAdmin, CEO/MD and holders of 'employees.manage'
 * (controllers/promotionController.requirePromoter); God reads only.
 */
const express = require('express');
const {
  requirePromoter,
  promotionOptions,
  listPromotions,
  createPromotion,
  promotionLetterPdf,
} = require('../controllers/promotionController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);
router.use(requirePromoter);

// GET /options — employees, designations and departments for the form.
router.get('/options', promotionOptions);
// GET / — promotion history (?employee=<profileId>).
router.get('/', listPromotions);
// POST / — give a promotion { employee, designation, department?, effectiveDate?, remarks? }.
router.post('/', createPromotion);
// GET /:id/letter.pdf — the promotion (or transfer) letter for one promotion.
router.get('/:id/letter.pdf', promotionLetterPdf);

module.exports = router;
