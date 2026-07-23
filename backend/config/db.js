// MongoDB connection setup. Pins public DNS resolvers (so mongodb+srv SRV
// lookups work behind restrictive networks) and exposes connectDB(), called
// once at boot in server.js before routes/workers start.
const mongoose = require('mongoose');
const dns = require('dns');

// Force Node to use public DNS resolvers for the SRV lookup that
// mongodb+srv:// URIs require. This bypasses broken or restrictive
// local DNS (common with some ISPs, VPNs, and corporate networks).
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

/**
 * Connect Mongoose to the MongoDB instance named by the MONGO_URI env var.
 * @returns {Promise<void>} Resolves once connected.
 * @throws {Error} If MONGO_URI is unset, or the connection fails.
 * @sideeffect Opens the shared Mongoose connection and logs on success.
 */
async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set in environment');
  }
  await mongoose.connect(uri);
  console.log('MongoDB connected');
}

module.exports = connectDB;
