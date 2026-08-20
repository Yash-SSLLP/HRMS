/**
 * Saving a file the server streamed back.
 *
 * Every download in the app goes through the api client with a bearer header,
 * so none of them can be a plain <a href>: the token would have to travel in
 * the URL, where it lands in history, server logs and referrers. The response
 * therefore arrives as a Blob and has to be handed to the browser by hand — and
 * that dance (read Content-Disposition, mint an object URL, click it, revoke
 * it) was being copied into every page that offers a report.
 *
 * The revoke matters: an object URL pins its Blob in memory for the life of the
 * document, so a page that lets someone download twenty payslips without it
 * quietly holds twenty PDFs.
 */

/**
 * Pull the filename the server asked for out of a Content-Disposition header.
 * @param {object} res - an axios response
 * @param {string} fallback - used when the header is absent or unparseable
 * @returns {string}
 */
export function filenameFrom(res, fallback) {
  const cd = res?.headers?.['content-disposition'] || '';
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  return m ? decodeURIComponent(m[1]) : fallback;
}

/**
 * Save a blob response to disk under the name the server chose.
 * @param {object} res - an axios response fetched with `responseType: 'blob'`
 * @param {string} fallback - filename to use if the server did not name one
 * @sideEffects Triggers a browser download.
 */
export function saveBlobResponse(res, fallback) {
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFrom(res, fallback);
  a.click();
  URL.revokeObjectURL(url);
}
