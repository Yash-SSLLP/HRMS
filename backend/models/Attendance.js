const mongoose = require('mongoose');

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
    // Storage-relative paths to the selfie captured at each punch (see services/storage.js)
    checkInPhoto: String,
    checkOutPhoto: String,
    // GPS location captured alongside each punch photo
    checkInLocation: locationSchema,
    checkOutLocation: locationSchema,
    // Whether the punch was made while working from home
    checkInWfh: { type: Boolean, default: false },
    checkOutWfh: { type: Boolean, default: false },
    hoursWorked: { type: Number, default: 0, min: 0 },
    // Set by the nightly auto-close worker when the day ended with a check-in
    // but no check-out ("forgot to punch out"). Cleared automatically if a
    // check-out is later filled in (HR edit / regularization).
    noPunchOut: { type: Boolean, default: false },
    remarks: String,
  },
  { timestamps: true }
);

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

// Never leak the filesystem path; expose only whether a photo exists. The image
// itself is served through the authenticated GET /api/attendance/:id/photo/:which route.
attendanceSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.hasCheckInPhoto = !!ret.checkInPhoto;
    ret.hasCheckOutPhoto = !!ret.checkOutPhoto;
    delete ret.checkInPhoto;
    delete ret.checkOutPhoto;
    delete ret.__v;
    return ret;
  },
});

module.exports = mongoose.model('Attendance', attendanceSchema);
module.exports.STATUS = STATUS;
