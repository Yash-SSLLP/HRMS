/**
 * EmployeeProfile — the logged-in employee's HR record (employee portal).
 * Loads the profile from GET /employees/me and the field catalogue from
 * GET /change-requests/fields.
 *
 * FILL WHAT IS MISSING (2026-09-30, user: "if any details is missing then give
 * option to employee to fill that in web also" — the app's Profile already did).
 * Every EMPTY catalogue field on this page carries "+ Add": an inline editor
 * that saves through POST /change-requests/fill — applied at once, audited, and
 * then locked like any other filled field (changing it later is a change
 * request to HR, "Request a change" above). The server is the rule-keeper: it
 * refuses a field that is already set (409) and the model validates the format
 * (PAN, IFSC, UAN…), whose message is shown under the box. A field with a
 * request already waiting says "Pending with HR" instead.
 *
 * Date of birth is also self-service through the Birthday card (PATCH
 * /employees/me/birthday, once a day).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'react-toastify';
import { FiPlus, FiClock, FiCheck, FiX } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import ProfilePhotoCard from '../components/ProfilePhotoCard';

// Fields picked from a fixed list — must match the enums in models/EmployeeProfile.js.
const CHOICES = {
  gender: ['Male', 'Female', 'Other'],
  maritalStatus: ['Single', 'Married', 'Other'],
  employmentType: ['FullTime', 'PartTime', 'Contract', 'Intern'],
  'bankDetails.accountType': ['Savings', 'Current', 'Salary'],
};
const CHOICE_LABELS = { FullTime: 'Full time', PartTime: 'Part time' };

// What each ID looks like — shown as the placeholder, so the format is known
// before the server has to refuse it. Upper-cased as typed where the model
// stores it upper-case.
const HINTS = {
  pan: { placeholder: 'ABCDE1234F', upper: true, maxLength: 10 },
  aadhaar: { placeholder: '12 digits', numeric: true, maxLength: 12 },
  uan: { placeholder: '12 digits', numeric: true, maxLength: 12 },
  esicNumber: { placeholder: '10–17 digits', numeric: true, maxLength: 17 },
  'bankDetails.ifsc': { placeholder: 'SBIN0001234', upper: true, maxLength: 11 },
  'bankDetails.accountNumber': { placeholder: 'Account number', numeric: true, maxLength: 20 },
  phone: { placeholder: '10-digit mobile', numeric: true, maxLength: 15 },
  'emergencyContact.phone': { placeholder: '10-digit mobile', numeric: true, maxLength: 15 },
  'address.current.pincode': { placeholder: '6 digits', numeric: true, maxLength: 6 },
  'address.permanent.pincode': { placeholder: '6 digits', numeric: true, maxLength: 6 },
};

// The fillable details this page shows that count towards "N missing".
const COUNTED_KEYS = [
  'email', 'phone', 'dateOfBirth', 'gender', 'maritalStatus', 'employmentType', 'designation', 'department',
  'pan', 'uan', 'pfNumber', 'esicNumber', 'aadhaar',
  'bankDetails.bankName', 'bankDetails.branch', 'bankDetails.accountHolderName',
  'bankDetails.accountNumber', 'bankDetails.ifsc', 'bankDetails.accountType',
  'address.current.line1', 'address.current.city', 'address.current.state', 'address.current.pincode',
  'address.permanent.line1', 'address.permanent.city', 'address.permanent.state', 'address.permanent.pincode',
  'emergencyContact.name', 'emergencyContact.relation', 'emergencyContact.phone',
];

const fmtDate = (d) => (d
  ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  : '');

const toInputDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

/**
 * One label/value pair. With a catalogue `field` that is EMPTY on the server,
 * it offers "+ Add" and edits in place; with one waiting on HR, it says so.
 */
