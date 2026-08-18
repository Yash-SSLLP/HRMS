/**
 * Publish a built release APK to GitHub Releases, where the in-app updater
 * will find it.
 *
 *   node scripts/publish-apk.js            # dry run — says exactly what it would do
 *   node scripts/publish-apk.js --publish  # actually create the release
 *
 * THE CONTRACT WITH THE UPDATER (src/services/appUpdate.js).
 * The app makes ONE call to /releases/latest and reads the version straight out
 * of the asset filename, because a GitHub release knows its tag and its assets
 * but nothing about Android build numbers:
 *
 *     hrms-<versionName>-<versionCode>.apk      e.g. hrms-1.13.1-29.apk
 *
 * That filename is load-bearing. The release must also be neither a draft nor a
 * pre-release, since /releases/latest skips both.
 *
 * WHY THE CHECKS BELOW EXIST. Every one of them is a way a release has actually
 * gone wrong, or could go wrong silently — which is the dangerous kind, because
 * a bad release does not error, it just quietly never reaches anybody:
 *
 *   - The version lives in TWO files and nothing keeps them in step, so an APK
 *     can report a new version while Android still sees the old versionCode.
 *     The updater compares versionCode, finds it unchanged, and offers nothing.
 *   - The APK on disk may predate your last edit, so you ship yesterday's code
 *     under today's version number.
 *   - The baked config inside the APK may point at a dead backend.
 *
 * Dry run by default, matching backend/scripts/migrateMultiKhata.js — nothing
 * reaches GitHub until you ask for it in as many words.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PUBLISH = process.argv.includes('--publish');
const root = path.join(__dirname, '..');
const OUT_DIR = path.join(root, 'android/app/build/outputs/apk/release');
const BUILT_APK = path.join(OUT_DIR, 'app-release.apk');

const problems = [];
const fail = (msg) => problems.push(msg);
const ok = (msg) => console.log(`  ok    ${msg}`);
const note = (msg) => console.log(`        ${msg}`);

/** Run a command and return stdout, or null if it failed. */
function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
}

/**
 * Read one file out of a zip without a dependency.
 *
 * `tar` reads zips on Windows 10+, macOS and Linux alike; `unzip` covers the
 * rest. If neither is present the caller degrades to a warning rather than
 * blocking the release over a check it cannot perform.
 * @param {string} archive - Path to the .apk.
 * @param {string} entry - Path inside it.
 * @returns {string|null}
 */
function readFromApk(archive, entry) {
  return run('tar', ['-xOf', archive, entry]) || run('unzip', ['-p', archive, entry]);
}

/** Newest mtime under a directory, so a stale build can be spotted. */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const item of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, item.name);
      if (item.isDirectory()) walk(full);
      else newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

console.log(`\n${PUBLISH ? 'Publishing' : 'DRY RUN — nothing will be published'}\n`);

// ---- 1. The version the release will claim ---------------------------------
const appJson = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
const version = appJson.expo.version;
const versionCode = appJson.expo.android?.versionCode;
const tag = `v${version}`;
const assetName = `hrms-${version}-${versionCode}.apk`;
const assetPath = path.join(OUT_DIR, assetName);

console.log(`Release ${tag}  ·  asset ${assetName}\n`);

// ---- 2. app.json and build.gradle must agree -------------------------------
const gradle = fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf8');
const gradleName = (gradle.match(/versionName\s+"([^"]+)"/) || [])[1];
const gradleCode = Number((gradle.match(/versionCode\s+(\d+)/) || [])[1]);
if (gradleName !== version || gradleCode !== versionCode) {
  fail(`app.json says ${version}/${versionCode} but build.gradle says ${gradleName}/${gradleCode}. `
    + 'Bump both — run `npm run check:version`.');
} else {
  ok(`app.json and build.gradle agree on ${version} / ${versionCode}`);
}

