/**
 * Audit Log in words (2026-10-02, user: "what log is this — mention proper", and
 * "add a Details button").
 *
 * A raw AuditLog row is five codes — entity, field, from, to, by — and on its
 * own it does not say what happened. "employee · status: created as Approved"
 * left a SuperAdmin guessing. This turns a row into:
 *
 *   · a MODULE NAME people use ("Leave", "Employee cashbook"), not a model name;
 *   · one SENTENCE ("Sequence Admin approved Test User's leave request");
 *   · on demand, the RECORD itself — found by its id — summarised field by
 *     field, with the record's whole status history.
 *
 * THE `employee` ROWS. The plugin names a row after its MODEL, and the
 * Employee Cashbook's ledger model is a discriminator of CashbookEntry whose
 * model name is literally `employee` (models/CashbookEntry.js,
 * `CashbookEntry.discriminator('employee', …)`). So "Module: employee" was an
 * Employee Cashbook entry all along — it is mapped by that name below.
 *
 * FINDING THE RECORD BY ID, NOT BY THE NAME IN THE ROW. A row may still carry a
 * name this portal does not know (the separate apps that share this database
 * write to the same log). An ObjectId is unique across collections, so the
 * record is looked for under its stated type first, then in every model this
 * server knows, then — for the Details panel only — in every collection in the
 * database. Whatever it turns out to be, the row is described as THAT.
 *
 * Sensitive fields (passwords, tokens, identity numbers, bank details, salary
 * figures, photos and attachments) are never put in a summary.
 */
const mongoose = require('mongoose');

/**
 * What each logged type is called, the noun for one of them, and where it
 * lives. `model` when the row's name is not the model's; `made`/`went` word a
 * creation ("recorded …, which posted as Approved"); `about` explains a module
 * whose statuses do not speak for themselves (shown in Details).
 */
const MODULES = {
  employee: {
    label: 'Employee cashbook', noun: 'cashbook entry', person: true, link: '/admin/khata', made: 'recorded', went: 'posted as',
    about: 'A line in one person’s own cash account with the company (Employee Cashbook) — the advances they hold and what they spend from them. An expense the person files counts the moment it is filed, so it starts as Approved; the company’s check comes later, as the separate “confirmed” step.',
  },
  Attendance: { label: 'Attendance', noun: 'attendance record', person: true, link: '/admin/attendance' },
  'Attendance.doublePay': {
    label: 'Rest-day duty pay', noun: 'rest-day duty claim', person: true, link: '/admin/attendance', model: 'Attendance',
    about: 'A decision on a day worked on a rest day (a Sunday or a company comp-off day) — an approved day is paid at double rate.',
  },
  Candidate: { label: 'Recruitment', noun: 'candidate', link: '/admin/recruitment' },
  'Candidate.round': {
    label: 'Interview round', noun: 'interview', link: '/admin/recruitment', model: 'Candidate',
    about: 'One interview round of a candidate — scheduled, rescheduled, cleared or rejected.',
  },
  CashbookEntry: {
    label: 'Company cashbook', noun: 'cashbook voucher', person: true, link: '/admin/cashbook', made: 'recorded', went: 'posted as',
    about: 'A line of the company cashbook — money into or out of a company account. An entry finance records posts at once (Approved); a voucher an employee submits waits as Pending until the cash operator decides.',
  },
  ChangeRequest: { label: 'Profile change request', noun: 'profile change request', person: true, link: '/admin/change-requests' },
  Company: { label: 'Company', noun: 'company', link: '/admin/companies' },
  Complaint: { label: 'Complaint', noun: 'complaint', link: '/admin/complaints' },
  CompOff: { label: 'Comp-off', noun: 'comp-off', person: true },
  Course: { label: 'Course', noun: 'course', link: '/admin/courses' },
  CourseComment: { label: 'Course comment', noun: 'course comment', link: '/admin/courses' },
  CourseReport: { label: 'Course issue report', noun: 'course issue report', link: '/admin/courses' },
  DocumentChangeRequest: { label: 'Document replacement', noun: 'document replacement request', link: '/admin/documents' },
  EmployeeProfile: { label: 'Employee record', noun: 'employee record', person: true, link: '/admin/employees' },
  Enrollment: { label: 'Course enrolment', noun: 'course enrolment', person: true, link: '/admin/courses' },
  ExitRequest: { label: 'Resignation', noun: 'resignation', person: true, link: '/admin/exits' },
  Expense: { label: 'Expense claim', noun: 'expense claim', person: true },
  Goal: { label: 'Goal', noun: 'goal', link: '/admin/performance' },
  InvestmentDeclaration: { label: 'Tax declaration', noun: 'tax declaration', person: true, link: '/admin/declarations' },
  Job: { label: 'Job opening', noun: 'job opening', link: '/admin/recruitment' },
  JobRequest: { label: 'Job-opening request', noun: 'job-opening request', link: '/admin/consultancy-jobs' },
  KhataEntry: {
    label: 'Employee cashbook', noun: 'cashbook entry', person: true, link: '/admin/khata', made: 'recorded', went: 'posted as',
    about: 'An entry from the older Employee Cashbook ledger, kept from before it was merged into the cashbook.',
  },
  LeaveRequest: { label: 'Leave', noun: 'leave request', person: true, link: '/admin/leave' },
  Loan: { label: 'Loan / advance', noun: 'loan request', person: true, link: '/admin/loans' },
  OnboardingTask: { label: 'Onboarding task', noun: 'onboarding task', link: '/admin/onboarding' },
  Payroll: { label: 'Payslip', noun: 'payslip', person: true, link: '/admin/payroll' },
  Project: { label: 'Project', noun: 'project', link: '/admin/projects' },
  Regularization: { label: 'Regularization', noun: 'attendance regularization', person: true, link: '/admin/regularizations' },
  Review: { label: 'Performance review', noun: 'performance review', person: true, link: '/admin/review-cycles' },
  SalaryChangeRequest: { label: 'Salary change', noun: 'salary change request', person: true, link: '/admin/approvals' },
  Task: { label: 'Task', noun: 'task', link: '/admin/tasks' },
  TaskTemplate: { label: 'Task template', noun: 'task template', link: '/admin/tasks' },
  Training: { label: 'Training', noun: 'training', link: '/admin/training' },
  TravelRequest: { label: 'Travel request', noun: 'travel request', person: true },
  User: { label: 'User account', noun: 'user account', person: true, link: '/admin/users' },
  WorkLocation: { label: 'Work location', noun: 'work location', link: '/admin/work-locations' },
};

