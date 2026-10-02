/**
 * Training on the dashboard (2026-10-02): a session I am on that is live now
 * or starts within the next day — with the Join button right here — and a
 * nudge for any finished session still waiting for my review. Same data as My
 * Trainings (GET /training/mine); renders nothing when there is nothing to say.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiVideo, FiStar, FiChevronRight, FiBookOpen } from 'react-icons/fi';
import api from '../api/client';
import { timeRange, relativeStart, longDate } from './training/trainingUtil';

const SOON_MS = 24 * 3600 * 1000;
const REVIEW_WINDOW_MS = 30 * 864e5;

export default function TrainingsBanner({ base = '/employee/my-trainings' }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let alive = true;
    const load = () => api.get('/training/mine')
      .then(({ data }) => { if (alive) setRows(data.trainings || []); })
      .catch(() => {});
    load();
    const id = setInterval(load, 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const now = Date.now();
  const soon = rows.filter((t) => t.status === 'Ongoing'
    || (t.status === 'Planned' && t.startDate && new Date(t.startDate).getTime() - now < SOON_MS))
    .sort((a, b) => (a.status === 'Ongoing' ? -1 : b.status === 'Ongoing' ? 1 : new Date(a.startDate) - new Date(b.startDate)))
    // Three at most — the rest are one tap away on My Trainings.
    .slice(0, 3);
  const review = rows.filter((t) => t.status === 'Completed' && t.role?.participant && !t.myFeedback
    && now - new Date(t.endDate || t.startDate || 0).getTime() < REVIEW_WINDOW_MS);
  if (!soon.length && !review.length) return null;

  const join = (t) => {
    window.open(t.meetingLink, '_blank', 'noopener,noreferrer');
    api.post(`/training/${t._id}/join`).catch(() => {});
  };

  return (
    <div className="mb-4 space-y-2">
      {soon.map((t) => {
        const live = t.status === 'Ongoing';
        return (
          <div key={t._id} className={`trn-card ${live ? 'is-live' : ''}`} style={{ cursor: 'default', gridTemplateColumns: 'auto minmax(0,1fr)' }}>
            <span className="trn-kpi-icon" style={{ '--kpi-hue': live ? '#dc2626' : 'var(--accent)' }}><FiBookOpen size={18} /></span>
            <div className="min-w-0 flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="min-w-0 flex-1" style={{ flexBasis: '14rem' }}>
                <div className="trn-eyebrow" style={live ? { color: '#dc2626' } : undefined}>
                  {live ? 'Training — happening now' : `Training ${relativeStart(t.startDate)}`}
                </div>
                <div className="trn-title text-gray-900 truncate">{t.title}</div>
                <div className="text-xs text-gray-600 mt-0.5">{longDate(t.startDate)} · {timeRange(t)}{t.trainer ? ` · ${t.trainer}` : ''}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2 ml-auto">
                {t.meetingLink && t.joinOpen && (
                  <button type="button" className={`trn-btn ${live ? 'is-live' : 'is-primary accent-bg on-accent'}`} onClick={() => join(t)}>
                    <FiVideo size={14} /> {live ? 'Join now' : 'Join meeting'}
                  </button>
                )}
                <Link to={base} className="trn-btn">Details <FiChevronRight size={14} /></Link>
              </div>
            </div>
          </div>
        );
      })}
      {review.length > 0 && (
        <Link to={base} className="trn-card trn-review-card" style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto', alignItems: 'center' }}>
          <span className="trn-kpi-icon" style={{ '--kpi-hue': '#d97706' }}><FiStar size={18} /></span>
          <span className="min-w-0">
            <span className="block trn-title text-gray-900 truncate">
              {review.length === 1 ? `How clear was “${review[0].title}”?` : `${review.length} trainings are waiting for your review`}
            </span>
            <span className="block text-xs text-gray-600 mt-0.5">Rate it in half a minute — it shapes the next session.</span>
          </span>
          <FiChevronRight size={18} className="text-gray-400" />
        </Link>
      )}
    </div>
  );
}
