/**
 * The attendance report workbook — everything HR asks about a stretch of days,
 * in one download.
 *
 * Before this the export was one sheet of raw attendance rows, so the questions
 * HR actually asks ("who worked a Sunday, was it approved?", "who was on WFH?",
 * "whose days were regularized, and by whom?") meant cross-checking three other
 * screens. Now one file carries:
 *
 *   Summary           one row per employee — every count for the window
 *   Daily             EVERY calendar day per employee, including the days with
 *                     no punch at all (which never had a row before), with the
 *                     day type, leave, regularization and 2× duty beside it
 *   Sunday & Holiday  every Sunday / holiday that was actually worked, and
 *                     where its double-pay claim stands
 *   WFH               every day punched as work-from-home
 *   Outside Punches   every punch made beyond the employee's geofence — distance,
 *                     how far outside, GPS accuracy and a map link
 *   Regularizations   every request for a day in the window, any status
 *   Leave             every leave request touching the window, any status
 *   Worked on Leave   punches made on an approved-leave day, and the decision
 *
 * Pure: the controller loads the data (and does the scoping); this only shapes
 * it, so the admin and manager exports cannot drift apart.
 */
const ExcelJS = require('exceljs');
const { ymdIST } = require('../utils/dateHelpers');
const { lateMinutes } = require('../utils/workday');
const { formatDuration } = require('../utils/duration');
const { haversineMeters } = require('../utils/geo');
const { COMP_OFF, compOffKeysFor, doublePayState, restDayCredit, isSundayKey } = require('../utils/restDay');
const { HIDDEN_ROLES } = require('../utils/visibility');

const DAY_MS = 86400000;

const fmtTime = (d) => (d
  ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' })
  : '');
const fmtDateTime = (d) => (d
  ? new Date(d).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  })
  : '');
const personName = (u) => [u?.firstName, u?.lastName].filter(Boolean).join(' ');

// 'YYYY-MM-DD' → the same key n days later. Done on UTC parts so it never
// depends on the server's timezone.
function addDaysKey(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// 'YYYY-MM-DD' → '05 Sep' — short enough to list a month of dates in one cell.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDay = (key) => `${key.slice(8, 10)} ${MON[Number(key.slice(5, 7)) - 1]}`;
// 'YYYY-MM-DD' → '05-09-2026' for the period columns.
const dmy = (key) => `${key.slice(8, 10)}-${key.slice(5, 7)}-${key.slice(0, 4)}`;
const dateList = (keys) => keys.map(shortDay).join(', ');
function weekdayOfKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
}

// Header row: bold, grey, frozen, filterable — the house style for exports.
function addSheet(wb, name, columns) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map(([header, width]) => ({ header, width }));
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.alignment = { vertical: 'middle', wrapText: true };
  head.height = 30;
  head.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F4F5' } };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD4D4D8' } } };
  });
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

// A short "nothing here" line so an empty sheet reads as checked, not broken.
function noteIfEmpty(ws, text) {
  if (ws.rowCount <= 1) ws.addRow([text]).font = { italic: true, color: { argb: 'FF71717A' } };
}

/**
 * Build the workbook.
 * @param {Object} data
 * @param {Array<Object>} data.profiles   EmployeeProfiles (user, workLocationRef, company populated)
 * @param {Array<Object>} data.records    Attendance rows in the window (doublePay/workOnLeave deciders populated)
 * @param {Array<Object>} data.holidays   Holiday docs covering the window
 * @param {Array<Object>} data.regularizations  Regularization requests dated in the window (reviewedBy populated)
 * @param {Array<Object>} data.leaves     LeaveRequests touching the window (approver populated)
 * @param {Object} data.settings          Setting singleton (geofence)
 * @param {Function} data.resolveGeofence (profile, settings) → {center, radiusM, exempt}
 * @param {Date} data.start               first instant of the window (IST midnight)
 * @param {Date} data.end                 exclusive end, already capped at end of today
 * @param {Object} [data.viewer]          req.user — a SuperAdmin decider shows as "the Backend" to anyone else
 * @param {string} [data.title]           e.g. "September 2026" — printed atop the Summary
 * @returns {ExcelJS.Workbook}
 */
