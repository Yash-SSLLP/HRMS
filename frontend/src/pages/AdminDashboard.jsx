/**
 * AdminDashboard — user account management (admin portal, "User Accounts" page).
 * Lists login accounts from GET /admin/users and creates/edits them via
 * POST/PUT /admin/users, activates/deactivates and deletes (SuperAdmin only).
 * A SuperAdmin may also change any account's email here (confirmed first; the
 * server refuses an address a live account holds and mails the new one).
 * SuperAdmin can also edit each HR Manager's granular admin permissions via a
 * modal backed by GET /admin/permissions/catalog + PATCH /admin/users/:id/permissions.
 */
import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiPlus, FiUsers, FiUserCheck, FiUserX, FiShield, FiSearch, FiX, FiEdit2, FiSliders, FiTrash2, FiLock,
  FiEye, FiEyeOff,
} from 'react-icons/fi';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { PersonAvatar, RoleChip } from '../components/permissions/permUi';
import { useTabParam } from '../hooks/useTabParam';
import { hasLeft } from '../utils/peopleOptions';
import { ROLES, roleLabel } from '../config/roles';
import { toYMD } from '../utils/time';
import { confirmDialog } from '../components/dialogs';
import '../styles/pages/people-admin.css';

const blankForm = {
  email: '',
  password: '',
  firstName: '',
  lastName: '',
  phone: '',
  role: 'Employee',
  isActive: true,
  // CEO/MD only — see the "Celebrations" block in the form. Sent for every
  // role, but the server stores them only for an executive account, whose
  // dates have nowhere else to live (they have no employee profile).
  dateOfBirth: '',
  dateOfJoining: '',
  dateOfMarriage: '',
};

// Roles with no employee profile of their own, and therefore the only ones
// whose celebration dates are kept on the login account.
const EXEC_ROLES = ['CEO', 'MD'];

/** ISO date (or blank) → the yyyy-mm-dd an <input type="date"> wants. */
const dateInput = (v) => (v ? String(v).slice(0, 10) : '');

// Roles counted by the "Admin roles" figure (presentation only).
const ADMIN_ROLES = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager'];
// Role chips follow the order of ROLES; anything unknown sorts last.
const roleRank = (r) => { const i = ROLES.indexOf(r); return i < 0 ? ROLES.length : i; };

// Whether the current viewer is allowed to manage a given user row.
// SuperAdmin manages everyone; HR Managers can only manage Employee accounts.
function canManage(viewerRole, targetRole) {
  if (viewerRole === 'SuperAdmin') return true;
  return targetRole === 'Employee';
}

