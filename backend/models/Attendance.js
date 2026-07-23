const mongoose = require('mongoose');

// One attendance record per employee per work day: the day's punches (with
// selfie + GPS + geofence flags), computed hours, and the day's status. Feeds
// payroll (paid/LOP days) and attendance reports.
// Present/Absent/HalfDay = worked state; WeeklyOff/Holiday = non-working day; OnLeave = on an approved leave.
const STATUS = ['Present', 'Absent', 'HalfDay', 'WeeklyOff', 'Holiday', 'OnLeave'];

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
    // Captured at punch time: the punch was made beyond the office geofence and
    // was not a WFH punch. Persisted so the violation is recorded even if the
    // office coordinates / threshold are changed later. WFH punches are exempt.
    checkInOutsideGeofence: { type: Boolean, default: false },
    checkOutOutsideGeofence: { type: Boolean, default: false },
    hoursWorked: { type: Number, default: 0, min: 0 },
    // Set by the nightly auto-close worker when the day ended with a check-in
    // but no check-out ("forgot to punch out"). Cleared automatically if a
    // check-out is later filled in (HR edit / regularization).
    noPunchOut: { type: Boolean, default: false },
    remarks: String,
  },
  { timestamps: true }
);

// One attendance record per employee per day.
attendanceSchema.index({ employee: 1, date: 1 }, { unique: true });

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
