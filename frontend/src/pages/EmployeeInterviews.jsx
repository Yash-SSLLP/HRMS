/**
 * EmployeeInterviews — "My Interviews", for whoever is taking the interview.
 *
 * Reached two ways, deliberately by the same page: /employee/interviews in the
 * employee portal, and /admin/my-interviews in the admin portal, because a
 * CEO/MD has no employee portal at all and HR routinely puts them on the final
 * round. The endpoints behind it authorise on IDENTITY, not on a capability —
 * the server only lets you touch a round whose `interviewer` is you — so there
 * is nothing role-specific to draw either way.
 *
 * REDESIGNED 2026-09-30 from the user's sketch: an interview DESK, one
 * interview at a time, in three columns —
 *
 *   Candidate         Current round               Previous rounds
 *   name, when,       everything YOU fill in,     what every earlier panel
 *   Join, résumé      numbered, with a checklist  wrote, read-only
 *
 * Above it, "Your interviews": every round you are on, by list (Upcoming /
 * No show / On hold / Completed), as cards to pick from. The NEXT interview —
 * the soonest one still to run — is picked on arrival, so the page opens on the
 * person you are about to meet. Below 1280px the previous rounds tuck under the
 * candidate card; on a phone everything stacks in reading order: who, what the
 * others said, then your write-up.
 *
 * Loads from GET /recruitment/my-interviews, saves via
 * PATCH /recruitment/my-interviews/:candidateId/round, moves a round via
 * POST /recruitment/my-interviews/:candidateId/round/reschedule, opens the
 * candidate's résumé as an auth blob download.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiBriefcase, FiCalendar, FiCheck, FiClock, FiEdit2, FiExternalLink, FiFileText, FiMapPin,
  FiRefreshCw, FiUserX, FiVideo, FiLock,
} from 'react-icons/fi';
import api from '../api/client';
import { downloadFile } from '../api/download';
import PageHeader from '../components/PageHeader';
import { formatDateTime12, formatTime12 } from '../utils/time';
import {
  PriorRejectionChip, PriorRejections, RoundBadge, RecommendationChip, StarRow,
  RATING_FIELDS, RECOMMENDATIONS, REC_STYLES, REMARK_PLACEHOLDER,
  ROUND_STATUS, ROUND_STATUS_STYLES, roundStatusLabel, assessmentOf, hasAssessment, averageRating,
  SUGGESTED_REMARK_CHARS, RescheduleDialog, RescheduleTrail, canRescheduleRound, roundBoxClass,
} from '../components/InterviewAssessment';

// The two results that close a round.
const DECIDED = ['Cleared', 'Rejected'];
// Paused: not decided, but nothing to do on it either.
const HELD = 'OnHold';
// The candidate did not turn up — the round waits on a new date.
const NO_SHOW = 'NoShow';
// A round still to be run: the Upcoming list.
const isOpenRound = (s) => !DECIDED.includes(s) && s !== HELD && s !== NO_SHOW;

const LISTS = [
  { key: 'open', label: 'Upcoming' },
  { key: 'missed', label: 'No show' },
  { key: 'held', label: 'On hold' },
  { key: 'done', label: 'Completed' },
];
const listOf = (status) => (DECIDED.includes(status) ? 'done'
  : status === HELD ? 'held' : status === NO_SHOW ? 'missed' : 'open');

// What the desk holds while it is being edited. Split from the server copy so a
// half-typed write-up survives switching to another interview and back.
const draftOf = (iv) => ({
  status: iv.status || 'Pending',
  feedback: iv.feedback || '',
  assessment: assessmentOf(iv),
});
const sameDraft = (a, b) => a.status === b.status && a.feedback === b.feedback
  && JSON.stringify(a.assessment) === JSON.stringify(b.assessment);

const keyOf = (iv) => `${iv.candidateId}:${iv.index}`;
const initials = (name = '') => name.trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
const timeOf = (iv) => (iv.scheduledAt ? new Date(iv.scheduledAt).getTime() : null);

/** "Today · 3:00 PM", "Tomorrow · 11:30 AM", or "28 Sept 2026, 3:00 PM". */
function whenLabel(d) {
  if (!d) return 'Not scheduled yet';
  const at = new Date(d);
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate());
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.round((day - today) / 86400000);
  if (diff === 0) return `Today · ${formatTime12(at)}`;
  if (diff === 1) return `Tomorrow · ${formatTime12(at)}`;
  if (diff === -1) return `Yesterday · ${formatTime12(at)}`;
  return formatDateTime12(at);
}

