/**
 * AdminRecruitment — applicant tracking (admin portal). Manages job openings and
 * candidates through the hiring pipeline (Applied→…→Hired/Rejected) via /recruitment
 * endpoints: jobs CRUD, candidate CRUD + stage moves, interview rounds (schedule,
 * Jitsi/Meet links, feedback), resume download, and offer-letter generation +
 * emailing (through the editable compose modal). Public apply links per job.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import DesignationSelect from '../components/DesignationSelect';
import DepartmentSelect from '../components/DepartmentSelect';
import MailComposeModal from '../components/MailComposeModal';
import { confirmDialog, promptDialog } from '../components/dialogs';

const JOB_STATUS = ['Open', 'OnHold', 'Closed'];
const STAGES = ['Applied', 'Shortlisted', 'Screening', 'Interview', 'Offer', 'Onboarding', 'NewJoinee', 'Hired', 'Rejected'];
const STAGE_STYLES = {
  Applied: 'bg-gray-100 text-gray-700',
  Shortlisted: 'bg-indigo-100 text-indigo-800',
  Screening: 'bg-blue-100 text-blue-800',
  Interview: 'bg-amber-100 text-amber-800',
  Offer: 'bg-purple-100 text-purple-800',
  Onboarding: 'bg-teal-100 text-teal-800',
  NewJoinee: 'bg-cyan-100 text-cyan-800',
  Hired: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-700',
};
// Stages at/after onboarding — the offer/onboard actions no longer apply.
const POST_ONBOARD = ['Onboarding', 'NewJoinee', 'Hired'];

const fmtDateTime = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hour12: true }) : '');
const toDateInput = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const ROUND_STATUS = ['Pending', 'Scheduled', 'Cleared', 'Rejected'];
const ROUND_STYLES = {
  Pending: 'bg-gray-100 text-gray-600',
  Scheduled: 'bg-blue-100 text-blue-700',
  Cleared: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
};
const blankJob = { title: '', department: '', location: '', employmentType: 'FullTime', openings: 1, description: '', status: 'Open' };
const blankCand = { name: '', email: '', phone: '', job: '', stage: 'Applied', rating: 0, notes: '' };

export default function AdminRecruitment() {
  const [jobs, setJobs] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [selectedJob, setSelectedJob] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [jobModal, setJobModal] = useState(false);
  const [jobEditId, setJobEditId] = useState(null);
  const [jobForm, setJobForm] = useState(blankJob);
  const [candModal, setCandModal] = useState(false);
  const [candEditId, setCandEditId] = useState(null);
  const [candForm, setCandForm] = useState(blankCand);
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [meetTimes, setMeetTimes] = useState({}); // per-round chosen datetime (keyed `${candId}:${idx}`)
  const [meetDurations, setMeetDurations] = useState({}); // per-round chosen duration in minutes
  const [meetBusy, setMeetBusy] = useState(''); // key of the round whose Meet link is being created
  const [mail, setMail] = useState(null); // editable compose modal payload

  // Offer-letter modal
  const [offerCand, setOfferCand] = useState(null);
  const [offerForm, setOfferForm] = useState(null);
  const [offerEmail, setOfferEmail] = useState(true);

  // Documents review modal
  const [docsCand, setDocsCand] = useState(null);
  const [docsBusy, setDocsBusy] = useState(false);
  const [docLinkCopied, setDocLinkCopied] = useState(false);

  // Active users available to be assigned as interviewers.
  const [users, setUsers] = useState([]);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [jRes, cRes] = await Promise.all([
        api.get('/recruitment/jobs'),
        api.get(`/recruitment/candidates${selectedJob ? `?job=${selectedJob}` : ''}`),
      ]);
      setJobs(jRes.data.jobs);
      setCandidates(cRes.data.candidates);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [selectedJob]);

  // Load active users once for the interviewer picker.
  useEffect(() => {
    api.get('/admin/users?active=true').then(({ data }) => setUsers(data.users)).catch(() => {});
  }, []);

  // ----- Jobs -----
  const openJobCreate = () => { setJobEditId(null); setJobForm(blankJob); setJobModal(true); };
  const openJobEdit = (j) => {
    setJobEditId(j._id);
    setJobForm({ title: j.title, department: j.department || '', location: j.location || '', employmentType: j.employmentType, openings: j.openings, description: j.description || '', status: j.status });
    setJobModal(true);
  };
  const saveJob = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      if (jobEditId) await api.put(`/recruitment/jobs/${jobEditId}`, jobForm);
      else await api.post('/recruitment/jobs', jobForm);
      setJobModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const removeJob = async (j) => {
    if (!(await confirmDialog({ message: `Delete job "${j.title}" and its candidates?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/recruitment/jobs/${j._id}`); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
  };

  const shareLink = (j) => `${window.location.origin}/apply/${j._id}`;
  const copyShare = async (j) => {
    const link = shareLink(j);
    try { await navigator.clipboard.writeText(link); }
    catch { await promptDialog({ title: 'Copy link', message: 'Copy this application link:', initialValue: link, confirmText: 'Done' }); }
    setCopiedId(j._id);
    setTimeout(() => setCopiedId((c) => (c === j._id ? null : c)), 1600);
  };

  // ----- Candidates -----
  const openCandCreate = () => { setCandEditId(null); setCandForm({ ...blankCand, job: selectedJob || '' }); setCandModal(true); };
  const openCandEdit = (c) => {
    setCandEditId(c._id);
    setCandForm({ name: c.name, email: c.email || '', phone: c.phone || '', job: c.job?._id || '', stage: c.stage, rating: c.rating || 0, notes: c.notes || '' });
    setCandModal(true);
  };
  const saveCand = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      const payload = { ...candForm, job: candForm.job || undefined };
      if (candEditId) await api.put(`/recruitment/candidates/${candEditId}`, payload);
      else await api.post('/recruitment/candidates', payload);
      setCandModal(false); await load();
    } catch (err) { setError(err.response?.data?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  const removeCand = async (c) => {
    if (!(await confirmDialog({ message: `Delete candidate "${c.name}"?`, tone: 'danger', confirmText: 'Delete' }))) return;
    try { await api.delete(`/recruitment/candidates/${c._id}`); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Delete failed'); }
  };

  const setStage = async (c, stage) => {
    try { await api.put(`/recruitment/candidates/${c._id}`, { stage }); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Update failed'); }
  };

  // ----- Shortlist / reject a job's applicants from a modal -----
  const [jobCandJob, setJobCandJob] = useState(null);   // the job whose candidates are shown
  const [jobCands, setJobCands] = useState([]);
  const [jobCandsLoading, setJobCandsLoading] = useState(false);

  const fetchJobCands = async (jobId) => {
    setJobCandsLoading(true);
    try {
      const { data } = await api.get(`/recruitment/candidates?job=${jobId}`);
      setJobCands(data.candidates || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to load candidates');
    } finally {
      setJobCandsLoading(false);
    }
  };

  const openJobCandidates = (job) => {
    setJobCandJob(job);
    setJobCands([]);
    fetchJobCands(job._id);
  };

  // Shortlist or reject from the modal, then refresh both the modal list and the
  // job table (candidate counts / the filtered list below).
  const decideJobCand = async (c, stage) => {
    try {
      await api.put(`/recruitment/candidates/${c._id}`, { stage });
      await Promise.all([fetchJobCands(jobCandJob._id), load()]);
      toast.success(stage === 'Shortlisted' ? `${c.name} shortlisted` : `${c.name} rejected`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Update failed');
    }
  };
  const setRound = async (c, index, patch) => {
    try {
      const { data } = await api.patch(`/recruitment/candidates/${c._id}/round`, { index, ...patch });
      const updated = data.candidate;
      // Update the candidate in place instead of re-fetching the whole list — a
      // full reload re-sorts by updatedAt and makes the row jump, which is jarring
      // while editing. Keep the already-populated `job` (the response returns it
      // as a bare id).
      if (updated) {
        const merge = (list) => list.map((x) => (x._id === c._id ? { ...x, ...updated, job: x.job } : x));
        setCandidates(merge);
        setJobCands((prev) => (prev.length ? merge(prev) : prev));
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Round update failed');
    }
  };

  // An ISO/Date → value for a <input type="datetime-local"> (in local time).
  const toLocalInput = (d) => {
    if (!d) return '';
    const dt = new Date(d);
    return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };

  // Editable preview of the interview-invite email (sent server-side from the
  // company mailbox, résumé attached) for the given round.
  const openInviteModal = (candId, idx, mailData, meetingLink) => {
    setMail({
      to: (mailData.to || []).join(', '),
      showCc: true,
      title: 'Interview invite email',
      link: meetingLink,
      sendLabel: 'Send invite',
      note: "Review and edit the invite below · it's emailed from the company mailbox to the candidate and interviewer, with the candidate's résumé attached. Add more emails in Cc to keep others in the loop.",
      defaultSubject: mailData.subject,
      defaultBody: mailData.body,
      attachedNames: mailData.attachments || [],
      onSend: async ({ subject, body, cc }) => {
        const { data } = await api.post(`/recruitment/candidates/${candId}/round/meet/email`, { index: idx, subject, body, cc });
        const mailed = (data.mailed || []).join(', ');
        toast.success(data.cc?.length ? `Invite emailed to ${mailed} (cc: ${data.cc.join(', ')})` : `Invite emailed to ${mailed}`);
      },
    });
  };

  // Auto-create a real Google Meet for this round, then show the invite email
  // (editable) so HR sends it only after reviewing it.
  const createMeet = async (c, idx) => {
    const key = `${c._id}:${idx}`;
    const local = meetTimes[key];
    const scheduledAt = local ? new Date(local).toISOString() : (c.rounds?.[idx]?.scheduledAt || undefined);
    const durationMinutes = Number(meetDurations[key]) || c.rounds?.[idx]?.meetDurationMinutes || 45;
    if (!c.email && !(await confirmDialog({ message: "This candidate has no email on file, so they won't get the invite. Create the meeting anyway?", confirmText: 'Create anyway' }))) return;
    if (!c.rounds?.[idx]?.interviewer && !(await confirmDialog({ message: "No interviewer is assigned to this round, so they won't be invited. Continue?", confirmText: 'Continue' }))) return;
    setMeetBusy(key);
    try {
      const { data } = await api.post(`/recruitment/candidates/${c._id}/round/meet`, { index: idx, scheduledAt, durationMinutes, sendEmail: false });
      await load();
      toast.success('Google Meet created');
      if (data.mail?.to?.length) openInviteModal(c._id, idx, data.mail, data.meetingLink);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Failed to create Google Meet');
    } finally {
      setMeetBusy('');
    }
  };

  // (Re)send the invite email for a round that already has a meeting link.
  const openInviteMail = async (c, idx) => {
    try {
      const { data } = await api.post(`/recruitment/candidates/${c._id}/round/meet/email`, { index: idx, preview: true });
      openInviteModal(c._id, idx, data, c.rounds?.[idx]?.meetingLink);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not load the invite email');
    }
  };

  const allCleared = (c) => (c.rounds || []).length > 0 && c.rounds.every((r) => r.status === 'Cleared');

  // ----- Offer letter -----
  const openOffer = (c) => {
    setOfferCand(c);
    setOfferEmail(!!c.email);
    const d = c.offer?.data || {};
    setOfferForm({
      position: d.position || c.job?.title || '',
      department: d.department || c.job?.department || '',
      address: d.address || '',
      refInterviewDate: toDateInput(d.refInterviewDate),
      salaryMonthly: d.salaryMonthly || '',
      salaryAnnual: d.salaryAnnual || '',
      probationMonths: d.probationMonths ?? 3,
      noticePeriodDays: d.noticePeriodDays ?? 30,
      joiningDate: toDateInput(d.joiningDate),
      acceptanceDeadline: toDateInput(d.acceptanceDeadline),
      signatoryName: d.signatoryName || '',
      signatoryTitle: d.signatoryTitle || '',
    });
  };
  // Editable compose modal for the offer letter. Fetches the server-rendered
  // preview, then sends from the company mailbox with the offer PDF attached.
  const composeOfferMail = async (c) => {
    if (!c.email) return;
    try {
      const { data } = await api.post(`/recruitment/candidates/${c._id}/letters/offer/email`, { preview: true });
      setMail({
        to: data.to,
        showCc: true,
        title: 'Send Offer Letter',
        link: data.link,
        sendLabel: 'Send offer',
        note: "Review and edit the message below · it's emailed from the company mailbox with the offer letter PDF attached.",
        defaultSubject: data.subject,
        defaultBody: data.body,
        attachedNames: data.attachments || [],
        onSend: async ({ subject, body, cc }) => {
          const { data: r } = await api.post(`/recruitment/candidates/${c._id}/letters/offer/email`, { subject, body, cc });
          toast.success(`Offer letter emailed to ${(r.mailed || [c.email]).join(', ')}`);
          await load();
        },
      });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not prepare the offer email');
    }
  };
  const saveOffer = async (e) => {
    e.preventDefault(); setSaving(true); setError('');
    try {
      const { data } = await api.post(`/recruitment/candidates/${offerCand._id}/offer`, { ...offerForm });
      const wantEmail = offerEmail;
      setOfferCand(null); setOfferForm(null); await load();
      // Emailing goes through the editable compose modal, never silently.
      if (wantEmail && data.candidate?.email && data.candidate?.offer?.token) composeOfferMail(data.candidate);
    } catch (err) { setError(err.response?.data?.message || 'Could not generate offer letter'); }
    finally { setSaving(false); }
  };
  const onboard = async (c) => {
    try { await api.post(`/recruitment/candidates/${c._id}/onboard`); await load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Could not onboard'); }
  };
  const downloadOffer = (c) =>
    downloadFile(`/recruitment/candidates/${c._id}/offer/pdf`, c.offer?.letterName || 'offer-letter.pdf')
      .catch((err) => toast.error(err.response?.data?.message || 'Download failed'));

  // ----- Candidate documents -----
  const docLink = (c) => `${window.location.origin}/submit-documents/${c.documents?.token || ''}`;
  const openDocs = (c) => { setDocsCand(c); setDocLinkCopied(false); };
  const generateDocLink = async (c) => {
    setDocsBusy(true);
    try {
      const { data } = await api.post(`/recruitment/candidates/${c._id}/documents/request`);
      setDocsCand(data.candidate); await load();
    } catch (err) { toast.error(err.response?.data?.message || 'Could not generate link'); }
    finally { setDocsBusy(false); }
  };
  const copyDocLink = async (c) => {
    const link = docLink(c);
    try { await navigator.clipboard.writeText(link); } catch { await promptDialog({ title: 'Copy link', message: 'Copy this link:', initialValue: link, confirmText: 'Done' }); }
    setDocLinkCopied(true);
    setTimeout(() => setDocLinkCopied(false), 1600);
  };
  const confirmDocs = async (c) => {
    setDocsBusy(true);
    try {
      const { data } = await api.post(`/recruitment/candidates/${c._id}/documents/confirm`);
      setDocsCand(data.candidate); await load();
    } catch (err) { toast.error(err.response?.data?.message || 'Could not confirm submission'); }
    finally { setDocsBusy(false); }
  };
  const viewDoc = async (c, fileId) => {
    try {
      const res = await api.get(`/recruitment/candidates/${c._id}/documents/${fileId}`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { toast.error(err.response?.data?.message || 'Could not open document'); }
  };
  const viewResume = async (c) => {
    try {
      const res = await api.get(`/recruitment/candidates/${c._id}/resume`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { toast.error(err.response?.data?.message || 'No resume on file'); }
  };

  // Resume upload/replace: a single hidden file input shared by every row.
  const resumeInputRef = useRef(null);
  const [resumeTarget, setResumeTarget] = useState(null);
  const [resumeBusyId, setResumeBusyId] = useState(null);
  const pickResume = (c) => { setResumeTarget(c._id); resumeInputRef.current?.click(); };
  const onResumePicked = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const id = resumeTarget;
    if (!file || !id) { setResumeTarget(null); return; }
    setResumeBusyId(id);
    try {
      const fd = new FormData();
      fd.append('resume', file);
      await api.post(`/recruitment/candidates/${id}/resume`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Resume upload failed');
    } finally {
      setResumeBusyId(null);
      setResumeTarget(null);
    }
  };

  const roundSummary = (c) => {
    const cleared = (c.rounds || []).filter((r) => r.status === 'Cleared').length;
    return `${cleared}/${(c.rounds || []).length} cleared`;
  };

  // The Candidates table shows only candidates who have been shortlisted (and
  // are therefore in the interview process). Applicants awaiting a decision
  // ('Applied') and rejected ones are handled in the per-job applicants modal.
  const shortlistedCandidates = candidates.filter((c) => c.stage !== 'Applied' && c.stage !== 'Rejected');

  return (
    <div>
      <PageHeader title="Recruitment" subtitle="Post jobs, share the application form, screen candidates & run interviews" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Jobs */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="card-title">Job Openings</h2>
        <button onClick={openJobCreate} className="px-3 py-1.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ New Job</button>
      </div>
      <div className="bg-white shadow rounded-lg overflow-hidden mb-6">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Title</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Dept / Location</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Candidates</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Application Form</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-4"><div className="space-y-2.5"><div className="skeleton h-4 rounded" /><div className="skeleton h-4 rounded w-5/6" /><div className="skeleton h-4 rounded w-2/3" /></div></td></tr>
            ) : jobs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No job openings</td></tr>
            ) : jobs.map((j) => (
              <tr key={j._id} className={selectedJob === j._id ? 'bg-gray-50' : ''}>
                <td className="px-4 py-3 font-medium text-gray-900">{j.title}</td>
                <td className="px-4 py-3 text-gray-600">{j.department || '-'}{j.location ? ` · ${j.location}` : ''}</td>
                <td className="px-4 py-3">
                  <button onClick={() => openJobCandidates(j)}
                    title="Review applicants - shortlist or reject"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline">{j.candidateCount} →</button>
                </td>
                <td className="px-4 py-3 text-gray-600">{j.status}</td>
                <td className="px-4 py-3">
                  {j.status === 'Open' ? (
                    <button
                      onClick={() => copyShare(j)}
                      className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border border-gray-300 hover:bg-gray-50"
                      title={shareLink(j)}
                    >
                      🔗 {copiedId === j._id ? 'Copied!' : 'Copy link'}
                    </button>
                  ) : (
                    <span className="text-xs text-gray-400">Closed</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                  <button onClick={() => openJobEdit(j)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => removeJob(j)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Candidates */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="card-title">
          Candidates {selectedJob && <span className="text-sm text-gray-500">· filtered by job <button onClick={() => setSelectedJob('')} className="text-blue-600 hover:underline">(clear)</button></span>}
        </h2>
        <button onClick={openCandCreate} className="px-3 py-1.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">+ Add Candidate</button>
      </div>
      {/* Shared hidden input for resume upload/replace from any candidate row. */}
      <input ref={resumeInputRef} type="file" accept=".pdf,.doc,.docx" className="hidden" onChange={onResumePicked} />
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50"><tr>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Candidate</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Job</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Resume</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Stage</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Interviews</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {shortlistedCandidates.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No shortlisted candidates yet. Open a job's candidate list and shortlist applicants to start the interview process.</td></tr>
            ) : shortlistedCandidates.map((c) => (
              <Fragment key={c._id}>
                <tr>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 flex items-center gap-2">
                      {c.name}
                      {c.source === 'Application' && <span className="text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">Applied online</span>}
                    </div>
                    <div className="text-xs text-gray-500">{c.email || ''}{c.phone ? ` · ${c.phone}` : ''}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.job?.title || '-'}</td>
                  <td className="px-4 py-3">
                    {resumeBusyId === c._id ? (
                      <span className="text-gray-400 text-xs">Uploading…</span>
                    ) : c.hasResume ? (
                      <div className="flex items-center gap-2">
                        <button onClick={() => viewResume(c)} className="text-blue-600 hover:underline">View</button>
                        <button onClick={() => pickResume(c)} className="text-gray-400 hover:text-gray-700 text-xs">Replace</button>
                      </div>
                    ) : (
                      <button onClick={() => pickResume(c)} className="text-blue-600 hover:underline">Upload</button>
                    )}
                  </td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STAGE_STYLES[c.stage] || ''}`}>{c.stage}</span></td>
                  <td className="px-4 py-3">
                    <button onClick={() => setExpanded(expanded === c._id ? null : c._id)} className="text-blue-600 hover:underline">
                      {roundSummary(c)} {expanded === c._id ? '▾' : '▸'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                    {/* All 4 rounds cleared → share the document-submission link */}
                    {allCleared(c) && c.stage !== 'Rejected' && !POST_ONBOARD.includes(c.stage) && (
                      <button onClick={() => openDocs(c)} className="text-white bg-indigo-600 hover:bg-indigo-700 px-2.5 py-1 rounded-lg">
                        📄 Document Link{c.documents?.submittedAt && !c.documents?.confirmedAt ? ' 🔴' : c.documents?.confirmedAt ? ' ✓' : ''}
                      </button>
                    )}
                    {allCleared(c) && c.documents?.confirmedAt && c.stage !== 'Rejected' && !POST_ONBOARD.includes(c.stage) && !c.offer?.generatedAt && (
                      <button onClick={() => openOffer(c)} className="text-purple-600 font-medium hover:underline">Create Offer Letter</button>
                    )}
                    {c.offer?.generatedAt && !POST_ONBOARD.includes(c.stage) && (
                      <button onClick={() => openOffer(c)} className="text-purple-600 hover:underline">Edit Offer</button>
                    )}
                    {c.offer?.generatedAt && !POST_ONBOARD.includes(c.stage) && (
                      <button onClick={() => onboard(c)} className="text-teal-600 font-medium hover:underline">Onboard →</button>
                    )}
                    {c.offer?.hasLetter && (
                      <button onClick={() => downloadOffer(c)} className="text-gray-600 hover:underline">Offer PDF</button>
                    )}
                    {c.stage === 'Applied' && (
                      <button onClick={() => setStage(c, 'Shortlisted')} className="text-white bg-green-600 hover:bg-green-700 px-2.5 py-1 rounded-lg">Shortlist</button>
                    )}
                    {c.stage !== 'Rejected' && c.stage !== 'Hired' && (
                      <button onClick={() => setStage(c, 'Rejected')} className="text-red-600 hover:underline">Reject</button>
                    )}
                    <button onClick={() => openCandEdit(c)} className="text-blue-600 hover:underline">Edit</button>
                    <button onClick={() => removeCand(c)} className="text-gray-400 hover:text-red-600">✕</button>
                  </td>
                </tr>
                {expanded === c._id && (
                  <tr>
                    <td colSpan={6} className="px-4 pb-4 pt-0 bg-gray-50">
                      {/* Application details */}
                      {(c.currentCompany || c.experienceYears != null || c.noticePeriod || c.expectedCtc || c.coverNote) && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 text-sm">
                          {c.currentCompany && <div><div className="text-xs text-gray-500">Current company</div><div className="text-gray-800">{c.currentCompany}</div></div>}
                          {c.experienceYears != null && <div><div className="text-xs text-gray-500">Experience</div><div className="text-gray-800">{c.experienceYears} yrs</div></div>}
                          {c.noticePeriod && <div><div className="text-xs text-gray-500">Notice period</div><div className="text-gray-800">{c.noticePeriod}</div></div>}
                          {c.expectedCtc && <div><div className="text-xs text-gray-500">Expected CTC</div><div className="text-gray-800">{c.expectedCtc}</div></div>}
                          {c.coverNote && <div className="col-span-2 md:col-span-4"><div className="text-xs text-gray-500">Cover note</div><div className="text-gray-700">{c.coverNote}</div></div>}
                        </div>
                      )}
                      {/* Interview rounds */}
                      <div className="text-xs font-semibold text-gray-600 mb-2">Interview Rounds</div>
                      {c.stage === 'Applied' ? (
                        <div className="flex items-center gap-3 bg-white border border-dashed border-gray-300 rounded-lg px-4 py-4 text-sm text-gray-600">
                          <span>Shortlist this candidate to begin interview rounds.</span>
                          <button onClick={() => setStage(c, 'Shortlisted')} className="px-3 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 text-xs">Shortlist</button>
                        </div>
                      ) : (
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                        {(c.rounds || []).map((r, idx) => (
                          <div key={r._id || idx} className="bg-white border border-gray-200 rounded-lg p-3">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm font-medium text-gray-800">{r.label || `Round ${idx + 1}`}</span>
                              <span className={`text-[11px] px-2 py-0.5 rounded ${ROUND_STYLES[r.status]}`}>{r.status}</span>
                            </div>
                            <select
                              value={r.status}
                              onChange={(e) => setRound(c, idx, { status: e.target.value })}
                              className="block w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm mb-2"
                            >
                              {ROUND_STATUS.map((s) => <option key={s}>{s}</option>)}
                            </select>
                            <select
                              value={r.interviewer || ''}
                              onChange={(e) => setRound(c, idx, { interviewer: e.target.value })}
                              className="block w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm mb-2"
                              title="Assign interviewer"
                            >
                              <option value="">Assign interviewer</option>
                              {users.map((u) => (
                                <option key={u._id} value={u._id}>{u.firstName} {u.lastName}{u.role !== 'Employee' ? ` (${u.role})` : ''}</option>
                              ))}
                            </select>
                            <input
                              defaultValue={r.feedback || ''}
                              onBlur={(e) => { if (e.target.value !== (r.feedback || '')) setRound(c, idx, { feedback: e.target.value }); }}
                              placeholder="Feedback…"
                              className="block w-full border border-gray-200 rounded-lg px-2 py-1 text-xs"
                            />
                            {/* Interview schedule + auto Google Meet for this round */}
                            <div className="mt-2 space-y-1">
                              <input
                                type="datetime-local"
                                defaultValue={toLocalInput(r.scheduledAt)}
                                onChange={(e) => setMeetTimes((m) => ({ ...m, [`${c._id}:${idx}`]: e.target.value }))}
                                onBlur={(e) => {
                                  const v = e.target.value;
                                  const iso = v ? new Date(v).toISOString() : '';
                                  if (iso !== (r.scheduledAt ? new Date(r.scheduledAt).toISOString() : '')) setRound(c, idx, { scheduledAt: iso });
                                }}
                                title="Interview date & time (used for the calendar invite)"
                                className="block w-full border border-gray-200 rounded-lg px-2 py-1 text-xs"
                              />
                              <select
                                value={meetDurations[`${c._id}:${idx}`] ?? (r.meetDurationMinutes || 45)}
                                onChange={(e) => {
                                  const v = Number(e.target.value);
                                  setMeetDurations((m) => ({ ...m, [`${c._id}:${idx}`]: v }));
                                  setRound(c, idx, { meetDurationMinutes: v });
                                }}
                                title="Interview duration (used for the Google Meet / calendar invite)"
                                className="block w-full border border-gray-200 rounded-lg px-2 py-1 text-xs"
                              >
                                {[15, 30, 45, 60, 90, 120].map((min) => (
                                  <option key={min} value={min}>
                                    {min < 60 ? `${min} min` : min === 60 ? '1 hour' : `${min / 60} hours`}
                                  </option>
                                ))}
                              </select>
                              <div className="flex gap-1">
                                <input
                                  defaultValue={r.meetingLink || ''}
                                  onBlur={(e) => { if (e.target.value !== (r.meetingLink || '')) setRound(c, idx, { meetingLink: e.target.value }); }}
                                  placeholder="Meeting link…"
                                  className="block w-full border border-gray-200 rounded-lg px-2 py-1 text-xs"
                                />
                                <button
                                  type="button"
                                  onClick={() => createMeet(c, idx)}
                                  disabled={meetBusy === `${c._id}:${idx}`}
                                  title="Create a Google Meet for this round · you review and edit the invite email before it's sent"
                                  className="shrink-0 text-[11px] px-2 py-1 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap"
                                >{meetBusy === `${c._id}:${idx}` ? '…' : '＋ Meet'}</button>
                              </div>
                              {r.meetingLink && (
                                <div className="mt-1 flex items-center gap-2">
                                  <a href={r.meetingLink} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-600 hover:underline">↗ Join meeting</a>
                                  <button
                                    type="button"
                                    onClick={() => openInviteMail(c, idx)}
                                    title="Preview, edit and (re)send the invite email to the candidate and interviewer"
                                    className="text-[11px] text-indigo-600 hover:underline"
                                  >✉ Email invite</button>
                                </div>
                              )}
                            </div>
                            {/* Audit trail: who last changed the status */}
                            {r.decidedByName && (
                              <div className="mt-1.5 text-[10px] text-gray-400 leading-tight" title={(r.history || []).map((h) => `${h.status} · ${h.byName} (${fmtDateTime(h.at)})`).join('\n')}>
                                Changed by <span className="font-medium text-gray-500">{r.decidedByName}</span>
                                {r.decidedAt ? ` · ${fmtDateTime(r.decidedAt)}` : ''}
                                {(r.history?.length > 1) ? ` · ${r.history.length} changes` : ''}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {jobModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">{jobEditId ? 'Edit Job' : 'New Job'}</h2>
            <form onSubmit={saveJob} className="space-y-3">
              <input required placeholder="Title *" value={jobForm.title} onChange={(e) => setJobForm({ ...jobForm, title: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <DepartmentSelect value={jobForm.department} onChange={(v) => setJobForm({ ...jobForm, department: v })} className="block w-full border rounded-lg px-3 py-2" />
                <input placeholder="Location" value={jobForm.location} onChange={(e) => setJobForm({ ...jobForm, location: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={jobForm.employmentType} onChange={(e) => setJobForm({ ...jobForm, employmentType: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  {['FullTime', 'PartTime', 'Contract', 'Intern'].map((t) => <option key={t}>{t}</option>)}
                </select>
                <input type="number" min="0" placeholder="Openings" value={jobForm.openings} onChange={(e) => setJobForm({ ...jobForm, openings: Number(e.target.value) })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={jobForm.status} onChange={(e) => setJobForm({ ...jobForm, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2 sm:col-span-2">
                  {JOB_STATUS.map((s) => <option key={s}>{s}</option>)}
                </select>
              </div>
              <textarea rows={3} placeholder="Description" value={jobForm.description} onChange={(e) => setJobForm({ ...jobForm, description: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setJobModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {candModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <h2 className="card-title mb-4">{candEditId ? 'Edit Candidate' : 'Add Candidate'}</h2>
            <form onSubmit={saveCand} className="space-y-3">
              <input required placeholder="Name *" value={candForm.name} onChange={(e) => setCandForm({ ...candForm, name: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input placeholder="Email" value={candForm.email} onChange={(e) => setCandForm({ ...candForm, email: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <input placeholder="Phone" value={candForm.phone} onChange={(e) => setCandForm({ ...candForm, phone: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={candForm.job} onChange={(e) => setCandForm({ ...candForm, job: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  <option value="">Job</option>
                  {jobs.map((j) => <option key={j._id} value={j._id}>{j.title}</option>)}
                </select>
                <select value={candForm.stage} onChange={(e) => setCandForm({ ...candForm, stage: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  {STAGES.map((s) => <option key={s}>{s}</option>)}
                </select>
                <select value={candForm.rating} onChange={(e) => setCandForm({ ...candForm, rating: Number(e.target.value) })} className="block w-full border rounded-lg px-3 py-2 sm:col-span-2">
                  {[0, 1, 2, 3, 4, 5].map((r) => <option key={r} value={r}>{r} star{r === 1 ? '' : 's'}</option>)}
                </select>
              </div>
              <textarea rows={3} placeholder="Notes" value={candForm.notes} onChange={(e) => setCandForm({ ...candForm, notes: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setCandModal(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Documents review modal */}
      {docsCand && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between mb-1">
              <h2 className="card-title">Candidate Documents</h2>
              <button onClick={() => setDocsCand(null)} className="text-xl leading-none text-gray-400 hover:text-gray-700">×</button>
            </div>
            <p className="text-sm text-gray-500 mb-4">{docsCand.name}{docsCand.email ? ` · ${docsCand.email}` : ''}</p>

            {/* Submission link */}
            {docsCand.documents?.token ? (
              <div className="mb-4">
                <label className="block text-xs text-gray-600 mb-1">Document submission link (share with candidate)</label>
                <div className="flex gap-2">
                  <input readOnly value={docLink(docsCand)} className="flex-1 border rounded-lg px-3 py-2 text-xs bg-gray-50" onFocus={(e) => e.target.select()} />
                  <button onClick={() => copyDocLink(docsCand)} className="text-xs px-3 py-2 rounded-lg border border-gray-300 hover:bg-gray-50 whitespace-nowrap">{docLinkCopied ? 'Copied!' : 'Copy'}</button>
                </div>
                <button onClick={() => generateDocLink(docsCand)} disabled={docsBusy} className="text-[11px] text-gray-500 hover:underline mt-1">Regenerate link</button>
              </div>
            ) : (
              <button onClick={() => generateDocLink(docsCand)} disabled={docsBusy} className="mb-4 px-3 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                {docsBusy ? 'Generating…' : 'Generate submission link'}
              </button>
            )}

            {/* Status */}
            <div className="mb-3 text-xs">
              {docsCand.documents?.confirmedAt ? (
                <span className="text-green-700 bg-green-50 border border-green-200 px-2 py-1 rounded">✓ Confirmed by {docsCand.documents.confirmedByName} · {fmtDateTime(docsCand.documents.confirmedAt)}</span>
              ) : docsCand.documents?.submittedAt ? (
                <span className="text-amber-800 bg-amber-50 border border-amber-200 px-2 py-1 rounded">Submitted {fmtDateTime(docsCand.documents.submittedAt)} · awaiting your confirmation</span>
              ) : (
                <span className="text-gray-500 bg-gray-50 border border-gray-200 px-2 py-1 rounded">Awaiting the candidate's submission</span>
              )}
            </div>

            {/* Files */}
            <div className="space-y-1.5 mb-4 max-h-60 overflow-y-auto">
              {(docsCand.documents?.files || []).length === 0 ? (
                <div className="text-sm text-gray-400">No documents uploaded yet.</div>
              ) : docsCand.documents.files.map((f) => (
                <div key={f._id} className="flex items-center justify-between gap-2 border border-gray-100 rounded-lg px-3 py-2">
                  <div className="min-w-0">
                    <div className="text-sm text-gray-800 truncate">{f.label}</div>
                    <div className="text-[11px] text-gray-400 truncate">{f.name}{f.sizeBytes ? ` · ${Math.max(1, Math.round(f.sizeBytes / 1024))} KB` : ''}</div>
                  </div>
                  <button onClick={() => viewDoc(docsCand, f._id)} className="text-blue-600 hover:underline text-sm shrink-0">View</button>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setDocsCand(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button>
              {docsCand.documents?.submittedAt && !docsCand.documents?.confirmedAt && (
                <button onClick={() => confirmDocs(docsCand)} disabled={docsBusy} className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">
                  {docsBusy ? 'Confirming…' : 'Confirm submission'}
                </button>
              )}
            </div>
            {docsCand.documents?.confirmedAt && (
              <p className="text-[11px] text-gray-400 mt-2">Documents confirmed · you can now create the offer letter from the candidate's row.</p>
            )}
          </div>
        </div>
      )}

      {/* Offer letter modal */}
      {offerCand && offerForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-2xl p-6">
            <h2 className="card-title mb-1">{offerCand.offer?.generatedAt ? 'Edit Offer Letter' : 'Create Offer Letter'}</h2>
            <p className="text-sm text-gray-500 mb-4">
              For <span className="font-medium text-gray-700">{offerCand.name}</span>{offerCand.email ? ` · ${offerCand.email}` : ''}
              {offerCand.offer?.generatedAt && <span className="block text-xs text-gray-400 mt-0.5">Regenerating replaces the current letter (last issued {fmtDateTime(offerCand.offer.generatedAt)}).</span>}
            </p>
            <form onSubmit={saveOffer} className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-600 mb-1">Candidate address</label>
                <input value={offerForm.address} onChange={(e) => setOfferForm({ ...offerForm, address: e.target.value })} className="block w-full border rounded-lg px-3 py-2" placeholder="e.g. Bangalore, Karnataka" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Position / Designation *</label>
                <DesignationSelect required value={offerForm.position} onChange={(v) => setOfferForm({ ...offerForm, position: v })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Department</label>
                <DepartmentSelect value={offerForm.department} onChange={(v) => setOfferForm({ ...offerForm, department: v })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">In-hand salary (₹ / month)</label>
                <input type="number" min="0" value={offerForm.salaryMonthly} onChange={(e) => setOfferForm({ ...offerForm, salaryMonthly: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Annual salary (₹ / year)</label>
                <input type="number" min="0" value={offerForm.salaryAnnual} onChange={(e) => setOfferForm({ ...offerForm, salaryAnnual: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Probation (months)</label>
                <input type="number" min="0" value={offerForm.probationMonths} onChange={(e) => setOfferForm({ ...offerForm, probationMonths: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Notice period (days)</label>
                <input type="number" min="0" value={offerForm.noticePeriodDays} onChange={(e) => setOfferForm({ ...offerForm, noticePeriodDays: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Interview reference date</label>
                <input type="date" value={offerForm.refInterviewDate} onChange={(e) => setOfferForm({ ...offerForm, refInterviewDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Joining date</label>
                <input type="date" value={offerForm.joiningDate} onChange={(e) => setOfferForm({ ...offerForm, joiningDate: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Acceptance deadline</label>
                <input type="date" value={offerForm.acceptanceDeadline} onChange={(e) => setOfferForm({ ...offerForm, acceptanceDeadline: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Signatory name</label>
                <input value={offerForm.signatoryName} onChange={(e) => setOfferForm({ ...offerForm, signatoryName: e.target.value })} placeholder="defaults to company HR" className="block w-full border rounded-lg px-3 py-2" />
              </div>
              <div>
                <label className="block text-xs text-gray-600 mb-1">Signatory title</label>
                <input value={offerForm.signatoryTitle} onChange={(e) => setOfferForm({ ...offerForm, signatoryTitle: e.target.value })} placeholder="e.g. HR Business Partner" className="block w-full border rounded-lg px-3 py-2" />
              </div>

              <label className={`sm:col-span-2 flex items-center gap-2 text-sm ${offerCand.email ? 'text-gray-700' : 'text-gray-400'}`}>
                <input type="checkbox" checked={offerEmail && !!offerCand.email} disabled={!offerCand.email} onChange={(e) => setOfferEmail(e.target.checked)} />
                Email the offer letter to the candidate · an editable preview opens after generating{!offerCand.email && ' (no email on file)'}
              </label>

              {error && <div className="sm:col-span-2 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}
              <div className="sm:col-span-2 flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => { setOfferCand(null); setOfferForm(null); setError(''); }} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">{saving ? 'Saving…' : (offerCand.offer?.generatedAt ? 'Update Offer Letter' : 'Generate & Save')}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Applicants review modal — shortlist or reject a job's candidates. Only
          shortlisted candidates proceed to the interview process. */}
      {jobCandJob && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center px-4 z-50 overflow-y-auto py-8"
          onMouseDown={() => setJobCandJob(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl overflow-hidden"
            onMouseDown={(e) => e.stopPropagation()}>
            <div className="px-5 pt-5 pb-4 border-b border-gray-100 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold text-gray-900 truncate">Applicants · {jobCandJob.title}</h2>
                <p className="text-xs text-gray-500 mt-0.5">Shortlist to move a candidate into the interview process, or reject.</p>
              </div>
              <button type="button" onClick={() => setJobCandJob(null)}
                className="shrink-0 text-gray-400 hover:text-gray-700 rounded-lg p-1 -mr-1 hover:bg-gray-100 text-xl leading-none">×</button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto px-5 py-4 space-y-2">
              {jobCandsLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="border border-gray-100 rounded-lg p-3 space-y-2">
                    <div className="skeleton h-4 w-1/3 rounded" />
                    <div className="skeleton h-3 w-1/2 rounded" />
                  </div>
                ))
              ) : (() => {
                // Only candidates still awaiting a decision belong here — once
                // shortlisted they've moved into the interview process, so drop
                // them (and everything downstream) from this queue.
                const pending = jobCands.filter((c) => c.stage === 'Applied' || c.stage === 'Rejected');
                if (pending.length === 0) {
                  return <p className="text-sm text-gray-500 text-center py-6">No applicants awaiting a decision.</p>;
                }
                return pending.map((c) => (
                  <div key={c._id} className="border border-gray-100 rounded-lg p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 truncate">{c.name}</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-lg ${STAGE_STYLES[c.stage] || ''}`}>{c.stage}</span>
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {[c.email, c.phone].filter(Boolean).join(' · ') || 'No contact details'}
                      </div>
                    </div>
                    <div className="shrink-0 flex items-center gap-2">
                      {c.hasResume && (
                        <button onClick={() => viewResume(c)}
                          title="Open the candidate's resume in a new tab"
                          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-700 hover:bg-gray-50">Resume</button>
                      )}
                      {c.stage === 'Applied' ? (
                        <>
                          <button onClick={() => decideJobCand(c, 'Shortlisted')}
                            className="text-xs px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700">Shortlist</button>
                          <button onClick={() => decideJobCand(c, 'Rejected')}
                            className="text-xs px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50">Reject</button>
                        </>
                      ) : (
                        <button onClick={() => decideJobCand(c, 'Shortlisted')}
                          className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50">Shortlist instead</button>
                      )}
                    </div>
                  </div>
                ));
              })()}
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-between">
              <p className="text-xs text-gray-400">Only shortlisted candidates move forward to the interview process.</p>
              <button type="button" onClick={() => setJobCandJob(null)}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button>
            </div>
          </div>
        </div>
      )}

      <MailComposeModal open={!!mail} onClose={() => setMail(null)} {...(mail || {})} />
    </div>
  );
}
