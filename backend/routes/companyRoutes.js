/**
 * Company router — mounted at /api/companies.
 * The companies (legal entities) the HRMS runs for. Reading the list is open to
 * any authenticated user (it feeds dropdowns on the employee form and the CEO/MD
 * company assignment); creating, editing and deleting a company is reserved for
 * the Backend (SuperAdmin), like the other org-structure settings.
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

// Writes are Backend-only.
router.post('/', restrictTo('SuperAdmin'), createCompany);
router.put('/:id', restrictTo('SuperAdmin'), updateCompany);
router.delete('/:id', restrictTo('SuperAdmin'), deleteCompany);

module.exports = router;
