import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_LABELS = {
  open: 'Open',
  under_review: 'Under review',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

const STATUS_STYLES = {
  open: 'bg-amber-100 text-amber-800',
  under_review: 'bg-blue-100 text-blue-800',
  resolved: 'bg-green-100 text-green-800',
  dismissed: 'bg-gray-200 text-gray-700',
};

export default function EmployeeComplaints() {
  const [complaints, setComplaints] = useState([]);
  const [people, setPeople] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ againstUserId: '', subject: '', description: '' });

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [mineRes, dirRes] = await Promise.all([
        api.get('/complaints/mine'),
        api.get('/chat/directory'),
      ]);
      setComplaints(mineRes.data.complaints);
      setPeople(dirRes.data.people);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/complaints', form);
      setShowModal(false);
      setForm({ againstUserId: '', subject: '', description: '' });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit complaint');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="My Complaints"
        subtitle="Your complaint is shared confidentially with the CEO, HR and Super Admin - never with the person it's about."
      >
        <button onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + Raise Complaint
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Subject</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Against</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Handled by</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Raised</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : complaints.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No complaints raised</td></tr>
            ) : complaints.map((c) => (
              <tr key={c._id}>
                <td className="px-4 py-3">
                  {c.subject}
                  {c.resolutionNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {c.resolutionNote}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  {c.against ? `${c.against.firstName} ${c.against.lastName}` : '-'}
                  <div className="text-xs text-gray-500">{c.against?.role}</div>
                </td>
                <td className="px-4 py-3">
                  {c.assignedTo ? `${c.assignedTo.firstName} ${c.assignedTo.lastName}` : '-'}
                  <div className="text-xs text-gray-500">{c.assignedTo?.role}</div>
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-lg ${STATUS_STYLES[c.status]}`}>
                    {STATUS_LABELS[c.status]}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{new Date(c.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">Raise a Complaint</h2>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Against *</label>
                <select required value={form.againstUserId}
                  onChange={(e) => setForm({ ...form, againstUserId: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  <option value="">Select a person…</option>
                  {people.map((p) => (
                    <option key={p._id} value={p._id}>{p.fullName} ({p.role})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Subject *</label>
                <input required value={form.subject} maxLength={200}
                  onChange={(e) => setForm({ ...form, subject: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description *</label>
                <textarea required value={form.description} rows={5} maxLength={5000}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Submitting…' : 'Submit'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
