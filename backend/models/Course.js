const mongoose = require('mongoose');
const { parseDriveFileId } = require('../utils/drive');

// The LMS / e-learning module. This one file defines the whole learning domain as
// several related models: Course (with embedded lesson `modules`, each video
// carrying timestamped `checkpoints` — the in-video questions), Enrollment (an
// employee taking a course, with per-module watch progress and the checkpoints
// they've cleared), CheckpointAnswer (the log of who answered what), CourseReport
// (lesson issue tickets), and the public no-login engagement models
// (CourseViewer, CourseComment, VideoFeedback). Default export is Course; the
// others are attached as properties.
const COURSE_CATEGORIES = ['Technical', 'Soft Skills', 'Compliance', 'Leadership', 'Onboarding', 'Other'];
const MODULE_TYPES = ['video', 'text'];
const ENROLLMENT_STATUS = ['Enrolled', 'InProgress', 'Completed']; // learner's progress through the course
const APPROVAL_STATUS = ['Approved', 'Pending', 'Rejected']; // access gate on an enrollment (self-enrolls need approval)
const ENROLL_SOURCE = ['Assigned', 'Self']; // how the enrollment was created (HR-assigned vs employee self-enroll)

// ===== In-video checkpoint questions =====
// A question the author pins to a TIMESTAMP inside a video lesson. Playback
// stops there and will not resume until the learner answers it — and, when the
// question has a right answer and `requireCorrect`, until they answer it
// correctly. A lesson may carry as many as the author wants.
//
// A question with no option marked `correct` is UNGRADED: the answer is
// recorded and the learner moves on either way (a poll / attention check).
const CHECKPOINT_TYPES = ['single', 'multiple', 'text'];

const checkpointOptionSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    correct: { type: Boolean, default: false },
  },
  { _id: false }
);

// `_id` is kept (mongoose default): the answer log points at it, so a question
// keeps its identity across course edits and reorders.
const checkpointSchema = new mongoose.Schema({
  atSec: { type: Number, required: true, min: 0 },
  question: { type: String, required: true, trim: true },
  type: { type: String, enum: CHECKPOINT_TYPES, default: 'single' },
  // For single/multiple these are the choices; for `text` they are the accepted
  // answers (matched case-insensitively). None marked correct = ungraded.
  options: [checkpointOptionSchema],
  // Shown once they've answered — the "why".
  explanation: { type: String, trim: true },
  // Graded question: must they get it right to move on? false = record the
  // answer and let them continue regardless.
  requireCorrect: { type: Boolean, default: true },
});

// A single unit of a course. `_id` is kept (mongoose default) so an enrollment's
// per-module progress can be keyed by a stable id even when modules are reordered.
const VIDEO_SOURCES = ['drive', 'cloudinary'];
const moduleSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true },
  type: { type: String, enum: MODULE_TYPES, default: 'video' },
  // Where a video module's file lives. Legacy modules have no value → 'drive'.
  videoSource: { type: String, enum: VIDEO_SOURCES, default: 'drive' },
  // Google Drive share link + the file id parsed from it (videoSource 'drive').
  driveUrl: { type: String, trim: true },
  driveFileId: { type: String, trim: true },
  // Cloudinary asset (videoSource 'cloudinary'). Stored as an `authenticated`
  // asset — never leaked to employees; reached only via a signed delivery URL.
  cloudinaryPublicId: { type: String, trim: true },
  cloudinaryVersion: { type: Number },
  cloudinaryFormat: { type: String, trim: true },
  cloudinaryResourceType: { type: String, trim: true, default: 'video' },
  videoSizeBytes: { type: Number, min: 0 },
  // Free text for a text module, or notes shown under a video.
  content: { type: String },
  // Video length in seconds, learned from the player on first play. Used as the
  // denominator for accurate watch progress.
  durationSec: { type: Number, default: 0, min: 0 },
  // Questions pinned inside this video, kept sorted by timestamp.
  checkpoints: [checkpointSchema],
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
    // Audience: 'internal' = employees only (catalog + assignment); 'external' =
    // shared publicly via a no-login /learn/:token link. Legacy courses (no
    // value) are treated as internal.
    courseType: { type: String, enum: ['internal', 'external'], default: 'internal', index: true },
    modules: [moduleSchema],
    durationHours: { type: Number, default: 0 },
    // Default number of days an enrollee has to finish, counted from when their
    // enrollment is approved/assigned. 0 = no deadline.
    deadlineDays: { type: Number, default: 0, min: 0 },
    active: { type: Boolean, default: true, index: true },
    // Public (no-login) sharing: when on, anyone with publicToken can view the
    // course at /learn/:token after filling a short lead form.
    isPublic: { type: Boolean, default: false, index: true },
    publicToken: { type: String, index: true },
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
    // In-video questions this learner has already got past. Anything not in
    // here still blocks playback (and watch credit) at its timestamp.
    clearedCheckpoints: [{ type: mongoose.Schema.Types.ObjectId }],
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

// One enrollment per (course, employee) — no duplicate enrollments.
enrollmentSchema.index({ course: 1, employee: 1 }, { unique: true });

