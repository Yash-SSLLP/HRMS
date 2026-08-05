/**
 * Client-side image downscaling for uploads (browser counterpart of
 * mobile/src/utils/image.js — keep the two caps in step).
 *
 * A phone or DSLR photo picked from disk is routinely 3–8 MB, while nothing in
 * the app renders a profile photo above ~96 px. Sending the original burns the
 * user's upload bandwidth and — now that files live in MongoDB — permanent
 * space in the cluster. Drawing it once to a canvas turns megabytes into tens
 * of kilobytes before the request is even made.
 *
 * Only ever shrinks: an image already within the cap keeps its own dimensions,
 * so a small photo is never upscaled into a blurrier, larger file.
 */

/** Longest edge (px) for a profile photo. */
export const AVATAR_MAX_PX = 512;

/**
 * Downscale + re-encode an image File as JPEG.
 * @param {File} file - The picked file.
 * @param {number} [maxPx] - Cap for the longest edge.
 * @param {number} [quality] - JPEG quality, 0..1.
 * @returns {Promise<File>} The compressed file, or the ORIGINAL file when it is
 *   not a raster image, cannot be decoded, or compression made it no smaller.
 */
export async function compressImage(file, maxPx = AVATAR_MAX_PX, quality = 0.82) {
  // Anything the canvas can't decode (SVG, HEIC on some browsers, a corrupt
  // file) must pass through untouched rather than fail the upload.
  if (!file || !file.type?.startsWith('image/') || file.type === 'image/svg+xml') return file;

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file;
  }

  const longest = Math.max(bitmap.width, bitmap.height);
  const scale = longest > maxPx ? maxPx / longest : 1;
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob || blob.size >= file.size) return file; // already smaller than we'd make it

  const name = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return new File([blob], `${name}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
}
