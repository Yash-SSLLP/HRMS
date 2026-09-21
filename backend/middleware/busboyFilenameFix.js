/**
 * Accept the multipart headers React Native actually sends.
 *
 * THE BUG. RN builds the part header itself (Libraries/Network/FormData.js) and
 * writes the filename twice:
 *
 *   content-disposition: form-data; name="file"; filename="pancard (1).pdf";
 *     filename*=utf-8''pancard%20(1).pdf
 *
 * The second is an RFC 5987 extended value, which may hold only attr-chars and
 * %XX escapes — but `encodeURI` leaves the URI sub-delimiters raw, among them
 * ( ) , ; : / ? @ = * and '. Busboy (multer's parser) then refuses the WHOLE
 * content-disposition, and a part whose disposition will not parse is skipped
 * entirely: the request still succeeds, just without the file. Every controller
 * can only answer "File is required (multipart field \"file\")" — naming the one
 * thing the person definitely did attach.
 *
 * Android produces those names constantly: a second copy of a download is saved
 * as "pancard (1).pdf", so a parenthesis was enough to make an upload from the
 * phone fail with a message that read like the app had lost the file.
 *
 * THE FIX, IN TWO PLACES. The app now sanitises the name before it ever reaches
 * a header (mobile/src/utils/filePart.js -> safeFileName). That only helps a
 * phone that has taken the update, and every APK already installed keeps sending
 * the old header — so the server meets it halfway: when busboy has ALREADY
 * given up on a disposition, retry it once with the malformed `filename*`
 * dropped. The quoted `filename="..."` beside it is well-formed and carries the
 * same name, so nothing is lost.
 *
 * Purely additive: a header busboy parses is never touched, so a working upload
 * cannot change behaviour. It patches a module internal, which is why every step
 * is guarded — if a busboy upgrade moves the file or renames the export, the
 * patch reports itself and the server runs exactly as it does today.
 *
 * ORDER MATTERS. busboy's multipart parser destructures parseDisposition at
 * require time, so this must run BEFORE anything pulls in busboy (i.e. before
 * multer). It is required at the top of server.js and of middleware/upload.js
 * for that reason; requiring it again is a no-op.
 */
let applied = false;

function applyBusboyFilenameFix() {
  if (applied) return true;
  try {
    // eslint-disable-next-line global-require, import/no-extraneous-dependencies
    const utils = require('busboy/lib/utils.js');
    const original = utils.parseDisposition;
    if (typeof original !== 'function') {
      console.warn('[upload] busboy.parseDisposition not found — RN filename fix not applied');
      return false;
    }
    if (original.__rnFilenameFix) {
      applied = true;
      return true;
    }

    // Everything from `filename*=` to the end of the header, which is where RN
    // puts it. Cutting to the end rather than to the next ';' matters: the
    // characters that break the value (';' among them) would otherwise leave a
    // fragment behind that fails to parse all over again.
    const EXTENDED_FILENAME = /;\s*filename\*\s*=.*$/i;

    function parseDispositionLenient(str, defDecoder) {
      const parsed = original(str, defDecoder);
      if (parsed !== undefined) return parsed;
      const withoutExtended = String(str || '').replace(EXTENDED_FILENAME, '');
      if (withoutExtended === str) return parsed;
      return original(withoutExtended, defDecoder);
    }
    parseDispositionLenient.__rnFilenameFix = true;
    utils.parseDisposition = parseDispositionLenient;

    // The patch is useless if busboy's multipart parser already captured the
    // original. Say so rather than leaving a silent no-op behind.
    try {
      if (require.cache[require.resolve('busboy/lib/types/multipart.js')]) {
        console.warn('[upload] busboy multipart parser was loaded before the RN filename fix — fix inactive');
      }
    } catch (_) { /* resolution is best-effort */ }

    applied = true;
    return true;
  } catch (err) {
    console.warn(`[upload] RN filename fix not applied: ${err.message}`);
    return false;
  }
}

applyBusboyFilenameFix();

module.exports = { applyBusboyFilenameFix };
