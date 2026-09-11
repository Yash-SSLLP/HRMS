/**
 * EmployeeInterviews — "My Interviews", for whoever is taking the interview.
 *
 * Reached two ways, deliberately by the same page: /employee/interviews in the
 * employee portal, and /admin/my-interviews in the admin portal, because a
 * CEO/MD has no employee portal at all and HR routinely puts them on the final
 * round. The three endpoints behind it authorise on IDENTITY, not on a
 * capability — the server only lets you touch a round whose `interviewer` is
 * you — so there is nothing role-specific to draw either way.
 *
 * The card is the interview itself, in the order the work happens: what the
 * EARLIER rounds found, then the call, then your own write-up. Reading the
 * previous panels first is the whole point — a Round 3 interviewer who has seen
 * Rounds 1 and 2 probes what they flagged instead of re-asking their questions.
 *
 * Loads from GET /recruitment/my-interviews, saves via
 * PATCH /recruitment/my-interviews/:candidateId/round, opens the candidate
 * résumé as an auth blob download.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import { formatDateTime12 } from '../utils/time';
import {
  AssessmentForm, AssessmentView, PreviousRounds,
  ROUND_STATUS_STYLES, assessmentOf, hasAssessment, SUGGESTED_REMARK_CHARS,
} from '../components/InterviewAssessment';

const ROUND_STATUS = ['Pending', 'Scheduled', 'Cleared', 'Rejected'];
// The two results that close a round — and the two the server will not accept
// without a written assessment behind them.
const DECIDED = ['Cleared', 'Rejected'];
const fmtDateTime = (d) => formatDateTime12(d);

// What the card holds while it is being edited. Split from the server copy so a
// half-typed write-up survives a background refresh of the list.
const draftOf = (iv) => ({
  status: iv.status || 'Pending',
  feedback: iv.feedback || '',
  assessment: assessmentOf(iv),
});

const sameDraft = (a, b) =>
  a.status === b.status && a.feedback === b.feedback
  && JSON.stringify(a.assessment) === JSON.stringify(b.assessment);

export default function EmployeeInterviews() {
  const [interviews, setInterviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});   // key -> draftOf()
  const [openKeys, setOpenKeys] = useState({}); // key -> is the write-up panel expanded
  const [savingKey, setSavingKey] = useState('');

  const key = (iv) => `${iv.candidateId}:${iv.index}`;

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/recruitment/my-interviews');
      setInterviews(data.interviews);
      const d = {};
      data.interviews.forEach((iv) => { d[key(iv)] = draftOf(iv); });
      setDrafts(d);
      // An interview still to be run opens ready to write; a decided one opens
      // as the record it now is, and takes a click to reopen.
      const open = {};
      data.interviews.forEach((iv) => { if (!DECIDED.includes(iv.status)) open[key(iv)] = true; });
      setOpenKeys(open);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load your interviews');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Persist the write-up (and the result) and swap in the server copy.
  const save = async (iv) => {
    const k = key(iv);
    const draft = drafts[k];
    setSavingKey(k);
    try {
      const { data } = await api.patch(`/recruitment/my-interviews/${iv.candidateId}/round`, {
        index: iv.index,
        status: draft.status,
        feedback: draft.feedback,
        assessment: draft.assessment,
      });
      setInterviews((list) => list.map((x) => (key(x) === k ? data.interview : x)));
      setDrafts((p) => ({ ...p, [k]: draftOf(data.interview) }));
      const decided = DECIDED.includes(data.interview.status);
      if (decided) setOpenKeys((p) => ({ ...p, [k]: false }));
      // Three different acts, three different confirmations — "recorded" on a
      // round that was already decided reads as though the verdict just changed.
      toast.success(decided
        ? (draft.status !== iv.status ? `Round ${data.interview.status.toLowerCase()}` : 'Assessment updated')
        : 'Assessment saved');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally { setSavingKey(''); }
  };

  const viewResume = (iv) =>
    downloadFile(`/recruitment/my-interviews/${iv.candidateId}/resume`, `${iv.candidateName.replace(/\s+/g, '_')}_resume.pdf`)
      .catch((err) => toast.error(err.response?.data?.message || 'Could not open the résumé'));

  const { open, done } = useMemo(() => ({
    open: interviews.filter((iv) => !DECIDED.includes(iv.status)),
    done: interviews.filter((iv) => DECIDED.includes(iv.status)),
  }), [interviews]);

  const card = (iv) => {
    const k = key(iv);
    const draft = drafts[k] || draftOf(iv);
    const suggestChars = iv.suggestedRemarkChars || SUGGESTED_REMARK_CHARS;
    const short = draft.feedback.trim().length < suggestChars;
    const decidingNow = DECIDED.includes(draft.status) && draft.status !== iv.status;
    const dirty = !sameDraft(draft, draftOf(iv));
    const expanded = !!openKeys[k];
    const saveLabel = savingKey === k ? 'Saving…'
      : decidingNow ? `Record ${draft.status.toLowerCase()}`
        : DECIDED.includes(iv.status) ? 'Update assessment'
          : 'Save assessment';

    const setDraft = (patch) => setDrafts((p) => ({ ...p, [k]: { ...draft, ...patch } }));

    return (
      <div key={k} className="bg-white shadow rounded-lg p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-gray-900">{iv.candidateName}</div>
            <div className="text-xs text-gray-500">
              {iv.jobTitle || 'No role'} · {iv.label}
              {iv.scheduledAt ? ` · ${fmtDateTime(iv.scheduledAt)}` : ''}
              {iv.durationMinutes ? ` · ${iv.durationMinutes} min` : ''}
            </div>
          </div>
          {/* Only the round's status here: the recommendation and the average
              belong to the write-up below, and printing them in both places
              read as two different facts about the same round. */}
          <span className={`text-[11px] px-2 py-0.5 rounded ${ROUND_STATUS_STYLES[iv.status]}`}>{iv.status}</span>
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
          <button
            onClick={() => setOpenKeys((p) => ({ ...p, [k]: !expanded }))}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50"
          >
            {expanded ? 'Hide assessment' : DECIDED.includes(iv.status) ? 'Edit assessment' : 'Record assessment'}
          </button>
          {!expanded && !hasAssessment(iv) && (
            <span className="text-[11px] text-amber-600">No write-up recorded yet</span>
          )}
        </div>

        {/* What the earlier panels found. Above the form on purpose: it is meant
            to be read before the interview, not after the verdict is typed. */}
        {iv.previousRounds?.length > 0 && (
          <div className="mt-3">
            <PreviousRounds rounds={iv.previousRounds} defaultOpen={!DECIDED.includes(iv.status)} />
          </div>
        )}

        {/* The decided round as it stands, when the form is closed. */}
        {!expanded && hasAssessment(iv) && (
          <div className="mt-3 border-t border-gray-100 pt-3">
            <AssessmentView round={iv} dense />
          </div>
        )}

        {expanded && (
          <div className="mt-4 border-t border-gray-100 pt-4">
            <AssessmentForm
              value={{ feedback: draft.feedback, assessment: draft.assessment }}
              onChange={(v) => setDraft({ feedback: v.feedback, assessment: v.assessment })}
              suggestChars={suggestChars}
            />

            <div className="mt-4">
              <label className="block text-xs font-semibold text-gray-700 mb-1">Result of this round</label>
              <div className="flex flex-wrap items-center gap-2">
                {ROUND_STATUS.map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setDraft({ status: s })}
                    className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors ${
                      draft.status === s
                        ? `${ROUND_STATUS_STYLES[s]} border-transparent ring-2 ring-offset-1 ring-gray-300`
                        : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
              <p className={`text-[11px] max-w-xl ${short ? 'text-amber-600' : 'text-gray-500'}`}>
                {short
                  ? 'Short remarks still save — but this is the whole record of the round for the next interviewer, for HR and for the CEO/MD.'
                  : 'Saved against the candidate: HR, the next round’s interviewer and the CEO/MD see this write-up with your name on it.'}
              </p>
              {/* Never disabled except while it is saving. Nothing about the
                  write-up gates recording the round: the interviewer has
                  finished the call and chosen a verdict, and refusing the save
                  loses the ratings and the recommendation along with it. */}
              <button
                onClick={() => save(iv)}
                disabled={savingKey === k}
                className="text-sm font-medium px-4 py-2 rounded-lg bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-50"
              >
                {saveLabel}
              </button>
            </div>
          </div>
        )}

        {iv.decidedAt && <div className="mt-2 text-[11px] text-gray-400">Decided {fmtDateTime(iv.decidedAt)}</div>}
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="My Interviews"
        subtitle="Interview rounds where you're the assigned interviewer · read what the earlier rounds found, join the call, then record your assessment"
      />
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
          No interviews assigned to you yet. When HR assigns you to a candidate&apos;s round, it shows up here.
        </div>
      ) : (
        <div className="space-y-6">
          {[['Upcoming', open], ['Completed', done]].map(([title, list]) => list.length > 0 && (
            <div key={title}>
              <h2 className="text-sm font-semibold text-gray-600 mb-2">{title}</h2>
              <div className="space-y-3">{list.map(card)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
