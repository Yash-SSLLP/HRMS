/**
 * Fail the build if the JS and native version numbers disagree.
 *
 *   node scripts/checkVersionSync.js
 *
 * WHY THIS EXISTS. `app.json` drives the JS bundle's config, but the version
 * Android actually stamps into the APK comes from `android/app/build.gradle`.
 * In a prebuilt project nothing keeps the two in step — `expo prebuild` would,
 * but running it regenerates the native project and would clobber the local
 * customisations in there.
 *
 * So bumping `app.json` alone produces an APK that REPORTS the new version in
 * its own settings screen while Android still sees the old `versionCode`. The
 * in-app updater compares versionCode against the GitHub release, finds it
 * unchanged, and never offers the update — an invisible failure that only shows
 * up as "nobody is getting the new build".
 *
 * Exits non-zero on a mismatch, so it can gate a release.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');

const js = {
  version: appJson.expo.version,
  versionCode: appJson.expo.android?.versionCode,
};
const native = {
  version: (gradle.match(/versionName\s+"([^"]+)"/) || [])[1],
  versionCode: Number((gradle.match(/versionCode\s+(\d+)/) || [])[1]),
};

const problems = [];
if (js.version !== native.version) {
  problems.push(`versionName: app.json says "${js.version}", build.gradle says "${native.version}"`);
}
if (js.versionCode !== native.versionCode) {
  problems.push(`versionCode: app.json says ${js.versionCode}, build.gradle says ${native.versionCode}`);
}

if (problems.length) {
  console.error('\nVersion mismatch between app.json and android/app/build.gradle:\n');
  problems.forEach((p) => console.error(`  * ${p}`));
  console.error('\nBump BOTH. The APK stamps its version from build.gradle; app.json only');
  console.error('feeds the JS bundle, so a mismatch ships a build the updater will ignore.\n');
  process.exit(1);
}

console.log(`version ${js.version} (versionCode ${js.versionCode}) — app.json and build.gradle agree.`);
