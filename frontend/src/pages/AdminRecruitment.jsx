import { useEffect, useState } from 'react';
import api from '../api/client';
import PageHeader from '../components/PageHeader';

const JOB_STATUS = ['Open', 'OnHold', 'Closed'];
const STAGES = ['Applied', 'Screening', 'Interview', 'Offer', 'Hired', 'Rejected'];
const STAGE_STYLES = {
  Applied: 'bg-gray-100 text-gray-700',
  Screening: 'bg-blue-100 text-blue-800',
  Interview: 'bg-amber-100 text-amber-800',
  Offer: 'bg-purple-100 text-purple-800',
  Hired: 'bg-green-100 text-green-800',
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
  useEffect(() => { load(); }, [selectedJob]);

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

  return (
    <div>
      <PageHeader title="Recruitment" />
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
            <th className="px-4 py-3 text-left font-medium text-gray-700">Openings</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Candidates</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Status</th>
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
                <td className="px-4 py-3">{j.openings}</td>
                <td className="px-4 py-3">
                  <button onClick={() => setSelectedJob(selectedJob === j._id ? '' : j._id)} className="text-blue-600 hover:underline">{j.candidateCount} →</button>
                </td>
                <td className="px-4 py-3 text-gray-600">{j.status}</td>
                <td className="px-4 py-3 text-right space-x-2">
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
            <th className="px-4 py-3 text-left font-medium text-gray-700">Rating</th>
            <th className="px-4 py-3 text-left font-medium text-gray-700">Stage</th>
            <th className="px-4 py-3 text-right font-medium text-gray-700">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {candidates.length === 0 ? (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-gray-500">No candidates</td></tr>
            ) : candidates.map((c) => (
              <tr key={c._id}>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{c.name}</div>
                  <div className="text-xs text-gray-500">{c.email || ''}{c.phone ? ` · ${c.phone}` : ''}</div>
                </td>
                <td className="px-4 py-3 text-gray-600">{c.job?.title || '—'}</td>
                <td className="px-4 py-3">{'★'.repeat(c.rating || 0)}{'☆'.repeat(5 - (c.rating || 0))}</td>
                <td className="px-4 py-3"><span className={`text-xs px-2 py-0.5 rounded-lg ${STAGE_STYLES[c.stage]}`}>{c.stage}</span></td>
                <td className="px-4 py-3 text-right space-x-2">
                  <button onClick={() => openCandEdit(c)} className="text-blue-600 hover:underline">Edit</button>
                  <button onClick={() => removeCand(c)} className="text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
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
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Department" value={jobForm.department} onChange={(e) => setJobForm({ ...jobForm, department: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <input placeholder="Location" value={jobForm.location} onChange={(e) => setJobForm({ ...jobForm, location: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={jobForm.employmentType} onChange={(e) => setJobForm({ ...jobForm, employmentType: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  {['FullTime', 'PartTime', 'Contract', 'Intern'].map((t) => <option key={t}>{t}</option>)}
                </select>
                <input type="number" min="0" placeholder="Openings" value={jobForm.openings} onChange={(e) => setJobForm({ ...jobForm, openings: Number(e.target.value) })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={jobForm.status} onChange={(e) => setJobForm({ ...jobForm, status: e.target.value })} className="block w-full border rounded-lg px-3 py-2 col-span-2">
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
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="Email" value={candForm.email} onChange={(e) => setCandForm({ ...candForm, email: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <input placeholder="Phone" value={candForm.phone} onChange={(e) => setCandForm({ ...candForm, phone: e.target.value })} className="block w-full border rounded-lg px-3 py-2" />
                <select value={candForm.job} onChange={(e) => setCandForm({ ...candForm, job: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  <option value="">— Job —</option>
                  {jobs.map((j) => <option key={j._id} value={j._id}>{j.title}</option>)}
                </select>
                <select value={candForm.stage} onChange={(e) => setCandForm({ ...candForm, stage: e.target.value })} className="block w-full border rounded-lg px-3 py-2">
                  {STAGES.map((s) => <option key={s}>{s}</option>)}
                </select>
                <select value={candForm.rating} onChange={(e) => setCandForm({ ...candForm, rating: Number(e.target.value) })} className="block w-full border rounded-lg px-3 py-2 col-span-2">
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
