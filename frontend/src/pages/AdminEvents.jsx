/**
 * AdminEvents — company event management (admin portal). Lists events for a year
 * from GET /events and creates/edits/deletes via POST/PUT/DELETE /events; a new
 * event notifies every employee and shows on the shared Calendar.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const blank = { title: '', date: '', time: '', location: '', description: '' };

export default function AdminEvents() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/events?year=${year}`);
      setEvents(data.events);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [year]);

  const openCreate = () => {
    setEditingId(null);
    setForm(blank);
    setInfo('');
    setShowModal(true);
  };

  const openEdit = (ev) => {
    setEditingId(ev._id);
    setForm({
      title: ev.title,
      date: ev.date ? ev.date.slice(0, 10) : '',
      time: ev.time || '',
      location: ev.location || '',
      description: ev.description || '',
    });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/events/${editingId}`, form);
        setInfo('');
      } else {
        const { data } = await api.post('/events', form);
        setInfo(`Event created · ${data.notified} employee(s) notified.`);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (ev) => {
    if (!(await confirmDialog({ message: `Delete "${ev.title}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/events/${ev._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Events" subtitle="Creating an event notifies every employee and adds it to the shared calendar.">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
          className="border rounded-lg px-3 py-2 text-sm">
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + Create Event
        </button>
      </PageHeader>

      {info && (
        <div className="mb-4 text-sm text-green-700 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">{info}</div>
      )}
      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Date</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Title</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">When / Where</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : events.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No events for {year}</td></tr>
            ) : events.map((ev) => (
              <tr key={ev._id}>
                <td className="px-4 py-3 whitespace-nowrap">
                  {new Date(ev.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                </td>
                <td className="px-4 py-3">
                  {ev.title}
                  {ev.description && <div className="text-xs text-gray-500 max-w-md truncate">{ev.description}</div>}
                </td>
                <td className="px-4 py-3 text-gray-600">
                  {[ev.time, ev.location].filter(Boolean).join(' · ') || '-'}
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openEdit(ev)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(ev)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Event' : 'Create Event'}</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Title *</label>
                <input required value={form.title} maxLength={200}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Date *</label>
                  <input type="date" required value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Time</label>
                  <input value={form.time} placeholder="e.g. 4:00 PM"
                    onChange={(e) => setForm({ ...form, time: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Location</label>
                <input value={form.location}
                  onChange={(e) => setForm({ ...form, location: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <textarea value={form.description} rows={3} maxLength={5000}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
              {!editingId && (
                <p className="text-xs text-gray-500">All employees will be notified when you create this event.</p>
              )}
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)}
                  className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
