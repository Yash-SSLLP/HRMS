import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import MailComposeModal from '../components/MailComposeModal';
import DesignationSelect from '../components/DesignationSelect';
import DepartmentSelect from '../components/DepartmentSelect';

const toDateInput = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString([], { dateStyle: 'medium' }) : '-');
const EMP_TYPES = ['FullTime', 'PartTime', 'Contract', 'Intern'];

const splitName = (full = '') => {
  const parts = String(full).trim().split(/\s+/);
  return { firstName: parts.shift() || '', lastName: parts.join(' ') || '' };
};

export default function AdminNewJoinees() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');

  // Convert modal
  const [cand, setCand] = useState(null);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const [mail, setMail] = useState(null); // editable compose modal payload

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/recruitment/candidates?stage=NewJoinee');
      setRows(data.candidates);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const downloadOffer = (c) =>
    downloadFile(`/recruitment/candidates/${c._id}/offer/pdf`, c.offer?.letterName || 'offer-letter.pdf')
      .catch((err) => toast.error(err.response?.data?.message || 'Download failed'));
  const downloadAppointment = (c) =>
    downloadFile(`/recruitment/candidates/${c._id}/appointment/pdf`, c.appointment?.letterName || 'appointment-letter.pdf')
      .catch((err) => toast.error(err.response?.data?.message || 'Download failed'));

  // Open the editable composer with a public download link inserted; HR can
  // tweak the subject/body before sending from their own mailbox.
  const sendLetter = async (c, kind) => {
    if (!c.email) { setError('This candidate has no email address on file.'); return; }
    setError(''); setInfo('');
    const label = kind === 'offer' ? 'Offer Letter' : 'Letter of Appointment';
    try {
      const { data } = await api.post(`/recruitment/candidates/${c._id}/letters/${kind}/email`, { preview: true });
      setMail({
        to: data.to,
        showCc: true,
        title: `Send ${label}`,
        link: data.link,
        sendLabel: `Send ${label.toLowerCase()}`,
        note: `Review and edit the message below · it's emailed from the company mailbox with the ${label.toLowerCase()} PDF attached.`,
        defaultSubject: data.subject,
        defaultBody: data.body,
        attachedNames: data.attachments || [],
        onSend: async ({ subject, body, cc }) => {
          const { data: r } = await api.post(`/recruitment/candidates/${c._id}/letters/${kind}/email`, { subject, body, cc });
          setInfo(`${label} emailed to ${(r.mailed || [c.email]).join(', ')}.`);
          await load();
        },
      });
    } catch (err) {
      setError(err.response?.data?.message || `Could not prepare the ${label.toLowerCase()} email`);
    }
  };

  const openConvert = async (c) => {
    setError(''); setInfo('');
    const { firstName, lastName } = splitName(c.name);
    const a = c.appointment?.data || {};
    const o = c.offer?.data || {};
    let employeeCode = '';
    try { employeeCode = (await api.get('/lifecycle/next-code')).data.suggestion || ''; } catch { /* optional */ }
    setForm({
      email: c.email || '',
      firstName,
      lastName,
      employeeCode,
      dateOfJoining: toDateInput(c.onboarding?.joiningDate || a.joiningDate || o.joiningDate),
      designation: a.designation || o.position || c.job?.title || '',
      department: a.department || o.department || c.job?.department || '',
      employmentType: c.job?.employmentType || 'FullTime',
      probationMonths: a.probationMonths ?? o.probationMonths ?? 3,
      password: 'Welcome@123',
    });
    setCand(c);
  };

  const saveConvert = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      const { data } = await api.post(`/recruitment/candidates/${cand._id}/convert-to-employee`, form);
      setCand(null); setForm(null);
      setInfo(`${cand.name} is now an employee (code ${data.employeeCode}).` +
        (data.initialPassword ? ` Initial login: ${data.user.email} / ${data.initialPassword} · ask them to change it on first login.` : ''));
      await load();
    } catch (err) { setError(err.response?.data?.message || 'Could not convert to employee'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <PageHeader title="New Joinees" subtitle="Candidates who completed onboarding · convert them into an employee with a login account" />
      {error && !cand && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      {info && <div className="mb-4 text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">{info}</div>}

      {loading ? (
        <div className="text-gray-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-8 text-center text-gray-500">
          No new joinees yet. In <span className="font-medium">Onboarding</span>, release a candidate's appointment letter to move them here.
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((c) => (
            <div key={c._id} className="bg-white shadow rounded-lg p-4 flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-gray-900">{c.name}</div>
                <div className="text-xs text-gray-500">{c.job?.title || '-'}{c.email ? ` · ${c.email}` : ' · no email on file'}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">
                  Joining {fmtDate(c.onboarding?.joiningDate)}
                  {c.appointment?.generatedAt ? ` · appointment letter issued ${fmtDate(c.appointment.generatedAt)}` : ''}
                </div>
              </div>
              <div className="flex flex-col items-stretch sm:items-end gap-2">
                {/* Offer letter */}
                <div className="flex items-center gap-2 justify-end flex-wrap">
                  {c.offer?.emailedAt && <span className="text-[10px] text-gray-400">already sent {fmtDate(c.offer.emailedAt)}</span>}
                  {c.offer?.hasLetter && (
                    <button onClick={() => downloadOffer(c)} className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 hover:bg-gray-50">Offer PDF</button>
                  )}
                  <button
                    onClick={() => sendLetter(c, 'offer')}
                    disabled={!c.offer?.hasLetter || !c.email}
                    title={!c.email ? 'No email on file for this candidate' : 'Email the offer letter to the candidate'}
                    className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {c.offer?.emailedAt ? 'Resend Offer Letter' : 'Send Offer Letter'}
                  </button>
                </div>
                {/* Appointment letter */}
                <div className="flex items-center gap-2 justify-end flex-wrap">
                  {c.appointment?.emailedAt && <span className="text-[10px] text-gray-400">already sent {fmtDate(c.appointment.emailedAt)}</span>}
                  {c.appointment?.hasLetter && (
                    <button onClick={() => downloadAppointment(c)} className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 hover:bg-gray-50">Appointment PDF</button>
                  )}
                  <button
                    onClick={() => sendLetter(c, 'appointment')}
                    disabled={!c.appointment?.hasLetter || !c.email}
                    title={!c.email ? 'No email on file for this candidate' : 'Email the appointment letter to the candidate'}
                    className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {c.appointment?.emailedAt ? 'Resend Appointment Letter' : 'Send Appointment Letter'}
                  </button>
                </div>
                <button onClick={() => openConvert(c)} className="text-xs px-2.5 py-1 rounded-lg bg-gray-900 text-white hover:bg-gray-700">Make Employee &amp; User</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Convert-to-employee modal */}
      {cand && form && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-xl p-6">
            <h2 className="card-title mb-1">Make Employee &amp; User</h2>
            <p className="text-sm text-gray-500 mb-4">Creates a login account and employee profile for <span className="font-medium text-gray-700">{cand.name}</span>.</p>
            <form onSubmit={saveConvert} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-600 mb-1">Login email *</label>
                <input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">First name *</label>
                <input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Last name</label>
                <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Employee code *</label>
                <input required value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Date of joining *</label>
                <input type="date" required value={form.dateOfJoining} onChange={(e) => setForm({ ...form, dateOfJoining: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Designation</label>
                <DesignationSelect value={form.designation} onChange={(v) => setForm({ ...form, designation: v })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Department</label>
                <DepartmentSelect value={form.department} onChange={(v) => setForm({ ...form, department: v })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Employment type</label>
                <select value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  {EMP_TYPES.map((t) => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Probation (months)</label>
                <input type="number" min="0" value={form.probationMonths} onChange={(e) => setForm({ ...form, probationMonths: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-600 mb-1">Initial password</label>
                <input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <p className="text-[11px] text-gray-400 mt-1">The joinee should change this after their first login.</p>
              </div>

              {error && <div className="sm:col-span-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="sm:col-span-2 flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => { setCand(null); setForm(null); setError(''); }} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Creating…' : 'Create employee'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <MailComposeModal open={!!mail} onClose={() => setMail(null)} {...(mail || {})} />
    </div>
  );
}
