const mongoose = require('mongoose');

/**
 * The Android build the mobile app should be running.
 *
 * ONE ROW, EVER. The app is sideloaded, so the only thing that tells a phone a
 * newer build exists is this record; there is no store, and no reason to keep
 * older builds around once they are superseded — publishing REPLACES both this
 * row and the file behind it (see services/appReleaseStore.js). The `key` field
 * is what enforces that: it is always 'current' and unique, so an upsert on it
 * can never race two publishes into two rows.
 *
 * The bytes are NOT here. Where they live depends on the configured store, and
 * the fields below carry just enough to find them again:
 *   disk    -> fileName, inside APP_RELEASE_DIR on the server
 *   github  -> githubTag + githubAssetId on the mobile repo
 */
const appReleaseSchema = new mongoose.Schema(
  {
    // Always 'current'. See the note above.
    key: { type: String, default: 'current', unique: true, immutable: true },

    // What Android stamps into the APK. versionCode is the one that decides
    // whether a phone is offered the update — versionName is only ever shown.
    versionName: { type: String, required: true, trim: true },
    versionCode: { type: Number, required: true },

    // Shown on the update screen. Optional; a release with nothing to say is
    // normal.
    notes: { type: String, trim: true, default: '' },

    // Exact byte count. The app compares this against what it actually
    // downloaded and discards a mismatch, so it has to be the real size, not an
    // estimate — a truncated APK fails to install with an unhelpful "problem
    // parsing package".
    size: { type: Number, required: true },

    // Which driver holds the file, recorded per-release rather than read from
    // the environment at download time: after a store switch, the release
    // published under the old one must still be downloadable.
    store: { type: String, enum: ['disk', 'github'], required: true },

    // disk store
    fileName: { type: String, trim: true },

    // github store
    githubRepo: { type: String, trim: true },
    githubTag: { type: String, trim: true },
    githubAssetId: { type: Number },

    // Who published it: an operator through the admin page, or CI with the
    // publish key.
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedVia: { type: String, enum: ['admin', 'ci'], default: 'ci' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AppRelease', appReleaseSchema);
