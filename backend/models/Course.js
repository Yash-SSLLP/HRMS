const mongoose = require('mongoose');

const COURSE_CATEGORIES = ['Technical', 'Soft Skills', 'Compliance', 'Leadership', 'Onboarding', 'Other'];
const ENROLLMENT_STATUS = ['Enrolled', 'InProgress', 'Completed'];

const moduleSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    content: { type: String },
    url: { type: String },
  },
  { _id: false }
);

const courseSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    category: { type: String, enum: COURSE_CATEGORIES, default: 'Other' },
    modules: [moduleSchema],
    durationHours: { type: Number, default: 0 },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const enrollmentSchema = new mongoose.Schema(
  {
    course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ENROLLMENT_STATUS, default: 'Enrolled' },
    completedModules: [{ type: Number }],
    progress: { type: Number, default: 0, min: 0, max: 100 },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

enrollmentSchema.index({ course: 1, employee: 1 }, { unique: true });

const Course = mongoose.model('Course', courseSchema);
const Enrollment = mongoose.model('Enrollment', enrollmentSchema);

module.exports = Course;
module.exports.Enrollment = Enrollment;
module.exports.COURSE_CATEGORIES = COURSE_CATEGORIES;
module.exports.ENROLLMENT_STATUS = ENROLLMENT_STATUS;
