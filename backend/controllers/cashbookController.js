const asyncHandler = require('express-async-handler');
const mongoose = require('mongoose');
const CashAccount = require('../models/CashAccount');
const CashCategory = require('../models/CashCategory');
const CashbookEntry = require('../models/CashbookEntry');
const { ENTRY_STATUS, PAYMENT_MODES } = require('../models/CashbookEntry');
const User = require('../models/User');
const storage = require('../services/storage');
const { notify, notifyMany } = require('../services/notify');

const USER_FIELDS = 'firstName lastName email role';

// ---------- helpers ----------

const toNum = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
const parseDate = (v) => { const d = new Date(v); return Number.isNaN(d.getTime()) ? null : d; };

// Recompute an account's balance straight from its ledger so it can never drift.
async function recomputeBalance(accountId) {
  if (!accountId) return null;
  const acc = await CashAccount.findById(accountId);
  if (!acc) return null;
  const agg = await CashbookEntry.aggregate([
    { $match: { account: acc._id, status: 'Approved' } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  let inSum = 0, outSum = 0;
  agg.forEach((r) => { if (r._id === 'in') inSum = r.total; else if (r._id === 'out') outSum = r.total; });
  acc.currentBalance = Math.round(((acc.openingBalance || 0) + inSum - outSum) * 100) / 100;
  await acc.save();
  return acc.currentBalance;
}

// Persist a receipt file (image/PDF) for an entry and stamp its attachment.
async function attachReceipt(entry, file) {
  if (!file) return;
  const saved = storage.saveBuffer({
    buffer: file.buffer,
    ownerType: 'cashbook',
    ownerId: entry._id,
    originalName: file.originalname,
  });
  entry.attachment = {
    storagePath: saved.storagePath,
    name: file.originalname,
    sizeBytes: saved.sizeBytes,
    mime: file.mimetype,
  };
  await entry.save();
}

// Who should hear about a new voucher: active SuperAdmins + Account Managers.
async function financeManagerIds() {
  const mgrs = await User.find({ role: { $in: ['SuperAdmin', 'AccountsManager'] }, isActive: true }).select('_id');
  return mgrs.map((u) => u._id);
}

const DEFAULT_CATEGORIES = [
  { name: 'Office Supplies', kind: 'out' },
  { name: 'Travel & Conveyance', kind: 'out' },
  { name: 'Food & Refreshments', kind: 'out' },
  { name: 'Utilities', kind: 'out' },
  { name: 'Repairs & Maintenance', kind: 'out' },
  { name: 'Salary Advance', kind: 'out' },
  { name: 'Printing & Stationery', kind: 'out' },
  { name: 'Miscellaneous', kind: 'both' },
  { name: 'Cash Received', kind: 'in' },
  { name: 'Bank Withdrawal', kind: 'in' },
  { name: 'Refund', kind: 'in' },
];
async function ensureCategories() {
  const count = await CashCategory.countDocuments();
  if (count === 0) {
    try { await CashCategory.insertMany(DEFAULT_CATEGORIES); } catch { /* seeded concurrently */ }
  }
}

const publicEntry = (e) => ({
  _id: e._id,
  account: e.account?._id || e.account || null,
  accountName: e.account?.name || undefined,
  type: e.type,
  amount: e.amount,
  date: e.date,
  category: e.category,
  paymentMode: e.paymentMode,
  description: e.description,
  party: e.party,
  referenceNo: e.referenceNo,
  status: e.status,
  submittedByEmployee: e.submittedByEmployee,
  employee: e.employee && e.employee.firstName
    ? { _id: e.employee._id, name: `${e.employee.firstName} ${e.employee.lastName}`.trim(), email: e.employee.email }
    : (e.employee?._id || e.employee || null),
  reviewNote: e.reviewNote,
  reviewedAt: e.reviewedAt,
  balanceAfter: e.balanceAfter,
  hasAttachment: !!e.attachment?.storagePath,
  transferGroup: e.transferGroup || null,
  createdAt: e.createdAt,
});

// ============================ Employee self-service ============================

// GET /api/cashbook/me — my submitted vouchers
const listMyVouchers = asyncHandler(async (req, res) => {
  const entries = await CashbookEntry.find({ employee: req.user._id, submittedByEmployee: true })
    .sort({ createdAt: -1 })
    .lean();
  res.json({ count: entries.length, vouchers: entries.map(publicEntry) });
});

// POST /api/cashbook/me — submit a petty-cash voucher (multipart, optional receipt)
const submitVoucher = asyncHandler(async (req, res) => {
  const amount = toNum(req.body.amount);
  if (!(amount > 0)) { res.status(400); throw new Error('A positive amount is required'); }
  const date = parseDate(req.body.date) || new Date();
  const entry = await CashbookEntry.create({
    type: 'out',
    amount,
    date,
    category: req.body.category || 'Miscellaneous',
    paymentMode: PAYMENT_MODES.includes(req.body.paymentMode) ? req.body.paymentMode : 'Cash',
    description: req.body.description,
    party: req.body.party,
    referenceNo: req.body.referenceNo,
    status: 'Pending',
    submittedByEmployee: true,
    employee: req.user._id,
    createdBy: req.user._id,
  });
  await attachReceipt(entry, req.file);

  const who = `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() || 'An employee';
  notifyMany(await financeManagerIds(), {
    type: 'cashbook',
    audience: 'admin',
    title: 'New cash voucher to review',
    body: `${who} submitted a ₹${amount} petty-cash voucher.`,
    link: '/admin/cashbook',
  }).catch((err) => console.error('cashbook notify failed:', err.message));

  res.status(201).json({ voucher: publicEntry(entry) });
});

// ============================ Accounts ============================

const listAccounts = asyncHandler(async (req, res) => {
  const accounts = await CashAccount.find().sort({ isActive: -1, name: 1 }).lean();
  res.json({ count: accounts.length, accounts });
});

const createAccount = asyncHandler(async (req, res) => {
  const { name, type, note } = req.body;
  if (!name || !name.trim()) { res.status(400); throw new Error('Account name is required'); }
  const openingBalance = toNum(req.body.openingBalance);
  const acc = await CashAccount.create({
    name: name.trim(),
    type,
    note,
    openingBalance: Number.isNaN(openingBalance) ? 0 : openingBalance,
    currentBalance: Number.isNaN(openingBalance) ? 0 : openingBalance,
    createdBy: req.user._id,
  });
  res.status(201).json({ account: acc });
});

const updateAccount = asyncHandler(async (req, res) => {
  const acc = await CashAccount.findById(req.params.id);
  if (!acc) { res.status(404); throw new Error('Account not found'); }
  for (const k of ['name', 'type', 'note', 'isActive']) {
    if (req.body[k] !== undefined) acc[k] = req.body[k];
  }
  if (req.body.openingBalance !== undefined) {
    const ob = toNum(req.body.openingBalance);
    if (!Number.isNaN(ob)) acc.openingBalance = ob;
  }
  await acc.save();
  await recomputeBalance(acc._id); // opening-balance change flows into currentBalance
  const fresh = await CashAccount.findById(acc._id).lean();
  res.json({ account: fresh });
});

const deleteAccount = asyncHandler(async (req, res) => {
  const count = await CashbookEntry.countDocuments({ account: req.params.id });
  if (count > 0) {
    res.status(400);
    throw new Error('This account has entries. Deactivate it instead of deleting.');
  }
  await CashAccount.findByIdAndDelete(req.params.id);
  res.json({ id: req.params.id, deleted: true });
});

// ============================ Categories ============================

const listCategories = asyncHandler(async (req, res) => {
  await ensureCategories();
  const categories = await CashCategory.find().sort({ name: 1 }).lean();
  res.json({ count: categories.length, categories });
});

const createCategory = asyncHandler(async (req, res) => {
  const { name, kind } = req.body;
  if (!name || !name.trim()) { res.status(400); throw new Error('Category name is required'); }
  try {
    const cat = await CashCategory.create({ name: name.trim(), kind, createdBy: req.user._id });
    res.status(201).json({ category: cat });
  } catch (err) {
    if (err.code === 11000) { res.status(409); throw new Error('A category with that name already exists'); }
    throw err;
  }
});

const updateCategory = asyncHandler(async (req, res) => {
  const cat = await CashCategory.findById(req.params.id);
  if (!cat) { res.status(404); throw new Error('Category not found'); }
  for (const k of ['name', 'kind', 'isActive']) {
    if (req.body[k] !== undefined) cat[k] = req.body[k];
  }
  await cat.save();
  res.json({ category: cat });
});

// ============================ Entries (ledger) ============================

function entryFilterFromQuery(q) {
  const filter = {};
  if (q.account) filter.account = q.account;
  if (q.type) filter.type = q.type;
  if (q.status) filter.status = q.status;
  if (q.category) filter.category = q.category;
  if (q.employee) filter.employee = q.employee;
  const from = q.from && parseDate(q.from);
  const to = q.to && parseDate(q.to);
  if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) { to.setHours(23, 59, 59, 999); filter.date.$lte = to; }
  }
  if (q.q) {
    const rx = new RegExp(String(q.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ description: rx }, { party: rx }, { referenceNo: rx }, { category: rx }];
  }
  return filter;
}

// GET /api/cashbook/entries
const listEntries = asyncHandler(async (req, res) => {
  const filter = entryFilterFromQuery(req.query);
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const page = Math.max(Number(req.query.page) || 1, 1);
  const [entries, total] = await Promise.all([
    CashbookEntry.find(filter)
      .populate('account', 'name type')
      .populate('employee', USER_FIELDS)
      .sort({ date: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CashbookEntry.countDocuments(filter),
  ]);
  res.json({ count: entries.length, total, page, entries: entries.map(publicEntry) });
});

// POST /api/cashbook/entries — finance posts a direct in/out entry (multipart)
const createEntry = asyncHandler(async (req, res) => {
  const { type, account } = req.body;
  if (!['in', 'out'].includes(type)) { res.status(400); throw new Error("type must be 'in' or 'out'"); }
  if (!account) { res.status(400); throw new Error('account is required'); }
  const amount = toNum(req.body.amount);
  if (!(amount > 0)) { res.status(400); throw new Error('A positive amount is required'); }
  const acc = await CashAccount.findById(account);
  if (!acc) { res.status(404); throw new Error('Account not found'); }

  const entry = await CashbookEntry.create({
    account,
    type,
    amount,
    date: parseDate(req.body.date) || new Date(),
    category: req.body.category || 'Uncategorized',
    paymentMode: PAYMENT_MODES.includes(req.body.paymentMode) ? req.body.paymentMode : 'Cash',
    description: req.body.description,
    party: req.body.party,
    referenceNo: req.body.referenceNo,
    status: 'Approved',
    createdBy: req.user._id,
  });
  await attachReceipt(entry, req.file);
  const balance = await recomputeBalance(account);
  entry.balanceAfter = balance;
  await entry.save();
  res.status(201).json({ entry: publicEntry(entry) });
});

// PUT /api/cashbook/entries/:id — edit an entry, then resync balances
const updateEntry = asyncHandler(async (req, res) => {
  const entry = await CashbookEntry.findById(req.params.id);
  if (!entry) { res.status(404); throw new Error('Entry not found'); }
  if (entry.transferGroup) { res.status(400); throw new Error('Transfer legs cannot be edited; delete the transfer instead.'); }
  const prevAccount = entry.account ? String(entry.account) : null;

  for (const k of ['type', 'category', 'paymentMode', 'description', 'party', 'referenceNo']) {
    if (req.body[k] !== undefined) entry[k] = req.body[k];
  }
  if (req.body.amount !== undefined) {
    const a = toNum(req.body.amount);
    if (!(a > 0)) { res.status(400); throw new Error('A positive amount is required'); }
    entry.amount = a;
  }
  if (req.body.date !== undefined) { const d = parseDate(req.body.date); if (d) entry.date = d; }
  if (req.body.account !== undefined && req.body.account) entry.account = req.body.account;
  if (req.body.status !== undefined && ENTRY_STATUS.includes(req.body.status)) entry.status = req.body.status;
  await entry.save();

  // Resync both the old and new account (an entry may have moved between books).
  await recomputeBalance(prevAccount);
  if (entry.account && String(entry.account) !== prevAccount) await recomputeBalance(entry.account);
  res.json({ entry: publicEntry(entry) });
});

// DELETE /api/cashbook/entries/:id — remove an entry (and its transfer sibling)
const deleteEntry = asyncHandler(async (req, res) => {
  const entry = await CashbookEntry.findById(req.params.id);
  if (!entry) { res.status(404); throw new Error('Entry not found'); }
  const affected = new Set();
  const toDelete = [entry];
  if (entry.transferGroup) {
    const siblings = await CashbookEntry.find({ transferGroup: entry.transferGroup, _id: { $ne: entry._id } });
    toDelete.push(...siblings);
  }
  for (const e of toDelete) {
    if (e.account) affected.add(String(e.account));
    if (e.attachment?.storagePath) { try { storage.remove(e.attachment.storagePath); } catch { /* ignore */ } }
    await e.deleteOne();
  }
  for (const a of affected) await recomputeBalance(a);
  res.json({ id: req.params.id, deleted: true });
});

// PATCH /api/cashbook/entries/:id/review — approve/reject an employee voucher
const reviewVoucher = asyncHandler(async (req, res) => {
  const { action, account, reviewNote } = req.body;
  if (!['approve', 'reject'].includes(action)) { res.status(400); throw new Error("action must be 'approve' or 'reject'"); }
  const entry = await CashbookEntry.findById(req.params.id);
  if (!entry) { res.status(404); throw new Error('Entry not found'); }
  if (entry.status !== 'Pending') { res.status(400); throw new Error(`This voucher is already ${entry.status}.`); }

  entry.reviewedBy = req.user._id;
  entry.reviewedAt = new Date();
  entry.reviewNote = reviewNote;

  if (action === 'approve') {
    const accountId = account || entry.account;
    if (!accountId) { res.status(400); throw new Error('Pick an account to pay this voucher from'); }
    const acc = await CashAccount.findById(accountId);
    if (!acc) { res.status(404); throw new Error('Account not found'); }
    entry.account = accountId;
    entry.status = 'Approved';
    if (req.body.category) entry.category = req.body.category;
    await entry.save();
    const bal = await recomputeBalance(accountId);
    entry.balanceAfter = bal;
    await entry.save();
  } else {
    entry.status = 'Rejected';
    await entry.save();
  }

  if (entry.employee) {
    notify({
      recipient: entry.employee,
      type: 'cashbook',
      audience: 'employee',
      title: action === 'approve' ? 'Cash voucher approved' : 'Cash voucher rejected',
      body: action === 'approve'
        ? `Your ₹${entry.amount} voucher was approved.`
        : `Your ₹${entry.amount} voucher was rejected.${reviewNote ? ` Note: ${reviewNote}` : ''}`,
      link: '/employee/cashbook',
    }).catch((err) => console.error('cashbook decision notify failed:', err.message));
  }

  res.json({ entry: publicEntry(entry) });
});

// POST /api/cashbook/transfer — move money between two accounts (two linked legs)
const transfer = asyncHandler(async (req, res) => {
  const { fromAccount, toAccount } = req.body;
  const amount = toNum(req.body.amount);
  if (!fromAccount || !toAccount) { res.status(400); throw new Error('fromAccount and toAccount are required'); }
  if (String(fromAccount) === String(toAccount)) { res.status(400); throw new Error('Choose two different accounts'); }
  if (!(amount > 0)) { res.status(400); throw new Error('A positive amount is required'); }
  const [from, to] = await Promise.all([CashAccount.findById(fromAccount), CashAccount.findById(toAccount)]);
  if (!from || !to) { res.status(404); throw new Error('Account not found'); }

  const date = parseDate(req.body.date) || new Date();
  const group = new mongoose.Types.ObjectId();
  const desc = req.body.description || `Transfer ${from.name} → ${to.name}`;
  await CashbookEntry.create([
    { account: fromAccount, type: 'out', amount, date, category: 'Transfer', paymentMode: req.body.paymentMode || 'Bank', description: desc, party: to.name, status: 'Approved', transferGroup: group, createdBy: req.user._id },
    { account: toAccount, type: 'in', amount, date, category: 'Transfer', paymentMode: req.body.paymentMode || 'Bank', description: desc, party: from.name, status: 'Approved', transferGroup: group, createdBy: req.user._id },
  ]);
  await recomputeBalance(fromAccount);
  await recomputeBalance(toAccount);
  res.status(201).json({ ok: true, transferGroup: group });
});

// ============================ Reports ============================

// GET /api/cashbook/overview — headline numbers for the dashboard
const overview = asyncHandler(async (req, res) => {
  const accounts = await CashAccount.find({ isActive: true }).lean();
  const totalCash = accounts.reduce((s, a) => s + (a.currentBalance || 0), 0);
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [todayAgg, pending] = await Promise.all([
    CashbookEntry.aggregate([
      { $match: { status: 'Approved', date: { $gte: startOfDay } } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]),
    CashbookEntry.countDocuments({ status: 'Pending' }),
  ]);
  let todayIn = 0, todayOut = 0;
  todayAgg.forEach((r) => { if (r._id === 'in') todayIn = r.total; else if (r._id === 'out') todayOut = r.total; });
  res.json({ totalCash, accounts, todayIn, todayOut, pendingVouchers: pending });
});

// GET /api/cashbook/reports/daybook?account=&from=&to= — running-balance ledger
const daybook = asyncHandler(async (req, res) => {
  const { account } = req.query;
  if (!account) { res.status(400); throw new Error('account is required'); }
  const acc = await CashAccount.findById(account);
  if (!acc) { res.status(404); throw new Error('Account not found'); }
  const from = req.query.from && parseDate(req.query.from);
  const to = req.query.to && parseDate(req.query.to);
  if (to) to.setHours(23, 59, 59, 999);

  // Opening = account opening balance + all approved movement strictly before `from`.
  let opening = acc.openingBalance || 0;
  if (from) {
    const before = await CashbookEntry.aggregate([
      { $match: { account: acc._id, status: 'Approved', date: { $lt: from } } },
      { $group: { _id: '$type', total: { $sum: '$amount' } } },
    ]);
    before.forEach((r) => { opening += r._id === 'in' ? r.total : -r.total; });
  }

  const range = { account: acc._id, status: 'Approved' };
  if (from || to) { range.date = {}; if (from) range.date.$gte = from; if (to) range.date.$lte = to; }
  const rows = await CashbookEntry.find(range).sort({ date: 1, createdAt: 1 }).lean();

  let running = opening, totalIn = 0, totalOut = 0;
  const ledger = rows.map((e) => {
    if (e.type === 'in') { running += e.amount; totalIn += e.amount; }
    else { running -= e.amount; totalOut += e.amount; }
    return { ...publicEntry(e), balance: Math.round(running * 100) / 100 };
  });
  res.json({
    account: { _id: acc._id, name: acc.name, type: acc.type },
    opening: Math.round(opening * 100) / 100,
    totalIn, totalOut,
    closing: Math.round(running * 100) / 100,
    rows: ledger,
  });
});

// GET /api/cashbook/reports/summary?from=&to=&account= — category/mode breakdown
const summary = asyncHandler(async (req, res) => {
  const match = { status: 'Approved' };
  if (req.query.account) match.account = new mongoose.Types.ObjectId(req.query.account);
  const from = req.query.from && parseDate(req.query.from);
  const to = req.query.to && parseDate(req.query.to);
  if (from || to) { match.date = {}; if (from) match.date.$gte = from; if (to) { to.setHours(23, 59, 59, 999); match.date.$lte = to; } }

  const [byCategory, byMode, totals] = await Promise.all([
    CashbookEntry.aggregate([{ $match: match }, { $group: { _id: { category: '$category', type: '$type' }, total: { $sum: '$amount' } } }]),
    CashbookEntry.aggregate([{ $match: match }, { $group: { _id: { mode: '$paymentMode', type: '$type' }, total: { $sum: '$amount' } } }]),
    CashbookEntry.aggregate([{ $match: match }, { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } }]),
  ]);
  let totalIn = 0, totalOut = 0;
  totals.forEach((r) => { if (r._id === 'in') totalIn = r.total; else if (r._id === 'out') totalOut = r.total; });
  res.json({
    totalIn, totalOut, net: Math.round((totalIn - totalOut) * 100) / 100,
    byCategory: byCategory.map((r) => ({ category: r._id.category, type: r._id.type, total: r.total })),
    byMode: byMode.map((r) => ({ mode: r._id.mode, type: r._id.type, total: r.total })),
  });
});

// GET /api/cashbook/reports/export — CSV of the filtered ledger
const exportCsv = asyncHandler(async (req, res) => {
  const filter = entryFilterFromQuery(req.query);
  const entries = await CashbookEntry.find(filter)
    .populate('account', 'name')
    .populate('employee', USER_FIELDS)
    .sort({ date: 1, createdAt: 1 })
    .lean();
  const esc = (v) => {
    const s = v === undefined || v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['Date', 'Account', 'Type', 'Category', 'Payment Mode', 'Party', 'Reference', 'Description', 'In', 'Out', 'Status', 'Submitted By'];
  const lines = [header.join(',')];
  for (const e of entries) {
    const who = e.employee?.firstName ? `${e.employee.firstName} ${e.employee.lastName}`.trim() : '';
    lines.push([
      new Date(e.date).toISOString().slice(0, 10),
      e.account?.name || '',
      e.type,
      e.category || '',
      e.paymentMode || '',
      e.party || '',
      e.referenceNo || '',
      e.description || '',
      e.type === 'in' ? e.amount : '',
      e.type === 'out' ? e.amount : '',
      e.status,
      e.submittedByEmployee ? who : '',
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="cashbook.csv"');
  res.send(lines.join('\n'));
});

// GET /api/cashbook/entries/:id/receipt — stream the receipt (owner or manager)
const getReceipt = asyncHandler(async (req, res) => {
  const entry = await CashbookEntry.findById(req.params.id).select('attachment employee');
  if (!entry || !entry.attachment?.storagePath) { res.status(404); throw new Error('Receipt not found'); }
  const isOwner = entry.employee && String(entry.employee) === String(req.user._id);
  const isManager = req.user.role === 'SuperAdmin' || req.user.role === 'AccountsManager'
    || (req.user.role === 'HRManager' && (!req.user.permissions || req.user.permissions.includes('cashbook.manage')))
    || ['CEO', 'MD'].includes(req.user.role);
  if (!isOwner && !isManager) { res.status(403); throw new Error('Not allowed'); }
  if (entry.attachment.mime) res.setHeader('Content-Type', entry.attachment.mime);
  if (!storage.streamTo(entry.attachment.storagePath, res)) { res.status(404); throw new Error('Receipt file missing'); }
});

module.exports = {
  // employee
  listMyVouchers, submitVoucher,
  // accounts
  listAccounts, createAccount, updateAccount, deleteAccount,
  // categories
  listCategories, createCategory, updateCategory,
  // entries
  listEntries, createEntry, updateEntry, deleteEntry, reviewVoucher, transfer,
  // reports
  overview, daybook, summary, exportCsv, getReceipt,
};
