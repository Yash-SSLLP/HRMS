import { useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';

const ROUND_STATUS = ['Pending', 'Scheduled', 'Cleared', 'Rejected'];
const STATUS_STYLES = {
  Pending: 'bg-gray-100 text-gray-600',
  Scheduled: 'bg-blue-100 text-blue-700',
  Cleared: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
};
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short', hour12: true }) : '');

// Interview rounds assigned to the signed-in employee: join the meeting,
// record feedback and set the round result. HR sees the same status/feedback
// (with the who-changed-it audit trail) on the admin Recruitment page.
export default function EmployeeInterviews() {
  const [interviews, setInterviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({}); // per-round feedback drafts
  const [savingKey, setSavingKey] = useState('');

  const key = (iv) => `${iv.candidateId}:${iv.index}`;

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/recruitment/my-interviews');
      setInterviews(data.interviews);
      const d = {};
      data.interviews.forEach((iv) => { d[key(iv)] = iv.feedback || ''; });
      setDrafts(d);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load your interviews');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const save = async (iv, patch) => {
    const k = key(iv);
    setSavingKey(k);
    try {
      const { data } = await api.patch(`/recruitment/my-interviews/${iv.candidateId}/round`, { index: iv.index, ...patch });
      setInterviews((list) => list.map((x) => (key(x) === k ? data.interview : x)));
      toast.success('Saved');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally { setSavingKey(''); }
  };

  const viewResume = (iv) =>
    downloadFile(`/recruitment/my-interviews/${iv.candidateId}/resume`, `${iv.candidateName.replace(/\s+/g, '_')}_resume.pdf`)
      .catch((err) => toast.error(err.response?.data?.message || 'Could not open the résumé'));

  const open = interviews.filter((iv) => ['Pending', 'Scheduled'].includes(iv.status));
  const done = interviews.filter((iv) => !['Pending', 'Scheduled'].includes(iv.status));

  return (
    <div>
      <PageHeader title="My Interviews" subtitle="Interview rounds where you're the assigned interviewer · join the call, record feedback and set the result" />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

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
      ) : interviews.length === 0 ? (
        <div className="bg-white shadow rounded-lg p-8 text-center text-gray-500">
          No interviews assigned to you yet. When HR assigns you to a candidate's round, it shows up here.
        </div>
      ) : (
        <div className="space-y-6">
          {[['Upcoming', open], ['Completed', done]].map(([title, list]) => list.length > 0 && (
            <div key={title}>
              <h2 className="text-sm font-semibold text-gray-600 mb-2">{title}</h2>
              <div className="space-y-3">
                {list.map((iv) => {
                  const k = key(iv);
                  return (
                    <div key={k} className="bg-white shadow rounded-lg p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-semibold text-gray-900">{iv.candidateName}</div>
                          <div className="text-xs text-gray-500">
                            {iv.jobTitle || 'No role'} · {iv.label}
                            {iv.scheduledAt ? ` · ${fmtDateTime(iv.scheduledAt)}` : ''}
                          </div>
                        </div>
                        <span className={`text-[11px] px-2 py-0.5 rounded ${STATUS_STYLES[iv.status]}`}>{iv.status}</span>
                      </div>

                      <div className="flex flex-wrap items-center gap-2 mt-3">
                        {iv.meetingLink && (
                          <a href={iv.meetingLink} target="_blank" rel="noopener noreferrer"
                            className="text-xs px-2.5 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
                            ↗ Join meeting
                          </a>
                        )}
                        {iv.hasResume && (
                          <button onClick={() => viewResume(iv)} className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50">
                            View résumé
                          </button>
                        )}
                        <select
                          value={iv.status}
                          onChange={(e) => save(iv, { status: e.target.value, feedback: drafts[k] })}
                          disabled={savingKey === k}
                          className="text-xs border border-gray-300 rounded-lg px-2 py-1.5"
                          title="Set the round result"
                        >
                          {ROUND_STATUS.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </div>

                      <div className="mt-3 flex gap-2">
                        <input
                          value={drafts[k] ?? ''}
                          onChange={(e) => setDrafts((p) => ({ ...p, [k]: e.target.value }))}
                          placeholder="Your feedback for this round…"
                          className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm"
                        />
                        <button
                          onClick={() => save(iv, { feedback: drafts[k] })}
                          disabled={savingKey === k || (drafts[k] ?? '') === (iv.feedback || '')}
                          className="text-xs px-3 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
                        >
                          {savingKey === k ? 'Saving…' : 'Save feedback'}
                        </button>
                      </div>
                      {iv.decidedAt && <div className="mt-2 text-[11px] text-gray-400">Decided {fmtDateTime(iv.decidedAt)}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
