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
import { ROLES, roleLabel } from '../config/roles';
import { canAdministerEmployee } from '../config/permissions';
import { formatDateTime12 } from '../utils/time';

const EMPLOYMENT_TYPES = ['FullTime', 'PartTime', 'Contract', 'Intern'];
// Enums mirrored from models/EmployeeProfile.js — a value outside these fails validation.
const GENDERS = ['Male', 'Female', 'Other'];

// ----- Import review -----
// Mirrors ROLES in backend/models/User.js. The import cannot invent a role, so
// this is the closed list a reviewer picks from when correcting one.
const ROLE_OPTIONS = ['SuperAdmin', 'HRManager', 'CEO', 'MD', 'Manager', 'LDManager', 'AccountsManager', 'Employee'];

// Field labels for a flag chip. Keyed by ImportFlag.FLAG_FIELDS.
const FLAG_LABELS = {
  role: 'Role',
  designation: 'Designation',
  department: 'Department',
  grade: 'Grade',
  workLocation: 'Work location',
  company: 'Company',
  salaryStructure: 'Salary structure',
  reportingManager: 'Reporting manager',
  hrPartner: 'HR partner',
};

// What to type in the correction box — an email for the two person fields, a
// name for everything else. Saying so beats a reviewer guessing and failing.
const PLACEHOLDERS = {
  reportingManager: 'Their manager’s email address',
  hrPartner: 'The HR partner’s email address',
  salaryStructure: 'An existing salary structure name',
  role: 'Pick a system role',
};
const MARITAL_STATUSES = ['Single', 'Married', 'Other'];
const blankAddress = { line1: '', line2: '', city: '', state: '', pincode: '', country: 'India' };

