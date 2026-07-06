/**
 * LMS video transcoding.
 *
 * Course videos live as single, original-quality Google Drive files. To offer a
 * YouTube-style quality menu + adaptive "Auto", we pre-generate lower-quality
 * copies ("renditions") with ffmpeg and store them in our own storage. The
 * player then requests a rendition by height via
 *   GET /api/courses/:id/modules/:mid/video?quality=<height>
 *
 * Transcoding is CPU-heavy and slow, so it runs in the background off a simple
 * in-process queue (one job at a time) after an admin creates/updates a course.
 * State is tracked on the module (transcodeStatus + renditions) so the UI can
 * show progress and the player can build its menu.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const Course = require('../models/Course');
const renditionStore = require('./renditionStore');
const { downloadDriveFileTo } = require('../utils/drive');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Quality ladder we aim to produce. Only heights strictly below the source
// height are generated (never upscale). The original Drive file remains the
// top "Source" quality, served by the existing proxy.
const TARGET_HEIGHTS = [360, 480, 720];

// ---- probing ----------------------------------------------------------------
function probe(srcPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(srcPath, (err, data) => {
      if (err) return reject(err);
      const video = (data.streams || []).find((s) => s.codec_type === 'video');
      resolve({
        height: video ? Number(video.height) || 0 : 0,
        durationSec: Math.round(Number(data.format?.duration) || 0),
      });
    });
  });
}

// ---- one rendition ----------------------------------------------------------
function encodeOne(srcPath, outPath, height) {
  return new Promise((resolve, reject) => {
    ffmpeg(srcPath)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate('128k')
      .outputOptions([
        '-vf', `scale=-2:${height}`, // keep aspect ratio, width kept even
        '-preset', 'veryfast',
        '-crf', '26',
        '-movflags', '+faststart', // moov atom up front → instant web playback
        '-pix_fmt', 'yuv420p',
        '-max_muxing_queue_size', '1024',
      ])
      .on('error', reject)
      .on('end', () => resolve())
      .save(outPath);
  });
}

// ---- core: transcode one module --------------------------------------------
// Re-fetches the course each time so results are written against the freshest
// document (the admin may have edited other modules meanwhile).
async function runModule(courseId, moduleId) {
  const setStatus = async (patch) => {
    const c = await Course.findById(courseId);
    if (!c) return null;
    const m = c.modules.id(moduleId);
    if (!m) return null;
    Object.assign(m, patch);
    await c.save();
    return m;
  };

  const course = await Course.findById(courseId);
  const mod = course && course.modules.id(moduleId);
  if (!mod || mod.type !== 'video' || !mod.driveFileId) return;

  // No shared rendition storage configured → don't transcode; the player shows
  // Source only. Leave status untouched so it isn't stuck as failed/pending.
  if (!renditionStore.enabled()) {
    await setStatus({ transcodeStatus: 'none' });
    return;
  }

  const fileId = mod.driveFileId;
  await setStatus({ transcodeStatus: 'processing', transcodeError: undefined });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lms-transcode-'));
  const srcPath = path.join(tmpDir, `src-${crypto.randomBytes(4).toString('hex')}`);
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } };

  try {
    await downloadDriveFileTo(fileId, srcPath);
    const { height: sourceHeight, durationSec } = await probe(srcPath);

    const heights = TARGET_HEIGHTS.filter((h) => sourceHeight === 0 || h < sourceHeight);
    const renditions = [];
    for (const h of heights) {
      const outPath = path.join(tmpDir, `${h}p.mp4`);
      // eslint-disable-next-line no-await-in-loop
      await encodeOne(srcPath, outPath, h);
      // Upload to shared Cloud Storage at a deterministic key so any host serves
      // (and any host can regenerate) the same file.
      // eslint-disable-next-line no-await-in-loop
      const { objectPath, sizeBytes } = await renditionStore.upload(moduleId, h, outPath);
      renditions.push({
        height: h,
        label: `${h}p`,
        storagePath: objectPath,
        store: 'gcs',
        sizeBytes,
        bitrateKbps: durationSec ? Math.round((sizeBytes * 8) / 1000 / durationSec) : 0,
      });
    }

    await setStatus({
      renditions,
      sourceHeight,
      transcodedFrom: fileId,
      transcodeStatus: 'ready',
      transcodeError: undefined,
      ...(durationSec && !mod.durationSec ? { durationSec } : {}),
    });
  } catch (err) {
    await setStatus({ transcodeStatus: 'failed', transcodeError: String(err.message || err).slice(0, 500) });
  } finally {
    cleanup();
  }
}

// ---- simple sequential queue ------------------------------------------------
const queue = [];
let running = false;

async function drain() {
  if (running) return;
  running = true;
  while (queue.length) {
    const { courseId, moduleId } = queue.shift();
    try {
      // eslint-disable-next-line no-await-in-loop
      await runModule(courseId, moduleId);
    } catch (err) {
      // runModule already records failures on the module; this guards the loop.
      // eslint-disable-next-line no-console
      console.error('[videoTranscode] job failed', err);
    }
  }
  running = false;
}

// Enqueue a module for (re)transcoding. Deduped so the same module isn't queued
// twice. Marks it 'pending' immediately so the UI reflects the queued state.
async function enqueueModule(courseId, moduleId) {
  const key = `${courseId}:${moduleId}`;
  if (queue.some((j) => `${j.courseId}:${j.moduleId}` === key)) return;
  queue.push({ courseId: String(courseId), moduleId: String(moduleId) });
  try {
    const c = await Course.findById(courseId);
    const m = c && c.modules.id(moduleId);
    if (m && m.transcodeStatus !== 'processing') {
      m.transcodeStatus = 'pending';
      await c.save();
    }
  } catch { /* best effort */ }
  drain();
}

// True when every recorded rendition lives in shared Cloud Storage (durable, so
// no per-request existence check is needed). Legacy 'local' renditions count as
// NOT present so they get rebuilt into GCS. A module with no renditions (source
// already low-res) counts as present.
function renditionsPresent(mod) {
  const rs = (mod && mod.renditions) || [];
  return rs.every((r) => r.store === 'gcs');
}

// Decide whether a video module needs (re)transcoding: it has a Drive source and
// either was never transcoded, the Drive file changed, OR its renditions aren't
// in shared storage yet (legacy local/random-path renditions from before GCS).
function needsTranscode(mod) {
  if (!mod || mod.type !== 'video' || !mod.driveFileId) return false;
  if (!renditionStore.enabled()) return false; // can't store renditions → nothing to do
  if (mod.transcodeStatus === 'processing' || mod.transcodeStatus === 'pending') return false;
  if (mod.transcodedFrom !== mod.driveFileId) return true;
  return !renditionsPresent(mod);
}

// Scan a course and enqueue every video module that needs it.
async function enqueueCourse(course) {
  if (!course) return;
  for (const mod of course.modules || []) {
    if (needsTranscode(mod)) {
      // eslint-disable-next-line no-await-in-loop
      await enqueueModule(course._id, mod._id);
    }
  }
}

module.exports = { enqueueModule, enqueueCourse, needsTranscode, renditionsPresent, TARGET_HEIGHTS };
