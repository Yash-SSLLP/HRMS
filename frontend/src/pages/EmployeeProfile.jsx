/**
 * EmployeeProfile — read-only view of the logged-in employee's HR record
 * (employee portal). Loads the profile from GET /employees/me. Most fields are
 * changed only via change-requests, but date-of-birth is self-service and saved
 * directly through PATCH /employees/me/birthday.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ProfilePhotoCard from '../components/ProfilePhotoCard';

// Compact label/value pair used across the personal/statutory/bank sections.
function Field({ label, value, mono }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      <dd className={`text-sm text-gray-900 ${mono ? 'font-mono' : ''}`}>{value || '-'}</dd>
    </div>
  );
}

const toInputDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

export default function EmployeeProfile() {
  const [profile, setProfile] = useState(null);
  const [error, setError] = useState('');
  const [dob, setDob] = useState('');
  const [savingDob, setSavingDob] = useState(false);
  const [dobMsg, setDobMsg] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get('/employees/me');
        setProfile(data.profile);
        setDob(toInputDate(data.profile?.dateOfBirth));
      } catch (err) {
        setError(err.response?.data?.message || 'Failed to load profile');
      }
    })();
  }, []);

  // Self-service birthday update (no HR approval needed, unlike other fields).
  const saveBirthday = async () => {
    if (!dob) { setDobMsg('Please pick a date.'); return; }
    setSavingDob(true);
    setDobMsg('');
    try {
      const { data } = await api.patch('/employees/me/birthday', { dateOfBirth: dob });
      setProfile((p) => ({ ...p, dateOfBirth: data.profile.dateOfBirth }));
      setDobMsg('Birthday saved!');
    } catch (err) {
      setDobMsg(err.response?.data?.message || 'Could not save birthday');
    } finally {
      setSavingDob(false);
    }
  };

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

  return (
    <div>
      <PageHeader title="My Profile" subtitle="To update any detail, raise a change request · your admin will review it.">
        <Link
          to="/employee/account"
          className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700"
        >
          Request a change
        </Link>
      </PageHeader>

      <ProfilePhotoCard />

      {/* Birthday — self-service (no approval needed) */}
      <div className="bg-white shadow rounded-lg p-5 mb-4">
        <h2 className="card-title mb-1">🎂 Birthday</h2>
        <p className="text-sm text-gray-500 mb-3">
          Add your date of birth so the team can celebrate with you. You can set this yourself.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs uppercase tracking-wide text-gray-500 mb-1">Date of Birth</label>
            <input
              type="date"
              value={dob}
              max={toInputDate(new Date())}
              onChange={(e) => { setDob(e.target.value); setDobMsg(''); }}
              className="border border-gray-300 rounded-lg px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300"
            />
          </div>
          <button
            onClick={saveBirthday}
            disabled={savingDob}
            className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-60"
          >
            {savingDob ? 'Saving…' : profile.dateOfBirth ? 'Update' : 'Add Birthday'}
          </button>
          {dobMsg && (
            <span className={`text-sm ${/saved/i.test(dobMsg) ? 'text-green-700' : 'text-red-700'}`}>{dobMsg}</span>
          )}
        </div>
      </div>

      <div className="bg-white shadow rounded-lg p-6 space-y-6">
        <section>
          <h2 className="card-title mb-3">Personal</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Employee Code" value={profile.employeeCode} mono />
            <Field label="Name" value={`${u.firstName || ''} ${u.lastName || ''}`} />
            <Field label="Email" value={u.email} />
            <Field label="Phone" value={u.phone} />
            <Field label="Date of Birth" value={profile.dateOfBirth && new Date(profile.dateOfBirth).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} />
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
