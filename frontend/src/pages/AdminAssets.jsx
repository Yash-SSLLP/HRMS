import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import PromptDialog from '../components/PromptDialog';

const CATEGORIES = ['Laptop', 'Desktop', 'Monitor', 'Phone', 'SIM', 'Furniture', 'Vehicle', 'Other'];
const STATUS = ['Available', 'Assigned', 'InRepair', 'Retired'];
const STATUS_STYLES = {
  Available: 'bg-green-100 text-green-800',
  Assigned: 'bg-blue-100 text-blue-800',
  InRepair: 'bg-amber-100 text-amber-800',
  Retired: 'bg-gray-200 text-gray-600',
};
const blank = { name: '', assetTag: '', category: 'Laptop', serialNumber: '', status: 'Available', notes: '' };
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
const personName = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email : '-');

export default function AdminAssets() {
  const [tab, setTab] = useState('assets');
  const [assets, setAssets] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Asset create/edit
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [addingName, setAddingName] = useState(false);

  // Assign / return
  const [assignFor, setAssignFor] = useState(null); // asset preset, or {} to pick an asset
  const [assignUser, setAssignUser] = useState('');
  const [assignAssetId, setAssignAssetId] = useState('');
  const [assignDate, setAssignDate] = useState(today());
  const [assignNote, setAssignNote] = useState('');
  const [returnFor, setReturnFor] = useState(null); // assignment being returned
  const [returnDate, setReturnDate] = useState(today());
  const [busy, setBusy] = useState(false);

  // Assignment register
  const [assignments, setAssignments] = useState([]);
  const [aLoading, setALoading] = useState(false);
  const [activeOnly, setActiveOnly] = useState(true);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [aRes, uRes] = await Promise.all([api.get('/assets'), api.get('/admin/users?active=true&excludeExecutives=true')]);
      setAssets(aRes.data.assets);
      setUsers(uRes.data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const loadAssignments = async () => {
    setALoading(true);
    try {
      const { data } = await api.get('/assets/assignments', { params: activeOnly ? { active: 'true' } : {} });
      setAssignments(data.assignments);
    } catch (err) { setError(err.response?.data?.message || 'Failed to load assignments'); }
    finally { setALoading(false); }
  };
  useEffect(() => { if (tab === 'assignments') loadAssignments(); /* eslint-disable-next-line */ }, [tab, activeOnly]);

  // ---- Asset CRUD ----
  const openCreate = () => { setEditingId(null); setForm(blank); setShowModal(true); };
  const openEdit = (a) => {
    setEditingId(a._id);
    setForm({ name: a.name, assetTag: a.assetTag, category: a.category, serialNumber: a.serialNumber || '', status: a.status, notes: a.notes || '' });
    setShowModal(true);
  };
  const save = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (editingId) await api.put(`/assets/${editingId}`, form);
      else await api.post('/assets', form);
      setShowModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const remove = async (a) => {
    if (!window.confirm(`Delete asset "${a.name}"? This also removes its assignment history.`)) return;
    try { await api.delete(`/assets/${a._id}`); await load(); if (tab === 'assignments') loadAssignments(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };

  // ---- Assign / return ----
  const openAssign = (asset) => {
    setAssignFor(asset || {});
    setAssignAssetId(asset?._id || '');
    setAssignUser(asset?.assignedTo?._id || '');
    setAssignDate(today());
    setAssignNote('');
  };
  const doAssign = async (e) => {
    e.preventDefault();
    const assetId = assignFor?._id || assignAssetId;
    if (!assetId) { alert('Please pick an asset.'); return; }
    if (!assignUser) { alert('Please pick an employee to assign to.'); return; }
    setBusy(true);
    try {
      await api.patch(`/assets/${assetId}/assign`, { userId: assignUser, date: assignDate, note: assignNote });
      setAssignFor(null); await load(); if (tab === 'assignments') loadAssignments();
    } catch (err) { alert(err.response?.data?.message || 'Assign failed'); }
    finally { setBusy(false); }
  };
  const openReturn = (assignment) => { setReturnFor(assignment); setReturnDate(today()); };
  const doReturn = async (e) => {
    e.preventDefault();
    const assetId = returnFor.asset?._id || returnFor.asset;
    setBusy(true);
    try {
      await api.patch(`/assets/${assetId}/assign`, { userId: null, date: returnDate });
      setReturnFor(null); await load(); if (tab === 'assignments') loadAssignments();
    } catch (err) { alert(err.response?.data?.message || 'Return failed'); }
    finally { setBusy(false); }
  };

  const assignableAssets = assets.filter((a) => a.status !== 'Retired');
  // Distinct asset names already in use — populate the Name dropdown so repeated
  // models stay consistent; a new name can be added inline.
  const assetNames = useMemo(
    () => [...new Set(assets.map((a) => a.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [assets]
  );

  return (
    <div>
      <PageHeader title="Assets" subtitle="Company assets and who they’re issued to">
        {tab === 'assets'
          ? <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Asset</button>
          : <button onClick={() => openAssign(null)} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ Assign asset</button>}
      </PageHeader>

      <div className="flex gap-1 mb-4 border-b border-gray-200">
        {[['assets', 'Assets'], ['assignments', 'Assignments']].map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 -mb-px border-b-2 text-sm ${tab === k ? 'border-gray-900 text-gray-900 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* ===== Assets inventory ===== */}
      {tab === 'assets' && (
        <div className="bg-white shadow rounded-lg overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200 text-sm">
            <thead className="bg-gray-50"><tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Asset</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Tag</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Category</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Assigned To</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
              ) : assets.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No assets</td></tr>
              ) : assets.map((a) => (
                <tr key={a._id}>
                  <td className="px-4 py-3 font-medium text-gray-900">{a.name}<div className="text-xs text-gray-500">{a.serialNumber}</div></td>
                  <td className="px-4 py-3 font-mono text-xs">{a.assetTag}</td>
                  <td className="px-4 py-3 text-gray-600">{a.category}</td>
                  <td className="px-4 py-3">
                    {a.assignedTo ? (
                      <span>{personName(a.assignedTo)}<div className="text-xs text-gray-400">since {fmtDate(a.assignedAt)}</div></span>
                    ) : '-'}
                  </td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STATUS_STYLES[a.status]}`}>{a.status}</span></td>
                  <td className="px-4 py-3 text-right space-x-2">
                    <button onClick={() => openAssign(a)} className="text-emerald-700 hover:underline">{a.assignedTo ? 'Reassign' : 'Assign'}</button>
                    <button onClick={() => openEdit(a)} className="text-blue-600 hover:underline">Edit</button>
                    <button onClick={() => remove(a)} className="text-red-600 hover:underline">Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ===== Assignment register (who has / had what, and when) ===== */}
      {tab === 'assignments' && (
        <>
          <label className="flex items-center gap-2 text-sm text-gray-600 mb-3">
            <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} />
            Currently issued only (hide returned)
          </label>
          <div className="bg-white shadow rounded-lg overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50"><tr>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Asset</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Assigned on</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Returned on</th>
                <th className="px-4 py-3 text-left font-medium text-gray-700">Note</th>
                <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {aLoading ? (
                  <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
                ) : assignments.length === 0 ? (
                  <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No {activeOnly ? 'active ' : ''}assignments yet</td></tr>
                ) : assignments.map((r) => (
                  <tr key={r._id}>
                    <td className="px-4 py-3">
                      <span className="font-medium text-gray-900">{r.asset?.name || 'Asset'}</span>
                      <div className="text-xs text-gray-500 font-mono">{r.asset?.assetTag}{r.asset?.category ? ` · ${r.asset.category}` : ''}</div>
                    </td>
                    <td className="px-4 py-3">{personName(r.employee)}</td>
                    <td className="px-4 py-3 text-gray-700">{fmtDate(r.assignedAt)}</td>
                    <td className="px-4 py-3">
                      {r.returnedAt
                        ? <span className="text-gray-700">{fmtDate(r.returnedAt)}</span>
                        : <span className="text-xs px-2 py-0.5 rounded-lg bg-blue-100 text-blue-800">Currently held</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{r.note || '-'}</td>
                    <td className="px-4 py-3 text-right">
                      {!r.returnedAt && <button onClick={() => openReturn(r)} className="text-amber-700 hover:underline">Mark returned</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ===== New / edit asset ===== */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-md p-6">
            <h2 className="card-title mb-4">{editingId ? 'Edit Asset' : 'New Asset'}</h2>
            <form onSubmit={save} className="space-y-3">
              <select
                required
                value={form.name || ''}
                onChange={(e) => { if (e.target.value === '__new__') setAddingName(true); else setForm({ ...form, name: e.target.value }); }}
                className="block w-full border rounded-lg px-3 py-2"
              >
                <option value="">Select asset name *</option>
                {assetNames.map((n) => <option key={n} value={n}>{n}</option>)}
                {form.name && !assetNames.includes(form.name) && <option value={form.name}>{form.name}</option>}
                <option value="__new__">＋ Add new name…</option>
              </select>
              <input required placeholder="Asset Tag *" value={form.assetTag} onChange={(e) => setForm({ ...form, assetTag: e.target.value.toUpperCase() })} className="block w-full border rounded-lg px-3 py-2 font-mono" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{CATEGORIES.map((c) => <option key={c}>{c}</option>)}</select>
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2">{STATUS.map((s) => <option key={s}>{s}</option>)}</select>
              </div>
              <input placeholder="Serial Number" value={form.serialNumber} onChange={(e) => setForm({ ...form, serialNumber: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Notes" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {addingName && (
        <PromptDialog
          title="Add asset name"
          label="Asset name"
          placeholder="e.g. MacBook Pro 14"
          submitLabel="Use name"
          onSubmit={async (v) => { setForm((f) => ({ ...f, name: v })); }}
          onClose={() => setAddingName(false)}
        />
      )}

      {/* ===== Assign to employee (with date) ===== */}
      {assignFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6">
            <h2 className="card-title mb-1">{assignFor._id ? `Assign “${assignFor.name}”` : 'Assign an asset'}</h2>
            <p className="text-xs text-gray-500 mb-4">Record which asset is issued to whom, and from when.</p>
            <form onSubmit={doAssign} className="space-y-3">
              {!assignFor._id && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Asset</label>
                  <select required value={assignAssetId} onChange={(e) => setAssignAssetId(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm">
                    <option value="">Select an asset…</option>
                    {assignableAssets.map((a) => (
                      <option key={a._id} value={a._id}>{a.name} · {a.assetTag}{a.assignedTo ? ` (with ${personName(a.assignedTo)})` : ''}</option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Employee</label>
                <select required value={assignUser} onChange={(e) => setAssignUser(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm">
                  <option value="">Select an employee…</option>
                  {users.map((u) => <option key={u._id} value={u._id}>{u.firstName} {u.lastName} ({u.role})</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Assigned date</label>
                <input type="date" required value={assignDate} onChange={(e) => setAssignDate(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Note (optional)</label>
                <input value={assignNote} onChange={(e) => setAssignNote(e.target.value)} placeholder="e.g. charger + bag included" className="block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setAssignFor(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={busy} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{busy ? 'Saving…' : 'Assign'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ===== Mark returned (with date) ===== */}
      {returnFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6">
            <h2 className="card-title mb-1">Return “{returnFor.asset?.name}”</h2>
            <p className="text-xs text-gray-500 mb-4">Returned by {personName(returnFor.employee)}.</p>
            <form onSubmit={doReturn} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Return date</label>
                <input type="date" required value={returnDate} onChange={(e) => setReturnDate(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setReturnFor(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={busy} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{busy ? 'Saving…' : 'Mark returned'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
