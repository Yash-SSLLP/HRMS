/**
 * Where a published APK physically lives.
 *
 * Two drivers behind one interface, selected by APP_RELEASE_STORE:
 *
 *   disk    A folder on this server (APP_RELEASE_DIR). The publisher POSTs the
 *           file to us and we keep exactly one. This is the end state on the
 *           Hostinger VPS, and the simplest thing that can work: no third
 *           party, no size ceiling, no signing dance.
 *
 *   github  A release asset on the mobile repo. The publisher — CI, which is
 *           already there and already holds a token — uploads the bytes itself
 *           and tells us only where they landed. We never see the file; a
 *           download is a 302 to a short-lived URL GitHub mints for us.
 *
 * WHY BOTH. The backend runs on Render today, whose filesystem is wiped on
 * every deploy, restart and sleep — a folder there cannot hold a release. The
 * github driver works from anywhere and needs no disk, so it covers the present;
 * disk covers the VPS. Switching is one environment variable, and nothing in the
 * mobile app changes: it only ever calls /api/app/latest and /api/app/download.
 *
 * WHY THE BYTES NEVER PASS THROUGH THIS PROCESS on the github driver: a 69 MB
 * upload streamed through a small Render instance is the one part of this that
 * would reliably fall over.
 *
 * Env:
 *   APP_RELEASE_STORE       'disk' | 'github'  (default 'github')
 *   APP_RELEASE_DIR         disk only — absolute path to the folder holding the
 *                           APK. Keep it OUTSIDE the git checkout, or a deploy
 *                           will wipe it.
 *   APP_RELEASE_GITHUB_REPO github only — 'owner/name' of the repo whose
 *                           releases hold the APK.
 *   APP_RELEASE_GITHUB_TOKEN github only — a token with Contents write on that
 *                           repo. Required for a private repo, and for deleting
 *                           the superseded release.
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DRIVER = (process.env.APP_RELEASE_STORE || 'github').toLowerCase();
const DISK_DIR = process.env.APP_RELEASE_DIR || '';
const GH_REPO = process.env.APP_RELEASE_GITHUB_REPO || '';
const GH_TOKEN = process.env.APP_RELEASE_GITHUB_TOKEN || '';

const GH_API = 'https://api.github.com';
const GH_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
};

/** An error carrying an HTTP status, so the controller can pass it straight on. */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ===== disk =================================================================

