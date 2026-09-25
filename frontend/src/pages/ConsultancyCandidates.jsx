/**
 * ConsultancyCandidates — the HR consultancy flow, from both sides.
 *
 * ONE page, two viewers, because both are looking at the same thing: candidates
 * an outside HR consultancy sent in, sorted by the verdict of the Round 1
 * interview the consultancy takes itself.
 *
 *   • The CONSULTANCY (role HRConsultancy) adds a candidate to one of the
 *     company's open jobs, then takes Round 1 and records it — ratings,
 *     strengths, concerns, a recommendation — with the same form every other
 *     interviewer uses, ending in SHORTLIST or REJECT. That verdict is final.
 *     After a shortlist the company books Rounds 2-4; the agency sees each one's
 *     time and meeting link here and can JOIN it, but never writes it up.
 *   • The COMPANY — HR with any recruitment capability, CEO/MD, the Backend and
 *     God — sees every consultancy's candidates in the same three sections, plus
 *     where each one has got to since (stage, later rounds), and can filter by
 *     consultancy and job.
 *
 * The three sections — Awaiting Round 1, Cleared, Rejected — are the ask:
 * rejected and cleared candidates are kept apart, and all of the people above
 * see both. The server decides the section (consultancyController sectionOf);
 * this page only counts and draws them.
 *
 * API: GET /recruitment/consultancy/candidates (both viewers),
 * GET /recruitment/consultancy/jobs, POST/PUT /recruitment/consultancy/candidates,
 * PATCH …/:id/round1 (consultancy only), GET …/:id/resume (both).
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { FiPlus, FiFileText, FiEdit2, FiClock, FiCheckCircle, FiXCircle, FiSearch, FiArrowRight, FiVideo } from 'react-icons/fi';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import { confirmDialog } from '../components/dialogs';
import { useAuthStore } from '../store/authStore';
import { useTabParam } from '../hooks/useTabParam';
import { useViewOnly } from '../hooks/useViewOnly';
import { isExternalAccount, hasPermission } from '../config/permissions';
import { formatDateTime12 } from '../utils/time';
import {
  AssessmentForm, AssessmentView, PriorRejectionChip, PriorRejections, RoundBadge,
  ROUND_STATUS_STYLES, roundStatusLabel, assessmentOf, hasAssessment, SUGGESTED_REMARK_CHARS,
} from '../components/InterviewAssessment';

// The ids are the server's (consultancyController sectionOf); the labels are
// the words the agency uses — a Round 1 pass is a SHORTLIST.
const SECTIONS = [
  { id: 'pending', label: 'Awaiting Round 1', icon: FiClock },
  { id: 'cleared', label: 'Shortlisted', icon: FiCheckCircle },
  { id: 'rejected', label: 'Rejected', icon: FiXCircle },
];
const SECTION_IDS = SECTIONS.map((s) => s.id);

// What a consultancy can say about Round 1. 'Pending' is "not decided yet" —
// the write-up can be saved before the verdict is. Shortlist is stored as the
// round's Cleared, which is what moves the candidate on in HR's pipeline.
const VERDICTS = [
  { status: 'Cleared', label: 'Shortlist' },
  { status: 'Rejected', label: 'Reject' },
  { status: 'Pending', label: 'Not decided yet' },
];
const DECIDED = ['Cleared', 'Rejected'];
// A round status in the agency's words.
const ROUND_WORDS = { Cleared: 'Shortlisted' };
const roundWord = (status) => ROUND_WORDS[status] || status || 'Pending';

// The pipeline stage, as HR's Recruitment page paints it.
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
const STAGE_LABELS = { NewJoinee: 'New Joinee' };

const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const blankForm = {
  job: '', location: '', name: '', email: '', phone: '',
  currentCompany: '', experienceYears: '', noticePeriod: '', currentCtc: '', expectedCtc: '', notes: '',
};

// The Round 1 write-up while it is being edited — split from the server copy so
// a half-typed assessment survives a background refresh.
const draftOf = (c) => ({
  status: c.round1?.status === 'Scheduled' ? 'Pending' : (c.round1?.status || 'Pending'),
  feedback: c.round1?.feedback || '',
  assessment: assessmentOf(c.round1),
});

export default function ConsultancyCandidates() {
  const user = useAuthStore((s) => s.user);
  const external = isExternalAccount(user);
  const viewOnly = useViewOnly();
  // May this company viewer carry a cleared candidate on to Round 2?
  const canContinue = !external && !viewOnly && hasPermission(user, 'recruitment.interviews');

  const [rows, setRows] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [loading, setLoading] = useState(true);       // first load only (skeleton)
  const [refreshing, setRefreshing] = useState(false); // later loads (no layout change)
  const [error, setError] = useState('');
  const [section, setSection] = useTabParam('pending', SECTION_IDS);
  const [q, setQ] = useState('');
  const [agencyFilter, setAgencyFilter] = useState('');
  const [jobFilter, setJobFilter] = useState('');

  // Consultancy only: the open jobs it can add to, the add/edit form, and the
  // Round 1 write-up drafts.
  const [jobs, setJobs] = useState([]);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null); // the row being edited, or null for "add"
  const [form, setForm] = useState(blankForm);
  const [resume, setResume] = useState(null);
  const [saving, setSaving] = useState(false);
  const [openId, setOpenId] = useState('');     // candidate whose Round 1 form is open
  const [drafts, setDrafts] = useState({});
  const [savingId, setSavingId] = useState('');

  const load = async ({ first = false } = {}) => {
    if (first) setLoading(true); else setRefreshing(true);
    setError('');
    try {
      const [cand, jobRes] = await Promise.all([
        api.get('/recruitment/consultancy/candidates'),
        external ? api.get('/recruitment/consultancy/jobs') : Promise.resolve(null),
      ]);
      setRows(cand.data.candidates || []);
      setAgencies(cand.data.consultancies || []);
      if (jobRes) setJobs(jobRes.data.jobs || []);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load the candidates');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load({ first: true }); }, []);

  // Arriving from Job Openings with "Add a candidate" (?add=<jobId>): open the
  // form on that job once the jobs are in, then drop the parameter so a reload
  // does not open it again.
  const [params, setParams] = useSearchParams();
  const addFor = params.get('add');
  useEffect(() => {
    if (!external || !addFor || loading) return;
    openAdd(addFor);
    const next = new URLSearchParams(params);
    next.delete('add');
    setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [external, addFor, loading]);

  // Swap one server row into the list (after an add, edit or verdict).
  const upsertRow = (row) => setRows((list) => {
    const i = list.findIndex((r) => r._id === row._id);
    if (i === -1) return [row, ...list];
    const next = list.slice();
    next[i] = row;
    return next;
  });

  // ----- Filters (client-side: the whole board is already loaded) -----
  const jobOptions = useMemo(() => {
    const m = new Map();
    rows.forEach((r) => { if (r.job?._id && !m.has(r.job._id)) m.set(r.job._id, r.job.title || 'Untitled job'); });
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (agencyFilter && String(r.consultancy?.user || '') !== agencyFilter) return false;
      if (jobFilter && r.job?._id !== jobFilter) return false;
      if (!term) return true;
      return [r.name, r.email, r.phone, r.job?.title, r.location, r.consultancy?.name]
        .some((v) => String(v || '').toLowerCase().includes(term));
    });
  }, [rows, q, agencyFilter, jobFilter]);

  const counts = useMemo(() => {
    const c = { pending: 0, cleared: 0, rejected: 0 };
    filtered.forEach((r) => { c[r.section] = (c[r.section] || 0) + 1; });
    return c;
  }, [filtered]);

  const shown = useMemo(() => {
    const list = filtered.filter((r) => r.section === section);
    // The queue stays newest-added first (the server's order); the decided
    // sections put the most recent verdict on top.
    if (section === 'pending') return list;
    return list.slice().sort((a, b) =>
      new Date(b.round1?.decidedAt || b.createdAt) - new Date(a.round1?.decidedAt || a.createdAt));
  }, [filtered, section]);

  // ----- Add / edit (consultancy) -----
  const selectedJob = jobs.find((j) => j._id === form.job) || null;
  const jobPlaces = editing ? [] : (selectedJob?.locations || []);

  const openAdd = (jobId = '') => {
    const job = jobs.find((j) => j._id === jobId);
    setEditing(null);
    // A job chosen up front (from Job Openings) comes with its only location
    // already picked, the same as choosing it in the form would.
    setForm(job
      ? { ...blankForm, job: job._id, location: job.locations?.length === 1 ? job.locations[0] : '' }
      : blankForm);
    setResume(null);
    setFormOpen(true);
  };
  const openEdit = (r) => {
    setEditing(r);
    setForm({
      job: r.job?._id || '',
      location: r.location || '',
      name: r.name || '',
      email: r.email || '',
      phone: r.phone || '',
      currentCompany: r.currentCompany || '',
      experienceYears: r.experienceYears ?? '',
      noticePeriod: r.noticePeriod || '',
      currentCtc: r.currentCtc || '',
      expectedCtc: r.expectedCtc || '',
      notes: r.notes || '',
    });
    setResume(null);
    setFormOpen(true);
  };

  const submitForm = async (e) => {
    e.preventDefault();
    if (!editing && !resume) {
      toast.error("Attach the candidate's résumé.");
      return;
    }
    const fd = new FormData();
    const keys = editing
      ? ['name', 'email', 'phone', 'currentCompany', 'experienceYears', 'noticePeriod', 'currentCtc', 'expectedCtc', 'notes']
      : Object.keys(blankForm);
    keys.forEach((k) => fd.append(k, form[k] ?? ''));
    if (resume) fd.append('resume', resume);
    setSaving(true);
    try {
      const multipart = { headers: { 'Content-Type': 'multipart/form-data' } };
      const { data } = editing
        ? await api.put(`/recruitment/consultancy/candidates/${editing._id}`, fd, multipart)
        : await api.post('/recruitment/consultancy/candidates', fd, multipart);
      upsertRow(data.candidate);
      setFormOpen(false);
      if (!editing) setSection('pending');
      toast.success(editing ? 'Details updated' : `${data.candidate.name} added — record Round 1 when you have interviewed them`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save the candidate');
    } finally {
      setSaving(false);
    }
  };

  // ----- Round 1 (consultancy) -----
  const toggleRound = (r) => {
    if (openId === r._id) { setOpenId(''); return; }
    setDrafts((p) => ({ ...p, [r._id]: p[r._id] || draftOf(r) }));
    setOpenId(r._id);
  };

  const saveRound = async (r) => {
    const draft = drafts[r._id] || draftOf(r);
    const current = r.round1?.status || 'Pending';
    const changing = draft.status !== current && !(draft.status === 'Pending' && current === 'Scheduled');
    // A verdict is FINAL — it cannot be changed from here afterwards — so both
    // get a moment's pause, and a rejection says what else it starts.
    if (changing && DECIDED.includes(draft.status)) {
      const shortlisting = draft.status === 'Cleared';
      const ok = await confirmDialog({
        title: shortlisting ? `Shortlist ${r.name}?` : `Reject ${r.name}?`,
        message: shortlisting
          ? 'HR is told, and schedules the next rounds — you can join them from here. The Round 1 result cannot be changed afterwards.'
          : 'They move to Rejected and cannot be put forward for this job again for 3 months. This cannot be changed afterwards.',
        confirmText: shortlisting ? 'Shortlist' : 'Reject',
        tone: shortlisting ? 'default' : 'danger',
      });
      if (!ok) return;
    }
    setSavingId(r._id);
    try {
      const { data } = await api.patch(`/recruitment/consultancy/candidates/${r._id}/round1`, {
        ...(changing ? { status: draft.status } : {}),
        feedback: draft.feedback,
        assessment: draft.assessment,
      });
      upsertRow(data.candidate);
      setDrafts((p) => ({ ...p, [r._id]: draftOf(data.candidate) }));
      if (changing && DECIDED.includes(draft.status)) {
        setOpenId('');
        toast.success(draft.status === 'Cleared'
          ? `${r.name} shortlisted — HR will schedule the next round`
          : `${r.name} rejected at Round 1`);
      } else {
        toast.success('Round 1 saved');
      }
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save Round 1');
    } finally {
      setSavingId('');
    }
  };

  const viewResume = (r) =>
    downloadFile(`/recruitment/consultancy/candidates/${r._id}/resume`, `${r.name.replace(/\s+/g, '_')}_resume.pdf`)
      .catch((err) => toast.error(err.response?.data?.message || 'Could not open the résumé'));

  // ----- Rendering -----
  const detail = (label, value) => (value || value === 0) && (
    <div className="min-w-0">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className="text-sm text-gray-800 break-words">{value}</div>
    </div>
  );

  const card = (r) => {
    const r1 = r.round1 || {};
    const open = openId === r._id;
    const draft = drafts[r._id] || draftOf(r);
    const setDraft = (patch) => setDrafts((p) => ({ ...p, [r._id]: { ...draft, ...patch } }));
    const suggest = r.suggestedRemarkChars || SUGGESTED_REMARK_CHARS;
    const current = r1.status || 'Pending';
    const decidingNow = DECIDED.includes(draft.status) && draft.status !== current;
    const saveLabel = savingId === r._id ? 'Saving…'
      : decidingNow ? (draft.status === 'Cleared' ? 'Shortlist candidate' : 'Reject candidate')
        : 'Save write-up';
    // Rounds 2-4 once the candidate is shortlisted — for the agency to JOIN,
    // and for the company to follow. The server sends the agency only these.
    const laterRounds = r.section === 'cleared'
      ? (r.rounds || []).filter((x) => x.index >= 1)
      : [];

    return (
      <div key={r._id} className="bg-white shadow rounded-lg p-4">
        {/* Who, and for what */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 grow basis-64">
            <div className="font-semibold text-gray-900 flex flex-wrap items-center gap-2">
              <span className="break-words">{r.name}</span>
              {!external && <PriorRejectionChip flag={r.priorRejection} />}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              {[r.job?.title || 'No job', r.location].filter(Boolean).join(' · ')}
              {!external && r.consultancy?.name ? ` · via ${r.consultancy.name}` : ''}
              {` · Added ${fmtDate(r.consultancy?.addedAt || r.createdAt)}`}
            </div>
            {(r.email || r.phone) && (
              <div className="text-xs text-gray-500 mt-0.5 break-words">{[r.email, r.phone].filter(Boolean).join(' · ')}</div>
            )}
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
            {/* The agency sees its own round; the company sees where the
                candidate is NOW (Round 1 is in the rounds row below). */}
            {external ? (
              <span className={`text-[11px] px-2 py-0.5 rounded ${ROUND_STATUS_STYLES[current] || ROUND_STATUS_STYLES.Pending}`}>
                Round 1 · {roundWord(current)}
              </span>
            ) : r.stage && (
              <span className={`text-[11px] px-2 py-0.5 rounded ${STAGE_STYLES[r.stage] || STAGE_STYLES.Applied}`}
                title="Current stage in the company's pipeline">
                Stage · {STAGE_LABELS[r.stage] || r.stage}
              </span>
            )}
          </div>
        </div>

        {/* What the consultancy told us about them */}
        {(r.currentCompany || r.experienceYears != null || r.noticePeriod || r.currentCtc || r.expectedCtc) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
            {detail('Current company', r.currentCompany)}
            {detail('Experience', r.experienceYears != null && r.experienceYears !== '' ? `${r.experienceYears} yrs` : '')}
            {detail('Notice period', r.noticePeriod)}
            {detail('Current in-hand CTC', r.currentCtc)}
            {detail('Expected CTC', r.expectedCtc)}
          </div>
        )}
        {r.notes && (
          <div className="mt-3 text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2 break-words">
            <span className="text-[11px] text-gray-500 block">{external ? 'Your notes' : 'Notes from the consultancy'}</span>
            {r.notes}
          </div>
        )}

        {/* The rounds after the shortlist: when, with whom, and the link to
            join. Booked by the company only; the agency joins, never writes up. */}
        {laterRounds.length > 0 && (
          <div className="mt-3">
            <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              {external ? 'Next rounds — scheduled by the company, you can join' : 'Next rounds'}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {laterRounds.map((x) => {
                const open = ['Pending', 'Scheduled'].includes(x.status);
                return (
                  <div key={x.index} className="border border-gray-200 rounded-lg p-2.5 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-medium text-gray-800">{x.label}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${ROUND_STATUS_STYLES[x.status] || ROUND_STATUS_STYLES.Pending}`}>{roundStatusLabel(x.status)}</span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-1">
                      {x.scheduledAt ? formatDateTime12(x.scheduledAt) : (open ? 'Not scheduled yet' : 'Not dated')}
                      {x.scheduledAt && x.durationMinutes ? ` · ${x.durationMinutes} min` : ''}
                    </div>
                    {x.interviewerName && <div className="text-[11px] text-gray-500 truncate">With {x.interviewerName}</div>}
                    {x.meetingLink && open && (
                      <a href={x.meetingLink} target="_blank" rel="noopener noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
                        <FiVideo size={13} /> Join meeting
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!external && r.employeeCode && (
          <div className="mt-2">
            <span className="text-[11px] px-2 py-0.5 rounded bg-green-100 text-green-800">Joined · {r.employeeCode}</span>
          </div>
        )}
        {!external && r.rejection && r.round1?.status !== 'Rejected' && (
          <p className="mt-2 text-xs text-red-700">
            Closed by {r.rejection.byName || 'the company'}{r.rejection.at ? ` on ${fmtDate(r.rejection.at)}` : ''}
            {r.rejection.reason ? ` — ${r.rejection.reason}` : ''}
          </p>
        )}
        {external && r.closedByCompany && (
          <p className="mt-2 text-xs text-red-700">The company closed this candidate before Round 1 was recorded.</p>
        )}

        {!external && r.priorRejection && (
          <div className="mt-3">
            <PriorRejections flag={r.priorRejection} defaultOpen={false} />
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2 mt-3">
          {r.hasResume && (
            <button type="button" onClick={() => viewResume(r)}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">
              <FiFileText size={13} /> View résumé
            </button>
          )}
          {external && r.canDecide && (
            <button type="button" onClick={() => toggleRound(r)}
              className="text-xs font-medium px-2.5 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-700">
              {open ? 'Close Round 1' : hasAssessment(r1) ? 'Continue Round 1' : 'Take Round 1'}
            </button>
          )}
          {external && r.canEdit && !open && (
            <button type="button" onClick={() => openEdit(r)}
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">
              <FiEdit2 size={13} /> Edit details
            </button>
          )}
          {canContinue && r.section === 'cleared' && !['Rejected', 'Hired'].includes(r.stage) && !r.employeeCode && (
            <Link to="/admin/recruitment"
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">
              Continue in Recruitment <FiArrowRight size={13} />
            </Link>
          )}
          {/* Not repeated when the red "closed by the company" line above
              already says it. */}
          {external && !r.canDecide && r.lockedReason && !r.closedByCompany && (
            <span className="text-[11px] text-gray-500">{r.lockedReason}</span>
          )}
        </div>

        {/* Round 1 as recorded (when the form is closed). */}
        {!open && hasAssessment(r1) && (
          <section className="my-round-panel mt-3">
            <div className="my-round-panel-head flex flex-wrap items-center gap-2 px-4 py-2.5">
              <RoundBadge>Round 1</RoundBadge>
              <span className="text-sm font-semibold text-gray-900">{external ? 'Your assessment' : 'Consultancy\u2019s assessment'}</span>
            </div>
            <div className="p-4">
              <AssessmentView round={r1} dense />
            </div>
          </section>
        )}
        {!open && r1.decidedAt && (
          <div className="mt-2 text-[11px] text-gray-400">
            {r1.status === 'Cleared' ? 'Shortlisted' : r1.status === 'Rejected' ? 'Rejected' : 'Round 1 recorded'} at Round 1 by {r1.decidedByName || r1.interviewerName || 'the consultancy'} · {formatDateTime12(r1.decidedAt)}
          </div>
        )}

        {/* The consultancy records Round 1 — framed as ITS round. */}
        {external && open && (
          <section className="my-round-panel mt-4">
            <div className="my-round-panel-head flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <RoundBadge>Round 1</RoundBadge>
                <span className="text-sm font-semibold text-gray-900">Your assessment</span>
              </div>
              <span className="text-[11px] text-gray-500">Fill this in for {r.name} after the interview</span>
            </div>
            <div className="p-4">
              <AssessmentForm
                value={{ feedback: draft.feedback, assessment: draft.assessment }}
                onChange={(v) => setDraft({ feedback: v.feedback, assessment: v.assessment })}
                suggestChars={suggest}
              />
              <div className="mt-4">
                <label className="block text-xs font-semibold text-gray-700 mb-1">Round 1 result</label>
                <div className="flex flex-wrap items-center gap-2">
                  {VERDICTS.map((v) => (
                    <button key={v.status} type="button" onClick={() => setDraft({ status: v.status })}
                      className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                        draft.status === v.status
                          ? `${ROUND_STATUS_STYLES[v.status]} border-transparent ring-2 ring-offset-1 ring-gray-300`
                          : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                      }`}>
                      {v.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-gray-500 max-w-xl">
                  {draft.status === 'Cleared'
                    ? 'HR schedules the next rounds and you can join them from here. Your write-up travels with the candidate. This cannot be changed afterwards.'
                    : draft.status === 'Rejected'
                      ? 'They move to Rejected and cannot be put forward for this job again for 3 months. This cannot be changed afterwards.'
                      : 'Saving without a result keeps the candidate under Awaiting Round 1 — you can come back to it.'}
                </p>
                <button type="button" onClick={() => saveRound(r)} disabled={savingId === r._id}
                  className="text-sm font-medium px-4 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50">
                  {saveLabel}
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    );
  };

  const emptyText = {
    pending: external
      ? 'No candidates waiting for Round 1. Add a candidate to one of the open jobs to get started.'
      : 'No consultancy candidates are waiting for Round 1.',
    cleared: 'No candidates have been shortlisted at Round 1 yet.',
    rejected: 'No candidates have been rejected at Round 1.',
  };

  return (
    <div>
      <PageHeader
        title={external ? 'My Candidates' : 'Consultancy Candidates'}
        subtitle={external
          ? 'Add candidates to our open jobs and take their Round 1 interview · shortlisted candidates go on to the company’s next rounds, which you can join'
          : 'Candidates sent in by HR consultancies, split by the Round 1 result the consultancy recorded · shortlisted ones go on to the rounds you schedule'}
      >
        {refreshing && <span className="text-xs text-gray-400">Updating…</span>}
        {external && (
          <button type="button" onClick={() => openAdd()}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
            <FiPlus size={15} /> Add candidate
          </button>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {/* Sections — rejected and cleared kept apart, with live counts. */}
      <div className="seg-track mb-4" role="tablist" aria-label="Round 1 result">
        {SECTIONS.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={section === s.id}
            onClick={() => setSection(s.id)}
            className={`seg-btn inline-flex items-center gap-1.5 whitespace-nowrap${section === s.id ? ' is-active' : ''}`}>
            <s.icon size={14} aria-hidden="true" />
            {s.label}
            <span className="text-[11px] tabular-nums px-1.5 rounded-full bg-gray-200 text-gray-700">
              {loading ? '–' : counts[s.id] || 0}
            </span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <label className="relative flex-1 min-w-[12rem] max-w-sm">
          <FiSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, email, phone, job"
            aria-label="Search candidates"
            className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-2 text-sm" />
        </label>
        {!external && agencies.length > 0 && (
          <SearchableSelect value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm max-w-[14rem]">
            <option value="">All consultancies</option>
            {agencies.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
          </SearchableSelect>
        )}
        {jobOptions.length > 1 && (
          <SearchableSelect value={jobFilter} onChange={(e) => setJobFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm max-w-[14rem]">
            <option value="">All jobs</option>
            {jobOptions.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </SearchableSelect>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-white shadow rounded-lg p-4 space-y-3">
              <div className="skeleton h-4 w-1/3 rounded" />
              <div className="skeleton h-3 w-1/2 rounded" />
              <div className="flex gap-2">
                <div className="skeleton h-8 w-24 rounded-lg" />
                <div className="skeleton h-8 w-24 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-8 text-center text-sm text-gray-500">
          {q || agencyFilter || jobFilter ? 'No candidates match these filters.' : emptyText[section]}
        </div>
      ) : (
        <div className="space-y-3">{shown.map(card)}</div>
      )}

      {/* Add / edit a candidate (consultancy) */}
      {formOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between gap-3 mb-4">
              <h2 className="card-title">{editing ? `Edit ${editing.name}` : 'Add a candidate'}</h2>
              <button type="button" aria-label="Close" onClick={() => setFormOpen(false)} className="topbar-icon-btn shrink-0">×</button>
            </div>
            {!editing && jobs.length === 0 ? (
              <div className="space-y-4">
                <p className="text-sm text-gray-600">There are no open jobs to add candidates to right now. The company’s openings appear here as soon as they are posted.</p>
                <div className="flex justify-end">
                  <button type="button" onClick={() => setFormOpen(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Close</button>
                </div>
              </div>
            ) : (
              <form onSubmit={submitForm} className="space-y-3">
                {editing ? (
                  <div className="text-sm text-gray-600">
                    For <span className="font-medium text-gray-800">{editing.job?.title || 'No job'}</span>
                    {editing.location ? ` · ${editing.location}` : ''}
                  </div>
                ) : (
                  <>
                    <label className="block">
                      <span className="block text-xs font-medium text-gray-600 mb-1">Job *</span>
                      <SearchableSelect value={form.job} required
                        onChange={(e) => {
                          const next = e.target.value;
                          const places = jobs.find((j) => j._id === next)?.locations || [];
                          setForm((f) => ({
                            ...f,
                            job: next,
                            location: places.includes(f.location) ? f.location : (places.length === 1 ? places[0] : ''),
                          }));
                        }}
                        className="block w-full border rounded-lg px-3 py-2">
                        <option value="">Choose an open job</option>
                        {jobs.map((j) => (
                          <option key={j._id} value={j._id}>
                            {[j.title, j.department, j.companyName].filter(Boolean).join(' · ')}
                          </option>
                        ))}
                      </SearchableSelect>
                    </label>
                    {selectedJob?.description && (
                      <p className="text-xs text-gray-500 bg-gray-50 rounded-lg px-3 py-2 max-h-24 overflow-y-auto whitespace-pre-line">
                        {selectedJob.description}
                      </p>
                    )}
                    {jobPlaces.length > 0 && (
                      <label className="block">
                        <span className="block text-xs font-medium text-gray-600 mb-1">Location *</span>
                        <select value={form.location} required onChange={(e) => setForm({ ...form, location: e.target.value })}
                          className="block w-full border rounded-lg px-3 py-2">
                          <option value="">Which location is this candidate for?</option>
                          {jobPlaces.map((l) => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </label>
                    )}
                  </>
                )}

                <input required placeholder="Candidate name *" value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <input required type="email" placeholder="Email *" value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <input required placeholder="Phone *" value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <input placeholder="Current company" value={form.currentCompany}
                    onChange={(e) => setForm({ ...form, currentCompany: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <input type="number" min="0" step="0.5" placeholder="Experience (years)" value={form.experienceYears}
                    onChange={(e) => setForm({ ...form, experienceYears: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <input placeholder="Current in-hand CTC" value={form.currentCtc}
                    onChange={(e) => setForm({ ...form, currentCtc: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <input placeholder="Expected CTC" value={form.expectedCtc}
                    onChange={(e) => setForm({ ...form, expectedCtc: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                  <input placeholder="Notice period" value={form.noticePeriod}
                    onChange={(e) => setForm({ ...form, noticePeriod: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2 sm:col-span-2" />
                </div>
                <textarea rows={3} placeholder="Notes for HR (optional)" value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
                <label className="block">
                  <span className="block text-xs font-medium text-gray-600 mb-1">
                    {editing ? 'Replace résumé (optional)' : 'Résumé * (PDF or Word, up to 5 MB)'}
                  </span>
                  <input type="file" accept=".pdf,.doc,.docx" required={!editing}
                    onChange={(e) => setResume(e.target.files?.[0] || null)}
                    className="block w-full text-sm" />
                </label>
                <div className="flex justify-end gap-2 pt-2">
                  <button type="button" onClick={() => setFormOpen(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                  <button type="submit" disabled={saving}
                    className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                    {saving ? 'Saving…' : editing ? 'Save changes' : 'Add candidate'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
