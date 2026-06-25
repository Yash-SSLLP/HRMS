/**
 * Expo push delivery.
 *
 * The mobile app is an Expo build, so we send through Expo's push service
 * (https://exp.host/--/api/v2/push/send) rather than talking to FCM directly.
 * Expo holds the FCM server credentials (configured via EAS) and fans messages
 * out to Android (FCM) / iOS (APNs) for us.
 *
 * Node 18+ ships a global `fetch`, so this has zero extra dependencies.
 *
 * On an "DeviceNotRegistered" receipt we prune the dead token so we stop
 * pushing to uninstalled apps.
 */
const DeviceToken = require('../models/DeviceToken');

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_TOKEN_RE = /^ExponentPushToken\[.+\]$|^ExpoPushToken\[.+\]$/;

// Expo accepts at most 100 messages per request.
function chunk(arr, size = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Push to an explicit list of Expo tokens.
 * @param {string[]} tokens
 * @param {{title:string, body?:string, data?:object, badge?:number}} payload
 */
async function pushToTokens(tokens, { title, body, data, badge } = {}) {
  const valid = [...new Set((tokens || []).filter((t) => EXPO_TOKEN_RE.test(t)))];
  if (!valid.length) return { sent: 0 };

  const messages = valid.map((to) => ({
    to,
    title,
    body: body || '',
    data: data || {},
    sound: 'default',
    priority: 'high',
    channelId: 'default',
    ...(typeof badge === 'number' ? { badge } : {}),
  }));

  let sent = 0;
  const dead = [];

  for (const batch of chunk(messages)) {
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch),
      });
      const json = await res.json().catch(() => ({}));
      const tickets = Array.isArray(json?.data) ? json.data : [];
      tickets.forEach((ticket, i) => {
        if (ticket?.status === 'ok') {
          sent += 1;
        } else if (ticket?.details?.error === 'DeviceNotRegistered') {
          dead.push(batch[i].to);
        }
      });
    } catch (err) {
      console.error('Expo push batch failed:', err.message);
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
