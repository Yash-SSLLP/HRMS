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
    'Offer Letter - {{companyName}}',
    `Dear {{candidateName}},

Please find attached your Offer Letter from {{companyName}}.{{linkClause}}

Kindly review the document and revert with your acceptance.

Warm regards,
{{hrName}}
{{companyName}}`,
    // linkClause is the whole "you can also view it online" sentence plus the
    // URL, or nothing at all: a letter with no public token has no link, and a
    // template cannot express "omit this line" on its own.
    ['candidateName', 'position', 'companyName', 'acceptanceDeadline', 'joiningDate',
      'link', 'linkClause', 'hrName']
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
    'Letter of Appointment - {{companyName}}',
    `Dear {{candidateName}},

Please find attached your Letter of Appointment from {{companyName}}.{{linkClause}}

Kindly review the document and revert with your acceptance.

Warm regards,
{{hrName}}
{{companyName}}`,
    ['candidateName', 'position', 'companyName', 'joiningDate', 'link', 'linkClause', 'hrName']
  ),

  mail(
    'candidate.documents',
    'Candidate document request',
    'Recruitment',
    'Sent to a candidate asking them to upload their onboarding documents.',
    'Documents required for your onboarding - {{companyName}}',
    `Dear {{candidateName}},

Congratulations on clearing your interviews with {{companyName}}.

To take your joining formalities forward, please upload the documents listed below using the secure link at the end of this email. No login is needed, and you can preview each file before you send it.

{{documentList}}

Upload here:
{{link}}

Please keep each file under 10 MB, in PDF, Word, JPG or PNG format. Write back to this email if any document is not available with you right now.

Warm regards,
{{hrName}}
{{companyName}}`,
    // documentList is rendered by the server from DOC_TYPES — editing this
    // template changes the wording around the list, never the list itself.
    ['candidateName', 'companyName', 'link', 'documentList', 'hrName']
  ),

  mail(
    'employee.documents',
    'Employee document request',
    'People',
    'Sent from an employee’s record (“Email link”) with their secure upload link. {{documentList}} is the set of documents still outstanding for that person, filled in by the server.',
    'Documents required - {{companyName}}',
    `Dear {{employeeName}},

Please upload the documents listed below using the secure link at the end of this email. No login is needed, and you can preview each file before you send it.

{{documentList}}

Upload here:
{{link}}

Please keep each file under 10 MB, in PDF, Word, JPG or PNG format. Write back to this email if any document is not available with you right now.

Warm regards,
{{hrName}}
{{companyName}}`,
    ['employeeName', 'employeeCode', 'companyName', 'link', 'documentList', 'hrName']
  ),

  mail(
    'payslip.mail',
    'Payslip email',
    'Payroll',
    'The email a released payslip is sent with.',
    'Payslip · {{period}}',
    `Dear {{employeeName}},

Please find attached your payslip for {{period}}. You can also view and download it anytime from the link below:

{{link}}

Regards,
{{hrName}}`,
    ['employeeName', 'employeeCode', 'period', 'companyName', 'link', 'hrName']
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
    'Sent from the Exit console (“Email Letter”) with the relieving letter PDF attached. Separate from the exit email below, which links to the same letter — use this one to reissue it later.',
    'Your relieving letter - {{companyName}}',
    `Dear {{employeeName}},

Please find attached your relieving letter from {{companyName}}, confirming that you have been relieved of your duties with effect from {{lastWorkingDay}}.{{linkClause}}

We thank you for your contribution and wish you every success ahead.

Warm regards,
{{hrName}}
{{companyName}}`,
    // linkClause, not a bare {{link}}: an exit with no feedback token has no
    // public page, and an unset variable is left as the literal placeholder —
    // which would ship "{{link}}" to a leaver.
    ['employeeName', 'employeeCode', 'companyName', 'lastWorkingDay', 'link', 'linkClause', 'hrName']
  ),

  mail(
    'exit.feedback',
    'Exit feedback request',
    'People',
    'Sent to a leaver inviting them to complete the exit feedback form.',
    'Thank you for your time with {{companyName}}',
    `Dear {{employeeName}},

Your last working day with {{companyName}} was {{lastWorkingDay}}. On behalf of the entire team, thank you for your time and contributions - we wish you the very best in your future endeavours.

Your relieving letter is ready. You can download it here, without signing in - please keep a copy for your records:
{{link}}

As part of our offboarding process, we'd be grateful if you could spare a few minutes to share your feedback. Your honest input helps us become a better workplace for everyone who comes after you. The feedback form is on the same page.

If you have any questions or need help, feel free to reply directly to this email - it will reach me.

Warm regards,
{{hrName}}
HR - {{companyName}}`,
    // One mail covers both halves of an exit: the relieving letter and the
    // feedback form live on the SAME tokenised page, so {{link}} serves both.
    // (That is also why 'relieving.mail' has no send site of its own.)
    ['employeeName', 'employeeCode', 'companyName', 'link', 'lastWorkingDay', 'hrName']
  ),

  mail(
    'account.emailChanged',
    'Sign-in email changed',
    'People',
    'Notifies a user that the email they sign in with has been changed.',
    'Your sign-in email has been updated - {{companyName}}',
    `Dear {{employeeName}},

Your {{companyName}} HRMS sign-in email has been updated by HR. From now on, please sign in with this address:

  {{newEmail}}

Your password has not changed.

Sign in here:
{{link}}

If you were not expecting this, please contact HR straight away.

Regards,
{{hrName}}
{{companyName}}`,
    // `oldEmail` is deliberately NOT offered. This mail goes to the NEW address,
    // and if HR mistyped it that is a stranger's inbox — which must not be handed
    // the employee's previous address. See notifyEmailChanged in adminController.
    ['employeeName', 'companyName', 'newEmail', 'link', 'hrName']
  ),

  mail(
    'passwordReset.request',
    'Password reset request (to HR)',
    'People',
    'Sent to the HR Managers and Super Admins the moment somebody files a password-reset request from the login page. Goes to exactly the people who get the in-app notification.',
    'Password reset requested - {{name}} ({{employeeCode}})',
    `{{name}} ({{employeeCode}}) cannot sign in and has asked for their password to be reset.

What they entered on the login page:
  Email        {{email}}
  Phone        {{phone}}
  Designation  {{designation}}
  Department   {{department}}
  Reason       {{reason}}

Open the request to set a new password or mark it resolved:
{{link}}

This is an automated message - the person who raised it is locked out and waiting.

{{companyName}} HRMS`,
    ['name', 'employeeCode', 'email', 'phone', 'designation', 'department', 'reason',
      'link', 'companyName']
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
