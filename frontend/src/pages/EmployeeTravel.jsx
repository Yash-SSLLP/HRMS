import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const TRAVEL_MODES = ['Flight', 'Train', 'Bus', 'Car', 'Other'];

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Completed: 'bg-blue-100 text-blue-800',
  Rejected: 'bg-red-100 text-red-800',
};

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

const emptyForm = {
  purpose: '',
  origin: '',
  destination: '',
  fromDate: '',
  toDate: '',
  modeOfTravel: 'Flight',
  estimatedCost: '',
  advanceRequested: '',
  notes: '',
};

export default function EmployeeTravel() {
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
      const { data } = await api.get('/travel/me');
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
      await api.post('/travel', {
        ...form,
        estimatedCost: form.estimatedCost === '' ? 0 : Number(form.estimatedCost),
        advanceRequested: form.advanceRequested === '' ? 0 : Number(form.advanceRequested),
      });
      setShowModal(false);
      setForm(emptyForm);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit travel request');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader title="Travel Requests" subtitle="Request and track your business travel.">
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
              <th className="px-4 py-3 text-left font-medium text-gray-700">Purpose</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Route</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Dates</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Mode</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Est. cost</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Advance</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No travel requests yet</td></tr>
            ) : items.map((t) => (
              <tr key={t._id}>
                <td className="px-4 py-3">{t.purpose}</td>
                <td className="px-4 py-3">{t.origin} → {t.destination}</td>
                <td className="px-4 py-3 text-gray-500">
                  {new Date(t.fromDate).toLocaleDateString()} – {new Date(t.toDate).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">{t.modeOfTravel}</td>
                <td className="px-4 py-3 text-right">{inr.format(t.estimatedCost || 0)}</td>
                <td className="px-4 py-3 text-right">{inr.format(t.advanceRequested || 0)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-1 rounded-lg ${STATUS_STYLES[t.status]}`}>
                    {t.status}
                  </span>
                  {t.reviewNote && (
                    <div className="text-xs text-gray-500 mt-1">Note: {t.reviewNote}</div>
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
            <h2 className="card-title mb-4">New Travel Request</h2>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Purpose *</label>
                <input required value={form.purpose}
                  onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Origin *</label>
                  <input required value={form.origin}
                    onChange={(e) => setForm({ ...form, origin: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Destination *</label>
                  <input required value={form.destination}
                    onChange={(e) => setForm({ ...form, destination: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">From date *</label>
                  <input required type="date" value={form.fromDate}
                    onChange={(e) => setForm({ ...form, fromDate: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">To date *</label>
                  <input required type="date" value={form.toDate}
                    onChange={(e) => setForm({ ...form, toDate: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Mode of travel</label>
                <select value={form.modeOfTravel}
                  onChange={(e) => setForm({ ...form, modeOfTravel: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {TRAVEL_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Estimated cost (INR)</label>
                  <input type="number" min="0" value={form.estimatedCost}
                    onChange={(e) => setForm({ ...form, estimatedCost: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Advance requested (INR)</label>
                  <input type="number" min="0" value={form.advanceRequested}
                    onChange={(e) => setForm({ ...form, advanceRequested: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Notes</label>
                <textarea value={form.notes} rows={3}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
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