// ---- 3. The APK exists -----------------------------------------------------
if (!fs.existsSync(BUILT_APK)) {
  fail(`No APK at ${path.relative(root, BUILT_APK)}. Build it first:\n`
    + '          cd android && ./gradlew assembleRelease');
} else {
  const apkStat = fs.statSync(BUILT_APK);
  ok(`APK found (${(apkStat.size / 1024 / 1024).toFixed(1)} MB, built ${apkStat.mtime.toLocaleString()})`);

  // ---- 4. Its NATIVE manifest must carry the version we are claiming -------
  // This is the one that decides whether the updater offers the build at all.
  const metaPath = path.join(OUT_DIR, 'output-metadata.json');
  if (fs.existsSync(metaPath)) {
    const el = JSON.parse(fs.readFileSync(metaPath, 'utf8')).elements?.[0] || {};
    if (el.versionCode !== versionCode || el.versionName !== version) {
      fail(`The built APK's manifest says ${el.versionName}/${el.versionCode}, not ${version}/${versionCode}. `
        + 'The version was bumped after this APK was built — rebuild it.');
    } else {
      ok(`APK manifest confirms ${el.versionName} / ${el.versionCode}`);
    }
  } else {
    note('warn  no output-metadata.json — could not confirm the APK\'s native version');
  }

  // ---- 5. Its BAKED config must match, and name a backend -----------------
  const raw = readFromApk(BUILT_APK, 'assets/app.config');
  if (!raw) {
    note('warn  could not read assets/app.config from the APK (no tar/unzip) — skipped');
  } else {
    try {
      const baked = JSON.parse(raw);
      if (baked.version !== version || baked.android?.versionCode !== versionCode) {
        fail(`The APK's baked config says ${baked.version}/${baked.android?.versionCode}, `
          + `not ${version}/${versionCode}. Rebuild it.`);
      } else {
        ok(`baked config confirms ${baked.version} / ${baked.android?.versionCode}`);
      }
      if (!baked.extra?.apiBaseUrl) fail('The APK has no extra.apiBaseUrl baked in — it would reach no backend.');
      else ok(`backend: ${baked.extra.apiBaseUrl}`);
    } catch {
      fail('The APK\'s assets/app.config is not readable JSON.');
    }
  }

  // ---- 6. The APK must not predate the source ------------------------------
  // A modification-time heuristic, and only over src/. app.json is deliberately
  // NOT included: its *content* is already checked against the config baked into
  // the APK above, which is a stronger test, and touching the file without
  // changing it (a git checkout, restoring a backup) would otherwise block a
  // perfectly good release with a misleading reason.
  const newestSrc = newestMtime(path.join(root, 'src'));
  if (newestSrc > apkStat.mtimeMs) {
    fail(`Files under src/ have changed since this APK was built (newest: ${new Date(newestSrc).toLocaleString()}). `
      + 'Rebuild, or you will ship stale code under a new version number.');
  } else {
    ok('APK is newer than every file in src/');
  }
}

// ---- 7. gh must be installed, authenticated, and the tag must be free ------
if (!run('gh', ['--version'])) {
  fail('The GitHub CLI (gh) is not installed — see https://cli.github.com');
} else if (!run('gh', ['auth', 'status'])) {
  fail('gh is not authenticated. Run: gh auth login');
} else {
  ok('gh is installed and authenticated');
  if (run('gh', ['release', 'view', tag, '--json', 'tagName'])) {
    fail(`Release ${tag} already exists. Bump the version, or delete it: gh release delete ${tag}`);
  } else {
    ok(`${tag} is free`);
  }
}

// ---- verdict ---------------------------------------------------------------
if (problems.length) {
  console.error(`\nNot ready to publish — ${problems.length} problem(s):\n`);
  problems.forEach((p) => console.error(`  * ${p}`));
  console.error('');
  process.exit(1);
}

if (!PUBLISH) {
  console.log('\nEverything checks out. To publish:\n');
  console.log('  node scripts/publish-apk.js --publish\n');
  process.exit(0);
}

// The asset is COPIED beside the build rather than renamed, so the Gradle
// output stays intact and a re-run is harmless. It deliberately never leaves
// the build folder.
fs.copyFileSync(BUILT_APK, assetPath);
console.log(`\n  copied  ${path.relative(root, assetPath)}`);

const notes = `Android build ${version} (versionCode ${versionCode}).`;
try {
  execFileSync('gh', ['release', 'create', tag, assetPath, '--title', tag, '--notes', notes], {
    stdio: 'inherit',
    cwd: root,
  });
} catch (err) {
  console.error('\nThe release could not be created:', err.message);
  process.exit(1);
}

console.log(`\nPublished ${tag}. Devices below versionCode ${versionCode} will be offered the update `
  + 'on their next check.\n');
