/**
 * InterviewAssessment — the interview write-up, in one place.
 *
 * A round used to collect a single line of free text, and a single line of free
 * text is what it got: "tty", "GOOD TO GO", or nothing. That line is then the
 * whole record read by the next round's interviewer, by HR, and by a CEO/MD
 * signing off the hire. So the form asks the questions a panel is actually
 * expected to answer — a score per competency, strengths and concerns as
 * separate fields, a hiring recommendation, and overall remarks — and the
 * read-only view renders the same structure back wherever an earlier round has
 * to be understood at a glance. Nothing here is enforced: the form asks well
 * and says when the remarks are thin, and saves whatever is typed.
 *
 * Everything here is shared by the admin Recruitment page (HR, CEO/MD) and the
 * "My Interviews" page (the assigned interviewer), so the two surfaces cannot
 * drift into asking for different things or labelling them differently.
 *
 * Mirrors models/Candidate.js (ASSESSMENT_RATINGS, ROUND_RECOMMENDATIONS).
 */
import { useState } from 'react';
import { formatDateTime12 } from '../utils/time';

// Order matters: it is the order of the form and of every read-back.
export const RATING_FIELDS = [
  { key: 'technical', label: 'Technical / functional skill' },
  { key: 'communication', label: 'Communication' },
  { key: 'problemSolving', label: 'Problem solving' },
  { key: 'experience', label: 'Relevant experience' },
  { key: 'cultureFit', label: 'Ownership & culture fit' },
];

// 0 is "not rated", which is not a 1 — an area nobody probed must not read as
// one the candidate failed.
export const SCALE = ['Not rated', 'Well below bar', 'Below bar', 'Meets the bar', 'Above the bar', 'Outstanding'];

export const RECOMMENDATIONS = ['Strong Hire', 'Hire', 'Borderline', 'No Hire'];
const REC_STYLES = {
  'Strong Hire': 'bg-green-100 text-green-800',
  Hire: 'bg-emerald-50 text-emerald-700',
  Borderline: 'bg-amber-100 text-amber-800',
  'No Hire': 'bg-red-100 text-red-700',
};

export const ROUND_STATUS_STYLES = {
  Pending: 'bg-gray-100 text-gray-600',
  Scheduled: 'bg-blue-100 text-blue-700',
  Cleared: 'bg-green-100 text-green-700',
  Rejected: 'bg-red-100 text-red-700',
};

// The length a write-up is nudged towards. ADVICE, never a gate — nothing here
// or on the server refuses a shorter one. Mirrors SUGGESTED_REMARK_CHARS in
// recruitmentController, which each my-interviews payload also carries as
// `suggestedRemarkChars`.
export const SUGGESTED_REMARK_CHARS = 20;

/** The empty assessment, in the exact shape the API returns. */
export const emptyAssessment = () => ({
  ratings: Object.fromEntries(RATING_FIELDS.map((f) => [f.key, 0])),
  strengths: '',
  concerns: '',
  recommendation: '',
});

/** Normalise whatever a round carries (including nothing at all) into that shape. */
export function assessmentOf(round) {
  const a = round?.assessment || {};
  const r = a.ratings || {};
  return {
    ratings: Object.fromEntries(RATING_FIELDS.map((f) => [f.key, Number(r[f.key]) || 0])),
    strengths: a.strengths || '',
    concerns: a.concerns || '',
    recommendation: a.recommendation || '',
  };
}

/** Has anybody actually written this round up? Blank scores and no text = no. */
export function hasAssessment(round) {
  const a = assessmentOf(round);
  return Boolean(
    (round?.feedback || '').trim() || a.strengths || a.concerns || a.recommendation
      || RATING_FIELDS.some((f) => a.ratings[f.key] > 0)
  );
}

/** Mean of the scores that were actually given, to 1 dp — or null if none were. */
export function averageRating(round) {
  const a = assessmentOf(round);
  const given = RATING_FIELDS.map((f) => a.ratings[f.key]).filter((n) => n > 0);
  if (!given.length) return null;
  return Math.round((given.reduce((s, n) => s + n, 0) / given.length) * 10) / 10;
}

