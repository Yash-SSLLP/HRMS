/**
 * ConsultancyJobs — job openings for an HR consultancy, and its requests for
 * new ones. One page, two viewers, like ConsultancyCandidates:
 *
 *   • The CONSULTANCY (role HRConsultancy) sees the company's OPEN jobs — with
 *     how many candidates it has already put forward for each and a button to
 *     add another — and can REQUEST a new opening when it has a requirement the
 *     portal does not carry. Its requests are listed with what became of them.
 *   • The COMPANY — HR, CEO/MD, the Backend, God — sees those requests and,
 *     where it may decide them (HR with recruitment.jobs, any CEO/MD, the
 *     Backend), ACCEPTS one, which opens it as a real job after any corrections,
 *     or rejects it with a note the agency reads.
 *
 * API: GET /recruitment/consultancy/jobs (agency), GET/POST
 * /recruitment/consultancy/job-requests, PATCH …/:id/withdraw (agency),
 * PATCH …/:id/approve | …/:id/reject (company). See
 * backend/controllers/jobRequestController.js.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'react-toastify';
import { FiPlus, FiBriefcase, FiMapPin, FiUsers, FiSearch, FiCheck, FiX, FiClock } from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import SearchableSelect from '../components/SearchableSelect';
import DepartmentSelect from '../components/DepartmentSelect';
import LocationsField from '../components/LocationsField';
import { confirmDialog, promptDialog } from '../components/dialogs';
import { useAuthStore } from '../store/authStore';
import { useNavCountsStore } from '../store/navCountsStore';
import { useTabParam } from '../hooks/useTabParam';
import { isExternalAccount } from '../config/permissions';

const EMPLOYMENT_TYPES = [
  { value: 'FullTime', label: 'Full-time' },
  { value: 'PartTime', label: 'Part-time' },
  { value: 'Contract', label: 'Contract' },
  { value: 'Intern', label: 'Internship' },
];
const typeLabel = (v) => EMPLOYMENT_TYPES.find((t) => t.value === v)?.label || v || '';

const STATUS_STYLES = {
  Pending: 'bg-amber-100 text-amber-800',
  Approved: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-700',
  Withdrawn: 'bg-gray-100 text-gray-600',
};
// What each status means to the reader, as a chip label.
const STATUS_LABELS = { Pending: 'Waiting for approval', Approved: 'Approved — job opened', Rejected: 'Not approved', Withdrawn: 'Withdrawn' };
// An approved request goes on to say what became of the job it opened
// (jobRequestController jobStateOf) — HR may have closed or deleted it since.
const APPROVED_STATES = {
  Open: { label: 'Approved — job open', style: 'bg-green-100 text-green-800' },
  OnHold: { label: 'Approved — job on hold', style: 'bg-amber-100 text-amber-800' },
  Closed: { label: 'Approved — job closed', style: 'bg-gray-100 text-gray-600' },
  Deleted: { label: 'Approved — job deleted', style: 'bg-red-100 text-red-700' },
};
const chipOf = (r) => (r.status === 'Approved' && APPROVED_STATES[r.jobState]
  ? APPROVED_STATES[r.jobState]
  : { label: STATUS_LABELS[r.status] || r.status, style: STATUS_STYLES[r.status] || STATUS_STYLES.Pending });

const AGENCY_TABS = [
  { id: 'open', label: 'Open jobs', icon: FiBriefcase },
  { id: 'requests', label: 'My requests', icon: FiClock },
];
const COMPANY_TABS = [
  { id: 'Pending', label: 'Pending', icon: FiClock },
  { id: 'Approved', label: 'Approved', icon: FiCheck },
  { id: 'Rejected', label: 'Rejected', icon: FiX },
  { id: 'Withdrawn', label: 'Withdrawn', icon: FiX },
];

const fmtDate = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const blankRequest = {
  title: '', department: '', employmentType: 'FullTime', openings: 1, company: '',
  locations: [], description: '', reason: '',
};

/** A job's or request's facts on one line: department · type · openings. */
function Facts({ department, employmentType, openings, companyName }) {
  const bits = [companyName, department, typeLabel(employmentType), openings ? `${openings} opening${openings === 1 ? '' : 's'}` : ''].filter(Boolean);
  return bits.length ? <div className="text-xs text-gray-500 mt-0.5">{bits.join(' · ')}</div> : null;
}

