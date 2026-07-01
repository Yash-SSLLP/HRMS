import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
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

// Ask permission, get the Expo push token, and register it with the backend.
// Returns the token string, or null if unavailable (e.g. simulator / denied).
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

    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ||
      Constants.easConfig?.projectId;

    const tokenResp = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    const token = tokenResp.data;
    cachedToken = token;

    await api.post('/devices/register', {
      token,
      platform: Platform.OS,
      deviceName: Device.deviceName || Device.modelName || undefined,
    });

    return token;
  } catch (err) {
    // Push needs Firebase/FCM configured in the build (google-services.json +
    // a real EAS projectId). When it isn't, getExpoPushTokenAsync rejects with
    // "Default FirebaseApp is not initialized". Log quietly (console.log, not
    // warn) so it doesn't pop a LogBox warning in dev, and carry on — the rest
    // of the app is unaffected; only push notifications are unavailable.
    console.log('Push registration skipped (notifications not configured):', err?.message);
    return null;
  }
}

// Tell the backend to stop pushing to this device (called on logout).
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

// Clear the app icon badge counter.
export async function clearBadge() {
  try {
    await Notifications.setBadgeCountAsync(0);
  } catch {
    /* ignore */
  }
}
