/**
 * AdminTraining — instructor-led training programs. Distinct from the LMS
 * courses managed on AdminCourses.
 *
 * ONE PAGE, TWO MOUNTS (2026-09-22): /admin/training and /employee/training.
 * The second exists because `training.manage` is grantable to ANY account by
 * the standalone User.trainingAccess switch — a training coordinator is often
 * neither HR nor a manager, and they need somewhere to run it from. Whoever
 * holds the grant gets the whole module, booking included; there is no
 * read-only tier ("whoever has access they can create that").
 *
 * `writable` survives for the accounts that can SEE the portal but not write to
 * it — a CEO/MD in view-only mode, and the God audit login. They get the list
 * and no buttons.
 *
 * PARTICIPANTS COME FROM /training/people, NOT /admin/users. That route is
 * role-gated (SuperAdmin, HRManager, CEO, MD, LDManager), so an Employee
 * holding the grant would have opened "New Training" and found nobody to add.
 *
 * Dates carry a TIME. The model always stored a Date, and the form always threw
 * the time away — so "Tomorrow" was all anybody could say about a session that
 * starts at 2pm.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';
import { peopleOptions } from '../utils/peopleOptions';
import { useAuthStore } from '../store/authStore';
import { hasPermission } from '../config/permissions';
import { formatDateTime12 } from '../utils/time';

const STATUS = ['Planned', 'Ongoing', 'Completed', 'Cancelled'];
const STATUS_STYLES = {
  Planned: 'bg-gray-100 text-gray-700',
  Ongoing: 'bg-blue-100 text-blue-800',
  Completed: 'bg-green-100 text-green-800',
  Cancelled: 'bg-red-100 text-red-700',
};
const blank = { title: '', description: '', trainer: '', startDate: '', endDate: '', status: 'Planned', participants: [] };

/**
 * What `<input type="datetime-local">` wants: 'YYYY-MM-DDTHH:mm' in LOCAL time.
 *
 * Built by hand from the local parts rather than by slicing toISOString(),
 * which is UTC — the old code sliced the first 10 characters off the stored
 * string, and east of Greenwich that silently shows the WRONG DAY for anything
 * scheduled after half past five in the evening.
 */
