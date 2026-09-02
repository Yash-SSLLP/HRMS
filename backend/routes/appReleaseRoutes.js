/**
 * App release router — mounted at /api/app.
 *
 * Reading is public (see the note in appReleaseController.js: an update check
 * runs before login, and a 401 would sign the user out). Publishing takes one of
 * two credentials:
 *
 *   X-API-Key: <APP_PUBLISH_KEY>   CI, which has no user to log in as
 *   a logged-in SuperAdmin          the admin page
 *
 * Either is enough; both are checked in that order because the key is cheap and
 * CI is the common caller.
 *
 * SuperAdmin rather than a grantable capability, following the audit log: which
 * build every employee's phone installs is not a routine HR permission. Widening
 * it later is one argument to restrictTo().
 */
const os = require('os');
const path = require('path');
const multer = require('multer');
const express = require('express');

const {
  getLatest, download, getPublishTarget,
  notifyUpdate, publish, getRelease,
} = require('../controllers/appReleaseController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { preserveContext } = require('../middleware/requestContext');

const router = express.Router();

const PUBLISH_KEY = process.env.APP_PUBLISH_KEY || '';

/**
 * Constant-time-ish comparison, so a wrong key cannot be narrowed down by
 * timing. Short-circuiting on length is fine: the length of the key is not the
 * secret.
 */
function keyMatches(given) {
  if (!PUBLISH_KEY || !given || given.length !== PUBLISH_KEY.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i += 1) diff |= given.charCodeAt(i) ^ PUBLISH_KEY.charCodeAt(i);
  return diff === 0;
}

/**
 * Accept either credential.
 *
 * The logged-in path is delegated to the existing `protect` + `restrictTo` pair
 * rather than reimplemented, so an operator publishing from the admin page is
 * authorised by exactly the same rules as anywhere else in the portal — and
 * lands in the audit log as themselves. (restrictTo also gives CEO/MD their
 * usual read-only view of the GET routes.)
 */
function publisherOnly(req, res, next) {
  if (keyMatches(req.get('X-API-Key'))) {
    req.publishedVia = 'ci';
    return next();
  }
  return protect(req, res, (err) => {
    if (err) return next(err);
    return restrictTo('SuperAdmin')(req, res, next);
  });
}

/**
 * The APK goes to a temp file, not into memory.
 *
 * createUpload() defaults to memoryStorage, which is right for the 5 MB
 * receipts and selfies elsewhere in the app and wrong here: an APK is ~70 MB
 * and buffering one per concurrent publish is how a small instance runs out of
 * memory. The store then moves the temp file into place.
 */
const apkUpload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 250 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (path.extname(file.originalname).toLowerCase() !== '.apk') {
      return cb(new Error('That is not an .apk file.'));
    }
    return cb(null, true);
  },
});

// GET /latest — newest published build, or { release: null }; public.
router.get('/latest', getLatest);
// GET /download — the APK; public.
router.get('/download', download);

// GET /publish-target — whether to send the file or a reference; publisher only.
// Nudge every registered device to install the current build. SuperAdmin only.
router.post('/notify-update', publisherOnly, notifyUpdate);
router.get('/publish-target', publisherOnly, getPublishTarget);
// GET /release — full current release + store status, for the admin screen.
router.get('/release', publisherOnly, getRelease);
// POST /publish — make a build current, replacing the previous one.
router.post('/publish', publisherOnly, preserveContext(apkUpload.single('file')), publish);

module.exports = router;