/** The verb a status change reads as. `{who}` / `{what}` are filled in. */
const STATUS_VERBS = {
  approved: '{who} approved {what}',
  rejected: '{who} rejected {what}',
  declined: '{who} declined {what}',
  cancelled: '{who} cancelled {what}',
  canceled: '{who} cancelled {what}',
  withdrawn: '{who} withdrew {what}',
  paid: '{who} marked {what} as paid',
  completed: '{who} completed {what}',
  closed: '{who} closed {what}',
  reopened: '{who} reopened {what}',
  resolved: '{who} resolved {what}',
  reversed: '{who} reversed {what}',
  onhold: '{who} put {what} on hold',
  hired: '{who} hired {what}',
  confirmed: '{who} confirmed {what}',
  submitted: '{who} submitted {what}',
  cleared: '{who} cleared {what}',
  scheduled: '{who} scheduled {what}',
  active: '{who} activated {what}',
  inactive: '{who} deactivated {what}',
};

/** Words for a field that changed, when it is not plain "status". */
const FIELD_WORDS = {
  role: 'role', checkIn: 'check-in time', checkOut: 'check-out time', mustChangePassword: 'password-change request',
};
/** Fields that hold a status — a change to one is a decision or a step, not an edit. */
const STATUS_FIELDS = new Set(['', 'status', 'stage', 'approvalStatus', 'doublePay']);
/** Types whose fields belong to the person ("Asha Verma's mobile number"), not to a document. */
const PERSON_FIELDS = new Set(['EmployeeProfile', 'User', 'Attendance']);

