import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const CYCLE_STATUS = ['Draft', 'Active', 'Closed'];
const STATUS_STYLES = {
  Draft: 'bg-gray-200 text-gray-600',
  Active: 'bg-green-100 text-green-800',
  Closed: 'bg-blue-100 text-blue-800',
};
const RELATIONSHIPS = ['self', 'manager', 'peer'];
const REL_LABELS = { self: 'Self', manager: 'Manager', peer: 'Peer' };
const REVIEW_STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Submitted: 'bg-green-100 text-green-800',
};

const blankCycle = {
  name: '',
  description: '',
  periodStart: '',
  periodEnd: '',
  status: 'Draft',
  competencies: 'Communication, Ownership, Technical, Teamwork',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '');
const userName = (u) => (u ? `${u.firstName} ${u.lastName}` : '—');

export default function AdminReviewCycles() {
  const [cycles, setCycles] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create/edit cycle modal
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankCycle);
  const [saving, setSaving] = useState(false);

  // Manage panel
  const [manageCycle, setManageCycle] = useState(null);
  const [cycleReviews, setCycleReviews] = useState([]);
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [assignForm, setAssignForm] = useState({ employee: '', reviewer: '', relationship: 'peer' });
  const [assigning, setAssigning] = useState(false);
  const [manageError, setManageError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [cRes, uRes] = await Promise.all([
        api.get('/reviews/cycles'),
        api.get('/admin/users'),
      ]);
      setCycles(cRes.data.cycles);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const toInput = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

  const openCreate = () => { setEditingId(null); setForm(blankCycle); setShowModal(true); };
  const openEdit = (c) => {
    setEditingId(c._id);
    setForm({
      name: c.name || '',
      description: c.description || '',
      periodStart: toInput(c.periodStart),
      periodEnd: toInput(c.periodEnd),
      status: c.status || 'Draft',
      competencies: (c.competencies || []).join(', '),
    });
    setShowModal(true);
  };

  const saveCycle = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: form.name,
        description: form.description,
        periodStart: form.periodStart || undefined,
        periodEnd: form.periodEnd || undefined,
        status: form.status,
        competencies: form.competencies
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
      if (editingId) await api.put(`/reviews/cycles/${editingId}`, payload);
      else await api.post('/reviews/cycles', payload);
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const removeCycle = async (c) => {
    if (!window.confirm(`Delete cycle "${c.name}" and all its reviews?`)) return;
    try {
      await api.delete(`/reviews/cycles/${c._id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    }
  };

  const loadCycleReviews = async (cycleId) => {
    setReviewsLoading(true);
    setManageError('');
    try {
      const res = await api.get(`/reviews/cycles/${cycleId}/reviews`);
      setCycleReviews(res.data.reviews);
    } catch (err) {
      setManageError(err.response?.data?.message || 'Failed to load reviews');
    } finally {
      setReviewsLoading(false);
    }
  };

  const openManage = (c) => {
    setManageCycle(c);
    setAssignForm({ employee: '', reviewer: '', relationship: 'peer' });
    setManageError('');
    setCycleReviews([]);
    loadCycleReviews(c._id);
  };

  const doAssign = async (e) => {
    e.preventDefault();
    if (!assignForm.employee || !assignForm.reviewer) {
      setManageError('Select both an employee and a reviewer.');
      return;
    }
    setAssigning(true);
    setManageError('');
    try {
      await api.post(`/reviews/cycles/${manageCycle._id}/assign`, assignForm);
      setAssignForm({ employee: '', reviewer: '', relationship: 'peer' });
      await loadCycleReviews(manageCycle._id);
      await load();
    } catch (err) {
      setManageError(err.response?.data?.message || 'Assign failed');
    } finally {
      setAssigning(false);
    }
  };

  return (
    <div>
      <PageHeader title="Appraisal Cycles" subtitle="Create review cycles and assign 360° reviewers.">
        <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Cycle</button>
      </PageHeader>
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Cycle</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Period</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Reviews</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : cycles.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No cycles yet</td></tr>
            ) : cycles.map((c) => (
              <tr key={c._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{c.name}<div className="text-xs text-gray-500">{c.description}</div></td>
                <td className="px-4 py-3 text-gray-600">{fmtDate(c.periodStart)}{c.periodEnd ? ` – ${fmtDate(c.periodEnd)}` : ''}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[c.status]}`}>{c.status}</span></td>
                <td className="px-4 py-3 text-gray-600">{c.reviewCount ?? 0}</td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openManage(c)} className="text-emerald-700 hover:underline">Manage</button>
                  <button onClick={() => openEdit(c)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => removeCycle(c)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create/Edit cycle modal */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Cycle' : 'New Cycle'}</h2>
            <form onSubmit={saveCycle} className="space-y-3">
              <input required placeholder="Name *" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Period start</label>
                  <input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Period end</label>
                  <input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                {CYCLE_STATUS.map((s) => <option key={s}>{s}</option>)}
              </select>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Competencies (comma-separated)</label>
                <input placeholder="Communication, Ownership, Technical, Teamwork" value={form.competencies} onChange={(e) => setForm({ ...form, competencies: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
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

      {/* Manage modal */}
      {manageCycle && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="card-title">Manage: {manageCycle.name}</h2>
              <button onClick={() => setManageCycle(null)} className="text-gray-400 hover:text-gray-700 text-sm">✕</button>
            </div>
            <p className="text-xs text-gray-500 mb-4">Assign reviewers and track submitted reviews for this cycle.</p>

            {manageError && (
              <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{manageError}</div>
            )}

            {/* Assign form */}
            <form onSubmit={doAssign} className="bg-gray-50 border rounded-lg p-4 mb-4">
              <div className="text-sm font-medium text-gray-800 mb-3">Assign a review</div>
              <div className="grid gap-3 sm:grid-cols-3">
                <select value={assignForm.employee} onChange={(e) => setAssignForm({ ...assignForm, employee: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  <option value="">Employee being reviewed…</option>
                  {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName}</option>)}
                </select>
                <select value={assignForm.reviewer} onChange={(e) => setAssignForm({ ...assignForm, reviewer: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  <option value="">Reviewer…</option>
                  {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName}</option>)}
                </select>
                <select value={assignForm.relationship} onChange={(e) => setAssignForm({ ...assignForm, relationship: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  {RELATIONSHIPS.map((r) => <option key={r} value={r}>{REL_LABELS[r]}</option>)}
                </select>
              </div>
              <div className="flex justify-end mt-3">
                <button type="submit" disabled={assigning} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{assigning ? 'Assigning…' : 'Assign review'}</button>
              </div>
            </form>

            {/* Reviews list */}
            <div className="text-sm font-medium text-gray-800 mb-2">Reviews in this cycle</div>
            {reviewsLoading ? (
              <div className="text-sm text-gray-500">Loading…</div>
            ) : cycleReviews.length === 0 ? (
              <div className="text-sm text-gray-500">No reviews assigned yet.</div>
            ) : (
              <div className="overflow-hidden border rounded-lg">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50"><tr>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Employee</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Reviewer</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Relationship</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Status</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-700">Overall</th>
                  </tr></thead>
                  <tbody className="divide-y divide-gray-100">
                    {cycleReviews.map((r) => (
                      <tr key={r._id}>
                        <td className="px-3 py-2 text-gray-900">{userName(r.employee)}</td>
                        <td className="px-3 py-2 text-gray-700">{userName(r.reviewer)}</td>
                        <td className="px-3 py-2 text-gray-600">{REL_LABELS[r.relationship] || r.relationship}</td>
                        <td className="px-3 py-2"><span className={`text-xs px-2 py-0.5 rounded-lg ${REVIEW_STATUS_STYLES[r.status]}`}>{r.status}</span></td>
                        <td className="px-3 py-2 text-gray-700">{r.overallRating ? `${r.overallRating}/5` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end mt-4">
              <button type="button" onClick={() => setManageCycle(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
