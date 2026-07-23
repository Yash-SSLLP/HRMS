/**
 * AdminWorkLocations — named work sites + per-site check-in geofence (admin
 * portal). Lists locations from GET /work-locations and (HR/SuperAdmin) CRUDs
 * them via /work-locations, and assigns/unassigns employees to a site via
 * POST /work-locations/:id/assign|unassign (employees from GET /employees).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';

const blank = () => ({ name: '', lat: '', lng: '', radiusM: 200, active: true });
const mapLink = (lat, lng) => `https://www.google.com/maps?q=${lat},${lng}`;

export default function AdminWorkLocations() {
  const currentUser = useAuthStore((s) => s.user);
  const canManage = ['SuperAdmin', 'HRManager'].includes(currentUser?.role);

  const [locations, setLocations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(null); // form object or null
  const [assignFor, setAssignFor] = useState(null); // location
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/work-locations');
      setLocations(data.locations);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => setEditing(blank());
  const openEdit = (l) => setEditing({ _id: l._id, name: l.name, lat: l.lat ?? '', lng: l.lng ?? '', radiusM: l.radiusM ?? 200, active: l.active });

  // Fill lat/lng from the admin's current device GPS position.
  const useMyLocation = () => {
    if (!('geolocation' in navigator)) { setError('Location is not supported on this device.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => setEditing((f) => ({ ...f, lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6) })),
      () => setError('Could not read your current location.'),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = {
        name: editing.name,
        lat: editing.lat === '' ? null : Number(editing.lat),
        lng: editing.lng === '' ? null : Number(editing.lng),
        radiusM: Number(editing.radiusM) || 0,
        active: editing.active,
      };
      if (editing._id) await api.put(`/work-locations/${editing._id}`, payload);
      else await api.post('/work-locations', payload);
      setEditing(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (l) => {
    if (!(await confirmDialog({ message: `Delete work location "${l.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/work-locations/${l._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="Work Locations" subtitle="Named sites with their own check-in geofence">
        {canManage && (
          <button onClick={openCreate} className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ Add Location</button>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : locations.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-10 text-center text-gray-500">
          No work locations yet. Employees without one are measured against the default office.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {locations.map((l) => (
            <div key={l._id} className="bg-white shadow rounded-xl p-5 flex flex-col">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-gray-900 truncate">{l.name}</div>
                  <div className="text-xs text-gray-400 mt-0.5">Range: {l.radiusM} m</div>
                </div>
                <span className={`shrink-0 text-xs px-2 py-0.5 rounded-lg ${l.active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                  {l.active ? 'Active' : 'Inactive'}
                </span>
              </div>

              <div className="text-sm text-gray-600 mt-2">
                {l.lat != null && l.lng != null ? (
                  <a href={mapLink(l.lat, l.lng)} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline font-mono text-xs">
                    📍 {Number(l.lat).toFixed(5)}, {Number(l.lng).toFixed(5)}
                  </a>
                ) : (
                  <span className="text-amber-600 text-xs">No coordinates set - punches here won't be geofenced</span>
                )}
              </div>

              <button onClick={() => setAssignFor(l)} className="text-left text-sm text-indigo-600 hover:underline mt-3">
                👥 {l.assignedCount} employee{l.assignedCount === 1 ? '' : 's'} assigned
              </button>

              {canManage && (
                <div className="mt-4 pt-3 border-t border-gray-100 flex gap-3 text-sm">
                  <button onClick={() => openEdit(l)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => setAssignFor(l)} className="text-indigo-600 hover:underline">Assign</button>
                  <button onClick={() => remove(l)} className="text-red-600 hover:underline ml-auto">Delete</button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Create / edit */}
      {editing && (
        <Modal title={editing._id ? 'Edit Work Location' : 'Add Work Location'} onClose={() => setEditing(null)}>
          <form onSubmit={save} className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name *</label>
              <input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="e.g. Bangalore HQ" className="block w-full border rounded-lg px-3 py-2" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Latitude</label>
                <input type="number" step="any" value={editing.lat} onChange={(e) => setEditing({ ...editing, lat: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Longitude</label>
                <input type="number" step="any" value={editing.lng} onChange={(e) => setEditing({ ...editing, lng: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-2">
              <button type="button" onClick={useMyLocation} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">📍 Use my current location</button>
              {editing.lat !== '' && editing.lng !== '' && (
                <a href={mapLink(editing.lat, editing.lng)} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline">Preview on map</a>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Check-in range (metres)</label>
              <input type="number" min="0" value={editing.radiusM} onChange={(e) => setEditing({ ...editing, radiusM: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={editing.active} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} />
              Active
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditing(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}

      {assignFor && <AssignModal location={assignFor} locations={locations} onClose={() => setAssignFor(null)} onDone={() => { setAssignFor(null); load(); }} />}
    </div>
  );
}

// Assign / unassign employees to a location. A checked employee belongs to THIS
// location; unchecking moves them off it. Employees on another site show a hint.
// Modal to assign/unassign employees to a site by diffing checked vs currently-here.
function AssignModal({ location, locations, onClose, onDone }) {
  const [people, setPeople] = useState([]);
  const [checked, setChecked] = useState(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const locNameById = {};
  locations.forEach((l) => { locNameById[String(l._id)] = l.name; });

  useEffect(() => {
    api.get('/employees?excludeExecutives=true').then(({ data }) => {
      const rows = (data.profiles || []).filter((p) => p.user).map((p) => ({
        id: p._id, // profile id (workLocationRef lives on the profile)
        name: `${p.user.firstName || ''} ${p.user.lastName || ''}`.trim() || p.user.email,
        sub: p.designation || p.employeeCode || p.user.email,
        current: p.workLocationRef ? String(p.workLocationRef) : '',
      }));
      setPeople(rows);
      setChecked(new Set(rows.filter((r) => r.current === String(location._id)).map((r) => r.id)));
    }).catch((err) => setError(err.response?.data?.message || 'Failed to load employees'));
  }, [location._id]);

  const toggle = (id) => setChecked((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const filtered = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()) || (p.sub || '').toLowerCase().includes(q.toLowerCase()));

  const submit = async () => {
    const here = new Set(people.filter((p) => p.current === String(location._id)).map((p) => p.id));
    const toAssign = [...checked].filter((id) => !here.has(id));
    const toUnassign = [...here].filter((id) => !checked.has(id));
    if (!toAssign.length && !toUnassign.length) { onDone(); return; }
    setBusy(true); setError('');
    try {
      if (toAssign.length) await api.post(`/work-locations/${location._id}/assign`, { employeeIds: toAssign });
      if (toUnassign.length) await api.post(`/work-locations/${location._id}/unassign`, { employeeIds: toUnassign });
      onDone();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update assignments');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Employees at “${location.name}”`} onClose={onClose}>
      {error && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      <input placeholder="Search employees…" value={q} onChange={(e) => setQ(e.target.value)} className="block w-full border rounded-lg px-3 py-2 text-sm mb-2" />
      <div className="max-h-80 overflow-y-auto border rounded-lg divide-y">
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400 p-3">No employees.</p>
        ) : filtered.map((p) => {
          const elsewhere = p.current && p.current !== String(location._id);
          return (
            <label key={p.id} className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={checked.has(p.id)} onChange={() => toggle(p.id)} />
              <div className="min-w-0 flex-1">
                <div className="text-sm text-gray-900 truncate">{p.name}</div>
                <div className="text-xs text-gray-400 truncate">
                  {p.sub}{elsewhere && <span className="text-amber-600"> · now at {locNameById[p.current] || 'another site'}</span>}
                </div>
              </div>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between pt-4">
        <span className="text-xs text-gray-500">{checked.size} assigned here</span>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
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
