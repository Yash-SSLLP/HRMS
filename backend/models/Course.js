const mongoose = require('mongoose');
const { parseDriveFileId } = require('../utils/drive');

const COURSE_CATEGORIES = ['Technical', 'Soft Skills', 'Compliance', 'Leadership', 'Onboarding', 'Other'];
const MODULE_TYPES = ['video', 'text'];
// Lifecycle of a video module's lower-quality renditions (see services/videoTranscode.js).
const TRANSCODE_STATUS = ['none', 'pending', 'processing', 'ready', 'failed'];

// One transcoded lower-quality copy of a video module, stored in our own storage
// (never the raw Drive file). `storagePath` is server-side only and never leaks
// to the client — the player references a rendition by its height via
// GET /:id/modules/:mid/video?quality=<height>.
const renditionSchema = new mongoose.Schema(
  {
    height: { type: Number, required: true }, // 360, 480, 720 …
    label: { type: String, required: true }, // "360p"
    // Object key / path in the rendition store (Cloud Storage). Never sent to
    // the client — the player references a rendition by height via the stream API.
    storagePath: { type: String, required: true },
    // Which backend holds the file. Only 'gcs' (shared Cloud Storage) is served
    // and advertised; the default 'local' marks legacy/pre-GCS renditions so they
    // are hidden and rebuilt into GCS (never mis-served as a missing GCS object).
    store: { type: String, enum: ['gcs', 'local'], default: 'local' },
    sizeBytes: { type: Number, default: 0 },
    bitrateKbps: { type: Number, default: 0 }, // approx, informs the Auto ladder
  },
  { _id: false }
);
const ENROLLMENT_STATUS = ['Enrolled', 'InProgress', 'Completed'];
const APPROVAL_STATUS = ['Approved', 'Pending', 'Rejected'];
const ENROLL_SOURCE = ['Assigned', 'Self'];

// A single unit of a course. `_id` is kept (mongoose default) so an enrollment's
// per-module progress can be keyed by a stable id even when modules are reordered.
const moduleSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  type: { type: String, enum: MODULE_TYPES, default: 'video' },
  // Google Drive share link + the file id parsed from it (video modules).
  driveUrl: { type: String, trim: true },
  driveFileId: { type: String, trim: true },
  // Free text for a text module, or notes shown under a video.
  content: { type: String },
  // Video length in seconds, learned from the player on first play. Used as the
  // denominator for accurate watch progress.
  durationSec: { type: Number, default: 0, min: 0 },
  // Lower-quality copies generated from the Drive source so the player can offer
  // a YouTube-style quality menu + adaptive "Auto". Empty until transcoding runs.
  renditions: { type: [renditionSchema], default: [] },
  transcodeStatus: { type: String, enum: TRANSCODE_STATUS, default: 'none' },
  transcodeError: { type: String },
  // Detected height of the Drive source, so we never offer a rendition >= source.
  sourceHeight: { type: Number, default: 0 },
  // The driveFileId the current renditions were built from — lets create/update
  // detect a changed source and re-transcode.
  transcodedFrom: { type: String },
});

// Keep driveFileId in sync with whatever link was provided. Tolerates a legacy
// module that only had a `url` by treating it as the drive link.
moduleSchema.pre('validate', function syncDriveId(next) {
  const link = this.driveUrl || this.get('url');
  if (link) {
    this.driveUrl = link;
    this.driveFileId = parseDriveFileId(link) || this.driveFileId || '';
  }
  next();
});

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, enum: COURSE_CATEGORIES, default: 'Other' },
    modules: [moduleSchema],
    durationHours: { type: Number, default: 0 },
    // Default number of days an enrollee has to finish, counted from when their
    // enrollment is approved/assigned. 0 = no deadline.
    deadlineDays: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Per-module watch progress for one enrollment.
const moduleProgressSchema = new mongoose.Schema(
  {
    module: { type: mongoose.Schema.Types.ObjectId, required: true },
    watchedSec: { type: Number, default: 0, min: 0 },
    durationSec: { type: Number, default: 0, min: 0 },
    completed: { type: Boolean, default: false },
    completedAt: { type: Date },
  },
  { _id: false }
);

const enrollmentSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Progress lifecycle (independent of approval).
    status: { type: String, enum: ENROLLMENT_STATUS, default: 'Enrolled' },
    // Access gate: self-enrollments start Pending and need HR/Admin/L&D approval;
    // assigned enrollments are Approved outright.
    approvalStatus: { type: String, enum: APPROVAL_STATUS, default: 'Approved', index: true },
    source: { type: String, enum: ENROLL_SOURCE, default: 'Self' },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Date by which the enrollee must finish.
    dueDate: { type: Date },
    moduleProgress: [moduleProgressSchema],
    progress: { type: Number, default: 0, min: 0, max: 100 },
    completedAt: { type: Date },
    // Course feedback the employee leaves (typically on completion).
    feedback: {
      rating: { type: Number, min: 1, max: 5 },
      comment: { type: String, trim: true },
      submittedAt: { type: Date },
    },
  },
  { timestamps: true }
);

enrollmentSchema.index({ course: 1, employee: 1 }, { unique: true });

courseSchema.plugin(require('./plugins/auditStatus'), { label: (d) => d.title });
enrollmentSchema.plugin(require('./plugins/auditStatus'), {
  entity: 'Enrollment',
  fields: ['status', 'approvalStatus'],
});

// Employee-raised issue about a course lesson (video quality, audio, playback…).
const REPORT_CATEGORIES = ['Video quality', 'Audio / sound', 'Playback / buffering', 'Content error', 'Other'];
const REPORT_STATUS = ['Open', 'Resolved'];
const courseReportSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    module: { type: mongoose.Schema.Types.ObjectId }, // the lesson, if the report is about one
    moduleTitle: { type: String },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    category: { type: String, enum: REPORT_CATEGORIES, default: 'Other' },
    note: { type: String, trim: true },
    status: { type: String, enum: REPORT_STATUS, default: 'Open', index: true },
  },
  { timestamps: true }
);
courseReportSchema.plugin(require('./plugins/auditStatus'), { entity: 'CourseReport' });

const Course = mongoose.model('Course', courseSchema);
const Enrollment = mongoose.model('Enrollment', enrollmentSchema);
const CourseReport = mongoose.model('CourseReport', courseReportSchema);

module.exports = Course;
module.exports.Enrollment = Enrollment;
module.exports.CourseReport = CourseReport;
module.exports.COURSE_CATEGORIES = COURSE_CATEGORIES;
module.exports.MODULE_TYPES = MODULE_TYPES;
module.exports.ENROLLMENT_STATUS = ENROLLMENT_STATUS;
module.exports.APPROVAL_STATUS = APPROVAL_STATUS;
module.exports.REPORT_CATEGORIES = REPORT_CATEGORIES;