const disk = {
  name: 'disk',

  // The publisher sends us the file itself.
  acceptsUpload: true,

  configured() {
    return Boolean(DISK_DIR);
  },

  misconfigured() {
    return 'APP_RELEASE_DIR is not set — the server has nowhere to keep the APK.';
  },

  /** Nothing for the publisher to know: it sends us the file. */
  target() {
    return {};
  },

  /**
   * Move an uploaded file into the release folder under its published name.
   *
   * Uses rename where possible and falls back to copy: multer's temp directory
   * and the release folder are often on the same filesystem but need not be
   * (a mounted volume), and rename across devices throws EXDEV.
   *
   * @param {{tmpPath: string, fileName: string}} file
   * @returns {Promise<{fileName: string, size: number}>}
   */
  async save({ tmpPath, fileName }) {
    await fsp.mkdir(DISK_DIR, { recursive: true });
    const dest = path.join(DISK_DIR, fileName);
    try {
      await fsp.rename(tmpPath, dest);
    } catch (err) {
      if (err.code !== 'EXDEV') throw err;
      await fsp.copyFile(tmpPath, dest);
      await fsp.unlink(tmpPath).catch(() => {});
    }
    const { size } = await fsp.stat(dest);
    return { fileName, size };
  },

  /** Best-effort delete of the superseded APK. */
  async remove(release) {
    if (!release?.fileName) return;
    await fsp.unlink(path.join(DISK_DIR, release.fileName)).catch(() => {});
  },

  /**
   * Send the APK.
   *
   * res.sendFile sets Content-Length and Accept-Ranges and handles Range
   * requests, which matters: the app's downloader resumes, and it verifies the
   * finished file against the byte count the API reported.
   */
  async send(req, res, release) {
    const file = path.join(DISK_DIR, release.fileName || '');
    if (!fs.existsSync(file)) {
      throw httpError(404, 'The published APK is missing from this server. Publish the build again.');
    }
    res.type('application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${release.fileName}"`);
    return new Promise((resolve, reject) => {
      res.sendFile(file, (err) => (err ? reject(err) : resolve()));
    });
  },
};

// ===== github ===============================================================

const github = {
  name: 'github',

  // The publisher uploads to GitHub directly and sends us only a reference —
  // see the note at the top about not streaming 69 MB through this process.
  acceptsUpload: false,

  configured() {
    return Boolean(GH_REPO);
  },

  misconfigured() {
    return 'APP_RELEASE_GITHUB_REPO is not set — the server does not know which repo holds the APK.';
  },

  /**
   * Where the publisher should put the bytes. Told, not configured separately:
   * the publisher and this server disagreeing about the repo would produce a
   * release row pointing at an asset nobody can find.
   */
  target() {
    return { repo: GH_REPO };
  },

  /**
   * Adopt an asset the publisher has already uploaded.
   *
   * Verified rather than trusted: a release row pointing at an asset that does
   * not exist would leave every phone with a download that 404s, and the phone
   * has no way to report that back.
   *
   * @param {{tag: string, assetId: number}} ref
   * @returns {Promise<{githubRepo: string, githubTag: string, githubAssetId: number, size: number, fileName: string}>}
   */
  async adopt({ tag, assetId }) {
    const res = await fetch(`${GH_API}/repos/${GH_REPO}/releases/assets/${assetId}`, { headers: GH_HEADERS });
    if (res.status === 404) {
      throw httpError(400, `No asset ${assetId} on ${GH_REPO}. Was the release created, and is the token allowed to see it?`);
    }
    if (!res.ok) throw httpError(502, `GitHub returned ${res.status} for that asset.`);
    const asset = await res.json();
    return {
      githubRepo: GH_REPO,
      githubTag: tag,
      githubAssetId: asset.id,
      size: asset.size,
      fileName: asset.name,
    };
  },

  /**
   * Delete the superseded release and its asset.
   *
   * Best-effort: the new release is already recorded by the time this runs, and
   * an orphaned old release is untidy, not broken.
   */
  async remove(release) {
    if (!release?.githubTag || !GH_TOKEN) return;
    const repo = release.githubRepo || GH_REPO;
    try {
      const res = await fetch(`${GH_API}/repos/${repo}/releases/tags/${release.githubTag}`, { headers: GH_HEADERS });
      if (!res.ok) return;
      const { id } = await res.json();
      await fetch(`${GH_API}/repos/${repo}/releases/${id}`, { method: 'DELETE', headers: GH_HEADERS });
      // The tag outlives the release it named, and would block re-publishing
      // that version later.
      await fetch(`${GH_API}/repos/${repo}/git/refs/tags/${release.githubTag}`, {
        method: 'DELETE',
        headers: GH_HEADERS,
      });
    } catch {
      /* best-effort — an orphaned release does not break anything */
    }
  },

  /**
   * Redirect to the bytes.
   *
   * Asking for the asset with Accept: application/octet-stream answers with a
   * 302 to a pre-signed URL that needs no credentials of its own and expires in
   * minutes — which is why this works for a PRIVATE mobile repo too, and why the
   * URL is fetched per download instead of being stored.
   */
  async send(req, res, release) {
    const repo = release.githubRepo || GH_REPO;
    const upstream = await fetch(`${GH_API}/repos/${repo}/releases/assets/${release.githubAssetId}`, {
      headers: { ...GH_HEADERS, Accept: 'application/octet-stream' },
      redirect: 'manual',
    });
    const location = upstream.headers.get('location');
    if (!location) {
      throw httpError(502, `Could not get a download URL from GitHub (${upstream.status}).`);
    }
    return res.redirect(302, location);
  },
};

// ===== repo =================================================================

/**
 * The APK is committed to the repository, in the "Mobile App" folder beside
 * backend/ and frontend/, and reaches this server the same way every other
 * change does: git pull. There is no publish step, no upload and no key —
 * whatever APK is sitting in that folder after a deploy IS the current release.
 *
 * WHY THIS IS DIFFERENT FROM THE OTHERS. disk and github both record a release
 * in the database and serve what that row points at. This driver is
 * AUTHORITATIVE: it reads the folder on every request, so the filesystem and the
 * answer can never disagree. A `git pull` that brings a new APK changes what the
 * app is offered with no other action — which is the entire point.
 *
 * The version is taken from the FILENAME, `hrms-<versionName>-<versionCode>.apk`
 * — the same contract the mobile CI and scripts/publish-apk.js already use. It
 * has to travel somehow, and a name is the one piece of metadata a plain folder
 * carries. An optional release.json beside it supplies release notes.
 */
const APK_RE = /^hrms-(\d+\.\d+\.\d+)-(\d+)\.apk$/i;

// The folder in this checkout, so a deployment needs one env var
// (APP_RELEASE_STORE=repo) and nothing else.
//
// Deliberately NOT falling back to APP_RELEASE_DIR: that variable belongs to the
// disk store, and a server that has used both would still have it set — pointing
// this driver at an empty uploads folder while the APK sits here unread, and
// answering "no build published" with everything apparently configured. Override
// with APP_RELEASE_REPO_DIR if the folder ever moves.
const REPO_DIR = process.env.APP_RELEASE_REPO_DIR
  || path.join(__dirname, '..', '..', 'Mobile App');

const repo = {
  name: 'repo',
  acceptsUpload: false,

  // Read the folder, do not trust a database row.
  authoritative: true,

  configured() {
    return fs.existsSync(REPO_DIR);
  },

  misconfigured() {
    return `No "Mobile App" folder at ${REPO_DIR} — deploy one containing hrms-<version>-<code>.apk.`;
  },

  target() {
    return { dir: REPO_DIR };
  },

  /**
   * The newest APK in the folder, or null when there is none.
   *
   * Highest versionCode wins rather than newest mtime: a git checkout rewrites
   * timestamps, so mtime says when you deployed, not which build is newer.
   *
   * @returns {{versionName:string, versionCode:number, size:number, fileName:string, notes:string, publishedAt:Date}|null}
   */
  current() {
    let names;
    try {
      names = fs.readdirSync(REPO_DIR);
    } catch {
      return null;
    }

    const builds = names
      .map((name) => {
        const m = APK_RE.exec(name);
        return m ? { name, versionName: m[1], versionCode: Number(m[2]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.versionCode - a.versionCode);

    if (!builds.length) return null;
    const newest = builds[0];

    let stat;
    try {
      stat = fs.statSync(path.join(REPO_DIR, newest.name));
    } catch {
      return null;
    }

    // Notes are optional: a release with nothing to say is normal, and a
    // malformed file must not take the update channel down.
    let notes = '';
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'release.json'), 'utf8'));
      if (String(meta.versionCode) === String(newest.versionCode)) notes = String(meta.notes || '');
    } catch { /* no notes */ }

    return {
      versionName: newest.versionName,
      versionCode: newest.versionCode,
      size: stat.size,
      fileName: newest.name,
      notes,
      publishedAt: stat.mtime,
      store: 'repo',
    };
  },

  /** Nothing to remove: git decides what is in the folder. */
  async remove() { /* no-op */ },

  async send(req, res, release) {
    const file = path.join(REPO_DIR, release.fileName || '');
    if (!fs.existsSync(file)) {
      throw httpError(404, 'The published APK is missing from this server. Has the deploy run?');
    }
    res.type('application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${release.fileName}"`);
    return new Promise((resolve, reject) => {
      res.sendFile(file, (err) => (err ? reject(err) : resolve()));
    });
  },
};

// ===== selection ============================================================

const DRIVERS = { disk, github, repo };

/** The configured driver. Throws if APP_RELEASE_STORE names one that does not exist. */
function driver() {
  const d = DRIVERS[DRIVER];
  if (!d) throw httpError(500, `APP_RELEASE_STORE is "${DRIVER}" — expected 'disk' or 'github'.`);
  return d;
}

/**
 * The driver that holds a PARTICULAR release, which is not necessarily the one
 * configured now: a release published before a store switch must stay
 * downloadable until it is replaced.
 */
function driverFor(release) {
  return DRIVERS[release?.store] || driver();
}

/** Throw if the configured driver cannot work with the current environment. */
function ensureConfigured() {
  const d = driver();
  if (!d.configured()) throw httpError(503, d.misconfigured());
  return d;
}

module.exports = { driver, driverFor, ensureConfigured, httpError };
