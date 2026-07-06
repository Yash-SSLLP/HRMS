/**
 * Push delivery via Firebase Cloud Messaging (FCM HTTP v1).
 *
 * The mobile app registers its native FCM device token (expo-notifications'
 * getDevicePushTokenAsync) with POST /api/devices/register. Here we send
 * directly to FCM using the Firebase Admin SDK — no Expo push relay involved.
 *
 * Credentials come from the shared services/firebase.js app (FIREBASE_SERVICE_ACCOUNT_JSON
 * / FIREBASE_SERVICE_ACCOUNT_PATH / backend/config/firebase-service-account.json).
 *
 * When no credentials are configured, push is a no-op (the rest of the app is
 * unaffected — in-app notifications still work). Dead/unregistered tokens are
 * pruned so we stop pushing to uninstalled apps.
 */
const DeviceToken = require('../models/DeviceToken');
const { getMessaging } = require('./firebase');

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
 * Push to an explicit list of FCM device tokens.
 * @param {string[]} tokens
 * @param {{title:string, body?:string, data?:object, badge?:number}} payload
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
 */
async function pushToUsers(userIds, payload) {
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  if (!ids.length) return { sent: 0 };
  const devices = await DeviceToken.find({ user: { $in: ids } }).select('token').lean();
  return pushToTokens(devices.map((d) => d.token), payload);
}

module.exports = { pushToTokens, pushToUsers };
