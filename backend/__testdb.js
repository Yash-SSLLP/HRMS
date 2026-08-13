// Throwaway in-memory MongoDB for end-to-end testing. Never touches Atlas.
const { MongoMemoryServer } = require('mongodb-memory-server');
(async () => {
  const mongod = await MongoMemoryServer.create({ instance: { port: 27777, dbName: 'hrms_test' } });
  console.log('TESTDB_URI=' + mongod.getUri('hrms_test'));
  console.log('ready');
  process.on('SIGTERM', async () => { await mongod.stop(); process.exit(0); });
  setInterval(() => {}, 1 << 30); // stay alive
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
