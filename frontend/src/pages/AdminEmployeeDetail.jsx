import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

function initials(p) {
  const a = (p?.user?.firstName || '')[0] || '';
  const b = (p?.user?.lastName || '')[0] || '';
  return (a + b).toUpperCase() || 'E';
}

function Field({ label, value }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-400">{label}</dt>
      <dd className="text-sm text-gray-800 mt-0.5">{value || <span className="text-gray-400">—</span>}</dd>
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
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError('');
    (async () => {
      try {
        const { data } = await api.get(`/employees/${id}`);
        setProfile(data.profile);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load employee');
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

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
      <PageHeader title={fullName(u) || profile.employeeCode} subtitle={`${profile.designation || '—'} · ${profile.department || '—'}`}>
        <Link to="/admin/employees" className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">← All employees</Link>
      </PageHeader>

      {/* Identity banner */}
      <div className="bg-white shadow rounded-lg p-5 mb-4 flex items-center gap-4">
        <span className="avatar-circle accent-bg text-white" style={{ width: '3.5rem', height: '3.5rem', fontSize: '1.1rem' }}>
          {initials(profile)}
        </span>
        <div className="min-w-0">
          <div className="text-lg font-semibold text-gray-900">{fullName(u) || '—'}</div>
          <div className="text-sm text-gray-500">
            <span className="font-mono">{profile.employeeCode}</span> · {u.email || '—'}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${u.isActive ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-700'}`}>
              {u.isActive ? 'Active' : 'Inactive'}
            </span>
            <span className={`inline-block px-2 py-0.5 text-xs rounded-lg ${CONFIRM_BADGE[profile.confirmationStatus] || 'bg-gray-100 text-gray-700'}`}>
              {profile.confirmationStatus || 'Probation'}
            </span>
            <span className="inline-block px-2 py-0.5 text-xs rounded-lg bg-gray-100 text-gray-700">{profile.employmentType || '—'}</span>
          </div>
        </div>
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
          <Field label="HR partner" value={fullName(profile.hrPartner)} />
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
    </div>
  );
}
