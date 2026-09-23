const mongoose = require('mongoose');
const Job = require('./Job');

// A request from an outside HR consultancy (User role HRConsultancy) for the
// company to open a NEW job opening — typically a client requirement the agency
// has been told about, or a role it already has candidates for. It is a draft of
// a posting, not a posting: nothing is visible to applicants, and no candidate
// can be filed against it, until somebody who runs recruitment accepts it — HR
// (recruitment.jobs), a CEO/MD or the Backend. Accepting creates a real Job
// (Open) from it, with whatever corrections the approver made, and links it back
// here in `job`.
//
// Its own collection rather than a 'Requested' Job status: a job's status drives
// the public application form, HR's jobs list and the recruitment counts, and a
// row that belongs to an outsider until it is accepted has no business in any of
// them. It also keeps the trail — who asked, who decided, why — after the job
// itself has been edited beyond recognition.
//
// Pending -> Approved (a Job now exists) | Rejected (with a note) |
// Withdrawn (the agency took it back before anybody decided).
const JOB_REQUEST_STATUS = ['Pending', 'Approved', 'Rejected', 'Withdrawn'];

// The job's own list, read off its schema so the two can never disagree.
const EMPLOYMENT_TYPES = Job.schema.path('employmentType').enumValues;

const jobRequestSchema = new mongoose.Schema(
  {
    // ===== The posting the agency is asking for =====
    title: { type: String, required: true, trim: true, maxlength: 120 },
    // Free text: the agency cannot see the company's department list. The
    // approver maps it onto a real department when accepting.
    department: { type: String, trim: true, maxlength: 80 },
    locations: { type: [String], default: [] },
    employmentType: { type: String, enum: EMPLOYMENT_TYPES, default: 'FullTime' },
    openings: { type: Number, default: 1, min: 1, max: 500 },
    description: { type: String, trim: true, maxlength: 4000 },
    // Why the agency is asking — a client requirement, candidates already in
    // hand. Read by the approver; never copied onto the job.
    reason: { type: String, trim: true, maxlength: 1000 },
    // Which company the opening would be for. Blank = the agency did not say
    // (it covers several), and the approver decides.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },

    // ===== Who asked =====
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Frozen at the time of asking, like Candidate.consultancy.name.
    requestedByName: { type: String, trim: true },

    // ===== The decision =====
    status: { type: String, enum: JOB_REQUEST_STATUS, default: 'Pending', index: true },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    decidedByName: { type: String, trim: true },
    decidedByRole: { type: String, trim: true },
    decidedAt: { type: Date },
    // The approver's word to the agency: why it was turned down, or anything
    // about the opening as accepted.
    decisionNote: { type: String, trim: true, maxlength: 500 },
    // The opening created on approval.
    job: { type: mongoose.Schema.Types.ObjectId, ref: 'Job' },
    // Stamped when HR deletes that job (recruitmentController deleteJob), so the
    // request can say "Approved — job deleted" instead of pointing at nothing.
    // A request whose job vanished before this existed is recognised at read
    // time anyway (jobRequestController), just without the who and when.
    jobDeletedAt: { type: Date },
    jobDeletedByName: { type: String, trim: true },
  },
  { timestamps: true }
);

// Audit-status plugin: logs status transitions (approved / rejected /
// withdrawn) to AuditLog, labelled by the requested title.
jobRequestSchema.plugin(require('./plugins/auditStatus'), { label: (d) => d.title });

module.exports = mongoose.model('JobRequest', jobRequestSchema);
module.exports.JOB_REQUEST_STATUS = JOB_REQUEST_STATUS;
module.exports.EMPLOYMENT_TYPES = EMPLOYMENT_TYPES;
