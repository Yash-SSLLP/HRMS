/**
 * The Advance Request Form — the company's printed form, as the portal asks it.
 *
 * The form itself (its fields, their order, the declaration) is fixed: it is the
 * company's own paper form, and the PDF (services/advanceFormPdf.js) reproduces
 * it line for line. Two parts of it are the company's to write, and live in the
 * settings singleton instead of here (Setting.loanForm):
 *
 *   purposes  the "Purpose of Advance" dropdown. Starts EMPTY on purpose — the
 *             list is a policy decision HR / CEO / MD / Admin make, not
 *             something the code should guess at.
 *   terms     the numbered Terms & Conditions the employee must accept. Until
 *             somebody edits them, the seven printed on the paper form apply
 *             (DEFAULT_TERMS below), so the form works the day it ships.
 *
 * Whatever terms were in force when an employee accepted them are copied onto
 * that loan (Loan.acceptance), so editing the list later never rewrites what
 * somebody already agreed to.
 */

// The seven terms printed on the paper form, in its order and wording (the
// stray capital in "and If the amount" is the one change).
const DEFAULT_TERMS = [
  'The advance amount provided is recoverable and will be deducted monthly from the employee’s salary.',
  'The employee agrees to the repayment schedule without delay.',
  'If the employee resigns, absconds, or employment is terminated, the outstanding amount will be recovered '
    + 'from the final settlement and if the amount is not settled, the company reserves the legal right to take '
    + 'appropriate action for recovery.',
  'No further advances will be issued until the current one is fully repaid.',
  'Management reserves the right to approve or reject the advance request.',
  'A 1% monthly interest will be charged on the advance amount until full repayment is completed.',
  'Any changes to the repayment plan must be approved by Management.',
];

// The form's Employee Declaration, word for word. Fixed rather than editable:
// it is what the tick box on the form says the employee is signing.
const DECLARATION = 'I hereby confirm that all the above details are correct. I agree to the terms & conditions '
  + 'and authorize salary deduction for repayment.';

// The most an employee may ask for on the form: this many times their monthly
// salary (the structure's components applied to the CTC in force this month,
// ÷ 12 — the full monthly gross a payslip starts from). Company rule set
// 2026-09-24. Applies to the employee's own request; a loan HR raises on
// somebody's behalf is HR's decision and is not capped.
const MAX_SALARY_MULTIPLE = 3;

// Limits on what can be saved, so one runaway paste cannot push the form onto a
// second sheet or turn the dropdown into a scroll of hundreds.
const MAX_PURPOSES = 40;
const MAX_PURPOSE_LENGTH = 80;
const MAX_TERMS = 20;
const MAX_TERM_LENGTH = 600;

module.exports = {
  DEFAULT_TERMS,
  DECLARATION,
  MAX_SALARY_MULTIPLE,
  MAX_PURPOSES,
  MAX_PURPOSE_LENGTH,
  MAX_TERMS,
  MAX_TERM_LENGTH,
};
