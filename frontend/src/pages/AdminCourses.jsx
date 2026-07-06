import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import CourseVideoPlayer from '../components/CourseVideoPlayer';

const CATEGORIES = ['Technical', 'Soft Skills', 'Compliance', 'Leadership', 'Onboarding', 'Other'];

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

const blankModule = () => ({ type: 'video', title: '', driveUrl: '', content: '' });
const blank = () => ({ title: '', description: '', category: 'Other', durationHours: 0, deadlineDays: 0, active: true, modules: [] });
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : '-');

export default function AdminCourses() {
  const [courses, setCourses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Editor
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank());
  const [saving, setSaving] = useState(false);
  const [previewModIdx, setPreviewModIdx] = useState(null);

  // Assign / roster / approvals / reports
  const [assignFor, setAssignFor] = useState(null); // course
  const [rosterFor, setRosterFor] = useState(null); // course
  const [showApprovals, setShowApprovals] = useState(false);
  const [showReports, setShowReports] = useState(false);

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
    // Clear the param so re-navigating/closing doesn't re-trigger it.
    searchParams.delete('panel');
    setSearchParams(searchParams, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingTotal = useMemo(() => courses.reduce((n, c) => n + (c.pendingCount || 0), 0), [courses]);
  const reportsTotal = useMemo(() => courses.reduce((n, c) => n + (c.openReportsCount || 0), 0), [courses]);

  const openCreate = () => { setEditingId(null); setForm(blank()); setPreviewModIdx(null); setShowModal(true); };
  const openEdit = (c) => {
    setEditingId(c._id);
    setForm({
      title: c.title,
      description: c.description || '',
      category: c.category,
      durationHours: c.durationHours || 0,
      deadlineDays: c.deadlineDays || 0,
      active: c.active,
      modules: (c.modules || []).map((m) => ({
        _id: m._id,
        type: m.type || 'video',
        title: m.title || '',
        driveUrl: m.driveUrl || m.url || '',
        content: m.content || '',
        // Read-only transcode state (for the quality-status indicator).
        transcodeStatus: m.transcodeStatus || 'none',
        transcodeError: m.transcodeError || '',
        qualities: m.qualities || [],
        sourceHeight: m.sourceHeight || 0,
      })),
    });
    setPreviewModIdx(null);
    setShowModal(true);
  };

  const addModule = () => setForm((f) => ({ ...f, modules: [...f.modules, blankModule()] }));
  const removeModule = (idx) => setForm((f) => ({ ...f, modules: f.modules.filter((_, i) => i !== idx) }));
  const updateModule = (idx, field, value) =>
    setForm((f) => ({ ...f, modules: f.modules.map((m, i) => (i === idx ? { ...m, [field]: value } : m)) }));

  // (Re)generate a saved video module's lower-quality renditions.
  const retranscode = async (idx) => {
    const m = form.modules[idx];
    if (!editingId || !m?._id) return;
    try {
      await api.post(`/courses/${editingId}/modules/${m._id}/retranscode`);
      updateModule(idx, 'transcodeStatus', 'pending');
      updateModule(idx, 'transcodeError', '');
    } catch (err) {
      alert(err.response?.data?.message || 'Could not start quality generation');
    }
  };

  const save = async (e) => {
    e.preventDefault();
    // Client-side guard: every video module needs a resolvable Drive link.
    const badVideo = form.modules.findIndex((m) => m.type === 'video' && !parseDriveId(m.driveUrl));
    if (badVideo >= 0) {
      setError(`Module ${badVideo + 1}: enter a valid Google Drive video link.`);
      return;
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
    if (!window.confirm(`Delete course "${c.title}"? This also removes all enrollments.`)) return;
    try {
      await api.delete(`/courses/${c._id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
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
          <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Course</button>
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
                <span className="bg-gray-100 text-gray-700 rounded-md px-2 py-0.5">🎬 {c.videoCount} video{c.videoCount === 1 ? '' : 's'}</span>
                {c.moduleCount - c.videoCount > 0 && (
                  <span className="bg-gray-100 text-gray-700 rounded-md px-2 py-0.5">📄 {c.moduleCount - c.videoCount} text</span>
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
                <button onClick={() => openEdit(c)} className="text-blue-600 hover:underline">Edit</button>
                <button onClick={() => setAssignFor(c)} className="text-indigo-600 hover:underline">Assign</button>
                <button onClick={() => setRosterFor(c)} className="text-gray-600 hover:underline">Roster</button>
                <button onClick={() => remove(c)} className="text-red-600 hover:underline ml-auto">Delete</button>
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
                      const fileId = m.type === 'video' ? parseDriveId(m.driveUrl) : null;
                      const canPreview = editingId && m._id && fileId;
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
                              <input placeholder="Google Drive video link" value={m.driveUrl} onChange={(e) => updateModule(idx, 'driveUrl', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                              <div className="flex items-center justify-between text-xs">
                                {m.driveUrl ? (
                                  fileId
                                    ? <span className="text-green-600">✓ Valid Drive link</span>
                                    : <span className="text-red-600">✗ Not a recognizable Drive link</span>
                                ) : <span className="text-gray-400">Paste a “Anyone with the link” Drive video URL</span>}
                                {canPreview && (
                                  <button type="button" onClick={() => setPreviewModIdx(previewModIdx === idx ? null : idx)} className="text-blue-600 hover:underline">
                                    {previewModIdx === idx ? 'Hide preview' : 'Preview'}
                                  </button>
                                )}
                              </div>
                              {m._id && <ModuleQualityStatus m={m} onRetry={() => retranscode(idx)} />}
                              {canPreview && previewModIdx === idx && (
                                <CourseVideoPlayer courseId={editingId} module={{ _id: m._id, title: m.title, qualities: m.qualities, transcodeStatus: m.transcodeStatus }} preview />
                              )}
                              <textarea rows={2} placeholder="Notes shown under the video (optional)" value={m.content} onChange={(e) => updateModule(idx, 'content', e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
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
      {showApprovals && <ApprovalsModal onClose={() => setShowApprovals(false)} onChange={load} />}
      {showReports && <ReportsModal onClose={() => setShowReports(false)} onChange={load} />}
    </div>
  );
}

// ===== Assign to employees =====
// Shows a video module's transcoding state so admins know when the lower-quality
// options (that power the player's quality menu + Auto) are ready.
function ModuleQualityStatus({ m, onRetry }) {
  const status = m.transcodeStatus || 'none';
  const labels = (m.qualities || []).map((q) => q.label).join(', ');
  if (status === 'pending' || status === 'processing') {
    return <div className="text-xs text-amber-600">⏳ Generating quality options (360p/480p/720p)… you can save and leave; this runs in the background.</div>;
  }
  if (status === 'ready') {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-green-600">
          {labels ? `✓ Quality options ready: ${labels} + Source` : '✓ Source quality only (video is already low-resolution)'}
        </span>
        <button type="button" onClick={onRetry} className="text-blue-600 hover:underline">Rebuild</button>
      </div>
    );
  }
  if (status === 'failed') {
    return (
      <div className="flex items-center justify-between text-xs">
        <span className="text-red-600" title={m.transcodeError || ''}>✗ Quality generation failed{m.transcodeError ? `: ${m.transcodeError}` : ''}</span>
        <button type="button" onClick={onRetry} className="text-blue-600 hover:underline">Retry</button>
      </div>
    );
  }
  // status === 'none' — has a source but hasn't been processed yet.
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-400">Quality options not generated yet.</span>
      <button type="button" onClick={onRetry} className="text-blue-600 hover:underline">Generate now</button>
    </div>
  );
}

function AssignModal({ course, onClose, onDone }) {
  const [people, setPeople] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [q, setQ] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/employees?excludeExecutives=true').then(({ data }) => {
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
            <div key={e._id} className="py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
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

// ===== Pending self-enroll approvals =====
function ApprovalsModal({ onClose, onChange }) {
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
            <div key={e._id} className="py-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-900 truncate">{e.employee ? `${e.employee.firstName || ''} ${e.employee.lastName || ''}`.trim() || e.employee.email : '-'}</div>
                <div className="text-xs text-gray-400 truncate">wants “{e.course?.title || 'a course'}”</div>
              </div>
              <button disabled={busyId === e._id} onClick={() => act(e._id, 'approve')} className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">Approve</button>
              <button disabled={busyId === e._id} onClick={() => act(e._id, 'reject')} className="px-3 py-1.5 text-xs border rounded-lg hover:bg-gray-50 disabled:opacity-60">Reject</button>
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
                {status === 'Open' ? (
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

function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="card-title">{title}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}
