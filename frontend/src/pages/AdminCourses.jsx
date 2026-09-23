/**
 * AdminCourses — LMS course authoring & administration (admin portal). Lists
 * courses from GET /courses/admin/all and CRUDs them via /courses, with a module
 * editor that uploads videos directly to Cloudinary (signed via
 * /courses/upload-signature) or accepts Drive links, and pins as many
 * timestamped questions inside a video as the author wants (CheckpointEditor).
 * Side modals handle assign, roster, the in-video answer log
 * (/courses/:id/checkpoint-answers), self-enroll approvals, issue reports,
 * public-share leads/feedback and comment moderation, each hitting the relevant
 * /courses/* endpoint.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { useViewOnly } from '../hooks/useViewOnly';
import CourseVideoPlayer from '../components/CourseVideoPlayer';
import { confirmDialog } from '../components/dialogs';
import { downloadTableXlsx } from '../api/download';
import { fmtClock, parseClock } from '../utils/checkpoints';

const CATEGORIES = ['Technical', 'Soft Skills', 'Compliance', 'Leadership', 'Onboarding', 'Other'];
// THERE IS NO SIZE LIMIT OF OUR OWN ON A COURSE VIDEO. A lesson can be as big as
// the Cloudinary plan allows. What remains is a protocol rule, not a policy one:
// Cloudinary's upload endpoint accepts 100 MB in ONE request and refuses
// anything larger, so a bigger file goes up as a run of chunks tied together by
// a shared X-Unique-Upload-Id. 20 MB is Cloudinary's own default chunk, and
// every chunk but the last must be over 5 MB. The phone uses the same two
// numbers (mobile CoursesAdminScreen).
const SINGLE_REQUEST_MAX = 100 * 1024 * 1024;
const CHUNK_BYTES = 20 * 1024 * 1024;

// Mirror of backend utils/drive.parseDriveFileId for live link validation.
const parseDriveId = (input) => {
  if (!input) return null;
  const s = String(input).trim();
  return (
    s.match(/\/file\/d\/([a-zA-Z0-9_-]{10,})/)?.[1] ||
    s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/)?.[1] ||
    s.match(/\/d\/([a-zA-Z0-9_-]{10,})/)?.[1] ||
    (/^[a-zA-Z0-9_-]{10,}$/.test(s) ? s : null)
  );
};

const blankModule = () => ({ type: 'video', videoSource: 'cloudinary', title: '', driveUrl: '', cloudinaryPublicId: '', content: '', checkpoints: [] });
// A new in-video question. `_clock` is the "1:30" the author types; atSec is what
// gets saved, and the two are kept in step by the timestamp field below.
const blankCheckpoint = () => ({
  atSec: 0, _clock: '0:00', question: '', type: 'single',
  options: [{ text: '', correct: false }, { text: '', correct: false }],
  explanation: '', requireCorrect: true,
});
const blank = () => ({ title: '', description: '', category: 'Other', courseType: 'internal', durationHours: 0, deadlineDays: 0, active: true, modules: [] });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');

// One POST to Cloudinary — the whole file, or one chunk of it. A raw XHR rather
// than the api axios instance, which would attach our JWT + baseURL to somebody
// else's host. The signed fields are repeated on EVERY chunk: Cloudinary
// validates each request on its own, and it is the two headers, not the body,
// that tie a run of chunks into one asset.
function postToCloudinary({ sig, blob, fileName, uploadId, start, total }, onLoaded) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', blob, fileName);
    fd.append('api_key', sig.apiKey);
    fd.append('timestamp', sig.timestamp);
    fd.append('signature', sig.signature);
    fd.append('folder', sig.folder);
    fd.append('type', sig.type);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', sig.uploadUrl);
    if (uploadId) {
      // Neither header is on the browser's forbidden list, so both go out as
      // written. The end offset is INCLUSIVE — off by one here and Cloudinary
      // answers "Chunk size doesn't match upload size".
      xhr.setRequestHeader('X-Unique-Upload-Id', uploadId);
      xhr.setRequestHeader('Content-Range', `bytes ${start}-${start + blob.size - 1}/${total}`);
    }
    xhr.upload.onprogress = (e) => {
      // Progress is reported against the WHOLE file, not this chunk, so the bar
      // climbs once from 0 to 100 however many requests it takes.
      if (e.lengthComputable) onLoaded(start + e.loaded);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error('Unexpected upload response')); }
      } else {
        let msg = `Upload failed (${xhr.status})`;
        try { msg = JSON.parse(xhr.responseText)?.error?.message || msg; } catch { /* keep default */ }
        reject(new Error(msg));
      }
    };
    // Cloudinary cuts the connection rather than answering when a file is over
    // the ACCOUNT's ceiling — which chunking does not lift, it only lifts the
    // per-request one. So a bare "network error" still often means too big.
    xhr.onerror = () => reject(new Error(
      'The upload could not reach Cloudinary. That is usually this network or a browser extension '
      + 'blocking it — or the file being larger than the Cloudinary plan itself allows.'
    ));
    xhr.onabort = () => reject(new Error('Upload cancelled.'));
    xhr.send(fd);
  });
}

/**
 * Direct browser → Cloudinary signed upload, in chunks once the file is past the
 * endpoint's per-request ceiling. Resolves with the parsed Cloudinary response
 * ({ public_id, version, format, bytes, ... }).
 *
 * ONE signature covers the whole run, which is what Cloudinary's own SDKs do for
 * upload_large. The practical consequence: a signature is good for an hour, so
 * an upload slow enough to run past that would fail part-way rather than at the
 * start. Re-minting per chunk is not worth the round trip until that shows up.
 */