// Audit-status plugins: log course `status` and enrollment status/approval transitions to AuditLog.
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

// ===== In-video question answers (the log) =====
// One row per ATTEMPT — a wrong answer followed by a right one leaves two rows,
// which is the point: the log says who answered what, on which question, when.
// The question text is snapshotted so the log still reads correctly after the
// course is edited. Exactly one of `employee` (internal learner) / `viewer`
// (public no-login viewer) identifies the answerer.
const checkpointAnswerSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    module: { type: mongoose.Schema.Types.ObjectId, index: true },
    moduleTitle: { type: String },
    checkpoint: { type: mongoose.Schema.Types.ObjectId, index: true },
    question: { type: String },
    atSec: { type: Number, default: 0 },
    audience: { type: String, enum: ['employee', 'public'], default: 'employee', index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    viewer: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseViewer', index: true },
    // Display name at the time of answering (a public viewer has no account).
    answeredBy: { type: String },
    // What they picked — option text(s), or the free text they typed.
    answer: [{ type: String }],
    graded: { type: Boolean, default: false }, // the question had a right answer
    correct: { type: Boolean, default: false },
    cleared: { type: Boolean, default: false }, // did this attempt let them continue
    attempt: { type: Number, default: 1 },
  },
  { timestamps: true }
);
checkpointAnswerSchema.index({ course: 1, createdAt: -1 });

// ===== Public (no-login) course engagement =====

// The fixed questions shown in the per-video feedback form on public courses.
// Edit freely — the public page + admin view render whatever is here.
const VIDEO_FEEDBACK_QUESTIONS = [
  { key: 'clarity', label: 'Was the content clear and easy to follow?', options: ['Yes', 'Somewhat', 'No'] },
  { key: 'usefulness', label: 'How useful was this video to you?', options: ['Very useful', 'Somewhat', 'Not really'] },
  { key: 'recommend', label: 'Would you recommend this to others?', options: ['Yes', 'Maybe', 'No'] },
];

// A public visitor who filled the lead form. `sessionToken` ties their later
// requests (video, comments, feedback) to them without a login.
const courseViewerSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    location: { type: String, required: true, trim: true },
    email: { type: String, trim: true, lowercase: true },
    sessionToken: { type: String, required: true, index: true },
    lastSeenAt: { type: Date },
  },
  { timestamps: true }
);

// A comment left under a video. Public comments are held Pending until an admin
// approves them; only Approved ones are shown to other viewers.
const COMMENT_STATUS = ['Pending', 'Approved', 'Rejected'];
const courseCommentSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    module: { type: mongoose.Schema.Types.ObjectId },
    moduleTitle: { type: String },
    viewer: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseViewer' },
    name: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true },
    status: { type: String, enum: COMMENT_STATUS, default: 'Pending', index: true },
  },
  { timestamps: true }
);
courseCommentSchema.plugin(require('./plugins/auditStatus'), { entity: 'CourseComment' });

// Per-video feedback from a public viewer: a star rating, answers to the fixed
// questions, and an optional free-text comment.
const videoFeedbackSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    module: { type: mongoose.Schema.Types.ObjectId, index: true },
    moduleTitle: { type: String },
    viewer: { type: mongoose.Schema.Types.ObjectId, ref: 'CourseViewer', index: true },
    rating: { type: Number, min: 1, max: 5 },
    answers: [{ key: String, label: String, answer: String, _id: false }],
    comment: { type: String, trim: true },
  },
  { timestamps: true }
);

const Course = mongoose.model('Course', courseSchema);
const Enrollment = mongoose.model('Enrollment', enrollmentSchema);
const CourseReport = mongoose.model('CourseReport', courseReportSchema);
const CourseViewer = mongoose.model('CourseViewer', courseViewerSchema);
const CourseComment = mongoose.model('CourseComment', courseCommentSchema);
const VideoFeedback = mongoose.model('VideoFeedback', videoFeedbackSchema);
const CheckpointAnswer = mongoose.model('CheckpointAnswer', checkpointAnswerSchema);

module.exports = Course;
module.exports.Enrollment = Enrollment;
module.exports.CourseReport = CourseReport;
module.exports.CourseViewer = CourseViewer;
module.exports.CourseComment = CourseComment;
module.exports.VideoFeedback = VideoFeedback;
module.exports.CheckpointAnswer = CheckpointAnswer;
module.exports.COURSE_CATEGORIES = COURSE_CATEGORIES;
module.exports.MODULE_TYPES = MODULE_TYPES;
module.exports.CHECKPOINT_TYPES = CHECKPOINT_TYPES;
module.exports.VIDEO_SOURCES = VIDEO_SOURCES;
module.exports.ENROLLMENT_STATUS = ENROLLMENT_STATUS;
module.exports.APPROVAL_STATUS = APPROVAL_STATUS;
module.exports.REPORT_CATEGORIES = REPORT_CATEGORIES;
module.exports.COMMENT_STATUS = COMMENT_STATUS;
module.exports.VIDEO_FEEDBACK_QUESTIONS = VIDEO_FEEDBACK_QUESTIONS;
