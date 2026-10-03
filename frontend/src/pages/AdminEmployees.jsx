/**
 * AdminEmployees — employee HR-profile management (admin portal). Lists profiles
 * from GET /employees (with document-completeness status), creates/edits/deletes
 * via /employees, imports/exports via Excel/ZIP (/employees/import, /export*),
 * generates per-employee document-submission links (POST /employees/:id/doc-link),
 * and (SuperAdmin) activates accounts + toggles the include-executives org setting.
 *
 * 2026-10-03 premium pass (presentation only): KPI strip, one toolbar, and the
 * directory as rich rows that re-flow by the list's own width. Styling: `.emp-*`
 * in styles/pages/employees.css.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import {
  FiSearch, FiX, FiPlus, FiDownload, FiArchive, FiFile, FiUpload, FiEdit2, FiTrash2, FiUserX, FiUserCheck,
  FiLock, FiUsers, FiFileText, FiCreditCard, FiClock, FiAlertTriangle, FiFilter, FiArrowUp, FiArrowDown,
  FiCheck, FiCopy, FiMail, FiUser, FiShield, FiEye, FiCheckCircle, FiAlertCircle, FiSkipForward,
} from 'react-icons/fi';
import '../styles/pages/employees.css';
import api from '../api/client';
import { downloadFile } from '../api/download';
import { useAuthStore } from '../store/authStore';
import PageHeader from '../components/PageHeader';
import { useTabParam } from '../hooks/useTabParam';
import { useViewOnly } from '../hooks/useViewOnly';
import DesignationSelect from '../components/DesignationSelect';
import DepartmentSelect from '../components/DepartmentSelect';
import { confirmDialog, promptDialog } from '../components/dialogs';
import MailComposeModal from '../components/MailComposeModal';
import SearchableSelect from '../components/SearchableSelect';
import ToggleSwitch from '../components/ToggleSwitch';
import { PersonAvatar } from '../components/permissions/permUi';
import { peopleOptions, hasLeft, peopleOptionList } from '../utils/peopleOptions';
import { ROLES, roleLabel } from '../config/roles';
import { canAdministerEmployee, hasExplicitPermission, isEditingExec } from '../config/permissions';
import { formatDateTime12, toYMD } from '../utils/time';
import { docLabel } from '../utils/docCategories';

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
  shift: 'Shift',
  reportingManager: 'Reporting manager',
  hrPartner: 'HR partner',
};

// What to type in the correction box — an email for the two person fields, a
// name for everything else. Saying so beats a reviewer guessing and failing.
const PLACEHOLDERS = {
  reportingManager: 'Their manager’s email address',
  hrPartner: 'The HR partner’s email address',
  salaryStructure: 'An existing salary structure name',
  shift: 'An existing shift name',
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

// The four bank fields a salary transfer needs. Branch and account type are on
// the form too, but they are not what decides whether HR can pay somebody, so
// they do not count against "complete".
const BANK_REQUIRED = [
  ['accountNumber', 'account number'],
  ['ifsc', 'IFSC'],
  ['accountHolderName', 'account holder'],
  ['bankName', 'bank name'],
];

/**
 * Whether an employee's bank details are there to pay them with — the Bank
 * column, its sort, its filter and the phone card all read this one answer.
 * `rank` orders the column: 0 nothing added, 1 partly filled, 2 complete.
 * `summary` is "HDFC Bank · ••4455": the account number is masked to its last
 * four, enough to recognise it in a list, not enough to use it.
 * @param {object} p - an EmployeeProfile row from GET /employees
 * @returns {{rank: number, missing: string[], summary: string}}
 */