async function uploadToCloudinary(sig, file, onProgress) {
  const total = file.size;
  const report = (loaded) => onProgress(Math.min(100, Math.round((loaded / total) * 100)));

  if (total <= SINGLE_REQUEST_MAX) {
    return postToCloudinary({ sig, blob: file, fileName: file.name, start: 0, total }, report);
  }

  // Sent strictly one at a time. Cloudinary assembles the asset from the ranges
  // as they land, and firing them in parallel only races that assembly.
  const uploadId = `hrms-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  let last = null;
  for (let start = 0; start < total; start += CHUNK_BYTES) {
    const blob = file.slice(start, Math.min(start + CHUNK_BYTES, total));
    // eslint-disable-next-line no-await-in-loop
    last = await postToCloudinary({ sig, blob, fileName: file.name, uploadId, start, total }, report);
  }
  // Every chunk but the last answers `{ done: false }`; the last answers with
  // the asset. No public_id means Cloudinary took the bytes but never finished
  // the file — saving that onto the lesson would give it a video id that plays
  // nothing.
  if (!last?.public_id) {
    throw new Error('Cloudinary accepted the video but did not finish assembling it. Please upload it again.');
  }
  return last;
}

const fmtBytes = (n) => {
  if (!n) return '';
  const mb = n / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
};

export default function AdminCourses() {
  // A view-only account browses the catalogue and changes nothing in it.
  const viewOnly = useViewOnly();
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Editor
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);
  const [previewModIdx, setPreviewModIdx] = useState(null);

  // Assign / roster / approvals / reports / public sharing
  const [assignFor, setAssignFor] = useState(null); // course
  const [rosterFor, setRosterFor] = useState(null); // course
  const [showApprovals, setShowApprovals] = useState(false);
  const [showReports, setShowReports] = useState(false);
  const [shareFor, setShareFor] = useState(null); // course (share/leads/feedback hub)
  const [answersFor, setAnswersFor] = useState(null); // course (in-video question log)
  const [showComments, setShowComments] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/courses/admin/all');
      setCourses(data.courses);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Open the panel a notification deep-linked to (e.g. /admin/courses?panel=reports).
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const panel = searchParams.get('panel');
    if (!panel) return;
    if (panel === 'approvals') setShowApprovals(true);
    else if (panel === 'reports') setShowReports(true);
    else if (panel === 'comments') setShowComments(true);
    // Clear the param so re-navigating/closing doesn't re-trigger it.
    searchParams.delete('panel');
    setSearchParams(searchParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingTotal = useMemo(() => courses.reduce((n, c) => n + (c.pendingCount || 0), 0), [courses]);
  const reportsTotal = useMemo(() => courses.reduce((n, c) => n + (c.openReportsCount || 0), 0), [courses]);
  const commentsTotal = useMemo(() => courses.reduce((n, c) => n + (c.pendingCommentsCount || 0), 0), [courses]);

  const openCreate = () => { setEditingId(null); setForm(blank()); setPreviewModIdx(null); setShowModal(true); };
  const openEdit = (c) => {
    setEditingId(c._id);
    setForm({
      title: c.title,
      description: c.description || '',
      category: c.category,
      courseType: c.courseType || (c.isPublic ? 'external' : 'internal'),
      durationHours: c.durationHours || 0,
      deadlineDays: c.deadlineDays || 0,
      active: c.active,
      modules: (c.modules || []).map((m) => ({
        _id: m._id,
        type: m.type || 'video',
        title: m.title || '',
        videoSource: m.videoSource || (m.cloudinaryPublicId ? 'cloudinary' : 'drive'),
        driveUrl: m.driveUrl || m.url || '',
        cloudinaryPublicId: m.cloudinaryPublicId || '',
        cloudinaryVersion: m.cloudinaryVersion || undefined,
        cloudinaryFormat: m.cloudinaryFormat || '',
        videoSizeBytes: m.videoSizeBytes || 0,
        // Carried through, not dropped: the server rewrites the whole module
        // list on save, so a field we don't send back is a field we erase.
        durationSec: m.durationSec || 0,
        checkpoints: (m.checkpoints || []).map((c) => ({
          _id: c._id,
          atSec: c.atSec || 0,
          _clock: fmtClock(c.atSec || 0),
          question: c.question || '',
          type: c.type || 'single',
          options: (c.options || []).map((o) => ({ text: o.text || '', correct: !!o.correct })),
          explanation: c.explanation || '',
          requireCorrect: c.requireCorrect !== false,
        })),
        content: m.content || '',
      })),
    });
    setPreviewModIdx(null);
    setShowModal(true);
  };

  const addModule = () => setForm((f) => ({ ...f, modules: [...f.modules, blankModule()] }));
  const removeModule = (idx) => setForm((f) => ({ ...f, modules: f.modules.filter((_, i) => i !== idx) }));
  const updateModule = (idx, field, value) =>
    setForm((f) => ({ ...f, modules: f.modules.map((m, i) => (i === idx ? { ...m, [field]: value } : m)) }));
  const patchModule = (idx, patch) =>
    setForm((f) => ({ ...f, modules: f.modules.map((m, i) => (i === idx ? { ...m, ...patch } : m)) }));

  // Upload a picked video file straight to Cloudinary, tracking progress on the
  // module, then store the resulting asset ids on it.
  const onPickVideo = async (idx, file) => {
    if (!file) return;
    if (!/^video\//i.test(file.type || '')) {
      patchModule(idx, { _uploadError: 'Please choose a video file.' });
      return;
    }
    patchModule(idx, { _uploadPct: 0, _uploadError: '' });
    try {
      const { data: sig } = await api.post('/courses/upload-signature');
      const result = await uploadToCloudinary(sig, file, (pct) => patchModule(idx, { _uploadPct: pct }));
      patchModule(idx, {
        cloudinaryPublicId: result.public_id,
        cloudinaryVersion: result.version,
        cloudinaryFormat: result.format,
        videoSizeBytes: result.bytes || file.size,
        // Cloudinary reports the length of a video it has just taken. It is the
        // only moment we learn it for free, and the question timeline below has
        // nothing to scale itself against without it.
        durationSec: Math.round(Number(result.duration) || 0) || undefined,
        _uploadName: file.name,
        _uploadPct: null,
      });
    } catch (err) {
      patchModule(idx, { _uploadPct: null, _uploadError: err.response?.data?.message || err.message || 'Upload failed' });
    }
  };

  const save = async (e) => {
    e.preventDefault();
    // A large lesson uploads for minutes with the Save button sitting right
    // there. Without this the save goes through with the asset id still empty
    // and the author is told the lesson has no video — which reads as the upload
    // having failed, when it is still running.
    const uploadingIdx = form.modules.findIndex((m) => m._uploadPct !== null && m._uploadPct !== undefined);
    if (uploadingIdx >= 0) {
      setError(`Module ${uploadingIdx + 1} is ${form.modules[uploadingIdx]._uploadPct}% uploaded. Wait for it to finish.`);
      return;
    }
    // Client-side guard: every video module needs a source — an uploaded
    // Cloudinary asset, or a resolvable Drive link.
    const badVideo = form.modules.findIndex((m) => {
      if (m.type !== 'video') return false;
      return m.videoSource === 'cloudinary' ? !m.cloudinaryPublicId : !parseDriveId(m.driveUrl);
    });
    if (badVideo >= 0) {
      const m = form.modules[badVideo];
      setError(`Module ${badVideo + 1}: ${m.videoSource === 'cloudinary' ? 'upload a video file.' : 'enter a valid Google Drive video link.'}`);
      return;
    }
    // In-video questions: the server checks these too, but catching them here
    // saves a round trip and points at the exact question.
    for (let i = 0; i < form.modules.length; i += 1) {
      const cps = form.modules[i].checkpoints || [];
      for (let j = 0; j < cps.length; j += 1) {
        const c = cps[j];
        const where = `Module ${i + 1}, question ${j + 1} (${fmtClock(c.atSec)})`;
        if (!String(c.question || '').trim()) { setError(`${where}: type the question.`); return; }
        const filled = (c.options || []).filter((o) => String(o.text || '').trim());
        if (c.type !== 'text' && filled.length < 2) { setError(`${where}: add at least two answer choices.`); return; }
        if (c.type === 'single' && filled.filter((o) => o.correct).length > 1) {
          setError(`${where}: a single-choice question can only have one right answer.`); return;
        }
      }
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...form,
        durationHours: Number(form.durationHours) || 0,
        deadlineDays: Number(form.deadlineDays) || 0,
      };
      if (editingId) await api.put(`/courses/${editingId}`, payload);
      else await api.post('/courses', payload);
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c) => {
    if (!(await confirmDialog({ message: `Delete course "${c.title}"? This also removes all enrollments.`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/courses/${c._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Courses" subtitle="Learning & development catalog">
        <div className="flex items-center gap-2">
          <button onClick={() => setShowApprovals(true)}
            className="relative px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50 text-sm">
            Approvals
            {pendingTotal > 0 && (
              <span className="ml-1 inline-flex items-center justify-center text-[11px] font-semibold bg-amber-500 text-white rounded-full px-1.5 py-0.5">{pendingTotal}</span>
            )}
          </button>
          <button onClick={() => setShowReports(true)}
            className="relative px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50 text-sm">
            Reports
            {reportsTotal > 0 && (
              <span className="ml-1 inline-flex items-center justify-center text-[11px] font-semibold bg-red-500 text-white rounded-full px-1.5 py-0.5">{reportsTotal}</span>
            )}
          </button>
          <button onClick={() => setShowComments(true)}
            className="relative px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50 text-sm">
            Comments
            {commentsTotal > 0 && (
              <span className="ml-1 inline-flex items-center justify-center text-[11px] font-semibold bg-indigo-500 text-white rounded-full px-1.5 py-0.5">{commentsTotal}</span>
            )}
          </button>
          {!viewOnly && (
            <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Course</button>
          )}
        </div>
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <div className="space-y-2 py-1"><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-4 rounded w-2/3" /></div>
      ) : courses.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-10 text-center text-gray-500">No courses yet. Create your first course.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {courses.map((c) => (
            <div key={c._id} className="bg-white shadow rounded-xl p-5 flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900 truncate">{c.title}</div>
                  <div className="text-xs text-gray-400 mt-0.5">{c.category}{c.durationHours ? ` · ${c.durationHours}h` : ''}</div>
                </div>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-lg ${c.active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                  {c.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              {c.description && <p className="text-sm text-gray-600 mt-2 line-clamp-2">{c.description}</p>}

              <div className="flex flex-wrap gap-1.5 mt-3 text-[11px]">
                {(c.courseType === 'external' || c.isPublic) ? (
                  <span className="bg-emerald-50 text-emerald-700 rounded-md px-2 py-0.5">🌐 External</span>
                ) : (
                  <span className="bg-gray-100 text-gray-600 rounded-md px-2 py-0.5">🏢 Internal</span>
                )}
                <span className="bg-gray-100 text-gray-700 rounded-md px-2 py-0.5">🎬 {c.videoCount} video{c.videoCount === 1 ? '' : 's'}</span>
                {c.moduleCount - c.videoCount > 0 && (
                  <span className="bg-gray-100 text-gray-700 rounded-md px-2 py-0.5">📄 {c.moduleCount - c.videoCount} text</span>
                )}
                {c.questionCount > 0 && (
                  <span className="bg-purple-50 text-purple-700 rounded-md px-2 py-0.5">❓ {c.questionCount} question{c.questionCount === 1 ? '' : 's'}</span>
                )}
                <span className="bg-blue-50 text-blue-700 rounded-md px-2 py-0.5">👥 {c.enrollmentCount} enrolled</span>
                <span className="bg-green-50 text-green-700 rounded-md px-2 py-0.5">✓ {c.completedCount} done</span>
                {c.overdueCount > 0 && <span className="bg-red-50 text-red-700 rounded-md px-2 py-0.5">⏰ {c.overdueCount} overdue</span>}
                {c.pendingCount > 0 && <span className="bg-amber-50 text-amber-700 rounded-md px-2 py-0.5">⏳ {c.pendingCount} pending</span>}
                {c.openReportsCount > 0 && <span className="bg-red-50 text-red-700 rounded-md px-2 py-0.5">⚠ {c.openReportsCount} report{c.openReportsCount === 1 ? '' : 's'}</span>}
              </div>

              <div className="text-xs text-gray-400 mt-3">
                {c.deadlineDays > 0 ? `Deadline: ${c.deadlineDays} days after enrollment` : 'No deadline'}
              </div>

              <div className="mt-4 pt-3 border-t border-gray-100 flex flex-wrap gap-3 text-sm">
                {!viewOnly && (
                  <>
                    <button onClick={() => openEdit(c)} className="text-blue-600 hover:underline">Edit</button>
                    <button onClick={() => setAssignFor(c)} className="text-indigo-600 hover:underline">Assign</button>
                  </>
                )}
                <button onClick={() => setRosterFor(c)} className="text-gray-600 hover:underline">Roster</button>
                {c.questionCount > 0 && (
                  <button onClick={() => setAnswersFor(c)} className="text-purple-600 hover:underline">Answers</button>
                )}
                {(c.courseType === 'external' || c.isPublic) && (
                  <button onClick={() => setShareFor(c)} className="text-emerald-600 hover:underline">Public link</button>
                )}
                {!viewOnly && (
                  <button onClick={() => remove(c)} className="text-red-600 hover:underline ml-auto">Delete</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ===== Editor ===== */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Course' : 'New Course'}</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Title *</label>
                <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Course type</label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {[
                    ['internal', '🏢 Internal', 'Only your employees - shows in their catalog, assignable.'],
                    ['external', '🌐 External', 'Public no-login link - anyone can watch after a short form.'],
                  ].map(([val, label, hint]) => (
                    <button type="button" key={val} onClick={() => setForm({ ...form, courseType: val })}
                      className={`text-left border rounded-lg px-3 py-2 ${form.courseType === val ? 'border-gray-900 ring-1 ring-gray-900 bg-gray-50' : 'hover:bg-gray-50'}`}>
                      <div className="text-sm font-medium text-gray-800">{label}</div>
                      <div className="text-[11px] text-gray-500 mt-0.5">{hint}</div>
                    </button>
                  ))}
                </div>
                {editingId && form.courseType === 'external' && (
                  <div className="text-[11px] text-gray-400 mt-1">Save, then use “Public link” on the card to copy the shareable URL.</div>
                )}
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Category</label>
                  <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                    {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Duration (hours)</label>
                  <input type="number" min="0" value={form.durationHours} onChange={(e) => setForm({ ...form, durationHours: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Deadline (days)</label>
                  <input type="number" min="0" value={form.deadlineDays} onChange={(e) => setForm({ ...form, deadlineDays: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                Active (visible in the catalog)
              </label>

              <div className="border-t pt-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-700">Modules</span>
                  <button type="button" onClick={addModule} className="text-sm text-blue-600 hover:underline">+ Add module</button>
                </div>
                {form.modules.length === 0 ? (
                  <p className="text-xs text-gray-400">No modules yet.</p>
                ) : (
                  <div className="space-y-3">
                    {form.modules.map((m, idx) => {
                      const isCloud = m.videoSource === 'cloudinary';
                      const fileId = m.type === 'video' && !isCloud ? parseDriveId(m.driveUrl) : null;
                      const hasVideo = m.type === 'video' && (isCloud ? !!m.cloudinaryPublicId : !!fileId);
                      const canPreview = editingId && m._id && hasVideo;
                      const uploading = m._uploadPct !== null && m._uploadPct !== undefined;
                      return (
                        <div key={idx} className="border rounded-lg p-3 space-y-2 bg-gray-50/50">
                          <div className="flex items-center justify-between gap-2">
                            <div className="inline-flex rounded-lg border bg-white overflow-hidden text-xs">
                              {['video', 'text'].map((t) => (
                                <button key={t} type="button" onClick={() => updateModule(idx, 'type', t)}
                                  className={`px-3 py-1.5 ${m.type === t ? 'bg-gray-900 text-white' : 'text-gray-600'}`}>
                                  {t === 'video' ? '🎬 Video' : '📄 Text'}
                                </button>
                              ))}
                            </div>
                            <button type="button" onClick={() => removeModule(idx)} className="text-xs text-red-600 hover:underline">Remove</button>
                          </div>
                          <input required placeholder={`Module ${idx + 1} title *`} value={m.title} onChange={(e) => updateModule(idx, 'title', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                          {m.type === 'video' ? (
                            <>
                              {/* Source: upload to Cloudinary, or paste a Drive link */}
                              <div className="inline-flex rounded-lg border bg-white overflow-hidden text-xs">
                                {[['cloudinary', '⬆ Upload'], ['drive', '🔗 Drive link']].map(([src, label]) => (
                                  <button key={src} type="button" onClick={() => updateModule(idx, 'videoSource', src)}
                                    className={`px-3 py-1.5 ${m.videoSource === src ? 'bg-gray-900 text-white' : 'text-gray-600'}`}>
                                    {label}
                                  </button>
                                ))}
                              </div>

                              {isCloud ? (
                                <div className="space-y-1.5">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <label className="px-3 py-2 text-sm border rounded-lg cursor-pointer hover:bg-gray-50">
                                      {m.cloudinaryPublicId ? 'Replace video…' : 'Choose video file…'}
                                      <input type="file" accept="video/*" className="hidden" disabled={uploading}
                                        onChange={(e) => { onPickVideo(idx, e.target.files?.[0]); e.target.value = ''; }} />
                                    </label>
                                    {m.cloudinaryPublicId && !uploading && (
                                      <span className="text-green-600 text-xs">
                                        ✓ Uploaded{m._uploadName ? ` - ${m._uploadName}` : ''}{m.videoSizeBytes ? ` (${fmtBytes(m.videoSizeBytes)})` : ''}
                                      </span>
                                    )}
                                  </div>
                                  {uploading && (
                                    <div>
                                      <div className="h-2 bg-gray-100 rounded overflow-hidden">
                                        <div className="h-2 accent-bg rounded transition-all" style={{ width: `${m._uploadPct}%` }} />
                                      </div>
                                      <div className="text-[11px] text-gray-500 mt-0.5">Uploading… {m._uploadPct}%</div>
                                    </div>
                                  )}
                                  {m._uploadError && <div className="text-xs text-red-600">✗ {m._uploadError}</div>}
                                  {!m.cloudinaryPublicId && !uploading && !m._uploadError && (
                                    <div className="text-xs text-gray-400">MP4/MOV/WebM, any size. Uploads straight to Cloudinary (private); anything large goes up in chunks.</div>
                                  )}
                                </div>
                              ) : (
                                <>
                                  <input placeholder="Google Drive video link" value={m.driveUrl} onChange={(e) => updateModule(idx, 'driveUrl', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                                  <div className="text-xs">
                                    {m.driveUrl ? (
                                      fileId
                                        ? <span className="text-green-600">✓ Valid Drive link</span>
                                        : <span className="text-red-600">✗ Not a recognizable Drive link</span>
                                    ) : <span className="text-gray-400">Paste a “Anyone with the link” Drive video URL</span>}
                                  </div>
                                </>
                              )}

                              {canPreview && (
                                <div className="text-xs text-right">
                                  <button type="button" onClick={() => setPreviewModIdx(previewModIdx === idx ? null : idx)} className="text-blue-600 hover:underline">
                                    {previewModIdx === idx ? 'Hide preview' : 'Preview'}
                                  </button>
                                </div>
                              )}
                              {canPreview && previewModIdx === idx && (
                                <CourseVideoPlayer
                                  courseId={editingId}
                                  module={{ _id: m._id, title: m.title, checkpoints: (m.checkpoints || []).filter((c) => c._id) }}
                                  preview
                                  // Lessons uploaded before the length was being
                                  // recorded have none, and the timeline cannot
                                  // scale without one. Opening the preview is the
                                  // one place the browser learns it. Only ever
                                  // filled into a blank, so this cannot loop.
                                  onDuration={(sec) => {
                                    if (!m.durationSec) patchModule(idx, { durationSec: Math.round(sec) });
                                  }}
                                />
                              )}
                              <textarea rows={2} placeholder="Notes shown under the video (optional)" value={m.content} onChange={(e) => updateModule(idx, 'content', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                              <CheckpointEditor
                                checkpoints={m.checkpoints || []}
                                durationSec={m.durationSec || 0}
                                onChange={(next) => updateModule(idx, 'checkpoints', next)}
                              />
                            </>
                          ) : (
                            <textarea rows={4} placeholder="Text content" value={m.content} onChange={(e) => updateModule(idx, 'content', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {assignFor && <AssignModal course={assignFor} onClose={() => setAssignFor(null)} onDone={() => { setAssignFor(null); load(); }} />}
      {rosterFor && <RosterModal course={rosterFor} onClose={() => setRosterFor(null)} />}
      {answersFor && <AnswersModal course={answersFor} onClose={() => setAnswersFor(null)} />}
      {showApprovals && <ApprovalsModal onClose={() => setShowApprovals(false)} onChange={load} />}
      {showReports && <ReportsModal onClose={() => setShowReports(false)} onChange={load} />}
      {shareFor && <ShareModal course={shareFor} onClose={() => setShareFor(null)} onChange={load} />}
      {showComments && <CommentsModal onClose={() => setShowComments(false)} onChange={load} />}
    </div>
  );
}

// ===== In-video questions for one video lesson =====
// Questions the learner has to answer before the video will go on. As many as
// you like, at any timestamp. A question with no right answer marked is a poll:
// it's still compulsory, the answer is still logged, but anything gets them
// through. Controlled: takes the array, hands back a new one.
const QUESTION_TYPES = [
  ['single', 'One answer'],
  ['multiple', 'Choose all that apply'],
  ['text', 'Type the answer'],
];

/**
 * The lesson drawn to scale, with a yellow tick wherever a question is pinned.
 *
 * Typing "7:20" into a box tells an author nothing about whether the questions
 * are spread through the lesson or bunched in the first minute of it. This is the
 * one view that does. Clicking a tick jumps to that question's card.
 *
 * A tick sitting PAST the end of the video is drawn red at the far right rather
 * than quietly clamped: the player only raises such a question when the video
 * ends, which is almost never what the author meant.
 */
function QuestionTimeline({ durationSec, checkpoints, focusIdx, onPick }) {
  const known = Number(durationSec) > 0;
  const marks = (checkpoints || []).map((c, i) => ({ i, at: Math.max(0, Number(c.atSec) || 0), q: c.question }));
  const latest = marks.reduce((n, m) => Math.max(n, m.at), 0);
  // With no recorded length the bar is scaled to the last question plus a
  // quarter of headroom. The spacing between ticks is still true; only the end
  // is a guess, and the caption says so rather than drawing a length we'd be
  // inventing.
  const span = known ? Number(durationSec) : Math.max(latest * 1.25, 60);

  return (
    <div className="mt-2.5">
      <div className="relative h-7">
        <div className="absolute inset-x-0 top-2.5 h-2 rounded-full bg-gray-200" />
        {marks.map((m) => {
          const over = known && m.at > span;
          const pct = Math.min(100, Math.max(0, (m.at / span) * 100));
          return (
            <button
              key={m.i}
              type="button"
              onClick={() => onPick(m.i)}
              style={{ left: `${pct}%` }}
              title={`${fmtClock(m.at)}${m.q ? ` — ${m.q}` : ''}${over ? ' (after the video ends)' : ''}`}
              className="absolute top-0 -translate-x-1/2 h-7 w-4 flex items-center justify-center"
            >
              <span className={`block w-1.5 rounded-sm ${focusIdx === m.i ? 'h-6' : 'h-5'} ${
                over ? 'bg-red-500 ring-1 ring-red-700' : 'bg-amber-400 ring-1 ring-amber-600'
              }`} />
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-gray-400 -mt-0.5">
        <span>0:00</span>
        <span>
          {known
            ? `${fmtClock(span)} · tap a marker to jump to its question`
            : 'Video length not recorded — scaled to the last question. Open Preview to measure it.'}
        </span>
      </div>
    </div>
  );
}

function CheckpointEditor({ checkpoints, durationSec = 0, onChange }) {
  // Which question the author last picked off the timeline: it gets a ring and
  // is scrolled to. Purely a pointer, never saved.
  const [focusIdx, setFocusIdx] = useState(null);
  const cardRefs = useRef([]);

  const patch = (i, p) => onChange(checkpoints.map((c, n) => (n === i ? { ...c, ...p } : c)));
  const patchOpt = (i, oi, p) => patch(i, {
    options: (checkpoints[i].options || []).map((o, n) => (n === oi ? { ...o, ...p } : o)),
  });
  const pick = (i) => {
    setFocusIdx(i);
    cardRefs.current[i]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };

  return (
    <div className="border border-dashed border-gray-300 rounded-lg p-3 bg-white">
      {/* Wraps on a phone, where "+ Add question" was squeezed onto two lines. */}
      <div className="flex flex-wrap items-center justify-between gap-1 sm:flex-nowrap sm:gap-0">
        <span className="text-xs font-medium text-gray-700">
          ❓ Questions in this video
          {checkpoints.length > 0 && <span className="text-gray-400 font-normal"> · {checkpoints.length}</span>}
        </span>
        <button type="button" onClick={() => onChange([...checkpoints, blankCheckpoint()])}
          className="text-xs text-blue-600 hover:underline">+ Add question</button>
      </div>

      {checkpoints.length > 0 && (
        <QuestionTimeline
          durationSec={durationSec}
          checkpoints={checkpoints}
          focusIdx={focusIdx}
          onPick={pick}
        />
      )}

      {checkpoints.length === 0 ? (
        <p className="text-[11px] text-gray-400 mt-1">
          None yet. A question pauses the video at its timestamp — the learner can’t carry on until they answer it.
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {checkpoints.map((c, i) => {
            const graded = (c.options || []).some((o) => o.correct && String(o.text || '').trim());
            return (
              <div
                key={i}
                ref={(el) => { cardRefs.current[i] = el; }}
                className={`border rounded-lg p-3 bg-gray-50/60 space-y-2 ${
                  focusIdx === i ? 'ring-2 ring-amber-400 border-amber-300' : ''
                }`}
              >
                {/* Wraps on a phone: this row needs ~330px and the question
                    card has ~215, which crushed the hint to one letter a line. */}
                <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <span className="text-xs text-gray-500 shrink-0">Pause at</span>
                  <input
                    value={c._clock ?? fmtClock(c.atSec)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      const secs = parseClock(raw);
                      patch(i, secs === null ? { _clock: raw } : { _clock: raw, atSec: secs });
                    }}
                    onBlur={() => patch(i, { _clock: fmtClock(c.atSec) })}
                    placeholder="m:ss"
                    className="w-24 border rounded-lg px-2 py-1.5 text-sm text-center"
                  />
                  <span className="text-[11px] text-gray-400">m:ss into the video</span>
                  <button type="button" onClick={() => onChange(checkpoints.filter((_, n) => n !== i))}
                    className="ml-auto text-xs text-red-600 hover:underline">Remove</button>
                </div>

                <textarea rows={2} value={c.question} onChange={(e) => patch(i, { question: e.target.value })}
                  placeholder="The question *" className="block w-full border rounded-lg px-3 py-2 text-sm" />

                <div className="inline-flex rounded-lg border bg-white overflow-hidden text-xs">
                  {QUESTION_TYPES.map(([val, label]) => (
                    <button key={val} type="button" onClick={() => patch(i, { type: val })}
                      className={`px-3 py-1.5 ${c.type === val ? 'bg-gray-900 text-white' : 'text-gray-600'}`}>{label}</button>
                  ))}
                </div>

                {c.type === 'text' ? (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-gray-500">
                      Accepted answers (case and spacing are ignored). Leave empty to accept anything.
                    </div>
                    {(c.options || []).map((o, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <input value={o.text} onChange={(e) => patchOpt(i, oi, { text: e.target.value, correct: true })}
                          placeholder="An answer you'd accept" className="flex-1 min-w-0 border rounded-lg px-3 py-1.5 text-sm" />
                        <button type="button" onClick={() => patch(i, { options: c.options.filter((_, n) => n !== oi) })}
                          className="text-xs text-gray-400 hover:text-red-600">✕</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => patch(i, { options: [...(c.options || []), { text: '', correct: true }] })}
                      className="text-xs text-blue-600 hover:underline">+ Add an accepted answer</button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-gray-500">
                      Tick the right answer{c.type === 'multiple' ? 's' : ''}. Tick none and it becomes a poll — still compulsory, but any answer gets them through.
                    </div>
                    {(c.options || []).map((o, oi) => (
                      <div key={oi} className="flex items-center gap-2">
                        <button type="button" title={o.correct ? 'This is the right answer' : 'Mark as the right answer'}
                          onClick={() => {
                            // Single-choice: ticking one unticks the rest.
                            if (c.type === 'single' && !o.correct) {
                              patch(i, { options: c.options.map((x, n) => ({ ...x, correct: n === oi })) });
                            } else {
                              patchOpt(i, oi, { correct: !o.correct });
                            }
                          }}
                          className={`shrink-0 w-6 h-6 rounded-full border flex items-center justify-center text-xs ${
                            o.correct ? 'bg-green-600 border-green-600 text-white' : 'border-gray-300 text-transparent hover:border-green-400'
                          }`}>✓</button>
                        <input value={o.text} onChange={(e) => patchOpt(i, oi, { text: e.target.value })}
                          placeholder={`Choice ${oi + 1}`} className="flex-1 min-w-0 border rounded-lg px-3 py-1.5 text-sm" />
                        <button type="button" onClick={() => patch(i, { options: c.options.filter((_, n) => n !== oi) })}
                          className="text-xs text-gray-400 hover:text-red-600">✕</button>
                      </div>
                    ))}
                    <button type="button" onClick={() => patch(i, { options: [...(c.options || []), { text: '', correct: false }] })}
                      className="text-xs text-blue-600 hover:underline">+ Add choice</button>
                  </div>
                )}

                <input value={c.explanation} onChange={(e) => patch(i, { explanation: e.target.value })}
                  placeholder="Shown after they answer (optional)" className="block w-full border rounded-lg px-3 py-2 text-sm" />

                {graded && (
                  <label className="flex items-center gap-2 text-xs text-gray-600">
                    <input type="checkbox" checked={c.requireCorrect !== false}
                      onChange={(e) => patch(i, { requireCorrect: e.target.checked })} />
                    They must answer it correctly to carry on (otherwise a wrong answer is just recorded)
                  </label>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ===== Assign to employees =====
// Multi-select employees and assign the course (with optional due date).
function AssignModal({ course, onClose, onDone }) {
  const [people, setPeople] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [q, setQ] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/employees').then(({ data }) => {
      setPeople((data.profiles || []).filter((p) => p.user).map((p) => ({
        id: p.user._id,
        name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim() || p.user.email,
        sub: p.designation || p.employeeCode || p.user.email,
      })));
    }).catch((err) => setError(err.response?.data?.message || 'Failed to load employees'));
  }, []);

  const toggle = (id) => setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const filtered = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) || (p.sub || '').toLowerCase().includes(q.toLowerCase()));

  const submit = async () => {
    if (selected.size === 0) { setError('Select at least one employee.'); return; }
    setBusy(true); setError('');
    try {
      await api.post(`/courses/${course._id}/assign`, { employeeIds: [...selected], dueDate: dueDate || undefined });
      onDone();
    } catch (err) {
      setError(err.response?.data?.message || 'Assign failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Assign “${course.title}”`} onClose={onClose}>
      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <div className="mb-3">
        <label className="block text-xs font-medium text-gray-600 mb-1">Due date {course.deadlineDays ? `(default: ${course.deadlineDays} days from now)` : '(optional)'}</label>
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="border rounded-lg px-3 py-2 text-sm" />
      </div>
      <input placeholder="Search employees…" value={q} onChange={(e) => setQ(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm mb-2" />
      <div className="max-h-72 overflow-y-auto border rounded-lg divide-y">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 p-3">No employees.</p>
        ) : filtered.map((p) => (
          <label key={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
            <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
            <div className="min-w-0">
              <div className="text-sm text-gray-900 truncate">{p.name}</div>
              <div className="text-xs text-gray-400 truncate">{p.sub}</div>
            </div>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-between pt-4">
        <span className="text-xs text-gray-500">{selected.size} selected</span>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{busy ? 'Assigning…' : 'Assign'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ===== Roster for one course =====
function RosterModal({ course, onClose }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/courses/${course._id}/enrollments`).then(({ data }) => setRows(data.enrollments))
      .catch((err) => setError(err.response?.data?.message || 'Failed to load'));
  }, [course._id]);

  const badge = (e) => {
    if (e.approvalStatus === 'Pending') return <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">Pending</span>;
    if (e.approvalStatus === 'Rejected') return <span className="text-xs bg-red-100 text-red-700 rounded px-2 py-0.5">Rejected</span>;
    if (e.status === 'Completed') return <span className="text-xs bg-green-100 text-green-800 rounded px-2 py-0.5">Completed</span>;
    if (e.overdue) return <span className="text-xs bg-red-100 text-red-700 rounded px-2 py-0.5">Overdue</span>;
    return <span className="text-xs bg-gray-100 text-gray-700 rounded px-2 py-0.5">{e.status}</span>;
  };

  return (
    <Modal title={`Roster · ${course.title}`} onClose={onClose}>
      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      {!rows ? <div className="space-y-2 py-1"><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-4 rounded w-2/3" /></div> : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No enrollments yet.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto divide-y">
          {rows.map((e) => (
            // On a phone the name takes the first line and the progress + badge
            // the second; beside them it was left ~85px.
            <div key={e._id} className="py-2.5 flex flex-wrap items-center gap-3 sm:flex-nowrap">
              <div className="min-w-0 flex-1 basis-full sm:basis-[0%]">
                <div className="text-sm text-gray-900 truncate">{e.employee ? `${e.employee.firstName || ''} ${e.employee.lastName || ''}`.trim() || e.employee.email : '-'}</div>
                <div className="text-xs text-gray-400">Due {fmtDate(e.dueDate)} · {e.source}</div>
                {e.feedback?.rating && (
                  <div className="text-xs text-amber-600 mt-0.5" title={e.feedback.comment || ''}>
                    {'★'.repeat(e.feedback.rating)}{'☆'.repeat(5 - e.feedback.rating)}
                    {e.feedback.comment ? <span className="text-gray-400"> · “{e.feedback.comment}”</span> : null}
                  </div>
                )}
              </div>
              <div className="w-24">
                <div className="h-1.5 bg-gray-100 rounded"><div className="h-1.5 accent-bg rounded" style={{ width: `${e.progress || 0}%` }} /></div>
                <div className="text-[11px] text-gray-400 text-right mt-0.5">{e.progress || 0}%</div>
              </div>
              {badge(e)}
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end pt-4"><button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button></div>
    </Modal>
  );
}

// ===== In-video question answers =====
// Who answered what, on which question. Two views over the same fetch: the
// per-question roll-up (how many got it right first time), and the raw log —
// one row per ATTEMPT, so a wrong answer followed by a right one shows both.
function AnswersModal({ course, onClose }) {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('questions');
  const [only, setOnly] = useState(''); // '' | wrong | correct
  const [moduleId, setModuleId] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    api.get(`/courses/${course._id}/checkpoint-answers`, {
      params: { only: only || undefined, module: moduleId || undefined },
    })
      .then(({ data: d }) => setData(d))
      .catch((err) => setError(err.response?.data?.message || 'Failed to load'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course._id, only, moduleId]);

  const lessons = useMemo(() => {
    const seen = new Map();
    (data?.questions || []).forEach((q) => { if (!seen.has(String(q.module))) seen.set(String(q.module), q.moduleTitle); });
    return [...seen.entries()];
  }, [data]);

  const who = (a) => a.answeredBy
    || (a.employee ? `${a.employee.firstName || ''} ${a.employee.lastName || ''}`.trim() || a.employee.email : '')
    || a.viewer?.name || 'Someone';

  const exportAnswers = async () => {
    const rows = (data?.answers || []).map((a) => [
      new Date(a.createdAt).toLocaleString('en-IN'),
      who(a),
      a.audience === 'public' ? 'Public viewer' : 'Employee',
      a.employee?.email || a.viewer?.email || a.viewer?.phone || '',
      a.moduleTitle || '',
      fmtClock(a.atSec),
      a.question || '',
      (a.answer || []).join(' | '),
      a.graded ? (a.correct ? 'Correct' : 'Wrong') : 'Not graded',
      a.attempt,
    ]);
    try {
      await downloadTableXlsx({
        filename: `${course.title}-question-answers`,
        sheetName: 'Answers',
        headers: ['When', 'Who', 'Type', 'Contact', 'Lesson', 'At', 'Question', 'Answered', 'Result', 'Attempt'],
        rows,
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not export the answers');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">In-video questions · “{course.title}”</h2>
          <button onClick={onClose} type="button" aria-label="Close" title="Close" className="topbar-icon-btn shrink-0">×</button>
        </div>

        <div className="flex gap-2 border-b mb-3 overflow-x-auto">
          {[['questions', 'By question'], ['log', 'Answer log']].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 whitespace-nowrap ${tab === k ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>{label}</button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-3">
          <select value={moduleId} onChange={(e) => setModuleId(e.target.value)} className="border rounded-lg px-2 py-1.5 text-xs">
            <option value="">All lessons</option>
            {lessons.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </select>
          {tab === 'log' && (
            <>
              {[['', 'All'], ['wrong', 'Wrong only'], ['correct', 'Correct only']].map(([v, label]) => (
                <button key={v || 'all'} onClick={() => setOnly(v)}
                  className={`px-3 py-1.5 text-xs rounded-lg border ${only === v ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50'}`}>{label}</button>
              ))}
              {data?.answers?.length > 0 && (
                <button onClick={exportAnswers} className="ml-auto text-xs text-blue-600 hover:underline">Export Excel</button>
              )}
            </>
          )}
        </div>

        {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

        {!data ? (
          <div className="space-y-2 py-1"><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-4 rounded w-2/3" /></div>
        ) : tab === 'questions' ? (
          (data.questions || []).length === 0 ? (
            <p className="text-sm text-gray-500">This course has no in-video questions yet. Add them while editing a video lesson.</p>
          ) : (
            <div className="max-h-96 overflow-y-auto divide-y">
              {(data.questions || [])
                .filter((q) => !moduleId || String(q.module) === moduleId)
                .map((q) => (
                  <div key={q._id} className="py-3">
                    <div className="text-xs text-gray-400">{q.moduleTitle} · at {fmtClock(q.atSec)}</div>
                    <div className="text-sm text-gray-900 mt-0.5">{q.question}</div>
                    <div className="text-xs text-gray-500 mt-1">
                      {q.options.map((o) => (
                        <span key={o.text} className={`inline-block mr-2 ${o.correct ? 'text-green-700 font-medium' : ''}`}>
                          {o.correct ? '✓ ' : ''}{o.text}
                        </span>
                      ))}
                      {!q.graded && <span className="text-gray-400">(not graded - any answer is accepted)</span>}
                    </div>
                    <div className="flex flex-wrap gap-1.5 mt-2 text-[11px]">
                      <span className="bg-gray-100 text-gray-700 rounded-md px-2 py-0.5">{q.answeredBy} answered</span>
                      <span className="bg-gray-100 text-gray-700 rounded-md px-2 py-0.5">{q.attempts} attempt{q.attempts === 1 ? '' : 's'}</span>
                      {q.graded && (
                        <>
                          <span className="bg-green-50 text-green-700 rounded-md px-2 py-0.5">{q.firstTimeRight} right first time</span>
                          {q.answeredBy > q.eventuallyRight && (
                            <span className="bg-red-50 text-red-700 rounded-md px-2 py-0.5">{q.answeredBy - q.eventuallyRight} never got it</span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )
        ) : (data.answers || []).length === 0 ? (
          <p className="text-sm text-gray-500">No answers recorded yet.</p>
        ) : (
          <div className="max-h-96 overflow-y-auto divide-y">
            {data.answers.map((a) => (
              <div key={a._id} className="py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-900 truncate">{who(a)}</span>
                  {/* shrink-0 on a phone: squeezed, these chips broke mid-word
                      ("Pub-lic"); the name is the one that truncates. */}
                  {a.audience === 'public' && <span className="shrink-0 sm:shrink text-[11px] bg-emerald-50 text-emerald-700 rounded px-1.5 py-0.5">Public</span>}
                  {a.attempt > 1 && <span className="shrink-0 sm:shrink text-[11px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">attempt {a.attempt}</span>}
                  <span className={`ml-auto shrink-0 text-xs rounded px-2 py-0.5 ${
                    !a.graded ? 'bg-gray-100 text-gray-600' : a.correct ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-700'
                  }`}>{!a.graded ? 'Recorded' : a.correct ? '✓ Correct' : '✗ Wrong'}</span>
                </div>
                <div className="text-xs text-gray-400 mt-0.5">{a.moduleTitle} · at {fmtClock(a.atSec)} · {fmtDate(a.createdAt)}</div>
                <div className="text-sm text-gray-700 mt-1">{a.question}</div>
                <div className="text-sm text-gray-900 mt-0.5">→ {(a.answer || []).join(', ') || '-'}</div>
              </div>
            ))}
            {data.count >= 3000 && <p className="text-xs text-gray-400 py-2">Showing the most recent 3000 answers.</p>}
          </div>
        )}

        <div className="flex justify-end pt-4"><button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button></div>
      </div>
    </div>
  );
}

// ===== Pending self-enroll approvals =====
function ApprovalsModal({ onClose, onChange }) {
  // Each modal asks for itself rather than being handed the flag — one import,
  const viewOnly = useViewOnly();
  const [rows, setRows] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = () => api.get('/courses/enrollments/pending').then(({ data }) => setRows(data.enrollments))
    .catch((err) => setError(err.response?.data?.message || 'Failed to load'));
  useEffect(() => { load(); }, []);

  const act = async (id, action) => {
    setBusyId(id); setError('');
    try {
      await api.patch(`/courses/enrollments/${id}/${action}`);
      await load();
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal title="Enrollment approvals" onClose={onClose}>
      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      {!rows ? <div className="space-y-2 py-1"><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-4 rounded w-2/3" /></div> : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No pending requests.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto divide-y">
          {rows.map((e) => (
            // Same phone split as the roster: the two buttons beside the text
            // cut the course being asked for down to a few characters.
            <div key={e._id} className="py-3 flex flex-wrap items-center gap-3 sm:flex-nowrap">
              <div className="min-w-0 flex-1 basis-full sm:basis-[0%]">
                <div className="text-sm text-gray-900 truncate">{e.employee ? `${e.employee.firstName || ''} ${e.employee.lastName || ''}`.trim() || e.employee.email : '-'}</div>
                <div className="text-xs text-gray-400 truncate">wants “{e.course?.title || 'a course'}”</div>
              </div>
              {!viewOnly && (
                <>
                  <button disabled={busyId === e._id} onClick={() => act(e._id, 'approve')} className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">Approve</button>
                  <button disabled={busyId === e._id} onClick={() => act(e._id, 'reject')} className="px-3 py-1.5 text-xs border rounded-lg hover:bg-gray-50 disabled:opacity-60">Reject</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end pt-4"><button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button></div>
    </Modal>
  );
}

// ===== Course issue reports =====
function ReportsModal({ onClose, onChange }) {
  // and no prop to forget when a new modal is added to this file.
  const viewOnly = useViewOnly();
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('Open');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = (s) => api.get('/courses/reports', { params: { status: s } })
    .then(({ data }) => setRows(data.reports))
    .catch((err) => setError(err.response?.data?.message || 'Failed to load'));
  useEffect(() => { setRows(null); load(status); /* eslint-disable-next-line */ }, [status]);

  const act = async (id, newStatus) => {
    setBusyId(id); setError('');
    try {
      await api.patch(`/courses/reports/${id}/resolve`, { status: newStatus });
      await load(status);
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal title="Course issue reports" onClose={onClose}>
      <div className="flex gap-2 mb-3">
        {['Open', 'Resolved'].map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 text-xs rounded-lg border ${status === s ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50'}`}>{s}</button>
        ))}
      </div>
      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      {!rows ? <div className="space-y-2 py-1"><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-4 rounded w-2/3" /></div> : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No {status.toLowerCase()} reports.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto divide-y">
          {rows.map((r) => (
            <div key={r._id} className="py-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-gray-900">
                    <span className="font-medium">{r.category}</span>
                    <span className="text-gray-400"> · {r.course?.title || 'Course'}{r.moduleTitle ? ` · ${r.moduleTitle}` : ''}</span>
                  </div>
                  {r.note && <div className="text-sm text-gray-600 mt-0.5">“{r.note}”</div>}
                  <div className="text-xs text-gray-400 mt-0.5">
                    {r.employee ? `${r.employee.firstName || ''} ${r.employee.lastName || ''}`.trim() || r.employee.email : '-'} · {fmtDate(r.createdAt)}
                  </div>
                </div>
                {viewOnly ? null : status === 'Open' ? (
                  <button disabled={busyId === r._id} onClick={() => act(r._id, 'Resolved')}
                    className="shrink-0 px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">Resolve</button>
                ) : (
                  <button disabled={busyId === r._id} onClick={() => act(r._id, 'Open')}
                    className="shrink-0 px-3 py-1.5 text-xs border rounded-lg hover:bg-gray-50 disabled:opacity-60">Reopen</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end pt-4"><button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button></div>
    </Modal>
  );
}

// ===== Public sharing hub: copy the public link, view captured leads + feedback =====
function ShareModal({ course, onClose }) {
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState('leads');
  const [leads, setLeads] = useState(null);
  const [feedback, setFeedback] = useState(null);

  const publicUrl = course.publicToken ? `${window.location.origin}/learn/${course.publicToken}` : '';

  const copy = () => { navigator.clipboard?.writeText(publicUrl); setCopied(true); setTimeout(() => setCopied(false), 1500); };

  useEffect(() => {
    if (tab === 'leads' && leads === null) {
      api.get(`/courses/${course._id}/leads`).then(({ data }) => setLeads(data.leads)).catch(() => setLeads([]));
    }
    if (tab === 'feedback' && feedback === null) {
      api.get(`/courses/${course._id}/video-feedback`).then(({ data }) => setFeedback(data.feedback)).catch(() => setFeedback([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const exportLeads = async () => {
    const rows = (leads || []).map((l) => [
      l.name, l.phone, l.location, l.email || '', new Date(l.createdAt).toLocaleString('en-IN'),
    ]);
    try {
      await downloadTableXlsx({
        filename: `${course.title}-leads`,
        sheetName: 'Leads',
        headers: ['Name', 'Phone', 'Location', 'Email', 'Date'],
        rows,
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not export leads');
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">Public link · “{course.title}”</h2>
          <button onClick={onClose} type="button" aria-label="Close" title="Close" className="topbar-icon-btn shrink-0">×</button>
        </div>

        <div className="text-xs text-gray-500 mb-2">Anyone with this link can watch after a short form (name, phone, location) - no login.</div>
        <div className="flex gap-2 mb-4">
          <input readOnly value={publicUrl} className="flex-1 border rounded-lg px-3 py-2 text-sm bg-gray-50" onFocus={(e) => e.target.select()} />
          <button onClick={copy} className="px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">{copied ? 'Copied ✓' : 'Copy'}</button>
          <a href={publicUrl} target="_blank" rel="noreferrer" className="px-3 py-2 text-sm border rounded-lg hover:bg-gray-50">Open</a>
        </div>

        <div className="flex gap-2 border-b mb-3 overflow-x-auto">
          {[['leads', 'Leads'], ['feedback', 'Feedback']].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 whitespace-nowrap ${tab === k ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>{label}</button>
          ))}
        </div>

        {tab === 'leads' && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500">{leads ? `${leads.length} lead${leads.length === 1 ? '' : 's'}` : 'Loading…'}</span>
              {leads && leads.length > 0 && <button onClick={exportLeads} className="text-xs text-blue-600 hover:underline">Export Excel</button>}
            </div>
            <div className="max-h-80 overflow-y-auto border rounded-lg divide-y">
              {!leads ? <div className="p-3 text-sm text-gray-400">Loading…</div> : leads.length === 0 ? (
                <div className="p-3 text-sm text-gray-500">No one has started this course yet.</div>
              ) : leads.map((l) => (
                <div key={l._id} className="px-3 py-2">
                  <div className="text-sm text-gray-900">{l.name} <span className="text-gray-400">· {l.phone}</span></div>
                  <div className="text-xs text-gray-500">{l.location}{l.email ? ` · ${l.email}` : ''} · {fmtDate(l.createdAt)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'feedback' && (
          <div className="max-h-80 overflow-y-auto border rounded-lg divide-y">
            {!feedback ? <div className="p-3 text-sm text-gray-400">Loading…</div> : feedback.length === 0 ? (
              <div className="p-3 text-sm text-gray-500">No video feedback yet.</div>
            ) : feedback.map((f) => (
              <div key={f._id} className="px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-gray-900">{f.viewer?.name || 'Someone'}</span>
                  {f.rating ? <span className="text-amber-500 text-sm">{'★'.repeat(f.rating)}{'☆'.repeat(5 - f.rating)}</span> : null}
                </div>
                <div className="text-xs text-gray-400">{f.moduleTitle || 'Video'} · {fmtDate(f.createdAt)}</div>
                {(f.answers || []).length > 0 && (
                  <div className="text-xs text-gray-600 mt-1">{f.answers.map((a) => `${a.label}: ${a.answer}`).join(' · ')}</div>
                )}
                {f.comment && <div className="text-sm text-gray-700 mt-1">“{f.comment}”</div>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ===== Global comment moderation =====
function CommentsModal({ onClose, onChange }) {
  // (Same reasoning as ApprovalsModal above.)
  const viewOnly = useViewOnly();
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('Pending');
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  const load = (s) => api.get('/courses/comments', { params: { status: s } })
    .then(({ data }) => setRows(data.comments))
    .catch((err) => setError(err.response?.data?.message || 'Failed to load'));
  useEffect(() => { setRows(null); load(status); /* eslint-disable-next-line */ }, [status]);

  const act = async (id, action) => {
    setBusyId(id); setError('');
    try {
      if (action === 'delete') await api.delete(`/courses/comments/${id}`);
      else await api.patch(`/courses/comments/${id}`, { status: action });
      await load(status);
      onChange?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Action failed');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal title="Course comments" onClose={onClose}>
      <div className="flex gap-2 mb-3">
        {['Pending', 'Approved', 'Rejected'].map((s) => (
          <button key={s} onClick={() => setStatus(s)}
            className={`px-3 py-1.5 text-xs rounded-lg border ${status === s ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50'}`}>{s}</button>
        ))}
      </div>
      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      {!rows ? <div className="space-y-2 py-1"><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-4 rounded w-2/3" /></div> : rows.length === 0 ? (
        <p className="text-sm text-gray-500">No {status.toLowerCase()} comments.</p>
      ) : (
        <div className="max-h-96 overflow-y-auto divide-y">
          {rows.map((c) => (
            <div key={c._id} className="py-3">
              <div className="text-sm text-gray-900"><span className="font-medium">{c.name}</span>
                <span className="text-gray-400"> · {c.course?.title || 'Course'}{c.moduleTitle ? ` · ${c.moduleTitle}` : ''}</span>
              </div>
              <div className="text-sm text-gray-700 mt-0.5">“{c.text}”</div>
              <div className="text-xs text-gray-400 mt-0.5">{fmtDate(c.createdAt)}</div>
              <div className="flex gap-2 mt-2">
                {!viewOnly && status !== 'Approved' && <button disabled={busyId === c._id} onClick={() => act(c._id, 'Approved')} className="px-3 py-1 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">Approve</button>}
                {!viewOnly && status !== 'Rejected' && <button disabled={busyId === c._id} onClick={() => act(c._id, 'Rejected')} className="px-3 py-1 text-xs border rounded-lg hover:bg-gray-50 disabled:opacity-60">Reject</button>}
                {!viewOnly && <button disabled={busyId === c._id} onClick={() => act(c._id, 'delete')} className="px-3 py-1 text-xs text-red-600 hover:underline disabled:opacity-60 ml-auto">Delete</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="flex justify-end pt-4"><button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button></div>
    </Modal>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">{title}</h2>
          <button onClick={onClose} type="button" aria-label="Close" title="Close" className="topbar-icon-btn shrink-0">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
