const mongoose = require('mongoose');

/**
 * One named EXPENSE BOOK belonging to an employee — a "khata".
 *
 * A khata is a folder for spending, not a pot of money. The money lives in the
 * employee's single wallet (see models/EmployeeWallet.js); a khata answers the
 * other question — what was it spent ON. A site supervisor carrying one advance
 * might open "Site A — materials", "Vehicle & fuel" and "Client hospitality",
 * and file each purchase under the right one. Every khata spends out of the
 * same wallet, so the remaining advance reads the same whichever book you have
 * open, and one book is never flush while another is empty.
 *
 * WHY IT WORKS THIS WAY. Advances used to be given to a specific khata, so an
 * employee had several separate pots and had to ask for money against the right
 * one. That is not how carrying cash works: notes in a pocket are fungible, and
 * only the *reason* they were spent needs separating. So the balance moved to
 * the wallet and this model kept the categorisation, which is the part that was
 * genuinely useful.
 *
 * `spent` is therefore a TOTAL, never a balance: the sum of the approved
 * expenses filed under this book. It only ever goes up (a reversal takes it
 * back down by cancelling the row it reverses). It is a cache, replayed from
 * the KhataEntry rows after any change — see services/khataLedger.js →
 * recomputeKhataSpent — so it cannot drift from the ledger behind it.
 *
 * SHARING A BOOK. A job is rarely run by one person, so the owner can invite
 * colleagues onto their book (`members`). This shares the HEADING, never the
 * money: an invited operator's spending still comes out of that operator's own
 * wallet, and the owner's balance does not move an inch. What the sharing buys
 * is a single honest total for the site — `spent` sums the book, not one
 * person's share of it. Ownership itself is not a member row: `employee` is the
 * owner, there is exactly one, and they cannot be removed.
 *
 * The cashbook (CashAccount/CashbookEntry) answers "how much cash is in the
 * tin?"; the wallet answers "how much is Rahul holding?"; this answers "and
 * what did he spend it on?".
 */

/**
 * The name every employee's first khata gets. Self-service has to work with no
 * setup at all: somebody filing their first expense before anyone has organised
 * their books lands here rather than being told to go and create something.
 */
const DEFAULT_KHATA_NAME = 'General';

// An invited colleague's standing on somebody else's book. Mirrors ChatGroup's
// member lifecycle (models/ChatGroup.js) so the two invite flows behave alike.
const MEMBER_STATUS = ['invited', 'accepted', 'declined'];

// What a collaborator may do. The BOOK OWNER is EmployeeKhata.employee and is
// never a member row — there is exactly one owner and they cannot be removed.
//   operator — post their own spending into this book and read everyone's.
//              Their entries come out of THEIR OWN wallet, never the owner's:
//              a book is a folder for spending, not a pot of money.
//   viewer   — read the book and download its reports. Posts nothing.
const MEMBER_ROLES = ['operator', 'viewer'];

/**
 * One colleague the owner has shared this book with.
 *
 * An invitation is a standing, not an act: the row is written the moment the
 * owner invites somebody and stays there whatever they answer, so "declined"
 * is a fact on the record rather than a missing row that looks like nobody was
 * ever asked. Re-inviting somebody who declined flips the status back rather
 * than pushing a second row — exactly what ChatGroup does.
 */
const memberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: MEMBER_ROLES, default: 'operator' },
  status: { type: String, enum: MEMBER_STATUS, default: 'invited' },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  invitedAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
}, { _id: false });

