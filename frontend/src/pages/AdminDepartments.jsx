/**
 * AdminDepartments — department master (admin portal). Lists departments with
 * headcount from GET /departments and (HR/SuperAdmin) creates/renames via
 * POST/PUT /departments; only SuperAdmin can DELETE. Opening a department's
 * people lazily loads its members from GET /employees?department=.
 *
 * 2026-10-03 redesign (user: "make it more premium"): figures strip, one
 * toolbar (status + search), a card per department with its share of the
 * headcount, and the members in a side drawer. Styling: styles/pages/people-admin.css (.dep-*).
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiDownload, FiLayers, FiUsers, FiTrendingUp, FiUserMinus, FiEdit2, FiTrash2, FiSearch, FiX,
  FiChevronRight,
} from 'react-icons/fi';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { confirmDialog } from '../components/dialogs';
import { PersonAvatar } from '../components/permissions/permUi';
import { downloadTableXlsx } from '../api/download';
import { hasLeft } from '../utils/peopleOptions';
import '../styles/pages/people-admin.css';

const blank = { name: '', isActive: true };

// Presentation only: each department keeps one hue (from its id) everywhere it
// appears, and a two-letter mark from its name.
const HUES = ['#4f46e5', '#0d9488', '#d97706', '#db2777', '#2563eb', '#16a34a', '#9333ea', '#dc2626'];
const hueOf = (id) => {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) % 100003;
  return HUES[h % HUES.length];
};
const markOf = (name) => (name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const personName = (p) => `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() || p.user?.email || p.employeeCode || 'Employee';

export default function AdminDepartments() {
  const currentUser = useAuthStore((s) => s.user);
  const isSuperAdmin = currentUser?.role === 'SuperAdmin';
  // HR + SuperAdmin can add/rename; only SuperAdmin can delete.
  const canManage = isSuperAdmin || currentUser?.role === 'HRManager';
  const canDelete = isSuperAdmin;

  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(null); // department _id whose members are shown
  const [members, setMembers] = useState({}); // { [deptName]: profile[] }
  const [memLoading, setMemLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  // View filters (presentation only).
  const [view, setView] = useState('all'); // all | active | inactive
  const [q, setQ] = useState('');
  const [memberQ, setMemberQ] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/departments');
      setDepartments(data.departments);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // Show / hide the employees in a department (lazily fetched from /employees).
  const toggleMembers = async (d) => {
    if (expanded === d._id) { setExpanded(null); return; }
    setExpanded(d._id);
    if (members[d.name] === undefined) {
      setMemLoading(true);
      try {
        const { data } = await api.get('/employees', { params: { department: d.name } });
        // The people still here — the same set the headcount badge counts. A
        // leaver is on the Employees page's Exited tab and nowhere else.
        setMembers((m) => ({ ...m, [d.name]: (data.profiles || []).filter((p) => !hasLeft(p)) }));
      } catch {
        setMembers((m) => ({ ...m, [d.name]: [] }));
      } finally {
        setMemLoading(false);
      }
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(blank);
    setShowModal(true);
  };

  const openEdit = (d) => {
    setEditingId(d._id);
    setForm({ name: d.name, isActive: d.isActive });
    setShowModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (editingId) {
        await api.put(`/departments/${editingId}`, form);
      } else {
        await api.post('/departments', form);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (d) => {
    if (!(await confirmDialog({ message: `Delete department "${d.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/departments/${d._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  // Export every employee with their department, as an .xlsx.
  //
  // The page loads members lazily (only for the row you expand), so this pulls
  // the full list in one go rather than exporting whatever happens to be open.
  // Employees with no department are included under "(No department)" — leaving
  // them out would make the export silently disagree with the headcount. People
  // who have left are not, for the same reason: the headcount does not count
  // them (the employee master export on the Employees page is the record).
  const exportEmployees = async () => {
    setExporting(true);
    try {
      const { data } = await api.get('/employees');
      const rows = (data.profiles || [])
        .filter((p) => !hasLeft(p))
        .map((p) => {
          const name = `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim()
            || p.user?.email || p.employeeCode || 'Employee';
          return {
            name,
            department: p.department || '(No department)',
            designation: p.designation || '-',
            status: p.user?.isActive === false ? 'Inactive' : 'Active',
            code: p.employeeCode || '-',
            email: p.user?.email || '-',
          };
        })
        // Grouped by department, then alphabetical — reads like the page does.
        .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name))
        .map((r) => [r.name, r.department, r.designation, r.status, r.code, r.email]);

      if (!rows.length) {
        toast.error('No employees to export');
        return;
      }
      await downloadTableXlsx({
        filename: `employees-by-department-${new Date().toISOString().slice(0, 10)}`,
        sheetName: 'Employees',
        headers: ['Employee Name', 'Department', 'Designation', 'Status', 'Employee Code', 'Email'],
        rows,
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not export');
    } finally {
      setExporting(false);
    }
  };

  // ----- Presentation only: figures, filters, the open drawer -----
  const activeCount = departments.filter((d) => d.isActive).length;
  const inactiveCount = departments.length - activeCount;
  const headcount = departments.reduce((sum, d) => sum + (d.employeeCount || 0), 0);
  const largest = departments.reduce(
    (best, d) => ((d.employeeCount || 0) > (best?.employeeCount || 0) ? d : best), null,
  );
  const emptyCount = departments.filter((d) => !d.employeeCount).length;
  const avg = departments.length ? Math.round(headcount / departments.length) : 0;
  const KPIS = [
    { key: 'depts', label: 'Departments', value: departments.length, icon: FiLayers, hue: '#6366f1', sub: `${activeCount} active` },
    { key: 'people', label: 'Employees', value: headcount, icon: FiUsers, hue: '#16a34a', sub: `~${avg} per department` },
    { key: 'largest', label: 'Largest', value: largest?.employeeCount || 0, icon: FiTrendingUp, hue: '#8b5cf6', sub: largest?.name || '—' },
    { key: 'empty', label: 'Empty', value: emptyCount, icon: FiUserMinus, hue: '#d97706', sub: emptyCount ? 'No employees' : 'All staffed' },
  ];

  const needle = q.trim().toLowerCase();
  const shownDepts = departments
    .filter((d) => (view === 'all' ? true : view === 'active' ? d.isActive : !d.isActive))
    .filter((d) => !needle || (d.name || '').toLowerCase().includes(needle));

  const openDept = departments.find((d) => d._id === expanded) || null;
  const openMembers = openDept ? members[openDept.name] : undefined;
  const memberNeedle = memberQ.trim().toLowerCase();
  const membersShown = (openMembers || []).filter(
    (p) => !memberNeedle || `${personName(p)} ${p.designation || ''}`.toLowerCase().includes(memberNeedle),
  );
  const openCount = openMembers ? openMembers.length : (openDept?.employeeCount || 0);
  // A fresh drawer starts with an empty search.
  const showMembers = (d) => { setMemberQ(''); toggleMembers(d); };

  return (
    <div>
      <PageHeader title="Departments" subtitle={!canManage ? 'View only' : undefined}>
        <button type="button" onClick={exportEmployees} disabled={exporting}
          title="Download every employee with their department, designation and status"
          className="trn-btn">
          <FiDownload size={14} /> {exporting ? 'Preparing…' : 'Export'}
        </button>
        {canManage && (
          <button type="button" onClick={openCreate} className="trn-btn is-primary accent-bg text-white">
            <FiPlus size={15} /> Add Department
          </button>
        )}
      </PageHeader>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      {/* Figures */}
      <div className="trn-kpis dep-kpis">
        {KPIS.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.key} className="trn-kpi" style={{ '--kpi-hue': k.hue }}>
              <span className="trn-kpi-icon" aria-hidden="true"><Icon size={19} /></span>
              <span className="min-w-0">
                <span className="trn-kpi-value block">{loading ? '—' : k.value}</span>
                <span className="trn-kpi-label block">{k.label}</span>
                <span className="trn-kpi-sub block">{loading ? '' : k.sub}</span>
              </span>
            </div>
          );
        })}
      </div>

      {/* Toolbar: status, search */}
      <div className="pb-toolbar">
        <div className="trn-seg" role="tablist" aria-label="Status">
          {[
            ['all', 'All', departments.length],
            ['active', 'Active', activeCount],
            ['inactive', 'Inactive', inactiveCount],
          ].map(([key, label, count]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)}
              className={`trn-seg-btn${view === key ? ' is-on' : ''}`}>
              {label} <span className="trn-seg-count">{count}</span>
            </button>
          ))}
        </div>
        <div className="pb-toolbar-end">
          {!loading && <span className="dep-count">{shownDepts.length} of {departments.length}</span>}
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search departments" aria-label="Search departments" />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="opacity-50 hover:opacity-100">
                <FiX size={14} />
              </button>
            )}
          </label>
        </div>
      </div>

      {loading ? (
        <div className="rst-grid">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-44 rounded-2xl" />)}
        </div>
      ) : shownDepts.length === 0 ? (
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiLayers size={24} /></span>
            <p className="text-sm font-semibold">{departments.length ? 'No departments match' : 'No departments yet'}</p>
          </div>
        </div>
      ) : (
        <div className="rst-grid">
          {shownDepts.map((d) => {
            const n = d.employeeCount || 0;
            const pct = headcount ? Math.round((n / headcount) * 100) : 0;
            const loaded = members[d.name];
            return (
              <article key={d._id} className={`rst-card dep-card${d.isActive ? '' : ' is-off'}`} style={{ '--hue': hueOf(d._id) }}>
                <div className="rst-card-head">
                  <div className="dep-head-main">
                    <span className="dep-mark" aria-hidden="true">{markOf(d.name)}</span>
                    <div className="min-w-0">
                      <div className="rst-card-name" title={d.name}>{d.name}</div>
                      <div className="rst-card-tags">
                        <span className={`rst-status${d.isActive ? ' is-on' : ''}`}>{d.isActive ? 'Active' : 'Inactive'}</span>
                      </div>
                    </div>
                  </div>
                  {canManage && (
                    <div className="dep-tools">
                      <button type="button" className="trn-icon-btn" onClick={() => openEdit(d)}
                        aria-label={`Rename ${d.name}`} title="Rename">
                        <FiEdit2 size={15} />
                      </button>
                      {canDelete && (
                        <button type="button" className="trn-icon-btn dep-del" onClick={() => remove(d)}
                          aria-label={`Delete ${d.name}`} title="Delete">
                          <FiTrash2 size={15} />
                        </button>
                      )}
                    </div>
                  )}
                </div>

                <div className="dep-figure">
                  <span className="dep-figure-n">{n}</span>
                  <span className="dep-figure-l">{n === 1 ? 'employee' : 'employees'}</span>
                  <span className="dep-figure-pct" title="Share of employees in departments">{pct}%</span>
                </div>
                <div className="dep-bar" aria-hidden="true">
                  <span className="dep-bar-fill" style={{ width: `${pct}%` }} />
                </div>

                <div className="rst-card-foot">
                  <button type="button" className="rst-people" onClick={() => showMembers(d)} disabled={!d.employeeCount}>
                    <FiUsers size={14} /> {n > 0 ? 'View people' : 'No employees'}
                    {n > 0 && <FiChevronRight size={14} />}
                  </button>
                  {loaded && loaded.length > 0 && (
                    <span className="dep-stack" aria-hidden="true">
                      {loaded.slice(0, 4).map((p) => <PersonAvatar key={p._id} user={p.user} size="sm" />)}
                      {loaded.length > 4 && <span className="dep-stack-more">+{loaded.length - 4}</span>}
                    </span>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* ===== People in a department (drawer) ===== */}
      {openDept && (
        <div className="fixed inset-0 trn-drawer-wrap" onClick={() => toggleMembers(openDept)}>
          <div className="trn-drawer" role="dialog" aria-modal="true" aria-label={`People in ${openDept.name}`}
            onClick={(e) => e.stopPropagation()}>
            <div className="trn-drawer-head dep-drawer-head" style={{ '--hue': hueOf(openDept._id) }}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="dep-mark dep-drawer-mark" aria-hidden="true">{markOf(openDept.name)}</span>
                  <div className="min-w-0">
                    <div className="text-lg font-bold truncate">{openDept.name}</div>
                    <div className="text-xs opacity-70 mt-0.5">
                      {openCount} {openCount === 1 ? 'employee' : 'employees'}
                    </div>
                  </div>
                </div>
                <button type="button" className="trn-icon-btn" onClick={() => toggleMembers(openDept)} aria-label="Close">
                  <FiX size={17} />
                </button>
              </div>
              {(openMembers?.length || 0) > 6 && (
                <label className="trn-search mt-3">
                  <FiSearch size={15} className="opacity-50 shrink-0" />
                  <input value={memberQ} onChange={(e) => setMemberQ(e.target.value)}
                    placeholder="Search name or designation" aria-label="Search people" />
                </label>
              )}
            </div>
            <div className="trn-drawer-body">
              {openMembers === undefined ? (
                memLoading ? (
                  <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
                ) : null
              ) : openMembers.length === 0 ? (
                <div className="trn-empty">
                  <span className="trn-empty-icon"><FiUsers size={24} /></span>
                  <p className="text-sm font-semibold">No employees in this department.</p>
                </div>
              ) : membersShown.length === 0 ? (
                <div className="trn-empty">
                  <span className="trn-empty-icon"><FiUsers size={24} /></span>
                  <p className="text-sm font-semibold">No one matches</p>
                </div>
              ) : (
                <div className="prm-list">
                  {membersShown.map((p) => (
                    <div key={p._id} className="rst-entry">
                      <PersonAvatar user={p.user} size="sm" />
                      <div className="min-w-0 flex-1">
                        <div className="rst-entry-name">{personName(p)}</div>
                        {p.designation && <div className="rst-entry-note">{p.designation}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-sm p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="card-title">{editingId ? 'Edit Department' : 'Add Department'}</h2>
              <button type="button" onClick={() => setShowModal(false)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={save} className="space-y-3.5">
              <label className="block">
                <span className="prm-label">Name *</span>
                <input required value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="prm-input" />
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
