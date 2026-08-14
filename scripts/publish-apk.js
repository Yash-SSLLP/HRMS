/**
 * Publish the built release APK to GitHub Releases.
 *
 *   node scripts/publish-apk.js --dry-run              run every guard, change nothing
 *   node scripts/publish-apk.js --notes "What changed"
 *   node scripts/publish-apk.js --notes-file notes.md
 *   node scripts/publish-apk.js --force                replace an existing release for this tag
 *
 * This is the other half of the in-app updater (mobile/src/services/appUpdate.js).
 * The app asks GitHub for the newest release and compares the versionCode encoded
 * in the asset filename, so what this script uploads has to be exactly what was
 * built — hence the preflight guards below, which all abort before anything is
 * created on GitHub.
 *
 * Authentication: a fine-grained token scoped to this repo with Contents:
 * read+write, in GITHUB_TOKEN (env, or a line in the repo-root .env, which
 * .gitignore already covers). The git remote is SSH, which the REST API cannot
 * use, so a token is unavoidable.
 *
 * Zero dependencies, plain Node — same convention as scripts/build-guides.js.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const APP_JSON = path.join(ROOT, 'mobile', 'app.json');
const APK_DIR = path.join(ROOT, 'mobile', 'android', 'app', 'build', 'outputs', 'apk', 'release');
const APK = path.join(APK_DIR, 'app-release.apk');
const METADATA = path.join(APK_DIR, 'output-metadata.json');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const DRY = has('--dry-run');
const FORCE = has('--force');

const die = (msg, hint) => {
  console.error(`\n  ✗ ${msg}`);
  if (hint) console.error(`    ${hint}`);
  process.exit(1);
};
const step = (msg) => console.log(`  · ${msg}`);
const ok = (msg) => console.log(`  ✓ ${msg}`);

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

/** GITHUB_TOKEN from the environment, else a bare KEY=value line in the root .env. */
function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  try {
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    const m = env.match(/^\s*(?:GITHUB_TOKEN|GH_TOKEN)\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  } catch { /* no .env — fall through */ }
  return null;
}

// ---------------------------------------------------------------------------
// GitHub REST
// ---------------------------------------------------------------------------

const TOKEN = readToken();

/**
 * One JSON request against api.github.com.
 * @returns {Promise<{status:number, body:any}>} Never throws on a non-2xx — the
 *   caller decides, because 404 is a normal answer for "no releases yet".
 */
