/**
 * Getting a usable GPS fix out of the device.
 *
 * WHY THIS IS NOT ONE CALL. The first position a phone returns is usually a
 * coarse network fix — the cell tower, or the wifi neighbourhood, easily a
 * kilometre out. A real GNSS fix converges over a few seconds. Taking the first
 * reading was recording misleading locations on attendance punches, so this
 * watches briefly and keeps the most accurate reading instead, resolving early
 * once the fix is good enough to stop waiting for.
 *
 * NULL IS A LEGITIMATE ANSWER. Permission refused, indoors with no sky, an
 * emulator with location switched off — every caller here (a punch, an expense)
 * is recording something that has already happened, and none of them may be
 * blocked because the satellites were unhelpful. An absent location is honest;
 * a made-up one is not.
 */
import * as Location from 'expo-location';

// GPS accuracy tuning. Shared by every caller so two screens cannot disagree
// about what "we have a fix" means.
const GPS_GOOD_ENOUGH_M = 25;   // resolve early once a fix is at least this accurate
const GPS_MAX_WAIT_MS = 12000;  // otherwise accept the best fix within this window

/**
 * The most accurate fix obtainable in a few seconds.
 * @param {{maxWaitMs?: number, goodEnoughM?: number}} [opts]
 * @returns {Promise<object|null>} expo-location coords
 *   (`{latitude, longitude, accuracy, …}`), or null when there is no fix to be
 *   had — callers carry on without it.
 */
export async function getDeviceLocation(opts = {}) {
  const maxWaitMs = opts.maxWaitMs || GPS_MAX_WAIT_MS;
  const goodEnoughM = opts.goodEnoughM || GPS_GOOD_ENOUGH_M;
  try {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return null;
    return await new Promise((resolve) => {
      let best = null;
      let sub = null;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (sub) sub.remove();
        resolve(best);
      };
      const timer = setTimeout(finish, maxWaitMs);
      Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Highest, timeInterval: 1000, distanceInterval: 0 },
        (pos) => {
          const c = pos?.coords;
          if (!c) return;
          if (!best || (c.accuracy != null && c.accuracy < best.accuracy)) best = c;
          if (best.accuracy != null && best.accuracy <= goodEnoughM) finish();
        }
      )
        .then((s) => {
          sub = s;
          if (done) s.remove(); // max-wait already elapsed before the watch started
        })
        .catch(() => finish());
    });
  } catch {
    return null;
  }
}

/**
 * The same fix as the multipart fields the backend reads
 * (`parseFiledLocation` in the khata and expense controllers).
 *
 * Returns an empty object when there is no fix, so it can be spread into a form
 * body unconditionally — the caller never has to branch, and a missing location
 * simply means the keys are not sent.
 * @param {object} [opts] - Passed through to getDeviceLocation.
 * @returns {Promise<{latitude?: string, longitude?: string, accuracy?: string}>}
 */
export async function getFiledLocationFields(opts) {
  const coords = await getDeviceLocation(opts);
  if (!coords) return {};
  return {
    latitude: String(coords.latitude),
    longitude: String(coords.longitude),
    ...(coords.accuracy != null ? { accuracy: String(Math.round(coords.accuracy)) } : {}),
  };
}

export default getDeviceLocation;
