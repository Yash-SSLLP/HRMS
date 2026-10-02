/**
 * My Trainings — the sessions I am on, from my own side (2026-10-02).
 *
 * Mounted at /employee/my-trainings for everybody, and at /admin/my-trainings
 * for a CEO/MD booked on (or running) a session — they have no employee portal,
 * the same reason /admin/my-interviews exists. Nothing here needs a grant: the
 * server answers GET /training/mine by identity.
 *
 * THE PAGE:
 *   Hero            the session that is live now, or the next one — big date,
 *                   time with "in 2 h", trainer, what it covers, the files, and
 *                   the Join button (it lights up half an hour before)
 *   Your review     sessions that are over and not yet reviewed, each with the
 *                   review form right there — "how clear was it?"
 *   Everything      Upcoming | Completed | All, as cards; a past one shows my
 *                   review (or a Rate button), a trainer sees how it was rated
 *
 * JOIN opens the meeting in a new tab synchronously (so no pop-up blocker gets
 * a say) and then tells the server, which records attendance while the session
 * is on — that record is what the monthly report's "Joined" column reads.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
  FiVideo, FiClock, FiUser, FiCalendar, FiPaperclip, FiStar, FiCheckCircle, FiExternalLink, FiBookOpen,
  FiChevronDown, FiChevronUp, FiX, FiAward, FiUsers,
} from 'react-icons/fi';
import api from '../api/client';
import PageHeader from '../components/PageHeader';
import FeedbackForm from '../components/training/FeedbackForm';
import {
  DateTile, StatusPill, CategoryChip, Stars, FileRow, EmptyState,
} from '../components/training/bits';
import {
  timeRange, durationText, relativeStart, longDate, initials, RATING_WORDS,
} from '../components/training/trainingUtil';
import { openTrainingFile } from '../components/training/fileOpen';
import { formatTime12 } from '../utils/time';

const REVIEW_WINDOW_DAYS = 30;
const TABS = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'completed', label: 'Completed' },
  { id: 'all', label: 'All' },
];

const endedAt = (t) => new Date(t.endDate || t.startDate || 0).getTime();

/** Open the meeting, then record the join. Never awaited before the tab opens. */
function useJoin(setTrainings) {
  return (t) => {
    if (!t.meetingLink) return;
    window.open(t.meetingLink, '_blank', 'noopener,noreferrer');
    api.post(`/training/${t._id}/join`)
      .then(({ data }) => {
        if (data.recorded) {
          setTrainings((list) => list.map((x) => (x._id === t._id
            ? { ...x, myAttendance: { firstJoinedAt: x.myAttendance?.firstJoinedAt || new Date().toISOString(), joins: (x.myAttendance?.joins || 0) + 1 } }
            : x)));
        }
      })
      .catch(() => {});
  };
}

function Files({ t }) {
  const [opening, setOpening] = useState('');
  if (!t.attachments?.length) return null;
  return (
    <div className="trn-files" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 15rem), 1fr))' }}>
      {t.attachments.map((f) => (
        <FileRow key={f._id} file={f} busy={opening === String(f._id)}
          onOpen={async () => { setOpening(String(f._id)); await openTrainingFile(t._id, f); setOpening(''); }} />
      ))}
    </div>
  );
}

function JoinButton({ t, onJoin, large }) {
  if (!t.meetingLink || t.status === 'Cancelled' || t.status === 'Completed') return null;
  const live = t.status === 'Ongoing';
  if (t.joinOpen) {
    return (
      <button type="button" className={`trn-btn ${large ? 'is-lg' : ''} ${live ? 'is-live' : 'is-primary accent-bg on-accent'}`} onClick={() => onJoin(t)}>
        <FiVideo size={large ? 18 : 15} /> {live ? 'Join now' : 'Join meeting'} <FiExternalLink size={13} className="opacity-80" />
      </button>
    );
  }
  return (
    <button type="button" className={`trn-btn ${large ? 'is-lg' : ''}`} onClick={() => onJoin(t)} title="The meeting room opens half an hour before the start">
      <FiVideo size={large ? 17 : 14} /> Meeting link
    </button>
  );
}

