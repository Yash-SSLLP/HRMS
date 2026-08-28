/**
 * AdminEmployeeDetail — read-only employee profile detail (admin portal), route
 * /admin/employees/:id. Loads the full profile from GET /employees/:id and the
 * employee's documents from GET /documents?employee=. HR can generate a
 * document-submission link (POST /employees/:id/doc-link) and verify/reject
 * submitted documents (PATCH /documents/:id/status).
 */
import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import api from '../api/client';
import { useAuthStore } from '../store/authStore';
import { hasPermission, isReadOnlyExec, canEditEmployeeProfile } from '../config/permissions';
import PageHeader from '../components/PageHeader';
import { promptDialog } from '../components/dialogs';
import DocPreviewModal from '../components/DocPreviewModal';

const DOC_STATUS_STYLES = {
  Submitted: 'bg-amber-100 text-amber-800',
  Verified: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-800',
};

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';

function initials(p) {
  const a = (p?.user?.firstName || '')[0] || '';
  const b = (p?.user?.lastName || '')[0] || '';
  return (a + b).toUpperCase() || 'E';
}

function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-800 mt-0.5">{value || <span className="text-gray-400">-</span>}</dd>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div className="bg-white shadow rounded-lg p-5">
      <h2 className="card-title mb-4">{title}</h2>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-4">{children}</dl>
    </div>
  );
}

const fullName = (u) => `${u?.firstName || ''} ${u?.lastName || ''}`.trim();

const CONFIRM_BADGE = {
  Probation: 'bg-amber-100 text-amber-800',
  Extended: 'bg-blue-100 text-blue-800',
  Confirmed: 'bg-green-100 text-green-800',
};