const lc = (s) => String(s || '').trim().toLowerCase();
/** Code words that do not split cleanly. */
const WORDS = {
  HRManager: 'HR Manager', SuperAdmin: 'Super Admin', LDManager: 'HR L&D', AccountsManager: 'Accounts Manager',
  HRConsultancy: 'HR Consultancy', OnHold: 'On hold', NoShow: 'No show', NewJoinee: 'New joinee', InProgress: 'In progress',
};
/** "OnHold" → "On hold", "NewJoinee" → "New joinee"; anything without a lower→upper join is left alone. */
const human = (s) => {
  const t = String(s ?? '').trim();
  if (!t) return '';
  if (WORDS[t]) return WORDS[t];
  if (/\s/.test(t) || !/[a-z][A-Z]/.test(t)) return t;
  const spaced = t.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0) + spaced.slice(1).toLowerCase();
};
const capital = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** "Mobile number" → "mobile number", but "PAN" stays "PAN". */
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const article = (noun) => (/^[aeiou]/i.test(noun) ? 'an' : 'a');
/** A label's first part reads as a person's name (not a code, an amount or a date). */
const looksLikeName = (s) => !!s && s.length <= 60 && !/[\d₹#@/]/.test(s);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-09-28" → "28 Sep 2026" (a calendar day — no time zone to get wrong); anything else as written. */
const niceDay = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}` : s;
};

/**
 * What a logged type is called. An unknown name is shown as it was written,
 * marked as not being one of the portal's own.
 */
function moduleInfo(entity) {
  if (MODULES[entity]) return { key: entity, ...MODULES[entity], known: true };
  const base = String(entity || '').split('.')[0];
  if (MODULES[base]) return { key: base, ...MODULES[base], known: true };
  // A model of this server that is simply not in the table is still ours.
  let ours = false;
  try { ours = !!mongoose.model(entity); } catch { /* not a model here */ }
  return { key: entity, label: capital(human(entity)) || 'Record', noun: 'record', person: false, known: ours };
}

/**
 * One sentence for an entry. `resolvedType` (when the record was found under a
 * different name than the row carries) wins over the row's own name.
 * @param {Object} e - AuditLog row (lean)
 * @param {string} [resolvedType]
 * @returns {string}
 */
function describe(e, resolvedType) {
  const mod = moduleInfo(resolvedType || e.entity);
  const who = e.byName || 'The system';
  const noun = mod.noun;
  const from = String(e.fromStatus ?? '').trim();
  const to = String(e.toStatus ?? '').trim();
  const field = String(e.field || '').trim();

  // Labels come as "Asha Verma", "Asha Verma · 2026-09-28" or "Bala — 09/2026";
  // the first part is the person when it reads like a name, the rest says which.
  const label = String(e.entityLabel || '').trim();
  const parts = label.split(/\s+[·—]\s+/);
  const named = mod.person && looksLikeName(parts[0]);
  const subject = named ? parts[0] : label;
  const which = named ? parts.slice(1).map(niceDay).join(' · ') : '';
  const self = !!(e.byName && subject && lc(e.byName) === lc(subject));
  const forWhich = which ? ` for ${which}` : '';
  const what = self ? `their own ${noun}${forWhich}`
    : named ? `${subject}'s ${noun}${forWhich}`
      : subject ? `the ${noun} “${subject}”`
        : `${article(noun)} ${noun}`;
  const whose = self ? 'their own' : named ? `${subject}'s` : '';
  const step = from && to ? ` (${human(from)} → ${human(to)})` : '';

  // Interview rounds: "Round 2 (Technical)", or a whole reschedule sentence.
  if (mod.key === 'Candidate.round') {
    const person = subject || 'a candidate';
    const moved = /^(Round \d+(?: \([^)]*\))?) rescheduled(.*)$/.exec(field);
    if (moved) return `${who} rescheduled ${person}'s ${moved[1]} interview${moved[2]}.`;
    const round = field || 'interview';
    return `${who} marked ${person}'s ${round} interview as ${human(to) || 'updated'}${step}.`;
  }
  if (lc(to).startsWith('deleted')) {
    return `${who} deleted ${what}${from ? ` (it was ${human(from)})` : ''}.`;
  }
  if (field === 'password') return `${who} reset ${whose || 'a'} password.`;
  if (field === 'mustChangePassword') {
    const them = self ? 'themselves' : subject || 'someone';
    return lc(to) === 'required'
      ? `${who} asked ${them} to choose a new password at the next sign-in.`
      : `${who} stopped asking ${them} to choose a new password.`;
  }
  if (field === 'isActive' || field === 'active') {
    return `${who} ${lc(to) === 'true' ? 'switched on' : 'switched off'} ${what}.`;
  }
  if (field === 'payslipRequest') {
    const [verdict, ...why] = to.split(' · ');
    const req = `${whose || 'a'} payslip request${forWhich}`;
    const reason = why.length ? ` — reason: ${why.join(' · ')}` : '';
    return lc(verdict) === 'declined' ? `${who} declined ${req}${reason}.`
      : `${who} moved ${req} from ${human(from)} to ${human(verdict)}${reason}.`;
  }
  if (field === 'payslipLock') return `${who} overrode the lock on ${what}${step}.`;

  if (STATUS_FIELDS.has(field)) {
    // Born carrying the status — a creation, not a decision. Saying "approved"
    // here would put an approval next to somebody who never made one.
    if (!from) {
      const made = mod.made || 'created';
      const born = self ? `${who} ${made} their own ${noun}${forWhich}`
        : named ? `${who} ${made} ${article(noun)} ${noun} for ${subject}${which ? ` (${which})` : ''}`
          : subject ? `${who} ${made} the ${noun} “${subject}”` : `${who} ${made} ${article(noun)} ${noun}`;
      return `${born}, which ${mod.went || 'started as'} ${human(to) || 'new'}.`;
    }
    const verb = STATUS_VERBS[lc(to).replace(/[\s_-]/g, '')];
    if (verb) return `${verb.replace('{who}', who).replace('{what}', what)}${step}.`;
    return `${who} moved ${what} from ${human(from)} to ${human(to)}.`;
  }

  // Any other field: an edit, said as "X's <field>" for a person's own details.
  const fieldWords = FIELD_WORDS[field] || lowerFirst(/\s/.test(field) ? field : human(field));
  const on = mod.key === 'Attendance' && which ? ` on ${which}` : '';
  const target = PERSON_FIELDS.has(mod.key) && whose ? `${whose} ${fieldWords}${on}`
    : `the ${fieldWords} of ${what}`;
  if (!from || from === '—') return `${who} set ${target} to ${human(to)}.`;
  if (!to || to === '—') return `${who} cleared ${target} (it was ${human(from)}).`;
  return `${who} changed ${target} from ${human(from)} to ${human(to)}.`;
}

