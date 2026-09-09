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
// purpose. The bound is the LRU cap below: past it, the oldest entry is
// revoked and dropped, which keeps a long session from accumulating blobs.
// Failures are cached too (as a rejected marker) and then dropped, so a broken
// image does not re-request on every scroll.
// ---------------------------------------------------------------------------
const CACHE_MAX = 240;
const cache = new Map(); // url -> Promise<objectUrl>

function loadImage(url) {
  const hit = cache.get(url);
  if (hit) {
    // Refresh recency for the LRU.
    cache.delete(url);
    cache.set(url, hit);
    return hit;
  }
  const p = fetchImageObjectUrl(url).catch((err) => {
    cache.delete(url); // don't pin a failure forever — let a retry happen
    throw err;
  });
  cache.set(url, p);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    const dying = cache.get(oldest);
    cache.delete(oldest);
    Promise.resolve(dying).then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
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
    loadImage(url)
      .then((u) => { if (active) setSrc(u); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [url]);

  if (failed) return fallback !== undefined ? fallback : <span className={`text-xs text-gray-400 ${className}`} style={style}>n/a</span>;
  if (!src) return <span className={`inline-block bg-gray-100 animate-pulse ${className}`} style={style} />;
  return <img src={src} alt={alt} className={className} style={style} onClick={onClick} />;
}
