import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import api, { getBaseURL } from '../api/client';
import PublicVideoPlayer from '../components/PublicVideoPlayer';

// PublicCoursePage — public (no-login) LMS course viewer at route /learn/:token.
// Audience: anonymous external leads (no HRMS account); the token in the URL is
// the only credential. Flow: fill a short lead form (once per browser) → watch
// the course with a no-skip player → leave comments (held for approval) → give
// per-video feedback.
// Backend (all under /public/courses/:token): GET / (course + feedback questions),
// POST /register (lead capture), GET/POST /comments, POST /feedback, and the
// streamed video at /modules/:id/video.

// localStorage key that persists the lead session per course token/browser.
const lsKey = (token) => `pubcourse:${token}`;

// Top-level page: resolves the shareable token into a course, gates access
// behind the lead form, and hosts the player / curriculum / feedback UI.
export default function PublicCoursePage() {
  const { token } = useParams();
  const [course, setCourse] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Lead session (persisted per browser so they don't refill each visit).
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem(lsKey(token)) || 'null'); } catch { return null; }
  });

  const [activeId, setActiveId] = useState(null);
  const [feedbackFor, setFeedbackFor] = useState(null); // module awaiting feedback
  const [doneFeedback, setDoneFeedback] = useState(() => new Set());
  const [base, setBase] = useState('');

  // Absolute API base is needed to build the raw <video> src (not an axios call).
  useEffect(() => { getBaseURL().then(setBase); }, []);

  // Load the course + feedback questions whenever the token changes; a bad/expired
  // token surfaces as a friendly "invalid link" message rather than a crash.
  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const { data } = await api.get(`/public/courses/${token}`);
        setCourse(data.course);
        setQuestions(data.feedbackQuestions || []);
        if (data.course?.modules?.length) setActiveId(String(data.course.modules[0]._id));
      } catch (err) {
        setError(err.response?.data?.message || 'This course link is invalid or no longer available.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const modules = course?.modules || [];
  const active = modules.find((m) => String(m._id) === String(activeId)) || null;
  const activeIndex = modules.findIndex((m) => String(m._id) === String(activeId));

  // Persist the lead session locally so the form isn't shown again on revisit.
  const onRegistered = (s) => {
    localStorage.setItem(lsKey(token), JSON.stringify(s));
    setSession(s);
  };

  if (loading) return <Centered><div className="text-sm text-gray-500">Loading course…</div></Centered>;
  if (error || !course) return <Centered><div className="text-sm text-gray-600">{error || 'Course not found.'}</div></Centered>;

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-gray-900 text-white px-4 sm:px-6 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] text-gray-400 uppercase tracking-wide">{course.category || 'Course'}</div>
            <h1 className="text-base sm:text-lg font-semibold truncate">{course.title}</h1>
          </div>
          {session?.name && <div className="text-xs text-gray-300 shrink-0">Hi, {session.name.split(' ')[0]}</div>}
        </div>
      </div>

      {!session ? (
        <div className="max-w-md mx-auto px-4 py-10">
          <LeadForm token={token} course={course} onRegistered={onRegistered} />
        </div>
      ) : (
        <div className="max-w-6xl mx-auto px-0 sm:px-4 py-0 sm:py-4 grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-0 sm:gap-4">
          {/* Stage */}
          <div className="bg-white sm:rounded-xl overflow-hidden shadow-sm">
            {!active ? (
              <div className="p-8 text-sm text-gray-500">This course has no lessons yet.</div>
            ) : active.type === 'text' ? (
              <div className="p-5 sm:p-8">
                <div className="text-xs text-gray-400 mb-1">Lesson {activeIndex + 1} of {modules.length}</div>
                <h2 className="text-xl font-semibold text-gray-900 mb-4">{active.title}</h2>
                <div className="prose prose-sm max-w-none text-gray-700 whitespace-pre-wrap">{active.content || 'No content.'}</div>
              </div>
            ) : (
              <div>
                <PublicVideoPlayer
                  key={active._id}
                  src={base ? `${base}/public/courses/${token}/modules/${active._id}/video?viewer=${encodeURIComponent(session.sessionToken)}` : ''}
                  durationSec={active.durationSec}
                  onEnded={() => { if (!doneFeedback.has(String(active._id))) setFeedbackFor(active); }}
                />
                <div className="p-4 sm:p-6">
                  <div className="text-xs text-gray-400 mb-1">Lesson {activeIndex + 1} of {modules.length}</div>
                  <h2 className="text-lg sm:text-xl font-semibold text-gray-900">{active.title}</h2>
                  {active.content && <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{active.content}</p>}
                  <button onClick={() => setFeedbackFor(active)}
                    className="mt-3 text-sm text-indigo-600 hover:underline">Give feedback on this video</button>
                </div>
              </div>
            )}

            {/* Comments */}
            {active && <Comments token={token} module={active} session={session} />}
          </div>

          {/* Curriculum */}
          <aside className="bg-white sm:rounded-xl shadow-sm h-max">
            <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-800">Course content</div>
            <div className="lg:max-h-[70vh] overflow-y-auto">
              {modules.map((m, idx) => {
                const isActive = String(m._id) === String(activeId);
                return (
                  <button key={m._id} onClick={() => setActiveId(String(m._id))}
                    className={`w-full text-left px-4 py-3 flex items-start gap-3 border-b border-gray-50 ${isActive ? 'bg-indigo-50' : 'hover:bg-gray-50'}`}>
                    <span className={`mt-0.5 shrink-0 w-5 h-5 rounded-full flex items-center justify-center text-[11px] ${isActive ? 'bg-indigo-600 text-white' : 'border border-gray-300 text-gray-400'}`}>{idx + 1}</span>
                    <span className="min-w-0">
                      <span className={`block text-sm ${isActive ? 'font-semibold text-indigo-900' : 'text-gray-800'} truncate`}>{m.title}</span>
                      <span className="text-[11px] text-gray-400">{m.type === 'text' ? '📄 Reading' : '🎬 Video'}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>
        </div>
      )}

      {feedbackFor && (
        <FeedbackModal
          token={token}
          module={feedbackFor}
          questions={questions}
          session={session}
          onClose={() => setFeedbackFor(null)}
          onDone={(mid) => { setDoneFeedback((s) => new Set(s).add(String(mid))); setFeedbackFor(null); }}
        />
      )}
    </div>
  );
}

function Centered({ children }) {
  return <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">{children}</div>;
}

// ===== Lead capture form (hard gate) =====
function LeadForm({ token, course, onRegistered }) {
  const [form, setForm] = useState({ name: '', phone: '', location: '', email: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim() || !form.phone.trim() || !form.location.trim()) {
      setError('Please fill in your name, phone and location.');
      return;
    }
    setBusy(true); setError('');
    try {
      // Registering the lead returns a sessionToken used to authorize every
      // subsequent public action (video stream, comments, feedback).
      const { data } = await api.post(`/public/courses/${token}/register`, form);
      onRegistered({ sessionToken: data.sessionToken, name: data.viewer?.name || form.name });
    } catch (err) {
      setError(err.response?.data?.message || 'Could not start the course. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <h2 className="text-lg font-semibold text-gray-900">Watch “{course.title}”</h2>
      <p className="text-sm text-gray-500 mt-1 mb-4">Tell us a little about yourself to start the course. It’s free.</p>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Full name *"><input required value={form.name} onChange={set('name')} className="block w-full border rounded-lg px-3 py-2 text-sm" /></Field>
        <Field label="Phone number *"><input required type="tel" value={form.phone} onChange={set('phone')} className="block w-full border rounded-lg px-3 py-2 text-sm" /></Field>
        <Field label="Location *"><input required value={form.location} onChange={set('location')} placeholder="City / area" className="block w-full border rounded-lg px-3 py-2 text-sm" /></Field>
        <Field label="Email (optional)"><input type="email" value={form.email} onChange={set('email')} className="block w-full border rounded-lg px-3 py-2 text-sm" /></Field>
        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
        <button type="submit" disabled={busy} className="w-full px-4 py-2.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60 text-sm font-medium">
          {busy ? 'Starting…' : 'Start course →'}
        </button>
      </form>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
      {children}
    </div>
  );
}

// ===== Comments (approved list + post) =====
function Comments({ token, module, session }) {
  const [comments, setComments] = useState([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [posted, setPosted] = useState(false);
  const [error, setError] = useState('');
  const moduleId = String(module._id);
  const lastLoaded = useRef(null);

  const load = async () => {
    try {
      const { data } = await api.get(`/public/courses/${token}/comments`, { params: { module: moduleId } });
      setComments(data.comments || []);
    } catch { /* ignore */ }
  };
  // Reset the composer on module switch and reload comments once per module
  // (lastLoaded guards against duplicate fetches for the same module id).
  useEffect(() => {
    setPosted(false); setText('');
    if (lastLoaded.current !== moduleId) { lastLoaded.current = moduleId; load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moduleId]);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true); setError('');
    try {
      await api.post(`/public/courses/${token}/comments`, { viewer: session.sessionToken, module: moduleId, text });
      setText(''); setPosted(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not post your comment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-gray-100 p-4 sm:p-6">
      <div className="text-sm font-semibold text-gray-800 mb-3">Comments</div>
      <div className="flex gap-2 mb-2">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment…"
          className="flex-1 border rounded-lg px-3 py-2 text-sm" onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        <button onClick={submit} disabled={busy || !text.trim()} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">Post</button>
      </div>
      {error && <div className="text-xs text-red-600 mb-2">{error}</div>}
      {posted && <div className="text-xs text-green-600 mb-2">Thanks! Your comment will appear once it’s approved.</div>}
      {comments.length === 0 ? (
        <p className="text-sm text-gray-400 mt-2">No comments yet. Be the first!</p>
      ) : (
        <div className="space-y-3 mt-3">
          {comments.map((c) => (
            <div key={c._id} className="flex items-start gap-3">
              <div className="shrink-0 w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-xs font-semibold">
                {(c.name || '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="text-sm text-gray-900"><span className="font-medium">{c.name}</span></div>
                <div className="text-sm text-gray-700 whitespace-pre-wrap">{c.text}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Per-video feedback modal =====
// Star rating + configurable multiple-choice questions + free text; posts to
// /feedback and reports the module id back so it isn't re-prompted this session.
function FeedbackModal({ token, module, questions, session, onClose, onDone }) {
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [answers, setAnswers] = useState({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    if (!rating) { setError('Please pick a star rating.'); return; }
    setBusy(true); setError('');
    try {
      await api.post(`/public/courses/${token}/feedback`, {
        viewer: session.sessionToken,
        module: module._id,
        rating,
        answers: Object.entries(answers).map(([key, answer]) => ({ key, answer })),
        comment,
      });
      onDone(module._id);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit feedback.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-base font-semibold text-gray-900">How was this video?</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        <p className="text-xs text-gray-400 mb-4">{module.title}</p>

        <div className="flex items-center gap-1 mb-4">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" onMouseEnter={() => setHover(n)} onMouseLeave={() => setHover(0)} onClick={() => setRating(n)}
              className={`text-3xl leading-none ${(hover || rating) >= n ? 'text-amber-500' : 'text-gray-300'}`}>★</button>
          ))}
        </div>

        <div className="space-y-3 mb-3">
          {questions.map((q) => (
            <div key={q.key}>
              <div className="text-sm text-gray-700 mb-1">{q.label}</div>
              <div className="flex flex-wrap gap-2">
                {q.options.map((opt) => (
                  <button key={opt} type="button" onClick={() => setAnswers((a) => ({ ...a, [q.key]: opt }))}
                    className={`px-3 py-1.5 text-xs rounded-lg border ${answers[q.key] === opt ? 'bg-gray-900 text-white border-gray-900' : 'hover:bg-gray-50'}`}>
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Anything else? (optional)"
          className="block w-full border rounded-lg px-3 py-2 text-sm mb-3" />
        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg mb-3">{error}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Skip</button>
          <button onClick={submit} disabled={busy} className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">
            {busy ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}