/** The recommendation as a coloured chip (nothing when unset). */
export function RecommendationChip({ value, className = '' }) {
  if (!value) return null;
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded font-medium ${REC_STYLES[value] || 'bg-gray-100 text-gray-600'} ${className}`}>
      {value}
    </span>
  );
}

/**
 * One competency's 1-5 score. Read-only renders the same five marks, so a saved
 * round and the form it was typed into look like the same object.
 */
export function StarRow({ value = 0, onChange, disabled = false, size = 'text-xl' }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          disabled={disabled}
          // Clicking the current score clears it back to "not rated" — otherwise
          // a mis-click can never be taken back, only moved.
          onClick={() => onChange?.(value === n ? 0 : n)}
          title={disabled ? SCALE[value] : SCALE[n]}
          aria-label={`${n} — ${SCALE[n]}`}
          // .star-btn / .is-on rather than raw utilities, for the same reason
          // PublicCoursePage gives: the dark-mode block remaps text-gray-300
          // and text-amber-400 globally, and would repaint a gold star.
          // Padding, not a bigger glyph, is what makes an editable star
          // tappable — the same shape the review sheet uses (.star-btn is
          // excluded from the 40px mobile floor, which would stretch the row).
          className={`star-btn ${size} leading-none ${n <= value ? 'is-on' : ''} ${disabled ? 'cursor-default' : 'px-1 py-0.5'}`}
        >
          ★
        </button>
      ))}
      <span className="ml-1.5 text-[11px] text-gray-500">{SCALE[value]}</span>
    </span>
  );
}

// Spelled out rather than left as "Feedback…": the example is what makes the
// difference between a professional write-up and "tty".
const REMARK_PLACEHOLDER = [
  'Summarise the interview in a few professional sentences: what you assessed, how the candidate performed against it, and what you recommend.',
  '',
  'e.g. "Took the candidate through their last two projects and a scenario on handling a client escalation. Explained their approach clearly and owned the outcome. Commercial exposure is lighter than the role needs, so pricing conversations are worth testing in the next round. Recommend proceeding."',
].join('\n');

/**
 * The write-up form. Controlled: `value` is {feedback, assessment}, and every
 * change is handed straight back up — the parent owns saving.
 * @param {{value: Object, onChange: Function, disabled?: boolean, suggestChars?: number, compact?: boolean}} props
 */
export function AssessmentForm({ value, onChange, disabled = false, suggestChars = SUGGESTED_REMARK_CHARS, compact = false }) {
  const a = value.assessment || emptyAssessment();
  const setA = (patch) => onChange({ ...value, assessment: { ...a, ...patch } });
  const setRating = (key, n) => setA({ ratings: { ...a.ratings, [key]: n } });
  const remark = value.feedback || '';
  const short = remark.trim().length < suggestChars;

  const box = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-600';

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs font-semibold text-gray-700 mb-2">Competency ratings</div>
        <div className={compact ? 'space-y-1.5' : 'space-y-2'}>
          {RATING_FIELDS.map((f) => (
            <div key={f.key} className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-gray-700">{f.label}</span>
              <StarRow value={a.ratings[f.key] || 0} onChange={(n) => setRating(f.key, n)} disabled={disabled} />
            </div>
          ))}
        </div>
        <p className="text-[11px] text-gray-400 mt-1.5">
          Leave an area unrated if it did not come up — it is recorded as &ldquo;not assessed&rdquo;, not as a low score.
        </p>
      </div>

      <div className={compact ? 'space-y-3' : 'grid grid-cols-1 sm:grid-cols-2 gap-3'}>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Strengths</label>
          <textarea
            rows={3}
            value={a.strengths}
            disabled={disabled}
            onChange={(e) => setA({ strengths: e.target.value })}
            placeholder="What they demonstrated well, with the example that showed it."
            className={box}
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">Concerns / areas to probe</label>
          <textarea
            rows={3}
            value={a.concerns}
            disabled={disabled}
            onChange={(e) => setA({ concerns: e.target.value })}
            placeholder="Gaps, risks, or anything the next round should dig into."
            className={box}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Overall remarks</label>
        <textarea
          rows={compact ? 4 : 5}
          value={remark}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, feedback: e.target.value })}
          placeholder={REMARK_PLACEHOLDER}
          className={box}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 mt-1">
          {/* A nudge, not a rule — the save never waits on it. */}
          <p className={`text-[11px] ${short ? 'text-amber-600' : 'text-gray-400'}`}>
            {short
              ? 'A couple of sentences is worth more here than a line — this is the record the next round, HR and the CEO/MD read.'
              : 'Written up. This is what the next round, HR and the CEO/MD will read.'}
          </p>
          <span className="text-[11px] text-gray-400">{remark.trim().length} chars</span>
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1">Recommendation</label>
        <div className="flex flex-wrap gap-2">
          {RECOMMENDATIONS.map((r) => {
            const on = a.recommendation === r;
            return (
              <button
                key={r}
                type="button"
                disabled={disabled}
                onClick={() => setA({ recommendation: on ? '' : r })}
                /* Weight and border live on the base class, never only on the
                   selected state — a chip that gains a bold label or a ring on
                   click would resize itself under the cursor. */
                className={`text-xs font-medium px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-60 ${
                  on ? `${REC_STYLES[r]} border-transparent ring-2 ring-offset-1 ring-gray-300` : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                }`}
              >
                {r}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * One round's write-up, read-only. Used for a decided round of your own and for
 * every earlier round you are given as context.
 * @param {{round: Object, dense?: boolean}} props
 */
export function AssessmentView({ round, dense = false }) {
  const a = assessmentOf(round);
  const avg = averageRating(round);
  const rated = RATING_FIELDS.filter((f) => a.ratings[f.key] > 0);

  if (!hasAssessment(round)) {
    return <p className="text-xs text-gray-400 italic">No feedback recorded for this round yet.</p>;
  }

  return (
    <div className={dense ? 'space-y-2' : 'space-y-3'}>
      {(a.recommendation || avg != null) && (
        <div className="flex flex-wrap items-center gap-2">
          <RecommendationChip value={a.recommendation} />
          {avg != null && (
            <span className="text-[11px] text-gray-500">
              Average rating <span className="font-semibold text-gray-700">{avg.toFixed(1)}</span>/5
            </span>
          )}
        </div>
      )}

      {rated.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
          {rated.map((f) => (
            <div key={f.key} className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-600">{f.label}</span>
              <StarRow value={a.ratings[f.key]} disabled size="text-sm" />
            </div>
          ))}
        </div>
      )}

      {round.feedback && (
        <div>
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">Overall remarks</div>
          <p className="text-sm text-gray-800 whitespace-pre-wrap">{round.feedback}</p>
        </div>
      )}

      {(a.strengths || a.concerns) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {a.strengths && (
            <div className="bg-green-50 border border-green-100 rounded-lg px-3 py-2">
              <div className="text-[11px] font-semibold text-green-800 uppercase tracking-wide">Strengths</div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{a.strengths}</p>
            </div>
          )}
          {a.concerns && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              <div className="text-[11px] font-semibold text-amber-800 uppercase tracking-wide">Concerns / to probe</div>
              <p className="text-sm text-gray-800 whitespace-pre-wrap">{a.concerns}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Every round that came before this one, with what each panel said.
 *
 * This is the point of the whole component: an interviewer taking Round 3 opens
 * it already holding Rounds 1 and 2 — their scores, their concerns and the
 * questions they left open — instead of interviewing the candidate cold and
 * re-asking what two panels have already covered.
 *
 * @param {{rounds: Object[], title?: string, defaultOpen?: boolean}} props
 */
export function PreviousRounds({ rounds = [], title = 'What the earlier rounds said', defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!rounds.length) return null;
  const written = rounds.filter(hasAssessment).length;

  return (
    <div className="border border-gray-200 rounded-lg bg-gray-50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="text-xs font-semibold text-gray-700">
          {title}
          <span className="ml-2 font-normal text-gray-500">
            {written} of {rounds.length} round{rounds.length === 1 ? '' : 's'} written up
          </span>
        </span>
        <span className="text-gray-400 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {rounds.map((r) => (
            <div key={r.index} className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                <div className="text-sm font-medium text-gray-800">
                  {r.label}
                  <span className="ml-2 text-xs font-normal text-gray-500">
                    {r.interviewerName || r.decidedByName || 'Interviewer not recorded'}
                    {r.decidedAt ? ` · ${formatDateTime12(r.decidedAt)}` : ''}
                  </span>
                </div>
                <span className={`text-[11px] px-2 py-0.5 rounded ${ROUND_STATUS_STYLES[r.status] || ROUND_STATUS_STYLES.Pending}`}>
                  {r.status}
                </span>
              </div>
              <AssessmentView round={r} dense />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
