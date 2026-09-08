/**
 * Employee codes that are spoken for but do not belong to an employee yet.
 *
 * An appointment letter allots the code BEFORE the person joins — that is the
 * whole point of the letter — so between issuing it and the candidate being
 * converted to an employee there is no EmployeeProfile carrying that code.
 * Anything that answers "is this code free?" by looking only at EmployeeProfile
 * therefore says yes to a code already printed on somebody's signed contract,
 * and two letters issued in the same week get the same suggestion.
 *
 * `already converted` is the one case to exclude: once a candidate becomes an
 * employee their code lives on their profile, and counting it here as well would
 * make the code look doubly taken and, worse, make the next suggestion skip a
 * number for no reason.
 */
const mongoose = require('mongoose');
const Candidate = require('../models/Candidate');

/**
 * An exclude-id only narrows the query, so anything unusable is simply dropped.
 * It arrives from a query string, and feeding a non-ObjectId straight into the
 * filter turns a harmless typo into a 500 from a live-validation endpoint the
 * form calls on every keystroke.
 */
const asId = (v) => (v && mongoose.isValidObjectId(v) ? v : null);

/** Candidates holding a letter whose code has not become an employee's yet. */
const UNCONVERTED = {
  'appointment.data.employeeCode': { $nin: [null, ''] },
  // `employee.user` is set by the recruitment conversion — see
  // recruitmentController's convertToEmployee.
  $or: [{ 'employee.user': { $exists: false } }, { 'employee.user': null }],
};

/**
 * Every code currently reserved by an unconverted appointment letter.
 * @param {*} [excludeCandidateId] - a candidate whose own reservation to ignore
 * @returns {Promise<string[]>} normalised (upper-case, trimmed) codes
 */
async function reservedAppointmentCodes(excludeCandidateId = null) {
  const filter = { ...UNCONVERTED };
  const skip = asId(excludeCandidateId);
  if (skip) filter._id = { $ne: skip };
  const rows = await Candidate.find(filter).select('appointment.data.employeeCode').lean();
  return rows
    .map((c) => String(c.appointment?.data?.employeeCode || '').trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Who a code is promised to, if anybody.
 *
 * Returns the candidate's NAME rather than a boolean so the form can say which
 * letter already has it — "already promised to Asha Patel" is actionable where
 * "taken" leaves HR guessing whether they can overrule it.
 *
 * @param {string} code
 * @param {*} [excludeCandidateId] - the candidate whose letter is being edited
 * @returns {Promise<string|null>} the candidate's name, or null when free
 */
async function appointmentCodeHolder(code, excludeCandidateId = null) {
  const wanted = String(code || '').trim().toUpperCase();
  if (!wanted) return null;
  const filter = { ...UNCONVERTED };
  const skip = asId(excludeCandidateId);
  if (skip) filter._id = { $ne: skip };
  const rows = await Candidate.find(filter).select('name appointment.data.employeeCode').lean();
  const hit = rows.find(
    (c) => String(c.appointment?.data?.employeeCode || '').trim().toUpperCase() === wanted
  );
  return hit ? (hit.name || 'another candidate') : null;
}

module.exports = { reservedAppointmentCodes, appointmentCodeHolder };