// ─── the badge and the field, for the screens ─────────────────────────────

const GOOD = new Set(['approved', 'paid', 'completed', 'cleared', 'hired', 'resolved', 'active', 'confirmed', 'selected', 'done', 'accepted', 'joined', 'verified']);
const BAD = new Set(['rejected', 'declined', 'cancelled', 'canceled', 'deleted', 'withdrawn', 'inactive', 'reversed', 'failed', 'noshow', 'terminated', 'expired', 'dropped', 'lost']);
const WAIT = new Set(['pending', 'onhold', 'requested', 'review', 'submitted', 'draft', 'planned', 'scheduled', 'inprogress', 'applied', 'screening', 'interview', 'new', 'open', 'awaiting', 'sent']);
/** good / bad / wait / info — the colour a status word is drawn in. */
function toneOf(word) {
  const k = lc(String(word || '').split(' · ')[0]).replace(/[\s_-]/g, '');
  if (!k) return 'neutral';
  if (k.startsWith('deleted') || k.startsWith('declined')) return 'bad';
  if (GOOD.has(k)) return 'good';
  if (BAD.has(k)) return 'bad';
  if (WAIT.has(k)) return 'wait';
  return 'info';
}

/**
 * The short coloured badge an entry is listed with: where it ended up, or what
 * kind of change it was when that is not a status ("Edited", "Switched off").
 * @returns {{text: string, tone: string, created?: boolean}}
 */
function badgeFor(e, resolvedType) {
  const mod = moduleInfo(resolvedType || e.entity);
  const field = String(e.field || '').trim();
  const from = String(e.fromStatus ?? '').trim();
  const to = String(e.toStatus ?? '').trim();
  if (mod.key === 'Candidate.round') {
    if (/ rescheduled/.test(field)) return { text: 'Rescheduled', tone: 'info' };
    return { text: human(to) || 'Updated', tone: toneOf(to) };
  }
  if (lc(to).startsWith('deleted')) return { text: 'Deleted', tone: 'bad' };
  if (field === 'password') return { text: 'Password reset', tone: 'wait' };
  if (field === 'mustChangePassword') {
    return lc(to) === 'required' ? { text: 'New password asked', tone: 'wait' } : { text: 'Ask withdrawn', tone: 'neutral' };
  }
  if (field === 'isActive' || field === 'active') {
    return lc(to) === 'true' ? { text: 'Switched on', tone: 'good' } : { text: 'Switched off', tone: 'bad' };
  }
  if (field === 'payslipRequest') {
    const verdict = to.split(' · ')[0];
    return { text: human(verdict) || 'Updated', tone: toneOf(verdict) };
  }
  if (field === 'payslipLock') return { text: 'Lock overridden', tone: 'wait' };
  if (STATUS_FIELDS.has(field)) {
    return { text: human(to) || 'Updated', tone: toneOf(to), ...(from ? {} : { created: true }) };
  }
  return { text: 'Edited', tone: 'neutral' };
}