function buildAttendanceReport(data) {
  const {
    profiles, records, holidays, regularizations, leaves, settings, resolveGeofence,
    start, end, viewer, title,
  } = data;

  // Who a decision is shown as — the same masking the on-screen claim lists use.
  const seesBackend = viewer?.role === 'SuperAdmin';
  const actorName = (u, fallback = '') => {
    if (!u) return fallback;
    if (!seesBackend && HIDDEN_ROLES.includes(u.role)) return 'the Backend';
    return personName(u) || fallback;
  };

  const todayKey = ymdIST(new Date());
  const firstKey = ymdIST(start);
  const lastKey = ymdIST(new Date(end.getTime() - 1)); // inclusive
  const windowKeys = [];
  for (let k = firstKey; k <= lastKey; k = addDaysKey(k, 1)) windowKeys.push(k);

  // ---- calendar --------------------------------------------------------------
  const compOffKeys = compOffKeysFor(holidays);
  const holidayByKey = new Map();
  (holidays || []).forEach((h) => holidayByKey.set(ymdIST(h.date), h));
  const dayType = (key) => {
    const h = holidayByKey.get(key);
    if (h) return h.type === COMP_OFF ? `Comp Off – ${h.name}` : `Holiday – ${h.name}`;
    if (isSundayKey(key)) return 'Sunday';
    return 'Working day';
  };
  const isOffDay = (key) => isSundayKey(key) || holidayByKey.has(key);

  // ---- index everything by employee + day --------------------------------------
  const profileById = new Map(profiles.map((p) => [String(p._id), p]));
  const profileByUser = new Map(profiles.filter((p) => p.user).map((p) => [String(p.user._id || p.user), p]));

  const recordByEmpDay = new Map();
  records.forEach((r) => {
    const id = String(r.employee?._id || r.employee);
    recordByEmpDay.set(`${id}|${ymdIST(r.date)}`, r);
  });

  // Approved leave per employee-day (the leave a day sits inside).
  const leaveByEmpDay = new Map();
  (leaves || []).filter((l) => l.status === 'Approved').forEach((l) => {
    const id = String(l.employee?._id || l.employee);
    const to = ymdIST(l.endDate);
    for (let k = ymdIST(l.startDate); k <= to; k = addDaysKey(k, 1)) {
      if (k >= firstKey && k <= lastKey) leaveByEmpDay.set(`${id}|${k}`, l);
    }
  });

  // Regularizations per employee-day — the latest request for the day wins the
  // Daily column; the Regularizations sheet lists every one.
  const regByEmpDay = new Map();
  [...(regularizations || [])]
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .forEach((g) => {
      const p = profileByUser.get(String(g.employee?._id || g.employee));
      if (p) regByEmpDay.set(`${p._id}|${ymdIST(g.date)}`, g);
    });

  const regText = (g) => {
    if (!g) return '';
    const by = g.status === 'Pending' ? '' : actorName(g.reviewedBy, lastDecider(g));
    return `${g.status} – ${g.type}${by ? ` (by ${by})` : ''}`;
  };
  // Who decided a regularization that has no reviewedBy stamp: the last rung
  // that ruled on its ladder.
  function lastDecider(g) {
    const steps = (g.approvalChain || []).filter((s) => s.status === 'Approved' || s.status === 'Rejected');
    return steps.length ? steps[steps.length - 1].approverName || '' : '';
  }

  const wfhText = (r) => {
    if (!r) return '';
    if (r.checkInWfh && r.checkOutWfh) return 'In & Out';
    if (r.checkInWfh) return 'In';
    if (r.checkOutWfh) return 'Out';
    return '';
  };

  // Where one punch was made, judged against the employee's own geofence (their
  // work location, else the office) — the same rule the attendance screens use:
  // a WFH punch and a "punch from anywhere" grant are never "outside".
  //   where: Inside | Outside | WFH | Anywhere allowed | No GPS
  const punchPlace = (r, p, kind) => {
    const at = kind === 'in' ? r?.checkIn : r?.checkOut;
    if (!r || !at) return null;
    const loc = kind === 'in' ? r.checkInLocation : r.checkOutLocation;
    const isWfh = kind === 'in' ? r.checkInWfh : r.checkOutWfh;
    const geo = resolveGeofence(p, settings);
    const d = haversineMeters(geo.center, loc);
    const distanceM = d == null ? null : Math.round(d);
    let where;
    if (distanceM == null) where = 'No GPS';
    else if (isWfh) where = 'WFH';
    else if (geo.exempt) where = 'Anywhere allowed';
    else if (geo.radiusM && distanceM > geo.radiusM) where = 'Outside';
    else where = 'Inside';
    return {
      kind, at, where, distanceM,
      radiusM: geo.radiusM || null,
      outsideByM: where === 'Outside' ? distanceM - geo.radiusM : null,
      locationName: geo.label || '',
      accuracyM: loc?.accuracy != null ? Math.round(loc.accuracy) : null,
      mapUrl: loc?.lat != null && loc?.lng != null ? `https://www.google.com/maps?q=${loc.lat},${loc.lng}` : null,
    };
  };
  const mapCell = (pl) => (pl?.mapUrl ? { text: 'Open map', hyperlink: pl.mapUrl } : '');
  const distText = (m) => {
    if (m == null) return '';
    return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
  };
  // Hyperlink cells read as links (blue, underlined).
  const styleLinks = (row) => row.eachCell((cell) => {
    if (cell.value && cell.value.hyperlink) cell.font = { color: { argb: 'FF2563EB' }, underline: true };
  });

  const leaveText = (l) => (l ? `${l.leaveType}${l.isHalfDay ? ' (half day)' : ''}` : '');

  // ---- order employees by code ---------------------------------------------------
  const people = [...profiles].sort((a, b) => (a.employeeCode || '').localeCompare(b.employeeCode || '', undefined, { numeric: true }));
  const nameOf = (p) => personName(p.user);
  const empCells = (p) => [p.employeeCode || '', nameOf(p), p.department || '', p.designation || ''];

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sequence - HRMS';
  wb.created = new Date();

  // ================= Summary =================
  const summary = addSheet(wb, 'Summary', [
    ['Employee Code', 14], ['Name', 22], ['Department', 16], ['Designation', 18], ['Company', 18],
    ['From', 11], ['To', 11], ['Days on Roll', 9], ['Working Days', 9], ['Present', 9], ['Half Day', 9], ['Absent', 9],
    ['On Leave', 9], ['No Punch (LOP)', 10], ['Late Days', 9], ['Total Late', 11],
    ['No Punch-Out', 10], ['WFH Days', 9], ['Outside Punch Days', 10], ['Outside Punches', 10], ['Farthest Outside', 11], ['Total Hours', 10],
    ['Sundays Worked', 10], ['Holidays Worked', 10], ['2× Approved (days)', 11], ['2× Pending', 9], ['2× Rejected', 9],
    ['Regularized (Approved)', 12], ['Regularization Pending', 12], ['Regularization Rejected', 12],
    ['Leave Days Approved', 10], ['Worked on Leave', 10],
    // The dates behind the counts above, so nobody has to dig through Daily.
    ['Late Dates', 30], ['No Punch Dates', 30], ['WFH Dates', 30], ['Outside Punch Dates', 30],
    ['Sunday/Holiday Worked Dates', 30], ['Leave Dates', 30], ['Regularized Dates', 30],
  ]);

  // ================= Daily =================
  const daily = addSheet(wb, 'Daily', [
    ['Employee Code', 14], ['Name', 22], ['Department', 16], ['Date', 12], ['Weekday', 9], ['Day Type', 22],
    ['Status', 14], ['Check In', 11], ['Check Out', 11], ['Hours Worked', 10], ['Late (min)', 9], ['Late By', 10],
    ['Shift', 14], ['WFH', 9], ['Work Location', 16],
    ['In: Where', 11], ['In: Distance (m)', 10], ['In: Map', 10],
    ['Out: Where', 11], ['Out: Distance (m)', 10], ['Out: Map', 10],
    ['No Punch-Out', 9], ['Half Day Declared', 9],
    ['Sunday/Holiday 2× Duty', 14], ['2× Decided By', 18], ['Leave', 18], ['Worked on Leave', 14],
    ['Regularization', 34], ['Remarks', 40],
  ]);

  // ================= Sunday & Holiday work =================
  const duty = addSheet(wb, 'Sunday & Holiday Work', [
    ['Employee Code', 14], ['Name', 22], ['Department', 16], ['Date', 12], ['Weekday', 9], ['Day Type', 24],
    ['Status', 10], ['Check In', 11], ['Check Out', 11], ['Hours Worked', 10], ['WFH', 9],
    ['2× Claim', 22], ['Extra Days', 9], ['Decided By', 18], ['Decided At', 20], ['Note', 30],
  ]);

  // ================= WFH =================
  const wfh = addSheet(wb, 'WFH', [
    ['Employee Code', 14], ['Name', 22], ['Department', 16], ['Date', 12], ['Weekday', 9], ['Day Type', 18],
    ['Status', 10], ['Check In', 11], ['Check Out', 11], ['Hours Worked', 10], ['WFH On', 10],
    ['In: Distance (m)', 10], ['Out: Distance (m)', 10], ['In: Map', 10], ['Out: Map', 10], ['Remarks', 40],
  ]);

  // ================= Outside punches =================
  // One row per punch made beyond the employee's geofence (not WFH, no
  // punch-anywhere grant) — who, when, and how far away.
  const outside = addSheet(wb, 'Outside Punches', [
    ['Employee Code', 14], ['Name', 22], ['Department', 16], ['Date', 12], ['Weekday', 9], ['Punch', 7],
    ['Time', 11], ['Work Location', 18], ['Allowed Radius (m)', 10], ['Distance (m)', 10], ['Distance', 10],
    ['Outside By (m)', 10], ['GPS Accuracy (m)', 10], ['Status', 10], ['Map', 10], ['Remarks', 40],
  ]);

  // ================= Worked on leave =================
  const wol = addSheet(wb, 'Worked on Leave', [
    ['Employee Code', 14], ['Name', 22], ['Department', 16], ['Date', 12], ['Leave Type', 16],
    ['Check In', 11], ['Check Out', 11], ['Hours Worked', 10], ['Claim Status', 12], ['Approver', 18],
    ['Decided By', 18], ['Decided At', 20], ['Note', 30],
  ]);

  for (const p of people) {
    const pid = String(p._id);
    const joinKey = p.dateOfJoining ? ymdIST(p.dateOfJoining) : null;
    const exitKey = p.dateOfExit ? ymdIST(p.dateOfExit) : null;
    const s = {
      onRoll: 0, working: 0, present: 0, half: 0, absent: 0, leave: 0, noPunch: 0, lateDays: 0, lateMin: 0,
      noPunchOut: 0, wfh: 0, distant: 0, outsidePunches: 0, farthest: 0, hours: 0, sundays: 0, holidays: 0,
      dpApproved: 0, dpPending: 0, dpRejected: 0, leaveDays: 0, workedOnLeave: 0,
    };
    const dates = { late: [], noPunch: [], wfh: [], outside: [], offWorked: [], leave: [] };
    let fromKey = null;
    let toKey = null;

    for (const key of windowKeys) {
      const r = recordByEmpDay.get(`${pid}|${key}`);
      // Days outside employment are skipped — unless a record says they worked.
      if (!r && ((joinKey && key < joinKey) || (exitKey && key > exitKey))) continue;
      s.onRoll += 1;
      if (!fromKey) fromKey = key;
      toKey = key;

      const off = isOffDay(key);
      const type = dayType(key);
      if (!off) s.working += 1;
      const lv = leaveByEmpDay.get(`${pid}|${key}`);
      // A day handed back because it was worked (worked-on-leave approved) is
      // no longer a leave day.
      if (lv && !off && !(lv.workedDays || []).includes(key)) { s.leaveDays += lv.isHalfDay ? 0.5 : 1; dates.leave.push(key); }
      const reg = regByEmpDay.get(`${pid}|${key}`);

      let status;
      if (r) {
        status = r.status || '';
      } else if (off) {
        status = isSundayKey(key) ? 'Weekly Off' : 'Holiday';
      } else if (lv) {
        status = 'OnLeave';
      } else if (key < todayKey) {
        status = 'No Punch';
        s.noPunch += 1;
        dates.noPunch.push(key);
      } else {
        status = 'Not punched yet';
      }

      let late = 0;
      let dp = null;
      let wfhOn = '';
      let distant = false;
      let pin = null;
      let pout = null;
      let noOut = false;
      if (r) {
        if (r.status === 'Present') s.present += 1;
        else if (r.status === 'HalfDay') s.half += 1;
        else if (r.status === 'Absent') s.absent += 1;
        else if (r.status === 'OnLeave') s.leave += 1;
        late = lateMinutes(r);
        if (late) { s.lateDays += 1; s.lateMin += late; dates.late.push(key); }
        wfhOn = wfhText(r);
        if (wfhOn) { s.wfh += 1; dates.wfh.push(key); }
        pin = punchPlace(r, p, 'in');
        pout = punchPlace(r, p, 'out');
        const outs = [pin, pout].filter((pl) => pl && pl.where === 'Outside');
        distant = outs.length > 0;
        if (distant) { s.distant += 1; dates.outside.push(key); }
        s.outsidePunches += outs.length;
        outs.forEach((pl) => { s.farthest = Math.max(s.farthest, pl.distanceM); });
        noOut = r.noPunchOut || Boolean(r.checkIn && !r.checkOut && key < todayKey);
        if (noOut) s.noPunchOut += 1;
        s.hours += r.hoursWorked || 0;
        dp = doublePayState(r, compOffKeys);
        if (r.checkIn && off) {
          if (isSundayKey(key)) s.sundays += 1; else s.holidays += 1;
          dates.offWorked.push(key);
        }
        if (dp === 'Approved') s.dpApproved += restDayCredit(r);
        else if (dp === 'Pending') s.dpPending += 1;
        else if (dp === 'Rejected') s.dpRejected += 1;
        if (r.workOnLeave?.status === 'Approved') s.workedOnLeave += 1;
      }

      const dpBy = dp && dp !== 'Pending' ? actorName(r.doublePay?.decidedBy) : '';
      const dailyRow = daily.addRow([
        p.employeeCode || '', nameOf(p), p.department || '', key, weekdayOfKey(key), type,
        status, fmtTime(r?.checkIn), fmtTime(r?.checkOut), r ? r.hoursWorked || 0 : '', late || '', late ? formatDuration(late) : '',
        r?.shiftName || '', wfhOn, (pin || pout)?.locationName || '',
        pin?.where || '', pin?.distanceM ?? '', mapCell(pin),
        pout?.where || '', pout?.distanceM ?? '', mapCell(pout),
        noOut ? 'Yes' : '', r?.halfDayDeclared ? 'Yes' : '',
        dp ? `${dp} (${restDayCredit(r)} day)` : '', dpBy, leaveText(lv), r?.workOnLeave?.status || '',
        regText(reg), r?.remarks || '',
      ]);
      styleLinks(dailyRow);

      [pin, pout].filter((pl) => pl && pl.where === 'Outside').forEach((pl) => {
        styleLinks(outside.addRow([
          ...empCells(p).slice(0, 3), key, weekdayOfKey(key), pl.kind === 'in' ? 'In' : 'Out',
          fmtTime(pl.at), pl.locationName, pl.radiusM ?? '', pl.distanceM, distText(pl.distanceM),
          pl.outsideByM, pl.accuracyM ?? '', r.status || '', mapCell(pl), r.remarks || '',
        ]));
      });

      // A worked day off: a Sunday, a comp-off day, or any other holiday.
      if (r && r.checkIn && off) {
        const claim = dp
          ? dp
          : 'Not a 2× day (ordinary holiday)';
        duty.addRow([
          ...empCells(p).slice(0, 3), key, weekdayOfKey(key), type,
          r.status || '', fmtTime(r.checkIn), fmtTime(r.checkOut), r.hoursWorked || 0, wfhOn,
          claim, dp ? restDayCredit(r) : '', dp && dp !== 'Pending' ? actorName(r.doublePay?.decidedBy) : '',
          dp && dp !== 'Pending' ? fmtDateTime(r.doublePay?.decidedAt) : '', r.doublePay?.note || '',
        ]);
      }

      if (r && wfhOn) {
        styleLinks(wfh.addRow([
          ...empCells(p).slice(0, 3), key, weekdayOfKey(key), type,
          r.status || '', fmtTime(r.checkIn), fmtTime(r.checkOut), r.hoursWorked || 0, wfhOn,
          pin?.distanceM ?? '', pout?.distanceM ?? '', mapCell(pin), mapCell(pout), r.remarks || '',
        ]));
      }

      if (r?.workOnLeave) {
        const w = r.workOnLeave;
        wol.addRow([
          ...empCells(p).slice(0, 3), key, w.leaveType || '',
          fmtTime(r.checkIn), fmtTime(r.checkOut), r.hoursWorked || 0, w.status || 'Pending', w.approverName || '',
          w.status && w.status !== 'Pending' ? actorName(w.decidedBy) : '',
          w.status && w.status !== 'Pending' ? fmtDateTime(w.decidedAt) : '', w.note || '',
        ]);
      }
    }

    const regs = (regularizations || []).filter((g) => profileByUser.get(String(g.employee?._id || g.employee)) === p);
    summary.addRow([
      ...empCells(p), p.company?.name || '',
      fromKey ? dmy(fromKey) : '', toKey ? dmy(toKey) : '', s.onRoll, s.working, s.present, s.half, s.absent, s.leave, s.noPunch, s.lateDays, s.lateMin ? formatDuration(s.lateMin) : '',
      s.noPunchOut, s.wfh, s.distant, s.outsidePunches, s.farthest ? distText(s.farthest) : '', +s.hours.toFixed(2),
      s.sundays, s.holidays, s.dpApproved, s.dpPending, s.dpRejected,
      regs.filter((g) => g.status === 'Approved').length,
      regs.filter((g) => g.status === 'Pending').length,
      regs.filter((g) => g.status === 'Rejected').length,
      s.leaveDays, s.workedOnLeave,
      dateList(dates.late), dateList(dates.noPunch), dateList(dates.wfh), dateList(dates.outside),
      dateList(dates.offWorked), dateList(dates.leave),
      dateList([...new Set(regs.filter((g) => g.status === 'Approved').map((g) => ymdIST(g.date)))].sort()),
    ]);
  }

  // ================= Regularizations =================
  const regSheet = addSheet(wb, 'Regularizations', [
    ['Employee Code', 14], ['Name', 22], ['Department', 16], ['Date', 12], ['Weekday', 9], ['Type', 16],
    ['Requested In', 11], ['Requested Out', 11], ['Reason', 34], ['Status', 10],
    ['Before: Status', 11], ['Before: In', 11], ['Before: Out', 11], ['Applied In', 11], ['Applied Out', 11],
    ['Approval Steps', 34], ['Decided By', 18], ['Decided At', 20], ['Review Note', 30], ['Attachments', 9], ['Requested At', 20],
  ]);
  [...(regularizations || [])]
    .map((g) => ({ g, p: profileByUser.get(String(g.employee?._id || g.employee)) }))
    .filter((x) => x.p)
    .sort((a, b) => (a.p.employeeCode || '').localeCompare(b.p.employeeCode || '', undefined, { numeric: true })
      || new Date(a.g.date) - new Date(b.g.date))
    .forEach(({ g, p }) => {
      const key = ymdIST(g.date);
      const steps = (g.approvalChain || [])
        .map((st) => `${st.approverName || 'Approver'}: ${st.status}`)
        .join(' → ');
      regSheet.addRow([
        ...empCells(p).slice(0, 3), key, weekdayOfKey(key), g.type || '',
        g.requestedCheckIn || '', g.requestedCheckOut || '', g.reason || '', g.status || '',
        g.previousStatus || '', fmtTime(g.previousCheckIn), fmtTime(g.previousCheckOut),
        fmtTime(g.appliedCheckIn), fmtTime(g.appliedCheckOut),
        steps, g.status === 'Pending' ? '' : actorName(g.reviewedBy, lastDecider(g)),
        fmtDateTime(g.reviewedAt), g.reviewNote || '', (g.attachments || []).length || '', fmtDateTime(g.createdAt),
      ]);
    });
  noteIfEmpty(regSheet, 'No regularization requests in this period.');

  // ================= Leave =================
  const leaveSheet = addSheet(wb, 'Leave', [
    ['Employee Code', 14], ['Name', 22], ['Department', 16], ['Leave Type', 16], ['From', 12], ['To', 12],
    ['Half Day', 8], ['Total Days', 9], ['Paid Days', 9], ['LOP Days', 9], ['Status', 10],
    ['Decided By', 18], ['Decided At', 20], ['Reason', 34], ['Days Worked Instead', 18], ['Applied At', 20],
  ]);
  [...(leaves || [])]
    .map((l) => ({ l, p: profileById.get(String(l.employee?._id || l.employee)) }))
    .filter((x) => x.p)
    .sort((a, b) => (a.p.employeeCode || '').localeCompare(b.p.employeeCode || '', undefined, { numeric: true })
      || new Date(a.l.startDate) - new Date(b.l.startDate))
    .forEach(({ l, p }) => {
      const decided = l.status === 'Approved' || l.status === 'Rejected';
      leaveSheet.addRow([
        ...empCells(p).slice(0, 3), l.leaveType || '', ymdIST(l.startDate), ymdIST(l.endDate),
        l.isHalfDay ? 'Yes' : '', l.totalDays || 0, l.paidDays || 0, l.lopDays || 0, l.status || '',
        decided ? actorName(l.approver) : '', decided ? fmtDateTime(l.decisionAt) : '', l.reason || '',
        (l.workedDays || []).join(', '), fmtDateTime(l.appliedAt || l.createdAt),
      ]);
    });
  noteIfEmpty(leaveSheet, 'No leave requests in this period.');

  noteIfEmpty(duty, 'Nobody worked a Sunday or holiday in this period.');
  noteIfEmpty(wfh, 'No work-from-home punches in this period.');
  noteIfEmpty(outside, 'Nobody punched outside their work location in this period.');
  noteIfEmpty(wol, 'Nobody punched in on an approved-leave day in this period.');
  noteIfEmpty(daily, 'No employees in this period.');

  // A title line above the Summary table would break its filter, so the period
  // goes in the sheet's header/footer and the workbook title instead.
  if (title) {
    wb.title = `Attendance report – ${title}`;
    summary.headerFooter.oddHeader = `&LAttendance report – ${title}`;
  }
  // Summary is the first thing anyone opens.
  wb.views = [{ activeTab: 0 }];
  return wb;
}

module.exports = { buildAttendanceReport };
