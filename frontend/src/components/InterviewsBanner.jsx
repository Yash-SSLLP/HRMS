import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiUsers, FiVideo } from 'react-icons/fi';
import api from '../api/client';
import { ROUND_STATUS_STYLES, roundStatusLabel } from './InterviewAssessment';

// When the employee has been assigned to take interviews, surface them on the
// dashboard — right alongside announcements and surveys — so they aren't
// missed. Data comes from the same endpoint the "My Interviews" page uses.
//
// WHICH ONES (user decision 2026-09-24): the interviews still to be ATTENDED,
// and only those. A round is attended once its result is recorded, so the
// status decides, not the clock:
//   Pending / Scheduled — waiting on the interviewer. Shown whatever the date:
//                         one whose slot has passed with no result recorded
//                         stays, marked, until somebody records it.
//   On Hold             — kept, but below the rest: paused, not done.
//   Cleared / Rejected  — done; gone from here (My Interviews keeps them).
// A round with no time booked is not an interview yet, and a candidate who has
// left the running — rejected, or already at offer or beyond — takes their
// rounds with them, so an unrecorded round can never haunt the dashboard.
const OPEN = ['Pending', 'Scheduled'];
const HELD = 'OnHold';
const PAST_INTERVIEWS = ['Offer', 'Onboarding', 'NewJoinee', 'Hired', 'Rejected'];

const fmtWhen = (iso) => {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
  });
};

const byTime = (a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt);

export default function InterviewsBanner() {
  const [items, setItems] = useState({ open: [], held: [] });

  useEffect(() => {
    api.get('/recruitment/my-interviews')
      .then(({ data }) => {
        const shown = (data.interviews || data.items || [])
          .filter((iv) => iv.scheduledAt && !PAST_INTERVIEWS.includes(iv.stage));
        setItems({
          open: shown.filter((iv) => OPEN.includes(iv.status || 'Pending')).sort(byTime),
          held: shown.filter((iv) => iv.status === HELD).sort(byTime),
        });
      })
      .catch(() => {});
  }, []);

  if (!items.open.length && !items.held.length) return null;

  const now = Date.now();
  const card = (iv) => {
    const held = iv.status === HELD;
    // Its slot has come and gone with nothing recorded: the reason it is still here.
    const overdue = !held && new Date(iv.scheduledAt).getTime() < now;
    return (
      <div key={`${iv.candidateId}-${iv.index}`} className="bg-white shadow rounded-lg p-4 border-l-4"
        style={{ borderLeftColor: held ? '#9ca3af' : '#f59e0b' }}>
        <div className="flex items-center gap-2 flex-wrap mb-1">
          <FiUsers className={`${held ? 'text-gray-400' : 'text-amber-500'} shrink-0`} size={15} />
          <span className="font-semibold text-gray-900">Interview: {iv.candidateName}</span>
          <span className="text-[10px] font-medium rounded-full px-2 py-0.5 bg-amber-100 text-amber-800">{iv.label}</span>
          {iv.status === 'Scheduled' && (
            <span className="text-[10px] font-medium rounded-full px-2 py-0.5 bg-green-100 text-green-800">Scheduled</span>
          )}
          {held && (
            <span className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${ROUND_STATUS_STYLES.OnHold}`}>{roundStatusLabel(HELD)}</span>
          )}
          {overdue && (
            <span className="text-[10px] font-medium rounded-full px-2 py-0.5 bg-orange-100 text-orange-800">Result not recorded</span>
          )}
        </div>
        <div className="text-sm text-gray-700">
          {iv.jobTitle ? <span className="text-gray-500">{iv.jobTitle} · </span> : null}
          {fmtWhen(iv.scheduledAt)}
          {iv.durationMinutes ? <span className="text-gray-500"> · {iv.durationMinutes < 60 ? `${iv.durationMinutes} min` : `${iv.durationMinutes / 60} hr`}</span> : null}
        </div>
        <div className="flex items-center justify-between gap-3 mt-2">
          <Link to="/employee/interviews" className="text-xs text-blue-600 hover:underline">
            {overdue ? 'Record the result in My Interviews →' : 'View in My Interviews →'}
          </Link>
          {iv.meetingLink && !held && (
            <a href={iv.meetingLink} target="_blank" rel="noreferrer"
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm bg-gray-900 text-white rounded-lg hover:bg-gray-700">
              <FiVideo size={14} /> Join meeting
            </a>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="mb-4 space-y-2">
      {items.open.map(card)}
      {items.held.length > 0 && (
        <>
          {/* Paused rounds sit below the ones waiting on you, under their own line. */}
          <div className="pt-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">On hold</div>
          {items.held.map(card)}
        </>
      )}
    </div>
  );
}
