/**
 * In-app APK updates, from GitHub Releases.
 *
 * The app is distributed by sideloading, not through the Play Store, so nothing
 * tells anyone a new build exists. This checks the repo's latest release, and if
 * it is newer than the installed package, downloads the APK and hands it to the
 * Android package installer.
 *
 * WHAT THIS CANNOT DO
 * -------------------
 * Install silently. Android always shows its own confirmation screen, and there
 * is no permission that changes that. "Automatic" in Settings therefore means
 * "check on its own and tell you", never "update by itself".
 *
 * The publishing half lives in scripts/publish-apk.js — the two agree on one
 * contract: the asset is named `hrms-<versionName>-<versionCode>.apk`.
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import * as Application from 'expo-application';
import * as IntentLauncher from 'expo-intent-launcher';

const REPO = Constants.expoConfig?.extra?.updateRepo || '';

/** Settings toggle: check on app open, or only when the user asks. Default on. */
export const AUTO_UPDATE_KEY = 'autoUpdateCheck';
const LAST_CHECK_KEY = 'autoUpdateLastCheck';
const AUTO_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/** Off on iOS (no sideloading) and when no repo is configured. */
export const UPDATES_SUPPORTED = Platform.OS === 'android' && !!REPO;

// The versionCode has to travel somehow: a GitHub release knows its tag and its
// assets, but nothing about Android build numbers. Encoding it in the filename
// keeps the whole check to ONE API request, which matters because unauthenticated
// GitHub allows 60 an hour per IP and an office shares one.
const ASSET_RE = /^hrms-(\d+\.\d+\.\d+)-(\d+)\.apk$/;

const CHECK_TIMEOUT_MS = 15000; // React Native's fetch has no timeout of its own

/**
 * The running package's own version.
 *
 * Read from the native package rather than from `Constants.expoConfig.version`
 * (what the Settings "App version" row shows): that is a value baked into the JS
 * bundle and can drift from the installed APK. The whole question here is
 * "is the installed APK older than the published one", so it has to come from
 * the install itself.
 *
 * @returns {{versionName: string, versionCode: number}}
 */
export function getInstalledVersion() {
  const versionName = Application.nativeApplicationVersion
    || Constants.expoConfig?.version
    || '0.0.0';
  const versionCode = parseInt(Application.nativeBuildVersion || '0', 10) || 0;
  return { versionName, versionCode };
}

/**
 * Ask GitHub for the latest release and compare it with what is installed.
 *
 * Returns a result object rather than throwing, so the screen is a switch and
 * every outcome — including "there are no releases yet" — has somewhere to go.
 *
 * @returns {Promise<{status:'available'|'up-to-date'|'rate-limited'|'offline'|'error', …}>}
 */
