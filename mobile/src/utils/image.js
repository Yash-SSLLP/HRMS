/**
 * Client-side image downscaling for uploads.
 *
 * Phone cameras produce 8–12 MP JPEGs (3–8 MB). Nothing in the app displays a
 * profile photo larger than ~96 px, so shipping the original wastes the user's
 * data, the request timeout, and — now that files live in MongoDB — permanent
 * storage in the cluster. Resizing on the device costs a few hundred ms and
 * turns a multi-megabyte upload into tens of kilobytes.
 *
 * Only ever shrinks: an image already smaller than the cap is passed through at
 * its own size, so a small photo is never upscaled into a blurry, bigger file.
 */
import * as ImageManipulator from 'expo-image-manipulator';

/** Longest edge (px) for a profile photo — displayed at 92 px at most. */
export const AVATAR_MAX_PX = 512;
/** Longest edge (px) for the 16:9 profile banner, which spans the screen. */
export const BANNER_MAX_PX = 1280;

/**
 * Longest edge (px) for a photographed receipt/document. Much larger than an
 * avatar because the whole point of the image is that an approver can READ it
 * — amount, date, merchant — so it is sized to stay legible full-screen while
 * landing well inside the 5 MB upload cap. Keep in step with the web copy in
 * frontend/src/utils/image.js.
 */
export const RECEIPT_MAX_PX = 1600;

/**
 * Longest edge (px) for an attendance punch selfie. Only ever viewed to confirm
 * who punched — in the record list and on the punch map — so a full 8–12 MP
 * front-camera frame buys nothing and costs an upload the employee is standing
 * at the gate waiting for.
 */
export const SELFIE_MAX_PX = 1080;

/**
 * Downscale + re-encode a picked image as JPEG.
 * @param {{uri: string, width?: number, height?: number}} asset - An
 *   expo-image-picker asset (its width/height decide whether a resize is needed).
 * @param {number} maxPx - Cap for the longest edge.
 * @param {number} [quality] - JPEG quality, 0..1.
 * @returns {Promise<{uri: string, width: number, height: number}>} The
 *   manipulated image; safe to hand straight to FormData.
 */
export async function compressImage(asset, maxPx, quality = 0.8) {
  const { uri, width, height } = asset || {};
  if (!uri) throw new Error('No image to upload');

  const longest = Math.max(width || 0, height || 0);
  // Resize by the LONGEST edge so tall portraits shrink too; expo-image-manipulator
  // keeps the aspect ratio when only one dimension is given.
  const actions = longest > maxPx
    ? [(width || 0) >= (height || 0) ? { resize: { width: maxPx } } : { resize: { height: maxPx } }]
    : [];

  return ImageManipulator.manipulateAsync(uri, actions, {
    compress: quality,
    format: ImageManipulator.SaveFormat.JPEG,
  });
}
