import { Fragment, useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const JOB_STATUS = ['Open', 'OnHold', 'Closed'];
const STAGES = ['Applied', 'Shortlisted', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'];
const STAGE_STYLES = {
  Applied: 'bg-gray-100 text-gray-700',
  Shortlisted: 'bg-indigo-100 text-indigo-800',
  Screening: 'bg-blue-100 text-blue-800',
  Interview: 'bg-amber-100 text-amber-800',
  Offer: 'bg-purple-100 text-purple-800',
  Hired: 'bg-green-100 text-green-800',
  Rejected: 'bg-red-100 text-red-700',
};
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
    if (!window.confirm(`Delete job "${j.title}" and its candidates?`)) return;
    try { await api.delete(`/recruitment/jobs/${j._id}`); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };

  const shareLink = (j) => `${window.location.origin}/apply/${j._id}`;
  const copyShare = async (j) => {
    const link = shareLink(j);
    try { await navigator.clipboard.writeText(link); }
    catch { window.prompt('Copy this application link:', link); }
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
    if (!window.confirm(`Delete candidate "${c.name}"?`)) return;
    try { await api.delete(`/recruitment/candidates/${c._id}`); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Delete failed'); }
  };

  const setStage = async (c, stage) => {
    try { await api.put(`/recruitment/candidates/${c._id}`, { stage }); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Update failed'); }
  };
  const setRound = async (c, index, patch) => {
    try { await api.patch(`/recruitment/candidates/${c._id}/round`, { index, ...patch }); await load(); }
    catch (err) { alert(err.response?.data?.message || 'Round update failed'); }
  };
  const viewResume = async (c) => {
    try {
      const res = await api.get(`/recruitment/candidates/${c._id}/resume`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { alert(err.response?.data?.message || 'No resume on file'); }
  };

  const roundSummary = (c) => {
    const cleared = (c.rounds || []).filter((r) => r.status === 'Cleared').length;
    return `${cleared}/${(c.rounds || []).length} cleared`;
  };

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
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">Loading…</td></tr>
            ) : jobs.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No job openings</td></tr>
            ) : jobs.map((j) => (
              <tr key={j._id} className={selectedJob === j._id ? 'bg-gray-50' : ''}>
                <td className="px-4 py-3 font-medium text-gray-900">{j.title}</td>
                <td className="px-4 py-3 text-gray-600">{j.department || '—'}{j.location ? ` · ${j.location}` : ''}</td>
                <td className="px-4 py-3">
                  <button onClick={() => setSelectedJob(selectedJob === j._id ? '' : j._id)} className="text-blue-600 hover:underline">{j.candidateCount} →</button>
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
            {candidates.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-500">No candidates yet. Share an application link to start receiving applications.</td></tr>
            ) : candidates.map((c) => (
              <Fragment key={c._id}>
                <tr>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-900 flex items-center gap-2">
                      {c.name}
                      {c.source === 'Application' && <span className="text-[10px] uppercase tracking-wide bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded">Applied online</span>}
                    </div>
                    <div className="text-xs text-gray-500">{c.email || ''}{c.phone ? ` · ${c.phone}` : ''}</div>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{c.job?.title || '—'}</td>
                  <td className="px-4 py-3">
                    {c.hasResume ? (
                      <button onClick={() => viewResume(c)} className="text-blue-600 hover:underline">View</button>
                    ) : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STAGE_STYLES[c.stage] || ''}`}>{c.stage}</span></td>
                  <td className="px-4 py-3">
                    <button onClick={() => setExpanded(expanded === c._id ? null : c._id)} className="text-blue-600 hover:underline">
                      {roundSummary(c)} {expanded === c._id ? '▾' : '▸'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap space-x-2">
                    {c.stage !== 'Shortlisted' && c.stage !== 'Hired' && c.stage !== 'Rejected' && (
                      <button onClick={() => setStage(c, 'Shortlisted')} className="text-green-600 hover:underline">Shortlist</button>
                    )}
                    {c.stage !== 'Rejected' && (
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
                            <input
                              defaultValue={r.feedback || ''}
                              onBlur={(e) => { if (e.target.value !== (r.feedback || '')) setRound(c, idx, { feedback: e.target.value }); }}
                              placeholder="Feedback…"
                              className="block w-full border border-gray-200 rounded-lg px-2 py-1 text-xs"
                            />
                          </div>
                        ))}
                      </div>
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
                <input placeholder="Department" value={jobForm.department} onChange={(e) => setJobForm({ ...jobForm, department: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
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
                  <option value="">— Job —</option>
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
    </div>
  );
}
