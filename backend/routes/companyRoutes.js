/**
 * Company router — mounted at /api/companies.
 *
 * The companies (legal entities) the HRMS runs for. Reading the LIST stays open
 * to any authenticated user because it feeds dropdowns (the employee form, the
 * CEO/MD company assignment) — but the controller walls it, so a non-Backend
 * caller is only ever told about their own company.
 *
 * EVERYTHING ELSE IS THE BACKEND'S (SuperAdmin) ALONE — the Companies page,
 * its roster, and every write. This deliberately reverses the earlier
 * "CEO/MD may manage companies" exception: the user decided the Companies tab
 * is a Backend-only surface, so the routes match the nav.
 */
const express = require('express');
const {
  listCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  listCompanyEmployees,
  updateCompanyEmployees,
} = require('../controllers/companyController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(protect);

// GET / — list companies; any authenticated user (dropdowns; company-walled).
router.get('/', listCompanies);

// The Companies page and every write: Backend only. NOTE restrictTo would let
// CEO/MD read the roster through its exec-GET back door, so the roster uses an
// explicit inline gate instead.
const superAdminOnly = (req, res, next) => {
  if (req.user.role !== 'SuperAdmin') {
    res.status(403);
    return next(new Error('Companies are managed by the Backend account only.'));
  }
  next();
};
router.post('/', superAdminOnly, createCompany);
router.put('/:id', superAdminOnly, updateCompany);
router.delete('/:id', superAdminOnly, deleteCompany);

// Who belongs to a company — the roster behind the page's "Employees" button.
router.get('/:id/employees', superAdminOnly, listCompanyEmployees);
router.patch('/:id/employees', superAdminOnly, updateCompanyEmployees);

module.exports = router;
