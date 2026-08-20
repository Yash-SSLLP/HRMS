/**
 * Wipe the HRMS portal back to a fresh install, keeping only the SuperAdmin login.
 *
 *   node scripts/resetPortal.js                     # report what it would delete
 *   node scripts/resetPortal.js --apply             # delete it
 *   node scripts/resetPortal.js --apply --wipe-config   # also clear portal setup
 *
 * THIS DESTROYS DATA AND CANNOT BE UNDONE. It exists to clear dummy/test data
 * so the portal can be exercised from a clean slate. It is not a maintenance
 * tool — nothing in normal operation should ever bulk-delete these rows.
 *
 * WHAT IT KEEPS, ALWAYS:
 *   1. Every user whose role is SuperAdmin (their login is the way back in),
 *      and the GridFS blob their profile photo points at.
 *   2. Every collection this database holds that the HRMS models do NOT own.
 *      This database is shared with another application (dealers, customers,
 *      products, orders, ...) and those rows are none of our business. The
 *      owned set is read off the mongoose models at runtime, not hardcoded, so
 *      a new model cannot quietly fall outside it.
 *
 * WHAT --wipe-config ADDS: the portal's own setup — settings (office geofence,
 * punch reminder times, module toggles), shifts, holidays, work locations,
 * departments, cash accounts & categories, mail/letter templates, org masters.
 * Without the flag that setup survives and only operational data goes.
 *
 * GRIDFS. Uploads are files in uploads.files plus their uploads.chunks blocks.
 * Deleting the owning row would leave the blob orphaned, so the file store is
 * cleared alongside — except the SuperAdmin's own photo.
 *
 * RECONCILING WHAT SURVIVES. Kept config still points at the world we deleted:
 * a cash account's currentBalance is a cache of its (now gone) ledger, and every
 * createdBy/operator on those rows names a user who no longer exists — which
 * populates to null and reads as a blank name in the UI. So after the delete the
 * kept rows are re-based: balances back to their opening figure, dangling user
 * refs re-pointed at the surviving SuperAdmin, operator grants for deleted users
 * dropped.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const APPLY = process.argv.includes('--apply');
const WIPE_CONFIG = process.argv.includes('--wipe-config');
const say = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

// Portal setup rather than operational data — kept unless --wipe-config.
const CONFIG_COLLECTIONS = new Set([
  'settings',
  'templates',
  'holidays',
  'shifts',
  'worklocations',
  'departments',
  'cashaccounts',
  'cashcategories',
  'orgmasters',
  'guides',
]);

// Loading every model registers it with mongoose, which is how we learn the
// exact set of collections the HRMS owns.
function ownedCollections() {
  const dir = path.join(__dirname, '..', 'models');
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.js')) require(path.join(dir, f));
  }
  return new Set(Object.values(mongoose.models).map((m) => m.collection.collectionName));
}

// Kept config rows carry ObjectIds of users that no longer exist. Re-point them
// at the surviving SuperAdmin so nothing populates to null.
const USER_REFS = {
  cashaccounts: ['createdBy'],
  cashcategories: ['createdBy'],
  worklocations: ['createdBy'],
  shifts: ['createdBy'],
  holidays: ['createdBy'],
  templates: ['updatedBy'],
};

async function reconcile(db, adminId) {
  const alive = new Set(
    (await db.collection('users').find({}, { projection: { _id: 1 } }).toArray()).map((u) => String(u._id))
  );
  const fixes = [];

  for (const [name, fields] of Object.entries(USER_REFS)) {
    for (const field of fields) {
      const rows = await db
        .collection(name)
        .find({ [field]: { $exists: true, $ne: null } }, { projection: { [field]: 1 } })
        .toArray();
      const ids = rows.filter((doc) => !alive.has(String(doc[field]))).map((doc) => doc._id);
      if (!ids.length) continue;
      await db.collection(name).updateMany({ _id: { $in: ids } }, { $set: { [field]: adminId } });
      fixes.push(`${name}.${field} -> SuperAdmin (${ids.length})`);
    }
  }

  // A cash account's balance is a cache of its ledger rows. Those are gone, so
  // the only honest figure left is the opening balance.
  const accounts = await db.collection('cashaccounts').find({}).toArray();
  for (const a of accounts) {
    const opening = Number(a.openingBalance) || 0;
    const operators = (a.operators || []).filter((o) => alive.has(String(o.user)));
    const set = {};
    if (Number(a.currentBalance) !== opening) set.currentBalance = opening;
    if (operators.length !== (a.operators || []).length) set.operators = operators;
    if (!Object.keys(set).length) continue;
    await db.collection('cashaccounts').updateOne({ _id: a._id }, { $set: set });
    if ('currentBalance' in set) fixes.push(`${a.name}: balance ${a.currentBalance} -> ${opening} (ledger is empty)`);
    if ('operators' in set) {
      fixes.push(`${a.name}: dropped ${(a.operators || []).length - operators.length} operator(s) for deleted users`);
    }
  }

  if (fixes.length) console.log(`\nreconciled kept config:\n   ${fixes.join('\n   ')}`);
}

async function run() {
  const owned = ownedCollections();
  await connectDB();
  const db = mongoose.connection.db;
  console.log(`\ndatabase: ${mongoose.connection.name}\n`);

  // --- The logins that survive ---
  const keepUsers = await db
    .collection('users')
    .find({ role: 'SuperAdmin' }, { projection: { email: 1, firstName: 1, lastName: 1, photo: 1 } })
    .toArray();
  if (!keepUsers.length) {
    console.error('ABORT: no SuperAdmin user found — refusing to lock you out of the portal.');
    process.exitCode = 1;
    return;
  }
  console.log('keeping these logins:');
  for (const u of keepUsers) console.log(`   ${u.email}  (${`${u.firstName || ''} ${u.lastName || ''}`.trim()})`);
  const keepFiles = keepUsers.map((u) => u.photo).filter(Boolean);

  // --- Split the database into what we own and what we must not touch ---
  const present = (await db.listCollections().toArray()).map((c) => c.name);
  const gridfs = present.filter((n) => n === 'uploads.files' || n === 'uploads.chunks');
  const foreign = present.filter((n) => !owned.has(n) && !gridfs.includes(n));
  const targets = present.filter((n) => owned.has(n) && n !== 'users');

  // --- Report, then act ---
  let deleted = 0;
  const kept = [];
  console.log('\ncollections to clear:');
  for (const name of targets.sort()) {
    const col = db.collection(name);
    const count = await col.countDocuments();
    if (!count) continue;
    if (CONFIG_COLLECTIONS.has(name) && !WIPE_CONFIG) {
      kept.push(`${name} (${count})`);
      continue;
    }
    say(`   ${name}: ${count}`);
    if (APPLY) {
      const res = await col.deleteMany({});
      deleted += res.deletedCount;
    } else {
      deleted += count;
    }
  }

  // Users: everything except the SuperAdmin rows.
  const others = await db.collection('users').countDocuments({ role: { $ne: 'SuperAdmin' } });
  if (others) {
    say(`   users: ${others} (all non-SuperAdmin)`);
    if (APPLY) await db.collection('users').deleteMany({ role: { $ne: 'SuperAdmin' } });
    deleted += others;
  }

  // GridFS: drop every blob except the kept photos, chunks first so a failure
  // mid-way leaves orphaned chunks rather than a file row pointing at nothing.
  if (gridfs.includes('uploads.files')) {
    const files = db.collection('uploads.files');
    const doomed = await files
      .find({ filename: { $nin: keepFiles } }, { projection: { _id: 1 } })
      .toArray();
    if (doomed.length) {
      say(`   uploads (GridFS): ${doomed.length} files${keepFiles.length ? ` (keeping ${keepFiles.length})` : ''}`);
      if (APPLY) {
        const ids = doomed.map((f) => f._id);
        await db.collection('uploads.chunks').deleteMany({ files_id: { $in: ids } });
        await files.deleteMany({ _id: { $in: ids } });
      }
      deleted += doomed.length;
    }
  }

  // --- Re-base the config we kept onto the world that is left ---
  if (kept.length && APPLY) await reconcile(db, keepUsers[0]._id);

  if (kept.length) {
    console.log(`\nkeeping portal setup (pass --wipe-config to clear it too):\n   ${kept.join(', ')}`);
  }
  if (foreign.length) {
    console.log(`\nNOT TOUCHED — collections this database holds that the HRMS does not own:\n   ${foreign.sort().join(', ')}`);
  }

  console.log(`\n${APPLY ? 'deleted' : 'would delete'} ${deleted} documents.`);
  if (!APPLY) console.log('nothing was changed. re-run with --apply to do it.');
}

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
