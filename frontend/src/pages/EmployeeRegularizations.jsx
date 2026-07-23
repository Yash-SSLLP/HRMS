/**
 * EmployeeRegularizations — attendance-correction requests (employee portal).
 * Lists the user's requests from GET /regularizations/me and submits new ones
 * via POST /regularizations. Approval is done by HR/manager on the admin side.
 */
import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const TYPES = [
  'Missing Punch',
  'Wrong Time',
  'Forgot Check-in',
  'Forgot Check-out',
  'On Duty',
  'Other',
];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const emptyForm = {
  date: '',
  type: 'Other',
  requestedCheckIn: '',
  requestedCheckOut: '',
  reason: '',
};

export default function EmployeeRegularizations() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/regularizations/me');
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
      await api.post('/regularizations', form);
      setShowModal(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit request');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Attendance Regularization"
        subtitle="Request a correction for a missing or wrong attendance punch."
      >
        <button onClick={() => setShowModal(true)}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + New Request
        </button>
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Requested times</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Reason</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No regularization requests</td></tr>
            ) : items.map((r) => (
              <tr key={r._id}>
                <td className="px-4 py-3 text-gray-700">{new Date(r.date).toLocaleDateString()}</td>
                <td className="px-4 py-3">{r.type}</td>
                <td className="px-4 py-3 text-gray-700">
                  {r.requestedCheckIn || '-'} – {r.requestedCheckOut || '-'}
                </td>
                <td className="px-4 py-3">
                  {r.reason}
                  {r.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {r.reviewNote}</div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${STATUS_STYLES[r.status]}`}>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">New Regularization Request</h2>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Date *</label>
                <input type="date" required value={form.date}
                  onChange={(e) => setForm({ ...form, date: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Type</label>
                <select value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Requested check-in</label>
                  <input type="time" value={form.requestedCheckIn}
                    onChange={(e) => setForm({ ...form, requestedCheckIn: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Requested check-out</label>
                  <input type="time" value={form.requestedCheckOut}
                    onChange={(e) => setForm({ ...form, requestedCheckOut: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
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
