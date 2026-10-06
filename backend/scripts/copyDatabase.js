/**
 * Copy the whole HRMS database (MONGO_URI in .env) into a database on ANOTHER
 * cluster — used to move HRMS to a new Atlas cluster (first run 2026-10-06).
 *
 *   DST_URI="mongodb+srv://user:pass@host/?appName=Cluster0" node scripts/copyDatabase.js --dry-run
 *   DST_URI=... node scripts/copyDatabase.js              copy (refuses if the target db is not empty)
 *   DST_URI=... node scripts/copyDatabase.js --replace    drop ONLY the target db, then copy again
 *   DST_DB=other_name                                     target db name (default: same as the source)
 *   --skip=a,b                                            leave those collections out
 *
 * _id and BSON types are kept as they are (Int32/Int64/Double/Decimal128/Binary
 * are not re-typed), GridFS files come along as ordinary collections, indexes are
 * rebuilt after the data, and every collection is checked by document count AND
 * total BSON bytes on both sides. The source is only read. On the target only
 * DST_DB is written — other databases on that cluster are never touched.
 *
 * The live app keeps writing to the source, so a copy is a snapshot: re-run with
 * --replace immediately before switching MONGO_URI, with the app stopped if possible.
 */
require('dotenv').config();
require('dns').setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
const { MongoClient, BSON } = require('mongodb');

const SRC_URI = process.env.MONGO_URI;
const DST_URI = process.env.DST_URI;

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const REPLACE = args.includes('--replace');
const skipArg = args.find((a) => a.startsWith('--skip='));
const SKIP = new Set(skipArg ? skipArg.slice(7).split(',').filter(Boolean) : []);

const FORBIDDEN = new Set(['admin', 'local', 'config']);
const READ_OPTS = { promoteValues: false, promoteBuffers: false, bsonRegExp: true };
const BATCH_DOCS = 500;
const BATCH_BYTES = 8 * 1048576;
const MB = (b) => (b / 1048576).toFixed(1) + ' MB';
const host = (uri) => (uri.match(/@([^/?]+)/) || [])[1];

async function fingerprint(coll) {
  const [r] = await coll.aggregate([
    { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: { $bsonSize: '$$ROOT' } } } },
  ]).toArray();
  return r ? { n: Number(r.n), bytes: Number(r.bytes) } : { n: 0, bytes: 0 };
}

async function copyCollection(sdb, ddb, name) {
  const dst = ddb.collection(name);
  let batch = [];
  let bytes = 0;
  let done = 0;
  let doneBytes = 0;
  let lastLog = 0;
  const flush = async () => {
    if (!batch.length) return;
    await dst.insertMany(batch, { ordered: false });
    done += batch.length;
    doneBytes += bytes;
    batch = [];
    bytes = 0;
    if (doneBytes - lastLog > 25 * 1048576) {
      lastLog = doneBytes;
      console.log(`    … ${name}: ${done} docs, ${MB(doneBytes)}`);
    }
  };
  for await (const doc of sdb.collection(name).find({}, { ...READ_OPTS, batchSize: 200 }).sort({ _id: 1 })) {
    batch.push(doc);
    bytes += BSON.calculateObjectSize(doc);
    if (batch.length >= BATCH_DOCS || bytes >= BATCH_BYTES) await flush();
  }
  await flush();
  return done;
}

async function copyIndexes(sdb, ddb, name) {
  const idx = await sdb.collection(name).listIndexes().toArray();
  // eslint-disable-next-line no-unused-vars
  const specs = idx.filter((i) => i.name !== '_id_').map(({ v, ns, background, ...rest }) => rest);
  if (specs.length) await ddb.collection(name).createIndexes(specs);
  return specs.length;
}

