/**
 * Report export router — mounted at /api/reports.
 * Generic tabular → .xlsx conversion for client-loaded report data.
 */
const express = require('express');
const { tableToXlsx } = require('../controllers/reportExportController');
const { protect } = require('../middleware/authMiddleware');

const router = express.Router();

router.use(protect);

// POST /xlsx — convert a client-supplied table into an Excel workbook download.
router.post('/xlsx', tableToXlsx);

module.exports = router;
