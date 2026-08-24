/**
 * The catalogue of editable email and letter templates.
 *
 * This file — not the database — is the source of truth for WHICH templates
 * exist, what variables each one may use, and what it says by default. A row in
 * models/Template.js is only ever an override of one of these entries, so an
 * untouched template keeps following the shipped wording and "reset" is simply
 * dropping the override.
 *
 * Adding a template:
 *   1. add an entry here (stable `key` — it is stored on override rows);
 *   2. call renderMail()/renderLetterBody() from services/templates.js at the
 *      send site, passing exactly the variables listed below.
 * Anything listed in `variables` but not supplied at render time is left as the
 * literal placeholder, which is a visible, debuggable failure rather than the
 * word "undefined" going out to a candidate.
 */

/** A mail template: editable subject + body. */
const mail = (key, name, group, description, subject, body, variables) =>
  ({ key, name, group, description, format: 'mail', subject, body, variables });

/**
 * A letter template: body only. The text becomes the letter's paragraphs —
 * blank line separates paragraphs, a line wrapped in **double asterisks** is
 * bold, and a line written as `- Heading: text` becomes a numbered term.
 */
const letter = (key, name, group, description, body, variables) =>
  ({ key, name, group, description, format: 'letter', subject: '', body, variables });

const TEMPLATES = [
  letter(
    'offer.letter',
    'Offer letter',
    'Recruitment',
    'The body of the offer letter PDF sent to a selected candidate. Page layout, letterhead and signature block stay fixed.',
    `This is with reference to the interview {{interviewRef}}. We are pleased to inform you that you have been selected for the position of {{position}}{{departmentClause}} at {{companyName}} on the terms and conditions discussed during the interview.

**"Your in-hand salary will be {{salaryMonthly}} per month which is {{salaryAnnual}} per annum".**

The probation period shall be for {{probationMonths}} months during which the company holds the right to assess your performance, citing any shortfalls against desirable performance; the organization holds the right to end your employment with a notice period of {{noticePeriodDays}} days or immediately.

**Your official joining date is from {{joiningDate}}.**

Please confirm your acceptance by replying to this email or digitally signing the attached document by {{acceptanceDeadline}}. On joining of duty, you will be issued a letter of appointment with all terms and conditions.

In case you don't join us by the stipulated date, the offer stands Cancelled / Withdrawn.

**We congratulate you on this offer and appreciate if you join us on the given date.**`,
    ['candidateName', 'position', 'department', 'departmentClause', 'companyName', 'salaryMonthly',
      'salaryAnnual', 'probationMonths', 'noticePeriodDays', 'joiningDate', 'acceptanceDeadline', 'interviewRef']
  ),

  mail(
    'offer.mail',
    'Offer letter email',
    'Recruitment',
    'The covering email the offer letter PDF is attached to.',
    'Your offer of employment — {{companyName}}',
    `Dear {{candidateName}},

Please find attached your offer letter for the position of {{position}} at {{companyName}}.

Kindly confirm your acceptance by {{acceptanceDeadline}}.

Warm regards,
{{companyName}} · HR`,
    ['candidateName', 'position', 'companyName', 'acceptanceDeadline', 'joiningDate', 'link']
  ),

  letter(
    'appointment.letter',
    'Appointment letter',
    'Recruitment',
    'The body of the appointment letter PDF issued once a candidate joins.',
    `We are pleased to appoint you as {{position}}{{departmentClause}} at {{companyName}} with effect from {{joiningDate}}.

- Remuneration: Your total remuneration will be {{salaryAnnual}} per annum, payable monthly, subject to statutory deductions.
- Probation: You will be on probation for {{probationMonths}} months from the date of joining.
- Notice period: Either party may terminate this employment by giving {{noticePeriodDays}} days' written notice.
- Confidentiality: You shall not disclose any confidential information of the company during or after your employment.

**We welcome you to {{companyName}} and look forward to a long and rewarding association.**`,
    ['candidateName', 'position', 'department', 'departmentClause', 'companyName', 'salaryMonthly',
      'salaryAnnual', 'probationMonths', 'noticePeriodDays', 'joiningDate']
  ),

  mail(
    'appointment.mail',
    'Appointment letter email',
    'Recruitment',
    'The covering email the appointment letter PDF is attached to.',
    'Your appointment letter — {{companyName}}',
    `Dear {{candidateName}},

Welcome aboard. Please find attached your appointment letter for the position of {{position}}.

Warm regards,
{{companyName}} · HR`,
    ['candidateName', 'position', 'companyName', 'joiningDate', 'link']
  ),

  mail(
    'candidate.documents',
    'Candidate document request',
    'Recruitment',
    'Sent to a candidate asking them to upload their onboarding documents.',
    'Documents required for your onboarding - {{companyName}}',
    `Dear {{candidateName}},

To complete your onboarding, please upload the required documents using the secure link below. You will not need to sign in.

{{link}}

Warm regards,
{{companyName}} · HR`,
    ['candidateName', 'companyName', 'link']
  ),

  mail(
    'employee.documents',
    'Employee document request',
    'People',
    'Sent to an employee when HR needs missing or corrected documents.',
    'Action needed on your documents - {{companyName}}',
    `Dear {{employeeName}},

Some of your documents still need attention. Please upload them using the secure link below.

{{link}}

Warm regards,
{{companyName}} · HR`,
    ['employeeName', 'employeeCode', 'companyName', 'link']
  ),

  mail(
    'payslip.mail',
    'Payslip email',
    'Payroll',
    'The email a released payslip is sent with.',
    'Payslip · {{period}}',
    `Dear {{employeeName}},

Please find your payslip for {{period}} attached. You can also view it any time from the employee portal.

{{link}}

Warm regards,
{{companyName}} · HR`,
    ['employeeName', 'employeeCode', 'period', 'companyName', 'link']
  ),

  letter(
    'relieving.letter',
    'Relieving letter',
    'People',
    'The body of the relieving letter PDF issued to a leaver once their notice is served and no-dues clearance is complete. Page layout, letterhead and signature block stay fixed.',
    `This is to certify that {{employeeName}}{{employeeCodeClause}} was employed with {{companyName}} as {{designation}}{{departmentClause}} from {{joiningDate}} to {{lastWorkingDay}}.

The resignation tendered has been accepted, and {{employeeName}} stands relieved of all duties with effect from the close of business on {{lastWorkingDay}}.

**All company property has been returned and no dues remain outstanding as on the date of this letter.**

During the tenure with us, {{employeeName}} was found to be sincere and diligent in the discharge of the responsibilities assigned.

**We thank {{employeeName}} for the contribution made to {{companyName}} and wish every success in the future.**`,
    ['employeeName', 'employeeCode', 'employeeCodeClause', 'designation', 'department', 'departmentClause',
      'companyName', 'joiningDate', 'lastWorkingDay']
  ),

  mail(
    'relieving.mail',
    'Relieving letter email',
    'People',
    'The covering email the relieving letter PDF is attached to.',
    'Your relieving letter — {{companyName}}',
    `Dear {{employeeName}},

Please find attached your relieving letter from {{companyName}}, confirming that you have been relieved of your duties with effect from {{lastWorkingDay}}.

You can also view it here: {{link}}

We thank you for your contribution and wish you every success ahead.

Warm regards,
{{companyName}} · HR`,
    ['employeeName', 'employeeCode', 'companyName', 'lastWorkingDay', 'link']
  ),

  mail(
    'exit.feedback',
    'Exit feedback request',
    'People',
    'Sent to a leaver inviting them to complete the exit feedback form.',
    'Thank you for your time with {{companyName}}',
    `Dear {{employeeName}},

Thank you for your contribution to {{companyName}}. We would value your feedback about your time with us — it takes only a few minutes.

{{link}}

We wish you every success ahead.

Warm regards,
{{companyName}} · HR`,
    ['employeeName', 'employeeCode', 'companyName', 'link', 'lastWorkingDay']
  ),

  mail(
    'account.emailChanged',
    'Sign-in email changed',
    'People',
    'Notifies a user that the email they sign in with has been changed.',
    'Your sign-in email has been updated - {{companyName}}',
    `Dear {{employeeName}},

The email address you use to sign in to {{companyName}} HRMS has been changed to {{newEmail}}.

If you did not expect this, please contact HR immediately.

Warm regards,
{{companyName}} · HR`,
    ['employeeName', 'companyName', 'newEmail', 'oldEmail']
  ),
];

const BY_KEY = new Map(TEMPLATES.map((t) => [t.key, t]));

/** @returns {Array} The full catalogue (defaults, no overrides applied). */
const listRegistry = () => TEMPLATES;
/** @param {string} key @returns {Object|undefined} */
const getRegistry = (key) => BY_KEY.get(key);
/** @param {string} key @returns {boolean} */
const isTemplateKey = (key) => BY_KEY.has(key);

module.exports = { listRegistry, getRegistry, isTemplateKey };
