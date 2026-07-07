/**
 * Cloudinary storage + delivery for LMS course videos.
 *
 * Videos are uploaded straight from the admin's browser to Cloudinary via a
 * SIGNED upload (the backend never buffers the file — it only mints a short
 * signature), stored as `authenticated` delivery type, and played back through
 * a SIGNED delivery URL that the stream endpoint 302-redirects to. So playback
 * bandwidth + transcoding are handled by Cloudinary, and the raw asset can only
 * be reached with a signature our backend produces after an access check.
 *
 * Degrades gracefully when the CLOUDINARY_* env vars are absent: enabled()
 * returns false and the LMS keeps working with Google Drive links only.
 *
 * Required env:
 *   CLOUDINARY_CLOUD_NAME   the cloud name (e.g. jhu4nxbl)
 *   CLOUDINARY_API_KEY      API key
 *   CLOUDINARY_API_SECRET   API secret
 *   CLOUDINARY_FOLDER       optional, defaults to 'hrms-lms'
 */
const cloudinary = require('cloudinary').v2;

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const API_KEY = process.env.CLOUDINARY_API_KEY;
const API_SECRET = process.env.CLOUDINARY_API_SECRET;
const FOLDER = process.env.CLOUDINARY_FOLDER || 'hrms-lms';

let configured = false;

function enabled() {
  return Boolean(CLOUD_NAME && API_KEY && API_SECRET);
}

function ensure() {
  if (!enabled()) throw new Error('Cloudinary is not configured (set the CLOUDINARY_* environment variables).');
  if (!configured) {
    cloudinary.config({ cloud_name: CLOUD_NAME, api_key: API_KEY, api_secret: API_SECRET, secure: true });
    configured = true;
  }
}

/**
 * Everything the browser needs for a signed, authenticated direct upload.
 * The browser POSTs multipart { file, api_key, timestamp, signature, folder,
 * type } to uploadUrl — the non-file fields it sends MUST exactly match the
 * signed set below, or Cloudinary rejects with 401.
 */
function signUpload() {
  ensure();
  const timestamp = Math.round(Date.now() / 1000);
  // Only these params are part of the signature (file/api_key/resource_type/
  // cloud_name are never signed). 'authenticated' makes the asset private.
  const signed = { folder: FOLDER, timestamp, type: 'authenticated' };
  const signature = cloudinary.utils.api_sign_request(signed, API_SECRET);
  return {
    cloudName: CLOUD_NAME,
    apiKey: API_KEY,
    uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/video/upload`,
    ...signed,
    signature,
  };
}

/** Signed private delivery URL for a stored video module. */
function deliveryUrl(module) {
  ensure();
  return cloudinary.url(module.cloudinaryPublicId, {
    resource_type: module.cloudinaryResourceType || 'video',
    type: 'authenticated',
    version: module.cloudinaryVersion || undefined,
    format: module.cloudinaryFormat || undefined,
    sign_url: true,
    secure: true,
  });
}

/** Best-effort delete of a stored asset (ignores missing / errors). */
async function destroy(publicId, resourceType = 'video') {
  if (!enabled() || !publicId) return;
  try {
    ensure();
    await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      type: 'authenticated',
      invalidate: true,
    });
  } catch {
    /* best-effort — orphan cleanup */
  }
}

module.exports = { enabled, signUpload, deliveryUrl, destroy };
