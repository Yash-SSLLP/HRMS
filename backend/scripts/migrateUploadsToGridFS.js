/**
 * One-off (idempotent) migration: copy every file under UPLOAD_DIR into MongoDB
 * GridFS, keyed by the same relative path already stored in the DB.
 *
 * Why: storage used to write to the container filesystem, so the bytes only
 * existed on whichever machine handled the upload — invisible to any other
 * backend instance, and wiped by every Railway redeploy. services/storage.js
 * now reads and writes GridFS; this back-fills the files that predate it.
 *
 * Safe to re-run: a path already present in GridFS is skipped, and nothing is
 * deleted from disk (the disk copy stays as a fallback / backup).
 *
 *   node scripts/migrateUploadsToGridFS.js          # migrate everything
 *   node scripts/migrateUploadsToGridFS.js avatars  # only this sub-folder
 *   node scripts/migrateUploadsToGridFS.js --dry-run
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');

const ROOT = path.resolve(process.env.UPLOAD_DIR || './uploads');
const BUCKET = 'uploads';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => !a.startsWith('--')) || null;

/** Every file under `dir`, as paths relative to ROOT with forward slashes. */
function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, acc);
    else if (entry.isFile()) acc.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return acc;
}

const mb = (n) => (n / 1048576).toFixed(1);

(async () => {
  if (!fs.existsSync(ROOT)) {
    console.log(`No upload directory at ${ROOT} — nothing to migrate.`);
    return;
  }
  await connectDB();
  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

  const base = only ? path.join(ROOT, only) : ROOT;
  if (!fs.existsSync(base)) {
    console.log(`No such folder: ${base}`);
    await mongoose.disconnect();
    return;
  }

  const files = walk(base);
  console.log(`${files.length} file(s) under ${base}${dryRun ? '  [DRY RUN]' : ''}\n`);

  let migrated = 0; let skipped = 0; let failed = 0; let bytes = 0;
  for (const rel of files) {
    const already = await bucket.find({ filename: rel }).limit(1).toArray();
    if (already.length) { skipped += 1; continue; }

    const abs = path.join(ROOT, rel);
    const size = fs.statSync(abs).size;
    if (dryRun) { migrated += 1; bytes += size; console.log(`would migrate  ${rel}  (${mb(size)} MB)`); continue; }

    try {
      await new Promise((resolve, reject) => {
        const upload = bucket.openUploadStream(rel, { metadata: { migratedFromDisk: true, sizeBytes: size } });
        upload.on('error', reject);
        upload.on('finish', resolve);
        fs.createReadStream(abs).on('error', reject).pipe(upload);
      });
      migrated += 1; bytes += size;
      console.log(`migrated  ${rel}  (${mb(size)} MB)`);
    } catch (err) {
      failed += 1;
      console.log(`FAILED    ${rel}  -> ${err.message}`);
    }
  }

  console.log(`\nmigrated ${migrated}  skipped(already in GridFS) ${skipped}  failed ${failed}  total ${mb(bytes)} MB`);
  await mongoose.disconnect();
})().catch((err) => { console.error(err); process.exit(1); });
