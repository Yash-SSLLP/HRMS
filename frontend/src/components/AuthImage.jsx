import { useEffect, useState } from 'react';
import { fetchImageObjectUrl } from '../api/download';

// Renders an image from a protected API endpoint (needs the Bearer token, which
// a plain <img src> can't send). Fetches as a blob and uses an object URL.
//
// ---------------------------------------------------------------------------
// WHY THERE IS A CACHE HERE
//
// Every mount used to fire its own request and revoke its own object URL on
// unmount, so nothing was ever reused. An employee list with photos issued one
// blob request PER ROW, the org chart one per node, the chat list one per
// conversation — and because the URL was revoked on unmount, navigating away
// and back paid for all of them again. Avatars are the most-repeated image in
// the app and the least likely to change mid-session.
//
// The cache is keyed by the full request URL. That is safe precisely BECAUSE
// the callers already bust it themselves: an avatar URL carries the stored
// photo path (`/auth/users/:id/avatar?p=<photo>`), which changes the moment a
// new photo is uploaded, so a fresh photo is a fresh key and can never be
// served from a stale entry.
//
// The map holds a PROMISE, not a URL, so N rows mounting in the same frame
// share one in-flight request instead of racing N identical ones.
//
// Nothing revokes on unmount any more — the entry outlives the component on
// purpose. The bound is the LRU cap below: past it, the oldest entry is dropped,
// and its blob is revoked UNLESS something is still displaying it (the mounted
// and orphans maps below), because revoking a blob an <img> is showing turns it
// into the browser broken-image glyph. Failures are cached too (as a rejected
// marker) and then dropped, so a broken image does not re-request on every
// scroll.
// ---------------------------------------------------------------------------
const CACHE_MAX = 240;
const cache = new Map();   // url -> Promise<objectUrl>
/**
 * How many mounted components are currently showing each URL, and the blobs
 * evicted from the cache while somebody was still looking at them.
 *
 * The cache deliberately outlives any one component — that is what stops a list
 * re-requesting every avatar on every navigation — so this is NOT a lifetime
 * owner. It answers one question: at eviction time, is anybody still looking?
 *
 * WHY IT HAS TO. Eviction takes the least recently REQUESTED entry, which says
 * nothing about whether an <img> is still pointing at it. A long table of
 * photos can push its own first rows past the cap while they are on screen, and
 * revoking a blob an <img> is displaying turns it into the browser's
 * broken-image glyph — a symptom that looks like a broken server and is not.
 * So an evicted URL with live consumers moves to `orphans` and is freed by the
 * last component to let go of it.
 */
const mounted = new Map(); // url -> count
const orphans = new Map(); // url -> Promise<objectUrl>, evicted while on screen

function free(entry) {
  Promise.resolve(entry).then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
}

function retain(url) {
  mounted.set(url, (mounted.get(url) || 0) + 1);
}

function release(url) {
  const n = (mounted.get(url) || 1) - 1;
  if (n > 0) { mounted.set(url, n); return; }
  mounted.delete(url);
  const orphan = orphans.get(url);
  if (orphan) { orphans.delete(url); free(orphan); }
}

function loadImage(url) {
  const hit = cache.get(url);
  if (hit) {
    // Refresh recency for the LRU.
    cache.delete(url);
    cache.set(url, hit);
    return hit;
  }
  // Re-adopting a blob that was evicted while still on screen: it is perfectly
  // good, and fetching it again would be a wasted round trip for bytes the
  // browser already holds.
  const readopted = orphans.get(url);
  if (readopted) {
    orphans.delete(url);
    cache.set(url, readopted);
    return readopted;
  }
  const p = fetchImageObjectUrl(url).catch((err) => {
    cache.delete(url); // don't pin a failure forever — let a retry happen
    throw err;
  });
  cache.set(url, p);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === url) break; // never evict the entry just inserted
    const dying = cache.get(oldest);
    cache.delete(oldest);
    if (mounted.get(oldest)) orphans.set(oldest, dying);
    else free(dying);
  }
  return p;
}

export default function AuthImage({ url, alt = '', className = '', style, onClick, fallback }) {
  const [src, setSrc] = useState(() => null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    setSrc(null);
    // Say we are looking at it BEFORE the request, not after it resolves: a
    // long list mounts every row in one frame, and the last of them can push
    // the first past the cache cap while its bytes are still in flight.
    retain(url);
    loadImage(url)
      .then((u) => { if (active) setSrc(u); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; release(url); };
  }, [url]);

  if (failed) return fallback !== undefined ? fallback : <span className={`text-xs text-gray-400 ${className}`} style={style}>n/a</span>;
  if (!src) return <span className={`inline-block bg-gray-100 animate-pulse ${className}`} style={style} />;
  return <img src={src} alt={alt} className={className} style={style} onClick={onClick} />;
}
