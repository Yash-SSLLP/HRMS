/**
 * Keep an HR consultancy's name the same everywhere it is written down.
 *
 * Several records carry the agency's name as TEXT, next to its user id — the
 * candidate's `consultancy.name`, the Round 1 it took (`interviewerName`,
 * `decidedByName`, each history `byName`), a rejection it made, and its
 * job-opening requests. Those copies are what the boards, HR's pipeline and
 * the phone app print, and a copy does not follow its account: renaming the
 * agency on the Users page left "Krishave HR" on every candidate while the
 * account itself said "Krisave HR" (user report 2026-09-23 — "change the name
 * from everywhere").
 *
 * So a consultancy rename rewrites those copies (adminController updateUser).
 * Everything is matched on the USER ID, never on the old text, so another
 * account that happens to share the name is never touched.
 */
const mongoose = require('mongoose');
const Candidate = require('../models/Candidate');
const JobRequest = require('../models/JobRequest');

/**
 * Write `fullName` onto every record that names consultancy account `userId`.
 * @param {*} userId - the HRConsultancy account
 * @param {string} fullName - its current "First Last"
 * @returns {Promise<Object<string, number>>} documents changed, per kind
 */
async function syncConsultancyName(userId, fullName) {
  const id = new mongoose.Types.ObjectId(String(userId));
  const name = String(fullName || '').trim();
  if (!name) return {};
  const [agency, interviewer, decider, history, rejection, requested, decided] = await Promise.all([
    // The agency that sent the candidate.
    Candidate.updateMany({ 'consultancy.user': id }, { $set: { 'consultancy.name': name } }),
    // The rounds it is booked on (its Round 1), and the ones it decided.
    Candidate.updateMany(
      { 'rounds.interviewer': id },
      { $set: { 'rounds.$[r].interviewerName': name } },
      { arrayFilters: [{ 'r.interviewer': id }] }
    ),
    Candidate.updateMany(
      { 'rounds.decidedBy': id },
      { $set: { 'rounds.$[r].decidedByName': name } },
      { arrayFilters: [{ 'r.decidedBy': id }] }
    ),
    // Each status change it made, in any round's history.
    Candidate.updateMany(
      { 'rounds.history.by': id },
      { $set: { 'rounds.$[].history.$[h].byName': name } },
      { arrayFilters: [{ 'h.by': id }] }
    ),
    // A candidate it rejected at Round 1.
    Candidate.updateMany({ 'rejection.by': id }, { $set: { 'rejection.byName': name } }),
    // Its job-opening requests, and any it withdrew (decided by itself).
    JobRequest.updateMany({ requestedBy: id }, { $set: { requestedByName: name } }),
    JobRequest.updateMany({ decidedBy: id }, { $set: { decidedByName: name } }),
  ]);
  const n = (r) => r?.modifiedCount ?? r?.nModified ?? 0;
  return {
    candidates: n(agency),
    roundsBooked: n(interviewer),
    roundsDecided: n(decider),
    roundHistory: n(history),
    rejections: n(rejection),
    jobRequests: n(requested),
    jobRequestsDecided: n(decided),
  };
}

module.exports = { syncConsultancyName };
