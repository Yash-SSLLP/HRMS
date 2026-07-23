// Helpers for fetching protected binary responses through the axios `api`
// instance (so the Bearer token is attached) and turning them into browser
// downloads or object URLs for <img>/<video> elements.
import api from './client';

/**
 * Fetch a binary response from the API and trigger a browser download.
 * Uses axios with responseType='blob' so the auth interceptor still attaches the Bearer token.
 */
export async function downloadFile(url, suggestedName) {
  const res = await api.get(url, { responseType: 'blob' });

  // Try to pull filename from Content-Disposition; fall back to suggested
  const cd = res.headers['content-disposition'] || '';
  const match = /filename="?([^";]+)"?/i.exec(cd);
  const filename = match ? match[1] : suggestedName || 'download';

  const blobUrl = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Defer revoke so Safari has time to start the download
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

/**
 * Fetch a protected image (Bearer token attached by the axios interceptor) and
 * return an object URL suitable for an <img src>. Caller is responsible for
 * revoking the URL with URL.revokeObjectURL when done.
 */
export async function fetchImageObjectUrl(url) {
  const res = await api.get(url, { responseType: 'blob' });
  return URL.createObjectURL(res.data);
}