export default function AdminEmployeeDetail() {
  const { id } = useParams();
  const me = useAuthStore((s) => s.user);
  // Who may change an employee's details: a SuperAdmin, or an HR Manager holding
  // employees.manage. CEO/MD pass hasPermission but are read-only executives —
  // the server refuses their writes, so they must not be offered the button.
  // Unless a SuperAdmin has switched that exec account into edit mode.
  const canEditAnyone = me?.role === 'SuperAdmin'
    || (!isReadOnlyExec(me) && hasPermission(me, 'employees.manage'));
  // Setting someone else's password is SuperAdmin-only, matching the server:
  // PUT /admin/users/:id refuses a non-SuperAdmin touching a non-Employee, and
  // handing out passwords is not something an HR Manager should do silently.
  const canSetPassword = me?.role === 'SuperAdmin';
  const [profile, setProfile] = useState(null);
  // …and, on top of that, editing someone whose role is Manager needs the
  // separate grant a SuperAdmin gives per account. Derived from the loaded
  // profile rather than the role alone, because it depends on WHO is being
  // edited, not only on who is doing the editing.
  const canEdit = canEditAnyone && canEditEmployeeProfile(me, profile?.user);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pwBusy, setPwBusy] = useState(false);
  const [docs, setDocs] = useState([]);
  const [token, setToken] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  const [docBusy, setDocBusy] = useState(false);
  // The document open in the preview modal, so a set can be verified
  // without downloading every file first.
  const [previewDoc, setPreviewDoc] = useState(null);

  const loadDocs = async () => {
    try {
      const { data } = await api.get(`/documents?employee=${id}`);
      setDocs(data.documents || []);
    } catch { /* ignore */ }
  };

  useEffect(() => {
    setLoading(true);
    setError('');
    (async () => {
      try {
        const { data } = await api.get(`/employees/${id}`);
        setProfile(data.profile);
        setToken(data.profile?.docToken || '');
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load employee');
      } finally {
        setLoading(false);
      }
    })();
    loadDocs();
  }, [id]);

  const docLink = token ? `${window.location.origin}/employee-docs/${token}` : '';

  const generateLink = async () => {
    setDocBusy(true);
    try {
      const { data } = await api.post(`/employees/${id}/doc-link`);
      setToken(data.token);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not generate link');
    } finally {
      setDocBusy(false);
    }
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(docLink); } catch { await promptDialog({ title: 'Copy link', message: 'Copy this link:', initialValue: docLink, confirmText: 'Done' }); }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 1600);
  };

  // SuperAdmin sets a new sign-in password for this employee.
  //
  // Reads profile.user rather than the `u` alias further down, so it never
  // depends on where in the render this is declared. The server does the real
  // work: PUT /admin/users/:id assigns the plain value and the User pre-save
  // hook re-hashes it, so nothing hashed is ever sent from the browser.
  const setPassword = async () => {
    const target = profile?.user;
    if (!target?._id) return;
    const name = fullName(target) || target.email || 'this employee';
    const pw = await promptDialog({
      title: 'Set a new password',
      message: `${name} will sign in with this password from now on. Tell them through a channel you trust — it is not emailed to them.`,
      inputLabel: 'New password',
      inputType: 'password',
      placeholder: 'At least 8 characters',
      confirmText: 'Set password',
      tone: 'warning',
    });
    if (pw === null) return;                       // cancelled
    if (String(pw).trim().length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    setPwBusy(true);
    try {
      await api.put(`/admin/users/${target._id}`, { password: String(pw) });
      toast.success(`Password updated for ${name}`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not set the password');
    } finally {
      setPwBusy(false);
    }
  };

  const setDocStatus = async (docId, status) => {
    let note;
    if (status === 'Rejected') note = (await promptDialog({ message: 'Reason for rejecting (optional):' })) || '';
    try {
      await api.patch(`/documents/${docId}/status`, { status, note });
      await loadDocs();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not update status');
    }
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Employee" />
        <p className="text-sm text-gray-400 italic">Loading…</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div>
        <PageHeader title="Employee">
          <Link to="/admin/employees" className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">← Back</Link>
        </PageHeader>
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
          {error || 'Employee not found'}
        </div>
      </div>
    );
  }

  const u = profile.user || {};
  const bank = profile.bankDetails || {};
  const cur = profile.address?.current || {};
  const perm = profile.address?.permanent || {};
  const ec = profile.emergencyContact || {};
  const addr = (a) =>
    [a.line1, a.line2, a.city, a.state, a.pincode, a.country].filter(Boolean).join(', ');

  return (
    <div>
      <PageHeader title={fullName(u) || profile.employeeCode} subtitle={`${profile.designation || '-'} · ${profile.department || '-'}`}>
        {canSetPassword && u?._id && (
          <button onClick={setPassword} disabled={pwBusy}
            title={`Set a new sign-in password for ${fullName(u) || 'this employee'}`}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50 disabled:opacity-50">
            {pwBusy ? 'Saving…' : 'Set password'}
          </button>
        )}
        {canEdit && (
          // Editing reuses the full form on the employees list rather than a
          // second copy here; `back=1` returns to this page once saved.
          <Link to={`/admin/employees?edit=${id}&back=1`}
            className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
            Edit details
          </Link>
        )}
        <Link to="/admin/employees" className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">← All employees</Link>
      </PageHeader>

      {/* Identity banner */}
      <div className="bg-white shadow rounded-lg p-5 mb-4 flex items-center gap-4">
        <span className="avatar-circle accent-bg text-white" style={{ width: '3.5rem', height: '3.5rem', fontSize: '1.1rem' }}>
          {initials(profile)}
        </span>
        <div className="min-w-0">
          <div className="text-lg font-semibold text-gray-900">{fullName(u) || '-'}</div>
          <div className="text-sm text-gray-500">
            <span className="font-mono">{profile.employeeCode}</span> · {u.email || '-'}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${u.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
              {u.isActive ? 'Active' : 'Inactive'}
            </span>
            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${CONFIRM_BADGE[profile.confirmationStatus] || 'bg-gray-100 text-gray-700'}`}>
              {profile.confirmationStatus || 'Probation'}
            </span>
            <span className="inline-block px-2 py-0.5 text-xs rounded-lg bg-gray-100 text-gray-700">{profile.employmentType || '-'}</span>
          </div>
        </div>
      </div>

      {/* Document submission link + verification */}
      <div className="bg-white shadow rounded-lg p-5 mb-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="card-title">Document Submission</h2>
          {token ? (
            <button onClick={generateLink} disabled={docBusy} className="text-xs text-gray-500 hover:underline">Regenerate link</button>
          ) : null}
        </div>
        {token ? (
          <div className="flex gap-2 mb-4">
            <input readOnly value={docLink} onFocus={(e) => e.target.select()}
              className="flex-1 border rounded-lg px-3 py-2 text-xs bg-gray-50" />
            <button onClick={copyLink} className="text-xs px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 whitespace-nowrap">
              {linkCopied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
        ) : (
          <button onClick={generateLink} disabled={docBusy}
            className="mb-4 px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
            {docBusy ? 'Generating…' : 'Generate submission link'}
          </button>
        )}
        <p className="text-xs text-gray-500 mb-3">
          Share this link with {fullName(u) || 'the employee'} to collect documents. Submitted files appear below for you to verify.
        </p>

        {docs.length === 0 ? (
          <p className="text-sm text-gray-400 italic">No documents submitted yet.</p>
        ) : (
          <ul className="divide-y divide-gray-100">
            {docs.map((d) => (
              <li key={d._id} className="py-2 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm text-gray-800 truncate">
                    <span className="text-gray-500">{d.category}:</span> {d.fileName}
                  </div>
                  {d.reviewNote && <div className="text-xs text-gray-400">{d.reviewNote}</div>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className={`text-xs px-2 py-0.5 rounded-lg ${DOC_STATUS_STYLES[d.status || 'Submitted']}`}>{d.status || 'Submitted'}</span>
                  <button onClick={() => setPreviewDoc(d)} className="text-xs text-blue-600 hover:underline">View</button>
                  {d.status !== 'Verified' && (
                    <button onClick={() => setDocStatus(d._id, 'Verified')} className="text-xs text-green-700 hover:underline">Verify</button>
                  )}
                  {d.status !== 'Rejected' && (
                    <button onClick={() => setDocStatus(d._id, 'Rejected')} className="text-xs text-amber-700 hover:underline">Reject</button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Job">
          <Field label="Designation" value={profile.designation} />
          <Field label="Department" value={profile.department} />
          <Field label="Grade" value={profile.grade} />
          <Field label="Work location" value={profile.workLocation} />
          <Field label="Employment type" value={profile.employmentType} />
          <Field label="Date of joining" value={fmtDate(profile.dateOfJoining)} />
          <Field label="Reporting manager" value={fullName(profile.reportingManager)} />
          {profile.dateOfExit && <Field label="Date of exit" value={fmtDate(profile.dateOfExit)} />}
        </Card>

        <Card title="Confirmation">
          <Field label="Status" value={profile.confirmationStatus} />
          <Field label="Probation (months)" value={profile.probationMonths} />
          <Field label="Due date" value={fmtDate(profile.confirmationDueDate)} />
          <Field label="Confirmed on" value={fmtDate(profile.confirmedOn)} />
          <Field label="Note" value={profile.confirmationNote} />
        </Card>

        <Card title="Personal & Contact">
          <Field label="Phone" value={u.phone} />
          <Field label="Email" value={u.email} />
          <Field label="Date of birth" value={fmtDate(profile.dateOfBirth)} />
          <Field label="Gender" value={profile.gender} />
          <Field label="Marital status" value={profile.maritalStatus} />
          <Field label="Current address" value={addr(cur)} />
          <Field label="Permanent address" value={addr(perm)} />
          <Field label="Emergency contact" value={ec.name ? `${ec.name}${ec.relation ? ` (${ec.relation})` : ''}${ec.phone ? ` · ${ec.phone}` : ''}` : ''} />
        </Card>

        <Card title="Statutory IDs">
          <Field label="PAN" value={profile.pan} />
          <Field label="UAN" value={profile.uan} />
          <Field label="PF number" value={profile.pfNumber} />
          <Field label="ESIC number" value={profile.esicNumber} />
          <Field label="Documents" value={profile.documentsVerified ? 'Verified' : 'Pending'} />
        </Card>

        <Card title="Bank Details">
          <Field label="Account holder" value={bank.accountHolderName} />
          <Field label="Bank" value={bank.bankName} />
          <Field label="Branch" value={bank.branch} />
          <Field label="Account no." value={bank.accountNumber} />
          <Field label="IFSC" value={bank.ifsc} />
          <Field label="Account type" value={bank.accountType} />
        </Card>
      </div>

      {previewDoc && <DocPreviewModal doc={previewDoc} onClose={() => setPreviewDoc(null)} />}
    </div>
  );
}
