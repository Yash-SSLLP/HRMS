/**
 * AdminEmployees — employee HR-profile management (admin portal). Lists profiles
 * from GET /employees (with document-completeness status), creates/edits/deletes
 * via /employees, imports/exports via Excel/ZIP (/employees/import, /export*),
 * generates per-employee document-submission links (POST /employees/:id/doc-link),
 * and (SuperAdmin) activates accounts + toggles the include-executives org setting.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import DesignationSelect from '../components/DesignationSelect';
import DepartmentSelect from '../components/DepartmentSelect';
import { confirmDialog, promptDialog } from '../components/dialogs';
import SearchableSelect from '../components/SearchableSelect';

const EMPLOYMENT_TYPES = ['FullTime', 'PartTime', 'Contract', 'Intern'];
// Enums mirrored from models/EmployeeProfile.js — a value outside these fails validation.
const GENDERS = ['Male', 'Female', 'Other'];
const MARITAL_STATUSES = ['Single', 'Married', 'Other'];
const blankAddress = { line1: '', line2: '', city: '', state: '', pincode: '', country: 'India' };

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
  regularizationApprovers: [], // 0, 1 or 2 user ids, in approval order
  documentsVerified: false,
  dateOfBirth: '',
  gender: '',
  maritalStatus: '',
  dateOfMarriage: '',
  address: { current: {}, permanent: {} },
  emergencyContact: { name: '', relation: '', phone: '' },
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
  const navigate = useNavigate();
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
  // Live "is this employee code free?" result for the form field. The server
  // enforces uniqueness either way; this just says so before the operator has
  // filled in the rest of the record. 'idle' | 'checking' | 'free' | 'taken'
  const [codeState, setCodeState] = useState('idle');
  const [codeTakenBy, setCodeTakenBy] = useState('');
  // Phone lives on the User, not the profile, so it saves separately.
  const [editPhone, setEditPhone] = useState('');
  const phoneAtOpen = useRef('');
  const emailAtOpen = useRef('');

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

  // Load everything the page needs together: profiles, user lists (for the
  // account + manager pickers), doc-completeness, designations and work locations.
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

  // ----- deep link: /admin/employees?edit=<profileId> -----
  // The employee detail page (a read-only view) sends HR here to edit, rather
  // than keeping a second copy of this long form in sync. `back=1` means return
  // to that employee's page once the save lands.
  const [searchParams, setSearchParams] = useSearchParams();
  const editParam = searchParams.get('edit');
  const returnToDetail = searchParams.get('back') === '1';
  const handledEdit = useRef(false);

  useEffect(() => {
    if (!editParam || handledEdit.current || loading) return;
    const profile = profiles.find((p) => p._id === editParam);
    if (!profile) return; // unknown/stale id — leave the page as it is
    handledEdit.current = true;
    openEdit(profile);
    // Keep `back` (the save handler reads it); drop only the trigger.
    setSearchParams(returnToDetail ? { back: '1' } : {}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editParam, loading, profiles]);

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

  // Reporting-manager candidates, scoped to the department chosen on the form.
  //
  // Department lives on the EmployeeProfile, not on User, so the picker is a
  // client-side join of the profiles already loaded above against the user
  // directory. Executives are always offered: CEO/MD have no employee profile
  // (and so no department), and without them the head of a department would have
  // nobody above them to report to.
  const EXEC_ROLES = ['CEO', 'MD', 'SuperAdmin'];
  const managerOptions = useMemo(() => {
    const selfId = String(form.user?._id || form.user || '');
    const currentId = String(form.reportingManager?._id || form.reportingManager || '');

    const sameDept = form.department
      ? profiles
        .filter((p) => p.department === form.department && p.user && String(p.user._id) !== selfId)
        .map((p) => p.user)
      : [];
    const sameDeptIds = new Set(sameDept.map((u) => String(u._id)));

    const executives = allUsers.filter(
      (u) => EXEC_ROLES.includes(u.role) && String(u._id) !== selfId && !sameDeptIds.has(String(u._id))
    );

    // Keep an already-saved manager visible even if they fall outside the rule.
    const listed = new Set([...sameDeptIds, ...executives.map((u) => String(u._id))]);
    const current = currentId && !listed.has(currentId)
      ? allUsers.find((u) => String(u._id) === currentId) || null
      : null;

    // Everyone else: reachable by typing a name (rendered in a searchOnly
    // group), so a cross-department report is possible without the default
    // list turning into the whole company.
    const others = allUsers.filter(
      (u) => String(u._id) !== selfId
        && !listed.has(String(u._id))
        && String(u._id) !== currentId
    );

    return { sameDept, executives, current, others };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profiles, allUsers, form.department, form.user, form.reportingManager]);

  // Changing the department can invalidate the chosen manager. Clear it rather
  // than submitting a stale cross-department value the server would reject.
  const onDepartmentChange = (department) => {
    setForm((prev) => {
      const next = { ...prev, department };
      const currentId = String(prev.reportingManager?._id || prev.reportingManager || '');
      if (!currentId) return next;
      const stillValid = profiles.some(
        (p) => p.department === department && p.user && String(p.user._id) === currentId
      ) || allUsers.some((u) => String(u._id) === currentId && EXEC_ROLES.includes(u.role));
      if (!stillValid) next.reportingManager = '';
      return next;
    });
  };

  const resetDocLink = () => { setDocToken(''); setDocCopied(false); setDocBusy(false); };

  // Debounced employee-code availability check while the modal is open. Codes
  // are stored uppercase, so the comparison — and what we send — is normalised
  // the same way the server does it. Editing a profile excludes its own code.
  const typedCode = (form.employeeCode || '').trim().toUpperCase();
  useEffect(() => {
    if (!showModal || !typedCode) { setCodeState('idle'); setCodeTakenBy(''); return undefined; }
    setCodeState('checking');
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/employees/code-available', {
          params: { code: typedCode, ...(editingId ? { exclude: editingId } : {}) },
        });
        setCodeState(data.available ? 'free' : 'taken');
        setCodeTakenBy(data.takenBy || '');
      } catch {
        // A failed check must not block the form — the server still rejects a
        // duplicate on save.
        setCodeState('idle');
        setCodeTakenBy('');
      }
    }, 350);
    return () => clearTimeout(t);
  }, [typedCode, showModal, editingId]);

  const openCreate = async () => {
    setEditingId(null);
    setForm(blankProfile);
    setEditEmail('');
    setEditPhone('');
    phoneAtOpen.current = '';
    emailAtOpen.current = '';
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
      regularizationApprovers: (p.regularizationApprovers || []).map((a) => a?._id || a).filter(Boolean),
      dateOfJoining: p.dateOfJoining ? p.dateOfJoining.slice(0, 10) : '',
      dateOfBirth: p.dateOfBirth ? p.dateOfBirth.slice(0, 10) : '',
      gender: p.gender || '',
      maritalStatus: p.maritalStatus || '',
      dateOfMarriage: p.dateOfMarriage ? p.dateOfMarriage.slice(0, 10) : '',
      address: {
        current: { ...blankAddress, ...(p.address?.current || {}) },
        permanent: { ...blankAddress, ...(p.address?.permanent || {}) },
      },
      emergencyContact: { ...blankProfile.emergencyContact, ...(p.emergencyContact || {}) },
      bankDetails: { ...blankProfile.bankDetails, ...(p.bankDetails || {}) },
    });
    setEditPhone(p.user?.phone || '');
    phoneAtOpen.current = p.user?.phone || '';
    emailAtOpen.current = p.user?.email || '';
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
      try { await navigator.clipboard.writeText(link); } catch { await promptDialog({ title: 'Copy link', message: 'Copy this link:', initialValue: link, confirmText: 'Done' }); }
      setDocCopied(true);
      setTimeout(() => setDocCopied(false), 1600);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not create the submission link');
    } finally {
      setDocBusy(false);
    }
  };

  // Patch one address block without clobbering the other.
  const setAddress = (which, patch) => setForm((f) => ({
    ...f,
    address: { ...f.address, [which]: { ...(f.address?.[which] || {}), ...patch } },
  }));

  // Who the open edit form belongs to, for messages.
  const editingName = () => {
    const p = profiles.find((x) => x._id === editingId);
    return `${p?.user?.firstName || ''} ${p?.user?.lastName || ''}`.trim()
      || p?.employeeCode || 'This employee';
  };

  const onSave = async (e) => {
    e.preventDefault();

    // The live check already flagged this code as taken — stop here rather than
    // send a request the server is certain to reject.
    if (codeState === 'taken') {
      setError(`Employee code "${typedCode}" already exists. Please choose another.`);
      return;
    }

    // Changing the login email locks the old address out, so it is confirmed
    // against both values before a single request goes out.
    const nextEmail = editEmail.trim();
    if (editingId && nextEmail && nextEmail !== emailAtOpen.current) {
      const ok = await confirmDialog({
        title: 'Change sign-in email?',
        message: `${editingName()} signs in with ${emailAtOpen.current || '(none)'}.

`
          + `After saving they must use ${nextEmail} instead. The old address will no longer work.`,
        confirmText: 'Change email',
        tone: 'danger',
      });
      if (!ok) return;
    }

    // Same rule the Org Chart applies: a manager from another department is
    // allowed, but only once the operator has seen which two departments they
    // are joining. The server rejects the pairing without this acknowledgement.
    const mgrId = String(form.reportingManager?._id || form.reportingManager || '');
    const mgr = mgrId ? allUsers.find((u) => String(u._id) === mgrId) : null;
    const mgrIsExec = mgr && EXEC_ROLES.includes(mgr.role);
    const mgrDept = mgrId
      ? (profiles.find((pr) => pr.user && String(pr.user._id) === mgrId)?.department || '')
      : '';
    const crossDept = !!mgr && !mgrIsExec && !!form.department && !!mgrDept && mgrDept !== form.department;

    if (crossDept) {
      const ok = await confirmDialog({
        tone: 'warning',
        title: 'Different department',
        message: `${mgr.firstName} ${mgr.lastName} is not in this employee's department. Reporting lines normally stay within a department — confirm only if this is a deliberate cross-department (dotted-line) report.`,
        details: [
          `${editingId ? editingName() : 'This employee'} — ${form.department}`,
          `${mgr.firstName} ${mgr.lastName} — ${mgrDept}`,
        ],
        confirmText: 'Save anyway',
      });
      if (!ok) return;
    }

    setSaving(true);
    setError('');
    try {
      // Empty work-location select must clear the ref (null), not send '' (bad ObjectId).
      const payload = { ...form, workLocationRef: form.workLocationRef || null };
      if (crossDept) payload.allowCrossDepartment = true;
      // Blank enums must be dropped, not sent as '' — the schema would reject it.
      if (!payload.gender) delete payload.gender;
      if (!payload.maritalStatus) delete payload.maritalStatus;
      // An empty date string is not a castable Date — drop it rather than send ''.
      if (!payload.dateOfMarriage) delete payload.dateOfMarriage;
      if (!payload.dateOfBirth) delete payload.dateOfBirth;
      let savedId = editingId;
      if (editingId) {
        await api.put(`/employees/${editingId}`, payload);
      } else {
        const { data } = await api.post('/employees', payload);
        savedId = data.profile?._id || savedId;
      }

      // Phone and email belong to the User account, so they are a separate call
      // — and only when they actually changed. An HR Manager may not edit
      // another admin's account, so a refusal here is reported without losing
      // the profile save.
      const emailChanged = editingId && editEmail.trim() && editEmail.trim() !== emailAtOpen.current;
      const phoneChanged = editPhone !== phoneAtOpen.current;
      if (phoneChanged || emailChanged) {
        const userId = form.user?._id || form.user;
        const patch = {};
        if (phoneChanged) patch.phone = editPhone;
        if (emailChanged) patch.email = editEmail.trim();
        if (userId && Object.keys(patch).length) {
          try {
            await api.put(`/admin/users/${userId}`, patch);
            phoneAtOpen.current = editPhone;
            if (emailChanged) {
              emailAtOpen.current = editEmail.trim();
              toast.success(`Sign-in email changed to ${editEmail.trim()}`);
            }
          } catch (err) {
            toast.error(err.response?.data?.message
              || `Profile saved, but the ${emailChanged ? 'email' : 'phone number'} could not be updated`);
          }
        }
      }
      setShowModal(false);
      // Came from the employee's own page — take them back to it, now updated.
      if (editingId && returnToDetail) { navigate(`/admin/employees/${editingId}`); return; }
      await load();
    } catch (err) {
      setError(err.response?.data?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async (p) => {
    if (!(await confirmDialog({ message: `Delete profile for ${p.user?.email}?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try {
      await api.delete(`/employees/${p._id}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Delete failed');
    }
  };

  // Activate / deactivate the employee's user account (SuperAdmin only). An
  // inactive account cannot log in, even with the correct password.
  const toggleActive = async (p) => {
    const uid = p.user?._id || p.user;
    if (!uid) return;
    const active = p.user?.isActive;
    const name = p.user?.firstName || 'this employee';
    if (!(await confirmDialog({
      message: active
        ? `Deactivate ${name}'s account? They will no longer be able to log in.`
        : `Reactivate ${name}'s account? They will be able to log in again.`,
    }))) return;
    try {
      await api.patch(`/admin/users/${uid}/${active ? 'deactivate' : 'activate'}`);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update status');
    }
  };

  const usersWithoutProfile = users.filter(
    (u) => !profiles.some((p) => (p.user?._id || p.user) === u._id)
  );

  // Shared cell renderers so the desktop table and the mobile card list stay
  // in sync.
  const docBadge = (p) => {
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
      <span className="inline-block px-2 py-0.5 text-xs rounded-lg bg-red-100 text-red-800" title={`Missing: ${s.missing.join(', ')}`}>
        Incomplete ({s.missing.length})
      </span>
    );
  };
  const statusBadge = (p) =>
    String(p.user?._id || '') === myId ? (
      <span className="text-xs text-gray-400">-</span>
    ) : (
      <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${p.user?.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
        {p.user?.isActive ? 'Active' : 'Inactive'}
      </span>
    );
  const rowActions = (p) => (
    <>
      <button onClick={() => downloadFile(`/employees/${p._id}/export.zip`, `${p.employeeCode || 'employee'}.zip`)}
        className="text-gray-700 hover:underline" title="Download all documents + details as a ZIP">ZIP</button>
      {isSuperAdmin && String(p.user?._id || '') !== myId && (
        <button onClick={() => toggleActive(p)} className="text-amber-600 hover:underline">
          {p.user?.isActive ? 'Deactivate' : 'Activate'}
        </button>
      )}
      <button onClick={() => openEdit(p)} className="text-blue-600 hover:underline">Edit</button>
      <button onClick={() => onDelete(p)} className="text-red-600 hover:underline">Delete</button>
    </>
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
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3">
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

      {/* Desktop: table */}
      <div className="hidden lg:block bg-white shadow rounded-lg overflow-hidden">
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
              // The whole row opens the employee — the record was previously
              // only reachable through global search. The action buttons stop
              // the click so Edit/Delete still do their own thing.
              <tr key={p._id} onClick={() => navigate(`/admin/employees/${p._id}`)}
                className="cursor-pointer hover:bg-gray-50 transition-colors">
                <td className="px-4 py-3 font-mono text-xs">{p.employeeCode}</td>
                <td className="px-4 py-3">
                  <span className="text-gray-900 hover:underline">{p.user?.firstName} {p.user?.lastName}</span>
                  <div className="text-xs text-gray-500">{p.user?.email}</div>
                </td>
                <td className="px-4 py-3">{p.designation || '-'}<div className="text-xs text-gray-500">{p.department || ''}</div></td>
                <td className="px-4 py-3 font-mono text-xs">{p.pan || '-'}</td>
                <td className="px-4 py-3">{docBadge(p)}</td>
                <td className="px-4 py-3">{statusBadge(p)}</td>
                <td className="px-4 py-3 text-right space-x-2" onClick={(e) => e.stopPropagation()}>{rowActions(p)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Phone + tablet: card list (a wide 7-column table only scrolls sideways here) */}
      <div className="lg:hidden space-y-3">
        {loading ? (
          <div className="bg-white shadow rounded-xl p-4 space-y-2"><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-4 rounded w-2/3" /></div>
        ) : profiles.length === 0 ? (
          <div className="bg-white shadow rounded-xl p-6 text-center text-gray-500">No profiles yet</div>
        ) : profiles.map((p) => (
          <div key={p._id} className="bg-white shadow rounded-xl p-4">
            <div className="flex items-start justify-between gap-2">
              {/* Same target as the desktop row: tapping the name opens the
                  record; the action buttons below keep their own handlers. */}
              <div className="min-w-0 cursor-pointer" onClick={() => navigate(`/admin/employees/${p._id}`)}>
                <div className="font-semibold text-gray-900 truncate hover:underline">{p.user?.firstName} {p.user?.lastName}</div>
                <div className="text-xs text-gray-500 truncate">{p.user?.email}</div>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-gray-500 mt-0.5">{p.employeeCode}</span>
            </div>
            <div className="mt-2 text-sm text-gray-700">
              {p.designation || '-'}{p.department ? <span className="text-gray-400"> · {p.department}</span> : null}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {docBadge(p)}
              {statusBadge(p)}
              {p.pan ? <span className="font-mono text-[11px] text-gray-500">PAN {p.pan}</span> : null}
            </div>
            <div className="mt-3 pt-3 border-t border-gray-100 flex flex-wrap gap-2 text-sm">
              {rowActions(p)}
            </div>
          </div>
        ))}
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
                  <SearchableSelect
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
                  </SearchableSelect>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Employee Code *</label>
                  <input
                    required
                    value={form.employeeCode}
                    onChange={(e) => setForm({ ...form, employeeCode: e.target.value })}
                    placeholder="SSL 1"
                    aria-invalid={codeState === 'taken'}
                    className={`mt-1 block w-full border rounded-lg px-3 py-2 uppercase ${codeState === 'taken' ? 'border-red-400' : ''}`}
                  />
                  {codeState === 'taken' && (
                    <p className="text-xs text-red-600 mt-1">
                      Employee code “{typedCode}” already exists
                      {codeTakenBy ? ` (${codeTakenBy})` : ''}. Please choose another.
                    </p>
                  )}
                  {codeState === 'free' && (
                    <p className="text-xs text-emerald-600 mt-1">“{typedCode}” is available.</p>
                  )}
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
                    onChange={onDepartmentChange}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Work location <span className="text-gray-400 font-normal">(check-in geofence)</span></label>
                  <SearchableSelect value={form.workLocationRef || ''} onChange={(e) => setForm({ ...form, workLocationRef: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Default (office)</option>
                    {workLocations.filter((l) => l.active).map((l) => (
                      <option key={l._id} value={l._id}>{l.name}</option>
                    ))}
                  </SearchableSelect>
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm text-gray-700">Reporting Manager</label>
                  {isSuperAdmin ? (
                    <SearchableSelect
                      value={form.reportingManager || ''}
                      onChange={(e) => setForm({ ...form, reportingManager: e.target.value })}
                      className="mt-1 block w-full border rounded-lg px-3 py-2"
                      disabled={!form.department}
                    >
                      <option value="">None (top level)</option>
                      {managerOptions.sameDept.length > 0 && (
                        <optgroup label={form.department}>
                          {managerOptions.sameDept.map((u) => (
                            <option key={u._id} value={u._id}>
                              {u.firstName} {u.lastName} ({u.role}) · {u.email}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {managerOptions.executives.length > 0 && (
                        <optgroup label="Executive">
                          {managerOptions.executives.map((u) => (
                            <option key={u._id} value={u._id}>
                              {u.firstName} {u.lastName} ({u.role}) · {u.email}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {/* Hidden until the operator types — see SearchableSelect's
                          searchOnly. Picking one is allowed but asks first. */}
                      {managerOptions.others.length > 0 && (
                        <optgroup label="Other departments · search by name" searchOnly>
                          {managerOptions.others.map((u) => (
                            <option key={u._id} value={u._id}>
                              {u.firstName} {u.lastName} ({u.role}) · {u.email}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      {/* A manager saved before this rule (or from another
                          department) stays selectable so editing the record
                          doesn't silently clear it. */}
                      {managerOptions.current && (
                        <optgroup label="Currently assigned (outside this department)">
                          <option value={managerOptions.current._id}>
                            {managerOptions.current.firstName} {managerOptions.current.lastName} ({managerOptions.current.role})
                          </option>
                        </optgroup>
                      )}
                    </SearchableSelect>
                  ) : (
                    <div className="mt-1 block w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-700 text-sm">
                      {(() => {
                        const mgr = allUsers.find((u) => u._id === (form.reportingManager?._id || form.reportingManager));
                        return mgr ? `${mgr.firstName} ${mgr.lastName} (${mgr.role})` : '-';
                      })()}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    {isSuperAdmin && !form.department
                      ? 'Pick a department first — managers are chosen from within it.'
                      : 'Shows the selected department plus executives; type a name to reach anyone else (you will be asked to confirm a cross-department report). Sets the hierarchy shown on the Org Chart.'}
                  </p>
                </div>
                {/* Attendance-regularization approval ladder: 1 or 2 named people,
                    in order. Deliberately separate from the reporting manager —
                    a correction is often signed off by a shift/ops lead. Step 2
                    only appears once step 1 is chosen, so the ladder can never be
                    configured with a gap. SuperAdmin-only, matching the backend. */}
                <div className="sm:col-span-2">
                  <label className="block text-sm text-gray-700">Regularization approval</label>
                  {isSuperAdmin ? (
                    <div className="mt-1 space-y-2">
                      {[0, 1].map((idx) => {
                        const chain = form.regularizationApprovers || [];
                        // Step 2 stays hidden until step 1 is set — no gaps.
                        if (idx === 1 && !chain[0]) return null;
                        return (
                          <div key={idx} className="flex items-center gap-2">
                            <span className="text-xs text-gray-500 w-14 shrink-0">Step {idx + 1}</span>
                            <SearchableSelect
                              value={chain[idx] || ''}
                              onChange={(e) => {
                                const next = [...chain];
                                if (e.target.value) next[idx] = e.target.value;
                                else next.splice(idx);       // clearing a step drops the ones after it
                                setForm({ ...form, regularizationApprovers: next.filter(Boolean) });
                              }}
                              className="block w-full border rounded-lg px-3 py-2"
                            >
                              <option value="">{idx === 0 ? 'None — any HR reviewer decides' : 'None — one step only'}</option>
                              {allUsers
                                .filter((u) => u.isActive !== false)
                                .filter((u) => u._id !== (form.user?._id || form.user))
                                .filter((u) => u._id === chain[idx] || !chain.includes(u._id))
                                .map((u) => (
                                  <option key={u._id} value={u._id}>
                                    {u.firstName} {u.lastName} ({u.role}) · {u.email}
                                  </option>
                                ))}
                            </SearchableSelect>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="mt-1 block w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-700 text-sm">
                      {(form.regularizationApprovers || [])
                        .map((id) => {
                          const u = allUsers.find((x) => x._id === id);
                          return u ? `${u.firstName} ${u.lastName}` : null;
                        })
                        .filter(Boolean)
                        .join(' → ') || '-'}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">
                    Who approves this employee&apos;s attendance regularizations, in order — step 1 decides
                    first, step 2 confirms. Leave step 1 empty to keep the current behaviour, where any
                    HR reviewer can decide. Approvers need no special permission.
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

              <h3 className="text-sm font-semibold text-gray-700 pt-3 border-t">Personal &amp; Contact</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Phone</label>
                  <input value={editPhone} onChange={(e) => setEditPhone(e.target.value)}
                    placeholder="10 digits" className="mt-1 block w-full border rounded-lg px-3 py-2" />
                  <p className="text-[11px] text-gray-400 mt-1">Saved on the login account.</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Email (login)</label>
                  <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)}
                    placeholder="name@company.com" className="mt-1 block w-full border rounded-lg px-3 py-2" />
                  <p className="text-[11px] text-amber-700 mt-1">Changing this changes how they sign in.</p>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Date of Birth</label>
                  <input type="date" value={form.dateOfBirth || ''}
                    onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Gender</label>
                  <select value={form.gender || ''} onChange={(e) => setForm({ ...form, gender: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Not set</option>
                    {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Marital Status</label>
                  <select value={form.maritalStatus || ''} onChange={(e) => setForm({ ...form, maritalStatus: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Not set</option>
                    {MARITAL_STATUSES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Marriage Anniversary</label>
                  <input type="date" value={form.dateOfMarriage || ''}
                    onChange={(e) => setForm({ ...form, dateOfMarriage: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                  <p className="text-xs text-gray-500 mt-1">Optional — shows on the celebrations widget each year.</p>
                </div>
              </div>

              {['current', 'permanent'].map((which) => (
                <div key={which}>
                  <div className="flex items-center gap-3 mt-1">
                    <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">{which} address</h4>
                    {which === 'permanent' && (
                      // Most people's two addresses are the same; typing it twice
                      // is the commonest reason this section is left blank.
                      <button type="button" onClick={() => setAddress('permanent', { ...form.address.current })}
                        className="text-[11px] text-blue-600 hover:underline">Same as current</button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-1">
                    <input value={form.address?.[which]?.line1 || ''} placeholder="Address line 1"
                      onChange={(e) => setAddress(which, { line1: e.target.value })}
                      className="sm:col-span-2 block w-full border rounded-lg px-3 py-2" />
                    <input value={form.address?.[which]?.line2 || ''} placeholder="Address line 2"
                      onChange={(e) => setAddress(which, { line2: e.target.value })}
                      className="block w-full border rounded-lg px-3 py-2" />
                    <input value={form.address?.[which]?.city || ''} placeholder="City"
                      onChange={(e) => setAddress(which, { city: e.target.value })}
                      className="block w-full border rounded-lg px-3 py-2" />
                    <input value={form.address?.[which]?.state || ''} placeholder="State"
                      onChange={(e) => setAddress(which, { state: e.target.value })}
                      className="block w-full border rounded-lg px-3 py-2" />
                    <input value={form.address?.[which]?.pincode || ''} placeholder="PIN code (6 digits)"
                      maxLength={6} inputMode="numeric"
                      onChange={(e) => setAddress(which, { pincode: e.target.value.replace(/\D/g, '') })}
                      className="block w-full border rounded-lg px-3 py-2" />
                  </div>
                </div>
              ))}

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm text-gray-700">Emergency Contact</label>
                  <input value={form.emergencyContact?.name || ''} placeholder="Name"
                    onChange={(e) => setForm({ ...form, emergencyContact: { ...form.emergencyContact, name: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Relation</label>
                  <input value={form.emergencyContact?.relation || ''} placeholder="e.g. Father"
                    onChange={(e) => setForm({ ...form, emergencyContact: { ...form.emergencyContact, relation: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Contact Phone</label>
                  <input value={form.emergencyContact?.phone || ''} placeholder="10 digits"
                    onChange={(e) => setForm({ ...form, emergencyContact: { ...form.emergencyContact, phone: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
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
                <button type="submit" disabled={saving || codeState === 'taken'}
                  title={codeState === 'taken' ? 'That employee code already exists' : undefined}
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
                  The template also covers job, payroll (Salary Structure + Annual CTC), statutory, bank, address and emergency-contact details.
                </p>
                <p className="text-[11px] text-amber-700 mt-1">
                  Lookup columns must match existing records or the row errors: <strong>Reporting Manager Email</strong> / <strong>HR Partner Email</strong> → an existing user's email; <strong>Salary Structure</strong> → an existing structure name (create it under Salary Structures first).
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