const toLocalInput = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}`;
};

/**
 * A training's date, with its time when it has one.
 *
 * 12-hour with am/pm, which is the rule everywhere in this portal that shows a
 * time of day. Midnight prints as the date alone: every training scheduled
 * before today carries a midnight stamp because the form only ever sent a date,
 * and printing "12:00 am" against all of them would read as a real decision
 * somebody made.
 */
/**
 * A training's date, with its time when it has one.
 *
 * Midnight prints as the date alone — that is how "a date, no time" is stored,
 * and it is the ONLY shape it has: the server pins a bare 'YYYY-MM-DD' to IST
 * midnight on the way in (trainingController.asInstant), so this does not have
 * to guess between local midnight and UTC midnight. It used to, and the guess
 * cost a real time: 05:30 IST *is* UTC midnight, so a training that genuinely
 * started at half past five had its time silently dropped.
 *
 * formatDateTime12 rather than a toLocaleTimeString of its own — it is the
 * portal's one 12-hour formatter, and it already fixes the en-IN casing split
 * that otherwise prints "6:00 pm" here and "6:00 PM" everywhere else.
 */
const fmt = (d) => {
  if (!d) return '-';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '-';
  if (dt.getHours() === 0 && dt.getMinutes() === 0) {
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
  }
  return formatDateTime12(dt, { year: false });
};

export default function AdminTraining() {
  const user = useAuthStore((st) => st.user);
  const writable = hasPermission(user, 'training.manage');
  const [trainings, setTrainings] = useState([]);
  const [users, setUsers] = useState([]);
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
      // The module's OWN people route — see the docblock. Only fetched when
      // there is a form to fill: a view-only exec never opens one.
      const [tRes, uRes] = await Promise.all([
        api.get('/training'),
        writable ? api.get('/training/people') : Promise.resolve(null),
      ]);
      setTrainings(tRes.data.trainings);
      if (uRes) setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, [writable]);

  const openCreate = () => { setEditingId(null); setForm(blank); setShowModal(true); };
  const openEdit = (t) => {
    setEditingId(t._id);
    setForm({
      title: t.title, description: t.description || '', trainer: t.trainer || '',
      startDate: toLocalInput(t.startDate), endDate: toLocalInput(t.endDate),
      status: t.status, participants: (t.participants || []).map((p) => p._id),
    });
    setShowModal(true);
  };
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      /**
       * Sent as an absolute instant, not as the local string the input holds.
       * '2026-09-22T14:30' has no timezone in it, so whoever parses it decides
       * what it means — and the server is not necessarily in the same one as
       * the person who typed it. toISOString() settles that here.
       */
      const payload = {
        ...form,
        startDate: form.startDate ? new Date(form.startDate).toISOString() : null,
        endDate: form.endDate ? new Date(form.endDate).toISOString() : null,
      };
      if (editingId) await api.put(`/training/${editingId}`, payload);
      else await api.post('/training', payload);
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const remove = async (t) => {
    if (!(await confirmDialog({ message: `Delete training "${t.title}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/training/${t._id}`); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
  };

  return (
    <div>
      <PageHeader title="Training">
        {writable && (
          <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Training</button>
        )}
      </PageHeader>
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Training</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Trainer</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Dates</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Participants</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            {writable && <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>}
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={writable ? 6 : 5} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : trainings.length === 0 ? (
              <tr><td colSpan={writable ? 6 : 5} className="px-4 py-6 text-center text-gray-500">
                {writable ? 'No training programs' : 'Nothing is scheduled yet. Programs appear here once HR books them.'}
              </td></tr>
            ) : trainings.map((t) => (
              <tr key={t._id}>
                <td className="px-4 py-3 font-medium text-gray-900">{t.title}</td>
                <td className="px-4 py-3 text-gray-600">{t.trainer || '-'}</td>
                <td className="px-4 py-3 text-gray-600">{fmt(t.startDate)} → {fmt(t.endDate)}</td>
                <td className="px-4 py-3">{(t.participants || []).length}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[t.status]}`}>{t.status}</span></td>
                {writable && (
                  <td className="px-4 py-3 text-right space-x-2">
                    <button onClick={() => openEdit(t)} className="text-blue-600 hover:underline">Edit</button>
                    <button onClick={() => remove(t)} className="text-red-600 hover:underline">Delete</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Training' : 'New Training'}</h2>
            <form onSubmit={save} className="space-y-3">
              <input required placeholder="Title *" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input placeholder="Trainer" value={form.trainer} onChange={(e) => setForm({ ...form, trainer: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
                {/* Date AND time, in one control rather than two: a session
                    runs from a moment to a moment, and a separate time box that
                    can be filled in with no date beside it is a state nobody
                    means. The browser draws its own am/pm picker. */}
                <div><label className="block text-xs text-gray-500">Starts</label><input type="datetime-local" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2" /></div>
                <div>
                  <label className="block text-xs text-gray-500">Ends</label>
                  {/* Cannot be set before the start — the picker will not offer
                      the earlier days, so a backwards range cannot be typed. */}
                  <input type="datetime-local" value={form.endDate} min={form.startDate || undefined} onChange={(e) => setForm({ ...form, endDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>
              <div>
                <label className="block text-sm text-gray-700">Participants</label>
                <SearchableSelect multiple value={form.participants}
                  onChange={(e) => setForm({ ...form, participants: Array.from(e.target.selectedOptions, (o) => o.value) })}
                  placeholder="Select participants…"
                  className="mt-1 block w-full border rounded-lg px-3 py-2">
                  {peopleOptions(users, (u) => `${u.firstName} ${u.lastName} (${u.role})`, { keep: form.participants })}
                </SearchableSelect>
                <p className="text-xs text-gray-400 mt-1">Search and tick everyone attending.</p>
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
    </div>
  );
}
