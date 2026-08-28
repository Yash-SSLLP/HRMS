/**
 * Find (and optionally remove) data left behind by the old non-cascading deletes.
 *
 * Before services/purgePerson.js existed, DELETE /api/employees/:id removed only
 * the EmployeeProfile and DELETE /api/admin/users/:id removed only the User, so
 * everything else those people owned stayed in the database pointing at an id
 * that no longer resolves. This sweeps that up.
 *
 * It reuses the SAME classification purgePerson uses, so it can never delete a
 * record merely because an admin who once created it has since been removed —
 * only rows whose OWNER is gone, plus dangling list entries and pointers.
 *
 * Reports and changes nothing by default:
 *   node scripts/cleanupOrphans.js
 * Actually deletes:
 *   node scripts/cleanupOrphans.js --apply
 * Skip the (slower) unreferenced-file scan:
 *   node scripts/cleanupOrphans.js --no-files
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const connectDB = require('../config/db');
const storage = require('../services/storage');

// Register every model so mongoose.model(name) resolves regardless of which
// controllers happen to have been required.
const modelsDir = path.join(__dirname, '..', 'models');
for (const f of fs.readdirSync(modelsDir)) {
  if (f.endsWith('.js')) {
    try { require(path.join(modelsDir, f)); } catch (e) { console.error('could not load model ' + f + ': ' + e.message); }
  }
}

const {
  OWNED_BY_PROFILE, OWNED_BY_USER, PULL_FROM, UNSET_REF, RETAINED_COLLECTIONS,
} = require('../services/purgePerson');

const APPLY = process.argv.includes('--apply');
const SCAN_FILES = !process.argv.includes('--no-files');
const M = (n) => mongoose.model(n);

const plan = [];
const record = (action, target, count, detail) => { if (count > 0) plan.push({ action, target, count, detail }); };

// Rows this run is going to delete. In APPLY mode they are gone by the time the
// file scan runs, so a file only they referenced correctly shows up as
// unreferenced. In DRY-RUN mode nothing has been deleted yet, so without this
// the scan still sees those rows and under-reports the files that would go —
// which is exactly how a dry run reporting 43 turned into an apply doing 45.
const pending = new Map(); // collection name -> Set of _id strings
async function markPending(model, filter) {
  if (APPLY) return;
  const col = M(model).collection.name;
  if (!pending.has(col)) pending.set(col, new Set());
  const ids = await M(model).find(filter).select('_id').lean();
  for (const r of ids) pending.get(col).add(String(r._id));
}
const isPending = (col, id) => pending.has(col) && pending.get(col).has(String(id));

/** Distinct values of `field` that do not appear in `liveIds`. */
async function danglingIds(model, field, liveIds) {
  const values = await M(model).distinct(field);
  return values.filter((v) => v && !liveIds.has(String(v)));
}

