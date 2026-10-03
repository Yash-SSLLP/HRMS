/**
 * AdminOrgMasters — org master data (admin portal): designations and grades.
 * A kind toggle drives GET /org-masters?kind=… and CRUD via
 * POST/PUT/DELETE /org-masters. These feed the pickers used across employee forms.
 *
 * There was a third tab, Locations, until 2026-09-01. It was a second list of
 * work locations beside the real one — Work Locations, which carries each site's
 * geofence and is what an employee is actually assigned to — and the employee
 * form had long since stopped offering it, so it was a place to type names
 * nothing read. Sites are created under Work Locations only.
 *
 * 2026-10-03 redesign (user: "make it more premium"): one toolbar (kind tabs
 * with counts, status chips, search) and a rich row per entry (code chip,
 * status pill, icon actions). Styling: styles/pages/people-admin.css (.om-*).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { FiPlus, FiBriefcase, FiAward, FiSearch, FiX, FiEdit2, FiTrash2 } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import '../styles/pages/people-admin.css';

const KINDS = [
  { value: 'Designation', label: 'Designations' },
  { value: 'Grade', label: 'Grades' },
];

// Presentation only: each kind's icon and hue.
const KIND_LOOK = {
  Designation: { icon: FiBriefcase, hue: '#6366f1' },
  Grade: { icon: FiAward, hue: '#d97706' },
};

const blank = { name: '', code: '', description: '', isActive: true };

export default function AdminOrgMasters() {
  const [kind, setKind] = useState('Designation');
  const [masters, setMasters] = useState([]);
  // Only the FIRST load blanks the table. Every later fetch — switching between
  // Designations and Grades, or reloading after a save/delete — keeps the rows on
  // screen and just marks them stale: setting `loading` again swapped the whole
  // list for a three-line skeleton, collapsing the table and snapping it back a
  // moment later, so every tab switch and every delete threw the page around.
  // Same split AdminAnalytics/AdminConfirmations use.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  // View filters + tab badges (presentation only).
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('all'); // all | active | inactive
  const [counts, setCounts] = useState({}); // { [kind]: rows } once that kind has loaded

  const load = async () => {
    setRefreshing(true);
    setError('');
    try {
      const { data } = await api.get('/org-masters', { params: { kind } });
      setMasters(data.masters);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { load(); }, [kind]);

  // Remember each kind's size once it has loaded, for the tab badges.
  useEffect(() => {
    if (!loading) setCounts((c) => ({ ...c, [kind]: masters.length }));
  }, [masters]); // eslint-disable-line react-hooks/exhaustive-deps

  const openCreate = () => {
    setEditingId(null);
    setForm(blank);
    setShowModal(true);
  };

  const openEdit = (m) => {
    setEditingId(m._id);
    setForm({
      name: m.name || '',
      code: m.code || '',
      description: m.description || '',
      isActive: m.isActive,
    });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/org-masters/${editingId}`, form);
      } else {
        await api.post('/org-masters', { ...form, kind });
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (m) => {
    if (!(await confirmDialog({ message: `Delete ${kind.toLowerCase()} "${m.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/org-masters/${m._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  const activeLabel = KINDS.find((k) => k.value === kind)?.label || '';

  // ----- Presentation only: status chips + search -----
  const activeN = masters.filter((m) => m.isActive).length;
  const inactiveN = masters.length - activeN;
  const needle = q.trim().toLowerCase();
  const shown = masters
    .filter((m) => (status === 'all' ? true : status === 'active' ? m.isActive : !m.isActive))
    .filter((m) => !needle || `${m.name || ''} ${m.code || ''} ${m.description || ''}`.toLowerCase().includes(needle));

  return (
    <div>
      <PageHeader title="Org Masters" subtitle="Designations & grades">
        {refreshing && <span className="om-updating">Updating…</span>}
        <button type="button" onClick={openCreate} className="trn-btn is-primary accent-bg text-white">
          <FiPlus size={15} /> Add {kind.toLowerCase()}
        </button>
      </PageHeader>

      {/* Toolbar: kind, status, search */}
      <div className="pb-toolbar">
        <div className="trn-seg" role="tablist" aria-label="Master list">
          {KINDS.map((k) => {
            const Icon = KIND_LOOK[k.value].icon;
            return (
              <button key={k.value} type="button" role="tab" aria-selected={kind === k.value} onClick={() => setKind(k.value)}
                className={`trn-seg-btn${kind === k.value ? ' is-on' : ''}`}>
                <Icon size={14} /> {k.label} <span className="trn-seg-count">{counts[k.value] ?? '–'}</span>
              </button>
            );
          })}
        </div>
        <div className="prm-chips">
          {[
            ['all', 'All', masters.length],
            ['active', 'Active', activeN],
            ['inactive', 'Inactive', inactiveN],
          ].map(([key, label, n]) => (
            <button key={key} type="button" onClick={() => setStatus(key)} aria-pressed={status === key}
              className={`prm-chip${status === key ? ' is-on' : ''}`}>
              {label} <span className="prm-chip-count">{n}</span>
            </button>
          ))}
        </div>
        <div className="pb-toolbar-end">
          {!loading && <span className="om-count">{shown.length} of {masters.length}</span>}
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, code or description" aria-label={`Search ${activeLabel.toLowerCase()}`} />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="opacity-50 hover:opacity-100">
                <FiX size={14} />
              </button>
            )}
          </label>
        </div>
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {loading ? (
        <div className="prm-list">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="om-row">
              <span className="om-mark skeleton" style={{ '--hue': '#64748b' }} />
              <div className="om-main space-y-1.5">
                <div className="skeleton h-3.5 rounded w-40 max-w-full" />
                <div className="skeleton h-3 rounded max-w-full" style={{ width: `${70 - i * 9}%` }} />
              </div>
              <div className="om-side"><div className="skeleton h-5 rounded-full w-14" /></div>
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon">
              {(() => { const Icon = KIND_LOOK[kind].icon; return <Icon size={24} />; })()}
            </span>
            <p className="text-sm font-semibold">
              {masters.length === 0 ? `No ${activeLabel.toLowerCase()} yet` : 'No matches'}
            </p>
          </div>
        </div>
      ) : (
        <div className={`prm-list om-list${refreshing ? ' is-stale' : ''}`}>
          {shown.map((m) => {
            const look = KIND_LOOK[m.kind] || KIND_LOOK[kind];
            const Icon = look.icon;
            return (
              <div key={m._id} className="om-row" style={{ '--hue': look.hue }}>
                <span className="om-mark" aria-hidden="true"><Icon size={16} /></span>
                <div className="om-main">
                  <div className="om-name-line">
                    <span className="om-name" title={m.name}>{m.name}</span>
                    {m.code && <span className="rst-code">{m.code}</span>}
                  </div>
                  <div className={`om-desc${m.description ? '' : ' is-none'}`} title={m.description || undefined}>
                    {m.description || '-'}
                  </div>
                </div>
                <div className="om-side">
                  <span className={`rst-status${m.isActive ? ' is-on' : ''}`}>{m.isActive ? 'Active' : 'Inactive'}</span>
                  <div className="om-actions">
                    <button type="button" className="trn-icon-btn" onClick={() => openEdit(m)}
                      aria-label={`Edit ${m.name}`} title="Edit">
                      <FiEdit2 size={15} />
                    </button>
                    <button type="button" className="trn-icon-btn om-del" onClick={() => remove(m)}
                      aria-label={`Delete ${m.name}`} title="Delete">
                      <FiTrash2 size={15} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="card-title">
                {editingId ? `Edit ${kind}` : `Add ${kind}`}
              </h2>
              <button type="button" onClick={() => setShowModal(false)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={save} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <label className="block sm:col-span-2">
                  <span className="prm-label">Name *</span>
                  <input required value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    className="prm-input" />
                </label>
                <label className="block">
                  <span className="prm-label">Code</span>
                  <input value={form.code} placeholder="Auto from name"
                    title="Auto-generated from name if left blank"
                    onChange={(e) => setForm({ ...form, code: e.target.value })}
                    className="prm-input font-mono" />
                </label>
              </div>
              <label className="block">
                <span className="prm-label">Description</span>
                <textarea value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  className="prm-input" rows={3} />
              </label>
              <label className="flex items-center gap-2 text-sm font-semibold">
                <input type="checkbox" checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                Active
              </label>
              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="trn-btn">Cancel</button>
                <button type="submit" disabled={saving} className="trn-btn is-primary accent-bg text-white">
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
