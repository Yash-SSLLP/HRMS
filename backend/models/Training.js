const mongoose = require('mongoose');

const { ObjectId } = mongoose.Schema.Types;

// A training/L&D session or program with a set of participant employees.
// Part of the learning module (distinct from Course, which is the LMS e-learning).
//
// STATUS — two of the four are a person's decision and two are the clock's
// (2026-10-02 rework). `Cancelled` and `Completed` are STICKY: somebody called
// the session off, or marked it finished early. `Planned` and `Ongoing` simply
// follow the schedule — services/trainingWorker moves Planned → Ongoing at the
// start and on to Completed at the end, and every save re-derives them — so the
// person booking a session never has to come back and flip a status by hand.
// Read the live answer through trainingController.liveStatus, which applies the
// same rule at request time (the worker runs once a minute).
const TRAINING_STATUS = ['Planned', 'Ongoing', 'Completed', 'Cancelled'];

/**
 * A file handed out with the training (slides, a handout, a policy PDF). The
 * bytes live in GridFS (services/storage) under `storagePath`, which never
 * leaves the server — participants download through GET /training/:id/files/:fileId.
 */
const attachmentSchema = new mongoose.Schema(
  {
    storagePath: { type: String, required: true },
    name: { type: String, trim: true },
    mime: { type: String, trim: true },
    size: Number,
    uploadedBy: { type: ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * Who pressed Join, and when. The portal cannot see inside a Google Meet, so
 * this is the attendance signal it CAN record: the person opened the meeting
 * from their own My Trainings page while the session was on (or about to be).
 * One row per person; repeat joins only bump the counter and the last stamp.
 */
const attendanceSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    firstJoinedAt: Date,
    lastJoinedAt: Date,
    joins: { type: Number, default: 0 },
  },
  { _id: false }
);

const RATING = { type: Number, min: 1, max: 5 };

/**
 * One participant's review, asked for once the session is over. `clarity` is
 * the question the module exists to ask ("how clear was the training?") and the
 * only required one; the other two are optional colour.
 */
const feedbackSchema = new mongoose.Schema(
  {
    user: { type: ObjectId, ref: 'User', required: true },
    clarity: { ...RATING, required: true },
    usefulness: RATING,
    trainerRating: RATING,
    comment: { type: String, trim: true, maxlength: 2000 },
    submittedAt: { type: Date, default: Date.now },
    updatedAt: Date,
  },
  { _id: false }
);

const trainingSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    // A name from the managed TrainingCategory list. Stored as text, the way
    // designation is on a profile: a category deleted from the list later does
    // not rewrite history, and a rename is carried across by the controller.
    category: { type: String, trim: true, default: '' },
    // The trainer's NAME — always set when there is a trainer, whoever they are.
    // `trainerUser` is set as well when they were picked from the staff list; an
    // outside trainer is the name alone. Kept as the display field because every
    // client already reads it, including the app builds still in people's pockets.
    trainer: { type: String, trim: true },
    trainerUser: { type: ObjectId, ref: 'User', default: null },
    startDate: Date,
    endDate: Date,
    status: { type: String, enum: TRAINING_STATUS, default: 'Planned' },
    // When somebody marked it finished (manual Completed). The clock's own
    // completion leaves this empty — the end time already says when.
    completedAt: Date,
    participants: [{ type: ObjectId, ref: 'User' }],
    // Where the session happens online. Pasted by hand, or created by the
    // server through Google Calendar — in which case `meetEventId` is the
    // calendar event that carries it (and its invites), kept so a reschedule or
    // a change of attendees moves the same event instead of minting another.
    meetingLink: { type: String, trim: true, default: '' },
    meetEventId: { type: String, default: undefined },
    attachments: { type: [attachmentSchema], default: [] },
    attendance: { type: [attendanceSchema], default: [] },
    feedback: { type: [feedbackSchema], default: [] },
    // Worker claims (services/trainingWorker) — each notice goes out once.
    reminderSentAt: Date,
    feedbackAskedAt: Date,
    createdBy: { type: ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

trainingSchema.index({ startDate: -1 });
trainingSchema.index({ participants: 1 });
trainingSchema.index({ trainerUser: 1 });
trainingSchema.index({ status: 1, startDate: 1 });

// The GridFS key is a server detail — never hand it to a client.
trainingSchema.set('toJSON', {
  transform(_doc, ret) {
    if (Array.isArray(ret.attachments)) {
      ret.attachments = ret.attachments.map(({ storagePath, ...rest }) => rest); // eslint-disable-line no-unused-vars
    }
    delete ret.meetEventId;
    return ret;
  },
});

// Audit-status plugin: logs `status` transitions to AuditLog (labelled by title).
trainingSchema.plugin(require('./plugins/auditStatus'), { label: (d) => d.title });

module.exports = mongoose.model('Training', trainingSchema);
module.exports.TRAINING_STATUS = TRAINING_STATUS;