function api(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.github.com',
      path: pathname,
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ssllp-hrms-publish-apk',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Stream the APK to uploads.github.com — a DIFFERENT host from the rest of the
 * API. Uses https.request rather than fetch purely so the upload can report
 * progress; a 70 MB silent wait looks like a hang.
 */
function uploadAsset(releaseId, repo, assetName, file, size) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'uploads.github.com',
      path: `/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ssllp-hrms-publish-apk',
        'Content-Type': 'application/vnd.android.package-archive',
        'Content-Length': size,
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch { parsed = data; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);

    let sent = 0;
    let lastPct = -1;
    const stream = fs.createReadStream(file);
    stream.on('data', (c) => {
      sent += c.length;
      const pct = Math.floor((sent / size) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stdout.write(`\r    uploading ${pct}%  (${(sent / 1e6).toFixed(1)}/${(size / 1e6).toFixed(1)} MB)`);
      }
    });
    stream.on('end', () => process.stdout.write('\n'));
    stream.on('error', reject);
    stream.pipe(req);
  });
}

// ---------------------------------------------------------------------------

(async () => {
  console.log('\nPublish APK to GitHub Releases\n');

  // --- Config -------------------------------------------------------------
  const app = JSON.parse(fs.readFileSync(APP_JSON, 'utf8')).expo;
  const repo = app.extra?.updateRepo;
  if (!repo) {
    die('mobile/app.json has no expo.extra.updateRepo',
      'Add  "updateRepo": "Yash-SSLLP/HRMS"  to the extra block.');
  }
  const version = app.version;
  const versionCode = app.android?.versionCode;
  const tag = `v${version}`;
  const assetName = `hrms-${version}-${versionCode}.apk`;

  if (!TOKEN && !DRY) {
    die('No GitHub token found.', [
      'Create a fine-grained token at https://github.com/settings/tokens?type=beta',
      `  · Repository access: only ${repo}`,
      '  · Permissions: Contents → Read and write',
      'Then add this line to the repo-root .env (already gitignored):',
      '  GITHUB_TOKEN=github_pat_...',
    ].join('\n    '));
  }

  console.log(`  repo    ${repo}`);
  console.log(`  version ${version}  (versionCode ${versionCode})`);
  console.log(`  tag     ${tag}`);
  console.log(`  asset   ${assetName}\n`);

  // --- Guard: the APK exists ---------------------------------------------
  if (!fs.existsSync(APK)) {
    die('No release APK found.',
      'Build it first:\n      cd mobile/android && ./gradlew.bat assembleRelease -x lint -x test --max-workers=2 --no-daemon');
  }
  const apkStat = fs.statSync(APK);

  // --- Guards A & B: the APK really is this version ------------------------
  // output-metadata.json is written by Gradle beside the APK and describes the
  // artifact that was ACTUALLY produced — a far better source than build.gradle,
  // which only says what the config last read.
  if (!fs.existsSync(METADATA)) die('output-metadata.json is missing beside the APK.', 'Rebuild so Gradle regenerates it.');
  const built = JSON.parse(fs.readFileSync(METADATA, 'utf8')).elements[0];

  if (built.versionName !== version) {
    die(`The built APK is v${built.versionName}, but app.json says v${version}.`,
      'You changed the version without rebuilding. Rebuild, then publish.');
  }
  if (Number(built.versionCode) !== Number(versionCode)) {
    die(`The built APK is versionCode ${built.versionCode}, but app.json says ${versionCode}.`,
      'You changed versionCode without rebuilding. Rebuild, then publish.');
  }
  ok(`APK matches app.json (v${built.versionName}, code ${built.versionCode})`);

  // --- Guard C: the APK is newer than app.json ----------------------------
  // A and B both pass if you edit app.json AFTER building and then rebuild
  // nothing — this is what catches that.
  const appJsonStat = fs.statSync(APP_JSON);
  if (apkStat.mtimeMs < appJsonStat.mtimeMs) {
    die('app.json was edited after the APK was built.',
      `APK  ${apkStat.mtime.toLocaleString()}\n    app.json  ${appJsonStat.mtime.toLocaleString()}\n    Rebuild so the APK reflects the current config.`);
  }
  ok('APK is newer than app.json');

  // --- Guard F: the working tree is clean and pushed -----------------------
  // The tag will point at HEAD, so HEAD must be what the APK was built from and
  // must already exist on GitHub.
  const git = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = git('git status --porcelain');
  if (dirty) {
    die('The working tree has uncommitted changes.',
      `Commit or stash them so the release tag points at the code that was built.\n\n${dirty.split('\n').slice(0, 10).join('\n    ')}`);
  }
  let head;
  try {
    const unpushed = git('git log @{u}..HEAD --oneline');
    if (unpushed) die('HEAD has not been pushed.', `Run: git push\n\n    ${unpushed.split('\n').join('\n    ')}`);
    head = git('git rev-parse HEAD');
  } catch (e) {
    if (/no upstream/i.test(e.message)) die('The branch has no upstream.', 'Run: git push -u origin main');
    throw e;
  }
  ok(`working tree clean, HEAD pushed (${head.slice(0, 8)})`);

  if (DRY && !TOKEN) {
    console.log('\n  --dry-run with no token: local guards passed; skipped the GitHub checks.\n');
    return;
  }

  // --- Guard D: never publish a downgrade ---------------------------------
  // Android refuses to install an APK whose versionCode is lower than the one
  // installed, so publishing one would silently dead-end the update path.
  const latest = await api('GET', `/repos/${repo}/releases/latest`);
  if (latest.status === 200) {
    const prev = (latest.body.assets || [])
      .map((a) => a.name.match(/^hrms-\d+\.\d+\.\d+-(\d+)\.apk$/))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a)[0];
    if (prev != null && Number(versionCode) <= prev) {
      die(`versionCode ${versionCode} is not newer than the published ${prev} (${latest.body.tag_name}).`,
        'Android will not install this as an update. Bump versionCode in mobile/app.json and rebuild.');
    }
    ok(`newer than the published release (${latest.body.tag_name}, code ${prev ?? 'unknown'})`);
  } else if (latest.status === 404) {
    ok('no existing release — this will be the first');
  } else if (latest.status === 401) {
    die('GitHub rejected the token (401).', 'Check the token value and that it has Contents: read+write on this repo.');
  } else {
    die(`Could not read the latest release (HTTP ${latest.status}).`,
      'Failing closed rather than publishing blind. Use --force to override.');
  }

  // --- Guard E: the tag is free -------------------------------------------
  const existing = await api('GET', `/repos/${repo}/releases/tags/${tag}`);
  if (existing.status === 200) {
    if (!FORCE) {
      die(`Release ${tag} already exists.`,
        'Bump the version, or pass --force to delete and recreate it.');
    }
    step(`--force: deleting the existing ${tag} release`);
    if (!DRY) await api('DELETE', `/repos/${repo}/releases/${existing.body.id}`);
  } else {
    ok(`tag ${tag} is free`);
  }

  // --- Notes --------------------------------------------------------------
  const notesFile = valueOf('--notes-file');
  const notes = notesFile
    ? fs.readFileSync(path.resolve(ROOT, notesFile), 'utf8').trim()
    : (valueOf('--notes') || '').trim();
  const body = [
    `v${version} (build ${versionCode})`,
    '',
    notes,
    '',
    '---',
    'Installs over the previous version and keeps your data. Android 7+.',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');

  if (DRY) {
    console.log(`\n  --dry-run: all guards passed. Would publish:\n`);
    console.log(`    ${tag} → ${assetName}  (${(apkStat.size / 1e6).toFixed(1)} MB)`);
    console.log(`    at commit ${head.slice(0, 8)}\n`);
    console.log(body.split('\n').map((l) => `    | ${l}`).join('\n'));
    console.log('\n  Nothing was changed.\n');
    return;
  }

  // --- Draft → upload → publish -------------------------------------------
  // In this order deliberately: /releases/latest excludes drafts, so the app can
  // never see a release whose APK is still uploading.
  step('creating draft release');
  const draft = await api('POST', `/repos/${repo}/releases`, {
    tag_name: tag,
    target_commitish: head,
    name: tag,
    body,
    draft: true,
    prerelease: false,
  });
  if (draft.status !== 201) {
    die(`Could not create the release (HTTP ${draft.status}).`, JSON.stringify(draft.body));
  }
  const releaseId = draft.body.id;

  try {
    step(`uploading ${assetName} (${(apkStat.size / 1e6).toFixed(1)} MB)`);
    const up = await uploadAsset(releaseId, repo, assetName, APK, apkStat.size);
    if (up.status !== 201) throw new Error(`asset upload failed (HTTP ${up.status}): ${JSON.stringify(up.body)}`);

    step('publishing');
    const pub = await api('PATCH', `/repos/${repo}/releases/${releaseId}`, { draft: false });
    if (pub.status !== 200) throw new Error(`could not publish (HTTP ${pub.status})`);

    console.log(`\n  ✓ Published ${tag}\n    ${pub.body.html_url}\n`);
    console.log('  Everyone on the app can now pull this from Settings → Check for updates.\n');
  } catch (err) {
    // Leave nothing half-made: a draft with a partial asset would block a retry
    // on the duplicate-tag guard.
    step('cleaning up the draft after the failure');
    await api('DELETE', `/repos/${repo}/releases/${releaseId}`).catch(() => {});
    die(err.message);
  }
})().catch((err) => die(err.message));
