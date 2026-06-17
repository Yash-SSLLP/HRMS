const mongoose = require('mongoose');
const dns = require('dns');

// Force Node to use public DNS resolvers for the SRV lookup that
// mongodb+srv:// URIs require. This bypasses broken or restrictive
// local DNS (common with some ISPs, VPNs, and corporate networks).
dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);

async function connectDB() {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is not set in environment');
  }
  await mongoose.connect(uri);
  console.log('MongoDB connected');
}

module.exports = connectDB;
