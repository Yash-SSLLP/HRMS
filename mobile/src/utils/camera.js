/**
 * Photographing a paper slip, in one place.
 *
 * WHY THIS EXISTS AS A UTILITY. Every screen that takes a receipt had the same
 * six lines copied into it — ask for permission, launch the camera, downscale
 * the result — and the same two holes in them:
 *
 *   1. A REFUSED PERMISSION IS A DEAD END. Android only shows its permission
 *      dialog while `canAskAgain` is true. Once somebody has said no twice, the
 *      request returns denied INSTANTLY and nothing appears on screen — from
 *      the outside "the camera does not open", with no way back short of
 *      knowing to go and find the app's settings page. So when the system will
 *      no longer ask, we ask instead, and open Settings for them.
 *   2. A THROW WAS SWALLOWED. launchCameraAsync rejects when no camera app can
 *      be resolved, or when the hardware is held by something else. Nothing
 *      caught it, so again: a tap that visibly does nothing. Now it says which.
 *
 * Always downscales before handing the file back: a phone still is routinely
 * 4–8 MB and the upload endpoints cap at 5 MB, so the original would be
 * rejected on submit — after the user had already waited for it.
 */
import { Alert, Linking } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

import { compressImage, RECEIPT_MAX_PX } from './image';

/**
 * Ask for the camera, explaining and offering Settings when the system will not.
 * @returns {Promise<boolean>} Whether the camera may be used.
 */
async function ensureCameraPermission() {
  const current = await ImagePicker.getCameraPermissionsAsync();
  if (current.granted) return true;

  // canAskAgain false means the OS dialog will never appear again, so asking
  // would silently return denied. Send them where it can actually be changed.
  if (!current.canAskAgain) {
    Alert.alert(
      'Camera access is off',
      'The app has been blocked from using the camera, so the photo screen cannot open. '
      + 'Turn it on in Settings → Permissions → Camera.',
      [{ text: 'Not now', style: 'cancel' }, { text: 'Open settings', onPress: () => Linking.openSettings() }]
    );
    return false;
  }

  const asked = await ImagePicker.requestCameraPermissionsAsync();
  if (asked.granted) return true;

  Alert.alert(
    'Camera needed',
    'Allow camera access to photograph the bill, or attach a file you already have instead.'
  );
  return false;
}

/**
 * Open the camera and return a photographed receipt, ready for FormData.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxPx] - Longest edge to downscale to.
 * @param {string} [opts.namePrefix] - Base name for the file.
 * @returns {Promise<{uri: string, name: string, mimeType: string}|null>} Null
 *   when the shot was cancelled, refused, or could not be taken — every one of
 *   which has already been explained to the user by the time this returns.
 */
export async function captureReceipt(opts = {}) {
  const { maxPx = RECEIPT_MAX_PX, namePrefix = 'receipt' } = opts;

  if (!(await ensureCameraPermission())) return null;

  let result;
  try {
    result = await ImagePicker.launchCameraAsync({
      // Stills only. Left at the device default facing: forcing the rear camera
      // is what a receipt wants, but a tablet that has only a front one should
      // still open rather than fail.
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.9,
      allowsEditing: false,
      exif: false,
    });
  } catch (err) {
    Alert.alert(
      'The camera could not be opened',
      `${err?.message || 'Something stopped the camera from starting.'}\n\n`
      + 'Close any other app using the camera and try again, or attach a file instead.'
    );
    return null;
  }

  if (result.canceled || !result.assets?.length) return null;

  try {
    const shot = await compressImage(result.assets[0], maxPx);
    return { uri: shot.uri, name: `${namePrefix}-${Date.now()}.jpg`, mimeType: 'image/jpeg' };
  } catch {
    Alert.alert('Could not use that photo', 'Please try again, or attach a file instead.');
    return null;
  }
}

export default captureReceipt;