function Field({ label, value, mono, field, meta, onFilled, display }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const empty = value == null || String(value).trim() === '';
  const canFill = !!field && !!meta && meta.isEmpty && !meta.pending && empty;
  const pending = !!meta?.pending;
  const hint = HINTS[field] || {};
  const choices = CHOICES[field];
  const isDate = meta?.type === 'date';

  const start = () => { setDraft(''); setError(''); setEditing(true); };
  const cancel = () => { setEditing(false); setError(''); };
  const save = async () => {
    const v = String(draft || '').trim();
    if (!v) { setError('Enter a value first.'); return; }
    setSaving(true);
    setError('');
    try {
      await api.post('/change-requests/fill', { field, value: v });
      setEditing(false);
      toast.success(`${label} saved`);
      onFilled?.();
    } catch (err) {
      setError(err.response?.data?.message || 'Could not save that.');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = `w-full min-w-0 border border-gray-300 rounded-lg px-2.5 py-1.5 text-sm bg-white ${mono ? 'font-mono' : ''}`;

  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-gray-500">{label}</dt>
      {editing ? (
        <dd className="mt-1">
          <div className="flex flex-wrap items-center gap-2">
            {choices ? (
              <select value={draft} onChange={(e) => setDraft(e.target.value)} className={`${inputClass} sm:w-auto`} autoFocus>
                <option value="">Choose…</option>
                {choices.map((c) => <option key={c} value={c}>{CHOICE_LABELS[c] || c}</option>)}
              </select>
            ) : isDate ? (
              <input type="date" value={draft} max={toInputDate(new Date())} onChange={(e) => setDraft(e.target.value)}
                className={`${inputClass} sm:w-auto`} autoFocus />
            ) : (
              <input
                value={draft}
                onChange={(e) => {
                  let v = e.target.value;
                  if (hint.upper) v = v.toUpperCase();
                  if (hint.numeric) v = v.replace(/[^0-9]/g, '');
                  setDraft(v);
                }}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
                placeholder={hint.placeholder || label}
                maxLength={hint.maxLength || 200}
                inputMode={hint.numeric ? 'numeric' : undefined}
                className={`${inputClass} sm:max-w-[16rem]`}
                autoFocus
              />
            )}
            <div className="flex items-center gap-1.5">
              <button type="button" onClick={save} disabled={saving}
                className="inline-flex items-center gap-1 accent-bg on-accent rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60">
                <FiCheck size={13} /> {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" onClick={cancel} disabled={saving}
                className="inline-flex items-center gap-1 border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                <FiX size={13} /> Cancel
              </button>
            </div>
          </div>
          {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
        </dd>
      ) : (
        <dd className={`text-sm text-gray-900 ${mono ? 'font-mono' : ''} flex flex-wrap items-center gap-2`}>
          {empty ? <span className="text-gray-400">-</span> : (display ?? value)}
          {canFill && (
            <button type="button" onClick={start} className="profile-add-btn">
              <FiPlus size={12} /> Add
            </button>
          )}
          {empty && pending && (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
              <FiClock size={11} /> Pending with HR
            </span>
          )}
        </dd>
      )}
    </div>
  );
}

export default function EmployeeProfile() {
  const [profile, setProfile] = useState(null);
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [dob, setDob] = useState('');
  const [savingDob, setSavingDob] = useState(false);
  const [dobMsg, setDobMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [me, catalogue] = await Promise.all([
        api.get('/employees/me'),
        // The page still works without it — it just cannot offer "+ Add".
        api.get('/change-requests/fields').catch(() => ({ data: { fields: [] } })),
      ]);
      setProfile(me.data.profile);
      setDob(toInputDate(me.data.profile?.dateOfBirth));
      setFields(Object.fromEntries((catalogue.data.fields || []).map((f) => [f.key, f])));
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load profile');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Self-service birthday update: no HR approval, but once per day — the
  // server spends the same allowance the Your-details screen does, so a second
  // change today comes back as a 409 and is shown below the field.
  const saveBirthday = async () => {
    if (!dob) { setDobMsg('Please pick a date.'); return; }
    setSavingDob(true);
    setDobMsg('');
    try {
      const { data } = await api.patch('/employees/me/birthday', { dateOfBirth: dob });
      setProfile((p) => ({ ...p, dateOfBirth: data.profile.dateOfBirth }));
      setDobMsg('Birthday saved!');
      load();
    } catch (err) {
      setDobMsg(err.response?.data?.message || 'Could not save birthday');
    } finally {
      setSavingDob(false);
    }
  };

  // How many details this page shows are still empty and yours to fill —
  // optional ones (address line 2) are offered but not counted as missing.
  const missing = useMemo(() => COUNTED_KEYS
    .filter((k) => fields[k] && fields[k].isEmpty && !fields[k].pending).length, [fields]);

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
  // A catalogue-backed field: `field` is the FIELD_CATALOG key, the value comes
  // from the profile (or the catalogue's own reading when the profile hides it).
  const F = (label, field, value, extra = {}) => (
    <Field label={label} field={field} meta={fields[field]} value={value} onFilled={load} {...extra} />
  );
  const aadhaarMeta = fields.aadhaar;

  return (
    <div>
      <PageHeader title="My Profile">
        <Link
          to="/employee/account"
          className="bg-gray-900 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-700"
        >
          Request a change
        </Link>
      </PageHeader>

      <ProfilePhotoCard />

      {missing > 0 && (
        <div className="profile-missing-banner mb-4">
          <FiPlus size={16} className="shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-gray-900">
              {missing} detail{missing === 1 ? ' is' : 's are'} missing from your profile
            </div>
          </div>
        </div>
      )}

      {/* Birthday — self-service (no approval needed) */}
      <div className="bg-white shadow rounded-lg p-5 mb-4">
        <h2 className="card-title mb-3">🎂 Birthday</h2>
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
          {/* One column on a phone (all lists): two 134px columns split
              emails, account and PF numbers across lines mid-string. */}
          <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <Field label="Employee Code" value={profile.employeeCode} mono />
            <Field label="Name" value={`${u.firstName || ''} ${u.lastName || ''}`.trim()} />
            {F('Email', 'email', u.email)}
            {F('Phone', 'phone', u.phone)}
            {F('Date of Birth', 'dateOfBirth', profile.dateOfBirth, { display: fmtDate(profile.dateOfBirth) })}
            <Field label="Date of Joining" value={fmtDate(profile.dateOfJoining)} />
            {F('Gender', 'gender', profile.gender)}
            {F('Marital Status', 'maritalStatus', profile.maritalStatus)}
            {F('Employment Type', 'employmentType', profile.employmentType, { display: CHOICE_LABELS[profile.employmentType] || profile.employmentType })}
            {F('Designation', 'designation', profile.designation)}
            {F('Department', 'department', profile.department)}
            {/* The assigned site is HR's to set (an org reference, not a
                catalogue field); the legacy free-text label is the fallback. */}
            <Field label="Work Location" value={profile.workLocationRef?.name || profile.workLocation} />
          </dl>
        </section>

        <section>
          <h2 className="card-title mb-3">Statutory IDs</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {F('PAN', 'pan', profile.pan, { mono: true })}
            {F('UAN', 'uan', profile.uan, { mono: true })}
            {F('PF Number', 'pfNumber', profile.pfNumber, { mono: true })}
            {F('ESIC Number', 'esicNumber', profile.esicNumber, { mono: true })}
            {/* Never displayed — only whether it is on file, and "+ Add" when not. */}
            {aadhaarMeta && F('Aadhaar', 'aadhaar', aadhaarMeta.isEmpty ? '' : 'on-file', {
              mono: true, display: <span className="text-gray-500 font-sans">On file (hidden)</span>,
            })}
          </dl>
        </section>

        <section>
          <h2 className="card-title mb-3">Bank</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {F('Bank', 'bankDetails.bankName', bank.bankName)}
            {F('Branch', 'bankDetails.branch', bank.branch)}
            {F('Account Holder', 'bankDetails.accountHolderName', bank.accountHolderName)}
            {F('Account Number', 'bankDetails.accountNumber', bank.accountNumber, { mono: true })}
            {F('IFSC', 'bankDetails.ifsc', bank.ifsc, { mono: true })}
            {F('Type', 'bankDetails.accountType', bank.accountType)}
          </dl>
        </section>

        <section>
          <h2 className="card-title mb-3">Current address</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {F('Address line 1', 'address.current.line1', getPath(profile, 'address.current.line1'))}
            {F('Address line 2', 'address.current.line2', getPath(profile, 'address.current.line2'))}
            {F('City', 'address.current.city', getPath(profile, 'address.current.city'))}
            {F('State', 'address.current.state', getPath(profile, 'address.current.state'))}
            {F('PIN code', 'address.current.pincode', getPath(profile, 'address.current.pincode'), { mono: true })}
          </dl>
        </section>

        <section>
          <h2 className="card-title mb-3">Permanent address</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {F('Address line 1', 'address.permanent.line1', getPath(profile, 'address.permanent.line1'))}
            {F('Address line 2', 'address.permanent.line2', getPath(profile, 'address.permanent.line2'))}
            {F('City', 'address.permanent.city', getPath(profile, 'address.permanent.city'))}
            {F('State', 'address.permanent.state', getPath(profile, 'address.permanent.state'))}
            {F('PIN code', 'address.permanent.pincode', getPath(profile, 'address.permanent.pincode'), { mono: true })}
          </dl>
        </section>

        <section>
          <h2 className="card-title mb-3">Emergency contact</h2>
          <dl className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            {F('Name', 'emergencyContact.name', getPath(profile, 'emergencyContact.name'))}
            {F('Relation', 'emergencyContact.relation', getPath(profile, 'emergencyContact.relation'))}
            {F('Phone', 'emergencyContact.phone', getPath(profile, 'emergencyContact.phone'), { mono: true })}
          </dl>
        </section>
      </div>
    </div>
  );
}
