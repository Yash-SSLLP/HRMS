/**
 * AdminHolidays — holiday calendar management (admin portal). Lists holidays for
 * a year from GET /holidays and creates/edits/deletes via POST/PUT/DELETE
 * /holidays. Holidays feed the shared calendar and attendance status.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const TYPES = ['Public', 'Restricted', 'Company'];
const blank = { name: '', date: '', type: 'Public', description: '' };

export default function AdminHolidays() {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [holidays, setHolidays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get(`/holidays?year=${year}`);
      setHolidays(data.holidays);
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
    setShowModal(true);
  };

  const openEdit = (h) => {
    setEditingId(h._id);
    setForm({
      name: h.name,
      date: h.date ? h.date.slice(0, 10) : '',
      type: h.type,
      description: h.description || '',
    });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/holidays/${editingId}`, form);
      } else {
        await api.post('/holidays', form);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (h) => {
    if (!(await confirmDialog({ message: `Delete "${h.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/holidays/${h._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Holidays">
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
          className="border rounded-lg px-3 py-2 text-sm">
          {[thisYear - 1, thisYear, thisYear + 1].map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
          + Add Holiday
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
              <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Type</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={4} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : holidays.length === 0 ? (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">No holidays for {year}</td></tr>
            ) : holidays.map((h) => (
              <tr key={h._id}>
                <td className="px-4 py-3 whitespace-nowrap">
                  {new Date(h.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
                </td>
                <td className="px-4 py-3">
                  {h.name}
                  {h.description && <div className="text-xs text-gray-500">{h.description}</div>}
                </td>
                <td className="px-4 py-3">{h.type}</td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openEdit(h)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => remove(h)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Holiday' : 'Add Holiday'}</h2>
            <form onSubmit={save} className="space-y-3">
              <div>
                <label className="block text-sm text-gray-700">Name *</label>
                <input required value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="mt-1 block w-full border rounded-lg px-3 py-2" />
              </div>
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
                  {TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Description</label>
                <input value={form.description}
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
