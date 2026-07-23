/**
 * Shift controller — shift definitions (Shift) and the per-employee roster
 * (RosterEntry). HR manage shifts and assign roster days; assigning a new shift
 * notifies the employee across three channels (in-app+push, chat, email).
 * Employees read their own roster.
 */
const asyncHandler = require('express-async-handler');
const Shift = require('../models/Shift');
const RosterEntry = require('../models/RosterEntry');
const User = require('../models/User');
const Connection = require('../models/Connection');
const Message = require('../models/Message');
const { notify } = require('../services/notify');
const { enqueueMail } = require('../services/email');

const USER_FIELDS = 'firstName lastName';

// "HH:mm" (24h) → "h:mm AM/PM"
const to12h = (t) => {
  if (!t) return '';
  const [h, m] = String(t).split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${ampm}`;
};
const fmtDate = (d) =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
const shiftTiming = (s) =>
  s && s.startTime && s.endTime ? ` (${to12h(s.startTime)} – ${to12h(s.endTime)})` : '';

/**
 * Tell an employee they've been assigned to a shift, across three channels:
 * in-app notification (+ push), a chat message from the assigning HR/admin, and
 * email. All best-effort — a delivery hiccup must never fail the assignment.
 */
async function notifyShiftAssignment({ employeeId, shiftId, date, note, assignedBy }) {
  try {
    const [employee, shift] = await Promise.all([
      User.findById(employeeId).select('firstName lastName email'),
      Shift.findById(shiftId).select('name code startTime endTime'),
    ]);
    if (!employee || !shift) return;

    const when = fmtDate(date);
    const label = `${shift.name}${shift.code ? ` (${shift.code})` : ''}`;
    const timing = shiftTiming(shift);
    const fromName = assignedBy
      ? `${assignedBy.firstName || ''} ${assignedBy.lastName || ''}`.trim() || 'HR'
      : 'HR';
    const toFirst = employee.firstName || 'there';
    const body = `You have been assigned to the ${shift.name} shift${timing} on ${when}.${note ? ` Note: ${note}` : ''}`;

    // 1) In-app notification + push (employee portal).
    await notify({
      recipient: employee._id,
      type: 'shift',
      audience: 'employee',
      title: 'New shift assigned',
      body,
      link: '/employee/shifts',
    });

    // 2) Chat message from the assigning HR/admin, so it lands in the employee's
    // inbox as a real conversation they can reply to. Ensure an accepted
    // connection exists between the two.
    if (assignedBy && String(assignedBy._id) !== String(employee._id)) {
      try {
        const pairKey = Connection.buildPairKey(assignedBy._id, employee._id);
        let conn = await Connection.findOne({ pairKey });
        if (!conn) {
          conn = await Connection.create({
            requester: assignedBy._id,
            recipient: employee._id,
            status: 'accepted',
          });
        } else if (conn.status !== 'accepted') {
          conn.status = 'accepted';
          await conn.save();
        }
        await Message.create({
          connection: conn._id,
          sender: assignedBy._id,
          body: `🗓️ ${body}`,
        });
      } catch (err) {
        console.error('shift chat delivery failed:', err.message);
      }
    }

    // 3) Email.
    if (employee.email) {
      await enqueueMail({
        to: employee.email,
        subject: `New shift assigned — ${label} on ${when}`,
        text: [
          `Hi ${toFirst},`,
          '',
          `You have been assigned to the ${label} shift${timing} on ${when}.`,
          note ? `Note: ${note}` : '',
          '',
          'You can view your roster anytime under "My Shifts" in the HRMS portal.',
          '',
          `- ${fromName}`,
        ].filter(Boolean).join('\n'),
        html: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
            <h2 style="color:#111827;margin:0 0 16px;">🗓️ New Shift Assigned</h2>
            <p style="color:#374151;font-size:15px;line-height:1.6;">Hi ${toFirst},</p>
            <p style="color:#374151;font-size:15px;line-height:1.6;">
              You have been assigned to the <strong>${label}</strong> shift${timing} on <strong>${when}</strong>.
            </p>
            ${note ? `<p style="color:#374151;font-size:15px;line-height:1.6;">Note: ${note}</p>` : ''}
            <p style="color:#6b7280;font-size:14px;margin-top:20px;">
              You can view your roster anytime under "My Shifts" in the HRMS portal.
            </p>
            <p style="color:#6b7280;font-size:14px;">- ${fromName}</p>
          </div>`,
      });
    }
  } catch (err) {
    console.error('shift assignment notify failed:', err.message);
  }
}

// ===== Shifts (HR/Admin) =====
/**
 * List all shift definitions, newest first.
 * @route GET /api/shifts  (HR/Admin)
 * @returns {{count: number, shifts: Object[]}}
 */
const listShifts = asyncHandler(async (req, res) => {
  const shifts = await Shift.find().sort({ createdAt: -1 });
  res.json({ count: shifts.length, shifts });
});

