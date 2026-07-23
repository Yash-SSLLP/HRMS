// services/push.js — push-notification setup for the app.
// Configures the foreground notification handler and the Android channel, asks
// for permission, obtains the native FCM/APNs device token, and registers it
// with the backend (delivery goes through Firebase Cloud Messaging). Also
// handles unregister-on-logout and clearing the app-icon badge.
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import api from '../api/client';

// Foreground behaviour: still show the banner + play sound while the app is open.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

let cachedToken = null;

// Create the Android notification channel once. High importance = heads-up
// banner + sound, which is what we want for chat/event/holiday alerts.
async function ensureAndroidChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'General',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#4f46e5',
    sound: 'default',
  });
}

/**
 * Ask permission, get the native FCM/APNs device token, and register it with
 * the backend (which sends via Firebase Admin / FCM).
 * @returns {Promise<string|null>} The token, or null if unavailable
 *   (simulator, permission denied, or FCM not configured in the build).
 */
export async function registerForPush() {
  try {
    await ensureAndroidChannel();

    if (!Device.isDevice) {
      // Push tokens only work on a physical device.
      return null;
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (existing !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') return null;

    // Native FCM (Android) / APNs (iOS) device token — sent to our backend
    // which delivers through Firebase Cloud Messaging directly.
    const tokenResp = await Notifications.getDevicePushTokenAsync();
    const token = tokenResp.data;
    if (!token) return null;
    cachedToken = token;

    await api.post('/devices/register', {
      token,
      platform: Platform.OS,
      deviceName: Device.deviceName || Device.modelName || undefined,
    });

    return token;
  } catch (err) {
    // Push needs Firebase/FCM configured in the build (google-services.json).
    // When it isn't, getDevicePushTokenAsync rejects with "Default FirebaseApp
    // is not initialized". Log quietly (console.log, not warn) so it doesn't pop
    // a LogBox warning in dev, and carry on — the rest of the app is unaffected;
    // only push notifications are unavailable.
    console.log('Push registration skipped (notifications not configured):', err?.message);
    return null;
  }
}

/**
 * Tell the backend to stop pushing to this device (called on logout).
 * Best-effort; no-op when no token was registered this session.
 * @returns {Promise<void>}
 */
export async function unregisterPush() {
  if (!cachedToken) return;
  try {
    await api.delete(`/devices/${encodeURIComponent(cachedToken)}`);
  } catch {
    /* best effort */
  } finally {
    cachedToken = null;
  }
}

/**
 * Clear the app-icon badge counter.
 * @returns {Promise<void>}
 */
export async function clearBadge() {
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {
    /* ignore */
  }
}
