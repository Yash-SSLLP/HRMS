import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api/client';
import { COMPANY_NAME, COMPANY_LOGO } from '../config/company';

const blank = {
  name: '', email: '', phone: '', currentCompany: '',
  experienceYears: '', noticePeriod: '', expectedCtc: '', coverNote: '',
};

function Shell({ children }) {
  return (
    <div className="min-h-full flex items-center justify-center bg-gradient-to-br from-gray-100 via-gray-50 to-blue-50 px-4 py-10">
      <div className="w-full max-w-xl bg-white shadow-lg rounded-2xl p-6 sm:p-8 border border-gray-100">
        <div className="flex flex-col items-center text-center mb-5">
          <img src={COMPANY_LOGO} alt={COMPANY_NAME} className="h-12 w-auto mb-3" />
        </div>
        {children}
      </div>
    </div>
  );
}

export default function ApplyForm() {
  const { jobId } = useParams();
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState(blank);
  const [resume, setResume] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data } = await api.get(`/recruitment/apply/${jobId}`);
        setJob(data.job);
      } catch (err) {
        setError(err.response?.data?.message || 'This opening is unavailable.');
      } finally {
        setLoading(false);
      }
    })();
  }, [jobId]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (!resume) { setError('Please attach your resume.'); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => { if (v) fd.append(k, v); });
      fd.append('resume', resume);
      await api.post(`/recruitment/apply/${jobId}`, fd);
      setDone(true);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not submit your application.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <Shell><p className="text-center text-gray-500">Loading…</p></Shell>;

  if (error && !job) {
    return <Shell><div className="text-center text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">{error}</div></Shell>;
  }

  if (done) {
    return (
      <Shell>
        <div className="text-center py-6">
          <div className="text-4xl mb-3">✅</div>
          <h1 className="text-xl font-bold text-gray-900">Application submitted</h1>
          <p className="text-sm text-gray-500 mt-2">Thanks for applying to <strong>{job.title}</strong>. Our team will review your profile and get in touch.</p>
        </div>
      </Shell>
    );
  }

  if (job && !job.open) {
    return (
      <Shell>
        <h1 className="text-xl font-bold text-gray-900 text-center">{job.title}</h1>
        <p className="text-center text-sm text-red-600 mt-3">This position is no longer accepting applications.</p>
      </Shell>
    );
  }

  const input = 'block w-full rounded-lg border border-gray-300 px-3 py-2 outline-none focus:ring-2 focus:ring-gray-300';

  return (
    <Shell>
      <div className="text-center mb-5">
        <h1 className="text-2xl font-bold text-gray-900">{job.title}</h1>
        <p className="text-sm text-gray-500 mt-1">
          {[job.department, job.location, job.employmentType].filter(Boolean).join(' · ')}
        </p>
        {job.description && <p className="text-sm text-gray-600 mt-3 whitespace-pre-wrap text-left">{job.description}</p>}
      </div>

      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full name *</label>
            <input required value={form.name} onChange={set('name')} className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email *</label>
            <input type="email" required value={form.email} onChange={set('email')} className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone</label>
            <input value={form.phone} onChange={set('phone')} className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Current company</label>
            <input value={form.currentCompany} onChange={set('currentCompany')} className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Experience (years)</label>
            <input type="number" min="0" step="0.5" value={form.experienceYears} onChange={set('experienceYears')} className={input} />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Notice period</label>
            <input value={form.noticePeriod} onChange={set('noticePeriod')} placeholder="e.g. 30 days" className={input} />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1">Expected CTC</label>
            <input value={form.expectedCtc} onChange={set('expectedCtc')} placeholder="e.g. ₹12 LPA" className={input} />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Cover note</label>
          <textarea rows={3} value={form.coverNote} onChange={set('coverNote')} className={input} placeholder="Why are you a great fit?" />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Resume * <span className="text-gray-400 font-normal">(PDF or Word, max 5 MB)</span></label>
          <input
            type="file" required accept=".pdf,.doc,.docx,application/pdf,application/msword"
            onChange={(e) => setResume(e.target.files?.[0] || null)}
            className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-gray-900 file:text-white hover:file:bg-gray-700"
          />
        </div>

        {error && <div className="text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

        <button type="submit" disabled={submitting} className="w-full bg-gray-900 text-white py-2.5 rounded-lg font-medium hover:bg-gray-700 disabled:opacity-60">
          {submitting ? 'Submitting…' : 'Submit application'}
        </button>
      </form>
    </Shell>
  );
}