/** A from/to value as words: "OnHold" → "On hold"; a switch's "true" → "On". */
function valueText(v, field) {
  const t = String(v ?? '').trim();
  if (field === 'isActive' || field === 'active') return lc(t) === 'true' ? 'On' : lc(t) === 'false' ? 'Off' : t;
  return human(t);
}

/** What the changed field is called, in words ("Status", "Check-in time", "Round 2 (Technical)"). */
function fieldLabel(e) {
  const field = String(e.field || '').trim();
  if (!field || field === 'status') return 'Status';
  if (moduleInfo(e.entity).key === 'Candidate.round') {
    const round = /^(Round \d+(?: \([^)]*\))?)/.exec(field);
    return round ? `${round[1]} interview` : field;
  }
  const words = {
    stage: 'Stage', approvalStatus: 'Approval', doublePay: 'Rest-day duty pay', password: 'Password',
    mustChangePassword: 'New password at next sign-in', isActive: 'Switched on / off', active: 'Switched on / off',
    payslipRequest: 'Payslip request', payslipLock: 'Payslip lock',
  };
  if (words[field]) return words[field];
  if (FIELD_WORDS[field]) return capital(FIELD_WORDS[field]);
  return /\s/.test(field) ? field : capital(human(field));
}

// ─── finding the record ───────────────────────────────────────────────────

/** Models never worth searching for a record an audit row points at. */
const SKIP_MODELS = new Set(['AuditLog', 'Notification', 'Message', 'EmailOutbox', 'DeviceToken', 'DigestLog', 'Counter', 'Setting']);
const SKIP_COLLECTIONS = /^(system\.|auditlogs$|notifications$|messages$|emailoutboxes$|devicetokens$|digestlogs$|uploads\.)/;

const modelFor = (name) => {
  try { return mongoose.model(name); } catch { return null; }
};

/** Run `fn` over `list` a few at a time, so a search across every model is not 80 queries at once. */
async function inBatches(list, size, fn) {
  for (let i = 0; i < list.length; i += size) await Promise.all(list.slice(i, i + size).map(fn));
}

// An id never changes type, so what was found once is remembered ('' = in no
// model). Bounded: cleared whole when it grows past TYPE_CACHE_MAX.
const typeCache = new Map();
const TYPE_CACHE_MAX = 5000;
const remember = (id, type) => {
  if (typeCache.size >= TYPE_CACHE_MAX) typeCache.clear();
  typeCache.set(id, type);
};

/** Models worth searching for a record, the row's own one first when it has one. */
const searchableModels = (except) => mongoose.modelNames().filter((n) => !SKIP_MODELS.has(n) && n !== except);

/**
 * The model a found document really belongs to. A base model's query returns
 * its discriminators' rows too (CashbookEntry finds Employee Cashbook rows), so
 * the discriminator key decides: `ledger: 'employee'` is an `employee` row.
 */
function typeOfDoc(m, doc) {
  const key = m.schema.options.discriminatorKey;
  const sub = m.discriminators && doc && doc[key];
  return sub && m.discriminators[sub] ? sub : m.modelName;
}

/**
 * Which model really holds each row's record, where that is not simply the
 * row's own name: a base model's row on a discriminator's record, and a row
 * whose name this portal does not know (looked for in every model — batched,
 * one indexed `$in` per model, remembered).
 * @param {Object[]} rows - lean AuditLog rows
 * @returns {Promise<Map<string, string>>} entityId → model name (found ones only)
 */
async function resolveUnknownTypes(rows) {
  const found = new Map();
  // A row logged under a BASE model may be a discriminator's record (a
  // CashbookEntry row on an Employee Cashbook line): one query per such model
  // reads the discriminator key of its rows on the page.
  const bases = new Map();
  rows.forEach((r) => {
    const mod = moduleInfo(r.entity);
    const m = r.entityId && modelFor(mod.model || mod.key);
    if (m && m.discriminators && Object.keys(m.discriminators).length) {
      if (!bases.has(m.modelName)) bases.set(m.modelName, new Set());
      bases.get(m.modelName).add(String(r.entityId));
    }
  });
  await Promise.all([...bases.entries()].map(async ([n, ids]) => {
    try {
      const m = mongoose.model(n);
      const docs = await m.find({ _id: { $in: [...ids] } }).select(`_id ${m.schema.options.discriminatorKey}`).lean();
      docs.forEach((d) => { const t = typeOfDoc(m, d); if (t !== n) found.set(String(d._id), t); });
    } catch { /* described by the row's own name instead */ }
  }));

  const unknown = rows.filter((r) => r.entityId && !moduleInfo(r.entity).known && !modelFor(r.entity));
  const ask = [];
  new Set(unknown.map((r) => String(r.entityId))).forEach((id) => {
    if (!typeCache.has(id)) ask.push(id);
    else if (typeCache.get(id)) found.set(id, typeCache.get(id));
  });
  if (!ask.length) return found;
  await inBatches(searchableModels(), 12, async (n) => {
    try {
      const m = mongoose.model(n);
      const docs = await m.find({ _id: { $in: ask } }).select(`_id ${m.schema.options.discriminatorKey || '__t'}`).lean();
      docs.forEach((d) => found.set(String(d._id), typeOfDoc(m, d)));
    } catch { /* a model that cannot be queried this way is simply skipped */ }
  });
  ask.forEach((id) => remember(id, found.get(id) || ''));
  return found;
}

