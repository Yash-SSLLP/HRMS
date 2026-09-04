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
const { isChatEnabled } = require('../middleware/chatEnabled');
// Company wall: RosterEntry.employee refs User, so the User-keyed scope helpers
// apply. Shift definitions themselves are shared config and stay global.
const { scopeUserField, cannotSeeUser, employeeProfileScope, allowedEmployeeIds } = require('../utils/employeeScope');
const EmployeeProfile = require('../models/EmployeeProfile');
const AuditLog = require('../models/AuditLog');
const { startOfDayIST } = require('../utils/dateHelpers');
const { crossesMidnight, shiftDurationMin, to12h } = require('../utils/shiftWindow');

const USER_FIELDS = 'firstName lastName';

// to12h now comes from utils/shiftWindow — the same formatter the punch paths,
// the worker and the admin UI use, so a shift can never be printed one way here
// and another way on the screen the employee is looking at.
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
    // connection exists between the two. Skipped while the chat module is off —
    // the notification and email above already carry the news, and a message
    // nobody can open is just invisible clutter.
    if (assignedBy && String(assignedBy._id) !== String(employee._id) && await isChatEnabled()) {
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

/**
 * Tell an employee their STANDING shift changed.
 *
 * Separate from notifyShiftAssignment above because that one is about one dated
 * day ("you are on nights on 12 September"). This is open-ended and has to read
 * that way, or somebody put on permanent nights is told about a single date and
 * turns up on the wrong evenings for the rest of the month.
 *
 * Best-effort: a delivery failure must never fail the assignment.
 */
async function notifyStandingShift({ employeeId, shift, assignedBy }) {
  try {
    if (!employeeId || !shift) return;
    const employee = await User.findById(employeeId).select('firstName lastName email');
    if (!employee) return;

    const label = `${shift.name}${shift.code ? ` (${shift.code})` : ''}`;
    const timing = shiftTiming(shift);
    // Without this an overnight shift reads as a fifteen-hour day running
    // backwards, and the employee's obvious reading of "7:00 PM – 4:00 AM" is
    // that they finish the same evening.
    const overnight = crossesMidnight(shift.startTime, shift.endTime)
      ? ' This shift ends the next morning.'
      : '';
    const fromName = assignedBy
      ? `${assignedBy.firstName || ''} ${assignedBy.lastName || ''}`.trim() || 'HR'
      : 'HR';
    const toFirst = employee.firstName || 'there';
    const body = `From now on you are on the ${shift.name} shift${timing}.${overnight}`;

    await notify({
      recipient: employee._id,
      type: 'shift',
      audience: 'employee',
      title: 'Your shift has changed',
      body,
      link: '/employee/shifts',
    });

    if (employee.email) {
      await enqueueMail({
        to: employee.email,
        subject: `Your shift has changed — ${label}`,
        text: [
          `Hi ${toFirst},`,
          '',
          `From now on you are on the ${label} shift${timing}.${overnight}`,
          '',
          'Your attendance — including when a check-in counts as late — is measured against these hours.',
          '',
          'You can view your shift anytime under "My Shifts" in the HRMS portal.',
          '',
          `- ${fromName}`,
        ].join('\n'),
        html: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;">
            <h2 style="color:#111827;margin:0 0 16px;">🕗 Your Shift Has Changed</h2>
            <p style="color:#374151;font-size:15px;line-height:1.6;">Hi ${toFirst},</p>
            <p style="color:#374151;font-size:15px;line-height:1.6;">
              From now on you are on the <strong>${label}</strong> shift${timing}.${overnight}
            </p>
            <p style="color:#374151;font-size:15px;line-height:1.6;">
              Your attendance — including when a check-in counts as late — is measured against these hours.
            </p>
            <p style="color:#6b7280;font-size:14px;margin-top:20px;">
              You can view your shift anytime under "My Shifts" in the HRMS portal.
            </p>
            <p style="color:#6b7280;font-size:14px;">- ${fromName}</p>
          </div>`,
      });
    }
  } catch (err) {
    console.error('standing shift notify failed:', err.message);
  }
}

// ===== Shifts (HR/Admin) =====
/**
 * List all shift definitions, newest first, each with how many employees stand
 * assigned to it and whether it runs past midnight.
 * @route GET /api/shifts  (HR/Admin)
 * @returns {{count: number, shifts: Object[]}} shifts with assignedCount,
 *   durationMin, crossesMidnight and 12-hour timing
 */
const listShifts = asyncHandler(async (req, res) => {
  const shifts = await Shift.find().sort({ createdAt: -1 }).lean();

  // Headcounts only count employees this viewer is allowed to see.
  // allowedEmployeeIds gives real ObjectIds because aggregate() does no ref
  // casting — the profile-scope fragment (string ids) cannot be $match-ed.
  const empIds = await allowedEmployeeIds(req);
  const counts = await EmployeeProfile.aggregate([
    { $match: { shiftRef: { $ne: null }, ...(empIds ? { _id: { $in: empIds } } : {}) } },
    { $group: { _id: '$shiftRef', n: { $sum: 1 } } },
  ]);
  const byId = {};
  counts.forEach((c) => { byId[String(c._id)] = c.n; });

  res.json({
    count: shifts.length,
    shifts: shifts.map((s) => ({
      ...s,
      assignedCount: byId[String(s._id)] || 0,
      durationMin: shiftDurationMin(s.startTime, s.endTime),
      // Lets the UI print "ends next day" instead of rendering 7:00 PM – 4:00 AM
      // as what looks like a fifteen-hour day running backwards.
      crossesMidnight: crossesMidnight(s.startTime, s.endTime),
      startLabel: to12h(s.startTime),
      endLabel: to12h(s.endTime),
    })),
  });
});

/**
 * List the employees standing-assigned to one shift.
 * @route GET /api/shifts/:id/employees  (HR/Admin)
 * @param {string} req.params.id - shift id
 * @returns {{count: number, employees: Object[]}} profiles with populated user
 */
const listShiftEmployees = asyncHandler(async (req, res) => {
  // Company wall applied INSIDE the handler, not left to the route gate:
  // makePermissionGuard waves a CEO/MD through on GET before hasPermission is
  // consulted, so a handler that trusted the gate would leak another company's
  // roster to a read-only executive.
  const employees = await EmployeeProfile.find({ shiftRef: req.params.id, ...employeeProfileScope(req) })
    .select('employeeCode designation department user company')
    .populate('user', 'firstName lastName email')
    .populate('company', 'name')
    .sort({ employeeCode: 1 })
    .lean();
  res.json({ count: employees.length, employees });
});

/**
 * Record who was moved onto (or off) a shift.
 *
 * Written from the resolved NAMES rather than through the auditStatus plugin,
 * which would store raw ObjectIds — an audit trail nobody can read is not an
 * audit trail. A standing shift decides late penalties and half-day status, so
 * by this codebase's own standard for anything that touches pay, moving someone
 * between shifts has to be answerable for.
 */
async function auditShiftAssignment({ profiles, toName, actor }) {
  const shiftNames = {};
  const refIds = [...new Set(profiles.map((p) => p.shiftRef && String(p.shiftRef)).filter(Boolean))];
  if (refIds.length) {
    const prior = await Shift.find({ _id: { $in: refIds } }).select('name').lean();
    prior.forEach((s) => { shiftNames[String(s._id)] = s.name; });
  }
  const byName = `${actor?.firstName || ''} ${actor?.lastName || ''}`.trim();
  await Promise.all(profiles.map((p) => {
    const from = p.shiftRef ? (shiftNames[String(p.shiftRef)] || 'Unknown shift') : 'None';
    if (from === toName) return null; // no-op re-assignment
    const who = `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.employeeCode || '';
    return AuditLog.create({
      entity: 'EmployeeProfile',
      entityId: p._id,
      entityLabel: who,
      field: 'Shift',
      fromStatus: from,
      toStatus: toName,
      by: actor?._id,
      byName,
      byRole: actor?.role,
      at: new Date(),
    }).catch(() => {});
  }).filter(Boolean));
}

/**
 * Put employees on a shift as their standing assignment.
 * @route POST /api/shifts/:id/assign  (HR/Admin)
 * @param {string} req.params.id - shift id
 * @param {string[]} req.body.employeeIds - EmployeeProfile ids (deduped)
 * @returns {{assigned: number}}
 * @sideeffect audits each change and notifies each employee (best-effort)
 */
const assignShift = asyncHandler(async (req, res) => {
  const shift = await Shift.findById(req.params.id);
  if (!shift) {
    res.status(404);
    throw new Error('Shift not found');
  }
  const ids = [...new Set((req.body.employeeIds || []).map(String))].filter(Boolean);
  if (!ids.length) {
    res.status(400);
    throw new Error('Select at least one employee to assign.');
  }

  // The scope goes in the QUERY, not just on the read above. The equivalent
  // work-location handler scopes its listing but not its updateMany, which
  // means a walled HR Manager can assign employees of a company they cannot
  // see by posting their ids directly. Silently skipping out-of-scope ids is
  // the right failure here: they are ids this viewer is not allowed to know
  // exist, so naming them in an error would leak exactly what the wall hides.
  const scope = employeeProfileScope(req);
  const targets = await EmployeeProfile.find({ _id: { $in: ids }, ...scope })
    .select('employeeCode shiftRef user')
    .populate('user', 'firstName lastName')
    .lean();

  const result = await EmployeeProfile.updateMany(
    { _id: { $in: targets.map((p) => p._id) } },
    { $set: { shiftRef: shift._id } }
  );
  res.json({ assigned: result.modifiedCount ?? targets.length });

  // After the response — a delivery hiccup must never fail the assignment.
  auditShiftAssignment({ profiles: targets, toName: shift.name, actor: req.user }).catch(() => {});
  targets
    .filter((p) => String(p.shiftRef || '') !== String(shift._id))
    .forEach((p) => notifyStandingShift({ employeeId: p.user?._id || p.user, shift, assignedBy: req.user }));
});

/**
 * Take employees off this shift, returning them to the org-wide hours.
 * @route POST /api/shifts/:id/unassign  (HR/Admin)
 * @param {string} req.params.id - shift id
 * @param {string[]} req.body.employeeIds - EmployeeProfile ids (deduped)
 * @returns {{unassigned: number}}
 */
const unassignShift = asyncHandler(async (req, res) => {
  const ids = [...new Set((req.body.employeeIds || []).map(String))].filter(Boolean);
  if (!ids.length) {
    res.status(400);
    throw new Error('Select at least one employee to remove.');
  }
  // Scoped for the same reason assignShift is, and additionally matched on this
  // shift so a stale tab cannot strip somebody's newer assignment.
  const targets = await EmployeeProfile.find({
    _id: { $in: ids }, shiftRef: req.params.id, ...employeeProfileScope(req),
  })
    .select('employeeCode shiftRef user')
    .populate('user', 'firstName lastName')
    .lean();

  const result = await EmployeeProfile.updateMany(
    { _id: { $in: targets.map((p) => p._id) } },
    { $unset: { shiftRef: '' } }
  );
  res.json({ unassigned: result.modifiedCount ?? 0 });

  auditShiftAssignment({ profiles: targets, toName: 'None', actor: req.user }).catch(() => {});
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
    if (req.query.from) filter.date.$gte = startOfDayIST(req.query.from);
    if (req.query.to) filter.date.$lte = startOfDayIST(req.query.to);
  }
  // Company wall: a walled admin only sees their own company's roster.
  await scopeUserField(req, filter, 'employee');
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
  // Company wall: a walled admin may only roster their own company's people.
  if (await cannotSeeUser(req, employee)) {
    res.status(404);
    throw new Error('Employee not found');
  }
  let entry = await RosterEntry.findOne({ employee, date: startOfDayIST(date) });
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
      date: startOfDayIST(date),
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
      date: startOfDayIST(date),
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
  // Company wall: 404 for another company's entry (existence stays hidden).
  if (!entry || await cannotSeeUser(req, entry.employee)) {
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
    if (req.query.from) filter.date.$gte = startOfDayIST(req.query.from);
    if (req.query.to) filter.date.$lte = startOfDayIST(req.query.to);
  }
  const entries = await RosterEntry.find(filter).populate('shift').sort({ date: 1 }).lean();

  // A standing shift is not a roster row, so without this an employee who was
  // told "from now on you are on the Night Shift" opens My Shifts — the screen
  // the notification points them at — and reads "No shifts scheduled".
  //
  // Synthesised here rather than in the two clients so the web page and the
  // mobile screen light up from the same payload and cannot disagree about
  // which days somebody is working.
  const profile = await EmployeeProfile.findOne({ user: req.user._id })
    .select('shiftRef')
    .populate('shiftRef')
    .lean();

  const rostered = new Set(entries.map((e) => startOfDayIST(e.date).getTime()));
  const synthetic = [];
  if (profile?.shiftRef && (req.query.from || req.query.to)) {
    // Only ever fills the window the caller asked for, so this cannot fan out:
    // an unbounded request returns roster rows alone, exactly as before.
    const from = startOfDayIST(req.query.from || req.query.to);
    const to = startOfDayIST(req.query.to || req.query.from);
    const DAY = 24 * 60 * 60 * 1000;
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      if (rostered.has(t)) continue; // a rostered day overrides the standing one
      synthetic.push({ _id: `standing-${t}`, date: new Date(t), shift: profile.shiftRef, source: 'standing' });
    }
  }

  const all = [...entries.map((e) => ({ ...e, source: 'roster' })), ...synthetic]
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((e) => ({
      ...e,
      // So a client can print "ends next day" instead of rendering
      // 7:00 PM – 4:00 AM as a fifteen-hour day running backwards.
      shift: e.shift ? { ...e.shift, crossesMidnight: crossesMidnight(e.shift.startTime, e.shift.endTime) } : e.shift,
    }));

  res.json({ count: all.length, entries: all, standingShift: profile?.shiftRef || null });
});

module.exports = {
  listShifts,
  listShiftEmployees,
  assignShift,
  unassignShift,
  createShift,
  updateShift,
  deleteShift,
  listRoster,
  assignRoster,
  deleteRoster,
  myRoster,
};
