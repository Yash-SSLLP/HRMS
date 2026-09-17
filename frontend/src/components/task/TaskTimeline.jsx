/**
 * A task's history, as a timeline (section 30).
 *
 * The activity trail is the thing the detail page is built around: read top to
 * bottom it answers "what actually happened here", which no combination of the
 * task's current fields can. Every line is one act — created, assigned,
 * accepted, a file uploaded, submitted, rejected, resubmitted, approved, a
 * reminder that fired, an escalation, a deadline moved.
 *
 * ROWS ARE NEVER EDITED OR DELETED, on the server or here. A mistake is
 * corrected by a new line that says so, so this is genuinely append-only and can
 * be read as a record rather than as a summary somebody maintains.
 *
 * Grouped by day, because a busy task produces thirty lines and an undivided
 * list of thirty timestamps is unreadable.
 */
import { useMemo } from 'react';
import {
  FiPlus, FiUserPlus, FiCheck, FiX, FiPlay, FiUpload, FiClock,
  FiMessageSquare, FiPaperclip, FiAlertTriangle, FiCalendar, FiMapPin,
  FiAward, FiPause, FiRepeat, FiArchive, FiGitBranch,
} from 'react-icons/fi';
import { formatDateTime12 } from '../../utils/time';

// One icon and one tone per kind of act. Anything not listed falls back to a
// neutral dot — a new verb on the server should still READ, even before this
// file has heard of it.
const LOOK = {
  created: [FiPlus, 'text-gray-500'],
  assigned: [FiUserPlus, 'text-blue-600'],
  reassigned: [FiUserPlus, 'text-blue-600'],
  unassigned: [FiUserPlus, 'text-gray-400'],
  handover: [FiRepeat, 'text-violet-600'],
  accepted: [FiCheck, 'text-sky-600'],
  declined: [FiX, 'text-red-600'],
  started: [FiPlay, 'text-blue-600'],
  progress: [FiClock, 'text-gray-400'],
  checklist: [FiCheck, 'text-gray-500'],
  submitted: [FiUpload, 'text-amber-600'],
  resubmitted: [FiUpload, 'text-amber-600'],
  approved: [FiCheck, 'text-green-600'],
  rejected: [FiX, 'text-red-600'],
  completed: [FiCheck, 'text-green-700'],
  cancelled: [FiX, 'text-gray-500'],
  reopened: [FiRepeat, 'text-violet-600'],
  blocked: [FiAlertTriangle, 'text-orange-600'],
  onHold: [FiPause, 'text-violet-600'],
  comment: [FiMessageSquare, 'text-gray-500'],
  attachment: [FiPaperclip, 'text-gray-500'],
  stepOpened: [FiGitBranch, 'text-amber-600'],
  stepDecided: [FiGitBranch, 'text-green-600'],
  stepSkipped: [FiGitBranch, 'text-gray-400'],
  workflowStarted: [FiGitBranch, 'text-gray-500'],
  workflowCompleted: [FiGitBranch, 'text-green-600'],
  extensionRequested: [FiCalendar, 'text-amber-600'],
  extensionApproved: [FiCalendar, 'text-green-600'],
  extensionRejected: [FiCalendar, 'text-red-600'],
  reminder: [FiClock, 'text-amber-500'],
  escalated: [FiAlertTriangle, 'text-red-600'],
  location: [FiMapPin, 'text-gray-500'],
  geofenceBlocked: [FiMapPin, 'text-red-600'],
  incentiveProposed: [FiAward, 'text-gray-500'],
  incentiveApproved: [FiAward, 'text-green-600'],
  incentiveCredited: [FiAward, 'text-green-700'],
  incentiveRejected: [FiAward, 'text-red-600'],
  timeEntry: [FiClock, 'text-gray-500'],
  timeApproved: [FiClock, 'text-green-600'],
  timeRejected: [FiClock, 'text-red-600'],
  archived: [FiArchive, 'text-gray-500'],
  restored: [FiArchive, 'text-gray-500'],
};

const dayKey = (d) => new Date(d).toLocaleDateString('en-IN', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
});

const timeOnly = (d) => new Date(d).toLocaleTimeString('en-IN', {
  hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
});

/**
 * @param {object} props
 * @param {Array} props.activity - the rows from GET /tasks/:id (oldest first)
 * @param {boolean} [props.dense]
 */
export default function TaskTimeline({ activity = [], dense = false }) {
  const days = useMemo(() => {
    const out = [];
    for (const row of activity) {
      const key = dayKey(row.at);
      const last = out[out.length - 1];
      if (last && last.day === key) last.rows.push(row);
      else out.push({ day: key, rows: [row] });
    }
    return out;
  }, [activity]);

  if (!activity.length) {
    return <p className="text-sm text-gray-500">Nothing has happened on this task yet.</p>;
  }

  return (
    <div className="space-y-5">
      {days.map(({ day, rows }) => (
        <div key={day}>
          <div className="text-xs font-medium text-gray-400 mb-2 sticky top-0 bg-white py-1">{day}</div>
          <div className="relative">
            <div className="absolute left-[9px] top-1 bottom-1 w-px bg-gray-100" aria-hidden />
            <div className="relative space-y-0">
              {rows.map((row) => {
                const [Icon, tone] = LOOK[row.kind] || [null, 'text-gray-400'];
                return (
                  <div key={row._id} className={`flex gap-3 ${dense ? 'pb-2' : 'pb-3'}`}>
                    <span className="w-[19px] h-[19px] shrink-0 rounded-full bg-white border border-gray-200 flex items-center justify-center">
                      {Icon ? <Icon className={tone} size={11} /> : <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-sm text-gray-800">
                          {row.message || row.kind}
                          {/* A move says what it moved between; without this a
                              trail of "updated the task" tells you nothing. */}
                          {row.field && row.from != null && row.to != null && row.field !== 'status' && (
                            <span className="text-gray-500"> ({row.from || '—'} → {row.to || '—'})</span>
                          )}
                        </span>
                        <span className="text-xs text-gray-400 tabular-nums shrink-0">{timeOnly(row.at)}</span>
                      </div>
                      {row.note && (
                        <div className="mt-1 text-sm text-gray-600 bg-gray-50 border border-gray-100 rounded px-2 py-1 whitespace-pre-wrap">
                          {row.note}
                        </div>
                      )}
                      {row.location && row.location.lat != null && (
                        <div className="mt-1 text-xs text-gray-400 inline-flex items-center gap-1">
                          <FiMapPin size={11} />
                          {row.location.address
                            || `${row.location.lat.toFixed(5)}, ${row.location.lng.toFixed(5)}`}
                          {row.location.distanceM != null && (
                            <span className={row.location.insideFence ? 'text-green-600' : 'text-red-600'}>
                              · {row.location.distanceM} m {row.location.insideFence ? 'inside' : 'outside'} the fence
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** One line of "who last touched this", for a list row that has no room for more. */
export function LastActivityLine({ activity = [] }) {
  const last = activity[activity.length - 1];
  if (!last) return null;
  return (
    <span className="text-xs text-gray-400">
      {last.message} · {formatDateTime12(last.at)}
    </span>
  );
}