/**
 * The record an entry points at: under its own type, else any known model,
 * else any collection in the database.
 * @param {Object} entry - lean AuditLog row
 * @returns {Promise<{type: string|null, collection: string|null, doc: Object|null, viaModel: boolean}>}
 */
async function findRecord(entry) {
  const none = { type: null, collection: null, doc: null, viaModel: false };
  const id = entry.entityId;
  if (!id || !mongoose.isValidObjectId(id)) return none;
  const mod = moduleInfo(entry.entity);
  const own = modelFor(mod.model || mod.key) || modelFor(entry.entity);
  const tryModel = async (m) => {
    const doc = await m.findById(id).lean().catch(() => null);
    return doc ? { type: typeOfDoc(m, doc), collection: m.collection.name, doc, viaModel: true } : null;
  };
  if (own) {
    const hit = await tryModel(own);
    if (hit) return hit;
  }
  const known = typeCache.get(String(id));
  if (known && modelFor(known)) {
    const hit = await tryModel(modelFor(known));
    if (hit) return hit;
  }
  let hit = null;
  await inBatches(searchableModels(own && own.modelName), 12, async (n) => {
    if (hit) return;
    const h = await tryModel(mongoose.model(n));
    if (h && !hit) hit = h;
  });
  if (hit) return hit;
  // Not in any model this server knows — a sibling app's collection, perhaps.
  try {
    const db = mongoose.connection.db;
    const ours = new Set(mongoose.modelNames().map((n) => mongoose.model(n).collection.name));
    const cols = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name)
      .filter((c) => !SKIP_COLLECTIONS.test(c) && !ours.has(c));
    const oid = new mongoose.Types.ObjectId(String(id));
    await inBatches(cols, 12, async (c) => {
      if (hit) return;
      const doc = await db.collection(c).findOne({ _id: oid }).catch(() => null);
      if (doc && !hit) hit = { type: null, collection: c, doc, viaModel: false };
    });
  } catch { /* fall through to "not found" */ }
  return hit || none;
}

// ─── summarising it ───────────────────────────────────────────────────────

/** Never shown, whatever the record type. */
const SENSITIVE = /pass(word)?|token|secret|hash|otp|paths?$|resume(data)?$|aadhaar|^pan$|^uan$|pfnumber|esic|bank|ifsc|accountnumber|salary|ctc|gross|netpay|^basic|earnings|deductions|contributions|components|photo|selfie|banner|signature|^attachments?$|^bills?$|receipt|(filed|checkin|checkout|punch)location|geo|^data$|cloud$|feedback$|^edits$|lastseen|lastlogin|tokenversion|permissions|incentiveroles/i;
/** Bookkeeping that says nothing to a person reading the record. */
const NOISE = /^(idempotencyKey|migratedFrom|transferGroup|ledger|balanceAfter|walletBalanceAfter|reminderSentAt|feedbackAskedAt|execApprovalRequired|affectsCompanyCash)$/;
/** Money is fine on a cashbook entry, not on a payslip or a salary change. */
const MONEY = /amount|value|principal|emi|balance|points|monthly/i;
const NO_MONEY_TYPES = new Set(['Payroll', 'SalaryChangeRequest', 'EmployeeProfile', 'User']);
const SKIP_KEYS = new Set(['_id', '__v', 'id']);

