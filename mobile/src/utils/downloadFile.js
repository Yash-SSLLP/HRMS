/**
 * Fetching a file the API streams back, and handing it to the OS.
 *
 * Every document route sits behind `protect`, so none of them can be opened with
 * a plain `Linking.openURL` — there is nowhere to put the bearer header, and
 * putting the token in the query string would leave it in logs and in whatever
 * the share sheet passes on. `FileSystem.downloadAsync` is the one call that
 * writes straight to disk WITH headers, which is why every download in the app
 * goes through it.
 *
 * The trap this exists to close: `downloadAsync` treats an HTTP error as a
 * successful download and writes the ERROR BODY to the file. Skip the status
 * check and the user cheerfully shares a .pdf containing
 * `{"message":"Not allowed"}`. So the status is checked here, once, rather than
 * being remembered at every call site.
 */
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Download an authenticated file and open the share sheet on it.
 *
 * @param {Object} opts
 * @param {string} opts.url - absolute URL, e.g. `${API_BASE}/khata/me/statement.pdf`
 * @param {string} opts.token - bearer token
 * @param {string} opts.fileName - what it is saved and shared as
 * @param {string} opts.mimeType
 * @param {string} [opts.dialogTitle]
 * @param {string} [opts.UTI] - iOS type, e.g. 'com.adobe.pdf'
 * @param {Object<number, string>} [opts.errors] - per-status messages, e.g. { 403: '…' }
 * @returns {Promise<{uri: string, shared: boolean}>} where `shared` is false when
 *   the OS offered no share sheet — the file is still on disk, so the caller can
 *   say so rather than leaving the tap looking like it did nothing.
 * @throws {Error} with a readable message on any non-200
 * @sideEffects Writes to the app cache and opens the OS share sheet.
 */
export async function downloadAndShare({
  url, token, fileName, mimeType, dialogTitle, UTI, errors = {},
}) {
  const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
  const res = await FileSystem.downloadAsync(url, fileUri, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    // Delete first: a file of JSON left in the cache under a .pdf name will be
    // picked up by the next share attempt if the retry happens to hit a 200
    // race, and it is dead weight either way.
    await FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
    throw new Error(errors[res.status] || `That file is not available (${res.status}).`);
  }
  const shared = await Sharing.isAvailableAsync();
  if (shared) {
    await Sharing.shareAsync(res.uri, { mimeType, dialogTitle: dialogTitle || fileName, UTI });
  }
  return { uri: res.uri, shared };
}
