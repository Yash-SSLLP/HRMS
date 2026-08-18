/**
 * Auto-posting from the other money modules into the employee khata.
 *
 * The khata is meant to be the ONE place you can look to answer "what is the
 * money position between us and this person?". That only holds if the modules
 * that already move money between the company and an employee — loans and
 * expense claims — put their movements in it too. This file is that bridge.
 *
 * THREE RULES IT ALL RESTS ON.
 *
 *  1. EVERY POST IS IDEMPOTENT. Each hook derives a stable idempotency key from
 *     the source record, so replaying a review, retrying a request, or running
 *     a backfill posts once and only once. This is the difference between a
 *     helpful integration and one that quietly pays somebody twice.
 *
 *  2. COMPANY CASH IS RECORDED EXACTLY ONCE. Where the source module already
 *     posts its own cashbook entry — as the expense module does on
 *     reimbursement — the khata row is written with `affectsCompanyCash: false`
 *     so the cash is not counted a second time. The khata still records what
 *     the movement did to the employee's balance; it just does not re-bank it.
 *
 *  3. FAILURES NEVER BREAK THE CALLER. A khata row is a reflection of something
 *     that already happened. If writing it fails, the loan approval or expense
 *     reimbursement it mirrors must still stand, so every hook swallows its own
 *     errors and logs them. `scripts/backfillKhataLinks.js` can replay anything
 *     that was missed, precisely because rule 1 makes replay safe.
 *
 * A NOTE ON LOANS AND PAYROLL. Payroll deducts an active EMI onto the payslip
 * but does not reduce `Loan.balance` — only an explicit repayment does. The
 * khata therefore mirrors the loan module's own balance movements exactly, and
 * is neither more nor less current than the loan record it follows.
 */
const ledger = require('./khataLedger');

/**
 * Post a khata row for a source record, once.
 * @param {object} input - As accepted by khataLedger.postEntry.
 * @param {object} actor - The acting user.
 * @param {string} label - What is being synced, for the log line on failure.
 * @returns {Promise<object|null>} The entry, or null if it could not be written.
 */
