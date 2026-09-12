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
 *
 * A line that FOLLOWS a `- Heading:` line without starting one of its own is a
 * further paragraph of that same term. The appointment letter's longer clauses
 * run to four or five paragraphs each, and before this they could only be
 * written as one unbroken block of type.
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
    'The body of the appointment letter PDF issued once a candidate joins. Page layout, letterhead, the key-facts panel, the signature block and Annexure I stay fixed. Inside a numbered clause, a line break starts a new paragraph.',
`We are delighted to extend this letter of appointment to you for full-time employment with {{companyName}}. Your appointment is subject to the terms and conditions set out below and to the Company's policies as applicable from time to time.

- Date of Appointment: Your appointment will be effective from {{joiningDate}}.
- Salary & Compensation: Your total annual compensation is {{salaryAnnual}}. The detailed break-up of your pay package is provided in Annexure I attached to this letter.
Your salary will ordinarily be paid between the 7th and 10th of every month, subject to payroll processing and applicable statutory deductions.
Your compensation package has been determined with reference to your candidature, qualifications, relevant experience, skill set and the assessment conducted during the selection process. Accordingly, the package is specific to your role and candidature.
The Company may, in accordance with applicable requirements and Company policy, revise the internal composition of salary components or allowances from time to time. Any such revision will be communicated as applicable.
- Reporting Function: You will report to the {{reportingTo}}, or to such other person as may be designated by the management from time to time.
- Placement: You are appointed as a full-time employee of {{companyName}}. Your normal place of work will be {{placeOfWork}}. You may also be required to work at other locations or travel for Company work where reasonably necessary for the performance of your duties.
- Probation Period: You will be on probation for a period of {{probationPeriod}} from the first day of the calendar month following your date of joining, unless otherwise communicated in writing.
Your performance, conduct, attendance, suitability for the role and adherence to Company policies will be reviewed during the probation period. The Company may confirm your employment, extend the probation period or discontinue employment in accordance with the terms of employment and applicable law.
You will continue to remain on probation until your services are formally confirmed in writing by the Company.
- Leave & Holidays: Employees are eligible for {{annualLeaveDays}} days of paid leave per year, subject to the Company's leave policy, approval procedures and applicable law.
Sick leave may be granted subject to the applicable leave rules. Where an employee takes more than two consecutive days of sick leave, the Company may require a medical certificate and supporting documentation.
Paid leave and sick leave will be administered in accordance with Company policy and may not be clubbed where the applicable policy does not permit such combination. Leave encashment, if any, will be governed by the Company's policy and applicable law.
Absence for a continuous period of 10 days without prior approval or adequate communication, including unauthorised overstaying of leave or training, may be treated as unauthorised absence and may result in disciplinary action, up to and including termination, subject to applicable requirements.
- Working Hours: The normal working days are Monday to Saturday. Normal working hours are {{workingHours}}, with a 30-minute lunch break and two tea breaks of 15 minutes each.
You are expected to adhere strictly to the prescribed working hours and attendance requirements. Repeated late coming or irregular attendance may result in loss of pay and/or disciplinary action in accordance with Company policy. Unauthorised or unreported absence will not be treated as hours worked and will be subject to applicable loss-of-pay rules.
The Company reserves the right to modify working days or hours based on business requirements, subject to applicable requirements.
- Confidential Information: During your employment, you may acquire or develop confidential and proprietary information relating to the Company's business, operations, customers, clients, vendors, pricing, designs, processes, employees, commercial arrangements and other affairs (collectively, "Confidential Information").
You agree that such Confidential Information is for the Company's benefit and must not, during or after your employment, be directly or indirectly used, copied, disclosed or shared except for authorised Company purposes or with the Company's written consent.
You may also be required to execute a separate Non-Disclosure Agreement (NDA). The obligations contained in such NDA will apply in addition to the confidentiality obligations stated in this appointment letter.
- Compensation Confidentiality: Your compensation details are specific to your candidature and are to be treated as confidential, subject to any disclosure required by law or authorised by the Company. Unauthorised disclosure or misuse of compensation information may be dealt with under the Company's applicable policies.
- Whole-time Service & Conflict of Interest: You are expected to devote your professional time and attention to your duties and to act in the best interests of the Company.
You must not divulge or misuse trade secrets, confidential information or other proprietary information obtained through your employment.
You must not, without prior written approval from the Company, undertake outside employment, business activity, consultancy or other engagement that conflicts with your duties or the Company's interests.
- Resignation & Termination: After confirmation, your services may be terminated by either party by giving {{noticePeriodPossessive}} written notice or salary in lieu of the applicable notice period, subject to the terms of employment and applicable law.
The Company may terminate employment for misconduct, serious policy violations, breach of confidentiality or NDA obligations, conflict of interest, material misrepresentation, or other lawful grounds, in accordance with applicable requirements.
Where an employee leaves without serving the applicable notice period or without proper communication, the Company may recover applicable notice pay or other dues in accordance with the terms of employment and applicable law.
In cases of unauthorised absence or suspected absconding, the Company may initiate appropriate disciplinary and separation procedures after reasonable attempts to contact the employee.
- Notice Period: The applicable notice period after confirmation is {{noticePeriod}}. The notice period cannot ordinarily be adjusted against available leave unless specifically approved by the Company.
During the notice period, you are required to complete a proper handover of responsibilities, documents, Company property and work-related information. Your final release date will be communicated after completion of the required handover and exit formalities.
- Communication: You are required to promptly inform the Company of any change in your residential address, contact details or other employment-related personal information required for official records.
- Dress Code: Employees are expected to maintain a professional and well-groomed appearance when attending the workplace or representing the Company before clients, visitors, vendors or other external parties.
All clothing must be clean, appropriate and professional. Employees may follow appropriate attire consistent with their personal, religious or cultural practices while maintaining workplace professionalism.
Formals or semi-formals are expected on weekdays. Appropriate Indian attire, formals or semi-formals may equally be worn.
- Retirement: The normal retirement age will be {{retirementAge}} years, subject to applicable law and Company policy.
- General Provisions: Malicious, derogatory or disruptive gossip, harassment, intimidation or conduct that adversely affects the workplace may be treated as a violation of Company policy and may result in disciplinary action.
Prevention of Sexual Harassment (POSH): {{companyName}} is committed to providing a safe, respectful and inclusive workplace. Any unwelcome physical, verbal, written, electronic, visual, psychological or other conduct of a sexual nature, or conduct that violates workplace dignity, may be treated as sexual harassment or inappropriate workplace conduct. Employees may raise concerns through the Company's designated internal mechanism, and complaints will be handled in accordance with applicable law and Company policy, with appropriate confidentiality and due process.
This appointment is subject to satisfactory verification of the information and references provided by you during the recruitment process. You will become eligible for applicable Company benefits in accordance with Company rules, your employment terms and applicable law.
- Travel: You may be required to undertake travel for Company work. Approved business travel expenses will be reimbursed in accordance with the Company's Travel Policy and applicable approval procedures.
- Company Property: You must take reasonable care of Company property entrusted to you for official use, including documents, devices, equipment, access cards, keys, records and other assets.
All Company property must be returned upon request and, in any event, before or upon separation from employment. Any recovery arising from loss or damage will be dealt with in accordance with applicable law and Company policy.
- Exit Formalities: Exit formalities will be completed on or before your last working day, subject to the Company's clearance process.
Final settlement and issuance of service or separation documents will be subject to completion of the required handover, return of Company property, clearance of outstanding dues and approvals from the concerned departments, in accordance with Company policy and applicable requirements.
- Policy Compliance: You are required to comply with all applicable Company policies, procedures, lawful instructions and standards of professional conduct, including policies relating to attendance, leave, confidentiality, workplace behaviour, information security and use of Company property.
- Acceptance of Appointment: Please confirm your acceptance of the above terms by signing and dating a copy of this appointment letter and returning it to the Company. Annexure I should also be signed in token of acceptance.

**We welcome you to {{companyName}} and look forward to a productive and successful association with you.**`,
    ['candidateName', 'position', 'department', 'departmentClause', 'companyName', 'salaryMonthly',
      'salaryAnnual', 'joiningDate', 'employeeCode', 'location', 'companyCity', 'hrEmailClause',
      // The appointment letter's own wording. These print a PHRASE, not a number
      // — "one month" rather than "30 days", "two months'" with the apostrophe in
      // the right place — because that is how the clause is actually spoken.
      'reportingTo', 'placeOfWork', 'workingHours', 'probationPeriod', 'probationMonths',
      'noticePeriod', 'noticePeriodPossessive', 'noticePeriodDays', 'annualLeaveDays',
      'retirementAge', 'employmentType']
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
