/**
 * Company letterhead / boilerplate used by generated letters (offer, appointment).
 * Values default to Sequence Surfaces LLP (from the sample offer letter) but can be
 * overridden per-environment via env vars without touching the letter renderer.
 */
const COMPANY = {
  name: process.env.ORG_DISPLAY_NAME || 'Sequence Surfaces LLP',
  tagline: process.env.ORG_TAGLINE || 'An Exclusive Laminate Company',
  addressLines:
    (process.env.ORG_ADDRESS_LINES && process.env.ORG_ADDRESS_LINES.split('|')) || [
      '#46/1, 1st Main Road',
      'B/H Amba Maheshwari Temple',
      'Magadi Main Road, Kamakshipalya',
      'Bangalore, Karnataka - 560079',
    ],
  phone: process.env.ORG_PHONE || '+91 96069 98652',
  email: process.env.ORG_EMAIL || '',
  gstin: process.env.ORG_GSTIN || '29AELFS7558A1ZM',
  // Defaults for the letter signatory block (overridable per-letter from the form).
  defaultSignatoryName: process.env.ORG_HR_SIGNATORY || 'Reena Angel',
  defaultSignatoryTitle: process.env.ORG_HR_TITLE || 'Human Resources Business Partner',
  // Governing-law state for the appointment letter's standard clauses.
  governingState: process.env.ORG_GOVERNING_STATE || 'Karnataka',
  logoPath: process.env.ORG_LOGO_PATH || null,
};

module.exports = COMPANY;