export default function AdminDashboard() {
  const me = useAuthStore((s) => s.user);
  const myId = String(me?._id || me?.id || '');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankForm);
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  // The address the account had when the form opened, so a changed one can be
  // confirmed before it is saved.
  const [emailAtOpen, setEmailAtOpen] = useState('');

  const isSuperAdmin = me?.role === 'SuperAdmin';

  // ----- Granular HR permissions (SuperAdmin only) -----
  const [catalog, setCatalog] = useState([]);
  const [permUser, setPermUser] = useState(null);
  const [permSel, setPermSel] = useState(() => new Set());
  const [permSaving, setPermSaving] = useState(false);
  const allKeys = catalog.map((p) => p.key);

  useEffect(() => {
    if (!isSuperAdmin) return;
    api.get('/admin/permissions/catalog').then(({ data }) => setCatalog(data.permissions || [])).catch(() => {});
  }, [isSuperAdmin]);

  const openPerms = (u) => {
    // A missing/undefined permissions array means ALL capabilities are granted.
    // Only the keys this dialog offers: a stored list can still carry a retired
    // key, which used to be counted ("37 of 36") and sent back to be refused —
    // see openPerms on the Permissions page.
    setPermSel(u.permissions == null
      ? new Set(allKeys)
      : new Set(u.permissions.filter((k) => allKeys.includes(k))));
    setPermUser(u);
  };
  const togglePerm = (key) => setPermSel((s) => {
    const n = new Set(s);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });
  const savePerms = async () => {
    setPermSaving(true); setError('');
    try {
      const id = permUser._id || permUser.id;
      const { data } = await api.patch(`/admin/users/${id}/permissions`, { permissions: [...permSel] });
      // Patch the row from the response rather than reloading the page behind
      // the modal that is closing.
      setUsers((rows) => rows.map((r) => (String(r._id || r.id) === String(id)
        ? { ...r, permissions: data?.user?.permissions ?? [...permSel] } : r)));
      setPermUser(null);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save permissions');
    } finally {
      setPermSaving(false);
    }
  };

  // Group the flat catalog for display.
  const permGroups = catalog.reduce((acc, p) => {
    (acc[p.group] = acc[p.group] || []).push(p);
    return acc;
  }, {});

  // CEO/MD are executives, not managed as regular accounts here — hidden from the
  // Users list for HR. A SuperAdmin DOES administer those accounts (role, edit
  // mode, deactivation), so they see them like any other. (They stay in the API
  // for everyone, so they can still be picked as an interviewer or as someone's
  // reporting manager.)
  const [q, setQ] = useState('');
  // Role chip in the toolbar ('' = every role). A view filter only.
  const [roleFilter, setRoleFilter] = useState('');

  /**
   * WORKING vs EXITED (user decision, 2026-09-22).
   *
   * `/admin/users` stamps `departed` on every row — a deactivated login OR a
   * last working day that has already passed — because a User account carries
   * no exit date of its own and `isActive` alone still calls somebody a
   * colleague the day after they walked out. `hasLeft` reads that stamp, so
   * this page, the Employees page and every picker split on one rule.
   */
  const [tab, setTab] = useTabParam('working', ['working', 'exited']);

  const inScope = isSuperAdmin ? users : users.filter((u) => !['CEO', 'MD'].includes(u.role));
  const exitedCount = inScope.filter(hasLeft).length;

  const visibleUsers = inScope
    .filter((u) => hasLeft(u) === (tab === 'exited'))
    .filter((u) => {
      const needle = q.trim().toLowerCase();
      if (!needle) return true;
      return `${u.firstName} ${u.lastName} ${u.email} ${roleLabel(u.role)}`.toLowerCase().includes(needle);
    });

  // ----- Presentation only (2026-10-03 redesign): figures + role chips -----
  const tabUsers = inScope.filter((u) => hasLeft(u) === (tab === 'exited'));
  const roleCounts = Object.entries(tabUsers.reduce((acc, u) => {
    acc[u.role] = (acc[u.role] || 0) + 1;
    return acc;
  }, {})).sort(([a], [b]) => roleRank(a) - roleRank(b));
  // A chip picked on one tab is ignored on a tab where that role has nobody.
  const activeRole = roleCounts.some(([r]) => r === roleFilter) ? roleFilter : '';
  const shownUsers = activeRole ? visibleUsers.filter((u) => u.role === activeRole) : visibleUsers;
  const workingCount = inScope.length - exitedCount;
  const workingUsers = inScope.filter((u) => !hasLeft(u));
  const adminCount = workingUsers.filter((u) => ADMIN_ROLES.includes(u.role)).length;
  const deactivatedCount = inScope.filter((u) => u.isActive === false).length;
  const roleKinds = new Set(inScope.map((u) => u.role)).size;
  const pctOf = (n) => (inScope.length ? Math.round((n / inScope.length) * 100) : 0);
  const KPIS = [
    { key: 'all', label: 'Accounts', value: inScope.length, icon: FiUsers, hue: '#64748b',
      sub: `${roleKinds} ${roleKinds === 1 ? 'role' : 'roles'}` },
    { key: 'working', label: 'Working', value: workingCount, icon: FiUserCheck, hue: '#16a34a',
      sub: `${pctOf(workingCount)}% of accounts` },
    { key: 'admin', label: 'Admin roles', value: adminCount, icon: FiShield, hue: '#8b5cf6',
      sub: `${workingUsers.filter((u) => u.role === 'Employee').length} employees`,
      title: 'Working Super Admin, HR, CEO/MD and manager accounts' },
    { key: 'exited', label: 'Exited', value: exitedCount, icon: FiUserX, hue: '#dc2626',
      sub: `${deactivatedCount} deactivated` },
  ];

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await api.get('/admin/users', { params: { includeExternal: true } });
      setUsers(data.users);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm(blankForm);
    setShowPassword(false);
    setShowConfirm(false);
    setConfirmPassword('');
    setShowModal(true);
  };

  const openEdit = (u) => {
    setEditingId(u._id || u.id);
    setShowPassword(false);
    setShowConfirm(false);
    setConfirmPassword('');
    setEmailAtOpen(u.email || '');
    setForm({
      email: u.email,
      password: '',
      firstName: u.firstName,
      lastName: u.lastName,
      phone: u.phone || '',
      role: u.role,
      isActive: u.isActive,
      dateOfBirth: dateInput(u.dateOfBirth),
      dateOfJoining: dateInput(u.dateOfJoining),
      dateOfMarriage: dateInput(u.dateOfMarriage),
    });
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingId(null);
    setForm(blankForm);
    setShowConfirm(false);
    setConfirmPassword('');
  };

  const onSave = async (e) => {
    e.preventDefault();
    setError('');
    // Validate confirm-password whenever a password is being set
    // (always on create; on edit only if a new password was typed).
    if ((form.password || !editingId) && form.password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    // A Super Admin may change anybody's email (the server checks no other live
    // account holds it, and mails the new address). It is also a way they sign
    // in, so the change is confirmed before a request goes out — the same step
    // the Employees page asks for.
    const nextEmail = form.email.trim().toLowerCase();
    const emailChanged = !!editingId && isSuperAdmin && nextEmail !== emailAtOpen.trim().toLowerCase();
    if (emailChanged) {
      const ok = await confirmDialog({
        title: 'Change sign-in email?',
        message: `${form.firstName} ${form.lastName}'s email is ${emailAtOpen || '(none)'}.\n\n`
          + `After saving it will be ${nextEmail}, and the old address will no longer sign them in. `
          + 'A notice is sent to the new address.',
        confirmText: 'Change email',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const payload = { ...form };
        if (!payload.password) delete payload.password;
        // Only a Super Admin changes an email here, and only a changed one is
        // sent — an unchanged address is no edit at all.
        if (!emailChanged) delete payload.email;
        else payload.email = nextEmail;
        await api.put(`/admin/users/${editingId}`, payload);
      } else {
        await api.post('/admin/users', form);
      }
      closeModal();
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  /** Merge fields into ONE row, leaving the rest of the table alone. */
  const patchRow = (id, patch) => setUsers(
    (rows) => rows.map((r) => (String(r._id || r.id) === String(id) ? { ...r, ...patch } : r))
  );

  const onToggleActive = async (u) => {
    const id = u._id || u.id;
    // Optimistic, like the Permissions page next door: reloading the whole list
    // to learn one boolean is the behaviour that made a single switch feel like
    // a page refresh.
    patchRow(id, { isActive: !u.isActive });
    try {
      await api.patch(`/admin/users/${id}/${u.isActive ? 'deactivate' : 'activate'}`);
    } catch (err) {
      patchRow(id, { isActive: u.isActive }); // put it back
      toast.error(err.response?.data?.message || 'Action failed');
    }
  };

  const onDelete = async (u) => {
    const id = u._id || u.id;
    // Same cascade as the employee-delete screen — see services/purgePerson.js.
    if (!(await confirmDialog({
      message: `Permanently delete ${u.email}?

This removes their login and every record they own — attendance, leave, documents, notifications and chat. Payroll records and the audit log are kept.

This cannot be undone.`,
      tone: 'danger',
      confirmText: 'Delete everything',
    }))) return;
    try {
      await api.delete(`/admin/users/${id}`);
      // Drop the row; refetching the whole list to notice it is gone is the
      // slowest possible way to remove one line from a table.
      setUsers((rows) => rows.filter((r) => String(r._id || r.id) !== String(id)));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  return (
    <div>
      <PageHeader title="User Accounts" subtitle={`${users.length} user(s)`}>
        <button type="button" onClick={openCreate} className="trn-btn is-primary accent-bg text-white">
          <FiPlus size={15} /> Add User
        </button>
      </PageHeader>

      {/* ── Figures ─────────────────────────────────────────── */}
      <div className="trn-kpis usr-kpis">
        {KPIS.map((k) => {
          const Icon = k.icon;
          return (
            <div key={k.key} className="trn-kpi" style={{ '--kpi-hue': k.hue }} title={k.title}>
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

      {/* ── Toolbar: Working · Exited, search, role chips ───── */}
      <div className="pb-toolbar">
        <div className="trn-seg" role="tablist" aria-label="Accounts">
          {[
            ['working', 'Working', workingCount, FiUserCheck],
            ['exited', 'Exited', exitedCount, FiUserX],
          ].map(([key, label, count, Icon]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`trn-seg-btn${tab === key ? ' is-on' : ''}`}
            >
              <Icon size={14} /> {label} <span className="trn-seg-count">{count}</span>
            </button>
          ))}
        </div>
        <div className="pb-toolbar-end">
          {!loading && <span className="usr-count">{shownUsers.length} of {tabUsers.length}</span>}
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, email or role…" aria-label="Search accounts" />
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="Clear search" className="opacity-50 hover:opacity-100">
                <FiX size={14} />
              </button>
            )}
          </label>
        </div>
        {roleCounts.length > 1 && (
          <div className="prm-chips usr-chips">
            <button type="button" onClick={() => setRoleFilter('')} className={`prm-chip${!activeRole ? ' is-on' : ''}`}>
              All <span className="prm-chip-count">{tabUsers.length}</span>
            </button>
            {roleCounts.map(([role, n]) => (
              <button key={role} type="button" onClick={() => setRoleFilter(activeRole === role ? '' : role)}
                className={`prm-chip${activeRole === role ? ' is-on' : ''}`}>
                {roleLabel(role)} <span className="prm-chip-count">{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          {error}
        </div>
      )}

      {/* ── Accounts ────────────────────────────────────────── */}
      {loading ? (
        <div className="prm-list usr-list">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="usr-row">
              <div className="prm-who usr-who">
                <span className="prm-avatar skeleton" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="skeleton h-3.5 rounded w-36 max-w-full" />
                  <div className="skeleton h-3 rounded w-48 max-w-full" />
                </div>
              </div>
              <div className="usr-role"><div className="skeleton h-5 rounded-md w-20" /></div>
              <div className="usr-status"><div className="skeleton h-5 rounded-full w-14" /></div>
              <div className="usr-actions"><div className="skeleton h-8 rounded-lg w-28" /></div>
            </div>
          ))}
        </div>
      ) : shownUsers.length === 0 ? (
        <div className="prm-list">
          <div className="trn-empty">
            <span className="trn-empty-icon"><FiUsers size={24} /></span>
            <p className="text-sm font-semibold">No users</p>
          </div>
        </div>
      ) : (
        <div className="prm-list usr-list">
          <div className="usr-head" aria-hidden="true">
            <span>Account</span><span>Role</span><span>Status</span><span>Actions</span>
          </div>
          {shownUsers.map((u) => {
            const isMe = String(u._id || u.id) === myId;
            const name = `${u.firstName} ${u.lastName}`;
            return (
              <div key={u._id || u.id} className={`usr-row${hasLeft(u) ? ' is-gone' : ''}`}>
                <div className="prm-who usr-who">
                  <PersonAvatar user={u} />
                  <div className="prm-who-text">
                    <div className="usr-name">
                      <span className="prm-who-name">{u.firstName} {u.lastName}</span>
                      {isMe && <span className="usr-you">You</span>}
                    </div>
                    <div className="prm-who-mail">{u.email}</div>
                  </div>
                </div>
                <div className="usr-role"><RoleChip role={u.role} /></div>
                <div className="usr-status">
                  {/* Nobody may see their own active status — hide it on your own row. */}
                  {isMe ? (
                    <span className="usr-dash">-</span>
                  ) : (
                    <span className={`rst-status${u.isActive ? ' is-on' : ''}`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  )}
                </div>
                <div className="usr-actions">
                  {canManage(me?.role, u.role) ? (
                    <>
                      {/* Only SuperAdmin may change an account's active status (never their own). */}
                      {isSuperAdmin && !isMe && (
                        <button type="button" onClick={() => onToggleActive(u)}
                          className={`trn-btn usr-toggle ${u.isActive ? 'is-off' : 'is-on'}`}>
                          {u.isActive ? <FiUserX size={13} /> : <FiUserCheck size={13} />}
                          {u.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                      )}
                      <button type="button" onClick={() => openEdit(u)} className="trn-icon-btn"
                        aria-label={`Edit ${name}`} title="Edit">
                        <FiEdit2 size={15} />
                      </button>
                      {/* SuperAdmin controls each HR Manager's granular admin access. */}
                      {isSuperAdmin && u.role === 'HRManager' && (
                        <button type="button" onClick={() => openPerms(u)} className="trn-icon-btn"
                          aria-label={`Permissions for ${name}`} title="Permissions">
                          <FiSliders size={15} />
                        </button>
                      )}
                    </>
                  ) : (
                    <span className="usr-restricted"><FiLock size={12} /> Restricted</span>
                  )}
                  {isSuperAdmin && (
                    <button type="button" onClick={() => onDelete(u)} className="trn-icon-btn usr-del"
                      aria-label={`Delete ${name}`} title="Delete">
                      <FiTrash2 size={15} />
                    </button>
                  )}
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
                {editingId ? 'Edit User' : 'Add User'}
              </h2>
              <button type="button" onClick={closeModal} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>
            <form onSubmit={onSave} className="space-y-3.5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="prm-label">
                    {form.role === 'HRConsultancy' ? 'Consultancy name' : 'First name'}
                  </label>
                  <input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                    className="prm-input" />
                  {/* An HR consultancy has no employee code: it signs in with
                      this name (utils/loginIdentity on the server), so say so
                      while it is being typed. */}
                  {form.role === 'HRConsultancy' && (
                    <p className="usr-field-note">
                      {form.firstName.trim()
                        ? <>They sign in with <span className="font-mono font-semibold">{form.firstName.trim().toLowerCase()}</span> (any case).</>
                        : 'They sign in with this name, in any case.'}
                    </p>
                  )}
                </div>
                <div>
                  <label className="prm-label">Last name</label>
                  <input required value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                    className="prm-input" />
                </div>
              </div>

              <div>
                <label className="prm-label">Email</label>
                {/* On an existing account only a Super Admin may change it —
                    for any user, their own included. */}
                <input type="email" required disabled={!!editingId && !isSuperAdmin} value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  title={editingId && !isSuperAdmin ? 'Only a Super Admin can change an email.' : undefined}
                  className="prm-input disabled:opacity-60" />
                {editingId && isSuperAdmin && (
                  <p className="usr-field-note is-warn">Changes their sign-in address.</p>
                )}
              </div>

              <div>
                <label className="prm-label">
                  {editingId ? 'New password (leave blank to keep)' : 'Password'}
                </label>
                <div className="usr-pw">
                  <input type={showPassword ? 'text' : 'password'} required={!editingId} minLength={editingId ? 0 : 8}
                    value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="prm-input" />
                  <button type="button" onClick={() => setShowPassword((s) => !s)}
                    className="usr-pw-eye"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}>
                    {showPassword ? <FiEyeOff size={18} aria-hidden="true" /> : <FiEye size={18} aria-hidden="true" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="prm-label">
                  {editingId ? 'Confirm new password' : 'Confirm password'}
                </label>
                <div className="usr-pw">
                  <input type={showConfirm ? 'text' : 'password'} required={!editingId} minLength={editingId ? 0 : 8}
                    value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                    className="prm-input" />
                  <button type="button" onClick={() => setShowConfirm((s) => !s)}
                    className="usr-pw-eye"
                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                    title={showConfirm ? 'Hide password' : 'Show password'}>
                    {showConfirm ? <FiEyeOff size={18} aria-hidden="true" /> : <FiEye size={18} aria-hidden="true" />}
                  </button>
                </div>
                {confirmPassword && form.password !== confirmPassword && (
                  <p className="text-xs text-red-600 mt-1">Passwords do not match</p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="prm-label">Role</label>
                  <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}
                    title={!isSuperAdmin ? 'HR Managers can only create Employee accounts.' : undefined}
                    className="prm-input">
                    {/* Only show roles the viewer can actually create. Non-admins
                        (HR) can only create Employees — and never see other roles. */}
                    {(isSuperAdmin ? ROLES : ['Employee']).map((r) => (
                      <option key={r} value={r}>{roleLabel(r)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="prm-label">Phone</label>
                  <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    placeholder="+91XXXXXXXXXX" className="prm-input" />
                </div>
              </div>

              {/* Celebrations — executives only.
                  A CEO/MD deliberately has no employee profile, which is where
                  everyone else's birthday lives, so theirs never reached the
                  calendar or the celebrations widget. These three fields are
                  the only place they can be recorded; leave one blank and that
                  occasion simply never shows. */}
              {EXEC_ROLES.includes(form.role) && (
                <div className="usr-sub">
                  <p className="usr-sub-title">Celebrations (optional)</p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="prm-label">Date of birth</label>
                      <input type="date" value={form.dateOfBirth} max={toYMD(new Date())}
                        onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
                        className="prm-input" />
                    </div>
                    <div>
                      <label className="prm-label">Date of joining</label>
                      <input type="date" value={form.dateOfJoining}
                        onChange={(e) => setForm({ ...form, dateOfJoining: e.target.value })}
                        className="prm-input" />
                    </div>
                    <div>
                      <label className="prm-label">Wedding anniversary</label>
                      <input type="date" value={form.dateOfMarriage}
                        onChange={(e) => setForm({ ...form, dateOfMarriage: e.target.value })}
                        className="prm-input" />
                    </div>
                  </div>
                </div>
              )}

              <label className="usr-check">
                <input type="checkbox" checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
                Active
              </label>

              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={closeModal} className="trn-btn">Cancel</button>
                <button type="submit" disabled={saving} className="trn-btn is-primary accent-bg text-white">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {permUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-2xl shadow-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-gray-100">
              <div className="flex items-center gap-3 min-w-0">
                <PersonAvatar user={permUser} />
                <div className="min-w-0">
                  <h2 className="card-title">Admin permissions</h2>
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {permUser.firstName} {permUser.lastName}
                  </p>
                </div>
              </div>
              <button type="button" onClick={() => setPermUser(null)} aria-label="Close" className="trn-icon-btn"><FiX size={16} /></button>
            </div>

            <div className="px-6 py-4 overflow-y-auto">
              <div className="flex flex-wrap items-center gap-2 mb-4">
                <button type="button" onClick={() => setPermSel(new Set(allKeys))} className="trn-btn">Select all</button>
                <button type="button" onClick={() => setPermSel(new Set())} className="trn-btn">Clear all</button>
                <span className="text-xs text-gray-500 ml-auto">
                  <strong className="accent-text">{permSel.size}</strong>/{allKeys.length} granted
                </span>
              </div>

              <div className="space-y-3">
                {Object.entries(permGroups).map(([group, items]) => {
                  const on = items.filter((p) => permSel.has(p.key)).length;
                  return (
                    <div key={group} className="prm-sec">
                      <div className="prm-sec-head">
                        <span className="prm-sec-title uppercase tracking-wide text-xs">{group}</span>
                        <span className={`prm-sec-count${on ? ' is-on' : ''}`}>{on}/{items.length}</span>
                      </div>
                      <div className="grid sm:grid-cols-2 gap-x-4 p-2">
                        {items.map((p) => (
                          <label key={p.key} className="usr-perm-item">
                            <input type="checkbox" checked={permSel.has(p.key)} onChange={() => togglePerm(p.key)}
                              className="rounded border-gray-300" />
                            {p.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-2 px-6 py-4 border-t border-gray-100">
              <button type="button" onClick={() => setPermUser(null)} className="trn-btn">Cancel</button>
              <button type="button" onClick={savePerms} disabled={permSaving} className="trn-btn is-primary accent-bg text-white">
                {permSaving ? 'Saving…' : 'Save permissions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
