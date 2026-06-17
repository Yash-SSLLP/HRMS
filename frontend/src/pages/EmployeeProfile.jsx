import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

function Field({ label, value, mono }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`text-sm text-gray-900 ${mono ? 'font-mono' : ''}`}>{value || '—'}</dd>
    </div>
  );
}

export default function EmployeeProfile() {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/employees/me');
        setProfile(data.profile);
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load profile');
      }
    })();
  }, []);

  if (error) {
    return (
      <div>
        <PageHeader title="My Profile" />
        <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-lg">
          {error}
        </div>
      </div>
    );
  }
  if (!profile) {
    return <p className="text-gray-500">Loading…</p>;
  }

  const u = profile.user || {};
  const bank = profile.bankDetails || {};
  const hr = profile.hrPartner || null;

  return (
    <div>
      <PageHeader title="My Profile" subtitle="To update any detail, raise a change request — your admin will review it.">
        <Link
          to="/employee/account"
          className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700"
        >
          Request a change
        </Link>
      </PageHeader>

      <div className="bg-white shadow rounded-lg p-6 space-y-6">
        <section>
          <h2 className="card-title mb-3">Personal</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Employee Code" value={profile.employeeCode} mono />
            <Field label="Name" value={`${u.firstName || ''} ${u.lastName || ''}`} />
            <Field label="Email" value={u.email} />
            <Field label="Phone" value={u.phone} />
            <Field label="Date of Joining" value={profile.dateOfJoining && new Date(profile.dateOfJoining).toLocaleDateString('en-IN')} />
            <Field label="Employment Type" value={profile.employmentType} />
            <Field label="Designation" value={profile.designation} />
            <Field label="Department" value={profile.department} />
            <Field label="Work Location" value={profile.workLocation} />
          </dl>
        </section>

        <section>
          <h2 className="card-title mb-3">Statutory IDs</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="PAN" value={profile.pan} mono />
            <Field label="UAN" value={profile.uan} mono />
            <Field label="PF Number" value={profile.pfNumber} mono />
            <Field label="ESIC Number" value={profile.esicNumber} mono />
          </dl>
          <p className="text-xs text-gray-400 mt-2 italic">Aadhaar is hidden by default. Contact HR if you need to verify.</p>
        </section>

        <section>
          <h2 className="card-title mb-3">HR Contact</h2>
          {hr ? (
            <dl className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <Field label="HR Partner" value={`${hr.firstName || ''} ${hr.lastName || ''}`.trim()} />
              <Field label="Email" value={hr.email} />
            </dl>
          ) : (
            <p className="text-sm text-gray-400 italic">No HR partner assigned. Contact HR if you have questions.</p>
          )}
        </section>

        <section>
          <h2 className="card-title mb-3">Bank</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Bank" value={bank.bankName} />
            <Field label="Branch" value={bank.branch} />
            <Field label="Account Holder" value={bank.accountHolderName} />
            <Field label="Account Number" value={bank.accountNumber} mono />
            <Field label="IFSC" value={bank.ifsc} mono />
            <Field label="Type" value={bank.accountType} />
          </dl>
        </section>
      </div>
    </div>
  );
}
