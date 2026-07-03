import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_STYLES = {
  Enrolled: 'bg-gray-100 text-gray-700',
  InProgress: 'bg-amber-100 text-amber-800',
  Completed: 'bg-green-100 text-green-800',
};

// A "Due in 3 days" / "Overdue by 2 days" / "Completed" chip from due metadata.
function DeadlineChip({ enrollment }) {
  if (enrollment.status === 'Completed') return <span className="text-xs bg-green-100 text-green-800 rounded px-2 py-0.5">Completed</span>;
  if (!enrollment.dueDate) return null;
  const d = enrollment.daysToDue;
  if (enrollment.overdue) return <span className="text-xs bg-red-100 text-red-700 rounded px-2 py-0.5">Overdue by {Math.abs(d)} day{Math.abs(d) === 1 ? '' : 's'}</span>;
  if (d === 0) return <span className="text-xs bg-amber-100 text-amber-800 rounded px-2 py-0.5">Due today</span>;
  return <span className="text-xs bg-blue-50 text-blue-700 rounded px-2 py-0.5">Due in {d} day{d === 1 ? '' : 's'}</span>;
}

function ProgressBar({ value }) {
  return (
    <div className="mt-3">
      <div className="flex items-center justify-between text-xs text-gray-500 mb-1"><span>Progress</span><span>{value || 0}%</span></div>
      <div className="h-2 bg-gray-100 rounded"><div className={`h-2 rounded ${value >= 100 ? 'bg-green-500' : 'accent-bg'}`} style={{ width: `${value || 0}%` }} /></div>
    </div>
  );
}

export default function EmployeeLearning() {
  const [enrollments, setEnrollments] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyEnroll, setBusyEnroll] = useState(null);

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

  const byCourseId = useMemo(() => {
    const m = {};
    enrollments.forEach((e) => { if (e.course) m[String(e.course._id)] = e; });
    return m;
  }, [enrollments]);

  const approved = enrollments.filter((e) => e.approvalStatus === 'Approved' && e.course);
  const pending = enrollments.filter((e) => e.approvalStatus === 'Pending' && e.course);

  const requestEnroll = async (course) => {
    setBusyEnroll(course._id);
    try {
      await api.post(`/courses/${course._id}/enroll`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Enroll failed');
    } finally {
      setBusyEnroll(null);
    }
  };

  return (
    <div>
      <PageHeader title="Learning" subtitle="Your courses & training" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* My Courses */}
      <h2 className="card-title mb-3">My Courses</h2>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : approved.length === 0 ? (
        <p className="text-sm text-gray-500 mb-8">No active courses yet. Request one from the catalog below, or wait to be assigned.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mb-8">
          {approved.map((e) => (
            <div key={e._id} className="bg-white shadow rounded-xl p-5 flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="font-semibold text-gray-900 min-w-0 truncate">{e.course.title}</div>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[e.status]}`}>{e.status}</span>
              </div>
              <div className="text-xs text-gray-400 mt-0.5">{e.course.category}{e.source === 'Assigned' ? ' · Assigned' : ''}</div>
              <div className="mt-2"><DeadlineChip enrollment={e} /></div>
              <ProgressBar value={e.progress} />
              <div className="mt-4">
                <Link to={`/employee/learning/${e.course._id}`} className="block text-center w-full px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                  {e.progress > 0 && e.status !== 'Completed' ? 'Continue' : e.status === 'Completed' ? 'Review' : 'Start course'}
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pending requests */}
      {pending.length > 0 && (
        <div className="mb-8">
          <h2 className="card-title mb-3">Awaiting approval</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {pending.map((e) => (
              <div key={e._id} className="bg-white border border-amber-200 rounded-xl p-5">
                <div className="font-medium text-gray-900">{e.course.title}</div>
                <div className="text-xs text-gray-400 mt-0.5">{e.course.category}</div>
                <div className="mt-3 text-sm text-amber-700 font-medium">⏳ Requested — awaiting approval</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Catalog */}
      <h2 className="card-title mb-3">Course Catalog</h2>
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : catalog.length === 0 ? (
        <p className="text-sm text-gray-500">No courses available.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {catalog.map((c) => {
            const enr = byCourseId[String(c._id)] || c.enrollment;
            const approvalStatus = enr?.approvalStatus;
            return (
              <div key={c._id} className="bg-white shadow rounded-xl p-5 flex flex-col">
                <div className="font-semibold text-gray-900">{c.title}</div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {c.category}{c.durationHours ? ` · ${c.durationHours}h` : ''} · {c.moduleCount || 0} module{c.moduleCount === 1 ? '' : 's'}
                </div>
                {c.description && <p className="text-sm text-gray-600 mt-2 flex-1">{c.description}</p>}
                {c.deadlineDays > 0 && <div className="text-xs text-gray-400 mt-2">Finish within {c.deadlineDays} days of enrollment</div>}
                <div className="mt-4">
                  {approvalStatus === 'Approved' ? (
                    <span className="text-sm text-green-700 font-medium">Enrolled ✓</span>
                  ) : approvalStatus === 'Pending' ? (
                    <span className="text-sm text-amber-700 font-medium">Awaiting approval…</span>
                  ) : approvalStatus === 'Rejected' ? (
                    <span className="text-sm text-red-600 font-medium">Request declined</span>
                  ) : (
                    <button onClick={() => requestEnroll(c)} disabled={busyEnroll === c._id}
                      className="px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                      {busyEnroll === c._id ? 'Requesting…' : 'Request to enroll'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