/**
 * Create a shift definition.
 * @route POST /api/shifts  (HR/Admin)
 * @param {string} req.body.name - required
 * @returns {{shift: Object}} (201)
 */
const createShift = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400);
    throw new Error('name is required');
  }
  const shift = await Shift.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ shift });
});

/**
 * Update a shift definition (partial).
 * @route PUT /api/shifts/:id  (HR/Admin)
 * @param {string} req.params.id - shift id
 * @param {Object} req.body - fields to update
 * @returns {{shift: Object}}
 */
const updateShift = asyncHandler(async (req, res) => {
  const shift = await Shift.findById(req.params.id);
  if (!shift) {
    res.status(404);
    throw new Error('Shift not found');
  }
  // Prevent clients from overwriting the original creator
  delete req.body.createdBy;
  Object.assign(shift, req.body);
  await shift.save();
  res.json({ shift });
});

/**
 * Delete a shift definition by id.
 * @route DELETE /api/shifts/:id  (HR/Admin)
 * @param {string} req.params.id - shift id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteShift = asyncHandler(async (req, res) => {
  const shift = await Shift.findById(req.params.id);
  if (!shift) {
    res.status(404);
    throw new Error('Shift not found');
  }
  await shift.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Roster (HR/Admin) =====
/**
 * List roster entries with optional employee/date-range filters.
 * @route GET /api/shifts/roster  (HR/Admin)
 * @param {string} [req.query.employee]
 * @param {string} [req.query.from]
 * @param {string} [req.query.to]
 * @returns {{count: number, entries: Object[]}} with populated employee/shift
 */
const listRoster = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employee) filter.employee = req.query.employee;
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = new Date(req.query.from);
    if (req.query.to) filter.date.$lte = new Date(req.query.to);
  }
  const entries = await RosterEntry.find(filter)
    .populate('employee', USER_FIELDS)
    .populate('shift')
    .sort({ date: 1 });
  res.json({ count: entries.length, entries });
});

/**
 * Assign (or update) an employee's shift for a date; notifies on a shift change.
 * @route POST /api/shifts/roster  (HR/Admin)
 * @param {string} req.body.employee - required
 * @param {string} req.body.date - required
 * @param {string} req.body.shift - required
 * @param {string} [req.body.note]
 * @returns {{entry: Object}} (201)
 * @sideeffect fires notifyShiftAssignment (in-app+push, chat, email) only when the shift actually changes
 */
const assignRoster = asyncHandler(async (req, res) => {
  const { employee, date, shift, note } = req.body;
  if (!employee || !date || !shift) {
    res.status(400);
    throw new Error('employee, date and shift are required');
  }
  let entry = await RosterEntry.findOne({ employee, date: new Date(date) });
  let shiftChanged;
  if (entry) {
    shiftChanged = String(entry.shift) !== String(shift);
    entry.shift = shift;
    if (note !== undefined) entry.note = note;
    await entry.save();
  } else {
    shiftChanged = true; // brand-new assignment
    entry = await RosterEntry.create({
      employee,
      date: new Date(date),
      shift,
      note,
      createdBy: req.user._id,
    });
  }
  res.status(201).json({ entry });

  // Only notify when the employee lands on a *new* shift (skip no-op re-saves,
  // e.g. editing just the note). Runs after the response — best-effort.
  if (shiftChanged) {
    notifyShiftAssignment({
      employeeId: employee,
      shiftId: shift,
      date: new Date(date),
      note,
      assignedBy: req.user,
    });
  }
});

/**
 * Delete a roster entry by id.
 * @route DELETE /api/shifts/roster/:id  (HR/Admin)
 * @param {string} req.params.id - roster entry id
 * @returns {{id: string, deleted: boolean}}
 */
const deleteRoster = asyncHandler(async (req, res) => {
  const entry = await RosterEntry.findById(req.params.id);
  if (!entry) {
    res.status(404);
    throw new Error('Roster entry not found');
  }
  await entry.deleteOne();
  res.json({ id: req.params.id, deleted: true });
});

// ===== Roster (Employee self-service) =====
/**
 * List the caller's own roster entries with optional date range.
 * @route GET /api/shifts/roster/me
 * @param {string} [req.query.from]
 * @param {string} [req.query.to]
 * @returns {{count: number, entries: Object[]}} with populated shift
 */
const myRoster = asyncHandler(async (req, res) => {
  const filter = { employee: req.user._id };
  if (req.query.from || req.query.to) {
    filter.date = {};
    if (req.query.from) filter.date.$gte = new Date(req.query.from);
    if (req.query.to) filter.date.$lte = new Date(req.query.to);
  }
  const entries = await RosterEntry.find(filter).populate('shift').sort({ date: 1 });
  res.json({ count: entries.length, entries });
});

module.exports = {
  listShifts,
  createShift,
  updateShift,
  deleteShift,
  listRoster,
  assignRoster,
  deleteRoster,
  myRoster,
};