export async function checkForUpdate() {
  if (!UPDATES_SUPPORTED) return { status: 'up-to-date' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  let res;
  try {
    // Bare fetch, not the axios client: this must never pass through the auth
    // interceptor (a 401 from github.com would log the user out) and it targets
    // a third-party host, not our API.
    res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch (err) {
    return { status: 'offline', message: err.message };
  } finally {
    clearTimeout(timer);
  }

  // No releases published yet. A renamed or newly-private repo answers the same
  // way and cannot be told apart without a token, so log it — remoteLog.js
  // carries this to the server where it can actually be diagnosed.
  if (res.status === 404) {
    console.log(`[update] no published release at ${REPO} (or the repo is not reachable)`);
    return { status: 'up-to-date', ...getInstalledVersion() };
  }
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
    return { status: 'rate-limited', resetAt: new Date(reset || Date.now() + 3600000) };
  }
  if (!res.ok) {
    console.warn(`[update] GitHub returned ${res.status}`);
    return { status: 'error', message: `GitHub returned ${res.status}` };
  }

  let release;
  try {
    release = await res.json();
  } catch {
    return { status: 'error', message: 'Could not read the release information.' };
  }

  const asset = (release.assets || []).find((a) => ASSET_RE.test(a.name));
  if (!asset) {
    // Should be impossible — publish-apk.js uploads the asset while the release
    // is still a draft, and /releases/latest skips drafts. Kept as a backstop so
    // a hand-made release never crashes the screen.
    console.warn(`[update] release ${release.tag_name} has no APK asset`);
    return { status: 'up-to-date', ...getInstalledVersion() };
  }

  const [, versionName, code] = asset.name.match(ASSET_RE);
  const versionCode = parseInt(code, 10);
  const installed = getInstalledVersion();

  // Strictly greater. Android refuses to install a lower versionCode over a
  // higher one, so offering it would only produce a failed install.
  if (!(versionCode > installed.versionCode)) {
    return { status: 'up-to-date', ...installed };
  }

  return {
    status: 'available',
    versionName,
    versionCode,
    url: asset.browser_download_url, // redirects to the CDN; costs no API quota
    size: asset.size,
    notes: (release.body || '').trim(),
  };
}

/** Delete any previously downloaded APK except `keepUri`. Each is ~70 MB. */
export async function cleanupApks(keepUri) {
  const dir = FileSystem.cacheDirectory;
  if (!dir) return;
  const names = await FileSystem.readDirectoryAsync(dir).catch(() => []);
  await Promise.all(
    names
      .filter((n) => /^hrms-.*\.apk$/.test(n) && `${dir}${n}` !== keepUri)
      .map((n) => FileSystem.deleteAsync(`${dir}${n}`, { idempotent: true }).catch(() => {}))
  );
}

/**
 * Download the APK, reporting whole-percent progress.
 *
 * Uses createDownloadResumable rather than the downloadAsync pattern used
 * elsewhere in the app (see PayslipsScreen): downloadAsync has no progress
 * callback, and 70 MB with no feedback is indistinguishable from a hang.
 *
 * @param {Object} release result from checkForUpdate()
 * @param {(pct:number)=>void} onProgress
 * @returns {Promise<string>} file URI of the downloaded APK
 */
export async function downloadApk(release, onProgress) {
  const free = await FileSystem.getFreeDiskStorageAsync().catch(() => Number.MAX_SAFE_INTEGER);
  // Checked up front so the user is not told at 90% that it will not fit.
  if (free < release.size * 1.25) {
    const needMb = Math.ceil((release.size * 1.25 - free) / 1e6);
    const err = new Error(`Free up about ${needMb} MB and try again.`);
    err.code = 'NOSPACE';
    throw err;
  }

  await cleanupApks();

  const fileUri = `${FileSystem.cacheDirectory}hrms-${release.versionName}-${release.versionCode}.apk`;
  let lastPct = -1;
  const task = FileSystem.createDownloadResumable(release.url, fileUri, {}, (p) => {
    // Content-Length is sometimes absent behind the CDN redirect, in which case
    // totalBytesExpectedToWrite is -1 — fall back to the size GitHub reported.
    const total = p.totalBytesExpectedToWrite > 0 ? p.totalBytesExpectedToWrite : release.size;
    const pct = Math.min(99, Math.floor((p.totalBytesWritten / total) * 100));
    // The raw callback fires hundreds of times; only report when it changes.
    if (pct !== lastPct) {
      lastPct = pct;
      onProgress(pct);
    }
  });

  const out = await task.downloadAsync();
  if (!out || out.status !== 200) throw new Error('The download did not complete.');

  // Truncation is the realistic corruption mode, and the exact expected byte
  // count came back in the release JSON — so verify rather than hope. A
  // truncated APK fails at install with an unhelpful "problem parsing package".
  const info = await FileSystem.getInfoAsync(out.uri, { size: true });
  if (!info.exists || info.size !== release.size) {
    await FileSystem.deleteAsync(out.uri, { idempotent: true }).catch(() => {});
    throw new Error('The download was incomplete. Please try again.');
  }

  onProgress(100);
  return out.uri;
}

// FLAG_GRANT_READ_URI_PERMISSION. Mandatory: expo-file-system's FileProvider is
// exported="false", so without this the package installer cannot read the file
// and fails with a SecurityException.
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * Hand the downloaded APK to the Android package installer.
 * @param {string} fileUri
 * @returns {Promise<{cancelled: boolean}>}
 */
export async function installApk(fileUri) {
  const info = await FileSystem.getInfoAsync(fileUri);
  if (!info.exists) {
    const err = new Error('The downloaded file is no longer available.');
    err.code = 'GONE';
    throw err;
  }

  const contentUri = await FileSystem.getContentUriAsync(fileUri);

  try {
    // Only `data` is set, deliberately. In Android, setData() clears the type and
    // setType() clears the data — only setDataAndType() sets both — so passing
    // both here would depend on which of those the module happens to call.
    const r = await IntentLauncher.startActivityAsync('android.intent.action.INSTALL_PACKAGE', {
      data: contentUri,
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return { cancelled: r?.resultCode === IntentLauncher.ResultCode.Canceled };
  } catch (err) {
    // ACTION_INSTALL_PACKAGE is deprecated since API 29 and some OEM ROMs no
    // longer resolve it. Logged so remoteLog.js reports which path devices take.
    console.warn('[update] INSTALL_PACKAGE did not resolve, trying VIEW:', err.message);
    const r = await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
      data: contentUri,
      type: 'application/vnd.android.package-archive',
      flags: FLAG_GRANT_READ_URI_PERMISSION,
    });
    return { cancelled: r?.resultCode === IntentLauncher.ResultCode.Canceled };
  }
}

/**
 * Open the per-app "Allow from this source" screen.
 *
 * There is no way to read PackageManager.canRequestPackageInstalls() from JS, so
 * the install is attempted first and this is offered when it is refused.
 */
export async function openInstallSettings() {
  const pkg = Application.applicationId || 'com.ssllp.hrms';
  await IntentLauncher.startActivityAsync('android.settings.MANAGE_UNKNOWN_APP_SOURCES', {
    data: `package:${pkg}`,
  });
}

// ===== The automatic check =====

/** Whether the Settings toggle is on. Defaults to ON for a never-set value. */
export async function isAutoCheckEnabled() {
  try {
    return (await AsyncStorage.getItem(AUTO_UPDATE_KEY)) !== 'off';
  } catch {
    return true;
  }
}

/** @param {boolean} on */
export async function setAutoCheckEnabled(on) {
  try {
    await AsyncStorage.setItem(AUTO_UPDATE_KEY, on ? 'on' : 'off');
  } catch { /* a failed preference write must not break the screen */ }
}

// The result of the last successful background check, so the Settings screen can
// open already knowing an update is waiting instead of making the user tap to
// discover it. Module-level rather than in a store: it is a cache, not state
// anything renders from directly, and it is meant to die with the process.
let pendingUpdate = null;

/** The update found by the last automatic check, if any. */
export function getPendingUpdate() {
  return pendingUpdate;
}

/** Forget the cached update — called once it has been acted on. */
export function clearPendingUpdate() {
  pendingUpdate = null;
}

/**
 * The background check, run once on app open.
 *
 * Silent by design: it never alerts and never navigates. All it does is answer
 * "is there something newer", so the Settings entry point can show a dot. An
 * update the user did not ask for should not interrupt whatever they opened the
 * app to do.
 *
 * Rate-limited to once a day and skipped entirely when the toggle is off, which
 * also keeps a shared office IP well clear of GitHub's 60-an-hour ceiling.
 *
 * @returns {Promise<Object|null>} the available release, or null
 */
export async function autoCheckForUpdate() {
  if (!UPDATES_SUPPORTED) return null;
  if (!(await isAutoCheckEnabled())) return null;

  try {
    const last = Number(await AsyncStorage.getItem(LAST_CHECK_KEY)) || 0;
    if (Date.now() - last < AUTO_CHECK_EVERY_MS) return null;
    await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  } catch { /* if the timestamp is unreadable, just check */ }

  const result = await checkForUpdate();
  pendingUpdate = result.status === 'available' ? result : null;
  return pendingUpdate;
}
