import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_STYLES = {
  Enrolled: 'bg-gray-100 text-gray-700',
  InProgress: 'bg-amber-100 text-amber-800',
  Completed: 'bg-green-100 text-green-800',
};

export default function EmployeeLearning() {
  const [enrollments, setEnrollments] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null); // enrollment._id being viewed
  const [savingProgress, setSavingProgress] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [meRes, catRes] = await Promise.all([api.get('/courses/me'), api.get('/courses')]);
      setEnrollments(meRes.data.enrollments);
      setCatalog(catRes.data.courses);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const doEnroll = async (course) => {
    try {
      await api.post(`/courses/${course._id}/enroll`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Enroll failed');
    }
  };

  const toggleModule = async (enrollment, idx) => {
    const course = enrollment.course;
    if (!course) return;
    const current = enrollment.completedModules || [];
    const next = current.includes(idx)
      ? current.filter((i) => i !== idx)
      : [...current, idx];
    setSavingProgress(true);
    try {
      const { data } = await api.patch(`/courses/${course._id}/progress`, { completedModules: next });
      setEnrollments((prev) =>
        prev.map((e) =>
          e._id === enrollment._id
            ? { ...e, completedModules: data.enrollment.completedModules, progress: data.enrollment.progress, status: data.enrollment.status }
            : e
        )
      );
    } catch (err) {
      setError(err.response?.data?.message || 'Update failed');
    } finally {
      setSavingProgress(false);
    }
  };

  const enrolledCourseIds = new Set(
    enrollments.filter((e) => e.course).map((e) => String(e.course._id))
  );
  const openEnrollment = enrollments.find((e) => e._id === openId);

  return (
    <div>
      <PageHeader title="Learning" subtitle="Courses & training" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* My Courses */}
      <h2 className="card-title mb-3">My Courses</h2>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : enrollments.length === 0 ? (
        <p className="text-sm text-gray-500 mb-8">You haven't enrolled in any courses yet.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
          {enrollments.map((e) => (
            <div key={e._id} className="bg-white shadow rounded-lg p-5">
              <div className="flex items-start justify-between">
                <div className="font-medium text-gray-900">{e.course?.title || 'Untitled'}</div>
                <span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[e.status]}`}>{e.status}</span>
              </div>
              {e.course?.category && <div className="text-xs text-gray-400 mt-0.5">{e.course.category}</div>}
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                  <span>Progress</span><span>{e.progress || 0}%</span>
                </div>
                <div className="h-2 bg-gray-100 rounded">
                  <div className="h-2 accent-bg rounded" style={{ width: `${e.progress || 0}%` }} />
                </div>
              </div>
              <div className="mt-4">
                <button
                  onClick={() => setOpenId(e._id)}
                  className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50"
                >
                  Open
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Course Catalog */}
      <h2 className="card-title mb-3">Course Catalog</h2>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : catalog.length === 0 ? (
        <p className="text-sm text-gray-500">No courses available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {catalog.map((c) => {
            const already = enrolledCourseIds.has(String(c._id)) || c.enrollment;
            return (
              <div key={c._id} className="bg-white shadow rounded-lg p-5 flex flex-col">
                <div className="font-medium text-gray-900">{c.title}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {c.category}{c.durationHours ? ` · ${c.durationHours}h` : ''}
                </div>
                {c.description && <p className="text-sm text-gray-600 mt-2 flex-1">{c.description}</p>}
                <div className="mt-4">
                  {already ? (
                    <span className="text-sm text-green-700 font-medium">Enrolled ✓</span>
                  ) : (
                    <button
                      onClick={() => doEnroll(c)}
                      className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700"
                    >
                      Enroll
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Course module modal */}
      {openEnrollment && openEnrollment.course && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <div className="flex items-start justify-between mb-1">
              <h2 className="card-title">{openEnrollment.course.title}</h2>
              <span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[openEnrollment.status]}`}>{openEnrollment.status}</span>
            </div>
            {openEnrollment.course.description && (
              <p className="text-sm text-gray-500 mb-4">{openEnrollment.course.description}</p>
            )}

            <div className="mb-4">
              <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                <span>Progress</span><span>{openEnrollment.progress || 0}%</span>
              </div>
              <div className="h-2 bg-gray-100 rounded">
                <div className="h-2 accent-bg rounded" style={{ width: `${openEnrollment.progress || 0}%` }} />
              </div>
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto">
              {(openEnrollment.course.modules || []).length === 0 ? (
                <p className="text-sm text-gray-500">This course has no modules.</p>
              ) : (
                openEnrollment.course.modules.map((m, idx) => {
                  const done = (openEnrollment.completedModules || []).includes(idx);
                  return (
                    <div key={idx} className="border rounded-lg p-3">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={done}
                          disabled={savingProgress}
                          onChange={() => toggleModule(openEnrollment, idx)}
                          className="mt-1"
                        />
                        <div>
                          <div className="font-medium text-gray-900 text-sm">{m.title}</div>
                          {m.content && <div className="text-sm text-gray-600 mt-0.5">{m.content}</div>}
                          {m.url && (
                            <a href={m.url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline">
                              Open resource
                            </a>
                          )}
                        </div>
                      </label>
                    </div>
                  );
                })
              )}
            </div>

            <div className="flex justify-end pt-4">
              <button
                onClick={() => setOpenId(null)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
