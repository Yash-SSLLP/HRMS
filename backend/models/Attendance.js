const mongoose = require('mongoose');

// One attendance record per employee per work day: the day's punches (with
// selfie + GPS + geofence flags), computed hours, and the day's status. Feeds
// payroll (paid/LOP days) and attendance reports.
// Present/Absent/HalfDay = worked state; WeeklyOff/Holiday = non-working day; OnLeave = on an approved leave.
const STATUS = ['Present', 'Absent', 'HalfDay', 'WeeklyOff', 'Holiday', 'OnLeave'];

// HR's / the manager's decision on a rest day that was actually worked.
//
// Working a Sunday or an org-wide Comp Off day is paid DOUBLE, but only once
// it is approved — so the decision lives on the day it describes. No decision
// (the field absent) means the claim is still pending, which is also what every
// historic record correctly reads as. See utils/restDay.js.
const doublePaySchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['Approved', 'Rejected'] },
    days: Number,          // extra days earned: 1 for a full day, 0.5 for a half day
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    note: String,
  },
  { _id: false }
);

// An employee who punched in on a day they are on APPROVED leave.
//
// Working through your own leave is allowed but never silent: the punch is
// recorded, the day KEEPS its leave status, and the claim waits for the top rung
// of that employee's leave approval hierarchy. Approved → the leave day is given
// back and the day becomes a normal worked day; Rejected → the punches stay on
// the record for audit but the day remains leave. HR is told either way.
// Lives on the day it describes, exactly like the doublePay decision above.
const workOnLeaveSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ['Pending', 'Approved', 'Rejected'], default: 'Pending' },
    // The approved leave being worked through, and a snapshot of its type so the
    // approver's inbox reads correctly without a second lookup.
    leaveRequest: { type: mongoose.Schema.Types.ObjectId, ref: 'LeaveRequest' },
    leaveType: String,
    // The status the day carries while this is undecided — 'OnLeave' for a paid
    // leave day, 'Absent' for an LOP one. Restored on rejection.
    leaveStatus: String,
    // Whose decision it is: the TOP rung of the employee's leave hierarchy.
    approver: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approverName: String,
    requestedAt: Date,
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedAt: Date,
    note: String,
    // Set once the approval actually gave the leave day back, so a re-run (or a
    // later HR edit) can never credit the same day twice.
    leaveDayReturned: { type: Boolean, default: false },
  },
  { _id: false }
);

// GPS location captured by the client at the moment of a punch photo.
const locationSchema = new mongoose.Schema(
  {
    lat: Number,
    lng: Number,
    accuracy: Number, // metres
  },
  { _id: false }
);

// Reference to a punch selfie stored in Cloudinary (durable, unlike the local
// disk which is ephemeral on most hosts). Enough to rebuild a signed delivery URL.
const cloudPhotoSchema = new mongoose.Schema(
  {
    publicId: String,
    version: Number,
    format: String,
  },
  { _id: false }
);

const attendanceSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmployeeProfile',
      required: true,
      index: true,
    },
    // Normalized to midnight local time of the work day
    date: { type: Date, required: true },
    status: { type: String, enum: STATUS, default: 'Present' },
    checkIn: Date,
    checkOut: Date,
    // Storage-relative paths to the selfie captured at each punch on local disk
    // (legacy / fallback — see services/storage.js).
    checkInPhoto: String,
    checkOutPhoto: String,
    // Preferred durable storage: the same selfies in Cloudinary. When present,
    // these win over the local-disk paths above.
    checkInPhotoCloud: cloudPhotoSchema,
    checkOutPhotoCloud: cloudPhotoSchema,
    // GPS location captured alongside each punch photo
    checkInLocation: locationSchema,
    checkOutLocation: locationSchema,
    // Whether the punch was made while working from home
    checkInWfh: { type: Boolean, default: false },
    checkOutWfh: { type: Boolean, default: false },
    // The employee declared this a half day at punch time (at check-in or at
    // check-out). Kept separate from `status` so the hours rule cannot quietly
    // undo the declaration: someone who says up front they are working half a
    // day, then happens to punch out 6+ hours later, still gets a half day.
    halfDayDeclared: { type: Boolean, default: false },
    // Captured at punch time: the punch was made beyond the office geofence and
    // was not a WFH punch. Persisted so the violation is recorded even if the
    // office coordinates / threshold are changed later. WFH punches are exempt.
    checkInOutsideGeofence: { type: Boolean, default: false },
    checkOutOutsideGeofence: { type: Boolean, default: false },
    // The shift this day was worked under, FROZEN at the moment the day was
    // first punched — exactly like checkInOutsideGeofence six lines above, and
    // for the same reason: a judgement has to be reproducible from the record.
    //
    // The times are denormalized alongside the ref rather than looked up. Two
    // things would otherwise rewrite settled history: deleteShift hard-deletes
    // with no reference check, and an HR edit to the Night Shift's hours would
    // re-judge — and so re-price — every night already worked under the old
    // ones. Late arrivals are recomputed on every read and payroll recomputes
    // any month that is not Paid, so "look it up when you need it" is not a
    // neutral choice here; it is a decision to let today's configuration change
    // what somebody was paid last month.
    //
    // All six are unset on every record written before shifts were honoured.
    // utils/workday.js treats an unstamped record exactly as it always did (the
    // org-wide latePolicy and a 7 PM assumed close), which is what makes this
    // change forward-only.
    shift: { type: mongoose.Schema.Types.ObjectId, ref: 'Shift', default: null },
    shiftName: { type: String },
    shiftStart: { type: String },        // 'HH:mm' IST
    shiftEnd: { type: String },          // 'HH:mm' IST — may be earlier than shiftStart
    shiftDurationMin: { type: Number },  // authoritative length; survives a midnight crossing
    // True when the shift runs past midnight, so this record's day ends on the
    // FOLLOWING calendar date. The punch-out lookup and the auto-close worker
    // both key off this, so it is stored rather than re-derived from the strings.
    shiftCrossesMidnight: { type: Boolean, default: false },
    hoursWorked: { type: Number, default: 0, min: 0 },
    // Set by the nightly auto-close worker when the day ended with a check-in
    // but no check-out ("forgot to punch out"). Cleared automatically if a
    // check-out is later filled in (HR edit / regularization).
    noPunchOut: { type: Boolean, default: false },
    // Only ever set on a Sunday / Comp Off day that was worked — the approval
    // that turns that day into double pay in the payroll run.
    doublePay: doublePaySchema,
    // Only ever set when the employee punched in on a day they were on approved
    // leave — the approval that decides whether that punch counts as work.
    workOnLeave: workOnLeaveSchema,
    remarks: String,
  },
  { timestamps: true }
);

// One attendance record per employee per day.
attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });

// The approver's inbox query: "work-on-leave claims awaiting me". Sparse because
// only the handful of days someone worked through their leave carry the field.
attendanceSchema.index(
  { 'workOnLeave.approver': 1, 'workOnLeave.status': 1 },
  { sparse: true }
);

// A later-filled check-out (HR edit / regularization) clears the no-punch-out mark.
attendanceSchema.pre('save', function clearNoPunchOut(next) {
  if (this.checkOut && this.noPunchOut) this.noPunchOut = false;
  next();
});

// Auto-compute hoursWorked when both punches are present
attendanceSchema.pre('save', function computeHours(next) {
  if (this.checkIn && this.checkOut) {
    const ms = new Date(this.checkOut).getTime() - new Date(this.checkIn).getTime();
    this.hoursWorked = ms > 0 ? +(ms / (1000 * 60 * 60)).toFixed(2) : 0;
  } else {
    this.hoursWorked = 0;
  }
  next();
});

// toJSON transform: never leak the filesystem/Cloudinary path; expose only
// booleans for whether a photo exists. The image itself is served through the
// authenticated GET /api/attendance/:id/photo/:which route.
attendanceSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.hasCheckInPhoto = !!(ret.checkInPhoto || ret.checkInPhotoCloud?.publicId);
    ret.hasCheckOutPhoto = !!(ret.checkOutPhoto || ret.checkOutPhotoCloud?.publicId);
    delete ret.checkInPhoto;
    delete ret.checkOutPhoto;
    delete ret.checkInPhotoCloud;
    delete ret.checkOutPhotoCloud;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Attendance', attendanceSchema);
module.exports.STATUS = STATUS;
