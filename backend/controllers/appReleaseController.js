/**
 * The mobile app's update channel.
 *
 * The Android app is sideloaded, so nothing tells a phone that a newer build
 * exists — it has to ask. It asks here: GET /latest says what the newest build
 * is, GET /download hands over the APK, and the app compares versionCode against
 * its own installed package.
 *
 * Both of those are PUBLIC, deliberately. The app checks for updates on open,
 * which can happen before anyone has logged in, and a 401 travelling back
 * through the app's auth interceptor would sign the user out — a check for
 * updates must never be able to do that. Nothing here is sensitive: the APK is
 * the same file every employee installs.
 *
 * Publishing is not public. It takes either the CI publish key or an operator
 * with the app.releases permission (see appReleaseRoutes.js).
 */
const asyncHandler = require('express-async-handler');
const AppRelease = require('../models/AppRelease');
const store = require('../services/appReleaseStore');

/**
 * The current release, from whichever source this server's store trusts.
 *
 * An AUTHORITATIVE driver (the `repo` store) reads the filesystem on every call,
 * so a `git pull` that lands a new APK changes the answer with no publish step
 * and nothing to keep in sync. The others record a row when something is
 * published and serve what it points at.
 */
async function currentRelease() {
  const driver = store.driver();
  if (driver.authoritative) return driver.current();
  return AppRelease.findOne({ key: 'current' });
}

/** Strip a release document down to what a phone needs. */
function publicView(release) {
  if (!release) return null;
  return {
    versionName: release.versionName,
    versionCode: release.versionCode,
    notes: release.notes || '',
    size: release.size,
    // Mongoose documents carry createdAt; the repo driver reports the file's own
    // mtime, since a folder has no other notion of "when".
    publishedAt: release.createdAt || release.publishedAt,
  };
}

/**
 * GET /api/app/latest — the newest published build. Public.
 *
 * Answers 200 with `{ release: null }` rather than 404 when nothing has been
 * published: "there is no build yet" is a normal state on a fresh install of
 * the backend, and the app should read it as "you are up to date", not as an
 * error worth showing anybody.
 */
const getLatest = asyncHandler(async (req, res) => {
  res.json({ release: publicView(await currentRelease()) });
});

/**
 * GET /api/app/download — the APK itself. Public.
 *
 * Delegates to whichever store holds THIS release, which is not necessarily the
 * one configured now (see services/appReleaseStore.js).
 */
const download = asyncHandler(async (req, res) => {
  const release = await currentRelease();
  if (!release) {
    res.status(404);
    throw new Error('No build has been published yet.');
  }
  await store.driverFor(release).send(req, res, release);
});

/**
 * GET /api/app/publish-target — how to publish, for whoever is about to.
 *
 * The publisher (CI, or the admin page) has to know whether to send us the file
 * or to put it somewhere itself and send a reference. That depends on the store
 * this server is configured with, and the publisher should not have to be
 * configured to match — it asks.
 */
const getPublishTarget = asyncHandler(async (req, res) => {
  const driver = store.ensureConfigured();
  const current = await currentRelease();
  res.json({
    store: driver.name,
    mode: driver.acceptsUpload ? 'upload' : (driver.authoritative ? 'repo' : 'reference'),
    ...driver.target(),
    // So the publisher can refuse early rather than build, upload, and then be
    // told the version was not bumped.
    currentVersionCode: current?.versionCode || 0,
    currentVersionName: current?.versionName || null,
  });
});

/**
 * POST /api/app/publish — make a build the current one.
 *
 * Two shapes, depending on the store:
 *   upload    multipart: file=<apk>, plus versionName / versionCode / notes
 *   reference JSON: { versionName, versionCode, notes, tag, assetId }
 *
 * Publishing REPLACES what came before, file included. The old artifact is
 * removed only after the new row is saved: an orphaned file wastes a little
 * space, whereas a row pointing at a file that has already been deleted breaks
 * every download.
 */
const publish = asyncHandler(async (req, res) => {
  const driver = store.ensureConfigured();

  // In repo mode the folder in the checkout IS the release. Accepting an upload
  // here would put a file where the next `git pull` overwrites or contradicts
  // it, so refuse with the actual procedure rather than appear to succeed.
  if (driver.authoritative) {
    res.status(409);
    throw new Error(
      'This server publishes from the repository: commit the APK to the "Mobile App" '
      + 'folder as hrms-<version>-<code>.apk, push, and deploy. Nothing to upload here.'
    );
  }

  const versionName = String(req.body.versionName || '').trim();
  const versionCode = Number(req.body.versionCode);
  const notes = String(req.body.notes || '').trim();

  if (!/^\d+\.\d+\.\d+$/.test(versionName)) {
    res.status(400);
    throw new Error('versionName must look like 2.3.0.');
  }
  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    res.status(400);
    throw new Error('versionCode must be a whole number above zero.');
  }

  const current = await AppRelease.findOne({ key: 'current' });

  // Android refuses to install a build whose versionCode is not higher than the
  // installed one, so publishing one could only ever produce a failed install on
  // every phone. A rollback is therefore a NEW, higher version — not this.
  if (current && versionCode <= current.versionCode) {
    res.status(409);
    throw new Error(
      `versionCode ${versionCode} is not newer than the published ${current.versionCode} `
      + `(${current.versionName}). Bump the version and build again.`
    );
  }

  let located;
  if (driver.acceptsUpload) {
    if (!req.file) {
      res.status(400);
      throw new Error('No APK was uploaded. Send it as multipart field "file".');
    }
    located = await driver.save({
      tmpPath: req.file.path,
      fileName: `hrms-${versionName}-${versionCode}.apk`,
    });
  } else {
    const assetId = Number(req.body.assetId);
    const tag = String(req.body.tag || '').trim();
    if (!assetId || !tag) {
      res.status(400);
      throw new Error(
        'This server stores APKs on GitHub, so publish needs { tag, assetId } of the '
        + 'uploaded release asset rather than the file itself.'
      );
    }
    located = await driver.adopt({ tag, assetId });
  }

  const release = await AppRelease.findOneAndUpdate(
    { key: 'current' },
    {
      $set: {
        versionName,
        versionCode,
        notes,
        store: driver.name,
        size: located.size,
        fileName: located.fileName || undefined,
        githubRepo: located.githubRepo || undefined,
        githubTag: located.githubTag || undefined,
        githubAssetId: located.githubAssetId || undefined,
        publishedBy: req.user?._id,
        publishedVia: req.publishedVia || (req.user ? 'admin' : 'ci'),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // Now that nothing points at it any more.
  if (current) await store.driverFor(current).remove(current).catch(() => {});

  res.status(201).json({ release: publicView(release) });
});

/**
 * GET /api/app/release — the full current release, for the admin screen.
 * Shows where the file actually lives, which is what you need when a download
 * is misbehaving.
 */
const getRelease = asyncHandler(async (req, res) => {
  const driver = store.driver();
  const release = driver.authoritative
    ? driver.current()
    : await AppRelease.findOne({ key: 'current' }).populate('publishedBy', 'name email');
  res.json({
    release,
    store: {
      name: driver.name,
      mode: driver.acceptsUpload ? 'upload' : (driver.authoritative ? 'repo' : 'reference'),
      configured: driver.configured(),
      ...driver.target(),
    },
  });
});

module.exports = { getLatest, download, getPublishTarget, publish, getRelease };