/** The fields worth leading with, per type. */
const PRIORITY = {
  employee: ['code', 'employee', 'movement', 'direction', 'amount', 'date', 'purpose', 'category', 'expenseBook', 'paymentMode', 'status', 'raisedByEmployee', 'confirmedByCompany', 'confirmedAt'],
  LeaveRequest:['employee', 'leaveType', 'startDate', 'endDate', 'totalDays', 'isHalfDay', 'reason', 'status', 'appliedAt', 'decisionAt', 'decisionNote'],
  KhataEntry: ['code', 'employee', 'type', 'direction', 'amount', 'date', 'purpose', 'category', 'paymentMode', 'status', 'raisedByEmployee', 'reviewNote'],
  CashbookEntry: ['code', 'type', 'amount', 'date', 'category', 'description', 'party', 'paymentMode', 'status', 'employee'],
  Regularization: ['employee', 'date', 'type', 'requestedCheckIn', 'requestedCheckOut', 'reason', 'status', 'reviewNote'],
  Expense: ['code', 'employee', 'category', 'amount', 'expenseDate', 'merchant', 'description', 'status'],
  Loan: ['employee', 'type', 'principal', 'emi', 'tenureMonths', 'reason', 'status'],
  ExitRequest: ['employee', 'type', 'resignationDate', 'lastWorkingDay', 'noticePeriodDays', 'reason', 'status'],
  Payroll: ['employee', 'payPeriod', 'paidDays', 'lopDays', 'status', 'paymentDate'],
  Task: ['code', 'title', 'status', 'priority', 'createdByName', 'startDate', 'dueDate', 'progress', 'category'],
  TaskTemplate: ['name', 'title', 'category', 'priority', 'isActive', 'createdByName'],
  Candidate: ['name', 'email', 'phone', 'stage', 'source', 'currentCompany', 'experienceYears'],
  User: ['firstName', 'lastName', 'email', 'phone', 'role', 'isActive'],
  EmployeeProfile: ['user', 'employeeCode', 'designation', 'department', 'dateOfJoining', 'dateOfExit', 'employmentType'],
  Attendance: ['employee', 'date', 'status', 'checkIn', 'checkOut', 'hoursWorked', 'remarks'],
  ChangeRequest: ['targetUser', 'fieldLabel', 'currentValue', 'requestedValue', 'reason', 'status', 'decisionNote'],
  Complaint: ['subject', 'description', 'status', 'resolutionNote'],
  Training: ['title', 'category', 'trainer', 'startDate', 'endDate', 'status'],
  Job: ['title', 'department', 'location', 'employmentType', 'openings', 'status'],
};

const KEY_WORDS = {
  startDate: 'Start', endDate: 'End', totalDays: 'Days', isHalfDay: 'Half day', appliedAt: 'Applied', decisionAt: 'Decided',
  decisionNote: 'Decision note', reviewNote: 'Review note', payPeriod: 'Pay period', lopDays: 'Unpaid days',
  paidDays: 'Paid days', createdByName: 'Set by', raisedByEmployee: 'Raised by the employee', requestedCheckIn: 'Asked check-in',
  requestedCheckOut: 'Asked check-out', hoursWorked: 'Hours worked', tenureMonths: 'Months', emi: 'EMI', fieldLabel: 'Field',
  currentValue: 'Current value', requestedValue: 'Asked for', employeeCode: 'Employee code', dateOfJoining: 'Joined',
  dateOfExit: 'Left', isActive: 'Active', createdAt: 'Created', updatedAt: 'Last changed', lastWorkingDay: 'Last working day',
  noticePeriodDays: 'Notice (days)', resignationDate: 'Resigned on', expenseDate: 'Date', paymentMode: 'Paid by',
  expenseBook: 'Book', confirmedByCompany: 'Checked by the company', confirmedAt: 'Checked on', movement: 'Kind',
  checkIn: 'Check in', checkOut: 'Check out', reversalOf: 'Reverses', reversedBy: 'Reversed by', createdBy: 'Created by',
};
const keyLabel = (k) => KEY_WORDS[k] || capital(human(k.replace(/Id$/, '')));

const IST_DT = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
});
const IST_D = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const IST_HM = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const upperMeridiem = (s) => s.replace(/\b([ap])\.?\s?m\.?\b/i, (_, p) => `${p.toUpperCase()}M`);
/** A date alone when it sits on IST midnight, else date and time (12-hour). */
function dateText(d) {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return IST_HM.format(dt) === '00:00' ? IST_D.format(dt) : upperMeridiem(IST_DT.format(dt));
}

const isOid = (v) => v instanceof mongoose.Types.ObjectId || (v && v._bsontype === 'ObjectId');

