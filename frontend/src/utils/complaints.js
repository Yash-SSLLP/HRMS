// Shared vocabulary for the complaints module, so the raise form, the
// employee's own list, the leadership inbox and the dashboard banner all agree
// on what a complaint with no named target is called.
//
// A complaint is either about a PERSON or about the workplace in GENERAL. The
// general case has no `against` at all (see backend/models/Complaint.js), which
// is why every screen needs one place to ask "who is this about?" rather than
// four different fallbacks — the banner used to answer "against Someone", the
// two tables answered "-", and the detail panel answered "against  ()".

// The value the pickers put on the wire in `againstUserId` to mean "no
// individual". MIRRORS Complaint.GENERAL_TARGET on the server; the server
// rejects anything else that is not a real user id.
export const GENERAL_TARGET = 'general';

export const GENERAL_LABEL = 'General (not about a specific person)';

// MIRRORS COMPLAINT_CLOSED_STATUSES in backend/controllers/complaintController.js.
// A complaint may only be deleted once it is closed — resolved (with action) or
// dismissed (without). Both are a verdict already delivered; an open or
// under-review one is a live grievance and the server refuses it.
export const CLOSED_STATUSES = ['resolved', 'dismissed'];
export const isClosedComplaint = (c) => CLOSED_STATUSES.includes(c?.status);

// True when this complaint names nobody. Reads `againstType` first — the server
// states it — and falls back to the absence of `against` so complaints filed
// before that field existed still read correctly.
export const isGeneralComplaint = (c) => c?.againstType === 'General' || !c?.against;

/**
 * Who a complaint is about, as a display string.
 * @param {object} c            a complaint, with `against` populated
 * @param {string} [general]    what to call the general case in this context
 */
export function complaintTarget(c, general = 'General') {
  if (isGeneralComplaint(c)) return general;
  const name = `${c.against.firstName || ''} ${c.against.lastName || ''}`.trim();
  return name || c.against.email || 'Someone';
}
