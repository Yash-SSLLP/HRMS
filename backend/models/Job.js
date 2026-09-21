const mongoose = require('mongoose');

// A job opening / requisition in the recruitment module. Candidates apply against
// a Job; drives the hiring pipeline.
// Open -> accepting candidates; OnHold -> paused; Closed -> filled or cancelled.
const JOB_STATUS = ['Open', 'OnHold', 'Closed'];

const jobSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    department: { type: String, trim: true },
    // WHERE THE OPENING IS. One requisition is routinely open in several places
    // at once — the same Telecaller role in Delhi, Indore and Raipur — and one
    // string could only name one of them, so the posting carried the wrong city
    // for every applicant but one. `locations` is the list, and it is what the
    // public form makes the applicant choose from (Candidate.location) so an
    // application says which branch it is for.
    //
    // `location` is the LEGACY single field, kept in step as the first entry so
    // anything still reading it (old rows, an export, a letter draft) keeps
    // working. Read the list through jobLocations() below rather than either
    // field directly — it is what reconciles a pre-list job with a new one.
    locations: { type: [String], default: [] },
    location: { type: String, trim: true },
    employmentType: {
      type: String,
      enum: ['FullTime', 'PartTime', 'Contract', 'Intern'],
      default: 'FullTime',
    },
    openings: { type: Number, default: 1, min: 0 },
    description: { type: String, trim: true },
    status: { type: String, enum: JOB_STATUS, default: 'Open' },
    // Which company is hiring. Null = a shared/legacy opening, visible to every
    // recruiter; set, it walls the job AND its candidates to that company's
    // admins (utils/employeeScope). A walled recruiter's new jobs get their own
    // company stamped automatically.
    company: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Audit-status plugin: logs `status` transitions to AuditLog (labelled by title).
jobSchema.plugin(require("./plugins/auditStatus"), { label: (d) => d.title });

/**
 * The places a job is hiring for, whatever era the row was written in: the list
 * when it has one, otherwise the legacy single `location`, otherwise nothing.
 * Every reader (the public form, the candidate validation, both portals) goes
 * through this so a job posted before `locations` existed behaves like a
 * one-location job rather than a locationless one.
 * @param {{locations?: string[], location?: string}} job
 * @returns {string[]}
 */
function jobLocations(job) {
  if (!job) return [];
  const list = (job.locations || []).map((l) => String(l || '').trim()).filter(Boolean);
  if (list.length) return list;
  const one = String(job.location || '').trim();
  return one ? [one] : [];
}

module.exports = mongoose.model('Job', jobSchema);
module.exports.JOB_STATUS = JOB_STATUS;
module.exports.jobLocations = jobLocations;
