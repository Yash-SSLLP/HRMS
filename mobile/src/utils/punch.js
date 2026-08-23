/**
 * Shared attendance-punch plumbing: the GPS fix, the multipart submit, and the
 * recovery path for a punch that Android interrupted.
 *
 * Why the recovery path exists: `launchCameraAsync` hands control to the phone's
 * camera app, which is memory hungry. Android is free to destroy our MainActivity
 * while it is in the foreground (guaranteed with the "Don't keep activities"
 * developer option, and common on low-memory devices). When the camera returns,
 * the app is COLD STARTED — the screen the user punched from is gone, the promise
 * awaiting the photo never resolves, and the punch is silently lost. That is
 * exactly what "it took the photo, the app reloaded, and nothing was recorded"
 * looks like; the website never sees it because a browser tab isn't evicted this
 * way. expo-image-picker keeps the captured photo for that case and returns it
 * from `getPendingResultAsync()` on the next launch, so we stash what the punch
 * was FOR (check-in vs check-out, WFH, half day) before opening the camera and
 * finish the job on relaunch.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';

import api from '../api/client';
import { compressImage, SELFIE_MAX_PX } from './image';
import { getDeviceLocation } from './geo';

const PENDING_KEY = 'pendingPunch';

// A recovered punch is only submitted if the camera round-trip was recent. A
// phone that was killed and not reopened until the evening must not silently
// record a morning check-in hours after the fact.
const PENDING_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Accurate GPS fix for a punch. Watches for a few seconds and keeps the most
 * accurate fix, resolving early once it is good enough.
 *
 * The implementation moved to utils/geo.js when expense filing started needing
 * the same fix, and the same accuracy tuning with it: two copies of "how long do
 * we wait for GPS" is how two screens end up recording locations of different
 * quality and nobody knowing which to trust. Kept exported under this name
 * because every attendance caller already asks for it.
 * @returns {Promise<object|null>} Coords, or null if permission is denied or no
 *   fix arrives — the punch still proceeds without coordinates.
 */
export const getPunchLocation = getDeviceLocation;

/**
 * Record what the punch about to be taken is for, so it can be completed if
 * Android destroys the app while the camera is open. Awaited before the camera
 * launches — after that call there may be no JS runtime left to write it.
 * @param {{which: 'checkin'|'checkout', wfh: boolean, halfDay: boolean}} intent
 */
export async function markPunchPending(intent) {
  try {
    await AsyncStorage.setItem(PENDING_KEY, JSON.stringify({ ...intent, at: Date.now() }));
  } catch {
    // Losing the marker only costs us the recovery path, not the punch itself.
  }
}

/** Drop the pending-punch marker once the punch is resolved (submitted or cancelled). */
export async function clearPunchPending() {
  try {
    await AsyncStorage.removeItem(PENDING_KEY);
  } catch {
    // Ignored: a stale marker expires on its own after PENDING_MAX_AGE_MS.
  }
}

/**
 * Upload a punch. The selfie is downscaled first — a front-camera still is
 * several megapixels, and the full frame is both slow to upload on mobile data
 * and far larger than any screen that shows it.
 * @param {{which: 'checkin'|'checkout', asset: object, wfh?: boolean, halfDay?: boolean, coords?: object|null}} p
 * @returns {Promise<object>} The server's response body.
 */
export async function submitPunch({ which, asset, wfh, halfDay, coords }) {
  const shot = await compressImage(asset, SELFIE_MAX_PX);
  const form = new FormData();
  form.append('photo', { uri: shot.uri, name: 'punch.jpg', type: 'image/jpeg' });
  form.append('wfh', wfh ? 'true' : 'false');
  // Declared at check-in it stands for the whole day; declared at check-out
  // it overrides the hours rule. Either way the server decides, not us.
  form.append('halfDay', halfDay ? 'true' : 'false');
  if (coords) {
    form.append('latitude', String(coords.latitude));
    form.append('longitude', String(coords.longitude));
    if (coords.accuracy != null) form.append('accuracy', String(coords.accuracy));
  }
  const { data } = await api.post(`/attendance/me/${which}`, form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data || {};
}

/**
 * Finish a punch that was interrupted by the app being destroyed behind the
 * camera. Call once per launch, after the session is restored. Drains the
 * pending camera result either way, so a photo from an abandoned attempt is not
 * left to surface against some later punch.
 *
 * The marker is cleared before the upload: one recovery attempt only, so a
 * failure can never leave the app re-punching on every launch.
 *
 * @returns {Promise<{which: string, data: object}|null>} What was submitted, or
 *   null if there was nothing to recover. Throws only if the upload itself failed.
 */
export async function resumeInterruptedPunch() {
  let pending = [];
  try {
    pending = (await ImagePicker.getPendingResultAsync()) || [];
  } catch {
    return null; // iOS / web, or nothing was stashed
  }
  const shot = pending.find((r) => r && !r.canceled && r.assets?.length);

  let raw = null;
  try {
    raw = await AsyncStorage.getItem(PENDING_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  await clearPunchPending();
  if (!shot) return null;

  let intent = null;
  try {
    intent = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!intent?.which) return null;
  if (Date.now() - (intent.at || 0) > PENDING_MAX_AGE_MS) return null;

  const coords = await getPunchLocation();
  const data = await submitPunch({
    which: intent.which,
    asset: shot.assets[0],
    wfh: intent.wfh,
    halfDay: intent.halfDay,
    coords,
  });
  return { which: intent.which, data };
}