/** Location chips. */
function Places({ list }) {
  if (!list?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      <FiMapPin size={13} className="text-gray-400" aria-hidden="true" />
      {list.map((l) => <span key={l} className="text-[11px] px-2 py-0.5 rounded bg-gray-100 text-gray-700">{l}</span>)}
    </div>
  );
}

/** Long text, clamped to a few lines with a toggle. */
function LongText({ text, label }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > 280 || text.split('\n').length > 4;
  return (
    <div className="mt-3 text-sm text-gray-700 break-words">
      {label && <span className="block text-[11px] text-gray-500">{label}</span>}
      <p className={`whitespace-pre-line ${long && !open ? 'line-clamp-4' : ''}`}>{text}</p>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-1 text-xs text-blue-600 hover:underline">
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

export default function ConsultancyJobs() {
  const user = useAuthStore((s) => s.user);
  const external = isExternalAccount(user);
  const navigate = useNavigate();
  const refreshCounts = useNavCountsStore((s) => s.refresh);

  const [jobs, setJobs] = useState([]);
  const [companies, setCompanies] = useState([]);  // agency: where it may ask; company: where a job may open
  const [requests, setRequests] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useTabParam(external ? 'open' : 'Pending',
    (external ? AGENCY_TABS : COMPANY_TABS).map((t) => t.id));
  const [q, setQ] = useState('');
  const [agencyFilter, setAgencyFilter] = useState('');

  // Agency: the request form.
  const [asking, setAsking] = useState(false);
  const [form, setForm] = useState(blankRequest);
  const [saving, setSaving] = useState(false);

  // Company: the approve-and-open form, and which row is busy.
  const [approving, setApproving] = useState(null); // the request being approved
  const [jobForm, setJobForm] = useState(null);
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [reqRes, jobRes, compRes] = await Promise.all([
          api.get('/recruitment/consultancy/job-requests'),
          external ? api.get('/recruitment/consultancy/jobs') : Promise.resolve(null),
          // Where the company may open the job. Only asked for by the company
          // side — the agency's own choices come with its jobs list.
          external ? Promise.resolve(null) : api.get('/companies').catch(() => ({ data: { companies: [] } })),
        ]);
        if (cancelled) return;
        setRequests(reqRes.data.requests || []);
        setAgencies(reqRes.data.consultancies || []);
        if (jobRes) {
          setJobs(jobRes.data.jobs || []);
          setCompanies(jobRes.data.companies || []);
        }
        if (compRes) setCompanies((compRes.data.companies || []).filter((c) => c.isActive !== false));
      } catch (err) {
        if (!cancelled) setError(err.response?.data?.message || 'Could not load the job openings');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [external]);

  const upsert = (row) => setRequests((list) => {
    const i = list.findIndex((r) => r._id === row._id);
    if (i === -1) return [row, ...list];
    const next = list.slice();
    next[i] = row;
    return next;
  });

  // ----- Filters -----
  const term = q.trim().toLowerCase();
  const matches = (...fields) => !term || fields.some((v) => String(v || '').toLowerCase().includes(term));

  const shownJobs = useMemo(
    () => jobs.filter((j) => matches(j.title, j.department, j.companyName, ...(j.locations || []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jobs, term],
  );
  const filteredRequests = useMemo(
    () => requests.filter((r) => (!agencyFilter || String(r.requestedBy) === agencyFilter)
      && matches(r.title, r.department, r.requestedByName, r.company?.name, ...(r.locations || []))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [requests, agencyFilter, term],
  );
  const counts = useMemo(() => {
    const c = { open: shownJobs.length, requests: filteredRequests.length };
    COMPANY_TABS.forEach((t) => { c[t.id] = filteredRequests.filter((r) => r.status === t.id).length; });
    return c;
  }, [shownJobs, filteredRequests]);
  const shownRequests = external ? filteredRequests : filteredRequests.filter((r) => r.status === tab);

  // ----- Agency actions -----
  const submitRequest = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const { data } = await api.post('/recruitment/consultancy/job-requests', {
        ...form,
        openings: Number(form.openings) || 1,
      });
      upsert(data.request);
      setAsking(false);
      setForm(blankRequest);
      setTab('requests');
      toast.success('Request sent — you will be notified when it is approved');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not send the request');
    } finally {
      setSaving(false);
    }
  };

  const withdraw = async (r) => {
    const ok = await confirmDialog({
      message: `Withdraw your request for "${r.title}"? Nobody has decided it yet.`,
      confirmText: 'Withdraw',
      tone: 'warning',
    });
    if (!ok) return;
    setBusyId(r._id);
    try {
      const { data } = await api.patch(`/recruitment/consultancy/job-requests/${r._id}/withdraw`);
      upsert(data.request);
      toast.success('Request withdrawn');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not withdraw the request');
    } finally {
      setBusyId('');
    }
  };

  const addCandidate = (jobId) => navigate(`/admin/consultancy?add=${jobId}`);

  // ----- Company actions -----
  const openApprove = (r) => {
    setApproving(r);
    setJobForm({
      title: r.title || '',
      department: r.department || '',
      employmentType: r.employmentType || 'FullTime',
      openings: r.openings || 1,
      // The company the agency named; else the only one this viewer can open
      // jobs in; else none (shared) — which is only offered with a choice.
      company: r.company?._id || (companies.length === 1 ? companies[0]._id : ''),
      locations: r.locations || [],
      description: r.description || '',
      note: '',
    });
  };

  const approve = async (e) => {
    e.preventDefault();
    const r = approving;
    setBusyId(r._id);
    try {
      const { data } = await api.patch(`/recruitment/consultancy/job-requests/${r._id}/approve`, {
        ...jobForm,
        openings: Number(jobForm.openings) || 1,
      });
      upsert(data.request);
      setApproving(null);
      toast.success(`"${data.job?.title || r.title}" is open — ${r.requestedByName || 'the consultancy'} can add candidates now`);
      refreshCounts({ admin: true, force: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not approve the request');
    } finally {
      setBusyId('');
    }
  };

  const reject = async (r) => {
    const note = await promptDialog({
      title: `Reject "${r.title}"?`,
      message: `${r.requestedByName || 'The consultancy'} will be told it was not approved.`,
      inputLabel: 'Reason for the consultancy (optional)',
      placeholder: 'e.g. We are not hiring for this role this quarter',
      confirmText: 'Reject request',
      tone: 'danger',
    });
    if (note === null) return; // cancelled
    setBusyId(r._id);
    try {
      const { data } = await api.patch(`/recruitment/consultancy/job-requests/${r._id}/reject`, { note });
      upsert(data.request);
      toast.success('Request rejected');
      refreshCounts({ admin: true, force: true });
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not reject the request');
    } finally {
      setBusyId('');
    }
  };

  // ----- Rendering -----
  const jobCard = (j) => (
    <div key={j._id} className="bg-white shadow rounded-lg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-gray-900 break-words">{j.title}</div>
          <Facts department={j.department} employmentType={j.employmentType} openings={j.openings} companyName={j.companyName} />
        </div>
        {j.postedAt && <span className="text-[11px] text-gray-400">Posted {fmtDate(j.postedAt)}</span>}
      </div>
      <Places list={j.locations} />
      <LongText text={j.description} />
      <div className="flex flex-wrap items-center justify-between gap-2 mt-3">
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500">
          <FiUsers size={13} aria-hidden="true" />
          {j.myCandidates
            ? `You have put forward ${j.myCandidates} candidate${j.myCandidates === 1 ? '' : 's'}`
            : 'No candidates from you yet'}
        </span>
        <button type="button" onClick={() => addCandidate(j._id)}
          className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-700">
          <FiPlus size={14} /> Add a candidate
        </button>
      </div>
    </div>
  );

  const requestCard = (r) => (
    <div key={r._id} className="bg-white shadow rounded-lg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-semibold text-gray-900 break-words">{r.title}</div>
          <Facts department={r.department} employmentType={r.employmentType} openings={r.openings} companyName={r.company?.name} />
          <div className="text-xs text-gray-500 mt-0.5">
            {external ? 'Asked' : `From ${r.requestedByName || 'a consultancy'} ·`} {fmtDate(r.createdAt)}
          </div>
        </div>
        <span className={`text-[11px] px-2 py-0.5 rounded ${chipOf(r).style}`}>
          {chipOf(r).label}
        </span>
      </div>
      <Places list={r.locations} />
      <LongText text={r.description} />
      {r.reason && (
        <div className="mt-3 text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2 break-words">
          <span className="text-[11px] text-gray-500 block">{external ? 'Why you asked' : 'Why they are asking'}</span>
          {r.reason}
        </div>
      )}

      {/* What became of it */}
      {r.status === 'Approved' && (
        <p className="mt-3 text-xs text-green-700">
          Approved{r.decidedByName ? ` by ${r.decidedByName}` : ''}{r.decidedAt ? ` on ${fmtDate(r.decidedAt)}` : ''}
          {r.job?.title ? ` — opened as "${r.job.title}"` : ''}.
          {r.decisionNote ? ` ${r.decisionNote}` : ''}
        </p>
      )}
      {/* …and what has happened to that job since. */}
      {r.status === 'Approved' && r.jobState === 'Deleted' && (
        <p className="mt-1 text-xs text-red-700">
          The job was later deleted{r.jobDeletedByName ? ` by ${r.jobDeletedByName}` : ''}{r.jobDeletedAt ? ` on ${fmtDate(r.jobDeletedAt)}` : ''}, so it no longer takes candidates.
        </p>
      )}
      {r.status === 'Approved' && r.jobState === 'Closed' && (
        <p className="mt-1 text-xs text-gray-500">The job has since been closed, so it no longer takes candidates.</p>
      )}
      {r.status === 'Approved' && r.jobState === 'OnHold' && (
        <p className="mt-1 text-xs text-amber-700">The job is on hold for now — candidates can be added once it reopens.</p>
      )}
      {r.status === 'Rejected' && (
        <p className="mt-3 text-xs text-red-700">
          Not approved{r.decidedByName ? ` by ${r.decidedByName}` : ''}{r.decidedAt ? ` on ${fmtDate(r.decidedAt)}` : ''}
          {r.decisionNote ? ` — ${r.decisionNote}` : '.'}
        </p>
      )}
      {r.status === 'Withdrawn' && (
        <p className="mt-3 text-xs text-gray-500">Withdrawn{r.decidedAt ? ` on ${fmtDate(r.decidedAt)}` : ''}.</p>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 mt-3">
        {external && r.canWithdraw && (
          <button type="button" onClick={() => withdraw(r)} disabled={busyId === r._id}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50">
            Withdraw request
          </button>
        )}
        {external && r.status === 'Approved' && r.job?._id && r.job.status === 'Open' && (
          <button type="button" onClick={() => addCandidate(r.job._id)}
            className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-gray-900 text-white hover:bg-gray-700">
            <FiPlus size={13} /> Add a candidate
          </button>
        )}
        {!external && r.canDecide && (
          <>
            <button type="button" onClick={() => openApprove(r)} disabled={busyId === r._id}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
              <FiCheck size={13} /> Approve &amp; open job
            </button>
            <button type="button" onClick={() => reject(r)} disabled={busyId === r._id}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-red-600 hover:bg-red-50 disabled:opacity-50">
              <FiX size={13} /> Reject
            </button>
          </>
        )}
        {!external && r.status === 'Approved' && r.job?._id && (
          <Link to="/admin/recruitment" className="text-xs text-blue-600 hover:underline">View in Recruitment</Link>
        )}
      </div>
    </div>
  );

  const tabs = external ? AGENCY_TABS : COMPANY_TABS;
  const list = external && tab === 'open' ? shownJobs : shownRequests;
  const emptyText = external
    ? (tab === 'open'
      ? 'There are no open jobs right now. If you have a requirement, request a new opening.'
      : 'You have not requested any openings yet.')
    : ({
      Pending: 'No job-opening requests are waiting for a decision.',
      Approved: 'No requests have been approved yet.',
      Rejected: 'No requests have been rejected.',
      Withdrawn: 'No requests have been withdrawn.',
    })[tab];

  return (
    <div>
      <PageHeader
        title={external ? 'Job Openings' : 'Consultancy Job Requests'}
        subtitle={external
          ? 'The company’s open jobs you can add candidates to · request a new opening when you have a requirement that is not listed'
          : 'Openings HR consultancies have asked for · approve one to open it as a job, or reject it with a note for the consultancy'}
      >
        {external && (
          <button type="button" onClick={() => { setForm(blankRequest); setAsking(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-gray-900 text-white rounded-lg hover:bg-gray-700 text-sm">
            <FiPlus size={15} /> Request a new opening
          </button>
        )}
      </PageHeader>

      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      <div className="seg-track mb-4" role="tablist" aria-label={external ? 'Jobs and requests' : 'Request status'}>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`seg-btn inline-flex items-center gap-1.5 whitespace-nowrap${tab === t.id ? ' is-active' : ''}`}>
            <t.icon size={14} aria-hidden="true" />
            {t.label}
            <span className="text-[11px] tabular-nums px-1.5 rounded-full bg-gray-200 text-gray-700">
              {loading ? '–' : counts[t.id] || 0}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <label className="relative flex-1 min-w-[12rem] max-w-sm">
          <FiSearch size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)}
            placeholder={external && tab === 'open' ? 'Search jobs, departments, places' : 'Search requests'}
            aria-label="Search"
            className="w-full border border-gray-300 rounded-lg pl-8 pr-3 py-2 text-sm" />
        </label>
        {!external && agencies.length > 1 && (
          <SearchableSelect value={agencyFilter} onChange={(e) => setAgencyFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm max-w-[14rem]">
            <option value="">All consultancies</option>
            {agencies.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
          </SearchableSelect>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="bg-white shadow rounded-lg p-4 space-y-3">
              <div className="skeleton h-4 w-1/3 rounded" />
              <div className="skeleton h-3 w-1/2 rounded" />
              <div className="skeleton h-8 w-32 rounded-lg" />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-8 text-center text-sm text-gray-500">
          {term || agencyFilter ? 'Nothing matches this search.' : emptyText}
        </div>
      ) : (
        <div className="space-y-3">{external && tab === 'open' ? list.map(jobCard) : list.map(requestCard)}</div>
      )}

      {/* The agency asks for a new opening */}
      {asking && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="card-title">Request a new opening</h2>
              <button type="button" aria-label="Close" onClick={() => setAsking(false)} className="topbar-icon-btn shrink-0">×</button>
            </div>
            <p className="text-xs text-gray-500 mb-4">HR, the CEO/MD or an administrator approves it — you can add candidates as soon as it opens.</p>
            <form onSubmit={submitRequest} className="space-y-3">
              <input required placeholder="Job title *" value={form.title} maxLength={120}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input placeholder="Department (if known)" value={form.department} maxLength={80}
                  onChange={(e) => setForm({ ...form, department: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" />
                <select value={form.employmentType} onChange={(e) => setForm({ ...form, employmentType: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" aria-label="Employment type">
                  {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <label className="block">
                  <span className="block text-xs text-gray-600 mb-1">Openings</span>
                  <input type="number" min="1" max="500" value={form.openings}
                    onChange={(e) => setForm({ ...form, openings: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </label>
                {companies.length > 1 && (
                  <label className="block">
                    <span className="block text-xs text-gray-600 mb-1">Company</span>
                    <select value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })}
                      className="block w-full border rounded-lg px-3 py-2">
                      <option value="">Not sure — let the company decide</option>
                      {companies.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                    </select>
                  </label>
                )}
                <LocationsField value={form.locations} onChange={(v) => setForm({ ...form, locations: v })}
                  hint="Where the role is based. The company confirms the places when it opens the job." />
              </div>
              <textarea rows={4} placeholder="Job description — responsibilities, skills, experience" value={form.description} maxLength={4000}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Why are you asking? e.g. client requirement, candidates ready" value={form.reason} maxLength={1000}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2" />
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setAsking(false)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={saving}
                  className="px-4 py-2 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-60">
                  {saving ? 'Sending…' : 'Send request'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* The company approves — and may correct the posting first */}
      {approving && jobForm && (
        <div className="fixed inset-0 bg-black/40 flex items-start justify-center px-4 z-50 overflow-y-auto py-8">
          <div className="bg-white rounded-xl shadow-lg w-full max-w-lg p-6">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="card-title">Approve &amp; open job</h2>
              <button type="button" aria-label="Close" onClick={() => setApproving(null)} className="topbar-icon-btn shrink-0">×</button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              Requested by {approving.requestedByName || 'a consultancy'}. Check the details — the job opens exactly as saved here, and they are told it is open.
            </p>
            <form onSubmit={approve} className="space-y-3">
              <input required placeholder="Title *" value={jobForm.title} maxLength={120}
                onChange={(e) => setJobForm({ ...jobForm, title: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2" />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <DepartmentSelect value={jobForm.department} onChange={(v) => setJobForm({ ...jobForm, department: v })}
                  className="block w-full border rounded-lg px-3 py-2" />
                <select value={jobForm.employmentType} onChange={(e) => setJobForm({ ...jobForm, employmentType: e.target.value })}
                  className="block w-full border rounded-lg px-3 py-2" aria-label="Employment type">
                  {EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <label className="block">
                  <span className="block text-xs text-gray-600 mb-1">Openings</span>
                  <input type="number" min="1" max="500" value={jobForm.openings}
                    onChange={(e) => setJobForm({ ...jobForm, openings: e.target.value })}
                    className="block w-full border rounded-lg px-3 py-2" />
                </label>
                {companies.length > 0 && (
                  <label className="block">
                    <span className="block text-xs text-gray-600 mb-1">Hiring company</span>
                    <select value={jobForm.company || ''} onChange={(e) => setJobForm({ ...jobForm, company: e.target.value })}
                      className="block w-full border rounded-lg px-3 py-2">
                      {companies.length > 1 && <option value="">Shared (every company)</option>}
                      {companies.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
                    </select>
                  </label>
                )}
                <LocationsField value={jobForm.locations} onChange={(v) => setJobForm({ ...jobForm, locations: v })} />
              </div>
              <textarea rows={4} placeholder="Description" value={jobForm.description} maxLength={4000}
                onChange={(e) => setJobForm({ ...jobForm, description: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2" />
              <textarea rows={2} placeholder="Note for the consultancy (optional)" value={jobForm.note} maxLength={500}
                onChange={(e) => setJobForm({ ...jobForm, note: e.target.value })}
                className="block w-full border rounded-lg px-3 py-2" />
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setApproving(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-gray-50">Cancel</button>
                <button type="submit" disabled={busyId === approving._id}
                  className="px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-60">
                  {busyId === approving._id ? 'Opening…' : 'Approve & open job'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
