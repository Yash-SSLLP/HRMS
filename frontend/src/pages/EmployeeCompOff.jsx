import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-blue-100 text-blue-800',
  Availed: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');

export default function EmployeeCompOff() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ workedDate: '', reason: '' });

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/compoff/me');
      setItems(data.items);
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
      await api.post('/compoff', form);
      setShowModal(false);
      setForm({ workedDate: '', reason: '' });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit request');
    } finally {
      setSaving(false);
    }
  };

  const avail = async (id) => {
    setError('');
    try {
      await api.patch(`/compoff/me/${id}/avail`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not avail comp-off');
    }
  };

  return (
    <div>
      <PageHeader
        title="Comp-off"
        subtitle="Request a compensatory off for a holiday or weekend you worked. Approved comp-offs can be availed before they expire."
      >
        <button onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + Request Comp-off
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Worked date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Expiry</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No comp-off requests</td></tr>
            ) : items.map((it) => (
              <tr key={it._id}>
                <td className="px-4 py-3 text-gray-700">{fmtDate(it.workedDate)}</td>
                <td className="px-4 py-3">
                  {it.reason}
                  {it.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {it.reviewNote}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-lg ${STATUS_STYLES[it.status]}`}>
                    {it.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-500">{fmtDate(it.expiryDate)}</td>
                <td className="px-4 py-3 text-right">
                  {it.status === 'Approved' ? (
                    <button onClick={() => avail(it._id)} className="text-blue-600 hover:underline">Avail</button>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">Request Comp-off</h2>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Worked date *</label>
                <input required type="date" value={form.workedDate}
                  onChange={(e) => setForm({ ...form, workedDate: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Reason *</label>
                <textarea required value={form.reason} rows={4} maxLength={2000}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
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
