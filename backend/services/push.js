/**
 * Push delivery via Firebase Cloud Messaging (FCM HTTP v1).
 *
 * The mobile app registers its native FCM device token (expo-notifications'
 * getDevicePushTokenAsync) with POST /api/devices/register. Here we send
 * directly to FCM using the Firebase Admin SDK — no Expo push relay involved.
 *
 * Credentials: a Firebase service-account key, provided as either
 *   - FIREBASE_SERVICE_ACCOUNT_JSON  → the whole JSON as a string (best for Railway), or
 *   - FIREBASE_SERVICE_ACCOUNT_PATH  → a path to the JSON file, or
 *   - backend/config/firebase-service-account.json  (local dev fallback).
 *
 * When no credentials are configured, push is a no-op (the rest of the app is
 * unaffected — in-app notifications still work). Dead/unregistered tokens are
 * pruned so we stop pushing to uninstalled apps.
 */
const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const DeviceToken = require('../models/DeviceToken');

let messaging = null;
let initTried = false;

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

// Lazily initialise the Admin SDK on first push. Cached across calls.
function getMessaging() {
  if (initTried) return messaging;
  initTried = true;
  const creds = loadServiceAccount();
  if (!creds) {
    console.warn(
      'Push disabled: no Firebase service account configured ' +
        '(set FIREBASE_SERVICE_ACCOUNT_JSON or add backend/config/firebase-service-account.json).'
    );
    return null;
  }
  try {
    const app = admin.apps.length
      ? admin.app()
      : admin.initializeApp({ credential: admin.credential.cert(creds) });
    messaging = admin.messaging(app);
    console.log('FCM push initialised for project:', creds.project_id);
  } catch (err) {
    console.error('Firebase Admin init failed:', err.message);
    messaging = null;
  }
  return messaging;
}

// FCM allows up to 500 tokens per multicast.
function chunk(arr, size = 500) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// FCM data payload values must all be strings.
function stringifyData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) out[k] = v == null ? '' : String(v);
  return out;
}

const DEAD_TOKEN_ERRORS = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Push to an explicit list of FCM device tokens. Sends in multicast batches of
 * up to 500; tokens FCM reports as dead/unregistered are pruned from DeviceToken.
 * @param {string[]} tokens
 * @param {{title:string, body?:string, data?:object, badge?:number}} payload
 * @returns {Promise<{sent:number}>} Count of successful per-device sends.
 * @sideEffects Network call to FCM; deletes dead tokens from the DeviceToken collection.
 */
async function pushToTokens(tokens, { title, body, data, badge } = {}) {
  const m = getMessaging();
  const valid = [...new Set((tokens || []).filter(Boolean))];
  if (!m || !valid.length) return { sent: 0 };

  const base = {
    notification: { title, body: body || '' },
    data: stringifyData(data),
    android: {
      priority: 'high',
      notification: { channelId: 'default', sound: 'default', defaultSound: true },
    },
    apns: {
      payload: { aps: { sound: 'default', ...(typeof badge === 'number' ? { badge } : {}) } },
    },
  };

  let sent = 0;
  const dead = [];

  for (const batch of chunk(valid)) {
    try {
      const resp = await m.sendEachForMulticast({ tokens: batch, ...base });
      resp.responses.forEach((r, i) => {
        if (r.success) {
          sent += 1;
        } else if (r.error && DEAD_TOKEN_ERRORS.has(r.error.code)) {
          dead.push(batch[i]);
        } else if (r.error) {
          console.error('FCM send error:', r.error.code, r.error.message);
        }
      });
    } catch (err) {
      console.error('FCM batch failed:', err.message);
    }
  }

  if (dead.length) {
    try {
      await DeviceToken.deleteMany({ token: { $in: dead } });
    } catch {
      /* best effort */
    }
  }

  return { sent };
}

/**
 * Push to every device registered to the given user id(s).
 * @param {string|string[]} userIds
 * @param {{title:string, body?:string, data?:object, badge?:number}} payload
 * @returns {Promise<{sent:number}>} Count of successful per-device sends.
 * @sideEffects Reads DeviceToken; delegates to pushToTokens (FCM call + dead-token cleanup).
 */
async function pushToUsers(userIds, payload) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length) return { sent: 0 };
  const devices = await DeviceToken.find({ user: { $in: ids } }).select('token').lean();
  return pushToTokens(devices.map((d) => d.token), payload);
}

module.exports = { pushToTokens, pushToUsers };
