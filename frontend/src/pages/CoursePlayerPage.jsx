import { useEffect, useMemo, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api/client';
import CourseVideoPlayer from '../components/CourseVideoPlayer';

const REPORT_CATEGORIES = ['Video quality', 'Audio / sound', 'Playback / buffering', 'Content error', 'Other'];

// Full-page, Udemy-style course player: a large content stage on the left and a
// curriculum sidebar on the right. Reached at /employee/learning/:courseId.
export default function CoursePlayerPage() {
  const { courseId } = useParams();
  const [enrollment, setEnrollment] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [busyText, setBusyText] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);

  // Clear the "video failed" hint whenever the lesson changes.
  useEffect(() => { setVideoFailed(false); }, [activeId]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/courses/me');
      const enr = (data.enrollments || []).find((e) => e.course && String(e.course._id) === String(courseId));
      if (!enr) setError('You are not enrolled in this course.');
      else if (enr.approvalStatus !== 'Approved') setError('Your enrollment is awaiting approval.');
      setEnrollment(enr || null);
      // Default to the first not-yet-completed module, else the first module.
      if (enr?.course?.modules?.length) {
        const done = new Set((enr.moduleProgress || []).filter((m) => m.completed).map((m) => String(m.module)));
        const firstOpen = enr.course.modules.find((m) => !done.has(String(m._id))) || enr.course.modules[0];
        setActiveId(String(firstOpen._id));
      }
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load course');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [courseId]);

  const course = enrollment?.course;
  const progress = enrollment?.progress || 0;
  const completedSet = useMemo(
    () => new Set((enrollment?.moduleProgress || []).filter((m) => m.completed).map((m) => String(m.module))),
    [enrollment]
  );
  const modules = course?.modules || [];
  const active = modules.find((m) => String(m._id) === String(activeId)) || null;
  const activeIndex = modules.findIndex((m) => String(m._id) === String(activeId));

  // Merge a fresh enrollment (from a progress/complete call) into local state.
  const applyUpdated = (updated) => {
    setEnrollment((prev) => (prev ? { ...prev, ...updated, course: prev.course } : prev));
  };

  const markText = async (module, completed) => {
    setBusyText(true);
    try {
      const { data } = await api.post(`/courses/${courseId}/modules/${module._id}/complete`, { completed });
      applyUpdated(data.enrollment);
    } catch {
      /* ignore */
    } finally {
      setBusyText(false);
    }
  };

  const goToModule = (delta) => {
    const next = modules[activeIndex + delta];
    if (next) setActiveId(String(next._id));
  };

  const backLink = (
    <Link to="/employee/learning" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
      ← Back to Learning
    </Link>
  );

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading course…</div>;
  if (error || !course) {
    return (
      <div className="max-w-lg mx-auto mt-10 text-center">
        <p className="text-sm text-gray-600 mb-4">{error || 'Course not found.'}</p>
        {backLink}
      </div>
    );
  }

  return (
    <div className="-m-4 sm:-m-6">
      {/* Top bar */}
      <div className="bg-gray-900 text-white px-4 sm:px-6 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Link to="/employee/learning" className="inline-flex items-center gap-1 text-xs text-gray-300 hover:text-white">← Learning</Link>
            <h1 className="text-base sm:text-lg font-semibold truncate">{course.title}</h1>
          </div>
          <div className="hidden sm:flex items-center gap-3 shrink-0">
            <div className="w-40">
              <div className="flex items-center justify-between text-[11px] text-gray-300 mb-1"><span>Progress</span><span>{progress}%</span></div>
              <div className="h-1.5 bg-white/20 rounded"><div className={`h-1.5 rounded ${progress >= 100 ? 'bg-green-400' : 'bg-white'}`} style={{ width: `${progress}%` }} /></div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px]">
        {/* Content stage */}
        <div className="bg-gray-50 min-h-[60vh]">
          {/* End-of-course feedback */}
          {progress >= 100 && (
            <div className="p-4 sm:p-6 border-b border-gray-200 bg-white">
              <FeedbackCard courseId={courseId} existing={enrollment.feedback} onSaved={applyUpdated} />
            </div>
          )}
          {!active ? (
            <div className="p-8 text-sm text-gray-500">Select a lesson to begin.</div>
          ) : active.type === 'text' ? (
            <div className="p-4 sm:p-8 max-w-3xl">
              <div className="text-xs text-gray-400 mb-1">Lesson {activeIndex + 1} of {modules.length}</div>
              <h2 className="text-xl font-semibold text-gray-900 mb-4">{active.title}</h2>
              <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap mb-6">{active.content || 'No content.'}</div>
              <button onClick={() => markText(active, !completedSet.has(String(active._id)))} disabled={busyText}
                className={`px-4 py-2 text-sm rounded-lg disabled:opacity-60 ${completedSet.has(String(active._id)) ? 'border hover:bg-gray-100' : 'bg-green-600 text-white hover:bg-green-700'}`}>
                {completedSet.has(String(active._id)) ? '✓ Completed — mark unread' : 'Mark as complete'}
              </button>
            </div>
          ) : (
            <div>
              <CourseVideoPlayer key={active._id} courseId={courseId} module={active} onProgress={applyUpdated} onError={() => setVideoFailed(true)} bare />
              <div className="p-4 sm:p-6 max-w-3xl">
                <div className="text-xs text-gray-400 mb-1">Lesson {activeIndex + 1} of {modules.length}</div>
                <h2 className="text-xl font-semibold text-gray-900">{active.title}</h2>
                {completedSet.has(String(active._id)) && <span className="inline-block mt-2 text-xs bg-green-100 text-green-800 rounded px-2 py-0.5">✓ Completed</span>}
                {active.content && <p className="text-sm text-gray-600 mt-3 whitespace-pre-wrap">{active.content}</p>}
              </div>
            </div>
          )}

          {/* Report an issue */}
          {active && (
            <div className={`px-4 sm:px-6 py-3 flex items-center gap-2 text-sm ${videoFailed ? 'bg-amber-50 border-t border-amber-200' : 'bg-gray-50 border-t border-gray-200'}`}>
              <span className="text-gray-500">{videoFailed ? 'Trouble with this lesson?' : 'Something wrong with this lesson?'}</span>
              <button onClick={() => setReportOpen(true)}
                className="ml-auto inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-white text-gray-700">
                ⚠ Report an issue
              </button>
            </div>
          )}

          {/* Prev / next lesson nav */}
          <div className="flex items-center justify-between gap-2 px-4 sm:px-6 py-4 border-t border-gray-200 bg-white">
            <button onClick={() => goToModule(-1)} disabled={activeIndex <= 0}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-40">← Previous</button>
            <button onClick={() => goToModule(1)} disabled={activeIndex >= modules.length - 1}
              className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40">Next lesson →</button>
          </div>
        </div>

        {/* Curriculum sidebar */}
        <aside className="border-t lg:border-t-0 lg:border-l border-gray-200 bg-white">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-800">Course content</span>
            <span className="text-xs text-gray-400">{completedSet.size}/{modules.length} done</span>
          </div>
          <div className="lg:max-h-[calc(100vh-8rem)] overflow-y-auto">
            {modules.length === 0 ? (
              <p className="text-sm text-gray-500 p-4">This course has no lessons yet.</p>
            ) : modules.map((m, idx) => {
              const done = completedSet.has(String(m._id));
              const isActive = String(m._id) === String(activeId);
              return (
                <button key={m._id} onClick={() => setActiveId(String(m._id))}
                  className={`w-full text-left px-4 py-3 flex items-start gap-3 border-b border-gray-50 ${isActive ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                  <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] ${done ? 'bg-green-500 text-white' : 'border border-gray-300 text-gray-400'}`}>
                    {done ? '✓' : idx + 1}
                  </span>
                  <span className="min-w-0">
                    <span className={`block text-sm ${isActive ? 'font-semibold text-indigo-900' : 'text-gray-800'} truncate`}>{m.title}</span>
                    <span className="text-[11px] text-gray-400">{m.type === 'text' ? '📄 Reading' : '🎬 Video'}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {progress >= 100 && (
            <div className="m-4 p-3 rounded-lg bg-green-50 border border-green-200 text-center">
              <div className="text-2xl">🎉</div>
              <div className="text-sm font-semibold text-green-800 mt-1">Course completed!</div>
            </div>
          )}
        </aside>
      </div>

      {reportOpen && (
        <ReportModal
          courseId={courseId}
          module={active}
          onClose={() => setReportOpen(false)}
        />
      )}
    </div>
  );
}

// ===== Report an issue modal =====
function ReportModal({ courseId, module, onClose }) {
  const [category, setCategory] = useState(REPORT_CATEGORIES[0]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post(`/courses/${courseId}/report`, { module: module?._id, category, note });
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not send report');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
        {done ? (
          <div className="text-center py-4">
            <div className="text-3xl">✅</div>
            <div className="font-semibold text-gray-900 mt-2">Thanks for letting us know</div>
            <p className="text-sm text-gray-500 mt-1">Our team will look into it.</p>
            <button onClick={onClose} className="mt-4 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">Close</button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="card-title">Report an issue</h2>
              <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>
            {module && <div className="text-xs text-gray-400 mb-3">Lesson: {module.title}</div>}
            <label className="block text-xs font-medium text-gray-600 mb-1">What's wrong?</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm mb-3">
              {REPORT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
            </select>
            <label className="block text-xs font-medium text-gray-600 mb-1">Details (optional)</label>
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. no sound after 2:30, video keeps buffering…"
              className="block w-full border rounded-lg px-3 py-2 text-sm mb-3" />
            {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mb-3">{error}</div>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
              <button onClick={submit} disabled={busy} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                {busy ? 'Sending…' : 'Send report'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ===== End-of-course feedback =====
function FeedbackCard({ courseId, existing, onSaved }) {
  const already = existing && existing.rating;
  const [rating, setRating] = useState(existing?.rating || 0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState(existing?.comment || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (already) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-600">
        <span className="text-green-600 font-medium">Thanks for your feedback!</span>
        <span className="text-amber-500">{'★'.repeat(existing.rating)}{'☆'.repeat(5 - existing.rating)}</span>
      </div>
    );
  }

  const submit = async () => {
    if (!rating) { setError('Please pick a star rating.'); return; }
    setBusy(true);
    setError('');
    try {
      const { data } = await api.post(`/courses/${courseId}/feedback`, { rating, comment });
      onSaved(data.enrollment);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit feedback');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div className="font-semibold text-gray-900">🎉 You finished this course!</div>
      <p className="text-sm text-gray-500 mt-0.5 mb-3">How was it? Your feedback helps us improve.</p>
      <div className="flex items-center gap-1 mb-3">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)} onClick={() => setRating(n)}
            className={`text-2xl leading-none ${(hover || rating) >= n ? 'text-amber-500' : 'text-gray-300'}`}>★</button>
        ))}
      </div>
      <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything you'd like to add? (optional)"
        className="block w-full border rounded-lg px-3 py-2 text-sm mb-2 max-w-xl" />
      {error && <div className="text-sm text-red-700 mb-2">{error}</div>}
      <button onClick={submit} disabled={busy} className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">
        {busy ? 'Submitting…' : 'Submit feedback'}
      </button>
    </div>
  );
}
