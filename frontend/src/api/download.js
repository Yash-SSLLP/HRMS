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
 * Fetch a protected PDF and open it in a new tab, where it can be read, printed
 * or saved. Bearer token attached by the axios interceptor, as everywhere.
 *
 * A refusal comes back as a Blob too (responseType is fixed before the status
 * is known), so the server's JSON message is read back out of it — that is the
 * sentence worth showing, not "Request failed with status code 404".
 * @param {string} url - API path, e.g. `/loans/me/<id>/form.pdf`
 * @param {string} [fallbackMessage] - shown when the server said nothing useful
 * @throws {Error} carrying the server's message
 */
export async function openProtectedPdf(url, fallbackMessage = 'Could not open the PDF') {
  let res;
  try {
    res = await api.get(url, { responseType: 'blob' });
  } catch (err) {
    let msg = fallbackMessage;
    try {
      const text = err.response?.data instanceof Blob ? await err.response.data.text() : null;
      if (text) msg = JSON.parse(text).message || msg;
    } catch { /* keep the fallback */ }
    throw new Error(msg);
  }
  const blobUrl = URL.createObjectURL(res.data);
  window.open(blobUrl, '_blank', 'noopener');
  // Long enough for the new tab to have read it; the Blob is not held for the
  // life of the page after that.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}

/**
 * Convert an already-loaded table into a real .xlsx via the backend and trigger
 * a download. Keeps the column layout on the client while producing a genuine
 * Excel file (no spreadsheet library in the browser bundle).
 * @param {object} table
 * @param {string} table.filename  base name (no extension)
 * @param {string} [table.sheetName]
 * @param {string[]} table.headers  column headers
 * @param {Array[]} table.rows      row cells aligned to headers
 * @param {number[]} [table.moneyCols]  column indexes to format as numbers
 * @param {Array} [table.totals]    optional bold totals row
 */
export async function downloadTableXlsx({ filename, sheetName, headers, rows, moneyCols, totals }) {
  const res = await api.post(
    '/reports/xlsx',
    { filename, sheetName, headers, rows, moneyCols, totals },
    { responseType: 'blob' },
  );
  const cd = res.headers['content-disposition'] || '';
  const match = /filename="?([^";]+)"?/i.exec(cd);
  const name = match ? match[1] : `${filename || 'export'}.xlsx`;
  const blobUrl = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

/**
 * Fetch a protected image (Bearer token attached by the axios interceptor) and
 * return an object URL suitable for an <img src>. Caller is responsible for
 * revoking the URL with URL.revokeObjectURL when done.
 */
export async function fetchImageObjectUrl(url) {
  const res = await api.get(url, { responseType: 'blob' });
  const blob = res.data;
  // WHAT CAME BACK HAS TO BE AN IMAGE, and until now nothing checked. A 2xx
  // carrying anything else — a JSON error body a proxy turned into a 200, an
  // empty response, an HTML login page from an expired session — was wrapped in
  // an object URL all the same, the <img> could not decode it, and the page
  // showed the browser's broken-image glyph with the alt text beside it. A
  // broken glyph tells the reader nothing and the developer less; rejecting
  // here routes it to AuthImage's honest "n/a" fallback instead, and lets the
  // next mount retry rather than caching the failure as a picture.
  if (!(blob instanceof Blob) || blob.size === 0 || !/^image\//i.test(blob.type || '')) {
    const err = new Error(`Not an image (${blob?.type || 'no type'}, ${blob?.size ?? 0} bytes)`);
    err.notAnImage = true;
    throw err;
  }
  return URL.createObjectURL(blob);
}