/**
 * Up to `limit` readable [label, value] pairs from a record — leading fields
 * first, sensitive ones never, people named rather than shown as ids.
 * @param {string|null} type - model name (null for a raw collection)
 * @param {Object} record - the record, lean
 * @param {number} [limit]
 * @returns {Promise<Array<{label: string, value: string}>>}
 */
async function summarizeRecord(type, record, limit = 16) {
  if (!record) return [];
  // A payslip's month and year read as one "Pay period: Sep 2026".
  const doc = { ...record };
  if (doc.payPeriodMonth && doc.payPeriodYear) {
    doc.payPeriod = `${MONTHS[Number(doc.payPeriodMonth) - 1] || doc.payPeriodMonth} ${doc.payPeriodYear}`;
    delete doc.payPeriodMonth;
    delete doc.payPeriodYear;
  }
  const noMoney = NO_MONEY_TYPES.has(type);
  const order = [...(PRIORITY[type] || []), ...Object.keys(doc), 'createdAt', 'updatedAt'];
  const seen = new Set();
  const picked = [];
  for (const k of order) {
    if (picked.length >= limit) break;
    if (seen.has(k) || SKIP_KEYS.has(k) || !(k in doc)) continue;
    seen.add(k);
    if (SENSITIVE.test(k) || NOISE.test(k) || (noMoney && MONEY.test(k))) continue;
    const v = doc[k];
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) { if (v.length) picked.push([k, `${v.length} item${v.length === 1 ? '' : 's'}`]); continue; }
    if (v instanceof Date) { picked.push([k, dateText(v)]); continue; }
    if (typeof v === 'boolean') { picked.push([k, v ? 'Yes' : 'No']); continue; }
    if (typeof v === 'number') {
      picked.push([k, /amount|principal|emi|balance/i.test(k) ? `₹${v.toLocaleString('en-IN')}` : v.toLocaleString('en-IN')]);
      continue;
    }
    if (typeof v === 'string') {
      // A one-word code ("expense", "OnHold") reads as a word; prose stays as written.
      const word = /^[A-Za-z]{2,30}$/.test(v) ? capital(human(v)) : v;
      picked.push([k, word.length > 300 ? `${word.slice(0, 300)}…` : word]);
      continue;
    }
    if (isOid(v)) { picked.push([k, { ref: String(v) }]); continue; }
    // Nested objects (sub-documents) are left out — the record's own fields say enough.
  }
  // Name what the ids point at: people directly or through their employee
  // profile, anything else by its own name/title/code — read off the schema's
  // `ref`, batched one query per referenced model.
  const refs = picked.filter(([, v]) => v && v.ref);
  const names = new Map();
  if (refs.length) {
    const schema = type && modelFor(type) ? modelFor(type).schema : null;
    const byModel = new Map();
    refs.forEach(([k, v]) => {
      const ref = schema?.path(k)?.options?.ref;
      // Without a schema (a raw collection) an id may be a person; try those two.
      (ref ? [ref] : ['User', 'EmployeeProfile']).forEach((r) => {
        if (!byModel.has(r)) byModel.set(r, new Set());
        byModel.get(r).add(v.ref);
      });
    });
    await Promise.all([...byModel.entries()].map(async ([r, ids]) => {
      const m = modelFor(r);
      if (!m) return;
      try {
        if (r === 'User') {
          const rows = await m.find({ _id: { $in: [...ids] } }).select('firstName lastName').lean();
          rows.forEach((u) => names.set(String(u._id), `${u.firstName || ''} ${u.lastName || ''}`.trim()));
        } else if (r === 'EmployeeProfile') {
          const rows = await m.find({ _id: { $in: [...ids] } }).select('user employeeCode').populate('user', 'firstName lastName').lean();
          rows.forEach((p) => names.set(String(p._id), `${p.user ? `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim() : 'Employee'}${p.employeeCode ? ` (${p.employeeCode})` : ''}`));
        } else {
          const rows = await m.find({ _id: { $in: [...ids] } }).select('name title code subject').lean();
          rows.forEach((d) => { const n = d.name || d.title || d.code || d.subject; if (n) names.set(String(d._id), String(n)); });
        }
      } catch { /* an unreadable reference stays "Linked record" */ }
    }));
  }
  return picked
    .map(([k, v]) => ({ label: keyLabel(k), value: v && v.ref ? (names.get(v.ref) || 'Linked record') : String(v) }))
    .slice(0, limit);
}

module.exports = {
  MODULES, moduleInfo, describe, badgeFor, fieldLabel, valueText, resolveUnknownTypes, findRecord, summarizeRecord, human,
};
