/**
 * Name the audit rows that were written before the log knew how to name them.
 *
 *   node scripts/backfillAuditLabels.js          # report what it would do
 *   node scripts/backfillAuditLabels.js --apply  # actually do it
 *
 * WHAT WAS WRONG. `AuditLog.entityLabel` is the "Record" column of the audit
 * screen — it is what turns a line into a sentence: "Vikas S approved
 * Priya Sharma's leave" instead of "Vikas S approved 59487c". The plugin that
 * writes the log used to look for `name` or `title` on the record, and the
 * request-shaped models — a leave, a regularisation, a reimbursement, a payslip,
 * a khata row — have neither. So every one of their rows went in with no label
 * and the screen fell back to showing six characters of the record's id.
 *
 * models/plugins/auditStatus.js now takes a `person` option and names those rows
 * after the person the record is about, but only rows written from here on. This
 * fills in the ones already on file, using the same rule, so the history reads
 * the same way as everything written after it.
 *
 * ONLY EMPTY LABELS ARE TOUCHED. A row that already carries one was named by its
 * own record and is right; nothing here overwrites it. Every other field —
 * who acted, what changed, when — is left exactly as it was: this is a display
 * label being filled in, not history being rewritten.
 *
 * Safe to run more than once; the second run finds nothing to do.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const AuditLog = require('../models/AuditLog');

const APPLY = process.argv.includes('--apply');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

/**
 * Which model an audit row's `entity` names, and which path on it holds the
 * person the row is about.
 *
 * Read from the models themselves rather than repeated here: each one already
 * declares its `person` in its auditStatus registration, and a second copy in
 * this file would be the thing that goes stale. `entity` in the log is the
 * Mongoose model name — except where a registration overrides it — so the map is
 * built by asking every registered model what it audits.
 * @returns {Map<string, {model: import('mongoose').Model, path: string}>}
 */
function personPaths() {
  const map = new Map();
  for (const name of mongoose.modelNames()) {
    const model = mongoose.model(name);
    // `$auditPerson` is stamped on the schema by the plugin — see auditStatus.js.
    const path = model.schema.$auditPerson;
    if (!path) continue;
    map.set(model.schema.$auditEntity || name, { model, path });
  }
  return map;
}

/**
 * The person's full name behind a ref, following one hop through an
 * EmployeeProfile where the ref lands on one (a profile carries no name of its
 * own). Mirrors personNameOf in models/plugins/auditStatus.js.
 * @param {import('mongoose').Model} model - The record's model.
 * @param {string} path - The path holding the person.
 * @param {*} id - The referenced id.
 * @returns {Promise<string>} '' when it cannot be resolved.
 */
async function nameOf(model, path, id) {
  if (!id) return '';
  const refName = model.schema.path(path)?.options?.ref;
  if (!refName) return '';
  let person = await mongoose.model(refName).findById(id).select('firstName lastName user').lean();
  if (person && !person.firstName && person.user) {
    person = await mongoose.model('User').findById(person.user).select('firstName lastName').lean();
  }
  return person?.firstName ? `${person.firstName} ${person.lastName || ''}`.trim() : '';
}

async function run() {
  await connectDB();
  // Register every model, so `personPaths` sees them and every ref resolves.
  // There is no barrel file, so the directory is the list.
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'models');
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.js')) require(path.join(dir, file));
  }

  const paths = personPaths();
  const blank = { $or: [{ entityLabel: { $exists: false } }, { entityLabel: null }, { entityLabel: '' }] };
  const rows = await AuditLog.find(blank).sort({ at: -1 }).lean();
  console.log(`${rows.length} audit row(s) with no label; ${paths.size} model(s) know who they are about\n`);

  const stats = { named: 0, noRecord: 0, noPerson: 0, unknownEntity: 0 };
  const unknown = new Set();

  for (const row of rows) {
    const entry = paths.get(row.entity);
    if (!entry) { stats.unknownEntity += 1; unknown.add(row.entity); continue; }

    const record = await entry.model.findById(row.entityId).select(entry.path).lean();
    // The record itself is gone — a purged employee, a deleted draft. The audit
    // line stays (that is the point of an audit line), just unnamed.
    if (!record) { stats.noRecord += 1; continue; }

    const label = await nameOf(entry.model, entry.path, record[entry.path]);
    if (!label) { stats.noPerson += 1; continue; }

    say(`${row.entity} ${String(row.entityId).slice(-6)} → "${label}"`);
    if (APPLY) await AuditLog.updateOne({ _id: row._id }, { $set: { entityLabel: label } });
    stats.named += 1;
  }

  console.log(`\n${APPLY ? 'named' : 'would name'}: ${stats.named}`);
  console.log(`skipped — record no longer exists: ${stats.noRecord}`);
  console.log(`skipped — no person on the record:  ${stats.noPerson}`);
  console.log(`skipped — entity has no person path: ${stats.unknownEntity}${unknown.size ? ` (${[...unknown].join(', ')})` : ''}`);
  if (!APPLY) console.log('\nNothing was written. Re-run with --apply to save these labels.');
}

run()
  .then(() => mongoose.disconnect())
  .catch(async (err) => {
    console.error(err);
    await mongoose.disconnect();
    process.exit(1);
  });