/** "in 45 min", "in 3 h", "in 2 days", "started 10 min ago", "2 days ago". */
function relativeLabel(d, durationMin = 0) {
  if (!d) return '';
  const start = new Date(d).getTime();
  const now = Date.now();
  const mins = Math.round((start - now) / 60000);
  if (mins > 0) {
    if (mins < 60) return `in ${mins} min`;
    if (mins < 24 * 60) return `in ${Math.round(mins / 60)} h`;
    return `in ${Math.round(mins / 1440)} days`;
  }
  const end = start + (durationMin || 45) * 60000;
  if (now <= end) return 'happening now';
  const ago = Math.round((now - start) / 60000);
  if (ago < 60) return `${ago} min ago`;
  if (ago < 24 * 60) return `${Math.round(ago / 60)} h ago`;
  return `${Math.round(ago / 1440)} days ago`;
}

export default function EmployeeInterviews() {
  const [interviews, setInterviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState({});
  const [list, setList] = useState('open');
  const [selKey, setSelKey] = useState('');
  const [editing, setEditing] = useState({}); // key -> reopened a decided write-up
  const [saving, setSaving] = useState(false);
  const [moving, setMoving] = useState(null);

  // Each list in its own order: the soonest interview first while it is still
  // to come, the latest decided first once it is done.
  const lists = useMemo(() => {
    const by = { open: [], missed: [], held: [], done: [] };
    interviews.forEach((iv) => by[listOf(iv.status)].push(iv));
    const soonest = (a, b) => (timeOf(a) ?? Infinity) - (timeOf(b) ?? Infinity);
    by.open.sort(soonest);
    by.held.sort(soonest);
    by.missed.sort((a, b) => (timeOf(b) ?? 0) - (timeOf(a) ?? 0));
    by.done.sort((a, b) => new Date(b.decidedAt || 0) - new Date(a.decidedAt || 0));
    return by;
  }, [interviews]);

  // THE NEXT INTERVIEW: the first upcoming one that has not already finished
  // (a round run earlier today and not yet written up is still "open", but the
  // one to open the page on is the person you are about to meet).
  const nextKey = useMemo(() => {
    const now = Date.now();
    const ahead = lists.open.find((iv) => {
      const t = timeOf(iv);
      return t != null && t + (iv.durationMinutes || 45) * 60000 >= now;
    });
    const first = ahead || lists.open[0];
    return first ? keyOf(first) : '';
  }, [lists]);

  const load = async () => {
    setLoading(true); setError('');
    try {
      const { data } = await api.get('/recruitment/my-interviews');
      const rows = data.interviews || [];
      setInterviews(rows);
      const d = {};
      rows.forEach((iv) => { d[keyOf(iv)] = draftOf(iv); });
      setDrafts(d);
    } catch (err) {
      setError(err.response?.data?.message || 'Failed to load your interviews');
    } finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  // Arrive on the next interview; if there is none, on the first list that has
  // anything in it.
  useEffect(() => {
    if (loading || selKey) return;
    if (nextKey) { setList('open'); setSelKey(nextKey); return; }
    const firstList = LISTS.find((l) => lists[l.key].length);
    if (firstList) { setList(firstList.key); setSelKey(keyOf(lists[firstList.key][0])); }
  }, [loading, selKey, nextKey, lists]);

  const selected = interviews.find((iv) => keyOf(iv) === selKey) || null;

  const pickList = (k) => {
    setList(k);
    const first = k === 'open' && nextKey ? nextKey : (lists[k][0] ? keyOf(lists[k][0]) : '');
    if (first) setSelKey(first);
  };

  const replaceRow = (row) => {
    const k = keyOf(row);
    setInterviews((all) => all.map((x) => (keyOf(x) === k ? row : x)));
    setDrafts((p) => ({ ...p, [k]: draftOf(row) }));
    // It may have moved to another list — follow it there.
    setList(listOf(row.status));
  };

  const save = async (iv) => {
    const k = keyOf(iv);
    const draft = drafts[k];
    setSaving(true);
    try {
      const { data } = await api.patch(`/recruitment/my-interviews/${iv.candidateId}/round`, {
        index: iv.index,
        status: draft.status,
        feedback: draft.feedback,
        assessment: draft.assessment,
      });
      replaceRow(data.interview);
      setEditing((p) => ({ ...p, [k]: false }));
      const now = data.interview.status;
      const changed = draft.status !== iv.status;
      toast.success(now === HELD && changed ? 'Round put on hold'
        : now === NO_SHOW && changed ? 'Recorded as a no-show — HR has been told'
          : DECIDED.includes(now)
            ? (changed ? `Round ${now.toLowerCase()}` : 'Assessment updated')
            : 'Assessment saved');
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not save');
    } finally { setSaving(false); }
  };

  const reschedule = async (iv, { scheduledAt, reason }) => {
    try {
      const { data } = await api.post(`/recruitment/my-interviews/${iv.candidateId}/round/reschedule`, {
        index: iv.index, scheduledAt, reason,
      });
      replaceRow(data.interview);
      toast.success(`Rescheduled to ${formatDateTime12(data.interview.scheduledAt)} — HR has been told`);
      return true;
    } catch (err) {
      toast.error(err.response?.data?.message || 'Could not reschedule');
      return false;
    }
  };

  const viewResume = (iv) =>
    downloadFile(`/recruitment/my-interviews/${iv.candidateId}/resume`, `${iv.candidateName.replace(/\s+/g, '_')}_resume.pdf`)
      .catch((err) => toast.error(err.response?.data?.message || 'Could not open the résumé'));

  return (
    <div className="ivd">
      <PageHeader
        title="My Interviews"
      />
      {error && <div className="mb-4 text-sm text-red-700 bg-red-50 border border-red-200 px-3 py-2 rounded-lg">{error}</div>}

      {loading ? (
        <DeskSkeleton />
      ) : interviews.length === 0 ? (
        <div className="ivd-card p-10 text-center">
          <div className="ivd-empty-icon mx-auto mb-3"><FiCalendar size={22} /></div>
          <div className="text-base font-semibold text-gray-900">No interviews assigned to you yet</div>
        </div>
      ) : (
        <>
          {/* ── Your interviews: pick one ───────────────────────────── */}
          <section className="ivd-card p-3 sm:p-4 mb-4">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
              <h2 className="text-sm font-semibold text-gray-900">Your interviews</h2>
              <div className="ivd-seg" role="tablist" aria-label="Which interviews">
                {LISTS.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    role="tab"
                    aria-selected={list === l.key}
                    onClick={() => pickList(l.key)}
                    disabled={!lists[l.key].length}
                    className={`ivd-seg-btn ${list === l.key ? 'is-on' : ''}`}
                  >
                    {l.label}
                    <span className="ivd-seg-count">{lists[l.key].length}</span>
                  </button>
                ))}
              </div>
            </div>
            {lists[list].length === 0 ? (
              <p className="text-sm text-gray-500 px-1 py-2">Nothing here.</p>
            ) : (
              <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {lists[list].map((iv) => (
                  <QueueCard
                    key={keyOf(iv)}
                    iv={iv}
                    active={keyOf(iv) === selKey}
                    isNext={keyOf(iv) === nextKey}
                    dirty={drafts[keyOf(iv)] && !sameDraft(drafts[keyOf(iv)], draftOf(iv))}
                    onPick={() => setSelKey(keyOf(iv))}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── The desk: one interview ─────────────────────────────── */}
          {selected && (
            <Desk
              key={selKey}
              iv={selected}
              isNext={selKey === nextKey}
              draft={drafts[selKey] || draftOf(selected)}
              setDraft={(patch) => setDrafts((p) => ({ ...p, [selKey]: { ...(p[selKey] || draftOf(selected)), ...patch } }))}
              editing={!!editing[selKey]}
              onEdit={() => setEditing((p) => ({ ...p, [selKey]: true }))}
              onCancelEdit={() => {
                setEditing((p) => ({ ...p, [selKey]: false }));
                setDrafts((p) => ({ ...p, [selKey]: draftOf(selected) }));
              }}
              saving={saving}
              onSave={() => save(selected)}
              onResume={() => viewResume(selected)}
              onReschedule={() => setMoving(selected)}
            />
          )}
        </>
      )}

      {moving && (
        <RescheduleDialog
          round={moving}
          title={`Reschedule ${moving.label}`}
          subtitle={`${moving.candidateName}${moving.jobTitle ? ` · ${moving.jobTitle}` : ''}`}
          note="The round goes back to Scheduled and HR is told."
          onClose={() => setMoving(null)}
          onSubmit={(v) => reschedule(moving, v)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
/** One interview in the picker. */
function QueueCard({ iv, active, isNext, dirty, onPick }) {
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={`ivd-queue ${active ? 'is-active' : ''}`}
    >
      <span className="ivd-avatar ivd-avatar-sm">{initials(iv.candidateName)}</span>
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-gray-900">{iv.candidateName}</span>
          {isNext && <span className="ivd-next-tag">Next</span>}
        </span>
        <span className="block truncate text-[11px] text-gray-500">
          {iv.label} · {iv.jobTitle || 'No role'}
        </span>
        <span className="block truncate text-[11px] text-gray-500">
          {whenLabel(iv.scheduledAt)}
          {dirty ? <span className="text-amber-600"> · unsaved</span> : null}
        </span>
      </span>
      <span className={`shrink-0 self-start text-[10px] font-medium px-1.5 py-0.5 rounded ${ROUND_STATUS_STYLES[iv.status] || ROUND_STATUS_STYLES.Pending}`}>
        {roundStatusLabel(iv.status)}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
function Desk({ iv, isNext, draft, setDraft, editing, onEdit, onCancelEdit, saving, onSave, onResume, onReschedule }) {
  const decided = DECIDED.includes(iv.status);
  const written = hasAssessment(iv);
  // A decided round (or a paused / missed one already written up) opens as the
  // record it is; Edit reopens the form.
  const showForm = editing || (!decided && !(written && !isOpenRound(iv.status)));

  return (
    <div className="ivd-desk">
      <div className="ivd-area-cand">
        <CandidateCard iv={iv} isNext={isNext} onResume={onResume} onReschedule={onReschedule} />
      </div>
      <div className="ivd-area-cur">
        <CurrentRound
          iv={iv}
          draft={draft}
          setDraft={setDraft}
          showForm={showForm}
          editing={editing}
          onEdit={onEdit}
          onCancelEdit={onCancelEdit}
          saving={saving}
          onSave={onSave}
        />
      </div>
      <div className="ivd-area-prev">
        <PreviousRoundsPanel iv={iv} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Column 1 — who, when, and the two things you open: the call and the résumé. */
function CandidateCard({ iv, isNext, onResume, onReschedule }) {
  const status = iv.status || 'Pending';
  const eyebrow = isNext ? 'Next interview'
    : status === NO_SHOW ? 'Did not show up'
      : status === HELD ? 'On hold'
        : DECIDED.includes(status) ? 'Completed' : 'Upcoming';
  const rel = relativeLabel(iv.scheduledAt, iv.durationMinutes);
  const canMove = iv.canReschedule ?? canRescheduleRound(iv);
  const background = [
    iv.experienceYears != null ? `${iv.experienceYears} yr${iv.experienceYears === 1 ? '' : 's'} experience` : '',
    iv.currentCompany ? `Now at ${iv.currentCompany}` : '',
    iv.noticePeriod ? `Notice: ${iv.noticePeriod}` : '',
  ].filter(Boolean);

  return (
    <section className="ivd-card ivd-sticky">
      <div className={`ivd-cand-hero ${isNext ? 'is-next' : ''}`}>
        <div className="ivd-eyebrow">{eyebrow}</div>
        <div className="flex items-center gap-3 mt-2">
          <span className="ivd-avatar">{initials(iv.candidateName)}</span>
          <div className="min-w-0">
            <div className="text-lg font-bold text-gray-900 leading-tight break-words">{iv.candidateName}</div>
            <div className="text-xs text-gray-500 mt-0.5 break-words">{iv.jobTitle || 'No role'}</div>
          </div>
        </div>
        {iv.priorRejection && <PriorRejectionChip flag={iv.priorRejection} className="mt-2" />}
      </div>

      <dl className="ivd-facts">
        <div>
          <dt>Round</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <RoundBadge>{iv.label}</RoundBadge>
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded ${ROUND_STATUS_STYLES[status] || ROUND_STATUS_STYLES.Pending}`}>
              {roundStatusLabel(status)}
            </span>
          </dd>
        </div>
        <div>
          <dt><FiCalendar size={12} /> When</dt>
          <dd>
            <span className="font-semibold text-gray-900">{whenLabel(iv.scheduledAt)}</span>
            {rel && <span className={`ivd-rel ${rel === 'happening now' ? 'is-live' : ''}`}>{rel}</span>}
          </dd>
        </div>
        {iv.durationMinutes ? (
          <div><dt><FiClock size={12} /> Length</dt><dd>{iv.durationMinutes} min</dd></div>
        ) : null}
        {iv.location ? (
          <div><dt><FiMapPin size={12} /> Location</dt><dd>{iv.location}</dd></div>
        ) : null}
        {background.length > 0 && (
          <div><dt><FiBriefcase size={12} /> Background</dt><dd>{background.join(' · ')}</dd></div>
        )}
      </dl>

      <div className="px-4 pb-4 space-y-2">
        {iv.meetingLink ? (
          <a href={iv.meetingLink} target="_blank" rel="noopener noreferrer" className="ivd-btn ivd-btn-primary accent-bg on-accent">
            <FiVideo size={16} /> Join meeting <FiExternalLink size={13} className="opacity-80" />
          </a>
        ) : (
          <div className="ivd-btn ivd-btn-ghost is-disabled"><FiVideo size={16} /> No meeting link yet</div>
        )}
        {iv.hasResume ? (
          <button type="button" onClick={onResume} className="ivd-btn ivd-btn-ghost">
            <FiFileText size={16} /> View résumé
          </button>
        ) : (
          <div className="ivd-btn ivd-btn-ghost is-disabled"><FiFileText size={16} /> No résumé uploaded</div>
        )}
        {canMove && (
          <button type="button" onClick={onReschedule} className={`ivd-btn ivd-btn-ghost ${status === NO_SHOW ? 'is-warn' : ''}`}>
            <FiRefreshCw size={15} /> Reschedule
          </button>
        )}

        {status === NO_SHOW && (
          <p className="ivd-note is-warn">
            <FiUserX size={14} className="shrink-0 mt-0.5" />
            <span>The candidate did not show up{iv.scheduledAt ? ` for ${formatDateTime12(iv.scheduledAt)}` : ''}. Reschedule to hold the round again.</span>
          </p>
        )}
        <RescheduleTrail items={iv.reschedules || []} />
        {iv.decidedAt && (
          <p className="text-[11px] text-gray-400">
            {status === NO_SHOW ? 'No-show recorded' : 'Decided'} {formatDateTime12(iv.decidedAt)}
          </p>
        )}
      </div>

      {/* Above everything else they read: we have turned this person down before. */}
      {iv.priorRejection && (
        <div className="px-4 pb-4">
          <PriorRejections flag={iv.priorRejection} defaultOpen={isOpenRound(status)} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
/**
 * Column 2 — the round YOU are writing up. Every field the write-up has is a
 * numbered step, and the checklist at the top says which are done, so nothing
 * is missed and nothing is a surprise.
 */
function CurrentRound({ iv, draft, setDraft, showForm, editing, onEdit, onCancelEdit, saving, onSave }) {
  const a = draft.assessment;
  const suggest = iv.suggestedRemarkChars || SUGGESTED_REMARK_CHARS;
  const rated = RATING_FIELDS.filter((f) => (a.ratings[f.key] || 0) > 0).length;
  const remarkLen = draft.feedback.trim().length;
  const steps = [
    { n: 1, label: `Ratings ${rated}/${RATING_FIELDS.length}`, done: rated > 0 },
    { n: 2, label: 'Strengths', done: !!a.strengths.trim() },
    { n: 3, label: 'Concerns', done: !!a.concerns.trim() },
    { n: 4, label: 'Overall remarks', done: remarkLen >= suggest },
    { n: 5, label: 'Recommendation', done: !!a.recommendation },
    { n: 6, label: 'Result', done: draft.status !== 'Pending' && draft.status !== 'Scheduled' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const setA = (patch) => setDraft({ assessment: { ...a, ...patch } });
  const decidingNow = DECIDED.includes(draft.status) && draft.status !== iv.status;
  const dirty = !sameDraft(draft, draftOf(iv));
  const saveLabel = saving ? 'Saving…'
    : decidingNow ? `Save & mark ${draft.status.toLowerCase()}`
      : draft.status === HELD && iv.status !== HELD ? 'Save & put on hold'
        : draft.status === NO_SHOW && iv.status !== NO_SHOW ? 'Record no-show'
          : DECIDED.includes(iv.status) ? 'Update assessment' : 'Save assessment';
  const box = 'w-full border border-gray-300 rounded-xl px-3 py-2.5 text-sm bg-white focus:outline-none';

  return (
    <section className="my-round-panel ivd-current">
      <header className="my-round-panel-head px-4 sm:px-5 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="ivd-eyebrow">Current round</div>
            <div className="flex flex-wrap items-center gap-2 mt-1">
              <RoundBadge>{iv.label}</RoundBadge>
              <h2 className="text-base font-bold text-gray-900">Your assessment</h2>
            </div>
            <p className="text-xs text-gray-500 mt-1">
              {showForm
                ? <>For <span className="font-medium text-gray-700">{iv.candidateName}</span>.</>
                : <>What you recorded for <span className="font-medium text-gray-700">{iv.candidateName}</span>.</>}
            </p>
          </div>
          {showForm && (
            <div className="ivd-progress" title={`${doneCount} of ${steps.length} filled in`}>
              <span className="text-lg font-bold text-gray-900">{doneCount}</span>
              <span className="text-xs text-gray-500">/{steps.length}</span>
            </div>
          )}
        </div>
        {showForm && (
          <ol className="ivd-checklist mt-3">
            {steps.map((s) => (
              <li key={s.n} className={s.done ? 'is-done' : ''}>
                <span className="ivd-check">{s.done ? <FiCheck size={11} /> : s.n}</span>
                {s.label}
              </li>
            ))}
          </ol>
        )}
      </header>

      {!showForm ? (
        <div className="p-4 sm:p-5">
          {hasAssessment(iv) ? (
            <WriteUp round={iv} />
          ) : (
            <p className="text-sm text-gray-500">No write-up recorded for this round.</p>
          )}
          <button type="button" onClick={onEdit} className="ivd-btn ivd-btn-ghost mt-4 w-auto px-4">
            <FiEdit2 size={14} /> Edit assessment
          </button>
        </div>
      ) : (
        <>
          <div className="p-4 sm:p-5 space-y-6">
            {/* 1 — ratings */}
            <Step n={1} title="Rate each area">
              <div className="ivd-ratings">
                {RATING_FIELDS.map((f) => (
                  <div key={f.key} className="ivd-rating-row">
                    <span className="text-sm text-gray-800">{f.label}</span>
                    <StarRow value={a.ratings[f.key] || 0} onChange={(n) => setA({ ratings: { ...a.ratings, [f.key]: n } })} />
                  </div>
                ))}
              </div>
            </Step>

            {/* 2 + 3 — strengths and concerns */}
            <div className="grid gap-6 md:grid-cols-2">
              <Step n={2} title="Strengths">
                <textarea rows={4} value={a.strengths} onChange={(e) => setA({ strengths: e.target.value })}
                  placeholder="e.g. Walked through a real client escalation and owned the outcome." className={box} />
              </Step>
              <Step n={3} title="Concerns / to probe">
                <textarea rows={4} value={a.concerns} onChange={(e) => setA({ concerns: e.target.value })}
                  placeholder="e.g. Pricing conversations are thin — test in the next round." className={box} />
              </Step>
            </div>

            {/* 4 — overall remarks */}
            <Step n={4} title="Overall remarks">
              <textarea rows={5} value={draft.feedback} onChange={(e) => setDraft({ feedback: e.target.value })}
                placeholder={REMARK_PLACEHOLDER} className={box} />
              <div className="flex justify-between gap-2 mt-1">
                <span className={`text-[11px] ${remarkLen < suggest ? 'text-amber-600' : 'text-gray-400'}`}>
                  {remarkLen < suggest ? 'A couple of sentences is worth more than a line.' : 'Written up.'}
                </span>
                <span className="text-[11px] text-gray-400">{remarkLen} chars</span>
              </div>
            </Step>

            {/* 5 — recommendation */}
            <Step n={5} title="Your recommendation">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {RECOMMENDATIONS.map((r) => {
                  const on = a.recommendation === r;
                  return (
                    <button key={r} type="button" onClick={() => setA({ recommendation: on ? '' : r })}
                      aria-pressed={on}
                      className={`ivd-choice ${on ? `is-on ${REC_STYLES[r]}` : ''}`}>
                      {r}
                    </button>
                  );
                })}
              </div>
            </Step>

            {/* 6 — the round's result */}
            <Step n={6} title={`Result of ${iv.label}`}>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ROUND_STATUS.map((st) => {
                  const on = draft.status === st;
                  return (
                    <button key={st} type="button" onClick={() => setDraft({ status: st })}
                      aria-pressed={on}
                      className={`ivd-choice ${on ? `is-on ${ROUND_STATUS_STYLES[st]}` : ''}`}>
                      {roundStatusLabel(st)}
                    </button>
                  );
                })}
              </div>
            </Step>
          </div>

          {/* Never disabled except while saving: a verdict the interviewer has
              reached must always be recordable. */}
          <footer className="ivd-savebar">
            <span className="text-[11px] text-gray-500 min-w-0">
              {dirty ? 'You have changes that are not saved yet.' : 'Everything here is saved.'}
            </span>
            <div className="flex items-center gap-2 shrink-0">
              {editing && (
                <button type="button" onClick={onCancelEdit} className="ivd-btn ivd-btn-ghost w-auto px-4">Cancel</button>
              )}
              <button type="button" onClick={onSave} disabled={saving} className="ivd-btn ivd-btn-primary accent-bg on-accent w-auto px-5 disabled:opacity-50">
                {saveLabel}
              </button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}

function Step({ n, title, children }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <span className="ivd-step-n">{n}</span>
        <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
/** Column 3 — every earlier round of this application, read-only. */
function PreviousRoundsPanel({ iv }) {
  const rounds = iv.previousRounds || [];
  const written = rounds.filter(hasAssessment).length;
  return (
    <section className="ivd-card ivd-sticky">
      <header className="px-4 py-3 border-b border-gray-100">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-gray-900">Previous rounds</h2>
          <span className="inline-flex items-center gap-1 text-[11px] text-gray-500"><FiLock size={11} /> Read-only</span>
        </div>
        <p className="text-[11px] text-gray-500 mt-0.5">
          {rounds.length
            ? `${written} of ${rounds.length} earlier round${rounds.length === 1 ? '' : 's'} written up`
            : 'Nothing before this one'}
        </p>
      </header>
      <div className="p-3 space-y-3">
        {rounds.length === 0 ? (
          <div className="text-center py-6 px-3">
            <div className="ivd-empty-icon mx-auto mb-2"><FiCalendar size={18} /></div>
            <p className="text-sm text-gray-600">This is the first round.</p>
            <p className="text-[11px] text-gray-500 mt-0.5">Nobody has interviewed {iv.candidateName} yet.</p>
          </div>
        ) : rounds.map((r) => (
          <article key={r.index} className={`${roundBoxClass(r.status)} p-3`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <RoundBadge>{r.label || `Round ${r.index + 1}`}</RoundBadge>
                <div className="text-xs font-medium text-gray-800 mt-1.5">{r.interviewerName || r.decidedByName || 'Interviewer not recorded'}</div>
                {r.decidedAt && <div className="text-[11px] text-gray-500">{formatDateTime12(r.decidedAt)}</div>}
              </div>
              <span className={`shrink-0 text-[11px] font-medium px-2 py-0.5 rounded ${ROUND_STATUS_STYLES[r.status] || ROUND_STATUS_STYLES.Pending}`}>
                {roundStatusLabel(r.status)}
              </span>
            </div>
            <div className="mt-3">
              {hasAssessment(r) ? <WriteUp round={r} compact /> : (
                <p className="text-xs text-gray-400 italic">No write-up recorded for this round.</p>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

/** A written-up round: verdict + average, the ratings, then the words. */
function WriteUp({ round, compact = false }) {
  const a = assessmentOf(round);
  const avg = averageRating(round);
  const rated = RATING_FIELDS.filter((f) => a.ratings[f.key] > 0);
  return (
    <div className="space-y-3">
      {(a.recommendation || avg != null) && (
        <div className="flex flex-wrap items-center gap-2">
          <RecommendationChip value={a.recommendation} />
          {avg != null && (
            <span className="text-[11px] text-gray-500">
              Average <span className="font-bold text-gray-900 text-sm">{avg.toFixed(1)}</span>/5
            </span>
          )}
        </div>
      )}
      {rated.length > 0 && (
        <div className={compact ? 'space-y-1' : 'grid gap-x-6 gap-y-1 sm:grid-cols-2'}>
          {rated.map((f) => (
            <div key={f.key} className="flex flex-wrap items-center justify-between gap-x-2">
              <span className="text-xs text-gray-600">{f.label}</span>
              <StarRow value={a.ratings[f.key]} disabled size="text-sm" />
            </div>
          ))}
        </div>
      )}
      {round.feedback && (
        <div>
          <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Overall remarks</div>
          <p className="text-sm text-gray-800 whitespace-pre-wrap mt-0.5">{round.feedback}</p>
        </div>
      )}
      {(a.strengths || a.concerns) && (
        <div className={compact ? 'space-y-2' : 'grid gap-3 sm:grid-cols-2'}>
          {a.strengths && (
            <div className="bg-green-50 border border-green-100 rounded-lg px-3 py-2">
              <div className="text-[10px] font-semibold text-green-800 uppercase tracking-wide">Strengths</div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{a.strengths}</p>
            </div>
          )}
          {a.concerns && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              <div className="text-[10px] font-semibold text-amber-800 uppercase tracking-wide">Concerns / to probe</div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{a.concerns}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DeskSkeleton() {
  return (
    <>
      <div className="ivd-card p-4 mb-4 grid gap-2 sm:grid-cols-3">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-14 rounded-xl" />)}
      </div>
      <div className="ivd-desk">
        <div className="ivd-area-cand ivd-card p-4 space-y-3"><div className="skeleton h-12 w-12 rounded-full" /><div className="skeleton h-4 w-2/3 rounded" /><div className="skeleton h-10 rounded-xl" /></div>
        <div className="ivd-area-cur ivd-card p-4 space-y-3">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-8 rounded" />)}</div>
        <div className="ivd-area-prev ivd-card p-4 space-y-3"><div className="skeleton h-24 rounded-xl" /></div>
      </div>
    </>
  );
}
