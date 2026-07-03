import { useEffect, useState } from 'react';
import api from '../api/client';
import { downloadFile } from '../api/download';
import { COMPANY_NAME } from '../config/company';
import PageHeader from '../components/PageHeader';
import MailComposeModal from '../components/MailComposeModal';
import DesignationSelect from '../components/DesignationSelect';

const toDateInput = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString([], { dateStyle: 'medium' }) : '-');

const APPT_NUM_FIELDS = [
  ['ctcAnnual', 'Annual CTC (₹)'],
  ['basic', 'Basic Pay (₹)'],
  ['hra', 'HRA (₹)'],
  ['specialAllowance', 'Special Allowance (₹)'],
  ['conveyance', 'Conveyance (₹)'],
  ['otherAllowances', 'Other Allowances (₹)'],
  ['employerPf', 'Employer PF (₹)'],
  ['gratuity', 'Gratuity (₹)'],
];

export default function AdminHiringOnboarding() {
  const [rows, setRows] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [savingId, setSavingId] = useState(null);
  const [mail, setMail] = useState(null); // editable compose modal payload

  // Appointment-letter modal
  const [apptCand, setApptCand] = useState(null);
  const [apptForm, setApptForm] = useState(null);
  const [apptEmail, setApptEmail] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/recruitment/candidates?stage=Onboarding');
      setRows(data.candidates);
      const d = {};
      data.candidates.forEach((c) => {
        d[c._id] = {
          joiningDate: toDateInput(c.onboarding?.joiningDate),
          noticePeriod: c.onboarding?.noticePeriod || '',
          notes: c.onboarding?.notes || '',
        };
      });
      setDrafts(d);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const setDraft = (id, patch) => setDrafts((p) => ({ ...p, [id]: { ...p[id], ...patch } }));

  const saveOnboarding = async (c) => {
    setSavingId(c._id); setError('');
    try {
      await api.patch(`/recruitment/candidates/${c._id}/onboarding`, drafts[c._id]);
      await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSavingId(null); }
  };

  const downloadOffer = (c) =>
    downloadFile(`/recruitment/candidates/${c._id}/offer/pdf`, c.offer?.letterName || 'offer-letter.pdf')
      .catch((err) => alert(err.response?.data?.message || 'Download failed'));
  const downloadAppointment = (c) =>
    downloadFile(`/recruitment/candidates/${c._id}/appointment/pdf`, c.appointment?.letterName || 'appointment-letter.pdf')
      .catch((err) => alert(err.response?.data?.message || 'Download failed'));

  // Email a generated letter: open the editable composer with a public download
  // link already inserted. HR can tweak the subject/body before sending.
  const sendLetter = (c, kind) => {
    const letter = c[kind];
    if (!c.email) { setError('This candidate has no email address on file.'); return; }
    if (!letter?.token) { setError(`Please regenerate the ${kind === 'offer' ? 'offer' : 'appointment'} letter to get a shareable download link.`); return; }
    setError(''); setInfo('');
    const label = kind === 'offer' ? 'Offer Letter' : 'Letter of Appointment';
    const link = `${window.location.origin}/letter/${letter.token}`;
    setMail({
      to: c.email,
      title: `Send ${label}`,
      link,
      defaultSubject: `${label} · ${COMPANY_NAME}`,
      defaultBody:
        `Dear ${c.name},\n\n` +
        `Please find your ${label} from ${COMPANY_NAME}. You can view and download it from the link below:\n\n` +
        `${link}\n\n` +
        `Kindly review the document and revert with your acceptance.\n\n` +
        `Warm regards,`,
      onSent: async () => {
        await api.post(`/recruitment/candidates/${c._id}/${kind}/mark-sent`);
        setInfo(`Compose window opened for ${c.email} with the ${label.toLowerCase()} link.`);
        await load();
      },
    });
  };

  // ----- Appointment letter -----
  const openAppt = (c) => {
    setApptCand(c);
    setApptEmail(!!c.email);
    const a = c.appointment?.data || {};
    const o = c.offer?.data || {};
    setApptForm({
      designation: a.designation || o.position || c.job?.title || '',
      department: a.department || o.department || c.job?.department || '',
      reportingManager: a.reportingManager || '',
      location: a.location || '',
      workingHours: a.workingHours || '',
      joiningDate: toDateInput(a.joiningDate || c.onboarding?.joiningDate || o.joiningDate),
      probationMonths: a.probationMonths ?? o.probationMonths ?? 3,
      noticePeriodDays: a.noticePeriodDays ?? o.noticePeriodDays ?? 30,
      ctcAnnual: a.ctcAnnual ?? o.salaryAnnual ?? '',
      basic: a.basic ?? '',
      hra: a.hra ?? '',
      specialAllowance: a.specialAllowance ?? '',
      conveyance: a.conveyance ?? '',
      otherAllowances: a.otherAllowances ?? '',
      employerPf: a.employerPf ?? '',
      gratuity: a.gratuity ?? '',
      signatoryName: a.signatoryName || '',
      signatoryTitle: a.signatoryTitle || '',
    });
  };
  const saveAppt = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      const { data } = await api.post(`/recruitment/candidates/${apptCand._id}/appointment`, { ...apptForm });
      const wantEmail = apptEmail;
      setApptCand(null); setApptForm(null); await load();
      // Emailing goes through the editable compose modal, never silently.
      if (wantEmail && data.candidate?.email && data.candidate?.appointment?.token) sendLetter(data.candidate, 'appointment');
    } catch (err) { setError(err.response?.data?.message || 'Could not generate appointment letter'); }
    finally { setSaving(false); }
  };

  return (
    <div>
      <PageHeader title="Onboarding" subtitle="Candidates who cleared interviews & received an offer · set joining details and release the appointment letter" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
      {info && <div className="mb-4 text-sm text-green-800 bg-green-50 border border-green-200 px-3 py-2 rounded-lg">{info}</div>}

      {loading ? (
        <div className="text-gray-500">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-8 text-center text-gray-500">
          No candidates in onboarding yet. In <span className="font-medium">Recruitment</span>, generate an offer letter and click <span className="font-medium">Onboard</span>.
        </div>
      ) : (
        <div className="space-y-4">
          {rows.map((c) => (
            <div key={c._id} className="bg-white shadow rounded-lg p-4">
              <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
                <div>
                  <div className="font-semibold text-gray-900">{c.name}</div>
                  <div className="text-xs text-gray-500">{c.job?.title || '-'}{c.email ? ` · ${c.email}` : ''}</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">
                    Onboarding since {fmtDate(c.onboarding?.startedAt)}{c.onboarding?.startedByName ? ` · by ${c.onboarding.startedByName}` : ''}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {c.offer?.emailedAt && <span className="text-[10px] text-gray-400">offer already sent {fmtDate(c.offer.emailedAt)}</span>}
                  {c.offer?.hasLetter && (
                    <button onClick={() => downloadOffer(c)} className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 hover:bg-gray-50">Offer PDF</button>
                  )}
                  {c.offer?.hasLetter && (
                    <button
                      onClick={() => sendLetter(c, 'offer')}
                      disabled={!c.email}
                      title={!c.email ? 'No email on file for this candidate' : 'Email the offer letter to the candidate'}
                      className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {c.offer?.emailedAt ? 'Resend Offer Letter' : 'Send Offer Letter'}
                    </button>
                  )}
                  {c.appointment?.hasLetter && (
                    <button onClick={() => downloadAppointment(c)} className="text-xs px-2.5 py-1 rounded-lg border border-gray-300 hover:bg-gray-50">Appointment PDF</button>
                  )}
                  {c.appointment?.hasLetter && (
                    <button
                      onClick={() => sendLetter(c, 'appointment')}
                      disabled={!c.email}
                      title={!c.email ? 'No email on file for this candidate' : 'Email the appointment letter to the candidate'}
                      className="text-xs px-2.5 py-1 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                    >
                      {c.appointment?.emailedAt ? 'Resend Appointment Letter' : 'Send Appointment Letter'}
                    </button>
                  )}
                  <button onClick={() => openAppt(c)} className="text-xs px-2.5 py-1 rounded-lg bg-gray-900 text-white hover:bg-gray-700">
                    {c.appointment?.generatedAt ? 'Re-issue Appointment Letter' : 'Release Appointment Letter'}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Joining date</label>
                  <input type="date" value={drafts[c._id]?.joiningDate || ''} onChange={(e) => setDraft(c._id, { joiningDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Notice period</label>
                  <input value={drafts[c._id]?.noticePeriod || ''} onChange={(e) => setDraft(c._id, { noticePeriod: e.target.value })} placeholder="e.g. 30 days / serving" className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div className="lg:col-span-2">
                  <label className="block text-xs text-gray-600 mb-1">Notes</label>
                  <input value={drafts[c._id]?.notes || ''} onChange={(e) => setDraft(c._id, { notes: e.target.value })} placeholder="Internal notes" className="block w-full border rounded-lg px-3 py-2 text-sm" />
                </div>
                <div className="sm:col-span-2 lg:col-span-4 flex justify-end">
                  <button onClick={() => saveOnboarding(c)} disabled={savingId === c._id} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {savingId === c._id ? 'Saving…' : 'Save joining details'}
                  </button>
                </div>
              </div>

              {c.appointment?.generatedAt && (
                <div className="mt-2 text-[11px] text-gray-400">
                  Appointment letter issued {fmtDate(c.appointment.generatedAt)}{c.appointment.generatedByName ? ` by ${c.appointment.generatedByName}` : ''}{c.appointment.emailedAt ? ' · emailed' : ''}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Appointment letter modal */}
      {apptCand && apptForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-1">Release Appointment Letter</h2>
            <p className="text-sm text-gray-500 mb-4">For <span className="font-medium text-gray-700">{apptCand.name}</span>{apptCand.email ? ` · ${apptCand.email}` : ''}</p>
            <form onSubmit={saveAppt} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-600 mb-1">Designation *</label>
                <DesignationSelect required value={apptForm.designation} onChange={(v) => setApptForm({ ...apptForm, designation: v })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Department</label>
                <input value={apptForm.department} onChange={(e) => setApptForm({ ...apptForm, department: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Reporting manager</label>
                <input value={apptForm.reportingManager} onChange={(e) => setApptForm({ ...apptForm, reportingManager: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Place of posting</label>
                <input value={apptForm.location} onChange={(e) => setApptForm({ ...apptForm, location: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-600 mb-1">Working hours</label>
                <input value={apptForm.workingHours} onChange={(e) => setApptForm({ ...apptForm, workingHours: e.target.value })} placeholder="e.g. 9:30 AM – 6:30 PM, Mon–Sat" className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Joining date</label>
                <input type="date" value={apptForm.joiningDate} onChange={(e) => setApptForm({ ...apptForm, joiningDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Probation (months)</label>
                  <input type="number" min="0" value={apptForm.probationMonths} onChange={(e) => setApptForm({ ...apptForm, probationMonths: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Notice (days)</label>
                  <input type="number" min="0" value={apptForm.noticePeriodDays} onChange={(e) => setApptForm({ ...apptForm, noticePeriodDays: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
              </div>

              <div className="sm:col-span-2 mt-1 text-xs font-semibold text-gray-600">CTC breakup (Annexure A) · annual ₹</div>
              {APPT_NUM_FIELDS.map(([key, label]) => (
                <div key={key}>
                  <label className="block text-xs text-gray-600 mb-1">{label}</label>
                  <input type="number" min="0" value={apptForm[key]} onChange={(e) => setApptForm({ ...apptForm, [key]: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                </div>
              ))}

              <div>
                <label className="block text-xs text-gray-600 mb-1">Signatory name</label>
                <input value={apptForm.signatoryName} onChange={(e) => setApptForm({ ...apptForm, signatoryName: e.target.value })} placeholder="defaults to company HR" className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Signatory title</label>
                <input value={apptForm.signatoryTitle} onChange={(e) => setApptForm({ ...apptForm, signatoryTitle: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>

              <label className={`sm:col-span-2 flex items-center gap-2 text-sm ${apptCand.email ? 'text-gray-700' : 'text-gray-400'}`}>
                <input type="checkbox" checked={apptEmail && !!apptCand.email} disabled={!apptCand.email} onChange={(e) => setApptEmail(e.target.checked)} />
                Email the appointment letter to the candidate · an editable preview opens after generating{!apptCand.email && ' (no email on file)'}
              </label>

              {error && <div className="sm:col-span-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="sm:col-span-2 flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => { setApptCand(null); setApptForm(null); setError(''); }} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Generating…' : 'Generate & Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <MailComposeModal open={!!mail} onClose={() => setMail(null)} {...(mail || {})} />
    </div>
  );
}
