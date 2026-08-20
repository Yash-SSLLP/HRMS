/**
 * AdminPermissions — SuperAdmin-only access-control page (admin portal). Lists
 * users from GET /admin/users and grants module access: cashbook access for
 * anyone (PATCH /admin/users/:id/cashbook-access), khata access and the separate
 * khata download grant (PATCH /admin/users/:id/khata-access and
 * /khata-export-access), work-from-home per employee
 * (PATCH /admin/users/:id/wfh-access) and granular HR capabilities for HR
 * Managers (catalog from GET /admin/permissions/catalog, saved via
 * PATCH /admin/users/:id/permissions). Also hosts the org-wide switches from
 * GET/PUT /admin/org-settings — the chat module, and whether a cash-advance
 * request needs a CEO/MD approval before the accounts team can pay it.
 */
import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import { roleLabel } from '../config/roles';
import { GRANTABLE_ROLES } from '../config/permissions';
import { useAuthStore } from '../store/authStore';

// Dedicated access-control page: grant module permissions to any user or employee.
// Cashbook access is a standalone grant available to anyone; the granular HR
// capabilities apply to HR Managers. SuperAdmin only (the backend enforces it).
export default function AdminPermissions() {
  const me = useAuthStore((s) => s.user);
  const isSuperAdmin = me?.role === 'SuperAdmin';

  const [users, setUsers] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);

  const [permUser, setPermUser] = useState(null);
  const [permSel, setPermSel] = useState(() => new Set());
  const [permSaving, setPermSaving] = useState(false);
  const allKeys = catalog.map((p) => p.key);

  // Org-wide feature switches.
  const [org, setOrg] = useState({
    chatEnabled: false,
    khataAdvanceApprovalRequired: true,
    documentFooter: { helpline: '', note: '' },
  });
  const [orgBusy, setOrgBusy] = useState(false);
  // The footer inputs are edited freely and saved on a button, unlike the
  // switches — so they need their own draft, or every keystroke would be a PUT.
  const [footer, setFooter] = useState({ helpline: '', note: '' });
  const [footerSaved, setFooterSaved] = useState(false);

  // One reader for the org payload, so a switch save cannot drop a field it
  // does not know about — which is exactly how the footer would have been wiped
  // by the next toggle.
  const readOrg = (d = {}) => ({
    chatEnabled: !!d.chatEnabled,
    // Absent means the server has not been upgraded yet; the gate is on by
    // default there too, so assume on rather than showing it as disabled.
    khataAdvanceApprovalRequired: d.khataAdvanceApprovalRequired !== false,
    documentFooter: {
      helpline: d.documentFooter?.helpline || '',
      note: d.documentFooter?.note || '',
    },
  });

  const load = async () => {
    setLoading(true); setError('');
    try {
      const [u, c, o] = await Promise.all([
        api.get('/admin/users'),
        api.get('/admin/permissions/catalog').catch(() => ({ data: { permissions: [] } })),
        api.get('/admin/org-settings').catch(() => ({ data: {} })),
      ]);
      setUsers(u.data.users || []);
      setCatalog(c.data.permissions || []);
      const next = readOrg(o.data);
      setOrg(next);
      setFooter(next.documentFooter);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // Optimistic toggle that reverts if the save fails. One handler for every
  // org switch, keyed by field, so adding another is one line rather than a
  // second copy of the same optimistic-update dance.
  const toggleOrg = async (field, errorText) => {
    const next = !org[field];
    setOrgBusy(true); setError('');
    setOrg({ ...org, [field]: next });
    try {
      const { data } = await api.put('/admin/org-settings', { [field]: next });
      setOrg(readOrg(data));
    } catch (err) {
      setOrg({ ...org, [field]: !next });
      setError(err.response?.data?.message || errorText);
    } finally {
      setOrgBusy(false);
    }
  };

  // The contact strip printed along the bottom of the khata statement PDF.
  const saveFooter = async () => {
    setOrgBusy(true); setError(''); setFooterSaved(false);
    try {
      const { data } = await api.put('/admin/org-settings', { documentFooter: footer });
      const next = readOrg(data);
      setOrg(next);
      setFooter(next.documentFooter);
      setFooterSaved(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save the statement footer');
    } finally {
      setOrgBusy(false);
    }
  };
  const footerDirty = footer.helpline !== org.documentFooter.helpline
    || footer.note !== org.documentFooter.note;

  // Cashbook and Expenses are standalone, role-independent grants — same call
  // shape either way, so they share one handler.
  const toggleAccess = async (u, { path, enabled, errorText }) => {
    setBusyId(u._id || u.id); setError('');
    try {
      await api.patch(`/admin/users/${u._id || u.id}/${path}`, { enabled });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || errorText);
    } finally {
      setBusyId(null);
    }
  };

  const toggleCashbook = (u) => toggleAccess(u, {
    path: 'cashbook-access', enabled: !u.cashbookAccess, errorText: 'Could not update cashbook access',
  });

  const toggleExpenses = (u) => toggleAccess(u, {
    path: 'expenses-access', enabled: !u.expensesAccess, errorText: 'Could not update expenses access',
  });

  const toggleAssets = (u) => toggleAccess(u, {
    path: 'assets-access', enabled: !u.assetsAccess, errorText: 'Could not update assets access',
  });

  // Two separate khata grants on purpose. The first opens the module so someone
  // can hand cash to staff and settle it; the second lets them download every
  // employee's ledger as a spreadsheet, which is data leaving the building and
  // therefore its own decision. Granting the download alone is allowed — it just
  // does nothing until the person can also reach the module.
  const toggleKhata = (u) => toggleAccess(u, {
    path: 'khata-access', enabled: !u.khataAccess, errorText: 'Could not update khata access',
  });

  const toggleKhataExport = (u) => toggleAccess(u, {
    path: 'khata-export-access', enabled: !u.khataExportAccess, errorText: 'Could not update khata download access',
  });

  // CEO/MD only: flip the account between view-only (the default) and edit mode.
  const toggleExecEdit = async (u) => {
    setBusyId(u._id || u.id); setError('');
    try {
      await api.patch(`/admin/users/${u._id || u.id}/exec-edit-access`, { enabled: !u.execEditAccess });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update executive access');
    } finally {
      setBusyId(null);
    }
  };

  const toggleWfh = async (u) => {
    setBusyId(u._id || u.id); setError('');
    try {
      await api.patch(`/admin/users/${u._id || u.id}/wfh-access`, { enabled: !u.wfhAllowed });
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not update work-from-home access');
    } finally {
      setBusyId(null);
    }
  };

  // Seed the dialog with what the account effectively holds RIGHT NOW. A null
  // array is "all" for an HR Manager but "none" for a Manager — seeding every
  // box for a Manager would mean one careless Save handed them full admin.
  const openPerms = (u) => {
    const effective = u.permissions == null
      ? (u.role === 'HRManager' ? allKeys : [])
      : u.permissions;
    setPermSel(new Set(effective));
    setPermUser(u);
  };
  const togglePerm = (key) => setPermSel((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });
  const savePerms = async () => {
    setPermSaving(true); setError('');
    try {
      await api.patch(`/admin/users/${permUser._id || permUser.id}/permissions`, { permissions: [...permSel] });
      setPermUser(null);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save permissions');
    } finally {
      setPermSaving(false);
    }
  };

  const permGroups = catalog.reduce((acc, p) => { (acc[p.group] = acc[p.group] || []).push(p); return acc; }, {});

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return users.filter((u) => !t || `${u.firstName} ${u.lastName} ${u.email} ${u.role}`.toLowerCase().includes(t));
  }, [users, q]);

  if (!isSuperAdmin) {
    return (
      <div>
        <PageHeader title="Permissions" />
        <p className="text-sm text-gray-500">Only a Super Admin can manage permissions.</p>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Permissions" />
      <p className="text-sm text-gray-500 mb-4">
        Grant module access to any user or employee. <strong>Cashbook</strong> and <strong>Expenses</strong> access can
        be given to anyone, whatever their role; <strong>Khata</strong> likewise — with the separate
        <strong>Export</strong> tick controlling who may download every employee&apos;s cash ledger as a
        spreadsheet, which no role grants on its own; <strong>Work from home</strong> is granted per employee;
        {' '}<strong>Module permissions</strong> apply to HR Managers and Managers — an HR Manager with none set keeps
        full access, while a Manager starts with nothing and only sees the admin portal once granted something.
        {' '}<strong>CEO / MD access</strong> switches an executive account between view-only (the default) and edit
        mode — in edit mode they can change data anywhere an HR Manager can, but this page, org settings and the
        audit log stay with Super Admins.
      </p>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Org-wide feature switches */}
      <div className="bg-white shadow rounded-lg p-4 mb-5">
        <h2 className="text-sm font-semibold text-gray-800 mb-3">Modules</h2>
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-900">Chat / Messages</div>
            <p className="text-xs text-gray-500 mt-0.5">
              When off, the chat dock is hidden from every portal and the mobile Chat tab disappears.
              Existing conversations are kept and come back untouched if you switch it on again.
            </p>
          </div>
          <button onClick={() => toggleOrg('chatEnabled', 'Could not update the chat setting')} disabled={orgBusy}
            className={`shrink-0 px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${org.chatEnabled ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700' : 'text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
            {org.chatEnabled ? '✓ Enabled' : 'Disabled'}
          </button>
        </div>

        <div className="flex items-start justify-between gap-4 mt-4 pt-4 border-t border-gray-100">
          <div className="min-w-0">
            <div className="text-sm font-medium text-gray-900">CEO / MD approval for cash advances</div>
            <p className="text-xs text-gray-500 mt-0.5">
              When on, an employee&apos;s advance request waits for a CEO, MD or Super Admin to approve it before
              the accounts team can pay it. When off, requests go straight to the accounts team, who still decide
              which account the money comes out of. Requests already waiting on an executive stay there either way.
            </p>
          </div>
          <button onClick={() => toggleOrg('khataAdvanceApprovalRequired', 'Could not update the advance-approval setting')}
            disabled={orgBusy}
            className={`shrink-0 px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${org.khataAdvanceApprovalRequired ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700' : 'text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
            {org.khataAdvanceApprovalRequired ? '✓ Required' : 'Not required'}
          </button>
        </div>
      </div>

      {/* The contact strip on the khata statement PDF. Only a Super Admin can
          change it, because the document goes outside the company. */}
      <div className="bg-white shadow rounded-lg p-4 mb-5">
        <h2 className="text-sm font-semibold text-gray-800">Statement footer</h2>
        <p className="text-xs text-gray-500 mt-0.5 mb-3">
          Printed along the bottom of every khata statement PDF, next to the company logo. Leave the number
          blank to print no help line at all — a statement often leaves the building, so &quot;no number&quot;
          is a real choice.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Help / contact number</label>
            <input value={footer.helpline} maxLength={40} placeholder="+91 96069 98652"
              onChange={(e) => { setFooter({ ...footer, helpline: e.target.value }); setFooterSaved(false); }}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">Small print (optional)</label>
            <input value={footer.note} maxLength={120} placeholder="Queries on this statement within 7 days of receipt."
              onChange={(e) => { setFooter({ ...footer, note: e.target.value }); setFooterSaved(false); }}
              className="w-full border rounded-lg px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <button onClick={saveFooter} disabled={orgBusy || !footerDirty}
            className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 text-white border border-indigo-600 hover:bg-indigo-700 disabled:opacity-50">
            {orgBusy ? 'Saving…' : 'Save footer'}
          </button>
          {footerSaved && !footerDirty && <span className="text-xs text-green-700">Saved.</span>}
        </div>
      </div>

      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, email or role…"
        className="w-full sm:max-w-sm mb-4 border rounded-lg px-3 py-2 text-sm" />

      <div className="bg-white shadow rounded-lg overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Employee</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Role</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Cashbook</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Expenses</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Assets</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Khata</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Work from home</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">CEO / MD access</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">HR Permissions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={9} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={9} className="px-4 py-6 text-center text-gray-500">No users</td></tr>
            ) : filtered.map((u) => (
              <tr key={u._id || u.id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{u.firstName} {u.lastName}</div>
                  <div className="text-xs text-gray-500">{u.email}</div>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-block px-2 py-0.5 text-xs bg-gray-100 rounded-lg">{roleLabel(u.role)}</span>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleCashbook(u)} disabled={busyId === (u._id || u.id)}
                    className={`px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${u.cashbookAccess ? 'bg-teal-600 text-white border-teal-600 hover:bg-teal-700' : 'text-teal-700 border-teal-300 hover:bg-teal-50'}`}>
                    {u.cashbookAccess ? '✓ Granted' : 'Grant access'}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleExpenses(u)} disabled={busyId === (u._id || u.id)}
                    className={`px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${u.expensesAccess ? 'bg-teal-600 text-white border-teal-600 hover:bg-teal-700' : 'text-teal-700 border-teal-300 hover:bg-teal-50'}`}>
                    {u.expensesAccess ? '✓ Granted' : 'Grant access'}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <button onClick={() => toggleAssets(u)} disabled={busyId === (u._id || u.id)}
                    className={`px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${u.assetsAccess ? 'bg-teal-600 text-white border-teal-600 hover:bg-teal-700' : 'text-teal-700 border-teal-300 hover:bg-teal-50'}`}>
                    {u.assetsAccess ? '✓ Granted' : 'Grant access'}
                  </button>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-1.5 items-start">
                    <button onClick={() => toggleKhata(u)} disabled={busyId === (u._id || u.id)}
                      title="Open the employee-khata module — give cash advances and settle them."
                      className={`px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${u.khataAccess ? 'bg-teal-600 text-white border-teal-600 hover:bg-teal-700' : 'text-teal-700 border-teal-300 hover:bg-teal-50'}`}>
                      {u.khataAccess ? '✓ Granted' : 'Grant access'}
                    </button>
                    {/* Kept visible even for roles that already hold the module
                        (Accounts Manager, HR) — none of them can download
                        without this tick. */}
                    <button onClick={() => toggleKhataExport(u)} disabled={busyId === (u._id || u.id)}
                      title="Download the balances and the full ledger as an Excel file."
                      className={`px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${u.khataExportAccess ? 'bg-purple-600 text-white border-purple-600 hover:bg-purple-700' : 'text-purple-700 border-purple-300 hover:bg-purple-50'}`}>
                      {u.khataExportAccess ? '✓ Export' : 'Allow export'}
                    </button>
                  </div>
                </td>
                <td className="px-4 py-3">
                  {/* The flag lives on the employee profile, so accounts without
                      one (CEO/MD) have nothing to grant. */}
                  {u.hasProfile ? (
                    <button onClick={() => toggleWfh(u)} disabled={busyId === (u._id || u.id)}
                      className={`px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${u.wfhAllowed ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700' : 'text-indigo-700 border-indigo-300 hover:bg-indigo-50'}`}>
                      {u.wfhAllowed ? '✓ Allowed' : 'Allow WFH'}
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {/* Executives are read-only by default; this switches one
                      account into edit mode (HR-Manager-equivalent writes). */}
                  {['CEO', 'MD'].includes(u.role) ? (
                    <button onClick={() => toggleExecEdit(u)} disabled={busyId === (u._id || u.id)}
                      title={u.execEditAccess
                        ? 'Can change data across the admin portal. Click to return to view only.'
                        : 'Can view everything but change nothing. Click to allow edits.'}
                      className={`px-3 py-1.5 text-xs rounded-lg border disabled:opacity-50 ${u.execEditAccess ? 'bg-amber-600 text-white border-amber-600 hover:bg-amber-700' : 'text-amber-700 border-amber-300 hover:bg-amber-50'}`}>
                      {u.execEditAccess ? '✓ Edit mode' : 'View only'}
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  {GRANTABLE_ROLES.includes(u.role) ? (
                    <button onClick={() => openPerms(u)} className="text-indigo-600 hover:underline text-xs">
                      {/* A null array means ALL for an HR Manager but NONE for a
                          Manager, so the count has to read the role too. */}
                      Edit ({u.permissions == null
                        ? (u.role === 'HRManager' ? 'All' : 'None')
                        : u.permissions.length})
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {permUser && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
            <h2 className="card-title mb-1">Module permissions</h2>
            <p className="text-sm text-gray-500 mb-4">
              {permUser.firstName} {permUser.lastName} · {roleLabel(permUser.role)} — choose which admin capabilities
              this account has.
              {permUser.role === 'Manager' && (
                <>
                  {' '}A Manager sees the admin portal only while they hold at least one capability; their team duties
                  (approving their own team&apos;s leave) come from the role and are unaffected by anything here.
                </>
              )}
            </p>
            <div className="flex gap-2 mb-4">
              <button type="button" onClick={() => setPermSel(new Set(allKeys))}
                className="text-xs px-3 py-1.5 rounded-lg border hover:bg-gray-50">Select all</button>
              <button type="button" onClick={() => setPermSel(new Set())}
                className="text-xs px-3 py-1.5 rounded-lg border hover:bg-gray-50">Clear all</button>
              <span className="text-xs text-gray-400 self-center ml-auto">{permSel.size}/{allKeys.length} granted</span>
            </div>

            <div className="space-y-4">
              {Object.entries(permGroups).map(([group, items]) => (
                <div key={group}>
                  <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">{group}</div>
                  <div className="grid sm:grid-cols-2 gap-1.5">
                    {items.map((p) => (
                      <label key={p.key} className="flex items-center gap-2 text-sm text-gray-700 py-1">
                        <input type="checkbox" checked={permSel.has(p.key)} onChange={() => togglePerm(p.key)}
                          className="rounded border-gray-300" />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-5">
              <button type="button" onClick={() => setPermUser(null)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={savePerms} disabled={permSaving}
                className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                {permSaving ? 'Saving…' : 'Save permissions'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