async function main() {
  await connectDB();
  console.log(APPLY ? '*** APPLY MODE — changes WILL be written ***\n' : 'DRY RUN — nothing will be changed. Re-run with --apply to delete.\n');

  const liveUsers = new Set((await M('User').find({}).select('_id').lean()).map((u) => String(u._id)));
  const liveProfiles = new Set((await M('EmployeeProfile').find({}).select('_id').lean()).map((p) => String(p._id)));
  console.log('live users: ' + liveUsers.size + ', live employee profiles: ' + liveProfiles.size + '\n');

  /* ---- 1. rows whose OWNER no longer exists ---- */
  for (const [group, pairs, live] of [
    ['profile', OWNED_BY_PROFILE, liveProfiles],
    ['user', OWNED_BY_USER, liveUsers],
  ]) {
    for (const [model, field] of pairs) {
      if (RETAINED_COLLECTIONS.includes(M(model).collection.name)) continue;
      const dangling = await danglingIds(model, field, live);
      if (!dangling.length) continue;
      const filter = { [field]: { $in: dangling } };
      const n = await M(model).countDocuments(filter);
      record('delete', model + '.' + field, n, 'owning ' + group + ' deleted');
      await markPending(model, filter);
      if (APPLY && n) await M(model).deleteMany(filter);
    }
  }

  /* ---- 2. documents whose owning profile is gone: drop the file too ---- */
  {
    const dangling = await danglingIds('Document', 'employee', liveProfiles);
    if (dangling.length) {
      const docs = await M('Document').find({ employee: { $in: dangling } }).select('storagePath').lean();
      record('delete', 'Document', docs.length, 'owning profile deleted');
      let files = 0;
      for (const d of docs) {
        if (!d.storagePath) continue;
        files += 1;
        if (APPLY) { try { await storage.remove(d.storagePath); } catch { /* already gone */ } }
      }
      record('delete-file', 'Document files', files, 'owning profile deleted');
      await markPending('Document', { employee: { $in: dangling } });
      if (APPLY) await M('Document').deleteMany({ employee: { $in: dangling } });
    }
  }

  /* ---- 3. chat threads whose participant is gone ---- */
  {
    const Connection = M('Connection');
    const dead = [];
    for (const field of ['requester', 'recipient']) {
      dead.push(...(await danglingIds('Connection', field, liveUsers)));
    }
    if (dead.length) {
      const conns = await Connection.find({ $or: [{ requester: { $in: dead } }, { recipient: { $in: dead } }] }).select('_id').lean();
      const ids = conns.map((c) => c._id);
      const msgs = await M('Message').countDocuments({ connection: { $in: ids } });
      record('delete', 'Message (1:1 threads)', msgs, 'participant deleted');
      record('delete', 'Connection', ids.length, 'participant deleted');
      await markPending('Message', { connection: { $in: ids } });
      await markPending('Connection', { _id: { $in: ids } });
      if (APPLY) {
        await M('Message').deleteMany({ connection: { $in: ids } });
        await Connection.deleteMany({ _id: { $in: ids } });
      }
    }
    const deadSenders = await danglingIds('Message', 'sender', liveUsers);
    if (deadSenders.length) {
      const filter = { sender: { $in: deadSenders }, group: { $ne: null } };
      const n = await M('Message').countDocuments(filter);
      record('delete', 'Message (group)', n, 'sender deleted');
      await markPending('Message', filter);
      if (APPLY && n) await M('Message').deleteMany(filter);
    }
  }

  /* ---- 4. dangling list entries ---- */
  for (const [model, field, subKey] of PULL_FROM) {
    const dotted = subKey ? field + '.' + subKey : field;
    const dangling = await danglingIds(model, dotted, liveUsers);
    if (!dangling.length) continue;
    const filter = { [dotted]: { $in: dangling } };
    const n = await M(model).countDocuments(filter);
    record('pull', model + '.' + field, n, 'listed user deleted');
    if (APPLY && n) {
      await M(model).updateMany(filter, {
        $pull: { [field]: subKey ? { [subKey]: { $in: dangling } } : { $in: dangling } },
      });
    }
  }

  /* ---- 5. dangling pointers on rows that belong to someone else ---- */
  const POINTERS = [
    ...UNSET_REF,
    ['LeaveRequest', 'currentApprover'],
    ['ExitRequest', 'currentApprover'],
    ['Regularization', 'currentApprover'],
  ];
  for (const [model, field] of POINTERS) {
    const dangling = await danglingIds(model, field, field === 'employee.profile' ? liveProfiles : liveUsers);
    if (!dangling.length) continue;
    const filter = { [field]: { $in: dangling } };
    const n = await M(model).countDocuments(filter);
    record('unset', model + '.' + field, n, 'target user deleted');
    if (APPLY && n) await M(model).updateMany(filter, { $set: { [field]: null } });
  }

  /* ---- 6. stored files nothing references ---- */
  if (SCAN_FILES) {
    const db = mongoose.connection.db;
    const referenced = new Set();
    for (const c of await db.listCollections().toArray()) {
      if (c.name.startsWith('uploads.')) continue;
      const rows = await db.collection(c.name).find({}).toArray();
      for (const r of rows) {
        if (isPending(c.name, r._id)) continue; // this row is going away with its file
        collectPaths(r, referenced);
      }
    }
    const files = await db.collection('uploads.files').find({}, { projection: { filename: 1, length: 1 } }).toArray();
    const unref = files.filter((f) => !referenced.has(f.filename));
    const kb = Math.round(unref.reduce((s, f) => s + (f.length || 0), 0) / 1024);
    record('delete-file', 'unreferenced stored files', unref.length, kb + ' KB');
    if (APPLY) {
      for (const f of unref) { try { await storage.remove(f.filename); } catch { /* already gone */ } }
    }
  }

  /* ---- report ---- */
  console.log(APPLY ? 'APPLIED:' : 'WOULD CHANGE:');
  if (!plan.length) console.log('  nothing — no orphaned data found');
  for (const p of plan) {
    console.log('  ' + p.action.padEnd(13) + String(p.count).padStart(5) + '  ' + p.target.padEnd(34) + (p.detail || ''));
  }
  const deletions = plan.filter((p) => p.action.startsWith('delete')).reduce((s, p) => s + p.count, 0);
  console.log('\ntotal ' + (APPLY ? 'deleted' : 'to delete') + ': ' + deletions);
  console.log('never touched: ' + RETAINED_COLLECTIONS.join(', '));
  if (!APPLY && plan.length) console.log('\nRe-run with --apply to perform these changes.');

  await mongoose.disconnect();
}

/** Collect every value that looks like a stored-file path out of a document. */
function collectPaths(value, out, depth = 0) {
  if (depth > 6 || value == null) return;
  if (typeof value === 'string') {
    if (value.includes('/') && !value.startsWith('http')) out.add(value);
    return;
  }
  if (Array.isArray(value)) { for (const v of value) collectPaths(v, out, depth + 1); return; }
  if (typeof value === 'object' && !(value instanceof Date) && !(value._bsontype)) {
    for (const v of Object.values(value)) collectPaths(v, out, depth + 1);
  }
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });
