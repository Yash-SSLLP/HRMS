import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import { downloadFile } from '../api/download';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import DesignationSelect from '../components/DesignationSelect';
import DepartmentSelect from '../components/DepartmentSelect';

const EMPLOYMENT_TYPES = ['FullTime', 'PartTime', 'Contract', 'Intern'];

const blankProfile = {
  user: '',
  employeeCode: '',
  dateOfJoining: '',
  designation: '',
  department: '',
  grade: '',
  workLocation: '',
  workLocationRef: '',
  employmentType: 'FullTime',
  pan: '',
  uan: '',
  pfNumber: '',
  esicNumber: '',
  reportingManager: '',
  documentsVerified: false,
  bankDetails: {
    accountHolderName: '',
    bankName: '',
    branch: '',
    accountNumber: '',
    ifsc: '',
    accountType: 'Savings',
  },
};

export default function AdminEmployees() {
  const currentUser = useAuthStore((s) => s.user);
  const isSuperAdmin = currentUser?.role === 'SuperAdmin';
  const myId = String(currentUser?._id || currentUser?.id || '');
  const [profiles, setProfiles] = useState([]);
  const [users, setUsers] = useState([]);
  const [hrUsers, setHrUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [workLocations, setWorkLocations] = useState([]);
  const [docStatus, setDocStatus] = useState({}); // employeeId -> { complete, verified, missing }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(blankProfile);
  const [saving, setSaving] = useState(false);
  // Per-employee document submission link (Edit modal)
  const [docToken, setDocToken] = useState('');
  const [docBusy, setDocBusy] = useState(false);
  const [docCopied, setDocCopied] = useState(false);
  const [editEmail, setEditEmail] = useState('');

  const [showImportModal, setShowImportModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const importFileRef = useRef(null);

  const closeImport = () => {
    setShowImportModal(false);
    setImportResult(null);
    if (importFileRef.current) importFileRef.current.value = '';
  };

  const runImport = async (e) => {
    e.preventDefault();
    const file = importFileRef.current?.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/employees/import', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setImportResult(data);
      await load();
    } catch (err) {
      setImportResult({
        errorBanner: err.response?.data?.message || 'Import failed',
      });
    } finally {
      setImporting(false);
    }
  };

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [profilesRes, usersRes, allUsersRes, docRes, desigRes, wlRes] = await Promise.all([
        api.get('/employees'),
        api.get('/admin/users?role=Employee'),
        api.get('/admin/users'),
        api.get('/employees/documents-status'),
        api.get('/org-masters?kind=Designation'),
        api.get('/work-locations').catch(() => ({ data: { locations: [] } })),
      ]);
      setProfiles(profilesRes.data.profiles);
      setUsers(usersRes.data.users);
      setAllUsers(allUsersRes.data.users);
      setHrUsers(allUsersRes.data.users.filter(
        (u) => u.role === 'HRManager' || u.role === 'SuperAdmin'
      ));
      setWorkLocations(wlRes.data.locations || []);
      setDesignations(
        (desigRes.data.masters || [])
          .filter((m) => m.isActive !== false)
          .map((m) => m.name)
      );
      const map = {};
      for (const s of docRes.data.statuses) map[String(s.employee)] = s;
      setDocStatus(map);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  // SuperAdmin-only org preference: whether CEO/MD appear in employee-selection
  // pickers across the app. Off by default.
  const [execIncluded, setExecIncluded] = useState(false);
  const [execBusy, setExecBusy] = useState(false);
  useEffect(() => {
    if (!isSuperAdmin) return;
    api.get('/admin/org-settings')
      .then(({ data }) => setExecIncluded(!!data.includeExecutivesInLists))
      .catch(() => {});
  }, [isSuperAdmin]);

  const toggleExecIncluded = async () => {
    const next = !execIncluded;
    setExecBusy(true);
    setExecIncluded(next); // optimistic
    try {
      const { data } = await api.put('/admin/org-settings', { includeExecutivesInLists: next });
      setExecIncluded(!!data.includeExecutivesInLists);
    } catch (err) {
      setExecIncluded(!next); // revert on failure
      setError(err.response?.data?.message || 'Failed to update setting');
    } finally {
      setExecBusy(false);
    }
  };

  const resetDocLink = () => { setDocToken(''); setDocCopied(false); setDocBusy(false); };

  const openCreate = async () => {
    setEditingId(null);
    setForm(blankProfile);
    setEditEmail('');
    resetDocLink();
    setShowModal(true);
    // Prefill the next employee code (continues the last one, e.g. SSL 8 → SSL 9).
    // It stays editable; failure is non-fatal and just leaves the field blank.
    try {
      const { data } = await api.get('/lifecycle/next-code');
      if (data?.suggestion) setForm((f) => ({ ...f, employeeCode: data.suggestion }));
    } catch {
      /* ignore — admin can type the code manually */
    }
  };

  const openEdit = (p) => {
    setEditingId(p._id);
    setEditEmail(p.user?.email || '');
    resetDocLink();
    setForm({
      ...blankProfile,
      ...p,
      user: p.user?._id || p.user,
      hrPartner: undefined, // HR ownership removed · never send this field
      reportingManager: p.reportingManager?._id || p.reportingManager || '',
      dateOfJoining: p.dateOfJoining ? p.dateOfJoining.slice(0, 10) : '',
      bankDetails: { ...blankProfile.bankDetails, ...(p.bankDetails || {}) },
    });
    setShowModal(true);
  };

  // Per-employee public document-submission link (created lazily on demand).
  const docLink = docToken ? `${window.location.origin}/employee-docs/${docToken}` : '';
  const copyDocLink = async () => {
    if (!editingId) return;
    setDocBusy(true);
    try {
      const token = docToken || (await api.post(`/employees/${editingId}/doc-link`)).data.token;
      if (!docToken) setDocToken(token);
      const link = `${window.location.origin}/employee-docs/${token}`;
      try { await navigator.clipboard.writeText(link); } catch { window.prompt('Copy this link:', link); }
      setDocCopied(true);
      setTimeout(() => setDocCopied(false), 1600);
    } catch (err) {
      alert(err.response?.data?.message || 'Could not create the submission link');
    } finally {
      setDocBusy(false);
    }
  };

  const onSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // Empty work-location select must clear the ref (null), not send '' (bad ObjectId).
      const payload = { ...form, workLocationRef: form.workLocationRef || null };
      if (editingId) {
        await api.put(`/employees/${editingId}`, payload);
      } else {
        await api.post('/employees', payload);
      }
      setShowModal(false);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (p) => {
    if (!window.confirm(`Delete profile for ${p.user?.email}?`)) return;
    try {
      await api.delete(`/employees/${p._id}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Delete failed');
    }
  };

  // Activate / deactivate the employee's user account (SuperAdmin only). An
  // inactive account cannot log in, even with the correct password.
  const toggleActive = async (p) => {
    const uid = p.user?._id || p.user;
    if (!uid) return;
    const active = p.user?.isActive;
    const name = p.user?.firstName || 'this employee';
    if (!window.confirm(
      active
        ? `Deactivate ${name}'s account? They will no longer be able to log in.`
        : `Reactivate ${name}'s account? They will be able to log in again.`
    )) return;
    try {
      await api.patch(`/admin/users/${uid}/${active ? 'deactivate' : 'activate'}`);
      await load();
    } catch (err) {
      alert(err.response?.data?.message || 'Could not update status');
    }
  };

  const usersWithoutProfile = users.filter(
    (u) => !profiles.some((p) => (p.user?._id || p.user) === u._id)
  );

  return (
    <div>
      <PageHeader title="Employee Profiles" subtitle={`${profiles.length} profile(s)`}>
        <button
          onClick={() => downloadFile('/employees/export.xlsx', 'employees.xlsx')}
          className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm"
          title="Download all employees as an Excel file"
        >
          Export Excel
        </button>
        {isSuperAdmin && (
          <button
            onClick={() => downloadFile('/employees/export-all.zip', 'all-employees.zip')}
            className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm"
            title="Download a ZIP of every employee's documents + details"
          >
            Download All (ZIP)
          </button>
        )}
        <button
          onClick={() => downloadFile('/employees/template.xlsx', 'employee-import-template.xlsx')}
          className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm"
          title="Download the blank import template"
        >
          Template
        </button>
        <button
          onClick={() => setShowImportModal(true)}
          className="px-3 py-2 border rounded-lg hover:bg-gray-50 text-sm"
        >
          Import Excel
        </button>
        <button
          onClick={openCreate}
          className="px-4 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm"
        >
          + Add Profile
        </button>
      </PageHeader>

      {isSuperAdmin && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-indigo-100 bg-indigo-50/60 px-4 py-3">
          <div className="text-sm">
            <div className="font-medium text-gray-800">Include CEO &amp; MD in employee selection lists</div>
            <div className="text-xs text-gray-500 mt-0.5">
              When off, CEO and MD are hidden from the “select an employee” dropdowns (attendance, payroll, loans, onboarding, etc.).
              They always remain in user management, the org chart, and manager selectors.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={execIncluded}
            disabled={execBusy}
            onClick={toggleExecIncluded}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
              execIncluded ? 'bg-indigo-600' : 'bg-gray-300'
            } ${execBusy ? 'opacity-60 cursor-wait' : ''}`}
            title={execIncluded ? 'CEO & MD are shown in employee lists' : 'CEO & MD are hidden from employee lists'}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              execIncluded ? 'translate-x-5' : 'translate-x-1'
            }`} />
          </button>
        </div>
      )}

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
      )}

      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Code</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Name</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Designation</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">PAN</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Documents</th>
              <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={7} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : profiles.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">No profiles yet</td></tr>
            ) : profiles.map((p) => (
              <tr key={p._id}>
                <td className="px-4 py-3 font-mono text-xs">{p.employeeCode}</td>
                <td className="px-4 py-3">{p.user?.firstName} {p.user?.lastName}<div className="text-xs text-gray-500">{p.user?.email}</div></td>
                <td className="px-4 py-3">{p.designation || '-'}<div className="text-xs text-gray-500">{p.department || ''}</div></td>
                <td className="px-4 py-3 font-mono text-xs">{p.pan || '-'}</td>
                <td className="px-4 py-3">
                  {(() => {
                    const s = docStatus[String(p._id)];
                    if (!s) return <span className="text-xs text-gray-400">-</span>;
                    if (s.complete) {
                      return (
                        <span className="inline-block px-2 py-0.5 text-xs rounded-lg bg-green-100 text-green-800"
                          title={s.verified ? 'Marked all-submitted by HR' : 'All required documents uploaded'}>
                          Complete{s.verified ? ' ✓' : ''}
                        </span>
                      );
                    }
                    return (
                      <span className="inline-block px-2 py-0.5 text-xs rounded-lg bg-red-100 text-red-800"
                        title={`Missing: ${s.missing.join(', ')}`}>
                        Incomplete ({s.missing.length})
                      </span>
                    );
                  })()}
                </td>
                <td className="px-4 py-3">
                  {/* Nobody may see their own active status — hide it on your own row. */}
                  {String(p.user?._id || '') === myId ? (
                    <span className="text-xs text-gray-400">-</span>
                  ) : (
                    <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${p.user?.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
                      {p.user?.isActive ? 'Active' : 'Inactive'}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button
                    onClick={() => downloadFile(`/employees/${p._id}/export.zip`, `${p.employeeCode || 'employee'}.zip`)}
                    className="text-gray-700 hover:underline"
                    title="Download all documents + details as a ZIP"
                  >
                    ZIP
                  </button>
                  {/* Only SuperAdmin may change an account's active status (never their own). */}
                  {isSuperAdmin && String(p.user?._id || '') !== myId && (
                    <button onClick={() => toggleActive(p)} className="text-amber-600 hover:underline">
                      {p.user?.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  )}
                  <button onClick={() => openEdit(p)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => onDelete(p)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl p-6">
            <h2 className="card-title mb-4">
              {editingId ? 'Edit Employee Profile' : 'Create Employee Profile'}
            </h2>
            <form onSubmit={onSave} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">User account *</label>
                  <select
                    required
                    disabled={!!editingId}
                    value={form.user}
                    onChange={(e) => setForm({ ...form, user: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100"
                  >
                    <option value="">Select a user…</option>
                    {(editingId
                      ? users
                      : usersWithoutProfile
                    ).map((u) => (
                      <option key={u._id} value={u._id}>
                        {u.firstName} {u.lastName} · {u.email}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Employee Code *</label>
                  <input
                    required
                    value={form.employeeCode}
                    onChange={(e) => setForm({ ...form, employeeCode: e.target.value })}
                    placeholder="SSL 1"
                    className="mt-1 block w-full border rounded-lg px-3 py-2 uppercase"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Date of Joining *</label>
                  <input
                    type="date" required
                    value={form.dateOfJoining}
                    onChange={(e) => setForm({ ...form, dateOfJoining: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Employment Type</label>
                  <select
                    value={form.employmentType}
                    onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2"
                  >
                    {EMPLOYMENT_TYPES.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Designation</label>
                  <DesignationSelect
                    value={form.designation || ''}
                    onChange={(v) => setForm({ ...form, designation: v })}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Department</label>
                  <DepartmentSelect
                    value={form.department || ''}
                    onChange={(v) => setForm({ ...form, department: v })}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Work location <span className="text-gray-400 font-normal">(check-in geofence)</span></label>
                  <select value={form.workLocationRef || ''} onChange={(e) => setForm({ ...form, workLocationRef: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Default (office)</option>
                    {workLocations.filter((l) => l.active).map((l) => (
                      <option key={l._id} value={l._id}>{l.name}</option>
                    ))}
                  </select>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm text-gray-700">Reporting Manager</label>
                  {isSuperAdmin ? (
                    <select
                      value={form.reportingManager || ''}
                      onChange={(e) => setForm({ ...form, reportingManager: e.target.value })}
                      className="mt-1 block w-full border rounded-lg px-3 py-2"
                    >
                      <option value="">None (top level)</option>
                      {allUsers
                        .filter((u) => u._id !== (form.user?._id || form.user))
                        .map((u) => (
                          <option key={u._id} value={u._id}>
                            {u.firstName} {u.lastName} ({u.role}) · {u.email}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <div className="mt-1 block w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-700 text-sm">
                      {(() => {
                        const mgr = allUsers.find((u) => u._id === (form.reportingManager?._id || form.reportingManager));
                        return mgr ? `${mgr.firstName} ${mgr.lastName} (${mgr.role})` : '-';
                      })()}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    Sets the reporting hierarchy shown on the Org Chart.
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={!!form.documentsVerified}
                      onChange={(e) => setForm({ ...form, documentsVerified: e.target.checked })} />
                    Documents verified · mark all documents as submitted
                  </label>
                  <p className="text-xs text-gray-500 mt-1">
                    Overrides the document checklist and shows this employee as “Complete”.
                  </p>
                </div>

                {/* Document submission link — send to the employee to collect any missing docs. */}
                {editingId && (
                  <div className="sm:col-span-2 border rounded-lg p-3 bg-gray-50">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-700">Document submission link</span>
                      <div className="flex gap-2">
                        <button type="button" onClick={copyDocLink} disabled={docBusy}
                          className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-60">
                          {docBusy ? 'Working…' : docCopied ? 'Copied!' : docToken ? 'Copy link' : 'Create & copy link'}
                        </button>
                        {docToken && editEmail && (
                          <a
                            href={`mailto:${editEmail}?subject=${encodeURIComponent('Please submit your documents')}&body=${encodeURIComponent(`Hi,\n\nPlease upload your documents using this secure link:\n${docLink}\n\nThank you.`)}`}
                            className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50"
                          >
                            Email link
                          </a>
                        )}
                      </div>
                    </div>
                    {(() => {
                      const miss = docStatus[editingId]?.missing || [];
                      return miss.length > 0 ? (
                        <p className="text-xs text-amber-700 mt-1.5">
                          Missing: {miss.join(', ')}. Share this link so they can upload the missing documents.
                        </p>
                      ) : (
                        <p className="text-xs text-gray-500 mt-1.5">
                          All required documents are in. You can still share this link for re-uploads.
                        </p>
                      );
                    })()}
                    {docToken && (
                      <input readOnly value={docLink} onFocus={(e) => e.target.select()}
                        className="mt-2 block w-full border rounded-lg px-2 py-1.5 text-xs bg-white font-mono" />
                    )}
                  </div>
                )}
              </div>

              <h3 className="text-sm font-semibold text-gray-700 pt-3 border-t">Statutory IDs (India)</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">PAN</label>
                  <input value={form.pan}
                    onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })}
                    placeholder="ABCDE1234F" maxLength={10}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">UAN</label>
                  <input value={form.uan}
                    onChange={(e) => setForm({ ...form, uan: e.target.value })}
                    placeholder="12 digits" maxLength={12}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">PF Number</label>
                  <input value={form.pfNumber}
                    onChange={(e) => setForm({ ...form, pfNumber: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">ESIC Number</label>
                  <input value={form.esicNumber}
                    onChange={(e) => setForm({ ...form, esicNumber: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <h3 className="text-sm font-semibold text-gray-700 pt-3 border-t">Bank Details</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Account Holder</label>
                  <input value={form.bankDetails.accountHolderName}
                    onChange={(e) => setForm({ ...form, bankDetails: { ...form.bankDetails, accountHolderName: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Bank Name</label>
                  <input value={form.bankDetails.bankName}
                    onChange={(e) => setForm({ ...form, bankDetails: { ...form.bankDetails, bankName: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Account Number</label>
                  <input value={form.bankDetails.accountNumber}
                    onChange={(e) => setForm({ ...form, bankDetails: { ...form.bankDetails, accountNumber: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">IFSC</label>
                  <input value={form.bankDetails.ifsc}
                    onChange={(e) => setForm({ ...form, bankDetails: { ...form.bankDetails, ifsc: e.target.value.toUpperCase() } })}
                    placeholder="HDFC0001234" maxLength={11}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono" />
                </div>
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

      {showImportModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="card-title">Import Employees from Excel</h2>
                <p className="text-xs text-gray-500 mt-1">
                  Use the <strong>Template</strong> button first to get a correctly-formatted file. Required columns: Employee Code, First Name, Last Name, Email, Date of Joining.
                </p>
              </div>
              <button onClick={closeImport} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
            </div>

            {!importResult && (
              <form onSubmit={runImport} className="space-y-3">
                <input
                  ref={importFileRef}
                  type="file" required
                  accept=".xlsx"
                  className="block w-full text-sm border rounded-lg px-3 py-2"
                />
                <p className="text-xs text-gray-500">
                  New users will be created with default password <code className="bg-gray-100 px-1 py-0.5 rounded">Welcome@123</code>.
                  Rows with duplicate email or employee code will be skipped, not overwritten.
                </p>
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={closeImport}
                    className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={importing}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {importing ? 'Importing…' : 'Upload & Import'}
                  </button>
                </div>
              </form>
            )}

            {importResult && (
              <div className="space-y-4">
                {importResult.errorBanner ? (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                    {importResult.errorBanner}
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                        <div className="text-2xl font-semibold text-green-800">{importResult.createdCount}</div>
                        <div className="text-xs text-green-700">Created</div>
                      </div>
                      <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                        <div className="text-2xl font-semibold text-amber-800">{importResult.skippedCount}</div>
                        <div className="text-xs text-amber-700">Skipped (duplicates)</div>
                      </div>
                      <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                        <div className="text-2xl font-semibold text-red-800">{importResult.errorCount}</div>
                        <div className="text-xs text-red-700">Errors</div>
                      </div>
                    </div>

                    {importResult.createdCount > 0 && (
                      <p className="text-sm text-gray-700">
                        Default password for newly-created accounts: <code className="bg-gray-100 px-1 py-0.5 rounded">{importResult.defaultPassword}</code> · communicate this to the employees so they can sign in and change it.
                      </p>
                    )}

                    {importResult.errors?.length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold mb-1">Errors</h3>
                        <div className="max-h-40 overflow-y-auto text-xs border rounded">
                          <table className="w-full">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-2 py-1 text-left">Row</th>
                                <th className="px-2 py-1 text-left">Reason</th>
                              </tr>
                            </thead>
                            <tbody>
                              {importResult.errors.map((e, i) => (
                                <tr key={i} className="border-t">
                                  <td className="px-2 py-1">{e.excelRow}</td>
                                  <td className="px-2 py-1 text-red-700">{e.message}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {importResult.skipped?.length > 0 && (
                      <div>
                        <h3 className="text-sm font-semibold mb-1">Skipped</h3>
                        <div className="max-h-32 overflow-y-auto text-xs border rounded">
                          <table className="w-full">
                            <thead className="bg-gray-50">
                              <tr>
                                <th className="px-2 py-1 text-left">Row</th>
                                <th className="px-2 py-1 text-left">Identifier</th>
                                <th className="px-2 py-1 text-left">Reason</th>
                              </tr>
                            </thead>
                            <tbody>
                              {importResult.skipped.map((s, i) => (
                                <tr key={i} className="border-t">
                                  <td className="px-2 py-1">{s.excelRow}</td>
                                  <td className="px-2 py-1">{s.email || s.employeeCode}</td>
                                  <td className="px-2 py-1 text-amber-700">{s.reason}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </>
                )}

                <div className="flex justify-end">
                  <button onClick={closeImport}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