async function safePost(input, actor, label) {
  try {
    const { entry, duplicate } = await ledger.postEntry(input, actor);
    if (duplicate) return entry; // already mirrored; nothing more to do
    return entry;
  } catch (err) {
    // Rule 3: the underlying money event has already happened and must stand.
    console.error(`khata sync (${label}) failed:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

/**
 * Mirror a loan disbursement into the borrower's khata.
 *
 * Called when a loan first becomes Active — the point at which the employee
 * actually receives the principal and starts owing it.
 *
 * The loan module has never posted its payouts to the cashbook, so by default
 * neither does this: the khata records that the employee now owes the principal
 * and leaves the company's cash books alone. Pass `cashAccount` to also bank it
 * properly, which is the better practice where the reviewer knows the account.
 * @param {object} loan - The Loan document, already saved as Active.
 * @param {object} actor - The reviewing user.
 * @param {object} [opts]
 * @param {string} [opts.cashAccount] - Bank the payout against this account too.
 * @returns {Promise<object|null>} The khata entry, or null on failure.
 */
async function syncLoanDisbursement(loan, actor, opts = {}) {
  if (!loan || !loan.employee || !(loan.principal > 0)) return null;
  return safePost({
    employee: loan.employee,
    direction: 'to_employee',
    type: 'advance',
    amount: loan.principal,
    date: loan.disbursedOn || new Date(),
    purpose: `${loan.type} disbursed${loan.reason ? ` — ${loan.reason}` : ''}`,
    category: loan.type,
    paymentMode: opts.cashAccount ? 'Bank' : 'Adjustment',
    cashAccount: opts.cashAccount || undefined,
    affectsCompanyCash: !!opts.cashAccount,
    autoApprove: true,
    // One disbursement per loan, ever.
    idempotencyKey: `loan:${loan._id}:disbursed`,
    source: { sourceLoan: loan._id },
  }, actor, `loan ${loan._id} disbursement`);
}

/**
 * Mirror a recorded loan repayment into the borrower's khata.
 * @param {object} loan - The Loan document.
 * @param {number} amount - The repayment just recorded.
 * @param {object} actor - The user recording it.
 * @param {object} [opts]
 * @param {string} [opts.cashAccount] - Bank the receipt against this account too.
 * @returns {Promise<object|null>}
 */
async function syncLoanRepayment(loan, amount, actor, opts = {}) {
  if (!loan || !(amount > 0)) return null;
  return safePost({
    employee: loan.employee,
    direction: 'from_employee',
    type: 'salary_recovery',
    amount,
    date: new Date(),
    purpose: `Repayment against ${loan.type}`,
    category: loan.type,
    paymentMode: opts.cashAccount ? 'Cash' : 'Adjustment',
    cashAccount: opts.cashAccount || undefined,
    affectsCompanyCash: !!opts.cashAccount,
    autoApprove: true,
    // A loan can be repaid many times, so the key has to vary per repayment.
    // The running balance AFTER this repayment is unique within one loan, which
    // makes a replayed request idempotent while genuine instalments are not.
    idempotencyKey: `loan:${loan._id}:repay:${ledger.round2(loan.balance)}`,
    source: { sourceLoan: loan._id },
  }, actor, `loan ${loan._id} repayment`);
}

// ---------------------------------------------------------------------------
// Expense claims
// ---------------------------------------------------------------------------

/**
 * Mirror an approved expense claim: the employee spent their own money, so the
 * company now owes them.
 *
 * No company cash moves at approval — the money left the EMPLOYEE's pocket, at
 * the shop, before any of this. So `affectsCompanyCash` is false and only the
 * khata balance shifts, into "you will give".
 * @param {object} expense - The Expense document.
 * @param {object} actor - The approving user.
 * @returns {Promise<object|null>}
 */
async function syncExpenseApproved(expense, actor) {
  if (!expense || !expense.employee || !(expense.amount > 0)) return null;
  return safePost({
    employee: expense.employee._id || expense.employee,
    direction: 'from_employee',
    type: 'expense',
    amount: expense.amount,
    date: expense.expenseDate || expense.createdAt || new Date(),
    purpose: `Own spend — ${expense.category}${expense.merchant ? ` (${expense.merchant})` : ''}`,
    category: expense.category,
    paymentMode: 'Adjustment',
    referenceNo: expense.code || undefined,
    affectsCompanyCash: false,
    autoApprove: true,
    idempotencyKey: `expense:${expense._id}:approved`,
    source: { sourceExpense: expense._id },
  }, actor, `expense ${expense._id} approval`);
}

/**
 * Mirror a reimbursement: the company has paid the claim back, squaring it.
 *
 * IMPORTANT — the approval leg is posted first if it is missing. A claim taken
 * straight to Reimbursed without ever passing through Approved would otherwise
 * post only the money-out leg, and the employee's khata would wrongly read as
 * though they OWED what they had just been paid back. Posting both is what
 * makes the pair net to zero, which is the only correct outcome.
 *
 * `affectsCompanyCash` is false because expenseController has already written
 * the cashbook entry for this payout (see its `sourceExpense` row). Counting it
 * here as well would double the money leaving the company.
 * @param {object} expense - The Expense document, already marked Reimbursed.
 * @param {object} actor - The user who reimbursed it.
 * @returns {Promise<object|null>}
 */
async function syncExpenseReimbursed(expense, actor) {
  if (!expense || !expense.employee || !(expense.amount > 0)) return null;

  // Guarantee the pair. safePost is idempotent, so this is a no-op when the
  // claim did pass through Approved normally.
  await syncExpenseApproved(expense, actor);

  return safePost({
    employee: expense.employee._id || expense.employee,
    direction: 'to_employee',
    type: 'reimbursement',
    amount: expense.amount,
    date: new Date(),
    purpose: `Reimbursed — ${expense.category}`,
    category: expense.category,
    paymentMode: 'Adjustment',
    referenceNo: expense.code || undefined,
    // The cashbook leg is already posted by the expense module. See above.
    affectsCompanyCash: false,
    autoApprove: true,
    idempotencyKey: `expense:${expense._id}:reimbursed`,
    source: { sourceExpense: expense._id },
  }, actor, `expense ${expense._id} reimbursement`);
}

module.exports = {
  syncLoanDisbursement,
  syncLoanRepayment,
  syncExpenseApproved,
  syncExpenseReimbursed,
};