function bankState(p) {
  const b = p.bankDetails || {};
  const missing = BANK_REQUIRED.filter(([k]) => !String(b[k] ?? '').trim()).map(([, label]) => label);
  const acct = String(b.accountNumber || '').replace(/\s+/g, '');
  const summary = [String(b.bankName || '').trim(), acct ? `••${acct.slice(-4)}` : ''].filter(Boolean).join(' · ');
  const rank = missing.length === 0 ? 2 : missing.length === BANK_REQUIRED.length ? 0 : 1;
  return { rank, missing, summary };
}

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
  bank: { label: 'Bank details', type: 'num', get: (p) => bankState(p).rank },
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
 * A column label you can click to sort by (the list's header strip, wide
 * screens only — narrower layouts sort from the toolbar's Sort select).
 *
 * The arrow shows only on the active column — an arrow on every header tells you
 * nothing about which one is in force. `aria-sort` on the header cell (see
 * `ariaSort` below) carries the same fact to a screen reader.
 */
function SortHeader({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      title={`Sort by ${label.toLowerCase()}`}
      className={`emp-sort${active ? ' is-on' : ''}`}
    >
      {label}
      <span className="emp-sort-arrow" aria-hidden="true">
        {active && sort.dir === 'asc' ? <FiArrowUp size={11} /> : <FiArrowDown size={11} />}
      </span>
    </button>
  );
}

/** `aria-sort` for a header cell holding one or more of the sort keys. */
const ariaSort = (sort, ...keys) => (
  keys.includes(sort.key) ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
);

/** "03 Oct 2026, 2:15 PM" → ['03 Oct 2026', '2:15 PM'], so a cell can stack them. */
const whenParts = (d) => {
  const s = formatDateTime12(d);
  const i = s.lastIndexOf(', ');
  return i > 0 ? [s.slice(0, i), s.slice(i + 2)] : [s, ''];
};

export default function AdminEmployees() {
  // A view-only account reads the directory and edits nobody. Template and the
  // Excel export stay — both are reads.
  const viewOnly = useViewOnly();
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const isSuperAdmin = currentUser?.role === 'SuperAdmin';
  // Reporting manager, HR partner and the regularization ladder: Backend by
  // default, or anyone a Super Admin has granted the permission to. Mirrors
  // canSetHierarchy on the server, so a field is never offered where the save
  // would silently drop it.
  // hasExplicitPermission, not hasPermission: the latter hands an unconfigured
  // HR Manager every capability and a read-only exec every capability, neither of
  // which the server agrees with here — they would be offered a picker whose
  // value the save silently drops.
  const canSetHierarchy = hasExplicitPermission(currentUser, 'hierarchy.manage');
  // Assigning WHO LOOKS AFTER an employee — their HR partner and reporting
  // manager — is different from configuring an approver ladder, and an HR
  // Manager may do it without any grant. Mirrors canAssignPeople in the
  // backend's employeeController; `canSetHierarchy` above still governs the
  // regularization ladder alone.
  const canAssignPeople = canSetHierarchy || currentUser?.role === 'HRManager';
  // …but FILLING A BLANK is not reassigning. An employee with no HR partner is
  // in nobody's care and one with no reporting manager has nobody to approve
  // their leave, so any admin who can edit the record may close those gaps —
  // and only changing a field that already names somebody needs the grant.
  // Mirrors canFillHierarchyField in the backend's employeeController, and like
  // it answers on the STORED value, not on what the form currently shows.
  // The reporting manager / HR partner the record being edited ALREADY had.
  // Blank for a new employee, which is what lets both be set on create.
  //
  // Declared HERE, above the two derived flags below, and not with the rest of
  // the modal state further down: `canSetHrPartner` is evaluated on every
  // render, so a `const` declared after it puts this in the temporal dead zone
  // and the whole page throws "Cannot access 'storedHierarchy' before
  // initialization" before it paints.
  const [storedHierarchy, setStoredHierarchy] = useState({ hrPartner: '', reportingManager: '' });
  const canFillHierarchy = (field) => canAssignPeople || !storedHierarchy[field];
  const canSetHrPartner = canFillHierarchy('hrPartner');
  const canSetReportingManager = canFillHierarchy('reportingManager');
  // Moving somebody between companies stays with the Backend and an executive
  // in edit mode. An HR Manager works inside one company - and the company is
  // what every scoping wall is built on - so the field is hidden from them
  // rather than shown read-only: there is nothing for them to decide.
  const canSetCompany = isSuperAdmin || isEditingExec(currentUser);
  // Correcting an import flag writes the same field the form writes, so it
  // answers to the same grant. An import run without the grant deliberately
  // flags the relationship columns it ignored — so without this the flag would
  // be a text box that always ends in a 403. The flag still shows; it is the
  // record of what the sheet said, and it can still be marked as seen.
  const canFixFlagField = (field) => {
    // The relationship flags are raised BECAUSE the import could not set the
    // field, so what is being corrected is almost always an empty one — which
    // any admin may now fill (see canFillHierarchy). The flag row does not carry
    // the employee's current partner, so the decision is left to the server: it
    // fills a blank and refuses a reassignment with a message the operator sees.
    if (field === 'company') return canSetCompany;
    return true;
  };
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
  const [hrUsers, setHrUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [workLocations, setWorkLocations] = useState([]);
  // Only the names — this list exists solely to suggest values in the import
  // review box, so a shift with no hours set is still a legitimate suggestion.
  const [shiftNames, setShiftNames] = useState([]);
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
  // The editable draft for "Email link". Null = closed.
  const [mail, setMail] = useState(null);
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

  /**
   * Merge fields into ONE row of the directory.
   *
   * The alternative, calling load(), fires seven requests and blanks a table of
   * hundreds to change one flag the click already told us. (Seven is the real
   * count — keep it honest if a request is ever added or removed below.)
   */
  const patchProfile = (id, patch) => setProfiles(
    (rows) => rows.map((r) => (String(r._id) === String(id) ? { ...r, ...patch } : r))
  );

  // Load everything the page needs together: profiles, the user list (for the
  // account + manager pickers), doc-completeness, designations and work locations.
  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [profilesRes, allUsersRes, docRes, desigRes, wlRes, companiesRes, shiftsRes] = await Promise.all([
        api.get('/employees'),
        // One directory call, not two: the Employee-only slice used to be fetched
        // alongside this one and never read, so every mount and every reload
        // downloaded the whole Employee list for nothing.
        api.get('/admin/users'),
        api.get('/employees/documents-status'),
        api.get('/org-masters?kind=Designation'),
        api.get('/work-locations').catch(() => ({ data: { locations: [] } })),
        api.get('/companies').catch(() => ({ data: { companies: [] } })),
        api.get('/shifts').catch(() => ({ data: { shifts: [] } })),
      ]);
      setProfiles(profilesRes.data.profiles);
      setAllUsers(allUsersRes.data.users);
      setHrUsers(allUsersRes.data.users.filter(
        (u) => u.role === 'HRManager' || u.role === 'SuperAdmin'
      ));
      setWorkLocations(wlRes.data.locations || []);
      setCompanies(companiesRes.data.companies || []);
      setShiftNames((shiftsRes.data.shifts || []).map((sh) => sh.name).filter(Boolean));
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

    // `hasLeft` is asked of the PROFILE, before it is mapped to its user: the
    // user object inside a profile row carries `isActive` but no exit date, so
    // asked afterwards (in `stays` below) it let through somebody whose last
    // working day had passed on a login not yet switched off.
    const sameDept = form.department
      ? profiles
        .filter((p) => p.department === form.department && p.user && String(p.user._id) !== selfId
          && (!hasLeft(p) || String(p.user._id) === currentId))
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

    // Anyone who has left is not offered as a manager at all — not in the
    // visible groups and not in the searchable tail (see utils/peopleOptions).
    // The manager already SAVED on this record is the one exception: dropping
    // them would make the field read as unset and the next save would clear it.
    const stays = (u) => !hasLeft(u) || String(u._id) === currentId;

    return {
      sameDept: sameDept.filter(stays),
      executives: executives.filter(stays),
      current,
      others: others.filter(stays),
    };
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
    // A new record holds nothing yet, so both relationship fields are fillable.
    setStoredHierarchy({ hrPartner: '', reportingManager: '' });
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
    // What the record ALREADY holds, kept apart from `form` so the "this field
    // was blank" rule below cannot be defeated by clearing the picker first —
    // the server answers on the stored value for exactly the same reason.
    setStoredHierarchy({
      hrPartner: p.hrPartner?._id || p.hrPartner || '',
      reportingManager: p.reportingManager?._id || p.reportingManager || '',
    });
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

  /**
   * Email the submission link to the employee, from the company mailbox.
   *
   * Replaces a `mailto:` anchor, which produced a fixed one-line message from
   * whatever mail client the browser happened to open, was never recorded, and
   * ignored the wording HR had set in Settings -> Templates. The server drafts
   * it (listing the documents still outstanding), HR edits it here, and the
   * server sends and stamps it.
   */
  const emailDocLink = async () => {
    if (!editingId) return;
    setDocBusy(true);
    try {
      const { data } = await api.post(`/employees/${editingId}/documents/email`, { preview: true });
      // The token is minted by the preview when it did not exist, so the link
      // box below fills in without a second round trip.
      if (data.link) setDocToken(data.link.split('/').pop());
      setMail({
        to: data.to,
        title: 'Email document submission link',
        link: data.link,
        sendLabel: 'Send link',
        note: "Review and edit the message before it is sent.",
        defaultSubject: data.subject,
        defaultBody: data.body,
        showCc: true,
        onSend: async ({ subject, body, cc }) => {
          await api.post(`/employees/${editingId}/documents/email`, { subject, body, cc });
          toast.success('Document link emailed');
        },
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not prepare the document email');
    } finally {
      setDocBusy(false);
    }
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
      // `form` is seeded by spreading the whole stored profile, so it carries the
      // leave ladder as well — which this modal does not show and cannot edit
      // (it lives on Permissions → Leave approvals). Sending it back unchanged only
      // ever asks the server to re-validate a field nobody touched, so drop it.
      delete payload.leaveApprovers;
      delete payload.leaveFinalHrRecipients;
      // Company: '' → null so an empty select clears it rather than sending a bad ObjectId.
      // Without the grant the field is not shown at all, so sending it could only
      // ever clear a company nobody meant to touch.
      if (canSetCompany) payload.company = form.company || null;
      else delete payload.company;
      // The server ignores these without the grant, but strip them here too so a
      // blank never clobbers an existing assignment through some other path.
      // '' → null on the way out: an empty select must clear the ref rather than
      // send a string Mongo cannot cast.
      if (canSetHrPartner) payload.hrPartner = form.hrPartner || null;
      else delete payload.hrPartner;
      if (canSetReportingManager) payload.reportingManager = form.reportingManager || null;
      else delete payload.reportingManager;
      if (!canSetHierarchy) delete payload.regularizationApprovers;
      if (crossDept) payload.allowCrossDepartment = true;
      // Blank enums must be dropped, not sent as '' — the schema would reject it.
      if (!payload.gender) delete payload.gender;
      if (!payload.maritalStatus) delete payload.maritalStatus;
      // An empty date string is not a castable Date — drop it rather than send ''.
      if (!payload.dateOfMarriage) delete payload.dateOfMarriage;
      if (!payload.dateOfBirth) delete payload.dateOfBirth;
      let savedId = editingId;
      // HR's detail changes save straight away; the server tells the employee's
      // company CEO/MD what changed and says how many it told (0 for the
      // Backend's or an exec's own edits, which are not announced).
      let execsNotified = 0;
      if (editingId) {
        const { data } = await api.put(`/employees/${editingId}`, payload);
        execsNotified = data.execsNotified || 0;
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
      // The role rides along in the same call. It is SuperAdmin-only, and the
      // server refuses outright if this admin may not grant it.
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
            execsNotified = Math.max(execsNotified, uData?.execsNotified || 0);
            phoneAtOpen.current = editPhone;
            if (emailChanged) {
              emailAtOpen.current = editEmail.trim();
              toast.success(`Sign-in email changed to ${editEmail.trim()}`);
            }
            if (roleChanged) {
              roleAtOpen.current = editRole;
              toast.success(`Role changed to ${roleLabel(editRole)}`);
            }
          } catch (err) {
            // Name the field that failed — "could not be updated" on its own
            // leaves you guessing which of the three the server refused.
            const field = roleChanged ? 'role' : emailChanged ? 'email' : 'phone number';
            toast.error(err.response?.data?.message || `Profile saved, but the ${field} could not be updated`);
          }
        }
      }
      if (execsNotified > 0) toast.info('Saved. The CEO/MD have been notified of the change — nothing for them to approve.');
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
      // Drop the row rather than refetching the directory to discover it is gone.
      setProfiles((rows) => rows.filter((r) => String(r._id) !== String(p._id)));
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
    // Patch the one row. `load()` here fired seven requests and blanked the
    // whole directory to change one boolean the click already told us.
    patchProfile(p._id, { user: { ...p.user, isActive: !active } });
    try {
      await api.patch(`/admin/users/${uid}/${active ? 'deactivate' : 'activate'}`);
    } catch (err) {
      patchProfile(p._id, { user: { ...p.user, isActive: active } }); // put it back
      toast.error(err.response?.data?.message || 'Could not update status');
    }
  };


  // Candidates for a NEW employee profile: anyone who can hold one and does not
  // already. Deliberately drawn from every user, not just role=Employee — a
  // Manager, HR Manager or Accounts Manager is an employee too and needs a
  // profile, and filtering to role=Employee made those accounts impossible to
  // convert once every plain Employee already had one.
  //
  // Memoised because it is a full-directory scan with a per-user profile lookup
  // inside it, and every keystroke in the editor modal calls
  // `setForm({ ...form })`, which re-renders this whole page.
  const usersWithoutProfile = useMemo(() => allUsers.filter(
    (u) => !PROFILE_INELIGIBLE_ROLES.includes(u.role) && !userHasProfile(u, profiles)
  ), [allUsers, profiles]);

  // Profile photos for the directory's avatars. GET /employees populates the
  // user without `photo`; the user directory loaded alongside it carries it, so
  // the row's avatar is a lookup, not another request for data.
  const photoOf = useMemo(
    () => new Map(allUsers.map((u) => [String(u._id), u.photo || null])),
    [allUsers]
  );

  // The <option> lists the editor modal's people pickers hand to
  // SearchableSelect. They are built here, not inline in the JSX, for the same
  // reason: typing one character into any field of the modal used to rebuild
  // ~500 option elements per picker, which SearchableSelect then re-flattened
  // into search text. Keyed on what the list actually depends on — note
  // `form.regularizationApprovers` and not the `chain` fallback used below,
  // because `form.regularizationApprovers || []` is a fresh array every render
  // and a memo keyed on it would never hit.
  // DATA, not <option> elements, and the placeholder is folded in as the first
  // entry. Both halves matter: SearchableSelect derives its list from whatever
  // it is given, and a children array — rebuilt every render because of the
  // placeholder sibling — defeated the memo inside it, so ~500 elements were
  // re-walked on every keystroke anywhere in this thirty-field modal.
  const accountOptions = useMemo(() => peopleOptionList(
    editingId ? allUsers : usersWithoutProfile,
    (u) => `${u.firstName} ${u.lastName} · ${u.email}${u.role !== 'Employee' ? ` · ${u.role}` : ''}`,
    { keep: [form.user?._id || form.user], lead: [{ value: '', label: 'Select a user…' }] },
  ), [allUsers, usersWithoutProfile, editingId, form.user]);

  // One list per ladder step. Also collapses what were three sequential
  // .filter() passes over the whole directory into a single predicate.
  const regApproverOptions = useMemo(() => {
    const chain = form.regularizationApprovers || [];
    const selfId = String(form.user?._id || form.user || '');
    const eligible = allUsers.filter((u) => !hasLeft(u) && String(u._id) !== selfId);
    return [0, 1].map((idx) => [
      { value: '', label: idx === 0 ? 'None — any HR reviewer decides' : 'None — one step only' },
      ...eligible
        .filter((u) => u._id === chain[idx] || !chain.includes(u._id))
        .map((u) => ({
          value: String(u._id),
          label: `${u.firstName} ${u.lastName} (${u.role}) · ${u.email}`,
        })),
    ]);
  }, [allUsers, form.user, form.regularizationApprovers]);

  // Shared cell renderers so the desktop table and the mobile card list stay
  // in sync.
  // ----- Directory search + filters -----
  // All client-side: the list is already fully loaded, so filtering here is
  // instant and needs no round trip. `query` is what has actually been applied;
  // `search` is what is in the box. They differ only between typing and
  // submitting, which is what makes the Search button mean something.
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState({ department: '', company: '', status: '', documents: '', bank: '' });
  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  // `key: ''` = leave the server's order alone (newest added first), which is
  // what the page has always shown — sorting is opt-in, not a new default.
  const [sort, setSort] = useState({ key: '', dir: 'asc' });
  const clearFilters = () => {
    setFilters({ department: '', company: '', status: '', documents: '', bank: '' });
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

  /**
   * WORKING vs EXITED (user decision, 2026-09-22).
   *
   * People who have left used to sit in the same list as everybody else, found
   * only by setting the status filter to Inactive — which is not the same
   * question: a resignation leaves the login working through the notice period,
   * so somebody can be Active and have walked out last week. That is exactly
   * the gap `hasLeft` exists to close (utils/peopleOptions, mirroring the
   * server's utils/departed), and it is the rule these two tabs split on.
   *
   * The status filter stays, and is still useful INSIDE the Exited tab: it
   * separates a leaver whose login is already off from one still inside their
   * notice period.
   */
  const [tab, setTab] = useTabParam('working', ['working', 'exited']);

  const exitedCount = useMemo(() => profiles.filter(hasLeft).length, [profiles]);

  // How many people the CURRENT tab holds — the denominator the row counter
  // under the filters measures against. Counting both tabs is what made the
  // Working tab read "45 of 50" with nothing filtered at all, contradicting the
  // tab pill directly above it, because "X of Y" is this page's way of saying a
  // filter is narrowing the list.
  const tabTotal = tab === 'exited' ? exitedCount : profiles.length - exitedCount;

  const visibleProfiles = useMemo(() => {
    const t = query.trim().toLowerCase();
    const matched = profiles.filter((p) => {
      if (hasLeft(p) !== (tab === 'exited')) return false;
      if (filters.department && p.department !== filters.department) return false;
      if (filters.company && p.company?.name !== filters.company) return false;
      if (filters.status && String(!!p.user?.isActive) !== filters.status) return false;
      if (filters.documents) {
        const s = docStatus[String(p._id)];
        const complete = !!s?.complete;
        if (filters.documents === 'complete' && !complete) return false;
        if (filters.documents === 'incomplete' && complete) return false;
      }
      // "Missing" is anything short of complete — partly filled cannot pay
      // anybody either, so it belongs in the list HR has to chase.
      if (filters.bank) {
        const complete = bankState(p).rank === 2;
        if (filters.bank === 'complete' && !complete) return false;
        if (filters.bank === 'missing' && complete) return false;
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
  }, [profiles, query, filters, docStatus, sort, tab]);

  // KPI strip, counted over the tab on screen — so the number on a card is what
  // its filter shows before any other filter narrows it. The tests are the same
  // ones the Documents and Bank filters apply above.
  const kpi = useMemo(() => {
    const weekAgo = Date.now() - 7 * 86400000;
    let docs = 0;
    let bank = 0;
    let recent = 0;
    for (const p of profiles) {
      if (hasLeft(p) !== (tab === 'exited')) continue;
      if (!docStatus[String(p._id)]?.complete) docs += 1;
      if (bankState(p).rank !== 2) bank += 1;
      if ((lastUpdatedAt(p)?.getTime() || 0) >= weekAgo) recent += 1;
    }
    return { docs, bank, recent };
  }, [profiles, docStatus, tab]);

  // What the employee declared instead of filing, in words. An experience letter
  // that is absent because they said it is their first job is a different fact
  // from one nobody has chased, and the badge should not read the same for both.
  const declaredNote = (s) => {
    const said = [];
    if (s?.declarations?.firstJob) said.push('first job — no experience letter');
    if (s?.declarations?.noOtherDocuments) said.push('no other documents');
    return said.length ? `Declared: ${said.join('; ')}` : '';
  };

  // Each chip carries an `emp-k` word ("Docs ·", "Bank ·") that the stylesheet
  // shows only where no column header says what the chip is about (the narrower
  // card layouts), so it cannot be mistaken for the chip beside it.
  const docBadge = (p) => {
    const s = docStatus[String(p._id)];
    if (!s) return <span className="emp-dash">-</span>;
    const declared = declaredNote(s);
    if (s.complete) {
      return (
        <span className="pb-tag is-in emp-tag"
          title={[s.verified ? 'Marked all-submitted by HR' : 'All required documents accounted for', declared].filter(Boolean).join(' · ')}>
          <FiFileText size={11} aria-hidden="true" />
          <span className="emp-k">Docs ·</span>
          Complete
          {s.verified && <FiCheck size={11} aria-label="verified" />}
        </span>
      );
    }
    return (
      <span className="pb-tag is-absent emp-tag"
        title={[`Missing: ${s.missing.map((c) => docLabel(c)).join(', ')}`, declared].filter(Boolean).join(' · ')}>
        <FiFileText size={11} aria-hidden="true" />
        <span className="emp-k">Docs ·</span>
        Incomplete
        <span className="emp-n">{s.missing.length}</span>
      </span>
    );
  };
  // Green complete, amber partly filled, red nothing at all — the last is the one
  // that stops a salary going out.
  const bankBadge = (p) => {
    const s = bankState(p);
    const [tone, text, title, n] = s.rank === 2
      ? ['is-in', 'Complete', `Bank details complete${s.summary ? ` · ${s.summary}` : ''}`, 0]
      : s.rank === 1
        ? ['is-late', 'Incomplete', `Missing: ${s.missing.join(', ')}`, s.missing.length]
        : ['is-absent', 'Not added', 'No bank details on record yet', 0];
    return (
      <span className={`pb-tag ${tone} emp-tag`} title={title}>
        <FiCreditCard size={11} aria-hidden="true" />
        <span className="emp-k">Bank ·</span>
        {text}
        {n > 0 && <span className="emp-n">{n}</span>}
      </span>
    );
  };
  const statusBadge = (p) =>
    String(p.user?._id || '') === myId ? (
      <span className="emp-dash">-</span>
    ) : (
      <span className={`rst-status emp-status${p.user?.isActive ? ' is-on' : ''}`}>
        {p.user?.isActive ? 'Active' : 'Inactive'}
      </span>
    );
  // Edit leads (the everyday verb); ZIP, activate/deactivate and delete are icon
  // buttons — same handlers and the same gates as the old text links. A Super
  // Admin's OWN row has no activate button, so a same-width spacer stands in for
  // it and the Edit buttons stay in one column down the list.
  const rowActions = (p) => {
    const own = String(p.user?._id || '') === myId;
    const active = !!p.user?.isActive;
    return (
      <>
        {canEditProfile(p) ? (
          <button type="button" onClick={() => openEdit(p)} className="trn-btn emp-edit">
            <FiEdit2 size={13} aria-hidden="true" /> Edit
          </button>
        ) : (
          <span className="trn-btn emp-edit is-locked" title={noEditReason(p)} aria-disabled="true">
            <FiLock size={12} aria-hidden="true" /> Edit
          </span>
        )}
        <button type="button"
          onClick={() => downloadFile(`/employees/${p._id}/export.zip`, `${p.employeeCode || 'employee'}.zip`)}
          className="trn-icon-btn emp-ib is-zip" title="Download all documents + details as a ZIP" aria-label="Download ZIP">
          <FiDownload size={15} />
        </button>
        {isSuperAdmin && !own && (
          <button type="button" onClick={() => toggleActive(p)}
            className={`trn-icon-btn emp-ib ${active ? 'is-warn' : 'is-ok'}`}
            title={active ? 'Deactivate' : 'Activate'} aria-label={active ? 'Deactivate' : 'Activate'}>
            {active ? <FiUserX size={15} /> : <FiUserCheck size={15} />}
          </button>
        )}
        {isSuperAdmin && own && <span className="emp-ib-ph" aria-hidden="true" />}
        {!viewOnly && (
          <button type="button" onClick={() => onDelete(p)} className="trn-icon-btn emp-ib is-danger"
            title="Delete" aria-label="Delete">
            <FiTrash2 size={15} />
          </button>
        )}
      </>
    );
  };
  // Icon buttons a row can hold — sizes the actions column so every row's
  // grid lines up (see --emp-n in employees.css).
  const actionSlots = 1 + (isSuperAdmin ? 1 : 0) + (viewOnly ? 0 : 1);

  // KPI cards that double as filters: a second click clears them again.
  const toggleKpiFilter = (key, value) => setFilter(key, filters[key] === value ? '' : value);

  // Skeletons on the FIRST load only: a reload after a save or an import keeps
  // the rows on screen rather than blanking the directory.
  const firstLoad = loading && profiles.length === 0;

  return (
    <div>
      <PageHeader title="Employee Profiles" subtitle={`${profiles.length} profile(s)`}>
        {/* The file actions as one joined group; Add Profile is the primary
            action beside it. */}
        <div className="emp-tools" role="group" aria-label="Excel and ZIP">
          <button
            type="button"
            onClick={() => downloadFile('/employees/export.xlsx', 'employees.xlsx')}
            className="emp-tool"
            title="Download all employees as an Excel file"
          >
            <FiDownload size={14} aria-hidden="true" /> Export Excel
          </button>
          {isSuperAdmin && (
            <button
              type="button"
              onClick={() => downloadFile('/employees/export-all.zip', 'all-employees.zip')}
              className="emp-tool"
              title="Download a ZIP of every employee's documents + details"
            >
              <FiArchive size={14} aria-hidden="true" /> Download All (ZIP)
            </button>
          )}
          <button
            type="button"
            onClick={() => downloadFile('/employees/template.xlsx', 'employee-import-template.xlsx')}
            className="emp-tool"
            title="Download the blank import template"
          >
            <FiFile size={14} aria-hidden="true" /> Template
          </button>
          {!viewOnly && (
            <button type="button" onClick={() => setShowImportModal(true)} className="emp-tool">
              <FiUpload size={14} aria-hidden="true" /> Import Excel
            </button>
          )}
        </div>
        {!viewOnly && (
          <button type="button" onClick={openCreate} className="trn-btn is-primary accent-bg text-white">
            <FiPlus size={15} aria-hidden="true" /> Add Profile
          </button>
        )}
      </PageHeader>

      {/* ── KPI strip ─────────────────────────────────────────
          Counted over the tab on screen. The two gaps HR chases (documents,
          bank) are buttons that set the same filters as the selects in the
          toolbar; a second click clears them. */}
      <div className="trn-kpis emp-kpis">
        <div className="trn-kpi" style={{ '--kpi-hue': tab === 'exited' ? '#64748b' : '#16a34a' }}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiUsers size={19} /></span>
          <span className="min-w-0">
            <span className="trn-kpi-value block">{firstLoad ? '—' : tabTotal}</span>
            <span className="trn-kpi-label block">{tab === 'exited' ? 'Exited' : 'Working'}</span>
            <span className="trn-kpi-sub block">
              {firstLoad ? '' : tab === 'exited' ? `${profiles.length - exitedCount} working` : `${exitedCount} exited`}
            </span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => toggleKpiFilter('documents', 'incomplete')}
          aria-pressed={filters.documents === 'incomplete'}
          className={`trn-kpi pb-kpi${filters.documents === 'incomplete' ? ' is-on' : ''}`}
          style={{ '--kpi-hue': '#dc2626' }}
          title="Show only incomplete documents"
        >
          <span className="trn-kpi-icon" aria-hidden="true"><FiFileText size={19} /></span>
          <span className="min-w-0">
            <span className="trn-kpi-value block">{firstLoad ? '—' : kpi.docs}</span>
            <span className="trn-kpi-label block">Docs incomplete</span>
            <span className="trn-kpi-sub block">{firstLoad ? '' : `${tabTotal - kpi.docs} complete`}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => toggleKpiFilter('bank', 'missing')}
          aria-pressed={filters.bank === 'missing'}
          className={`trn-kpi pb-kpi${filters.bank === 'missing' ? ' is-on' : ''}`}
          style={{ '--kpi-hue': '#d97706' }}
          title="Show only missing bank details"
        >
          <span className="trn-kpi-icon" aria-hidden="true"><FiCreditCard size={19} /></span>
          <span className="min-w-0">
            <span className="trn-kpi-value block">{firstLoad ? '—' : kpi.bank}</span>
            <span className="trn-kpi-label block">Bank missing</span>
            <span className="trn-kpi-sub block">{firstLoad ? '' : `${tabTotal - kpi.bank} complete`}</span>
          </span>
        </button>
        <div className="trn-kpi" style={{ '--kpi-hue': '#6366f1' }}>
          <span className="trn-kpi-icon" aria-hidden="true"><FiClock size={19} /></span>
          <span className="min-w-0">
            <span className="trn-kpi-value block">{firstLoad ? '—' : kpi.recent}</span>
            <span className="trn-kpi-label block">Updated recently</span>
            <span className="trn-kpi-sub block">Last 7 days</span>
          </span>
        </div>
      </div>

      {(flags.length > 0 || isSuperAdmin) && (
        <div className="emp-strip">
          {/* An import never refuses a row for naming something new — it
              creates what it safely can and says so here. Amber, not red:
              nothing is broken, but somebody should look. */}
          {flags.length > 0 && (
            <div className="emp-notice">
              <span className="emp-ico" style={{ '--hue': '#d97706' }} aria-hidden="true"><FiAlertTriangle size={16} /></span>
              <span className="emp-notice-text">
                {flags.length === 1
                  ? 'One imported value needs a check'
                  : `${flags.length} imported values need a check`}
              </span>
              {!viewOnly && (
                <button type="button" onClick={() => setShowFlags(true)} className="trn-btn emp-amber">
                  Review
                </button>
              )}
            </div>
          )}

          {/* SuperAdmin-only org preference, as a setting row. */}
          {isSuperAdmin && (
            <div className="emp-setting">
              <span className="emp-ico" aria-hidden="true"><FiEye size={16} /></span>
              <span className="emp-setting-text" title="When off, CEO and MD are hidden from employee pick-lists.">
                Include CEO &amp; MD in employee selection lists
              </span>
              <ToggleSwitch
                checked={execIncluded}
                onChange={toggleExecIncluded}
                busy={execBusy}
                label="Include CEO & MD in employee selection lists"
                title={execIncluded ? 'CEO & MD are shown in employee lists' : 'CEO & MD are hidden from employee lists'}
              />
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2.5 rounded-xl">{error}</div>
      )}

      {/* ── One toolbar: Working · Exited, search, then filters + sort ── */}
      <div className="pb-toolbar emp-toolbar">
        {/* Working vs Exited — paint-only selection, so picking one never
            re-measures the strip. */}
        <div className="trn-seg" role="tablist" aria-label="Show">
          {[
            ['working', 'Working', profiles.length - exitedCount],
            ['exited', 'Exited', exitedCount],
          ].map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`trn-seg-btn${tab === key ? ' is-on' : ''}`}
            >
              {label} <span className="trn-seg-count">{count}</span>
            </button>
          ))}
        </div>

        {/* A real form, so Enter submits and the button is not decoration. */}
        <form
          onSubmit={(e) => { e.preventDefault(); setQuery(search); }}
          className="pb-toolbar-end emp-search"
        >
          <label className="trn-search">
            <FiSearch size={15} className="opacity-50 shrink-0" aria-hidden="true" />
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
            />
            {search && (
              <button type="button" onClick={() => { setSearch(''); setQuery(''); }}
                aria-label="Clear search" className="emp-clear">
                <FiX size={14} />
              </button>
            )}
          </label>
          <button type="submit" className="trn-btn">Search</button>
        </form>

        <div className="emp-filters">
          <FiFilter size={14} className="emp-filters-ico" aria-hidden="true" />
          <select value={filters.department} onChange={(e) => setFilter('department', e.target.value)}
            aria-label="Filter by department" className="trn-select">
            <option value="">All departments</option>
            {departmentOptions.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>

          {companyOptions.length > 1 && (
            <select value={filters.company} onChange={(e) => setFilter('company', e.target.value)}
              aria-label="Filter by company" className="trn-select">
              <option value="">All companies</option>
              {companyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}

          <select value={filters.status} onChange={(e) => setFilter('status', e.target.value)}
            aria-label="Filter by status" className="trn-select">
            <option value="">Any status</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </select>

          <select value={filters.documents} onChange={(e) => setFilter('documents', e.target.value)}
            aria-label="Filter by document completeness" className="trn-select">
            <option value="">Any documents</option>
            <option value="complete">Documents complete</option>
            <option value="incomplete">Documents incomplete</option>
          </select>

          <select value={filters.bank} onChange={(e) => setFilter('bank', e.target.value)}
            aria-label="Filter by bank details" className="trn-select">
            <option value="">Any bank details</option>
            <option value="complete">Bank details complete</option>
            <option value="missing">Bank details missing</option>
          </select>

          {/* The same sort the column headers drive. It lives here as well
              because the narrower layouts are cards with no headers to click
              — without this, sorting would be wide-screen-only. */}
          <select
            value={sort.key ? `${sort.key}:${sort.dir}` : ''}
            onChange={(e) => {
              const [key, dir] = e.target.value.split(':');
              setSort(key ? { key, dir } : { key: '', dir: 'asc' });
            }}
            aria-label="Sort by"
            className="trn-select"
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
            <option value="bank:asc">Bank details — missing first</option>
            <option value="status:asc">Status — inactive first</option>
          </select>

          <div className="emp-filters-end">
            {activeFilterCount > 0 && (
              <button type="button" onClick={clearFilters} className="emp-clear-btn">
                Clear {activeFilterCount === 1 ? 'filter' : 'filters'}
              </button>
            )}
            <span className="emp-count">
              {loading ? 'Loading…'
                : visibleProfiles.length === tabTotal
                  ? `${tabTotal} ${tabTotal === 1 ? 'profile' : 'profiles'}`
                  : `${visibleProfiles.length} of ${tabTotal}`}
            </span>
          </div>
        </div>
      </div>

      {/* ── The directory: one rich row per person ────────────
          One markup, three layouts chosen by the list's OWN width (container
          queries in employees.css): wide = aligned columns under a sortable
          header strip; medium = who | chips | actions; narrow = a stacked
          card. The whole row opens the employee; the actions cell stops the
          click so Edit / ZIP / Delete still do their own thing. */}
      <div className="emp-wrap" style={{ '--emp-n': actionSlots }}>
        <div className="emp-list" role="table" aria-label="Employee profiles">
          <div className="emp-head" role="row">
            <div className="emp-h" role="columnheader" aria-sort={ariaSort(sort, 'name', 'code')}>
              <SortHeader label="Name" sortKey="name" sort={sort} onSort={toggleSort} />
              <SortHeader label="Code" sortKey="code" sort={sort} onSort={toggleSort} />
            </div>
            <div className="emp-h" role="columnheader" aria-sort={ariaSort(sort, 'designation')}>
              <SortHeader label="Designation" sortKey="designation" sort={sort} onSort={toggleSort} />
            </div>
            {/* PAN is an identifier nobody scans in order — no sort. */}
            <div className="emp-h" role="columnheader"><span className="emp-h-plain">PAN</span></div>
            <div className="emp-h" role="columnheader" aria-sort={ariaSort(sort, 'documents')}>
              <SortHeader label="Documents" sortKey="documents" sort={sort} onSort={toggleSort} />
            </div>
            <div className="emp-h" role="columnheader" aria-sort={ariaSort(sort, 'bank')}>
              <SortHeader label="Bank" sortKey="bank" sort={sort} onSort={toggleSort} />
            </div>
            <div className="emp-h" role="columnheader" aria-sort={ariaSort(sort, 'status')}>
              <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />
            </div>
            <div className="emp-h" role="columnheader" aria-sort={ariaSort(sort, 'updated')}>
              <SortHeader label="Last update" sortKey="updated" sort={sort} onSort={toggleSort} />
            </div>
            <div className="emp-h is-end" role="columnheader"><span className="sr-only">Actions</span></div>
          </div>

          {firstLoad ? (
            [0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="emp-skel" aria-hidden="true">
                <span className="skeleton emp-skel-av" />
                <span className="emp-skel-lines">
                  <span className="skeleton emp-skel-l1" />
                  <span className="skeleton emp-skel-l2" />
                </span>
                <span className="skeleton emp-skel-chip" />
              </div>
            ))
          ) : visibleProfiles.length === 0 ? (
            // "No profiles yet" is wrong when a filter is what emptied the
            // list — it reads as data loss rather than as a narrow search.
            <div className="trn-empty">
              <span className="trn-empty-icon"><FiUsers size={24} /></span>
              <p className="text-sm font-semibold">
                {profiles.length === 0 ? 'No profiles yet' : 'Nobody matches these filters'}
              </p>
            </div>
          ) : visibleProfiles.map((p) => {
            // Date AND time, 12-hour per the portal convention — "last
            // updated" is only useful if you can tell two edits apart on the
            // same day.
            const updated = lastUpdatedAt(p);
            const [updDay, updTime] = updated ? whenParts(updated) : ['', ''];
            const bank = bankState(p);
            return (
              <div key={p._id} role="row" className="emp-row" onClick={() => navigate(`/admin/employees/${p._id}`)}>
                <div className="emp-c emp-c-who" role="cell">
                  <PersonAvatar user={{ ...p.user, photo: photoOf.get(String(p.user?._id || '')) }} />
                  <div className="min-w-0">
                    <div className="emp-name">
                      <span className="emp-name-text">{p.user?.firstName} {p.user?.lastName}</span>
                      {p.employeeCode && <span className="emp-code">{p.employeeCode}</span>}
                    </div>
                    <div className="emp-mail">{p.user?.email}</div>
                  </div>
                </div>
                <div className="emp-c emp-c-role" role="cell">
                  <span className="emp-desig">{p.designation || '-'}</span>
                  {p.department && <span className="emp-dept">{p.department}</span>}
                </div>
                {/* PAN, documents, bank, status and last update: their own
                    columns on a wide list, one wrapping chip row otherwise. */}
                <div className="emp-recs">
                  <div className={`emp-c emp-c-pan${p.pan ? '' : ' is-empty'}`} role="cell">
                    {p.pan
                      ? <span className="emp-pan"><span className="emp-k">PAN</span>{p.pan}</span>
                      : <span className="emp-dash">-</span>}
                  </div>
                  <div className="emp-c emp-c-docs" role="cell">{docBadge(p)}</div>
                  <div className="emp-c emp-c-bank" role="cell">
                    {bankBadge(p)}
                    {bank.summary ? <span className="emp-bank-sum" title={bank.summary}>{bank.summary}</span> : null}
                  </div>
                  <div className="emp-c emp-c-status" role="cell">{statusBadge(p)}</div>
                  <div className={`emp-c emp-c-when${updated ? '' : ' is-empty'}`} role="cell">
                    {updated ? (
                      <>
                        <span className="emp-k">Updated</span>
                        <span className="emp-when-d">{updDay}</span>
                        {updTime && <span className="emp-when-t">{updTime}</span>}
                      </>
                    ) : <span className="emp-dash">-</span>}
                  </div>
                </div>
                <div className="emp-c emp-c-act" role="cell" onClick={(e) => e.stopPropagation()}>
                  {rowActions(p)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl p-6">
            <div className="emp-modal-head">
              <h2 className="card-title">
                {editingId ? 'Edit Employee Profile' : 'Create Employee Profile'}
              </h2>
              <button type="button" onClick={() => setShowModal(false)} aria-label="Close" title="Close"
                className="topbar-icon-btn shrink-0">×</button>
            </div>
            <form onSubmit={onSave} className="space-y-3 emp-form">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="prm-label">User account *</label>
                  <SearchableSelect
                    required
                    disabled={!!editingId}
                    value={form.user}
                    onChange={(e) => setForm({ ...form, user: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 disabled:bg-gray-100"
                    options={accountOptions}
                  />
                </div>
                <div>
                  <label className="prm-label">Employee Code *</label>
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
                  <label className="prm-label">Date of Joining *</label>
                  <input
                    type="date" required
                    value={form.dateOfJoining}
                    onChange={(e) => setForm({ ...form, dateOfJoining: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2"
                  />
                </div>
                <div>
                  <label className="prm-label">Employment Type</label>
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
                    <label className="prm-label">Role</label>
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
                        {editRole !== 'Employee' && editRole !== roleAtOpen.current && (
                          <p className="text-[11px] text-amber-700 mt-1">Grants admin access.</p>
                        )}
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
                  <label className="prm-label">Designation</label>
                  <DesignationSelect
                    value={form.designation || ''}
                    onChange={(v) => setForm({ ...form, designation: v })}
                  />
                </div>
                <div>
                  <label className="prm-label">Department</label>
                  <DepartmentSelect
                    value={form.department || ''}
                    onChange={onDepartmentChange}
                  />
                </div>
                <div>
                  <label className="prm-label">Work location <span className="emp-label-note">(check-in geofence)</span></label>
                  <SearchableSelect value={form.workLocationRef || ''} onChange={(e) => setForm({ ...form, workLocationRef: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Default (office)</option>
                    {visibleWorkLocations.map((l) => (
                      <option key={l._id} value={l._id}>{l.name}{l.company?.name ? ` · ${l.company.name}` : ''}</option>
                    ))}
                  </SearchableSelect>
                </div>
                {canSetCompany && (
                <div>
                  <label className="prm-label">Company</label>
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
                </div>
                )}
                <div className="sm:col-span-2">
                  <label className="prm-label">Reporting Manager</label>
                  {canSetReportingManager ? (
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
                  {canSetReportingManager && !form.department && (
                    <p className="text-xs text-gray-500 mt-1">Pick a department first.</p>
                  )}
                  {!canSetReportingManager && (
                    <p className="text-xs text-gray-500 mt-1">Needs an HR Manager or Super Admin.</p>
                  )}
                </div>
                {/* HR Partner: the HR Manager who owns this employee. With per-HR
                    scoping on, an HR Manager sees the employees they partner PLUS
                    anyone still unpartnered. Setting a blank one is open to any
                    admin who can edit the record; CHANGING one that already names
                    somebody needs the hierarchy grant - handing an employee over
                    is not an ordinary edit. */}
                <div className="sm:col-span-2">
                  <label className="prm-label">HR Partner</label>
                  {canSetHrPartner ? (
                    <SearchableSelect
                      value={form.hrPartner || ''}
                      onChange={(e) => setForm({ ...form, hrPartner: e.target.value })}
                      className="mt-1 block w-full border rounded-lg px-3 py-2"
                    >
                      <option value="">None</option>
                      {peopleOptions(
                        hrUsers,
                        (u) => `${u.firstName} ${u.lastName} (${u.role}) · ${u.email}`,
                        { keep: [form.hrPartner?._id || form.hrPartner] },
                      )}
                    </SearchableSelect>
                  ) : (
                    <div className="mt-1 block w-full border rounded-lg px-3 py-2 bg-gray-100 text-gray-700 text-sm">
                      {(() => {
                        const hr = hrUsers.find((u) => u._id === (form.hrPartner?._id || form.hrPartner));
                        return hr ? `${hr.firstName} ${hr.lastName} (${hr.role})` : '—';
                      })()}
                    </div>
                  )}
                  {!canSetHrPartner && (
                    <p className="text-xs text-gray-500 mt-1">Needs an HR Manager or Super Admin.</p>
                  )}
                </div>
                {/* Attendance-regularization approval ladder: 1 or 2 named people,
                    in order. Deliberately separate from the reporting manager —
                    a correction is often signed off by a shift/ops lead. Step 2
                    only appears once step 1 is chosen, so the ladder can never be
                    configured with a gap. Behind the hierarchy grant, matching the backend. */}
                <div className="sm:col-span-2">
                  <label className="prm-label">Regularization approval</label>
                  {canSetHierarchy ? (
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
                              options={regApproverOptions[idx]}
                            />
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
                </div>
                <div className="sm:col-span-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={!!form.documentsVerified}
                      onChange={(e) => setForm({ ...form, documentsVerified: e.target.checked })} />
                    Documents verified · mark all documents as submitted
                  </label>
                </div>

                {/* Document submission link — send to the employee to collect any missing docs. */}
                {editingId && (
                  <div className="sm:col-span-2 emp-doclink">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="emp-doclink-title">
                        <FiFileText size={14} aria-hidden="true" /> Document submission link
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" onClick={copyDocLink} disabled={docBusy}
                          className="trn-btn emp-btn-sm">
                          <FiCopy size={13} aria-hidden="true" />
                          {docBusy ? 'Working…' : docCopied ? 'Copied!' : docToken ? 'Copy link' : 'Create & copy link'}
                        </button>
                        {editEmail && (
                          <button type="button" onClick={emailDocLink} disabled={docBusy}
                            title="Send the link from the company mailbox, with the outstanding documents listed"
                            className="trn-btn emp-btn-sm">
                            <FiMail size={13} aria-hidden="true" /> Email link
                          </button>
                        )}
                      </div>
                    </div>
                    {(() => {
                      const st = docStatus[editingId];
                      const miss = st?.missing || [];
                      const declared = declaredNote(st);
                      return miss.length > 0 ? (
                        <p className="text-xs text-amber-700 mt-1.5">
                          Missing: {miss.map((c) => docLabel(c)).join(', ')}.
                          {declared ? ` (${declared}.)` : ''}
                        </p>
                      ) : (
                        <p className="text-xs text-gray-500 mt-1.5">
                          All required documents are in.
                          {declared ? ` (${declared}.)` : ''}
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

              <h3 className="emp-sec"><FiUser size={14} aria-hidden="true" /> Personal &amp; Contact</h3>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="prm-label">Phone</label>
                  <input value={editPhone} onChange={(e) => setEditPhone(e.target.value)}
                    placeholder="10 digits" className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="prm-label">Email (login)</label>
                  <input type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)}
                    placeholder="name@company.com" className="mt-1 block w-full border rounded-lg px-3 py-2" />
                  <p className="text-[11px] text-amber-700 mt-1">Changing this changes how they sign in.</p>
                </div>
                <div>
                  <label className="prm-label">Date of Birth</label>
                  {/* max: a mistyped year like 2925 used to save without a word. */}
                  <input type="date" value={form.dateOfBirth || ''} max={toYMD(new Date())}
                    onChange={(e) => setForm({ ...form, dateOfBirth: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="prm-label">Gender</label>
                  <select value={form.gender || ''} onChange={(e) => setForm({ ...form, gender: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Not set</option>
                    {GENDERS.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </div>
                <div>
                  <label className="prm-label">Marital Status</label>
                  <select value={form.maritalStatus || ''} onChange={(e) => setForm({ ...form, maritalStatus: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2">
                    <option value="">Not set</option>
                    {MARITAL_STATUSES.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
                <div>
                  <label className="prm-label">Marriage Anniversary</label>
                  <input type="date" value={form.dateOfMarriage || ''} max={toYMD(new Date())}
                    onChange={(e) => setForm({ ...form, dateOfMarriage: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
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
                  <label className="prm-label">Emergency Contact</label>
                  <input value={form.emergencyContact?.name || ''} placeholder="Name"
                    onChange={(e) => setForm({ ...form, emergencyContact: { ...form.emergencyContact, name: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="prm-label">Relation</label>
                  <input value={form.emergencyContact?.relation || ''} placeholder="e.g. Father"
                    onChange={(e) => setForm({ ...form, emergencyContact: { ...form.emergencyContact, relation: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="prm-label">Contact Phone</label>
                  <input value={form.emergencyContact?.phone || ''} placeholder="10 digits"
                    onChange={(e) => setForm({ ...form, emergencyContact: { ...form.emergencyContact, phone: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <h3 className="emp-sec"><FiShield size={14} aria-hidden="true" /> Statutory IDs (India)</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="prm-label">PAN</label>
                  <input value={form.pan}
                    onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })}
                    placeholder="ABCDE1234F" maxLength={10}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono" />
                </div>
                <div>
                  <label className="prm-label">UAN</label>
                  <input value={form.uan}
                    onChange={(e) => setForm({ ...form, uan: e.target.value })}
                    placeholder="12 digits" maxLength={12}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono" />
                </div>
                <div>
                  <label className="prm-label">PF Number</label>
                  <input value={form.pfNumber}
                    onChange={(e) => setForm({ ...form, pfNumber: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="prm-label">ESIC Number</label>
                  <input value={form.esicNumber}
                    onChange={(e) => setForm({ ...form, esicNumber: e.target.value })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <h3 className="emp-sec"><FiCreditCard size={14} aria-hidden="true" /> Bank Details</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="prm-label">Account Holder</label>
                  <input value={form.bankDetails.accountHolderName}
                    onChange={(e) => setForm({ ...form, bankDetails: { ...form.bankDetails, accountHolderName: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="prm-label">Bank Name</label>
                  <input value={form.bankDetails.bankName}
                    onChange={(e) => setForm({ ...form, bankDetails: { ...form.bankDetails, bankName: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="prm-label">Account Number</label>
                  <input value={form.bankDetails.accountNumber}
                    onChange={(e) => setForm({ ...form, bankDetails: { ...form.bankDetails, accountNumber: e.target.value } })}
                    className="mt-1 block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="prm-label">IFSC</label>
                  <input value={form.bankDetails.ifsc}
                    onChange={(e) => setForm({ ...form, bankDetails: { ...form.bankDetails, ifsc: e.target.value.toUpperCase() } })}
                    placeholder="HDFC0001234" maxLength={11}
                    className="mt-1 block w-full border rounded-lg px-3 py-2 font-mono" />
                </div>
              </div>

              {error && (
                <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>
              )}

              <div className="emp-modal-foot">
                <button type="button" onClick={() => setShowModal(false)}
                  className="trn-btn">Cancel</button>
                <button type="submit" disabled={saving || codeState === 'taken'}
                  title={codeState === 'taken' ? 'That employee code already exists' : undefined}
                  className="trn-btn is-primary accent-bg text-white">
                  <FiCheck size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ---------------- Import review ---------------- */}
      {showFlags && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
          {/* flex-col + an inner scroller is the shape index.css looks for: without
              it the panel itself became a second scroller around this body's own
              one, and on a phone the outer 1.1rem padding was added on top of each
              section's px-6, pulling the header rule away from the panel edges. */}
          <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl max-h-[85vh] flex flex-col">
            <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-gray-100">
              <div>
                <h2 className="card-title">Imported values to check</h2>
              </div>
              <button type="button" onClick={() => setShowFlags(false)} aria-label="Close"
                className="topbar-icon-btn shrink-0">×</button>
            </div>

            <div className="px-6 py-4 flex-1 min-h-0 overflow-y-auto space-y-3">
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
                        : f.field === 'shift' ? shiftNames
                        : ['reportingManager', 'hrPartner'].includes(f.field)
                          // A manager or HR partner is somebody still here.
                          ? allUsers.filter((u) => !hasLeft(u)).map((u) => u.email).filter(Boolean)
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

                    {!canFixFlagField(f.field) && (
                      <p className="text-xs text-gray-500 mt-2">
                        Only the Backend account can change this.
                      </p>
                    )}

                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      {canFixFlagField(f.field) && (
                      <input
                        list={suggestions.length ? listId : undefined}
                        value={flagEdits[f._id] ?? ''}
                        onChange={(e) => setFlagEdits((s) => ({ ...s, [f._id]: e.target.value }))}
                        placeholder={PLACEHOLDERS[f.field] || `Correct value (was “${f.rawValue || '—'}”)`}
                        className="flex-1 min-w-[14rem] border rounded-lg px-3 py-2 text-sm"
                      />
                      )}
                      {canFixFlagField(f.field) && suggestions.length > 0 && (
                        <datalist id={listId}>
                          {suggestions.slice(0, 200).map((s) => <option key={s} value={s} />)}
                        </datalist>
                      )}
                      <button
                        type="button"
                        disabled={flagBusy === f._id}
                        onClick={() => resolveFlag(f)}
                        className="trn-btn is-primary accent-bg text-white shrink-0"
                      >
                        {flagBusy === f._id ? 'Saving…'
                          : !canFixFlagField(f.field) ? 'Mark as seen'
                            : (flagEdits[f._id] || '').trim() ? 'Save & clear' : 'Looks right'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-end px-6 py-4 border-t border-gray-100">
              <button type="button" onClick={() => setShowFlags(false)}
                className="trn-btn">Close</button>
            </div>
          </div>
        </div>
      )}

      {showImportModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="card-title" title="Use the Template button first. Required columns: Employee Code, First Name, Last Name, Email, Date of Joining.">Import Employees from Excel</h2>
              </div>
              <button onClick={closeImport} type="button" aria-label="Close" title="Close" className="topbar-icon-btn shrink-0">×</button>
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
                  Duplicate email or employee code rows are skipped, not overwritten.
                </p>
                <div className="emp-modal-foot">
                  <button type="button" onClick={closeImport}
                    className="trn-btn">Cancel</button>
                  <button type="submit" disabled={importing}
                    className="trn-btn is-primary accent-bg text-white">
                    <FiUpload size={14} aria-hidden="true" /> {importing ? 'Importing…' : 'Upload & Import'}
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
                    {/* One column on a phone: three tiles inside this modal leave
                        ~64px of text width at 360px, which breaks "Skipped
                        (duplicates)" mid-word. */}
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div className="trn-kpi" style={{ '--kpi-hue': '#16a34a' }}>
                        <span className="trn-kpi-icon" aria-hidden="true"><FiCheckCircle size={18} /></span>
                        <span className="min-w-0">
                          <span className="trn-kpi-value block">{importResult.createdCount}</span>
                          <span className="trn-kpi-label block">Created</span>
                        </span>
                      </div>
                      <div className="trn-kpi" style={{ '--kpi-hue': '#d97706' }}>
                        <span className="trn-kpi-icon" aria-hidden="true"><FiSkipForward size={18} /></span>
                        <span className="min-w-0">
                          <span className="trn-kpi-value block">{importResult.skippedCount}</span>
                          <span className="trn-kpi-label block">Skipped (duplicates)</span>
                        </span>
                      </div>
                      {/* Kept as its own tile: an error is a row that did NOT
                          import, which is a different thing from a flag. */}
                      <div className="trn-kpi" style={{ '--kpi-hue': '#dc2626' }}>
                        <span className="trn-kpi-icon" aria-hidden="true"><FiAlertCircle size={18} /></span>
                        <span className="min-w-0">
                          <span className="trn-kpi-value block">{importResult.errorCount}</span>
                          <span className="trn-kpi-label block">Errors</span>
                        </span>
                      </div>
                    </div>

                    {importResult.createdCount > 0 && (
                      <p className="text-sm text-gray-700">
                        Default password for new accounts: <code className="bg-gray-100 px-1 py-0.5 rounded">{importResult.defaultPassword}</code>
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
                  <button type="button" onClick={closeImport}
                    className="trn-btn is-primary accent-bg text-white">
                    Done
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <MailComposeModal open={!!mail} onClose={() => setMail(null)} {...(mail || {})} />
    </div>
  );
}