(async () => {
  if (!SRC_URI) throw new Error('MONGO_URI is not set in .env');
  if (!DST_URI) throw new Error('set DST_URI to the target cluster connection string');
  if (host(SRC_URI) === host(DST_URI)) throw new Error('source and target are the same cluster');

  const sc = new MongoClient(SRC_URI);
  const dc = new MongoClient(DST_URI);
  await sc.connect();
  await dc.connect();
  const sdb = sc.db();
  const DST_DB = process.env.DST_DB || sdb.databaseName;
  if (FORBIDDEN.has(DST_DB)) throw new Error(`refusing to write into target db "${DST_DB}"`);
  const ddb = dc.db(DST_DB);
  console.log(`SOURCE ${host(SRC_URI)} / ${sdb.databaseName}`);
  console.log(`TARGET ${host(DST_URI)} / ${DST_DB}${DRY ? '   (dry run — nothing written)' : ''}`);

  const cols = (await sdb.listCollections().toArray())
    .filter((c) => c.type !== 'view' && !c.name.startsWith('system.') && !SKIP.has(c.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const existing = await ddb.listCollections().toArray();
  if (existing.length && !REPLACE && !DRY) {
    throw new Error(`target db "${DST_DB}" already has ${existing.length} collections — re-run with --replace to drop and recopy it`);
  }

  const dbs = await dc.db('admin').admin().listDatabases();
  const srcStats = await sdb.command({ dbStats: 1 });
  const others = dbs.databases.filter((d) => d.name !== DST_DB).reduce((s, d) => s + d.sizeOnDisk, 0);
  console.log(`target cluster already uses ${MB(others)} on disk outside ${DST_DB}; this copy adds ~${MB(srcStats.dataSize + srcStats.indexSize)} (data + indexes)`);
  if (SKIP.size) console.log('skipping:', [...SKIP].join(', '));

  if (DRY) {
    let n = 0;
    let b = 0;
    for (const c of cols) {
      const f = await fingerprint(sdb.collection(c.name));
      n += f.n;
      b += f.bytes;
    }
    console.log(`would copy ${cols.length} collections, ${n} documents, ${MB(b)} of BSON`);
    console.log(existing.length ? `target db "${DST_DB}" is NOT empty (${existing.length} collections)` : `target db "${DST_DB}" is empty`);
    await sc.close();
    await dc.close();
    return;
  }

  if (existing.length && REPLACE) {
    console.log(`dropping target db ${DST_DB} (${existing.length} collections)…`);
    await ddb.dropDatabase();
  }

  const t0 = Date.now();
  const report = [];
  for (const c of cols) {
    const before = await fingerprint(sdb.collection(c.name));
    await ddb.createCollection(c.name, c.options || {});
    const copied = await copyCollection(sdb, ddb, c.name);
    const after = await fingerprint(ddb.collection(c.name));
    const ok = after.n === before.n && after.bytes === before.bytes;
    report.push({ name: c.name, before, after, ok });
    console.log(`  ${ok ? 'OK ' : 'DIFF'} ${c.name.padEnd(28)} ${String(copied).padStart(6)} docs  ${MB(after.bytes).padStart(9)}`);
  }

  console.log('rebuilding indexes…');
  let ix = 0;
  for (const c of cols) ix += await copyIndexes(sdb, ddb, c.name);
  console.log(`  ${ix} secondary indexes created`);

  const bad = report.filter((r) => !r.ok);
  const docs = report.reduce((s, r) => s + r.after.n, 0);
  const bytes = report.reduce((s, r) => s + r.after.bytes, 0);
  console.log(`\nDONE in ${((Date.now() - t0) / 1000).toFixed(0)} s — ${report.length} collections, ${docs} documents, ${MB(bytes)}`);
  if (bad.length) {
    console.log('MISMATCHES (usually the live app wrote during the copy — re-run with --replace):');
    for (const r of bad) console.log(`  ${r.name}: source ${r.before.n} docs/${r.before.bytes} B, target ${r.after.n} docs/${r.after.bytes} B`);
    process.exitCode = 2;
  } else {
    console.log('every collection matches the source on document count and BSON bytes');
  }
  await sc.close();
  await dc.close();
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
