/**
 * Shared Firebase Admin app (firebase-admin v14 — modular API).
 *
 * A single initialised Admin app is reused across features (FCM push in
 * services/push.js and Cloud Storage for LMS video renditions in
 * services/renditionStore.js) so we never double-initialise.
 *
 * Credentials: a Firebase service-account key, provided as either
 *   - FIREBASE_SERVICE_ACCOUNT_JSON  → the whole JSON as a string (best for Railway), or
 *   - FIREBASE_SERVICE_ACCOUNT_PATH  → a path to the JSON file, or
 *   - backend/config/firebase-service-account.json  (local dev fallback).
 *
 * Storage bucket: FIREBASE_STORAGE_BUCKET, defaulting to "<project_id>.appspot.com".
 *
 * When no credentials are configured everything degrades gracefully: push is a
 * no-op and getBucket() returns null (renditions fall back to the Drive original).
 *
 * NOTE: firebase-admin v14 dropped the legacy namespaced API
 * (admin.credential.cert / admin.storage() / admin.messaging() / admin.apps).
 * Everything here uses the modular subpath imports instead.
 */
const fs = require('fs');
const path = require('path');
const { initializeApp, getApps, getApp, cert } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const { getMessaging: adminGetMessaging } = require('firebase-admin/messaging');

let app = null;
let initTried = false;
let serviceAccount = null;

// Resolve the service-account credentials from env or a local file. Returns the
// parsed object, or null when nothing is configured.
function loadServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      console.error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON:', err.message);
      return null;
    }
  }
  const filePath =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.join(__dirname, '..', 'config', 'firebase-service-account.json');
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      console.error('Failed to read Firebase service account file:', err.message);
    }
  }
  return null;
}

// The storage bucket name — explicit env, else the Firebase default for the
// project. Returns null when the project id can't be resolved.
function bucketName() {
  if (process.env.FIREBASE_STORAGE_BUCKET) return process.env.FIREBASE_STORAGE_BUCKET;
  const pid = serviceAccount && serviceAccount.project_id;
  return pid ? `${pid}.appspot.com` : null;
}

// Lazily initialise the Admin SDK on first use. Cached across calls. Returns the
// app, or null when no credentials are configured.
function getFirebaseApp() {
  if (initTried) return app;
  initTried = true;
  serviceAccount = loadServiceAccount();
  if (!serviceAccount) {
    console.warn(
      'Firebase disabled: no service account configured ' +
        '(set FIREBASE_SERVICE_ACCOUNT_JSON or add backend/config/firebase-service-account.json). ' +
        'Push and LMS video renditions will be unavailable.'
    );
    return null;
  }
  try {
    app = getApps().length
      ? getApp()
      : initializeApp({
          credential: cert(serviceAccount),
          ...(bucketName() ? { storageBucket: bucketName() } : {}),
        });
    console.log('Firebase Admin initialised for project:', serviceAccount.project_id);
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    app = null;
  }
  return app;
}

// The messaging instance (used by push.js), or null when unconfigured.
function getMessaging() {
  const a = getFirebaseApp();
  return a ? adminGetMessaging(a) : null;
}

// The Cloud Storage bucket handle, or null when unconfigured / no bucket name.
function getBucket() {
  const a = getFirebaseApp();
  if (!a) return null;
  const name = bucketName();
  if (!name) {
    console.warn('Firebase Storage bucket not set (FIREBASE_STORAGE_BUCKET) and no project_id default.');
    return null;
  }
  try {
    return getStorage(a).bucket(name);
  } catch (err) {
    console.error('Failed to get Firebase Storage bucket:', err.message);
    return null;
  }
}

module.exports = { getFirebaseApp, getMessaging, getBucket };
