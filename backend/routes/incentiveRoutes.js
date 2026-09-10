/**
 * Incentive router — mounted at /api/incentives.
 *
 * The daily rolling incentive: who was on the team, how many sheets they rolled,
 * and what that earns in points.
 *
 * TWO ROLES, not one grant (see config/incentiveRoles.js). A MANAGER runs the
 * tab — the rates, the sheet counts, and correcting anything saved. A PICKER
 * puts together their own team for the day and nothing else: no sheet counts, no
 * rates, and no editing once it is saved, because a correction going through the
 * manager is what makes the record worth keeping. HR, CEO, MD and SuperAdmin are
 * managers of every incentive by role.
 *
 * CEO AND MD MAY WRITE HERE, an exception to the portal-wide rule that an exec
 * reads and does not change (user decision 2026-09-10) — they are managers in
 * `incentiveRole`, so it needs no separate gate. It costs them nothing elsewhere
 * and does NOT extend to the God audit login, which `protect` refuses every
 * unsafe method before any route is reached.
 *
 * Both API clients carry a matching exception (their view-only backstop would
 * otherwise stop a CEO/MD write before it left the browser). If this rule ever
 * changes, change it in three places: here, frontend/src/api/client.js and
 * mobile/src/api/client.js.
 */
const express = require('express');
const { createUpload } = require('../middleware/upload');
const ctrl = require('../controllers/incentiveController');
const {
  protect, requireIncentivePayer, requireIncentiveAccess, requireIncentiveManager,
} = require('../middleware/authMiddleware');

// This router IS the Boys tab. A second incentive gets its own router and its
// own module key; nothing here is shared by accident.
const MODULE = 'boys';

const router = express.Router();

// 2 MB cap; a month of rollings is a few hundred rows at most. Same allowlist as
// the calendar and employee imports.
const XLSX_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream', // some browsers send this for .xlsx
];
const sheetUpload = createUpload({
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = XLSX_MIME.includes(file.mimetype) || /\.xlsx$/i.test(file.originalname || '');
    cb(ok ? null : new Error('Upload an .xlsx file'), ok);
  },
});

router.use(protect);

// MY OWN points — BEFORE the capability gate below, and that placement is the
// whole point: a person who earns points does not hold `incentive.manage`, and
// their home screen still has to be able to show them their own total. The
// handler reads the caller's own employee record and takes no id, so it can see
// nobody else.
router.get('/me', ctrl.myPoints);

// Past here you need a role in this tab — manager or picker. Which one you hold
// decides what the handlers let you do.
router.use(requireIncentiveAccess(MODULE));

const managerOnly = requireIncentiveManager(MODULE);

// GET /people — who can be put on a team, the department list and the default
// department. Its own endpoint because GET /employees is role-gated and would
// 403 a standalone-grant holder.
router.get('/people', ctrl.listPeople);

// GET /settings — the default rate and default department.
router.get('/settings', ctrl.getSettings);
// PUT /settings — change them. Manager only: a picker records who worked, not
// what the work is worth.
router.put('/settings', managerOnly, ctrl.updateSettings);

// GET /template.xlsx — the rollings import template, seeded with real codes.
router.get('/template.xlsx', ctrl.downloadTemplate);
// GET /export.xlsx — recorded days + the per-person roll-up, one workbook.
router.get('/export.xlsx', ctrl.exportXlsx);
// POST /import — bulk-record days from a filled-in workbook (multipart `file`).
// Manager only: an upload carries sheet counts, which is the manager's entry.
router.post('/import', managerOnly, sheetUpload.single('file'), ctrl.importEntries);

// Paying people their points. A NARROWER gate than the rest of this router on
// purpose: recording the day's work is a supervisor's job, settling it is the
// company's. Reading the payment history is behind the same gate — it is the
// audit trail of what was handed over.
// GET /payments — every payment in a month.
router.get('/payments', requireIncentivePayer, ctrl.listPayments);
// POST /payments — pay people their points for a month, in full or in part.
router.post('/payments', requireIncentivePayer, ctrl.payPoints);
// DELETE /payments/:id — undo one payment.
router.delete('/payments/:id', requireIncentivePayer, ctrl.deletePayment);

// GET /summary — the same range rolled up per person: what each one earned.
router.get('/summary', ctrl.summary);

// GET / — the recorded team-days, newest first.
router.get('/', ctrl.listEntries);
// POST / — record one team's day. Manager OR picker; the handler then holds a
// picker to their own team and refuses them a sheet count.
router.post('/', ctrl.createEntry);
// PUT /:id — correct a recorded day. MANAGER ONLY: a picker cannot edit a team
// once it is saved, which is the point of having a picker role at all.
router.put('/:id', managerOnly, ctrl.updateEntry);
// DELETE /:id — remove a recorded day. Manager only, same reason.
router.delete('/:id', managerOnly, ctrl.deleteEntry);

module.exports = router;
