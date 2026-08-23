/**
 * A one-shot browser location fix, in the shape the API expects.
 *
 * BEST-EFFORT, ALWAYS. Every caller here is recording something that has
 * already happened — money already spent, a claim already incurred — and none
 * of them may be blocked because the browser refused, the laptop has no GPS, or
 * the fix took too long. So this never rejects: no location simply means the
 * fields are absent, which is an honest answer and the one the server is written
 * to accept.
 *
 * `enableHighAccuracy` is on because a desktop's default IP-derived guess can be
 * tens of kilometres out, and a location that vague is worse than none — it
 * looks precise on a map and means nothing. The accuracy figure travels with the
 * reading for the same reason.
 */

/** How long to wait before giving up and filing without a location. */
const FIX_TIMEOUT_MS = 8000;

/**
 * @returns {Promise<{latitude: string, longitude: string, accuracy?: string}|{}>}
 *   Empty when there is no fix to be had — spread it into a FormData/body
 *   unconditionally and the caller never has to branch.
 */
export function getFiledLocationFields() {
  if (!navigator.geolocation) return Promise.resolve({});
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    // A belt-and-braces timer: some browsers are slow to honour the timeout
    // option, and a submit button must not hang on one.
    const timer = setTimeout(() => done({}), FIX_TIMEOUT_MS + 1000);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        const c = pos?.coords;
        if (!c || c.latitude == null) { done({}); return; }
        done({
          latitude: String(c.latitude),
          longitude: String(c.longitude),
          ...(c.accuracy != null ? { accuracy: String(Math.round(c.accuracy)) } : {}),
        });
      },
      () => { clearTimeout(timer); done({}); },
      { enableHighAccuracy: true, timeout: FIX_TIMEOUT_MS, maximumAge: 60000 }
    );
  });
}

export default getFiledLocationFields;
