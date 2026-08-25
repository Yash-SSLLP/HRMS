/**
 * Company router — mounted at /api/companies.
 *
 * The companies (legal entities) the HRMS runs for. Reading the list is open to
 * any authenticated user (it feeds dropdowns on the employee form and the CEO/MD
 * company assignment), and HR Managers read it on the Companies page.
 *
 * WRITES ARE THE BACKEND'S AND THE EXECUTIVES': a company is the executive's own
 * domain, so CEO/MD are named in the gate rather than reaching it through the
 * usual exec read-only rule. Listing them explicitly in `restrictTo` is what
 * makes their writes pass WITHOUT `execEditAccess` — the same deliberate
 * exception the advance-sanction route makes, and the reason it is spelled out
 * here. An HR Manager reads this page but cannot change it.
 *
 * A CEO/MD narrowed to certain companies (User.companies) may only touch those;
 * `assertCompanyScope` in the controller enforces it.
 */
const express = require('express');
const {
  listCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
} = require('../controllers/companyController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// GET / — list companies; any authenticated user (used for dropdowns).
router.get('/', listCompanies);

// Writes: the Backend and the executives. Naming CEO/MD here (rather than
// letting them fall through the exec read-only branch of restrictTo) is what
// lets a view-only executive change a company — see the note above.
const MAY_MANAGE = ['SuperAdmin', 'CEO', 'MD'];
router.post('/', restrictTo(...MAY_MANAGE), createCompany);
router.put('/:id', restrictTo(...MAY_MANAGE), updateCompany);
router.delete('/:id', restrictTo(...MAY_MANAGE), deleteCompany);

module.exports = router;