function Hero({ t, onJoin }) {
  const [more, setMore] = useState(false);
  const live = t.status === 'Ongoing';
  const rel = relativeStart(t.startDate);
  const long = (t.description || '').length > 220;
  return (
    <section className={`trn-hero ${live ? 'is-live' : ''} mb-5`}>
      <div className="flex flex-col md:flex-row md:items-start gap-5">
        <DateTile date={t.startDate} status={t.status} large />
        <div className="min-w-0 flex-1">
          <div className="trn-eyebrow">{live ? 'Happening now' : t.role.trainer ? 'Your next session to run' : 'Your next training'}</div>
          <h2 className="trn-hero-title text-gray-900 mt-1 break-words">{t.title}</h2>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            <StatusPill status={t.status} />
            <CategoryChip name={t.category} />
            {rel && <span className="trn-rel is-soon">{rel}</span>}
            {t.role.trainer && <span className="trn-tag is-accent"><FiAward size={10} /> You are the trainer</span>}
          </div>
          <div className="trn-meta text-gray-700" style={{ marginTop: '0.75rem', fontSize: '0.86rem' }}>
            <span><FiCalendar size={14} />{longDate(t.startDate)}</span>
            <span><FiClock size={14} />{timeRange(t)}{t.durationMinutes ? ` · ${durationText(t.durationMinutes)}` : ''}</span>
            {t.trainer && !t.role.trainer && (
              <span><span className={`trn-av ${t.trainerType === 'external' ? 'is-ext' : ''}`} style={{ width: '1.5rem', height: '1.5rem', borderWidth: 0 }}>{initials(t.trainer)}</span>{t.trainer}</span>
            )}
            {t.role.trainer && <span><FiUsers size={14} />{t.participantCount} participant{t.participantCount === 1 ? '' : 's'}</span>}
          </div>
          {t.description && (
            <p className={`trn-desc text-gray-700 mt-3 ${!more && long ? 'line-clamp-3' : ''}`}>{t.description}</p>
          )}
          {long && (
            <button type="button" className="text-xs font-semibold accent-text mt-1 inline-flex items-center gap-1" onClick={() => setMore((m) => !m)}>
              {more ? <>Show less <FiChevronUp size={12} /></> : <>Read more <FiChevronDown size={12} /></>}
            </button>
          )}
          {t.attachments?.length > 0 && (
            <div className="mt-4">
              <div className="trn-label text-gray-600"><FiPaperclip size={11} className="inline mr-1" />Files for this training</div>
              <Files t={t} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 mt-5">
            <JoinButton t={t} onJoin={onJoin} large />
            {t.myAttendance?.firstJoinedAt && (
              <span className="trn-yes"><FiCheckCircle size={13} /> You joined at {formatTime12(t.myAttendance.firstJoinedAt)}</span>
            )}
            {!t.meetingLink && <span className="text-sm text-gray-600">{t.status === 'Cancelled' ? 'This session was cancelled.' : 'In person — no meeting link.'}</span>}
            {t.meetingLink && !t.joinOpen && <span className="text-xs text-gray-500">The Join button lights up 30 minutes before the start.</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

function ReviewCard({ t, onSaved }) {
  return (
    <div className="trn-card-base trn-review-card p-4 md:p-5">
      <div className="flex items-start gap-3 mb-1">
        <DateTile date={t.startDate} status="Completed" />
        <div className="min-w-0 flex-1">
          <div className="trn-eyebrow" style={{ color: '#b45309' }}>Waiting for your review</div>
          <div className="trn-title text-gray-900 mt-0.5 break-words">{t.title}</div>
          <div className="trn-meta text-gray-600">
            <span><FiClock size={13} />{timeRange(t)}</span>
            {t.trainer && <span><FiUser size={13} />{t.trainer}</span>}
          </div>
        </div>
      </div>
      <FeedbackForm training={t} onSaved={onSaved} />
    </div>
  );
}

function TrainingRow({ t, onJoin, onRate }) {
  const [open, setOpen] = useState(false);
  const live = t.status === 'Ongoing';
  const done = t.status === 'Completed';
  const rel = t.status === 'Planned' ? relativeStart(t.startDate) : '';
  return (
    <div className={`trn-card ${live ? 'is-live' : ''} ${t.status === 'Cancelled' ? 'is-cancelled' : ''}`} style={{ cursor: 'default' }}>
      <DateTile date={t.startDate} status={t.status} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={t.status} />
          <CategoryChip name={t.category} />
          {rel && <span className="trn-rel text-gray-700">{rel}</span>}
          {t.role.trainer && <span className="trn-tag is-accent"><FiAward size={10} /> Trainer</span>}
        </div>
        <div className="trn-title text-gray-900 mt-1.5 break-words">{t.title}</div>
        <div className="trn-meta text-gray-600">
          <span><FiClock size={13} />{timeRange(t)}</span>
          {t.durationMinutes ? <span className="font-medium text-gray-700">{durationText(t.durationMinutes)}</span> : null}
          {t.trainer && !t.role.trainer && <span><FiUser size={13} />{t.trainer}</span>}
          {t.attachments?.length > 0 && <span><FiPaperclip size={13} />{t.attachments.length} file{t.attachments.length === 1 ? '' : 's'}</span>}
          {t.myAttendance?.firstJoinedAt && <span className="trn-yes"><FiCheckCircle size={12} /> Joined {formatTime12(t.myAttendance.firstJoinedAt)}</span>}
        </div>
        {done && t.role.participant && t.myFeedback && (
          <div className="mt-2 text-xs text-gray-600 inline-flex flex-wrap items-center gap-2">
            Your review <Stars value={t.myFeedback.clarity} size={13} /> <b className="text-gray-800">{RATING_WORDS.clarity[t.myFeedback.clarity - 1]}</b>
          </div>
        )}
        {done && t.role.trainer && t.feedbackSummary && (
          <div className="mt-2 text-xs text-gray-600 inline-flex flex-wrap items-center gap-2">
            {t.feedbackSummary.count
              ? <>How it landed <Stars value={t.feedbackSummary.clarity} size={13} /> <b className="text-gray-800">{t.feedbackSummary.clarity}/5</b> from {t.feedbackSummary.count} review{t.feedbackSummary.count === 1 ? '' : 's'}</>
              : 'No reviews yet'}
          </div>
        )}
        {open && (
          <div className="mt-3 space-y-3">
            {t.description && <p className="trn-desc text-gray-700">{t.description}</p>}
            <Files t={t} />
          </div>
        )}
        {(t.description || t.attachments?.length > 0) && (
          <button type="button" className="text-xs font-semibold accent-text mt-2 inline-flex items-center gap-1" onClick={() => setOpen((o) => !o)}>
            {open ? <>Hide details <FiChevronUp size={12} /></> : <>Details{t.attachments?.length ? ' & files' : ''} <FiChevronDown size={12} /></>}
          </button>
        )}
      </div>
      <div className="trn-card-actions">
        <JoinButton t={t} onJoin={onJoin} />
        {done && t.canGiveFeedback && (
          <button type="button" className={`trn-btn ${t.myFeedback ? '' : 'is-primary accent-bg on-accent'}`} onClick={() => onRate(t)}>
            <FiStar size={14} /> {t.myFeedback ? 'Edit review' : 'Rate it'}
          </button>
        )}
      </div>
    </div>
  );
}

export default function EmployeeTrainings() {
  const [trainings, setTrainings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('upcoming');
  const [rating, setRating] = useState(null);
  const join = useJoin(setTrainings);

  const load = async () => {
    try {
      const { data } = await api.get('/training/mine');
      setTrainings(data.trainings || []);
      setError('');
    } catch (err) {
      setError(err.response?.data?.message || 'Could not load your trainings');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // Live / Join flip with the clock — re-read every minute while open.
    const id = setInterval(load, 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const now = Date.now();
  const hero = useMemo(() => {
    const live = trainings.filter((t) => t.status === 'Ongoing');
    if (live.length) return live[0];
    return trainings.filter((t) => t.status === 'Planned' && t.startDate)
      .sort((a, b) => new Date(a.startDate) - new Date(b.startDate))[0] || null;
  }, [trainings]);

  const toReview = useMemo(() => trainings.filter((t) => t.status === 'Completed' && t.role.participant
    && !t.myFeedback && now - endedAt(t) < REVIEW_WINDOW_DAYS * 864e5)
    .sort((a, b) => endedAt(b) - endedAt(a)), [trainings, now]);

  const lists = useMemo(() => {
    const upcoming = trainings.filter((t) => t.status === 'Planned' || t.status === 'Ongoing'
      || (t.status === 'Cancelled' && t.startDate && new Date(t.startDate).getTime() > now))
      .sort((a, b) => new Date(a.startDate || 8.64e15) - new Date(b.startDate || 8.64e15));
    const completed = trainings.filter((t) => t.status === 'Completed').sort((a, b) => endedAt(b) - endedAt(a));
    return { upcoming, completed, all: trainings };
  }, [trainings, now]);

  const saved = (t, myFeedback) => {
    setTrainings((list) => list.map((x) => (x._id === t._id ? { ...x, myFeedback } : x)));
    setRating(null);
  };

  const listForTab = lists[tab].filter((t) => !(hero && t._id === hero._id && tab === 'upcoming'));

  return (
    <div>
      <PageHeader title="My Trainings" subtitle="Your sessions — join from here, get the files, and say how clear each one was." />
      {error && <div className="trn-note is-warn text-gray-700 mb-4">{error}</div>}

      {loading ? (
        <div className="trn-card-base p-6 space-y-3"><div className="skeleton h-5 rounded w-1/3" /><div className="skeleton h-8 rounded w-2/3" /><div className="skeleton h-4 rounded w-1/2" /><div className="skeleton h-10 rounded w-40" /></div>
      ) : trainings.length === 0 ? (
        <div className="trn-card-base">
          <EmptyState icon={FiBookOpen} title="No trainings yet">
            When you are added to a training it shows up here — with the date and time, the join link and any files.
          </EmptyState>
        </div>
      ) : (
        <>
          {hero && <Hero t={hero} onJoin={join} />}

          {toReview.length > 0 && (
            <section className="mb-6">
              <div className="trn-group-head" style={{ marginTop: 0 }}>
                <span className="trn-group-title text-gray-700">Your review, please</span>
                <span className="trn-group-sub text-gray-600">{toReview.length} waiting · takes half a minute</span>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                {toReview.slice(0, 4).map((t) => <ReviewCard key={t._id} t={t} onSaved={(fb) => saved(t, fb)} />)}
              </div>
            </section>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="trn-seg" role="tablist" aria-label="Which trainings">
              {TABS.map((x) => (
                <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} className={`trn-seg-btn ${tab === x.id ? 'is-on' : ''} text-gray-800`} onClick={() => setTab(x.id)}>
                  {x.label} <span className="trn-seg-count">{lists[x.id].length}</span>
                </button>
              ))}
            </div>
          </div>
          {listForTab.length === 0 ? (
            <div className="trn-card-base">
              <EmptyState icon={tab === 'completed' ? FiCheckCircle : FiCalendar} title={tab === 'completed' ? 'Nothing completed yet' : hero && tab === 'upcoming' ? 'Nothing else coming up' : 'Nothing here'}>
                {tab === 'upcoming' ? 'New sessions appear here as soon as you are added — you get a notification too.' : null}
              </EmptyState>
            </div>
          ) : (
            <div>
              {listForTab.map((t) => <TrainingRow key={t._id} t={t} onJoin={join} onRate={setRating} />)}
            </div>
          )}
        </>
      )}

      {rating && (
        <div className="fixed inset-0 bg-black/40 trn-modal-wrap" role="dialog" aria-modal="true" aria-label="Review the training">
          <div className="trn-modal trn-card-base flex flex-col" style={{ maxWidth: '34rem' }}>
            <div className="trn-modal-head">
              <span className="trn-kpi-icon" style={{ '--kpi-hue': '#d97706' }}><FiStar size={18} /></span>
              <div className="min-w-0 flex-1">
                <div className="text-lg font-bold text-gray-900 break-words">{rating.title}</div>
                <div className="text-xs text-gray-600">{longDate(rating.startDate)} · {timeRange(rating)}</div>
              </div>
              <button type="button" className="trn-icon-btn text-gray-500" onClick={() => setRating(null)} aria-label="Close" data-modal-close><FiX size={18} /></button>
            </div>
            <div className="trn-modal-body overflow-y-auto pt-2">
              <FeedbackForm training={rating} onSaved={(fb) => saved(rating, fb)} onCancel={() => setRating(null)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
