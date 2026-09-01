/**
 * Fold the retired Org Masters "Locations" list into the Work Locations register.
 *
 * Until 2026-09-01 there were two lists of the same places: OrgMaster rows of
 * kind 'Location' (name / code / description, managed on the Org Masters page)
 * and WorkLocation sites (name + geofence, managed on the Work Locations page).
 * Only the second is real — an employee is assigned to a WorkLocation and their
 * punch geofence is measured against it — so the first has been removed. This
 * copies across anything that existed only in the old list, so no name is lost.
 *
 * What it creates is a site with a NAME AND NOTHING ELSE. Coordinates and a
 * radius cannot be invented here, and a site without them simply has no
 * geofence to check (see utils/resolveGeofence), so nobody's punching is
 * narrowed by this script. The report at the end names every site still needing
 * its coordinates filled in.
 *
 * DRY RUN BY DEFAULT — prints what it would do and writes nothing:
 *   node scripts/mergeOrgLocations.js
 *   node scripts/mergeOrgLocations.js --apply
 *
 * The old OrgMaster rows are left where they are (unreachable, and evidence if
 * anything looks wrong afterwards); pass --delete-old with --apply to remove
 * them once you are satisfied.
 */
require('dotenv').config();
const connectDB = require('../config/db');
const OrgMaster = require('../models/OrgMaster');
const WorkLocation = require('../models/WorkLocation');

const APPLY = process.argv.includes('--apply');
const DELETE_OLD = process.argv.includes('--delete-old');

(async () => {
  await connectDB();

  // Read the retired rows directly: 'Location' is no longer in the model's enum,
  // which affects writes and validation, not what is already stored.
  const legacy = await OrgMaster.find({ kind: 'Location' }).select('name code description isActive').lean();
  const sites = await WorkLocation.find().select('name lat lng').lean();
  const byName = new Map(sites.map((s) => [s.name.trim().toLowerCase(), s]));

  const missing = legacy.filter((l) => l.name && !byName.has(l.name.trim().toLowerCase()));
  const already = legacy.length - missing.length;

  console.log(`Org Masters locations : ${legacy.length}`);
  console.log(`Work Locations sites  : ${sites.length}`);
  console.log(`Already present       : ${already}`);
  console.log(`To copy across        : ${missing.length}`);
  for (const l of missing) console.log(`  + ${l.name}${l.code ? ` (${l.code})` : ''}`);

  if (missing.length && APPLY) {
    for (const l of missing) {
      // eslint-disable-next-line no-await-in-loop
      await WorkLocation.updateOne(
        { name: l.name.trim() },
        { $setOnInsert: { name: l.name.trim(), active: l.isActive !== false } },
        { upsert: true }
      );
    }
    console.log(`Created ${missing.length} work location(s).`);
  } else if (missing.length) {
    console.log('(dry run — pass --apply to create them)');
  }

  if (DELETE_OLD && APPLY) {
    const { deletedCount } = await OrgMaster.deleteMany({ kind: 'Location' });
    console.log(`Deleted ${deletedCount} retired OrgMaster location row(s).`);
  }

  // Whatever exists now, say which sites cannot geofence anything yet.
  const after = await WorkLocation.find().select('name lat lng').lean();
  const noFence = after.filter((s) => s.lat == null || s.lng == null);
  if (noFence.length) {
    console.log(`\n${noFence.length} work location(s) have no coordinates yet — open Work Locations and set them:`);
    for (const s of noFence) console.log(`  ! ${s.name}`);
  }

  process.exit(0);
})().catch((err) => {
  console.error('mergeOrgLocations failed:', err.message);
  process.exit(1);
});
