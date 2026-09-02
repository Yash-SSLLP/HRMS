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
 * Tell every active device about a release.
 *
 * Shared by the manual "Ask everyone to update" button and by publish(), so the
 * two cannot word the same event differently.
 *
 * Deactivated and resigned accounts keep their device rows until the token
 * expires, so the audience is intersected with active users — otherwise the
 * push goes to people who have left and the reported count overstates who will
 * actually read it.
 *
 * @param {object} release - the AppRelease being announced
 * @param {string} [message] - overrides the release notes as the body
 * @returns {Promise<number>} how many people were notified (0 = nobody to tell)
 */
async function broadcastUpdate(release, message) {
  const DeviceToken = require('../models/DeviceToken');
  const User = require('../models/User');
  const withDevices = await DeviceToken.distinct('user');
  const recipients = withDevices.length
    ? (await User.find({ _id: { $in: withDevices }, isActive: true }).select('_id').lean()).map((u) => u._id)
    : [];
  if (!recipients.length) return 0;

  const { notifyMany } = require('../services/notify');
  const custom = typeof message === 'string' ? message.trim() : '';
  await notifyMany(recipients, {
    type: 'general',
    audience: 'all',
    title: `Update the app to ${release.versionName}`,
    body: custom
      || (release.notes
        ? `${release.notes.slice(0, 160)}${release.notes.length > 160 ? '…' : ''}`
        : 'A new version is available. Open Settings → Check for updates to install it.'),
    // The app routes this to its own update check rather than a browser.
    link: 'app-update',
    data: { versionName: release.versionName, versionCode: release.versionCode },
  });
  return recipients.length;
}

/**
 * POST /api/app/notify-update — nudge everyone to install the current build.
 *
 * A broadcast, not a targeted one: DeviceToken records the platform and the
 * device name but NOT the installed app version, so the server cannot tell who
 * is already up to date. Anyone on the latest build simply gets a notification
 * that asks them to do something they have already done — mildly redundant, and
 * far better than the alternative of nobody being told at all.
 *
 * The app decides what to do with the tap: its own update check compares
 * versionCode against the installed package and offers the download only when
 * this build is genuinely newer, so a phone already on it cannot be talked into
 * a pointless download.
 *
 * SuperAdmin only (publisherOnly), because it pushes to every phone in the company.
 *
 * @returns {{ok: true, version: string, notified: number}}
 */
const notifyUpdate = asyncHandler(async (req, res) => {
  const release = await currentRelease();
  if (!release) {
    res.status(404);
    throw new Error('No build has been published yet, so there is nothing to tell anyone about.');
  }

  const notified = await broadcastUpdate(release, req.body?.message);
  if (!notified) {
    res.status(400);
    throw new Error('No active devices are registered for notifications yet.');
  }
  res.json({ ok: true, version: release.versionName, notified });
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

  // Tell everyone, automatically. Publishing IS the announcement — the app's own
  // check is silent by design (it only puts a dot in Settings), so without this
  // a release reaches a phone whenever its owner happens to wander in there.
  //
  // Fire-and-forget: the release is already written and served, and a push
  // outage must not turn a successful publish into a failed request. Republishing
  // cannot double-notify — the versionCode guard above rejects anything not newer.
  broadcastUpdate(release)
    .then((n) => console.log(`App release ${release.versionName}: notified ${n} user(s).`))
    .catch((err) => console.error('release notify failed:', err.message));

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

module.exports = {
  notifyUpdate, getLatest, download, getPublishTarget, publish, getRelease,
  // Exported for the admin app-version screen, which needs to know what "up to
  // date" currently means in order to mark anybody behind.
  currentRelease };