const blankProfile = {
  user: '',
  employeeCode: '',
  dateOfJoining: '',
  designation: '',
  department: '',
  company: '',
  hrPartner: '',
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

// Roles that deliberately never get an employee profile: CEO and MD are not
// employees, and SuperAdmin is an admin login rather than somebody on the
// payroll. Everyone else can have one.
const PROFILE_INELIGIBLE_ROLES = ['CEO', 'MD', 'SuperAdmin'];

// The roles this modal may set. It edits somebody who HAS an employee profile,
// and the three above are exactly the roles that never have one — offering them
// here would let you produce an account that contradicts its own record. Making
// somebody a CEO/MD/Backend is done on the Users page, where the profile can be
// removed at the same time.
const ASSIGNABLE_ROLES = ROLES.filter((r) => !PROFILE_INELIGIBLE_ROLES.includes(r));

/**
 * Does this user already have an employee profile?
 *
 * Prefers the server's own `hasProfile` (listUsers computes it straight from the
 * EmployeeProfile collection) and only falls back to joining against the loaded
 * profile list, which is the weaker test — that list is filtered for display and
 * so cannot be relied on to contain every profile.
 */
const userHasProfile = (u, profiles) => (
  typeof u.hasProfile === 'boolean'
    ? u.hasProfile
    : profiles.some((p) => (p.user?._id || p.user) === u._id)
);

/**
 * When was this employee last touched?
 *
 * The LATER of the profile's and the account's `updatedAt`: designation,
 * department and the rest live on the profile, while role, login email and
 * phone live on the User — so reading only one of them would report a record as
 * untouched on the very day somebody changed its role.
 */
const lastUpdatedAt = (p) => {
  const a = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
  const b = p.user?.updatedAt ? new Date(p.user.updatedAt).getTime() : 0;
  const max = Math.max(a, b);
  return max ? new Date(max) : null;
};

/**
 * The sortable columns, each with the value to sort on.
 *
 * `numeric: true` on the text comparisons is what makes employee codes come out
 * in human order: a plain string sort puts "SSL 122" before "SSL 7" because it
 * compares character by character. It matters for designations with numbers in
 * them too ("Engineer II" vs "Engineer I").
 *
 * `type: 'num'` columns sort high-to-low first, because "most recently updated"
 * and "still incomplete" are the answers somebody is looking for when they click
 * those headers — ascending would put the least interesting rows on top.
 */
const SORTS = {
  // Spaces are stripped before comparing: the codes in use are inconsistent
  // about them ("SSL 7" beside "SSL41"), and a space sorts before a digit — so
  // comparing them literally interleaves the numbers, putting SSL 122 above
  // SSL41. Normalising gives SSL7 < SSL41 < SSL68 < SSL122, which is the order
  // anybody reading a code column expects.
  code: { label: 'Employee code', get: (p) => String(p.employeeCode || '').replace(/\s+/g, '') },
  name: { label: 'Name', get: (p) => `${p.user?.firstName || ''} ${p.user?.lastName || ''}`.trim() },
  designation: { label: 'Designation', get: (p) => p.designation || '' },
  department: { label: 'Department', get: (p) => p.department || '' },
  documents: { label: 'Documents', type: 'num', get: (p, docs) => (docs[String(p._id)]?.complete ? 1 : 0) },
  status: { label: 'Status', type: 'num', get: (p) => (p.user?.isActive ? 1 : 0) },
  updated: { label: 'Last update', type: 'num', get: (p) => (lastUpdatedAt(p)?.getTime() || 0) },
};

// A work site is offered to an employee when it belongs to their company, or is
// a shared site with no company, or the employee has no company set yet (nothing
// to constrain against). Keeps each company's people on their own sites.
const siteMatchesCompany = (loc, companyId) => {
  const lc = String(loc.company?._id || loc.company || '');
  const cid = String(companyId || '');
  if (!cid) return true; // employee has no company → no constraint
  if (!lc) return true;  // shared site (no company) → available to everyone
  return lc === cid;
};

/**
 * A column header you can click to sort by.
 *
 * The arrow shows only on the active column — an arrow on every header tells you
 * nothing about which one is in force. `aria-sort` carries the same fact to a
 * screen reader, which cannot see the glyph.
 */
function SortHeader({ label, sortKey, sort, onSort, align = 'left' }) {
  const active = sort.key === sortKey;
  return (
    <th
      className={`px-4 py-3 text-${align} font-medium text-gray-700`}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 hover:text-gray-900 ${active ? 'text-gray-900' : ''}`}
      >
        {label}
        <span className={`text-[10px] leading-none ${active ? 'accent-text' : 'text-gray-300'}`} aria-hidden="true">
          {active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}

export default function AdminEmployees() {
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const isSuperAdmin = currentUser?.role === 'SuperAdmin';
  // Two rules the server applies too, so the button is never offered where it
  // would fail: nobody edits their OWN record from the admin side (use My
  // Portal), and a Manager's record needs the manager-profile grant.
  const canEditProfile = (p) => canAdministerEmployee(currentUser, p?.user);
  const noEditReason = (p) => (
    String(p?.user?._id || '') === String(currentUser?._id || currentUser?.id || '')
      ? 'You cannot edit your own record here — use My Portal.'
      : "Editing a Manager's profile needs a Super Admin's permission."
  );
  const myId = String(currentUser?._id || currentUser?.id || '');
  const [profiles, setProfiles] = useState([]);
  const [users, setUsers] = useState([]);
  const [hrUsers, setHrUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [workLocations, setWorkLocations] = useState([]);
  const [companies, setCompanies] = useState([]);
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
  // The role lives on the login account, not the profile — same separate-save
  // treatment as phone and email below.
  //
  // Only the Backend account may CHANGE it, mirroring updateUser on the server:
  // it refuses an admin role from anyone else, and refuses any edit to a
  // non-Employee account from anyone else — which leaves an HR Manager able to
  // set "Employee" on an Employee, i.e. nothing. Everyone else sees the role
  // read-only rather than a control that would only ever fail.
  const [editRole, setEditRole] = useState('Employee');
  const roleAtOpen = useRef('Employee');
  const canSetRole = isSuperAdmin;

  const [showImportModal, setShowImportModal] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const importFileRef = useRef(null);

  // ----- Import review -----
  // Values an import had to invent (a department nobody had created) or could
  // not honour (a role that isn't a role). The rows imported regardless; these
  // are what somebody has to look at afterwards.
  const [flags, setFlags] = useState([]);
  const [showFlags, setShowFlags] = useState(false);
  const [flagEdits, setFlagEdits] = useState({}); // flagId -> the corrected value being typed
  const [flagBusy, setFlagBusy] = useState('');

  const loadFlags = async () => {
    try {
      const { data } = await api.get('/employees/import-flags');
      setFlags(data.flags || []);
    } catch {
      setFlags([]); // never let the review list break the page
    }
  };

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
      await Promise.all([load(), loadFlags()]);
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
      const [profilesRes, usersRes, allUsersRes, docRes, desigRes, wlRes, companiesRes] = await Promise.all([
        api.get('/employees'),
        api.get('/admin/users?role=Employee'),
        api.get('/admin/users'),
        api.get('/employees/documents-status'),
        api.get('/org-masters?kind=Designation'),
        api.get('/work-locations').catch(() => ({ data: { locations: [] } })),
        api.get('/companies').catch(() => ({ data: { companies: [] } })),
      ]);
      setProfiles(profilesRes.data.profiles);
      setUsers(usersRes.data.users);
      setAllUsers(allUsersRes.data.users);
      setHrUsers(allUsersRes.data.users.filter(
        (u) => u.role === 'HRManager' || u.role === 'SuperAdmin'
      ));
      setWorkLocations(wlRes.data.locations || []);
      setCompanies(companiesRes.data.companies || []);
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

  useEffect(() => { load(); loadFlags(); }, []);

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
    // A link can outlive the grant (or arrive from someone who never had it),
    // so the same check the Edit button makes applies to the deep link too.
    if (!canEditProfile(profile)) {
      toast.error(noEditReason(profile));
      setSearchParams({}, { replace: true });
      return;
    }
    openEdit(profile);
    // Keep `back` (the save handler reads it); drop only the trigger.
    setSearchParams(returnToDetail ? { back: '1' } : {}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editParam, loading, profiles]);

  // ----- deep link: /admin/employees?importFlags=<batch> -----
  // Where the "imported values need a check" notification lands. The batch is
  // not used to filter (an admin opening this wants every open flag, not just
  // that upload's) — it only says which notification brought them here.
  const flagsParam = searchParams.get('importFlags');
  const handledFlags = useRef(false);
  useEffect(() => {
    if (!flagsParam || handledFlags.current) return;
    handledFlags.current = true;
    setShowFlags(true);
    setSearchParams({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsParam]);

  /**
   * Close one flag, optionally correcting the value first.
   * An empty box means "what the import did was right" — the flag clears and
   * nothing on the employee changes.
   */
  const resolveFlag = async (flag) => {
    const value = (flagEdits[flag._id] || '').trim();
    setFlagBusy(flag._id);
    try {
      const { data } = await api.patch(`/employees/import-flags/${flag._id}`, value ? { value } : {});
      toast.success(data.message || 'Done');
      setFlagEdits((s) => { const n = { ...s }; delete n[flag._id]; return n; });
      // The value may have landed on the employee, so refresh both lists.
      await Promise.all([loadFlags(), value ? load() : Promise.resolve()]);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update');
    } finally {
      setFlagBusy('');
    }
  };

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
  // Work-location options narrowed to the employee's company (+ shared sites),
  // always keeping the currently-assigned site so an edit never silently drops it.
  const visibleWorkLocations = useMemo(() => {
    const cur = String(form.workLocationRef || '');
    return workLocations.filter(
      (l) => l.active && (siteMatchesCompany(l, form.company) || String(l._id) === cur)
    );
  }, [workLocations, form.company, form.workLocationRef]);

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
    // Creating picks an EXISTING account, which already carries its own role —
    // so the picker is edit-only and this is just a reset.
    setEditRole('Employee');
    roleAtOpen.current = 'Employee';
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
      company: p.company?._id || p.company || '',
      // Shown so the Backend can (re)assign the HR partner; stripped from the
      // payload for anyone who is not a SuperAdmin (see the save handler).
      hrPartner: p.hrPartner?._id || p.hrPartner || '',
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
    setEditRole(p.user?.role || 'Employee');
    roleAtOpen.current = p.user?.role || 'Employee';
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
      // Company: '' → null so an empty select clears it rather than sending a bad ObjectId.
      payload.company = form.company || null;
      // Assigning the HR partner is Backend-only; the server ignores this field
      // for non-SuperAdmins, but strip it here too so a blank never clobbers an
      // existing assignment through some other path.
      if (isSuperAdmin) payload.hrPartner = form.hrPartner || null;
      else delete payload.hrPartner;
      if (crossDept) payload.allowCrossDepartment = true;
      // Blank enums must be dropped, not sent as '' — the schema would reject it.
      if (!payload.gender) delete payload.gender;
      if (!payload.maritalStatus) delete payload.maritalStatus;
      // An empty date string is not a castable Date — drop it rather than send ''.
      if (!payload.dateOfMarriage) delete payload.dateOfMarriage;
      if (!payload.dateOfBirth) delete payload.dateOfBirth;
      let savedId = editingId;
      let queuedForApproval = 0;
      if (editingId) {
        const { data } = await api.put(`/employees/${editingId}`, payload);
        queuedForApproval = data.queuedForApproval || 0;
      } else {
        const { data } = await api.post('/employees', payload);
        savedId = data.profile?._id || savedId;
      }
      // An HR Manager's detail changes don't apply directly — they were sent to
      // the employee's company CEO/MD for approval.
      if (queuedForApproval > 0) {
        toast.info(`${queuedForApproval} change${queuedForApproval === 1 ? '' : 's'} sent to the CEO/MD for approval — they'll apply once approved.`);
      }

      // Phone and email belong to the User account, so they are a separate call
      // — and only when they actually changed. An HR Manager may not edit
      // another admin's account, so a refusal here is reported without losing
      // the profile save.
      const emailChanged = editingId && editEmail.trim() && editEmail.trim() !== emailAtOpen.current;
      const phoneChanged = editPhone !== phoneAtOpen.current;
      // The role rides along in the same call. Unlike name/email/phone it is
      // "operational", so the server applies it directly rather than queueing it
      // for a CEO/MD — and refuses outright if this admin may not grant it.
      const roleChanged = editingId && canSetRole && editRole && editRole !== roleAtOpen.current;
      if (phoneChanged || emailChanged || roleChanged) {
        const userId = form.user?._id || form.user;
        const patch = {};
        if (phoneChanged) patch.phone = editPhone;
        if (emailChanged) patch.email = editEmail.trim();
        if (roleChanged) patch.role = editRole;
        if (userId && Object.keys(patch).length) {
          try {
            const { data: uData } = await api.put(`/admin/users/${userId}`, patch);
            if (uData?.queuedForApproval > 0) {
              // HR edit — name/email/phone were sent to the CEO/MD, not applied.
              toast.info(`${uData.queuedForApproval} change${uData.queuedForApproval === 1 ? '' : 's'} sent to the CEO/MD for approval.`);
            } else {
              phoneAtOpen.current = editPhone;
              if (emailChanged) {
                emailAtOpen.current = editEmail.trim();
                toast.success(`Sign-in email changed to ${editEmail.trim()}`);
              }
              if (roleChanged) {
                roleAtOpen.current = editRole;
                toast.success(`Role changed to ${roleLabel(editRole)}`);
              }
            }
          } catch (err) {
            // Name the field that failed — "could not be updated" on its own
            // leaves you guessing which of the three the server refused.
            const field = roleChanged ? 'role' : emailChanged ? 'email' : 'phone number';
            toast.error(err.response?.data?.message || `Profile saved, but the ${field} could not be updated`);
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
    // Deleting now cascades (services/purgePerson.js): the login and everything
    // the person owns goes with the profile, so the warning has to say so.
    if (!(await confirmDialog({
      message: `Permanently delete ${p.user?.email}?

This removes their login and every record they own — attendance, leave, documents, notifications and chat. Payroll records and the audit log are kept.

This cannot be undone.`,
      tone: 'danger',
      confirmText: 'Delete everything',
    }))) return;
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


  // Candidates for a NEW employee profile: anyone who can hold one and does not
  // already. Deliberately drawn from every user, not just role=Employee — a
  // Manager, HR Manager or Accounts Manager is an employee too and needs a
  // profile, and filtering to role=Employee made those accounts impossible to
  // convert once every plain Employee already had one.
  const usersWithoutProfile = allUsers.filter(
    (u) => !PROFILE_INELIGIBLE_ROLES.includes(u.role) && !userHasProfile(u, profiles)
  );

  // Shared cell renderers so the desktop table and the mobile card list stay
  // in sync.
  // ----- Directory search + filters -----
  // All client-side: the list is already fully loaded, so filtering here is
  // instant and needs no round trip. `query` is what has actually been applied;
  // `search` is what is in the box. They differ only between typing and
  // submitting, which is what makes the Search button mean something.
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ department: '', company: '', status: '', documents: '' });
  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  // `key: ''` = leave the server's order alone (newest added first), which is
  // what the page has always shown — sorting is opt-in, not a new default.
  const [sort, setSort] = useState({ key: '', dir: 'asc' });
  const clearFilters = () => {
    setFilters({ department: '', company: '', status: '', documents: '' });
    setSearch(''); setQuery(''); setSort({ key: '', dir: 'asc' });
  };
  const activeFilterCount = Object.values(filters).filter(Boolean).length + (query ? 1 : 0) + (sort.key ? 1 : 0);

  /**
   * Click a column: sort by it, or flip the direction if it is already the one.
   * A numeric column opens descending (newest / most complete first); a text
   * column opens A–Z.
   */
  const toggleSort = (key) => setSort((s) => (
    s.key === key
      ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: SORTS[key]?.type === 'num' ? 'desc' : 'asc' }
  ));

  // Options come from the people actually on the page, so a filter never offers
  // a value that would return nothing.
  const departmentOptions = useMemo(
    () => [...new Set(profiles.map((p) => p.department).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [profiles]
  );
  const companyOptions = useMemo(
    () => [...new Set(profiles.map((p) => p.company?.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [profiles]
  );

  const visibleProfiles = useMemo(() => {
    const t = query.trim().toLowerCase();
    const matched = profiles.filter((p) => {
      if (filters.department && p.department !== filters.department) return false;
      if (filters.company && p.company?.name !== filters.company) return false;
      if (filters.status && String(!!p.user?.isActive) !== filters.status) return false;
      if (filters.documents) {
        const s = docStatus[String(p._id)];
        const complete = !!s?.complete;
        if (filters.documents === 'complete' && !complete) return false;
        if (filters.documents === 'incomplete' && complete) return false;
      }
      if (!t) return true;
      // Everything on the row, plus the fields somebody would reasonably type
      // (PAN and the company name) even though only some of them are columns.
      return [
        p.employeeCode, p.designation, p.department, p.pan,
        p.user?.firstName, p.user?.lastName, p.user?.email, p.company?.name,
        `${p.user?.firstName || ''} ${p.user?.lastName || ''}`,
      ].some((v) => String(v || '').toLowerCase().includes(t));
    });

    const col = SORTS[sort.key];
    if (!col) return matched; // untouched: the server's newest-first order

    const sign = sort.dir === 'asc' ? 1 : -1;
    // Sort a COPY: `matched` may be `profiles` itself when nothing is filtered,
    // and sorting that in place would mutate state React thinks is unchanged.
    return [...matched].sort((a, b) => {
      const av = col.get(a, docStatus);
      const bv = col.get(b, docStatus);
      if (col.type === 'num') return sign * ((av || 0) - (bv || 0));
      // Blanks sink to the bottom whichever way the column is pointing —
      // a column of dashes at the top is never the answer to "sort by this".
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      return sign * String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [profiles, query, filters, docStatus, sort]);

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
      {canEditProfile(p) ? (
        <button onClick={() => openEdit(p)} className="text-blue-600 hover:underline">Edit</button>
      ) : (
        <span className="text-gray-400 cursor-not-allowed" title={noEditReason(p)}>Edit</span>
      )}
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

      {/* An import never refuses a row for naming something new — it creates
          what it safely can and says so here. Amber, not red: nothing is
          broken, but somebody should look. */}
      {flags.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <div className="text-sm">
            <div className="font-medium text-amber-900">
              {flags.length === 1
                ? 'One imported value needs a check'
                : `${flags.length} imported values need a check`}
            </div>
            <div className="text-xs text-amber-800 mt-0.5">
              The Excel import created these or could not match them. The employees were imported either way.
            </div>
          </div>
          <button
            type="button"
            onClick={() => setShowFlags(true)}
            className="px-3 py-2 rounded-lg bg-amber-600 text-white text-sm hover:bg-amber-700 shrink-0"
          >
            Review
          </button>
        </div>
      )}

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

      {/* ---------------- Search + filters ---------------- */}
      <div className="bg-white shadow rounded-lg px-4 py-3.5 mb-4">
        <div className="flex flex-wrap items-center gap-3">
          {/* A real form, so Enter submits and the button is not decoration. */}
          <form
            onSubmit={(e) => { e.preventDefault(); setQuery(search); }}
            className="flex items-center gap-2 flex-1 min-w-[16rem]"
          >
            <div className="relative flex-1">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm pointer-events-none">🔍</span>
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  // Emptying the box restores the full list straight away —
                  // making somebody press Search to see everything again is
                  // the kind of small rudeness that makes a filter feel broken.
                  if (!e.target.value) setQuery('');
                }}
                placeholder="Search name, code, email, designation, PAN…"
                aria-label="Search employees"
                className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm"
              />
            </div>
            <button type="submit" className="px-4 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 shrink-0">
              Search
            </button>
          </form>

          <select value={filters.department} onChange={(e) => setFilter('department', e.target.value)}
            aria-label="Filter by department" className="border rounded-lg px-3 py-2 text-sm text-gray-700">
            <option value="">All departments</option>
            {departmentOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>

          {companyOptions.length > 1 && (
            <select value={filters.company} onChange={(e) => setFilter('company', e.target.value)}
              aria-label="Filter by company" className="border rounded-lg px-3 py-2 text-sm text-gray-700">
              <option value="">All companies</option>
              {companyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Filter by status" className="border rounded-lg px-3 py-2 text-sm text-gray-700">
            <option value="">Any status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>

          <select value={filters.documents} onChange={(e) => setFilter('documents', e.target.value)}
            aria-label="Filter by document completeness" className="border rounded-lg px-3 py-2 text-sm text-gray-700">
            <option value="">Any documents</option>
            <option value="complete">Documents complete</option>
            <option value="incomplete">Documents incomplete</option>
          </select>

          {/* The same sort the column headers drive. It lives here as well
              because the phone/tablet view is a card list with no headers to
              click — without this, sorting would be desktop-only. */}
          <select
            value={sort.key ? `${sort.key}:${sort.dir}` : ''}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':');
              setSort(key ? { key, dir } : { key: '', dir: 'asc' });
            }}
            aria-label="Sort by"
            className="border rounded-lg px-3 py-2 text-sm text-gray-700"
          >
            <option value="">Sort: recently added</option>
            <option value="name:asc">Name A–Z</option>
            <option value="name:desc">Name Z–A</option>
            <option value="code:asc">Code ascending</option>
            <option value="code:desc">Code descending</option>
            <option value="designation:asc">Designation A–Z</option>
            <option value="department:asc">Department A–Z</option>
            <option value="updated:desc">Last update — newest</option>
            <option value="updated:asc">Last update — oldest</option>
            <option value="documents:asc">Documents — incomplete first</option>
            <option value="status:asc">Status — inactive first</option>
          </select>

          <div className="flex items-center gap-3 ml-auto shrink-0">
            {activeFilterCount > 0 && (
              <button type="button" onClick={clearFilters} className="text-xs text-gray-600 hover:underline">
                Clear {activeFilterCount === 1 ? 'filter' : 'filters'}
              </button>
            )}
            <span className="text-xs text-gray-500 whitespace-nowrap">
              {loading ? 'Loading…'
                : visibleProfiles.length === profiles.length
                  ? `${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'}`
                  : `${visibleProfiles.length} of ${profiles.length}`}
            </span>
          </div>
        </div>
      </div>

      {/* Desktop: table */}
      <div className="hidden lg:block bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <SortHeader label="Code" sortKey="code" sort={sort} onSort={toggleSort} />
              <SortHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
              <SortHeader label="Designation" sortKey="designation" sort={sort} onSort={toggleSort} />
              {/* PAN is an identifier nobody scans in order — no sort. */}
              <th className="px-4 py-3 text-left font-medium text-gray-700">PAN</th>
              <SortHeader label="Documents" sortKey="documents" sort={sort} onSort={toggleSort} />
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
              <SortHeader label="Last update" sortKey="updated" sort={sort} onSort={toggleSort} />
              <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={8} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : visibleProfiles.length === 0 ? (
              // "No profiles yet" is wrong when a filter is what emptied the
              // table — it reads as data loss rather than as a narrow search.
              <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">
                {profiles.length === 0 ? 'No profiles yet' : 'Nobody matches these filters'}
              </td></tr>
            ) : visibleProfiles.map((p) => (
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
                {/* Date AND time, 12-hour per the portal convention — "last
                    updated" is only useful if you can tell two edits apart on
                    the same day. */}
                <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-600">
                  {lastUpdatedAt(p) ? formatDateTime12(lastUpdatedAt(p)) : <span className="text-gray-400">-</span>}
                </td>
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
        ) : visibleProfiles.length === 0 ? (
          <div className="bg-white shadow rounded-xl p-6 text-center text-gray-500">
            {profiles.length === 0 ? 'No profiles yet' : 'Nobody matches these filters'}
          </div>
        ) : visibleProfiles.map((p) => (
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
            {lastUpdatedAt(p) && (
              <div className="mt-2 text-[11px] text-gray-400">Updated {formatDateTime12(lastUpdatedAt(p))}</div>
            )}
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
                      ? allUsers
                      : usersWithoutProfile
                    ).map((u) => (
                      <option key={u._id} value={u._id}>
                        {u.firstName} {u.lastName} · {u.email}
                        {u.role !== 'Employee' ? ` · ${u.role}` : ''}
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

                {/* Role — the login account's, not the profile's. Edit-only:
                    creating picks an existing account that already has one. */}
                {editingId && (
                  <div>
                    <label className="block text-sm text-gray-700">Role</label>
                    {canSetRole ? (
                      <>
                        <select
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value)}
                          className="mt-1 block w-full border rounded-lg px-3 py-2"
                        >
                          {/* A role already on the account but not assignable here
                              (a CEO who somehow has a profile) still has to be
                              shown, or opening the form would silently demote them. */}
                          {(ASSIGNABLE_ROLES.includes(roleAtOpen.current)
                            ? ASSIGNABLE_ROLES
                            : [roleAtOpen.current, ...ASSIGNABLE_ROLES]
                          ).map((r) => <option key={r} value={r}>{roleLabel(r)}</option>)}
                        </select>
                        <p className="text-[11px] text-gray-400 mt-1">
                          What they can reach in the app. Saved on the login account.
                          {editRole !== 'Employee' && editRole !== roleAtOpen.current && (
                            <span className="text-amber-700"> Grants admin access — set what they may do under Permissions.</span>
                          )}
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="mt-1 block w-full border rounded-lg px-3 py-2 bg-gray-50 text-gray-500">
                          {roleLabel(editRole)}
                        </div>
                        <p className="text-[11px] text-gray-400 mt-1">Only the Backend account can change a role.</p>
                      </>
                    )}
                  </div>
                )}
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
                    {visibleWorkLocations.map((l) => (
                      <option key={l._id} value={l._id}>{l.name}{l.company?.name ? ` · ${l.company.name}` : ''}</option>
                    ))}
                  </SearchableSelect>
                  {form.company && <p className="text-xs text-gray-400 mt-1">Showing sites for the selected company, plus shared sites.</p>}
                </div>
                <div>
                  <label className="block text-sm text-gray-700">Company</label>
                  <SearchableSelect value={form.company || ''} onChange={(e) => {
                    const company = e.target.value;
                    setForm((prev) => {
                      const next = { ...prev, company };
                      // Drop a work site that no longer belongs to the new company.
                      const site = workLocations.find((l) => String(l._id) === String(prev.workLocationRef));
                      if (site && !siteMatchesCompany(site, company)) next.workLocationRef = '';
                      return next;
                    });
                  }}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Unassigned</option>
                    {companies.filter((c) => c.isActive !== false).map((c) => (
                      <option key={c._id} value={c._id}>{c.name}{c.code ? ` (${c.code})` : ''}</option>
                    ))}
                  </SearchableSelect>
                  <p className="text-xs text-gray-500 mt-1">The company this employee belongs to. A CEO/MD limited to certain companies only sees people in them.</p>
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
                {/* HR Partner: the HR Manager who owns this employee. With per-HR
                    scoping on, an HR Manager sees and manages only the employees
                    they partner. Backend-only, like the reporting manager. */}
                <div className="sm:col-span-2">
                  <label className="block text-sm text-gray-700">HR Partner</label>
                  {isSuperAdmin ? (
                    <SearchableSelect
                      value={form.hrPartner || ''}
                      onChange={(e) => setForm({ ...form, hrPartner: e.target.value })}
                      className="mt-1 block w-full border rounded-lg px-3 py-2"
                    >
                      <option value="">None</option>
                      {hrUsers.map((u) => (
                        <option key={u._id} value={u._id}>
                          {u.firstName} {u.lastName} ({u.role}) · {u.email}
                        </option>
                      ))}
                    </SearchableSelect>
                  ) : (
                    <div className="mt-1 block w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-700 text-sm">
                      {(() => {
                        const hr = hrUsers.find((u) => u._id === (form.hrPartner?._id || form.hrPartner));
                        return hr ? `${hr.firstName} ${hr.lastName} (${hr.role})` : '—';
                      })()}
                    </div>
                  )}
                  <p className="text-xs text-gray-500 mt-1">The HR Manager who sees and manages this employee. Only the Backend can change it.</p>
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

      {/* ---------------- Import review ---------------- */}
      {showFlags && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl">
            <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-gray-100">
              <div>
                <h2 className="card-title">Imported values to check</h2>
                <p className="text-xs text-gray-500 mt-1 max-w-2xl leading-relaxed">
                  An import never refuses a row for naming something new. Anything that is simply a name — a designation,
                  department, grade, work location or company — was created. Anything that could not be invented — a role,
                  a salary structure, a named person — was left at its safe default. Correct what is wrong; leave the box
                  empty to say the import got it right.
                </p>
              </div>
              <button type="button" onClick={() => setShowFlags(false)} aria-label="Close"
                className="text-gray-400 hover:text-gray-700 text-xl leading-none shrink-0">×</button>
            </div>

            <div className="px-6 py-4 max-h-[60vh] overflow-y-auto space-y-3">
              {flags.length === 0 ? (
                <div className="text-center py-10">
                  <p className="text-sm font-medium text-gray-700">Nothing to check</p>
                  <p className="text-xs text-gray-500 mt-1">Every imported value has been dealt with.</p>
                </div>
              ) : flags.map((f) => {
                const person = `${f.user?.firstName || ''} ${f.user?.lastName || ''}`.trim()
                  || f.employee?.employeeCode || 'Employee';
                // Suggestions for the correction box. A datalist rather than a
                // hard dropdown on purpose: the value being flagged is by
                // definition one the lists did not have, so free text has to stay.
                const listId = `flagopts-${f._id}`;
                const suggestions = f.field === 'role' ? ROLE_OPTIONS
                  : f.field === 'designation' ? designations
                    : f.field === 'company' ? companies.map((c) => c.name)
                      : f.field === 'workLocation' ? workLocations.map((w) => w.name)
                        : ['reportingManager', 'hrPartner'].includes(f.field)
                          ? allUsers.map((u) => u.email).filter(Boolean)
                          : [];
                return (
                  <div key={f._id} className="border border-gray-200 rounded-xl p-4">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-900">{person}</span>
                      {f.employee?.employeeCode && (
                        <span className="text-xs text-gray-500">{f.employee.employeeCode}</span>
                      )}
                      <span className="text-[11px] px-2 py-0.5 rounded-md border bg-gray-50 text-gray-600 border-gray-200">
                        {FLAG_LABELS[f.field] || f.field}
                      </span>
                      {/* "Created" and "left blank" are different outcomes and
                          need different urgency, so they are different chips. */}
                      <span className={`text-[11px] px-2 py-0.5 rounded-md border ${
                        f.action === 'created'
                          ? 'bg-sky-50 text-sky-700 border-sky-200'
                          : 'bg-amber-50 text-amber-800 border-amber-200'}`}>
                        {f.action === 'created' ? 'Created' : 'Not applied'}
                      </span>
                      {f.excelRow ? <span className="text-[11px] text-gray-400">row {f.excelRow}</span> : null}
                    </div>

                    <p className="text-xs text-gray-600 leading-relaxed">{f.note}</p>

                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      <input
                        list={suggestions.length ? listId : undefined}
                        value={flagEdits[f._id] ?? ''}
                        onChange={(e) => setFlagEdits((s) => ({ ...s, [f._id]: e.target.value }))}
                        placeholder={PLACEHOLDERS[f.field] || `Correct value (was “${f.rawValue || '—'}”)`}
                        className="flex-1 min-w-[14rem] border rounded-lg px-3 py-2 text-sm"
                      />
                      {suggestions.length > 0 && (
                        <datalist id={listId}>
                          {suggestions.slice(0, 200).map((s) => <option key={s} value={s} />)}
                        </datalist>
                      )}
                      <button
                        type="button"
                        disabled={flagBusy === f._id}
                        onClick={() => resolveFlag(f)}
                        className="px-3.5 py-2 text-sm rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50 shrink-0"
                      >
                        {flagBusy === f._id ? 'Saving…'
                          : (flagEdits[f._id] || '').trim() ? 'Save & clear' : 'Looks right'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end px-6 py-4 border-t border-gray-100">
              <button type="button" onClick={() => setShowFlags(false)}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">Close</button>
            </div>
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
                  A row is never refused for naming something new. A new <strong>Designation</strong>, <strong>Department</strong>,{' '}
                  <strong>Grade</strong>, <strong>Work Location</strong> or <strong>Company</strong> is created and flagged for review.
                  A <strong>Role</strong> that is not a system role imports as Employee; an unmatched{' '}
                  <strong>Salary Structure</strong>, <strong>Reporting Manager Email</strong> or <strong>HR Partner Email</strong>{' '}
                  is left blank. All of them are flagged so you can correct them afterwards.
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
                        {/* Kept as its own tile: an error is a row that did NOT
                            import, which is a different thing from a flag. */}
                      </div>
                    </div>

                    {importResult.createdCount > 0 && (
                      <p className="text-sm text-gray-700">
                        Default password for newly-created accounts: <code className="bg-gray-100 px-1 py-0.5 rounded">{importResult.defaultPassword}</code> · communicate this to the employees so they can sign in and change it.
                      </p>
                    )}

                    {/* Values this upload had to invent or could not honour.
                        The rows are already in — this is the follow-up. */}
                    {importResult.flagCount > 0 && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5">
                        <div className="text-sm font-medium text-amber-900">
                          {importResult.flagCount === 1
                            ? '1 value needs a check'
                            : `${importResult.flagCount} values need a check`}
                        </div>
                        <p className="text-xs text-amber-800 mt-0.5">
                          New designations, departments and companies were created; roles and people that could not be
                          matched were left at their safe default. HR, the admins and the CEO/MD have been notified.
                        </p>
                        <button
                          type="button"
                          onClick={() => { closeImport(); setShowFlags(true); }}
                          className="mt-2 px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs hover:bg-amber-700"
                        >
                          Review them now
                        </button>
                      </div>
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