const employeeKhataSchema = new mongoose.Schema(
  {
    employee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    // What this book is for — "Site A — materials", "Vehicle & fuel", "Client
    // hospitality". Shown on every expense, so it has to read as a purpose
    // rather than a code.
    name: { type: String, required: true, trim: true, maxlength: 80, default: DEFAULT_KHATA_NAME },

    // The one that self-service falls back to when no book is named — the
    // employee's first. Exactly one per employee carries this; see
    // khataLedger.getOrCreateDefaultKhata.
    isDefault: { type: Boolean, default: false },

    // Total approved spend filed under this book. A running TOTAL, not a
    // balance: the money itself is in the wallet. Replayed from the ledger,
    // never incremented in place.
    spent: { type: Number, default: 0, index: true },

    // How many approved expenses make up `spent`. Denormalised so a list of
    // books does not need a count query per row.
    entryCount: { type: Number, default: 0 },

    // Denormalised for sorting books by recent activity.
    lastEntryAt: { type: Date, default: null, index: true },

    // Closed books stay readable (financial history is never destroyed) but no
    // longer accept new expenses and drop out of the pickers. Unlike the old
    // balance-carrying khata, a book with spend on it CAN be closed — the spend
    // is history, not an outstanding amount.
    isActive: { type: Boolean, default: true },

    note: { type: String, trim: true, maxlength: 300 },

    // Colleagues the owner has shared this book with. A site is rarely run by
    // one person: the supervisor opens "Site A — materials" and the two people
    // buying for that site need to file their purchases under the same
    // heading. Sharing gives them the heading, NOT the money — each of them
    // still spends out of their own wallet, and the book simply totals what
    // the site cost between them.
    members: { type: [memberSchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // ---- legacy, pre-wallet ----
    // These carried the per-khata pot before advances moved to the wallet.
    // Kept on the schema (rather than dropped) so scripts/migrateKhataWallet.js
    // can read what the old books held and roll it into the wallet; nothing in
    // the running code reads them any more.
    balance: { type: Number, default: 0 },
    openingBalance: { type: Number, default: 0 },
    creditLimit: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

// One book per name per person: "Site A" must mean one thing for one employee,
// so a second khata of the same name is rejected rather than silently created
// alongside the first.
employeeKhataSchema.index({ employee: 1, name: 1 }, { unique: true });

// The "where has this person's money gone" query: their books, biggest first.
employeeKhataSchema.index({ employee: 1, spent: -1 });

// "Which books have been shared with me?" — the other half of every books list
// now that a list is owned books plus accepted invitations. Keyed on status too
// because a declined invitation must not drag a book back into anybody's list.
employeeKhataSchema.index({ 'members.user': 1, 'members.status': 1 });

// Convenience: this user's member sub-doc (or null). Copied from ChatGroup's
// memberFor — it has to work whether members.user was populated into a doc or
// left as a raw ObjectId, because half the call sites populate and half do not.
employeeKhataSchema.methods.memberFor = function memberFor(userId) {
  return this.members.find((m) => String(m.user?._id || m.user) === String(userId)) || null;
};

// The one person who opened this book. Never a member row: ownership is not an
// invitation that could be declined, and there is exactly one of it.
employeeKhataSchema.methods.isOwner = function isOwner(userId) {
  return String(this.employee?._id || this.employee) === String(userId);
};

// May read the book and its reports. An invitation that has not been accepted
// yet buys nothing — you see the invitation, not the spending behind it.
employeeKhataSchema.methods.canView = function canView(userId) {
  if (this.isOwner(userId)) return true;
  const mem = this.memberFor(userId);
  return Boolean(mem && mem.status === 'accepted');
};

// May file entries into it. A closed book takes nothing from anybody, owner
// included — closing is the company saying the job's figures are final — and a
// 'viewer' never posts, which is the whole point of the two roles.
employeeKhataSchema.methods.canPost = function canPost(userId) {
  if (this.isActive === false) return false;
  if (this.isOwner(userId)) return true;
  const mem = this.memberFor(userId);
  return Boolean(mem && mem.status === 'accepted' && mem.role === 'operator');
};

module.exports = mongoose.model('EmployeeKhata', employeeKhataSchema);
module.exports.DEFAULT_KHATA_NAME = DEFAULT_KHATA_NAME;
module.exports.MEMBER_STATUS = MEMBER_STATUS;
module.exports.MEMBER_ROLES = MEMBER_ROLES;
